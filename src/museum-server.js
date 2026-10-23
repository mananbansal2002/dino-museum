import { createServer } from "node:http";
import { createHash } from "node:crypto";
import express from "express";
import { Server } from "socket.io";
import { createSync } from "./sync.js";

/* ------------------------------------------------------------------ */
/* protocol limits                                                      */
/* ------------------------------------------------------------------ */

/** Name-tag colours handed out per room, unique while any are free. */
export const PLAYER_PALETTE = [
  "#ffc857", // sunflower
  "#4fc3f7", // sky
  "#ff7aa2", // flamingo
  "#7bd389", // mint
  "#b39ddb", // lavender
  "#ff9f5a", // tangerine
  "#4dd0c8", // lagoon
  "#e57373", // coral
  "#c5e478", // lime
  "#f48fb1", // blossom
  "#90caf9", // powder blue
  "#ffd180", // apricot
];

/** World is 32x30 cells of 6 m, centred on the origin. */
export const WORLD_BOUNDS = { x: 100, z: 95, yMin: 0, yMax: 10 };
export const ANIMS = new Set(["idle", "walk", "run", "jump", "sit"]);
export const ACTION_TYPES = new Set([
  "score",
  "iceCream",
  "iceCreamDone",
  "photo",
  "roar",
  "dig",
  "battle",
  "wave",
  "cheer",
]);
/** Ice cream orders, mirroring FLAVOURS / TOPPINGS in public/js/ui.js. */
export const ICE_FLAVOURS = new Set([
  "strawberry",
  "mintchoco",
  "dinodust",
  "volcano",
  "blueberry",
  "caramel",
  "matcha",
  "vanilla",
]);
export const ICE_TOPPINGS = new Set(["sprinkles", "chocolate", "cherry"]);
export const ICE_STYLES = new Set(["cone", "cup"]);
const ICE_SCOOPS_MAX = 3;

// Battle ids come straight from the client's programme so the two cannot
// drift. If that module fails to load, ids are only shape-checked.
const BATTLE_IDS = await import("../public/js/exhibits.js")
  .then((m) => new Set(m.BATTLES.map((b) => b.id)))
  .catch((e) => {
    console.warn("[museum] battle list unavailable, ids are only shape-checked", e?.message);
    return null;
  });
const BATTLE_ID_RE = /^[a-z0-9-]{1,40}$/;

const LOOK_COLOR_KEYS = new Set(["skin", "shirt", "pants", "hairColor"]);
const LOOK_STRING_KEYS = new Set(["hair", "accessory"]);
const LOOK_BODIES = new Set(["male", "female"]);
const HEX_RE = /^#[0-9a-f]{6}$/i;
const NAME_MAX = 18;
const CHAT_MAX = 240;
const ACTION_PAYLOAD_MAX = 512; // bytes of JSON
const SCORE_MAX_STEP = 50;
/** A battle restarts the overlay for the whole room: at most one per window. */
const BATTLE_COOLDOWN_MS = 15000;
/** Receivers flash their screen for a nearby photo: one per player per window. */
const PHOTO_COOLDOWN_MS = 2500;
/** Resume tokens let a reconnecting client take over its old player. */
const RESUME_RE = /^[\w-]{16,64}$/;
/** How long a dropped connection's player is held for its owner to resume. */
const RESUME_GRACE_MS = 5000;
/** Cross-instance: refresh this instance's roster entries + resync mirrors. */
const ROSTER_HEARTBEAT_MS = 15000;
/** Cross-instance: an unchanged state is republished at most this often. */
const STATE_KEEPALIVE_MS = 2000;
/** Cross-instance: a mirror missing from the roster is dropped once this quiet. */
const MIRROR_QUIET_MS = 5000;
/** Disconnect reasons where the client may come back on a new socket. */
const RESUMABLE_REASONS = new Set(["transport close", "transport error", "ping timeout"]);

