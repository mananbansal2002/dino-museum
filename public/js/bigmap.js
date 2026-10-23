import {
  ROOMS,
  PLACEMENTS,
  OBSTACLES,
  PROP_OBSTACLES,
  DISPLAYS,
  THEATRE_SEATS,
  SCREEN,
  COURT,
  CELL,
  GRID_W,
  GRID_H,
  g2w,
  g2z,
  isSolid,
  passable,
  roomAt,
  resolveCollision,
} from "./world.js";

/**
 * Full-screen museum map with fast travel.
 *
 *   import { createBigMap, hallEntryPoint, teleportPlayer } from "./bigmap.js";
 *   const bigMap = createBigMap({
 *     getLocal: () => S.player?.state,           // { x, z, ry }
 *     getPlayers: () => remote.list,              // [{ x, z, color, name }]
 *     getVisited: () => visitedRooms,             // optional: room ids
 *     onTravel: (roomId, point) => teleportPlayer(S.player, point),
 *   });
 *   bigMap.track(x, z);   // every frame: remembers the rooms you walk into
 *   bigMap.open(); bigMap.close(); bigMap.isOpen();
 *
 * The floor plan is drawn from the same world data as the minimap (ROOMS,
 * isSolid, g2w) but large, with inner walls and doorways. Halls you have
 * walked into are lit and clickable; the others are greyed out. The secret
 * end of the tour (rooms with `secret: true`) is not drawn, listed, counted
 * or hinted at until the visitor has stood in it, and a friend standing in
 * an unrevealed secret room is left off the map too.
 *
 * While open the map owns the keyboard (capture phase, like the settings
 * panel): Esc or the hotkey closes it, 1-9 / 0 travel to the numbered hall,
 * and nothing else reaches the game. Pointer lock is released on open.
 */

const CSS_HREF = "/css/bigmap.css";

/** Rooms you can travel to, in list order (corridors and links are not destinations). */
const TRAVEL_ORDER = ["lobby", "porch", "rotunda", "theater", "cretaceous", "predator", "triassic", "marine", "jurassic", "court"];

/** What a visitor arriving in each hall should be looking at. */
const FOCUS = {
  cretaceous: "trex",
  predator: "giganoto",
  rotunda: "spino",
  triassic: "plateosaurus",
  jurassic: "brachio",
  marine: "mosa",
  lobby: "quetzal",
};

const ROOM_BY_ID = new Map(ROOMS.map((r) => [r.id, r]));
const roomArea = (r) => (r.cols[1] - r.cols[0] + 1) * (r.rows[1] - r.rows[0] + 1);

/** Destinations: the listed halls first, then any other room that is not a corridor. */
export const TRAVEL_ROOMS = [
  ...TRAVEL_ORDER.filter((id) => ROOM_BY_ID.has(id)),
  ...ROOMS.filter((r) => !TRAVEL_ORDER.includes(r.id) && roomArea(r) > 12).map((r) => r.id),
];

function roomBounds(room) {
  return {
    minX: g2w(room.cols[0]) - CELL / 2,
    maxX: g2w(room.cols[1]) + CELL / 2,
    minZ: g2z(room.rows[0]) - CELL / 2,
    maxZ: g2z(room.rows[1]) + CELL / 2,
  };
}

/* ------------------------------------------------------------------ */
/* entry points                                                         */
/* ------------------------------------------------------------------ */

/** The point a visitor arriving in `room` should face, plus what it is. */
function focusOf(room) {
  const b = roomBounds(room);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  if (room.id === "theater") return { x: SCREEN.x, z: SCREEN.z, near: false };
  if (room.id === "court") return { x: COURT.stallX, z: COURT.stallZ, near: true };
  if (room.id === "porch") {
    // the plaza looks back in at the museum doors
    const lobby = ROOM_BY_ID.get("lobby");
    if (lobby) return { x: cx, z: roomBounds(lobby).minZ, near: false };
  }
  const inRoom = PLACEMENTS.filter((p) => roomAt(p.x, p.z)?.id === room.id);
  const main = inRoom.find((p) => p.id === FOCUS[room.id]) || [...inRoom].sort((a, b2) => (b2.pedestal || 0) - (a.pedestal || 0))[0];
  if (main) return { x: main.x, z: main.z, near: true };
  // a corridor: look down its long axis
  if (b.maxX - b.minX >= b.maxZ - b.minZ) return { x: b.maxX, z: cz, near: false };
  return { x: cx, z: b.minZ, near: false };
}

