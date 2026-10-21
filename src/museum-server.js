import { createServer } from "node:http";
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
  "photo",
  "roar",
  "dig",
  "battle",
  "wave",
  "sit",
  "cheer",
]);
const LOOK_COLOR_KEYS = new Set(["skin", "shirt", "pants", "hairColor"]);
const LOOK_STRING_KEYS = new Set(["hair", "accessory"]);
const LOOK_BODIES = new Set(["male", "female"]);
const HEX_RE = /^#[0-9a-f]{6}$/i;
const NAME_MAX = 18;
const CHAT_MAX = 240;
const ACTION_PAYLOAD_MAX = 512; // bytes of JSON
const SCORE_MAX_STEP = 50;

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
  return {
    x: clamp(nums.x, -WORLD_BOUNDS.x, WORLD_BOUNDS.x),
    y: clamp(nums.y, WORLD_BOUNDS.yMin, WORLD_BOUNDS.yMax),
    z: clamp(nums.z, -WORLD_BOUNDS.z, WORLD_BOUNDS.z),
    ry,
    anim: ANIMS.has(p.anim) ? p.anim : "idle",
  };
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
export function createMuseumServer({ staticDir = null, mountPath = null } = {}) {
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
    pingInterval: 20000,
    pingTimeout: 25000,
    maxHttpBufferSize: 1e5,
  });

  const sync = createSync();
  /** code -> { code, players: Map<id, player>, createdAt } */
  const rooms = new Map();

  function getRoom(code) {
    let room = rooms.get(code);
    if (!room) {
      room = { code, players: new Map(), createdAt: Date.now() };
      rooms.set(code, room);
    }
    return room;
  }

  function localCount(room) {
    let n = 0;
    for (const p of room.players.values()) if (!p.remote) n++;
    return n;
  }

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

  /** Emit to every local socket in the room except (optionally) one. */
  function fanOut(code, type, payload, exceptId = null) {
    const target = exceptId ? io.to(code).except(exceptId) : io.to(code);
    target.emit(type, payload);
  }

  function pushEvent(code, type, payload, exceptId = null) {
    if (!code) return;
    fanOut(code, type, payload, exceptId);
    sync.publish(code, { t: type, p: payload });
  }

  /** Apply an event relayed from another instance to our mirror of the room. */
  function onRemoteEvent(code, ev) {
    const r = rooms.get(code);
    if (!r || !ev || !ev.p) return;
    const id = ev.p.id;
    if (ev.t === "playerJoined") {
      if (id && !r.players.has(id)) r.players.set(id, { ...ev.p, remote: true });
    } else if (ev.t === "playerLeft") {
      const p = r.players.get(id);
      if (p && p.remote) r.players.delete(id);
    } else {
      const p = r.players.get(id);
      if (p && p.remote) {
        if (ev.t === "state") Object.assign(p, sanitizeState(ev.p) || {});
        if (ev.t === "look") p.look = sanitizeLook(ev.p.look);
        if (ev.t === "action" && ev.p.type === "score") p.score = ev.p.score ?? p.score;
        if (ev.t === "action" && ev.p.type === "iceCream") p.iceCream = ev.p.payload || null;
      }
    }
    fanOut(code, ev.t, ev.p);
  }

  /** Remove the socket's player from its current room (if any). */
  function leaveRoom(socket) {
    const code = socket.data.room;
    if (!code) return;
    socket.data.room = null;
    socket.leave(code);
    const room = rooms.get(code);
    if (!room) return;
    if (room.players.delete(socket.id)) {
      pushEvent(code, "playerLeft", { id: socket.id, name: socket.data.name });
      sync.removePlayer(code, socket.id);
    }
    maybeDeleteRoom(code);
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

    // Re-join on the same socket: leave the previous room first.
    leaveRoom(socket);

    const watchRoom = () => sync.watch(code, (ev) => onRemoteEvent(code, ev));
    let remoteRoster = null;
    if (sync.enabled) {
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
      for (const r of remoteRoster || []) {
        if (r && r.id && r.id !== socket.id && !room.players.has(r.id)) {
          room.players.set(r.id, { ...r, remote: true });
        }
      }
    }

    const spawn = sanitizeState(opts.state);
    const player = {
      id: socket.id,
      name,
      color: pickColor(room),
      score: 0,
      iceCream: null,
      look: sanitizeLook(opts.look),
      x: spawn?.x ?? 0,
      y: spawn?.y ?? 0,
      z: spawn?.z ?? 0,
      ry: spawn?.ry ?? 0,
      anim: spawn?.anim ?? "idle",
    };
    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.room = code;
    socket.data.name = name;

    // Tell everybody (including other instances) that this player arrived.
    pushEvent(code, "playerJoined", publicPlayer(player), socket.id);
    sync.addPlayer(code, publicPlayer(player));

    // Roster = local players + mirrors of players on other instances.
    const roster = publicPlayers(room);

    reply({
      id: socket.id,
      room: code,
      color: player.color,
      players: roster,
      crossInstance: sync.enabled,
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
      pushEvent(cur.code, "state", { id: socket.id, ...s }, socket.id);
      // Keep the shared roster's last position roughly fresh for players
      // joining through another instance (throttled: one write per 2 s).
      const now = Date.now();
      if (sync.enabled && now - (cur.player.rosterAt || 0) > 2000) {
        cur.player.rosterAt = now;
        sync.addPlayer(cur.code, publicPlayer(cur.player));
      }
    });

    socket.on("look", (look) => {
      const cur = current();
      if (!cur) return;
      if (limited("look")) return;
      cur.player.look = sanitizeLook(look);
      pushEvent(cur.code, "look", { id: socket.id, look: cur.player.look }, socket.id);
      sync.addPlayer(cur.code, publicPlayer(cur.player));
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
      if (limited("action")) return;
      const { player } = cur;

      let payload = msg.payload ?? null;
      if (type === "score") {
        const n = Number(payload);
        payload = Number.isFinite(n) ? clamp(Math.round(n), 1, SCORE_MAX_STEP) : 1;
        player.score = (player.score || 0) + payload;
      }
      if (type === "iceCream") {
        player.iceCream = payload && typeof payload === "object" ? payload : null;
      }
      // The sender already applied the action locally: don't echo it back.
      pushEvent(
        cur.code,
        "action",
        { id: socket.id, name: player.name, type, payload, score: player.score || 0 },
        socket.id
      );
    });

    socket.on("disconnect", () => {
      leaveRoom(socket);
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
    app.get(/^\/(?!api\/|socket\.io\/|health$).*/, (_req, res) => {
      res.sendFile("index.html", { root: staticDir });
    });
  }

  return { app, server, io, rooms, sync };
}