/** Per-socket rate limits: { max events, per window ms }. */
const LIMITS = {
  chat: { max: 5, windowMs: 5000 },
  state: { max: 30, windowMs: 1000 },
  action: { max: 20, windowMs: 5000 },
  look: { max: 5, windowMs: 5000 },
  join: { max: 5, windowMs: 10000 },
};

/* ------------------------------------------------------------------ */
/* sanitisers                                                           */
/* ------------------------------------------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function sanitizeName(raw) {
  return (
    String(raw ?? "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NAME_MAX)
      .trim() || "Visitor"
  );
}

export function sanitizeLook(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const key of LOOK_COLOR_KEYS) {
    const v = raw[key];
    if (typeof v === "string" && HEX_RE.test(v)) out[key] = v.toLowerCase();
  }
  for (const key of LOOK_STRING_KEYS) {
    const v = raw[key];
    if (typeof v === "string" && v.length <= 16 && /^[\w-]+$/.test(v)) out[key] = v;
  }
  if (typeof raw.body === "string" && LOOK_BODIES.has(raw.body)) out.body = raw.body;
  return Object.keys(out).length ? out : null;
}

/** Returns a clean state or null when the message must be dropped. */
export function sanitizeState(p) {
  if (!p || typeof p !== "object") return null;
  const nums = {};
  for (const k of ["x", "y", "z", "ry"]) {
    // Strict: JSON turns NaN/Infinity into null, which Number() would make 0.
    const v = p[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    nums[k] = v;
  }
  const TAU = Math.PI * 2;
  let ry = nums.ry % TAU;
  if (ry > Math.PI) ry -= TAU;
  if (ry < -Math.PI) ry += TAU;
  const out = {
    x: clamp(nums.x, -WORLD_BOUNDS.x, WORLD_BOUNDS.x),
    y: clamp(nums.y, WORLD_BOUNDS.yMin, WORLD_BOUNDS.yMax),
    z: clamp(nums.z, -WORLD_BOUNDS.z, WORLD_BOUNDS.z),
    ry,
    anim: ANIMS.has(p.anim) ? p.anim : "idle",
  };
  // Optional sender clock (ms, the sender's performance.now()): receivers use
  // it to space snapshots by when they were sent, not when they arrived.
  // Always present (undefined when absent) so Object.assign clears a stale one.
  const ts = p.ts;
  out.ts = typeof ts === "number" && Number.isFinite(ts) && ts >= 0 && ts < 1e12 ? Math.round(ts) : undefined;
  return out;
}

/** Returns a clean ice cream order or null when the order is not valid. */
export function sanitizeIceCream(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (typeof raw.flavour !== "string" || !ICE_FLAVOURS.has(raw.flavour)) return null;
  const n = Number(raw.scoops);
  const toppings = Array.isArray(raw.toppings)
    ? [...new Set(raw.toppings.filter((t) => typeof t === "string" && ICE_TOPPINGS.has(t)))]
    : [];
  return {
    flavour: raw.flavour,
    scoops: Number.isFinite(n) ? clamp(Math.round(n), 1, ICE_SCOOPS_MAX) : 1,
    style: ICE_STYLES.has(raw.style) ? raw.style : "cone",
    toppings,
  };
}

/**
 * Returns the payload to relay for an action, or undefined when the action
 * must be dropped. Every receiving client acts on these, so nothing is
 * relayed as-is.
 */
export function sanitizeActionPayload(type, payload) {
  switch (type) {
    case "score": {
      const n = Number(payload);
      return Number.isFinite(n) ? clamp(Math.round(n), 1, SCORE_MAX_STEP) : 1;
    }
    case "iceCream":
      return sanitizeIceCream(payload) ?? undefined;
    case "battle": {
      const id = payload?.id;
      if (typeof id !== "string" || !BATTLE_ID_RE.test(id)) return undefined;
      if (BATTLE_IDS && !BATTLE_IDS.has(id)) return undefined;
      return { id };
    }
    default:
      return ACTION_TYPES.has(type) ? {} : undefined;
  }
}

function payloadSize(v) {
  if (v === undefined) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(v));
  } catch {
    return Infinity; // circular / unserialisable
  }
}