const BLOCKERS = [
  ...OBSTACLES,
  ...PROP_OBSTACLES,
  ...DISPLAYS.map((d) => ({ id: `display:${d.speciesId}`, ...d.bounds })),
];

function insideBlocker(x, z, pad, skip) {
  for (const o of BLOCKERS) {
    if (skip && skip(o)) continue;
    if (Number.isFinite(o.r)) {
      if (Math.hypot(x - o.x, z - o.z) < o.r + pad) return true;
    } else if (x > o.minX - pad && x < o.maxX + pad && z > o.minZ - pad && z < o.maxZ + pad) {
      return true;
    }
  }
  return false;
}

/** Room for a visitor (plus a margin) to stand here without touching anything. */
function standable(x, z, roomId) {
  const pad = 1.1;
  if (roomAt(x, z)?.id !== roomId) return false;
  // every point of the visitor's circle must be in the same room
  for (const [dx, dz] of [[pad, 0], [-pad, 0], [0, pad], [0, -pad]]) {
    if (roomAt(x + dx, z + dz)?.id !== roomId) return false;
  }
  const [cx, cz] = resolveCollision(x, z, pad);
  if (Math.abs(cx - x) > 1e-4 || Math.abs(cz - z) > 1e-4) return false;
  if (insideBlocker(x, z, pad)) return false;
  // theatre seats are walkable but nobody should arrive sitting in a row
  if (roomId === "theater" && THEATRE_SEATS.some((s) => Math.hypot(s.x - x, s.z - z) < 0.95)) return false;
  return true;
}

/** Nothing solid between the eye and the target (the target's own plinth excepted). */
function clearView(x, z, tx, tz) {
  const d = Math.hypot(tx - x, tz - z);
  const near = (o) => {
    const ox = Number.isFinite(o.r) ? o.x : (o.minX + o.maxX) / 2;
    const oz = Number.isFinite(o.r) ? o.z : (o.minZ + o.maxZ) / 2;
    return Math.hypot(ox - tx, oz - tz) < 3.2;
  };
  for (let t = 0.8; t < d - 2.4; t += 0.5) {
    const k = t / d;
    if (insideBlocker(x + (tx - x) * k, z + (tz - z) * k, 0.15, near)) return false;
  }
  return true;
}

const entryCache = new Map();

/**
 * Where fast travel drops a visitor in `roomId`: a walkable spot near the
 * hall's centre, a comfortable distance from (and with a clear view of) its
 * main exhibit, facing it. Returns { x, z, ry, room } (ry: the visitor faces
 * (sin ry, cos ry), as player.state.ry) or null for an unknown room.
 */
export function hallEntryPoint(roomId) {
  if (entryCache.has(roomId)) return entryCache.get(roomId);
  const room = ROOM_BY_ID.get(roomId);
  if (!room) return null;
  const b = roomBounds(room);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const focus = focusOf(room);
  const span = Math.min(b.maxX - b.minX, b.maxZ - b.minZ);
  const ideal = focus.near ? Math.max(5, Math.min(11, span * 0.3)) : Math.max(4, span * 0.45);

  let best = null;
  for (let x = b.minX + 1; x <= b.maxX - 1; x += 0.5) {
    for (let z = b.minZ + 1; z <= b.maxZ - 1; z += 0.5) {
      const d = Math.hypot(focus.x - x, focus.z - z);
      if (focus.near && d < 3.5) continue;
      const score = Math.hypot(x - cx, z - cz) * 0.45 + Math.abs(d - ideal);
      if (best && score >= best.score) continue;
      if (!standable(x, z, room.id)) continue;
      if (focus.near && !clearView(x, z, focus.x, focus.z)) continue;
      best = { x, z, score };
    }
  }
  if (!best) best = { x: cx, z: cz };
  const point = {
    x: best.x,
    z: best.z,
    ry: Math.atan2(focus.x - best.x, focus.z - best.z),
    room: room.id,
  };
  entryCache.set(roomId, point);
  return point;
}

/**
 * Move a player made by createPlayer() to `point` ({ x, z, ry }). The player
 * notices the jump itself (camera snaps, velocity resets); a seated visitor
 * stands up first. Returns true when it moved.
 */
export function teleportPlayer(player, point) {
  if (!player?.state || !point) return false;
  if (player.isSitting) player.stand?.();
  const s = player.state;
  s.x = point.x;
  s.z = point.z;
  s.y = 0;
  s.vx = s.vz = s.vy = 0;
  s.onGround = true;
  if (Number.isFinite(point.ry)) {
    s.ry = point.ry;
    s.camYaw = point.ry;
  }
  s.pitch = -0.12;
  player.character?.group?.position.set(point.x, 0, point.z);
  if (player.character?.group && Number.isFinite(point.ry)) player.character.group.rotation.y = point.ry;
  return true;
}

/* ------------------------------------------------------------------ */
/* the map                                                              */
/* ------------------------------------------------------------------ */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function ensureStylesheet() {
  const has = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) =>
    (l.getAttribute("href") || "").endsWith("bigmap.css")
  );
  if (has) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  document.head.appendChild(link);
}

/** Number key for the i-th listed hall: 1..9, then 0. */
const hotkeyOf = (i) => String((i + 1) % 10);

const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;

function hexA(h, a) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * @param {object} opts
 * @param {() => ({x:number,z:number,ry:number}|null)} [opts.getLocal]  your position
 * @param {() => Array<{x:number,z:number,color?:string,name?:string}>} [opts.getPlayers]  other visitors
 * @param {() => Iterable<string>} [opts.getVisited]  room ids visited (merged with track())
 * @param {(id:string) => boolean} [opts.isRevealed]  e.g. minimap.isRevealed
 * @param {(roomId:string, point:{x,z,ry,room}) => (void|boolean)} [opts.onTravel]
 * @param {() => void} [opts.onOpen]
 * @param {() => void} [opts.onClose]
 * @param {string|null} [opts.hotkey="KeyM"]  also closes the map while it is open
 */