function rateLimiter() {
  const hits = new Map(); // kind -> timestamps
  return function allow(kind, now = Date.now()) {
    const lim = LIMITS[kind];
    if (!lim) return true;
    let list = hits.get(kind);
    if (!list) hits.set(kind, (list = []));
    while (list.length && now - list[0] >= lim.windowMs) list.shift();
    if (list.length >= lim.max) return false;
    list.push(now);
    return true;
  };
}

/**
 * Builds the Express + Socket.IO application used both by the local dev
 * server and by the Vercel serverless function.
 */
export function createMuseumServer({ staticDir = null, mountPath = null, sync: syncOptions = {} } = {}) {
  const app = express();
  const server = createServer(app);

  // On Vercel the function is mounted at /api/socket. Depending on the
  // platform the request URL may or may not keep that prefix, so normalise it
  // to the plain Socket.IO path before Socket.IO inspects the upgrade.
  if (mountPath) {
    server.prependListener("upgrade", (req) => {
      if (req.url.startsWith(mountPath)) {
        req.url = req.url.slice(mountPath.length) || "/socket.io";
      }
    });
  }

  const io = new Server(server, {
    cors: { origin: "*" },
    // Vercel strips the function mount path, so the default path works there
    // and locally. Long-polling is disabled client-side (see public/js/net.js).
    // A dead serverless instance only shows up as a missed heartbeat. Keep the
    // interval short so a cut is noticed in ~10-18 s instead of ~45 s.
    pingInterval: 10000,
    pingTimeout: 8000,
    maxHttpBufferSize: 1e5,
  });

  const sync = createSync(syncOptions);
  // Never wait longer than a roster entry takes to go stale.
  const mirrorQuietMs = Math.min(MIRROR_QUIET_MS, sync.staleMs);
  /**
   * code -> { code, players: Map<id, player>, createdAt, battleAt, gone }
   * `gone` remembers ids that recently left so a roster read that raced the
   * leave cannot bring them back as ghosts.
   */
  const rooms = new Map();

  function getRoom(code) {
    let room = rooms.get(code);
    if (!room) {
      room = { code, players: new Map(), createdAt: Date.now(), battleAt: 0, gone: new Map() };
      rooms.set(code, room);
    }
    return room;
  }

  function localCount(room) {
    let n = 0;
    for (const p of room.players.values()) if (!p.remote) n++;
    return n;
  }

  /** True while players from other instances share the room. */
  function hasRemote(room) {
    if (!room) return false;
    for (const p of room.players.values()) if (p.remote) return true;
    return false;
  }

  function tombstone(room, id) {
    const now = Date.now();
    room.gone.set(id, now);
    for (const [gid, at] of room.gone) if (now - at > sync.staleMs) room.gone.delete(gid);
  }

  const isGone = (room, id) => {
    const at = room.gone.get(id);
    return at !== undefined && Date.now() - at <= sync.staleMs;
  };

  /** Drop a room once no player on this instance is left in it. */
  function maybeDeleteRoom(code) {
    const room = rooms.get(code);
    if (!room || localCount(room) > 0) return;
    rooms.delete(code);
    sync.unwatch(code);
  }

  function newRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;
    do {
      code = Array.from(
        { length: 4 },
        () => chars[Math.floor(Math.random() * chars.length)]
      ).join("");
    } while (rooms.has(code));
    return code;
  }

  function pickColor(room) {
    const counts = new Map(PLAYER_PALETTE.map((c) => [c, 0]));
    for (const p of room.players.values()) {
      if (counts.has(p.color)) counts.set(p.color, counts.get(p.color) + 1);
    }
    // First free colour in palette order, otherwise the least used one.
    let best = PLAYER_PALETTE[0];
    for (const c of PLAYER_PALETTE) if (counts.get(c) < counts.get(best)) best = c;
    return best;
  }

  function publicPlayer(p) {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      score: p.score || 0,
      iceCream: p.iceCream || null,
      look: p.look || null,
      x: p.x,
      y: p.y,
      z: p.z,
      ry: p.ry,
      anim: p.anim,
    };
  }

  function publicPlayers(room) {
    return Array.from(room.players.values()).map(publicPlayer);
  }

  /** Shared-roster entry: public fields + the resume key (never sent to clients). */
  const rosterEntry = (p) => (p.k ? { ...publicPlayer(p), k: p.k } : publicPlayer(p));

  const hashToken = (token) => createHash("sha256").update(token).digest("base64url").slice(0, 22);

  /** Emit to every local socket in the room except (optionally) one. */
  function fanOut(code, type, payload, exceptId = null) {
    const target = exceptId ? io.to(code).except(exceptId) : io.to(code);
    target.emit(type, payload);
  }

  /** Fan out locally and publish to other instances (`meta` rides along unseen by clients). */
  function pushEvent(code, type, payload, exceptId = null, meta = null) {
    if (!code) return;
    fanOut(code, type, payload, exceptId);
    sync.publish(code, { ...meta, t: type, p: payload });
  }

  function publishState(code, player) {
    const s = { id: player.id, x: player.x, y: player.y, z: player.z, ry: player.ry, anim: player.anim };
    if (player.ts !== undefined) s.ts = player.ts;
    player.pubKey = `${s.x},${s.y},${s.z},${s.ry},${s.anim}`;
    player.pubAt = Date.now();
    sync.publish(code, { t: "state", p: s });
  }

  /**
   * Another instance just joined the room: states are only published while
   * someone elsewhere is listening, so send it where our players stand now.
   */
  function republishLocalStates(code, room) {
    for (const p of room.players.values()) if (!p.remote && !p.away) publishState(code, p);
  }

  /** Mirror of a player on another instance, rebuilt from untrusted data. */
  function mirrorFrom(e, k) {
    const s = sanitizeState(e) || { x: 0, y: 0, z: 0, ry: 0, anim: "idle" };
    const score = Number(e.score);
    return {
      id: e.id,
      name: sanitizeName(e.name),
      color: typeof e.color === "string" && HEX_RE.test(e.color) ? e.color : PLAYER_PALETTE[0],
      score: Number.isFinite(score) ? Math.max(0, Math.round(score)) : 0,
      iceCream: sanitizeIceCream(e.iceCream),
      look: sanitizeLook(e.look),
      ...s,
      remote: true,
      k: typeof k === "string" ? k : undefined,
      seenAt: Date.now(),
    };
  }

  /**
   * Add a mirror for a player on another instance and announce it to our
   * sockets. A no-op for players we already have (or who just left), so a
   * player seen in a roster and then in its own playerJoined event is only
   * announced once.
   */
  function addMirror(code, room, entry, k) {
    if (!entry || typeof entry.id !== "string" || !entry.id) return null;
    if (entry.inst === sync.instanceId) return null; // our own roster entry
    if (room.players.has(entry.id) || isGone(room, entry.id)) return null;
    const m = mirrorFrom(entry, k ?? entry.k);
    room.players.set(m.id, m);
    fanOut(code, "playerJoined", publicPlayer(m));
    republishLocalStates(code, room);
    return m;
  }

  /** Remove a local player (and its socket) without announcing a leave. */
  function evictLocal(code, room, prev) {
    clearTimeout(prev.graceTimer);
    room.players.delete(prev.id);
    tombstone(room, prev.id);
    sync.removePlayer(code, prev.id);
    const old = io.sockets.sockets.get(prev.id);
    if (old && old.data.room === code) {
      old.data.room = null;
      old.leave(code);
      old.disconnect(true);
    }
  }

  /** The player a reconnecting client left behind, if its resume key matches. */
  function findResumable(room, k, prevId) {
    const byId = typeof prevId === "string" ? room.players.get(prevId) : null;
    if (byId && byId.k === k) return byId;
    for (const p of room.players.values()) if (p.k === k) return p;
    return null;
  }

  /** A player reconnected through another instance: swap ids silently. */
  function onRemoteRejoin(code, r, p, k) {
    if (typeof p.id !== "string" || !p.id) return;
    const oldId = typeof p.oldId === "string" ? p.oldId : null;
    const prev = oldId ? r.players.get(oldId) : null;
    let swapped = false;
    if (prev && k && prev.k === k) {
      if (prev.remote) {
        r.players.delete(oldId);
        tombstone(r, oldId);
      } else {
        evictLocal(code, r, prev);
      }
      swapped = true;
    }
    if (r.players.has(p.id) || isGone(r, p.id)) return;
    const m = mirrorFrom(p, k);
    r.players.set(m.id, m);
    if (swapped) fanOut(code, "playerRejoined", { ...publicPlayer(m), oldId });
    else fanOut(code, "playerJoined", publicPlayer(m));
    republishLocalStates(code, r);
  }

  /** Apply an event relayed from another instance to our mirror of the room. */
  function onRemoteEvent(code, ev) {
    const r = rooms.get(code);
    if (!r || !ev || !ev.p || typeof ev.p !== "object") return;
    const p = ev.p;
    const id = p.id;
    const k = typeof ev.k === "string" ? ev.k : undefined;
    const mirror = r.players.get(id);
    const remote = mirror && mirror.remote ? mirror : null;
    if (remote) remote.seenAt = Date.now();

    switch (ev.t) {
      case "playerJoined":
        // A join event is ordered after any earlier leave of the same id in
        // the stream, so it overrides the tombstone (which only guards
        // against stale roster reads).
        if (typeof id === "string") r.gone.delete(id);
        addMirror(code, r, p, k);
        return;
      case "playerRejoined":
        onRemoteRejoin(code, r, p, k);
        return;
      case "playerLeft":
        // Only announce leaves we actually applied (duplicates, resends).
        if (!remote) return;
        r.players.delete(id);
        tombstone(r, id);
        fanOut(code, "playerLeft", { id, name: remote.name });
        return;
      case "state": {
        // Unknown ids would make clients spawn an avatar out of nowhere.
        if (!remote) return;
        const s = sanitizeState(p);
        if (!s) return;
        Object.assign(remote, s);
        fanOut(code, "state", { id, ...s });
        return;
      }
      case "look":
        if (!remote) return;
        remote.look = sanitizeLook(p.look);
        fanOut(code, "look", { id, look: remote.look });
        return;
      case "action": {
        if (!remote || typeof p.type !== "string" || !ACTION_TYPES.has(p.type)) return;
        const payload = sanitizeActionPayload(p.type, p.payload);
        if (payload === undefined) return;
        if (p.type === "iceCream") remote.iceCream = payload;
        const score = Number(p.score);
        if (Number.isFinite(score)) remote.score = Math.max(0, Math.round(score));
        fanOut(code, "action", { id, name: remote.name, type: p.type, payload, score: remote.score || 0 });
        return;
      }
      case "chat":
        if (typeof p.text !== "string" || !p.text.trim()) return;
        fanOut(code, "chat", { id, name: sanitizeName(p.name), text: p.text.slice(0, CHAT_MAX) });
        return;
      default:
    }
  }

  /**
   * Bring our mirrors in line with the shared roster: drop players whose
   * leave we never heard about (lost publish, trimmed stream, killed
   * instance) and add players whose join we missed.
   */
  async function reconcile(code) {
    const room = rooms.get(code);
    if (!room || !sync.enabled) return;
    const roster = await sync.getRoster(code);
    if (!roster || rooms.get(code) !== room) return;
    const now = Date.now();
    const live = new Map();
    for (const e of roster) {
      if (!e || typeof e.id !== "string") continue;
      if (e.inst === sync.instanceId) {
        // Ours, but no such player here any more: a write that raced a leave.
        if (!room.players.has(e.id)) sync.removePlayer(code, e.id);
        continue;
      }
      live.set(e.id, e);
    }
    for (const [id, p] of room.players) {
      // A brand-new mirror may simply not be in the roster yet, so only drop
      // mirrors that have also gone quiet.
      if (p.remote && !live.has(id) && now - (p.seenAt || 0) > mirrorQuietMs) {
        room.players.delete(id);
        tombstone(room, id);
        fanOut(code, "playerLeft", { id, name: p.name });
      }
    }
    for (const e of live.values()) addMirror(code, room, e);
  }

  /**
   * Keep this instance's roster entries fresh (entries that stop being
   * refreshed are treated as gone, which cleans up after a killed instance)
   * and resync every room's mirrors.
   */
  function heartbeat() {
    for (const [code, room] of rooms) {
      const locals = [];
      for (const p of room.players.values()) if (!p.remote) locals.push(rosterEntry(p));
      sync.touchPlayers(code, locals);
      reconcile(code).catch((e) => console.warn("[museum] roster resync failed", e?.message));
    }
  }
  if (sync.enabled) {
    const hb = setInterval(heartbeat, syncOptions.heartbeatMs ?? ROSTER_HEARTBEAT_MS);
    hb.unref?.();
    server.on("close", () => clearInterval(hb));
  }

  /** Remove a local player from its room and tell everybody. */
  function dropPlayer(code, player) {
    clearTimeout(player.graceTimer);
    const room = rooms.get(code);
    if (!room || room.players.get(player.id) !== player) return;
    room.players.delete(player.id);
    tombstone(room, player.id);
    pushEvent(code, "playerLeft", { id: player.id, name: player.name });
    sync.removePlayer(code, player.id);
    maybeDeleteRoom(code);
  }

  /**
   * Remove the socket's player from its current room (if any). With
   * `holdForResume` a player that has a resume key stays (frozen) for
   * RESUME_GRACE_MS, so a quick reconnect takes it over silently instead of
   * everyone seeing "left" + "joined" and the colour/score resetting.
   */
  function leaveRoom(socket, { holdForResume = false } = {}) {
    const code = socket.data.room;
    if (!code) return;
    socket.data.room = null;
    socket.leave(code);
    const room = rooms.get(code);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) {
      maybeDeleteRoom(code);
      return;
    }
    if (holdForResume && player.k) {
      player.away = true;
      player.graceTimer = setTimeout(() => dropPlayer(code, player), RESUME_GRACE_MS);
      player.graceTimer.unref?.();
      return;
    }
    dropPlayer(code, player);
  }

  async function doJoin(socket, opts, ack) {
    const reply = typeof ack === "function" ? ack : () => {};
    if (!socket.connected) return;
    if (!socket.data.allow("join")) {
      reply({ error: "rate_limited" });
      return;
    }
    if (!opts || typeof opts !== "object") opts = {};

    const name = sanitizeName(opts.name);
    let code = String(opts.room || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8);
    if (code.length < 3) code = newRoomCode();
    const k = typeof opts.resume === "string" && RESUME_RE.test(opts.resume) ? hashToken(opts.resume) : null;

    // Re-join on the same socket: leave the previous room first.
    leaveRoom(socket);

    const watchRoom = () =>
      sync.watch(code, (ev) => onRemoteEvent(code, ev), {
        shared: () => hasRemote(rooms.get(code)),
        onGap: () => reconcile(code).catch(() => {}),
      });
    let remoteRoster = null;
    if (sync.enabled) {
      // Every Redis call is time-limited (see sync.js), so a slow or
      // unreachable Redis degrades this join to local-only instead of hanging.
      await watchRoom();
      remoteRoster = await sync.getRoster(code);
      if (!socket.connected) {
        if (rooms.has(code)) maybeDeleteRoom(code);
        else sync.unwatch(code);
        return;
      }
    }

    // Look the room up only after the awaits: it may have been deleted (and
    // its poller stopped) by another socket leaving in the meantime.
    const room = getRoom(code);
    if (sync.enabled) {
      watchRoom(); // no-op when already polling
      // Our sockets in the room are told about any mirror added here; the
      // joiner gets them in its roster below.
      for (const r of remoteRoster || []) if (r && r.id !== socket.id) addMirror(code, room, r);
    }

    // Reconnect: take over the player this client left behind (possibly a
    // ghost whose dead socket the server has not noticed yet).
    const prev = k ? findResumable(room, k, opts.prevId) : null;
    if (prev) {
      if (prev.remote) {
        room.players.delete(prev.id);
        tombstone(room, prev.id);
        sync.removePlayer(code, prev.id);
      } else {
        evictLocal(code, room, prev);
      }
    }

    const spawn = sanitizeState(opts.state);
    const player = {
      id: socket.id,
      name,
      color: prev?.color ?? pickColor(room),
      score: prev?.score || 0,
      iceCream: prev?.iceCream ?? null,
      look: sanitizeLook(opts.look) ?? prev?.look ?? null,
      x: spawn?.x ?? prev?.x ?? 0,
      y: spawn?.y ?? prev?.y ?? 0,
      z: spawn?.z ?? prev?.z ?? 0,
      ry: spawn?.ry ?? prev?.ry ?? 0,
      anim: spawn?.anim ?? "idle",
      k,
    };
    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.room = code;
    socket.data.name = name;

    // Tell everybody (including other instances) that this player arrived,
    // or, on a resume, that it is the same player under a new id.
    const meta = k ? { k } : null;
    if (prev) pushEvent(code, "playerRejoined", { ...publicPlayer(player), oldId: prev.id }, socket.id, meta);
    else pushEvent(code, "playerJoined", publicPlayer(player), socket.id, meta);
    sync.addPlayer(code, rosterEntry(player));

    // Roster = local players + mirrors of players on other instances.
    const roster = publicPlayers(room);

    reply({
      id: socket.id,
      room: code,
      color: player.color,
      players: roster,
      crossInstance: sync.enabled,
      resumed: Boolean(prev),
      score: player.score,
    });
  }

  io.on("connection", (socket) => {
    socket.data.room = null;
    socket.data.name = "Visitor";
    socket.data.allow = rateLimiter();
    let joinChain = Promise.resolve();

    const current = () => {
      const room = rooms.get(socket.data.room);
      const player = room?.players.get(socket.id);
      return player ? { room, player, code: socket.data.room } : null;
    };

    const limited = (kind) => {
      if (socket.data.allow(kind)) return false;
      if (kind !== "state") socket.emit("rateLimited", { type: kind });
      return true;
    };

    socket.on("join", (opts, ack) => {
      // Serialise joins so a double "join" can never interleave.
      joinChain = joinChain
        .then(() => doJoin(socket, opts, ack))
        .catch((e) => console.warn("[museum] join failed", e?.message));
    });

    socket.on("state", (p) => {
      const cur = current();
      if (!cur) return;
      if (limited("state")) return;
      const s = sanitizeState(p);
      if (!s) return;
      Object.assign(cur.player, s);
      fanOut(cur.code, "state", { id: socket.id, ...s }, socket.id);
      // Other instances only need the stream while one of their players is
      // in the room, and an idle player's identical states only as a slow
      // keepalive: every publish is a paid Redis command.
      if (sync.enabled && hasRemote(cur.room)) {
        const key = `${s.x},${s.y},${s.z},${s.ry},${s.anim}`;
        if (key !== cur.player.pubKey || Date.now() - (cur.player.pubAt || 0) >= STATE_KEEPALIVE_MS) {
          publishState(cur.code, cur.player);
        }
      }
    });

    socket.on("look", (look) => {
      const cur = current();
      if (!cur) return;
      if (limited("look")) return;
      cur.player.look = sanitizeLook(look);
      pushEvent(cur.code, "look", { id: socket.id, look: cur.player.look }, socket.id);
      sync.addPlayer(cur.code, rosterEntry(cur.player));
    });

    socket.on("chat", (text) => {
      const cur = current();
      if (!cur) return;
      if (typeof text !== "string") return;
      // eslint-disable-next-line no-control-regex
      const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").slice(0, CHAT_MAX);
      if (!clean.trim()) return;
      if (limited("chat")) return;
      // Chat is echoed to the sender too: the client renders chat only from
      // the server so everyone sees the same (sanitised) text and order.
      pushEvent(cur.code, "chat", {
        id: socket.id,
        name: cur.player.name,
        text: clean,
      });
    });

    socket.on("action", (msg) => {
      const cur = current();
      if (!cur) return;
      if (!msg || typeof msg !== "object") return;
      const type = msg.type;
      if (typeof type !== "string" || !ACTION_TYPES.has(type)) return;
      if (payloadSize(msg.payload) > ACTION_PAYLOAD_MAX) return;
      // Receivers build meshes / start the cinema from these: relay only
      // whitelisted, clamped payloads.
      const payload = sanitizeActionPayload(type, msg.payload ?? null);
      if (payload === undefined) return;
      if (limited("action")) return;
      const { player, room } = cur;

      if (type === "battle") {
        const now = Date.now();
        if (now - room.battleAt < BATTLE_COOLDOWN_MS) {
          socket.emit("rateLimited", { type: "battle" });
          return;
        }
        room.battleAt = now;
      }
      if (type === "photo") {
        const now = Date.now();
        if (now - (player.photoAt || 0) < PHOTO_COOLDOWN_MS) return;
        player.photoAt = now;
      }
      if (type === "score") player.score = (player.score || 0) + payload;
      if (type === "iceCream" || type === "iceCreamDone") {
        // finished eating: late joiners should no longer see it in the hand
        player.iceCream = type === "iceCream" ? payload : null;
        sync.addPlayer(cur.code, rosterEntry(player));
      }
      // The sender already applied the action locally: don't echo it back.
      pushEvent(
        cur.code,
        "action",
        { id: socket.id, name: player.name, type, payload, score: player.score || 0 },
        socket.id
      );
    });

    socket.on("disconnect", (reason) => {
      leaveRoom(socket, { holdForResume: RESUMABLE_REASONS.has(reason) });
    });
  });

  const health = (_req, res) => {
    let players = 0;
    for (const r of rooms.values()) players += localCount(r);
    res.json({
      ok: true,
      rooms: rooms.size,
      players,
      crossInstance: sync.enabled,
      instance: sync.instanceId,
    });
  };

  app.get("/health", health);
  if (staticDir) {
    app.use(express.static(staticDir));
    // SPA fallback for page routes only: a missing asset (/js/x.js,
    // /models/x.glb, anything under an asset folder even without an
    // extension) must be a real 404, not index.html with status 200.
    const ASSET_DIRS = /^\/(?:images|models|data|textures|vendor|js|css|audio|video|fonts)(?:\/|$)/;
    app.get(/^\/(?!api\/|socket\.io\/|health$).*/, (req, res, next) => {
      const last = req.path.slice(req.path.lastIndexOf("/") + 1);
      if (ASSET_DIRS.test(req.path) || /\.[A-Za-z0-9]+$/.test(last) || !req.accepts("html")) return next();
      res.sendFile("index.html", { root: staticDir });
    });
  }

  return { app, server, io, rooms, sync };
}