export function createBigMap({
  getLocal = () => null,
  getPlayers = () => [],
  getVisited = null,
  isRevealed = null,
  onTravel = null,
  onOpen = null,
  onClose = null,
  hotkey = "KeyM",
} = {}) {
  ensureStylesheet();

  const seen = new Set();
  let open = false;
  let raf = 0;
  let hover = null; // room id under the pointer
  let returnFocus = null;
  let staticKey = "";

  /* ---------------- DOM ---------------- */
  const root = el("div", "bmap-overlay");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Museum map");

  const card = el("div", "bmap-card");
  card.tabIndex = -1;
  const head = el("header", "bmap-head");
  const titles = el("div", "bmap-titles");
  titles.append(el("h2", "bmap-title", "Museum map"), el("p", "bmap-sub", "Pick a hall you have visited to travel straight there."));
  const closeBtn = el("button", "bmap-close");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close the map");
  closeBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  head.append(titles, closeBtn);

  const body = el("div", "bmap-body");
  const stage = el("div", "bmap-stage");
  const canvas = el("canvas", "bmap-canvas");
  const tip = el("div", "bmap-tip");
  tip.hidden = true;
  stage.append(canvas, tip);

  const side = el("aside", "bmap-side");
  const progress = el("div", "bmap-progress");
  const progressText = el("div", "bmap-progress-text");
  const bar = el("div", "bmap-bar");
  const barFill = el("span");
  bar.append(barFill);
  progress.append(progressText, bar);
  const list = el("ol", "bmap-list");
  const legend = el("div", "bmap-legend");
  legend.innerHTML =
    '<span><i class="bmap-key-you"></i>You</span>' +
    '<span><i class="bmap-key-friend"></i>Visitors</span>' +
    '<span><i class="bmap-key-exhibit"></i>Exhibits</span>' +
    '<span><i class="bmap-key-locked"></i>Not visited</span>';
  side.append(progress, list, legend);
  body.append(stage, side);

  const foot = el("footer", "bmap-foot");
  foot.innerHTML = "<span><kbd>1</kbd>–<kbd>9</kbd> travel</span><span><kbd>Esc</kbd> close</span>";
  card.append(head, body, foot);
  root.append(card);
  document.body.appendChild(root);

  const ctx = canvas.getContext("2d");
  const base = document.createElement("canvas");
  const bctx = base.getContext("2d");

  /* ---------------- state ---------------- */
  function visitedSet() {
    const v = new Set(seen);
    try {
      for (const id of getVisited?.() || []) v.add(id);
    } catch {
      /* ignore a failing callback */
    }
    const me = local();
    if (me) {
      // standing in a room counts as having visited it, even if track() was not called
      const here = roomAt(me.x, me.z);
      if (here) {
        seen.add(here.id);
        v.add(here.id);
      }
    }
    return v;
  }
  let visited = new Set();

  function local() {
    try {
      const p = getLocal?.();
      return p && Number.isFinite(p.x) && Number.isFinite(p.z) ? p : null;
    } catch {
      return null;
    }
  }

  const shown = (room) => !!room && (!room.secret || visited.has(room.id) || !!isRevealed?.(room.id));
  const cellRoom = (c, r) => (isSolid(c, r) ? null : roomAt(g2w(c), g2z(r)));
  const cellShown = (c, r) => shown(cellRoom(c, r));
  const canTravel = (id) => TRAVEL_ROOMS.includes(id) && visited.has(id) && shown(ROOM_BY_ID.get(id));
  const listed = () => TRAVEL_ROOMS.filter((id) => shown(ROOM_BY_ID.get(id)));
  const currentRoom = () => {
    const me = local();
    return me ? roomAt(me.x, me.z)?.id || null : null;
  };

  /* ---------------- layout ---------------- */
  // the outer ring of grid cells is always solid: crop to the floor plan
  const crop = (() => {
    let c0 = GRID_W;
    let c1 = 0;
    let r0 = GRID_H;
    let r1 = 0;
    for (const room of ROOMS) {
      c0 = Math.min(c0, room.cols[0]);
      c1 = Math.max(c1, room.cols[1]);
      r0 = Math.min(r0, room.rows[0]);
      r1 = Math.max(r1, room.rows[1]);
    }
    return {
      minX: g2w(c0) - CELL / 2 - 2,
      maxX: g2w(c1) + CELL / 2 + 2,
      minZ: g2z(r0) - CELL / 2 - 2,
      maxZ: g2z(r1) + CELL / 2 + 2,
    };
  })();
  let W = 1;
  let H = 1;
  let px = 1;
  let scale = 1;
  let offX = 0;
  let offY = 0;
  const toX = (wx) => offX + (wx - crop.minX) * scale;
  const toY = (wz) => offY + (wz - crop.minZ) * scale;
  const fromX = (sx) => (sx - offX) / scale + crop.minX;
  const fromY = (sy) => (sy - offY) / scale + crop.minZ;

  function fit() {
    const rect = stage.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const bw = Math.round(cssW * dpr);
    const bh = Math.round(cssH * dpr);
    if (canvas.width === bw && canvas.height === bh && W === cssW && H === cssH) return false;
    W = cssW;
    H = cssH;
    px = dpr;
    canvas.width = bw;
    canvas.height = bh;
    base.width = bw;
    base.height = bh;
    const pad = 14;
    const cw = crop.maxX - crop.minX;
    const ch = crop.maxZ - crop.minZ;
    scale = Math.min((W - pad * 2) / cw, (H - pad * 2) / ch);
    offX = (W - cw * scale) / 2;
    offY = (H - ch * scale) / 2;
    return true;
  }

  /* ---------------- static layer ---------------- */
  function roomRect(room) {
    const b = roomBounds(room);
    return { x0: toX(b.minX), x1: toX(b.maxX), y0: toY(b.minZ), y1: toY(b.maxZ) };
  }

  function label(text, sub, rect, color, subColor) {
    const maxW = rect.x1 - rect.x0 - 8;
    const maxH = rect.y1 - rect.y0 - 6;
    const words = text.split(" ");
    const big = Math.max(10, Math.min(18, Math.round(scale * 3.4)));
    for (let size = big; size >= 8; size -= 1) {
      bctx.font = `700 ${size}px Inter, system-ui, sans-serif`;
      const lines = [];
      for (const word of words) {
        const last = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
        if (lines.length && bctx.measureText(last).width <= maxW) lines[lines.length - 1] = last;
        else lines.push(word);
      }
      const lineH = size * 1.15;
      const subSize = Math.max(8, Math.round(size * 0.66));
      const subH = sub ? subSize * 1.5 : 0;
      if (lines.length > 3 || lines.length * lineH + subH > maxH) continue;
      if (lines.some((l) => bctx.measureText(l).width > maxW)) continue;
      const cx = (rect.x0 + rect.x1) / 2;
      const top = (rect.y0 + rect.y1) / 2 - ((lines.length - 1) * lineH + subH) / 2;
      bctx.textAlign = "center";
      bctx.textBaseline = "middle";
      bctx.fillStyle = color;
      lines.forEach((l, i) => bctx.fillText(l, cx, top + i * lineH));
      if (sub) {
        bctx.font = `600 ${subSize}px Inter, system-ui, sans-serif`;
        if (bctx.measureText(sub).width <= maxW) {
          bctx.fillStyle = subColor;
          bctx.fillText(sub, cx, top + (lines.length - 1) * lineH + subH * 0.85);
        }
      }
      return;
    }
  }

  function drawStatic() {
    const here = currentRoom();
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, base.width, base.height);
    bctx.setTransform(px, 0, 0, px, 0, 0);

    // faint survey grid behind the plan
    bctx.strokeStyle = "rgba(160,190,215,0.05)";
    bctx.lineWidth = 1;
    for (let c = 0; c <= GRID_W; c++) {
      const x = Math.round(toX(g2w(c) - CELL / 2)) + 0.5;
      bctx.beginPath();
      bctx.moveTo(x, 0);
      bctx.lineTo(x, H);
      bctx.stroke();
    }
    for (let r = 0; r <= GRID_H; r++) {
      const y = Math.round(toY(g2z(r) - CELL / 2)) + 0.5;
      bctx.beginPath();
      bctx.moveTo(0, y);
      bctx.lineTo(W, y);
      bctx.stroke();
    }

    // floors
    for (const room of ROOMS) {
      if (!shown(room)) continue;
      const rc = roomRect(room);
      const accent = hex(room.accent);
      const travel = TRAVEL_ROOMS.includes(room.id);
      const lit = visited.has(room.id);
      let fill;
      if (!travel) fill = "rgba(150,165,180,0.13)";
      else if (!lit) fill = "rgba(120,130,140,0.10)";
      else fill = hexA(accent, room.id === hover ? 0.4 : 0.2);
      bctx.fillStyle = fill;
      bctx.fillRect(rc.x0, rc.y0, rc.x1 - rc.x0, rc.y1 - rc.y0);
      if (travel && !lit) {
        // locked halls: diagonal hatching
        bctx.save();
        bctx.beginPath();
        bctx.rect(rc.x0, rc.y0, rc.x1 - rc.x0, rc.y1 - rc.y0);
        bctx.clip();
        bctx.strokeStyle = "rgba(160,170,180,0.08)";
        bctx.lineWidth = 1;
        for (let d = rc.x0 - (rc.y1 - rc.y0); d < rc.x1; d += 9) {
          bctx.beginPath();
          bctx.moveTo(d, rc.y1);
          bctx.lineTo(d + (rc.y1 - rc.y0), rc.y0);
          bctx.stroke();
        }
        bctx.restore();
      }
      if (travel && lit && (room.id === hover || room.id === here)) {
        bctx.strokeStyle = hexA(accent, room.id === hover ? 0.95 : 0.6);
        bctx.lineWidth = room.id === hover ? 2.5 : 1.5;
        bctx.strokeRect(rc.x0 + 2, rc.y0 + 2, rc.x1 - rc.x0 - 4, rc.y1 - rc.y0 - 4);
      }
    }

    // walls: the building outline plus every wall between two rooms, with
    // the doorways (world OPEN) left as gaps. One path per weight, stroked
    // once, so the translucent segments never double up at the joints.
    const w = CELL * scale;
    const outerPath = new Path2D();
    const innerPath = new Path2D();
    const seg = (path, x0, y0, x1, y1) => {
      path.moveTo(x0, y0);
      path.lineTo(x1, y1);
    };
    for (let r = 0; r < GRID_H; r++) {
      for (let c = 0; c < GRID_W; c++) {
        if (!cellShown(c, r)) continue;
        const x0 = toX(g2w(c) - CELL / 2);
        const y0 = toY(g2z(r) - CELL / 2);
        if (!cellShown(c - 1, r)) seg(outerPath, x0, y0, x0, y0 + w);
        if (!cellShown(c + 1, r)) seg(outerPath, x0 + w, y0, x0 + w, y0 + w);
        if (!cellShown(c, r - 1)) seg(outerPath, x0, y0, x0 + w, y0);
        if (!cellShown(c, r + 1)) seg(outerPath, x0, y0 + w, x0 + w, y0 + w);
        if (cellShown(c + 1, r) && !passable(c, r, c + 1, r)) seg(innerPath, x0 + w, y0, x0 + w, y0 + w);
        if (cellShown(c, r + 1) && !passable(c, r, c, r + 1)) seg(innerPath, x0, y0 + w, x0 + w, y0 + w);
      }
    }
    bctx.lineCap = "round";
    bctx.lineJoin = "round";
    bctx.strokeStyle = "rgba(205,222,238,0.5)";
    bctx.lineWidth = Math.max(1.1, scale * 0.3);
    bctx.stroke(innerPath);
    bctx.strokeStyle = "rgba(215,230,242,0.78)";
    bctx.lineWidth = Math.max(1.6, scale * 0.5);
    bctx.stroke(outerPath);

    // exhibits
    const dot = Math.max(1.6, scale * 0.42);
    for (const p of PLACEMENTS) {
      const room = roomAt(p.x, p.z);
      if (!shown(room)) continue;
      bctx.fillStyle = visited.has(room.id) ? "rgba(255,200,87,0.9)" : "rgba(170,178,186,0.35)";
      bctx.beginPath();
      bctx.arc(toX(p.x), toY(p.z), dot, 0, Math.PI * 2);
      bctx.fill();
    }

    // hall names
    const n = listed();
    for (const room of ROOMS) {
      if (!shown(room) || !TRAVEL_ROOMS.includes(room.id)) continue;
      const lit = visited.has(room.id);
      const accent = hex(room.accent);
      const i = n.indexOf(room.id);
      const sub = room.id === here ? "YOU ARE HERE" : lit ? (i >= 0 && i < 10 ? `PRESS ${hotkeyOf(i)}` : null) : "NOT VISITED";
      label(
        room.name.toUpperCase(),
        sub,
        roomRect(room),
        lit ? hexA(accent, 0.98) : "rgba(175,185,195,0.55)",
        lit ? "rgba(243,236,223,0.6)" : "rgba(175,185,195,0.45)"
      );
    }
  }

  /* ---------------- dynamic layer ---------------- */
  function frame(now) {
    raf = open ? requestAnimationFrame(frame) : 0;
    if (!open) return;
    const nextVisited = visitedSet();
    const here = currentRoom();
    const key = `${[...nextVisited].sort().join(",")}|${hover}|${here}`;
    const resized = fit();
    if (resized || key !== staticKey) {
      visited = nextVisited;
      staticKey = key;
      drawStatic();
      if (key.split("|")[0] !== listKey) renderList();
      else syncList();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(px, 0, 0, px, 0, 0);

    // other visitors (never inside a secret room you have not found)
    let players = [];
    try {
      players = getPlayers?.() || [];
    } catch {
      players = [];
    }
    const r = Math.max(3.5, scale * 0.75);
    ctx.font = `600 ${Math.max(10, Math.min(12, scale * 1.6))}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const p of players) {
      if (!Number.isFinite(p?.x) || !Number.isFinite(p?.z)) continue;
      if (!shown(roomAt(p.x, p.z))) continue;
      const x = toX(p.x);
      const y = toY(p.z);
      ctx.fillStyle = p.color || "#8ecae6";
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
      if (p.name && players.length <= 16) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(6,10,14,0.85)";
        ctx.strokeText(p.name, x, y - r - 3);
        ctx.fillStyle = "rgba(243,236,223,0.92)";
        ctx.fillText(p.name, x, y - r - 3);
      }
    }

    const me = local();
    if (me) {
      const x = toX(me.x);
      const y = toY(me.z);
      const heading = Math.PI - (me.ry || 0); // see minimap.js
      const pulse = ((now || 0) % 1600) / 1600;
      ctx.strokeStyle = `rgba(255,200,87,${0.6 * (1 - pulse)})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, 6 + pulse * 18, 0, Math.PI * 2);
      ctx.stroke();

      const s = Math.max(1, scale * 0.16);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(heading);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 46 * s);
      grad.addColorStop(0, "rgba(255,200,87,0.35)");
      grad.addColorStop(1, "rgba(255,200,87,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 46 * s, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#ffc857";
      ctx.beginPath();
      ctx.moveTo(0, -8 * s);
      ctx.lineTo(6 * s, 6.5 * s);
      ctx.lineTo(0, 3.2 * s);
      ctx.lineTo(-6 * s, 6.5 * s);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.75)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ---------------- side list ---------------- */
  let listKey = "";
  const buttons = new Map();
  function renderList() {
    listKey = [...visited].sort().join(",");
    list.textContent = "";
    buttons.clear();
    const ids = listed();
    ids.forEach((id, i) => {
      const room = ROOM_BY_ID.get(id);
      const li = el("li");
      const btn = el("button", "bmap-hall");
      btn.type = "button";
      btn.dataset.room = id;
      btn.style.setProperty("--hall", hex(room.accent));
      const num = el("span", "bmap-num", i < 10 ? hotkeyOf(i) : "");
      const name = el("span", "bmap-name", room.name);
      const status = el("span", "bmap-status");
      btn.append(num, name, status);
      btn.addEventListener("click", () => travel(id));
      btn.addEventListener("pointerenter", () => setHover(id));
      btn.addEventListener("pointerleave", () => setHover(null));
      btn.addEventListener("focus", () => setHover(id));
      btn.addEventListener("blur", () => setHover(null));
      li.append(btn);
      list.append(li);
      buttons.set(id, { btn, status });
    });
    syncList();
  }

  function syncList() {
    const here = currentRoom();
    const ids = listed();
    const done = ids.filter((id) => visited.has(id)).length;
    progressText.textContent = `${done} of ${ids.length} halls explored`;
    barFill.style.width = `${ids.length ? (done / ids.length) * 100 : 0}%`;
    for (const [id, { btn, status }] of buttons) {
      const ok = canTravel(id);
      btn.disabled = !ok;
      btn.classList.toggle("is-here", id === here);
      btn.classList.toggle("is-hover", id === hover);
      btn.setAttribute(
        "aria-label",
        `${ROOM_BY_ID.get(id).name}: ${id === here ? "you are here" : ok ? "travel here" : "not visited yet"}`
      );
      status.textContent = id === here ? "You are here" : ok ? "Travel" : "Not visited";
    }
  }

  function setHover(id) {
    if (hover === id) return;
    hover = id;
    for (const [rid, { btn }] of buttons) btn.classList.toggle("is-hover", rid === hover);
  }

  /* ---------------- pointer ---------------- */
  function roomUnder(e) {
    const rect = canvas.getBoundingClientRect();
    const wx = fromX(e.clientX - rect.left);
    const wz = fromY(e.clientY - rect.top);
    const room = roomAt(wx, wz);
    return shown(room) && TRAVEL_ROOMS.includes(room.id) ? room : null;
  }

  canvas.addEventListener("pointermove", (e) => {
    const room = roomUnder(e);
    setHover(room ? room.id : null);
    canvas.style.cursor = room && canTravel(room.id) && room.id !== currentRoom() ? "pointer" : "default";
    if (!room) {
      tip.hidden = true;
      return;
    }
    const here = room.id === currentRoom();
    tip.textContent = "";
    tip.append(
      el("b", null, room.name),
      el("span", null, here ? "You are here" : canTravel(room.id) ? "Click to travel" : "Visit on foot first")
    );
    tip.classList.toggle("is-locked", !canTravel(room.id));
    const rect = stage.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(4, Math.min(rect.width - tw - 4, x + 14))}px`;
    tip.style.top = `${Math.max(4, y - 44)}px`;
  });
  canvas.addEventListener("pointerleave", () => {
    setHover(null);
    tip.hidden = true;
  });
  canvas.addEventListener("click", (e) => {
    const room = roomUnder(e);
    if (room && canTravel(room.id)) travel(room.id);
  });
  closeBtn.addEventListener("click", () => close());
  root.addEventListener("pointerdown", (e) => {
    if (e.target === root) close();
  });

  /* ---------------- travel ---------------- */
  function travel(id) {
    if (!canTravel(id)) return false;
    if (id === currentRoom()) {
      close();
      return true;
    }
    const point = hallEntryPoint(id);
    if (!point) return false;
    close();
    try {
      onTravel?.(id, point);
    } catch (err) {
      console.warn("bigmap: onTravel failed", err);
    }
    return true;
  }

  /* ---------------- keyboard ---------------- */
  function onKeyDown(e) {
    if (!open) return;
    if (e.code === "Escape" || (hotkey && e.code === hotkey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) close();
      return;
    }
    const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
    if (m && !e.repeat) {
      e.preventDefault();
      const id = listed()[(Number(m[1]) + 9) % 10];
      if (id) travel(id);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const live = [...buttons.values()].map((b) => b.btn).filter((b) => !b.disabled);
      if (live.length) {
        const i = live.indexOf(document.activeElement);
        const d = e.key === "ArrowDown" ? 1 : -1;
        live[(i + d + live.length) % live.length].focus();
      }
    } else if (e.key === "Tab") {
      const items = [closeBtn, ...[...buttons.values()].map((b) => b.btn).filter((b) => !b.disabled)];
      const inside = card.contains(document.activeElement);
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
    // nothing typed while the map is up reaches the game
    e.stopImmediatePropagation();
  }
  window.addEventListener("keydown", onKeyDown, true);

  /* ---------------- open / close ---------------- */
  function openMap() {
    if (open) return api;
    open = true;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      if (document.pointerLockElement) document.exitPointerLock?.();
    } catch {
      /* ignore */
    }
    visited = visitedSet();
    staticKey = "";
    root.hidden = false;
    renderList();
    tip.hidden = true;
    hover = null;
    raf = requestAnimationFrame(frame);
    // focus the dialog itself: arrows then step through the halls, and no
    // hall looks hovered before the visitor points at one
    requestAnimationFrame(() => card.focus({ preventScroll: true }));
    try {
      onOpen?.();
    } catch (err) {
      console.warn("bigmap: onOpen failed", err);
    }
    window.dispatchEvent(new CustomEvent("bigmap:open"));
    return api;
  }

  function close() {
    if (!open) return;
    open = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    root.hidden = true;
    tip.hidden = true;
    hover = null;
    if (returnFocus && document.contains(returnFocus)) {
      try {
        returnFocus.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    } else if (document.activeElement && root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    returnFocus = null;
    try {
      onClose?.();
    } catch (err) {
      console.warn("bigmap: onClose failed", err);
    }
    window.dispatchEvent(new CustomEvent("bigmap:close"));
  }

  const api = {
    el: root,
    open: openMap,
    close,
    toggle() {
      if (open) close();
      else openMap();
      return open;
    },
    isOpen: () => open,
    /** Remember the room at (x, z) as visited. Returns its id when it is new. */
    track(x, z) {
      const room = roomAt(x, z);
      if (!room || seen.has(room.id)) return null;
      seen.add(room.id);
      return room.id;
    },
    /** Rooms visited so far (track() plus getVisited()). */
    visited: () => visitedSet(),
    canTravel: (id) => {
      visited = visitedSet();
      return canTravel(id);
    },
    travel: (id) => {
      visited = visitedSet();
      return travel(id);
    },
    hallEntryPoint,
    dispose() {
      close();
      window.removeEventListener("keydown", onKeyDown, true);
      root.remove();
    },
  };
  return api;
}
