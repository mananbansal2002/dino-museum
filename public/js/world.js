import * as THREE from "three";
import { SPECIES } from "./species.js";
import { makeCanvas, makePlacard, makeTextTexture, rand } from "./util.js";

export const CELL = 6;
export const GRID_W = 32;
export const GRID_H = 30;

/**
 * World <-> grid conversion. A cell is *centred* on g2w(c) / g2z(r), so the
 * cell covers [g2w(c) - 3, g2w(c) + 3) and the walls sit exactly on the
 * shared cell borders.
 */
export const w2g = (x) => Math.floor(x / CELL + GRID_W / 2);
export const w2gz = (z) => Math.floor(z / CELL + GRID_H / 2);
export const g2w = (c) => (c - (GRID_W - 1) / 2) * CELL;
export const g2z = (r) => (r - (GRID_H - 1) / 2) * CELL;

export const ROOMS = [
  { id: "theater", name: "Screening Theatre", cols: [11, 20], rows: [1, 6], floor: 0x1b2431, wall: 0x24303f, accent: 0x59d4e6, h: 13 },
  { id: "cretaceous", name: "Cretaceous Hall", cols: [1, 9], rows: [1, 7], floor: 0x3d2b23, wall: 0x4a342a, accent: 0xff8a5c, h: 10 },
  { id: "marine", name: "Marine Reptile Hall", cols: [22, 29], rows: [1, 7], floor: 0x1e3040, wall: 0x243848, accent: 0x4fc3f7, h: 10 },
  { id: "ncorridor", name: "North Corridor", cols: [14, 17], rows: [7, 9], floor: 0x2b3038, wall: 0x333a44, accent: 0xffc857, h: 6 },
  { id: "cwcorridor", name: "Cretaceous Link", cols: [10, 10], rows: [3, 4], floor: 0x2b3038, wall: 0x333a44, accent: 0xffc857, h: 6 },
  { id: "necorridor", name: "Marine Link", cols: [21, 21], rows: [3, 4], floor: 0x2b3038, wall: 0x333a44, accent: 0xffc857, h: 6 },
  { id: "predator", name: "Predator Bay", cols: [7, 11], rows: [8, 13], floor: 0x33232c, wall: 0x3d2a34, accent: 0xff5d5d, h: 9 },
  { id: "rotunda", name: "Grand Gallery", cols: [12, 19], rows: [10, 17], floor: 0x413a2c, wall: 0x4a4132, accent: 0xffb703, h: 15 },
  { id: "triassic", name: "Triassic Hall", cols: [2, 6], rows: [12, 21], floor: 0x3f3323, wall: 0x4a3b28, accent: 0xe09a4a, h: 10 },
  { id: "jurassic", name: "Jurassic Hall", cols: [24, 29], rows: [12, 21], floor: 0x26352b, wall: 0x2e4034, accent: 0x7bc47f, h: 10 },
  { id: "wcorridor", name: "West Corridor", cols: [7, 11], rows: [15, 16], floor: 0x2b3038, wall: 0x333a44, accent: 0xffc857, h: 6 },
  { id: "ecorridor", name: "East Corridor", cols: [20, 23], rows: [15, 16], floor: 0x2b3038, wall: 0x333a44, accent: 0xffc857, h: 6 },
  { id: "wc2", name: "Triassic Link", cols: [3, 4], rows: [8, 11], floor: 0x2b3038, wall: 0x333a44, accent: 0xffc857, h: 6 },
  { id: "ec2", name: "Jurassic Link", cols: [25, 26], rows: [8, 11], floor: 0x2b3038, wall: 0x333a44, accent: 0xffc857, h: 6 },
  { id: "scorridor", name: "South Corridor", cols: [14, 17], rows: [18, 19], floor: 0x2b3038, wall: 0x333a44, accent: 0xffc857, h: 6 },
  { id: "lobby", name: "Entrance Atrium", cols: [9, 22], rows: [20, 23], floor: 0x4d4a44, wall: 0x57544d, accent: 0xffd166, h: 11 },
  { id: "porch", name: "Entrance Plaza", cols: [13, 18], rows: [24, 27], floor: 0x5b6067, wall: 0x666b72, accent: 0x8ecae8, h: 9 },
  // An immersive projection room off the south end of the Triassic Hall; the
  // show itself lives in extinction.js. "dark": no hall light or fixture.
  { id: "extinction", name: "Extinction Room", cols: [2, 6], rows: [22, 25], floor: 0x0b0b0c, wall: 0x101012, accent: 0xff8a4c, h: 9, dark: true },
  // The end of the tour: a bent exit passage leaves the far end of the
  // Jurassic Hall, runs down the east side of the building and turns into the
  // Ice Cream Court. Neither is visible from the entrance; both are hidden on
  // the minimap until a visitor walks in ("secret").
  { id: "xpassage", name: "Exit Passage", cols: [30, 30], rows: [18, 22], floor: 0x3a3f45, wall: 0x44494f, accent: 0xff8fab, h: 6, secret: true },
  { id: "court", name: "Ice Cream Court", cols: [27, 30], rows: [23, 27], floor: 0x5c4b3c, wall: 0x6b5947, accent: 0xff8fab, h: 10, secret: true },
];

/** Rooms that hold mounted skeletons (the "halls" of the tour). */
export const EXHIBIT_HALLS = ["cretaceous", "predator", "rotunda", "triassic", "jurassic", "marine"];

/** Open boundaries: "v:c,r" = gap between (c,r)/(c,r+1), "h:c,r" = gap between (c,r)/(c+1,r). */
export const OPEN = new Set([
  "v:14,6", "v:15,6", "v:16,6", "v:17,6", // theatre -> north corridor
  "v:14,9", "v:15,9", "v:16,9", "v:17,9", // north corridor -> grand gallery
  "h:9,3", "h:9,4", // cretaceous -> link
  "h:10,3", "h:10,4", // link -> theatre
  "h:20,3", "h:20,4", // theatre -> marine link
  "h:21,3", "h:21,4", // link -> marine hall
  "v:7,7", "v:8,7", "v:9,7", // cretaceous -> predator bay
  "v:3,7", "v:4,7", // cretaceous -> triassic link
  "v:3,11", "v:4,11", // triassic link -> triassic hall
  "v:25,7", "v:26,7", // marine -> jurassic link
  "v:25,11", "v:26,11", // jurassic link -> jurassic hall
  "h:11,10", "h:11,11", "h:11,12", "h:11,13", // predator bay -> grand gallery
  "h:6,12", "h:6,13", // predator bay -> triassic hall
  "h:6,15", "h:6,16", // triassic hall -> west corridor
  "h:11,15", "h:11,16", // west corridor -> grand gallery
  "h:19,15", "h:19,16", // grand gallery -> east corridor
  "h:23,15", "h:23,16", // east corridor -> jurassic hall
  "v:14,17", "v:15,17", "v:16,17", "v:17,17", // grand gallery -> south corridor
  "v:14,19", "v:15,19", "v:16,19", "v:17,19", // south corridor -> lobby
  "v:14,23", "v:15,23", "v:16,23", "v:17,23", // lobby -> entrance plaza
  "v:4,21", // triassic hall -> extinction room
  "h:29,18", "h:29,19", // jurassic hall (far end) -> exit passage
  "v:30,22", // exit passage bends into the ice cream court
]);

/** Walkable cells of two different rooms with no doorway between them are separated by a wall slab. */
function edgeKey(c, r, nc, nr) {
  if (nc === c + 1) return `h:${c},${r}`;
  if (nc === c - 1) return `h:${nc},${r}`;
  if (nr === r + 1) return `v:${c},${r}`;
  return `v:${c},${nr}`;
}

const roomGrid = new Map();
for (const room of ROOMS) {
  for (let c = room.cols[0]; c <= room.cols[1]; c++) {
    for (let r = room.rows[0]; r <= room.rows[1]; r++) {
      roomGrid.set(`${c},${r}`, room);
    }
  }
}

export function roomAt(x, z) {
  return roomGrid.get(`${w2g(x)},${w2gz(z)}`) || null;
}

/** Room id -> ids of the rooms a doorway in OPEN connects it to. */
const ROOM_LINKS = (() => {
  const links = new Map(ROOMS.map((r) => [r.id, new Set()]));
  for (const key of OPEN) {
    const [kind, rest] = key.split(":");
    const [c, r] = rest.split(",").map(Number);
    const a = roomGrid.get(`${c},${r}`);
    const b = roomGrid.get(kind === "h" ? `${c + 1},${r}` : `${c},${r + 1}`);
    if (!a || !b || a === b) continue;
    links.get(a.id).add(b.id);
    links.get(b.id).add(a.id);
  }
  return links;
})();

/** The rooms you can walk into straight from room `id` (through one doorway). */
export function roomNeighbours(id) {
  return ROOM_LINKS.get(id) || new Set();
}

export function isSolid(c, r) {
  if (c < 0 || r < 0 || c >= GRID_W || r >= GRID_H) return true;
  return !roomGrid.has(`${c},${r}`);
}

/**
 * Can you step from cell (c,r) straight into the neighbouring cell (nc,nr)?
 * Both have to be floor, and two different rooms are only connected through
 * a doorway listed in OPEN — everywhere else a wall slab separates them.
 */
export function passable(c, r, nc, nr) {
  if (isSolid(c, r) || isSolid(nc, nr)) return false;
  const a = roomGrid.get(`${c},${r}`);
  const b = roomGrid.get(`${nc},${nr}`);
  if (a.id === b.id) return true;
  return OPEN.has(edgeKey(c, r, nc, nr));
}

const WALL_HALF = 0.2; // wall slabs are 0.4 thick

function pushOutOfBox(x, z, radius, minX, maxX, minZ, maxZ) {
  const cx = Math.max(minX, Math.min(x, maxX));
  const cz = Math.max(minZ, Math.min(z, maxZ));
  const dx = x - cx;
  const dz = z - cz;
  const dist2 = dx * dx + dz * dz;
  if (dist2 >= radius * radius) return null;
  if (dist2 < 1e-10) {
    // centre is inside the box: leave through the nearest face
    const opts = [
      [minX - radius - x, 0],
      [maxX + radius - x, 0],
      [0, minZ - radius - z],
      [0, maxZ + radius - z],
    ];
    opts.sort((p, q) => Math.abs(p[0] + p[1]) - Math.abs(q[0] + q[1]));
    return [x + opts[0][0], z + opts[0][1]];
  }
  const dist = Math.sqrt(dist2);
  const push = radius - dist;
  return [x + (dx / dist) * push, z + (dz / dist) * push];
}

/**
 * Circle vs museum collision resolve. Solid cells are full blocks; walls
 * between two adjacent rooms without a doorway are thin slabs (exactly the
 * slabs buildWallData draws). Returns corrected [x, z].
 *
 * Pass the previous position (prevX, prevZ) when you have it: a slab is only
 * 0.4 m thick, so a big step on a slow frame could otherwise end on the far
 * side of it. With the previous position the circle is always kept on the
 * side it came from.
 */
export function resolveCollision(x, z, radius, prevX, prevZ) {
  const hasPrev = Number.isFinite(prevX) && Number.isFinite(prevZ);
  const slabX = (wx, minZ, maxZ) => {
    if (hasPrev && z > minZ && z < maxZ && Math.abs(x - wx) < radius + WALL_HALF + Math.abs(x - prevX)) {
      const side = prevX < wx ? -1 : 1;
      if ((x - wx) * side < radius + WALL_HALF) x = wx + side * (radius + WALL_HALF);
      return;
    }
    const p = pushOutOfBox(x, z, radius, wx - WALL_HALF, wx + WALL_HALF, minZ, maxZ);
    if (p) [x, z] = p;
  };
  const slabZ = (wz, minX, maxX) => {
    if (hasPrev && x > minX && x < maxX && Math.abs(z - wz) < radius + WALL_HALF + Math.abs(z - prevZ)) {
      const side = prevZ < wz ? -1 : 1;
      if ((z - wz) * side < radius + WALL_HALF) z = wz + side * (radius + WALL_HALF);
      return;
    }
    const p = pushOutOfBox(x, z, radius, minX, maxX, wz - WALL_HALF, wz + WALL_HALF);
    if (p) [x, z] = p;
  };
  const c0 = w2g(x - radius) - 1;
  const c1 = w2g(x + radius) + 1;
  const r0 = w2gz(z - radius) - 1;
  const r1 = w2gz(z + radius) + 1;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const minX = g2w(c) - CELL / 2;
      const maxX = minX + CELL;
      const minZ = g2z(r) - CELL / 2;
      const maxZ = minZ + CELL;
      if (isSolid(c, r)) {
        const p = pushOutOfBox(x, z, radius, minX, maxX, minZ, maxZ);
        if (p) [x, z] = p;
        continue;
      }
      // internal walls on this cell's east and south borders
      if (!isSolid(c + 1, r) && !passable(c, r, c + 1, r)) slabX(maxX, minZ, maxZ);
      if (!isSolid(c, r + 1) && !passable(c, r, c, r + 1)) slabZ(maxZ, minX, maxX);
    }
  }
  // roped-off plinths and the furniture
  for (const list of [OBSTACLES, PROP_OBSTACLES]) {
    for (const o of list) {
      if (x < o.minX - radius || x > o.maxX + radius || z < o.minZ - radius || z > o.maxZ + radius) continue;
      const p = Number.isFinite(o.r)
        ? pushOutOfCircle(x, z, radius, o.x, o.z, o.r)
        : pushOutOfBox(x, z, radius, o.minX, o.maxX, o.minZ, o.maxZ);
      if (p) [x, z] = p;
    }
  }
  return [x, z];
}

function pushOutOfCircle(x, z, radius, cx, cz, r) {
  const dx = x - cx;
  const dz = z - cz;
  const min = r + radius;
  const d2 = dx * dx + dz * dz;
  if (d2 >= min * min) return null;
  const d = Math.sqrt(d2);
  // dead centre: leave towards +z (any way out is as good as another)
  if (d < 1e-6) return [x, cz + min];
  return [cx + (dx / d) * min, cz + (dz / d) * min];
}

/**
 * Every wall slab of the museum.
 *
 * A boundary between a room and anything else always gets exactly one slab.
 * A boundary shared by two different rooms is drawn once (the room on the
 * west/north side owns it) unless the doorway is listed in OPEN.
 */
export function buildWallData() {
  const walls = [];
  const isOpen = (key, a, b) => OPEN.has(key) && a && b && a.id !== b.id;
  for (const room of ROOMS) {
    for (let c = room.cols[0]; c <= room.cols[1]; c++) {
      for (let r = room.rows[0]; r <= room.rows[1]; r++) {
        const west = roomGrid.get(`${c - 1},${r}`);
        const east = roomGrid.get(`${c + 1},${r}`);
        const north = roomGrid.get(`${c},${r - 1}`);
        const south = roomGrid.get(`${c},${r + 1}`);
        // west / north walls are only drawn when the neighbour is solid:
        // a neighbouring room draws the shared wall itself.
        if (!west) {
          walls.push({ x: g2w(c) - CELL / 2, z: g2z(r), sx: 0.4, sz: CELL, room });
        }
        if (!north) {
          walls.push({ x: g2w(c), z: g2z(r) - CELL / 2, sx: CELL, sz: 0.4, room });
        }
        if (!east || (!isOpen(`h:${c},${r}`, room, east) && east.id !== room.id)) {
          walls.push({ x: g2w(c) + CELL / 2, z: g2z(r), sx: 0.4, sz: CELL, room });
        }
        if (!south || (!isOpen(`v:${c},${r}`, room, south) && south.id !== room.id)) {
          walls.push({ x: g2w(c), z: g2z(r) + CELL / 2, sx: CELL, sz: 0.4, room });
        }
      }
    }
  }
  return walls;
}

/** Doorway signs: 0.85 m tall planes drawn from 110 px tall canvases. */
const SIGN_H = 0.85;
const SIGN_H_PX = 110;

let measureCtx = null;
/** Largest font size (<= size, >= 60% of it) at which makeTextTexture's text fits maxW px. */
function fitFontSize(text, size, maxW) {
  measureCtx = measureCtx || makeCanvas(8, 8).getContext("2d");
  const min = Math.ceil(size * 0.6);
  let fs = size;
  for (; fs > min; fs -= 2) {
    measureCtx.font = `600 ${fs}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    // makeTextTexture adds 1px letter spacing
    if (measureCtx.measureText(text).width + text.length <= maxW) break;
  }
  return fs;
}

/**
 * A 1 x 1 picture with a front face at z = +gap looking along +z and a back
 * face at z = -gap looking along -z, both reading left-to-right (the back is
 * not mirrored). One draw call for both sides of a panel.
 */
function twoSidedPlane(gap) {
  const front = new THREE.PlaneGeometry(1, 1).translate(0, 0, gap);
  const back = new THREE.PlaneGeometry(1, 1).rotateY(Math.PI).translate(0, 0, -gap);
  const geo = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "uv"]) {
    const a = front.getAttribute(name);
    const b = back.getAttribute(name);
    const arr = new Float32Array(a.array.length + b.array.length);
    arr.set(a.array, 0);
    arr.set(b.array, a.array.length);
    geo.setAttribute(name, new THREE.BufferAttribute(arr, a.itemSize));
  }
  const n = front.getAttribute("position").count;
  const index = [...front.getIndex().array, ...[...back.getIndex().array].map((v) => v + n)];
  geo.setIndex(index);
  front.dispose();
  back.dispose();
  return geo;
}

function radialTexture(inner, outer) {
  const c = makeCanvas(128, 128);
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, inner);
  g.addColorStop(0.55, inner.replace(/[\d.]+\)$/, (a) => `${parseFloat(a) * 0.6})`));
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function beamTexture() {
  const c = makeCanvas(4, 128);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.7, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}

/** The theatre screen between screenings: a dim poster with the canvas aspect of the screen (2:1). */
function screenPoster() {
  const c = makeCanvas(1024, 512);
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(512, 230, 40, 512, 256, 620);
  g.addColorStop(0, "#1d2c38");
  g.addColorStop(1, "#080b0f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 512);
  ctx.strokeStyle = "rgba(89,212,230,0.55)";
  ctx.lineWidth = 4;
  ctx.strokeRect(36, 36, 952, 440);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#59d4e6";
  ctx.font = "600 30px Inter, system-ui, sans-serif";
  ctx.fillText("SCREENING THEATRE", 512, 110);
  ctx.fillStyle = "#f6efe2";
  ctx.font = "800 84px Inter, system-ui, sans-serif";
  ctx.fillText("Tonight's screenings", 512, 220);
  ctx.fillStyle = "#ffc857";
  ctx.fillRect(392, 284, 240, 4);
  ctx.fillStyle = "rgba(246,239,226,0.85)";
  ctx.font = "500 38px Inter, system-ui, sans-serif";
  ctx.fillText("Press E at the console to choose a fight", 512, 360);
  return c;
}

/** Every mounted skeleton, where it stands and how it is posed. */
export const PLACEMENTS = [
  // ---- Cretaceous Hall (north-west) — 4 columns x 3 rows ----
  { id: "trex", x: -85, z: -74, ry: 0, scale: 1, pedestal: 7 },
  { id: "trike", x: -71, z: -74, ry: 0, scale: 1, pedestal: 6 },
  { id: "styraco", x: -57, z: -74, ry: 0, scale: 1, pedestal: 5 },
  { id: "edmont", x: -43, z: -74, ry: 0, scale: 1, pedestal: 6 },
  { id: "para", x: -85, z: -60, ry: 0, scale: 1, pedestal: 6 },
  { id: "iguanodon", x: -71, z: -60, ry: 0, scale: 1, pedestal: 5 },
  { id: "pachy", x: -57, z: -60, ry: 0, scale: 1, pedestal: 3 },
  { id: "stygi", x: -43, z: -60, ry: 0, scale: 1, pedestal: 3 },
  { id: "ankylo", x: -85, z: -47, ry: 0, scale: 1, pedestal: 5 },
  { id: "nodo", x: -71, z: -47, ry: 0, scale: 1, pedestal: 4 },
  { id: "wuerho", x: -57, z: -47, ry: 0, scale: 1, pedestal: 4 }, // Early Cretaceous stegosaur
  { id: "centro", x: -43, z: -47, ry: 0, scale: 1, scales: 5, pedestal: 5 },

  // ---- Predator Bay — long bodies point down the bay ----
  { id: "proto", x: -45, z: -37, ry: 0, scale: 1, pedestal: 2.5 },
  { id: "giganoto", x: -50, z: -30, ry: 0, scale: 0.9, pedestal: 5.5 },
  { id: "carchar", x: -38, z: -33, ry: 0, scale: 1, pedestal: 6 },
  { id: "mapu", x: -38, z: -16, ry: 0, scale: 0.85, pedestal: 6 },
  { id: "acro", x: -28, z: -20, ry: 0, scale: 0.8, pedestal: 5 },

  // ---- Triassic Hall (west) ----
  { id: "eoraptor", x: -78, z: -8, ry: 0, scale: 1, pedestal: 2.5 },
  { id: "herrerasaurus", x: -64, z: -8, ry: 0, scale: 1, pedestal: 3 },
  { id: "riojasaurus", x: -78, z: 4, ry: 0, scale: 1, pedestal: 4 },
  { id: "coelo", x: -64, z: 4, ry: 0, scale: 1, pedestal: 2.5 },
  { id: "plateosaurus", x: -78, z: 20, ry: Math.PI / 2, scale: 1, pedestal: 8 },
  { id: "massospondylus", x: -64, z: 20, ry: Math.PI / 2, scale: 1, pedestal: 8 },

  // ---- Jurassic Hall (east) ----
  { id: "stego", x: 53, z: -12, ry: 0, scale: 1, pedestal: 6 },
  { id: "allo", x: 66, z: -11, ry: 0, scale: 1, pedestal: 5 },
  { id: "diplod", x: 78, z: -10, ry: 0, scale: 0.55, pedestal: 7 },
  { id: "brachio", x: 57, z: 8, ry: 0, scale: 0.85, pedestal: 7 },
  { id: "barosaurus", x: 66, z: 5.5, ry: 0, scale: 0.65, pedestal: 6 },
  { id: "torvo", x: 78, z: 6, ry: 0, scale: 1, pedestal: 5 },
  { id: "camarasaurus", x: 66, z: 20, ry: 0, scale: 0.7, pedestal: 5 },
  { id: "apo", x: 76, z: 22, ry: 0, scale: 0.6, pedestal: 6 },
  { id: "kentrosaurus", x: 66, z: 29.5, ry: 0, scale: 1, pedestal: 5 },

  // ---- Marine Reptile Hall (north-east) ----
  { id: "mosa", x: 47, z: -78, ry: Math.PI / 2, scale: 1, pedestal: 8 },
  { id: "liopleurodon", x: 71, z: -78, ry: Math.PI / 2, scale: 1, pedestal: 7 },
  { id: "elasmo", x: 45, z: -60, ry: Math.PI / 2, scale: 1, pedestal: 6 },
  { id: "krono", x: 64, z: -60, ry: Math.PI / 2, scale: 1, pedestal: 6, face: Math.PI }, // not towards the Ichthyosaurus 6 m west
  { id: "plesio", x: 78, z: -58, ry: 0, scale: 1, pedestal: 6 },
  { id: "deino", x: 48, z: -48, ry: -Math.PI / 2, scale: 1, pedestal: 6 },
  { id: "ichthyo", x: 58, z: -54, ry: 0, scale: 1, pedestal: 4 },
  { id: "archelon", x: 68, z: -54, ry: 0, scale: 1, pedestal: 4 },

  // ---- Grand Gallery (centre) ----
  { id: "spino", x: -16, z: -22, ry: 0, scale: 1, pedestal: 8 },
  { id: "baryonyx", x: 12, z: -24, ry: Math.PI / 2, scale: 1, pedestal: 7 },
  { id: "dilo", x: -4, z: -18, ry: 0, scale: 1, pedestal: 4 },
  // a row along x: facing down the row would put each panel's front (and
  // its prompt) right against the back of the next one, so they face south
  { id: "raptor", x: -18, z: -8, ry: 0, scale: 1, pedestal: 2.5, face: 0 },
  { id: "deinonychus", x: -10, z: -8, ry: 0, scale: 1, pedestal: 3, face: 0 },
  { id: "oviraptor", x: -4, z: -8, ry: 0, scale: 1, pedestal: 2.5, face: 0 },
  { id: "ptero", x: 16, z: -10, ry: 0, scale: 1, pedestal: 5 },
  { id: "dimetrodon", x: 8, z: 4, ry: 0, scale: 1, pedestal: 5 },
  { id: "utahraptor", x: -8, z: 4, ry: 0, scale: 1, pedestal: 3.5 },
  { id: "doed", x: 18, z: 5, ry: 0, scale: 1, pedestal: 5 }, // Ice Age glyptodont: not a Cretaceous animal

  // ---- Entrance Atrium ----
  { id: "quetzal", x: 14, z: 34, ry: Math.PI / 2, scale: 0.7, pedestal: 0 },
  { id: "archaeopteryx", x: -30, z: 46, ry: 0, scale: 1.5, pedestal: 2, face: 0 }, // side by side: both face the entrance
  { id: "rhampho", x: -24, z: 46, ry: 0, scale: 1.5, pedestal: 2, face: 0 },
];

/**
 * Every point of interest. Kept outside of buildWorld so the data can be
 * validated by scripts/check.mjs without needing a WebGL context.
 */
export const SPAWN = { x: 0, z: g2z(21.5), ry: Math.PI };

/**
 * Ice Cream Court furniture: the court is x 66..90, z 48..78 and visitors
 * enter at its north-east corner. The stall stands against the south wall
 * facing north (stallX/stallZ = where the vendor works, main.js stands them
 * just behind it); the exit door is in the west wall.
 */
export const COURT = { stallX: 78, stallZ: 75, exitX: 66.2, exitZ: 70 };

/**
 * Wayfinding, museum style: signs hung from the ceiling, fixed high on a wall
 * or backlit over a doorway. The ice cream court stays a secret, so the only
 * one is an illuminated EXIT lightbox over the Jurassic Hall's exit doorway. All of them are well above head height
 * and none has a collider, so they never block a path (scripts/check.mjs).
 *
 *   kind: "hang" (two cables up to the ceiling), "wall" (flat on a wall or
 *         lintel, face at x/z), "lightbox" (backlit box over a doorway)
 *   x, y, z: centre of the sign face; ry: the face looks along (sin ry, cos ry)
 *   w, h: face size in metres
 *   to: [x, z] the next waypoint, which sets the arrow (see wayArrow)
 *   dest: where the signs lead ("court")
 */
const EXIT_DOOR = [g2w(29) + CELL / 2, (g2z(18) + g2z(19)) / 2]; // Jurassic Hall -> Exit Passage
export const WAYFINDING = [
  // the ice cream court is a surprise at the end of the tour: the way out is
  // marked only as an exit
  { id: "way-exit-lightbox", room: "jurassic", kind: "lightbox", x: EXIT_DOOR[0] - 0.46, y: 7.0, z: EXIT_DOOR[1], ry: -Math.PI / 2, w: 6.6, h: 1.4, to: [EXIT_DOOR[0] + 3, EXIT_DOOR[1]], title: "EXIT", sub: "WAY OUT", dest: "court" },
];

/**
 * The arrow on a wayfinding sign, as seen by someone reading it: radians
 * clockwise from "straight ahead" (0 = ↑, π/2 = →, -π/2 = ←), in 45° steps.
 */
export function wayArrow(sign) {
  // the reader looks against the face normal (sin ry, cos ry)
  const fx = -Math.sin(sign.ry);
  const fz = -Math.cos(sign.ry);
  const dx = sign.to[0] - sign.x;
  const dz = sign.to[1] - sign.z;
  const ahead = dx * fx + dz * fz;
  const right = dx * -fz + dz * fx;
  const step = Math.PI / 4;
  return Math.round(Math.atan2(right, ahead) / step) * step;
}

/** The cinema screen hangs on the north wall of the theatre. */
export const SCREEN = { x: 0, y: 6.4, z: g2z(1) - CELL / 2 + 0.9, w: 22, h: 11 };

/** Height of a theatre seat cushion / a bench plank (where you sit). */
const THEATRE_SEAT_Y = 0.5;
const BENCH_SEAT_Y = 0.58;

/**
 * Theatre seating: 7 rows, two blocks of 12 seats with a centre aisle and
 * wide side aisles. Seats are not collision obstacles; the 1.8 m gap between
 * rows keeps every seat walkable. Every seat turns to face the screen centre.
 */
export const THEATRE_SEATS = (() => {
  const seats = [];
  for (let row = 0; row < 7; row++) {
    const z = -73 + row * 2.8;
    let n = 0;
    for (const side of [-1, 1]) {
      for (let i = 0; i < 12; i++) {
        const x = side * (2.2 + i * 1.3);
        const ry = Math.atan2(SCREEN.x - x, SCREEN.z - z);
        seats.push({ id: `seat:theatre:${row + 1}-${++n}`, x, z, ry, row });
      }
    }
  }
  return seats;
})();

/** Benches in front of the big centrepieces: { x, z, ry } faces the exhibit. */
export const BENCHES = [
  // off to the east side: the middle of the gallery is the sightline from the
  // South Corridor to the T. rex
  { id: "rotunda", x: 13, z: 11, ry: Math.PI, looks: "the Grand Gallery" },
  { id: "cretaceous", x: -78, z: -63, ry: Math.PI, looks: "the Cretaceous Hall" },
  { id: "marine", x: 49, z: -68.8, ry: Math.PI, looks: "the Mosasaurus" },
  { id: "jurassic", x: 71.5, z: 13.6, ry: -Math.PI / 2, looks: "the long-necks" },
  // one long, low bench in the middle of the Extinction Room (drawn by
  // extinction.js, which lights it with the projection)
  { id: "extinction-1", x: -70.65, z: 55, ry: 0, looks: "the show", custom: true },
  { id: "extinction-2", x: -67.35, z: 55, ry: 0, looks: "the show", custom: true },
];

/* ------------------------------------------------------------------ */
/* exhibit panels                                                       */
/* ------------------------------------------------------------------ */

/** Depth of a panel's plinth (front to back). */
export const PANEL_DEPTH = 0.9;

/**
 * Image panel width: bigger animals get bigger pictures (1.8 m .. 4.5 m).
 * Lengths are free text ("8.5–9.7 m", "~9.5 m", "up to 7 m wingspan"): the
 * first number in the string is the length, 4 m when there is none.
 */
export function panelWidth(spec) {
  const m = /(\d+(?:\.\d+)?)/.exec(String(spec?.info?.length ?? ""));
  const len = m ? parseFloat(m[1]) : 4;
  return Math.max(1.8, Math.min(4.5, 1.5 + len * 0.15));
}

/**
 * Every placement becomes a framed, lit, double-sided image panel on a
 * plinth. `face` is the direction its front looks (towards the middle of
 * the hall, snapped to the walls); the plinth is a collision box.
 */
export const EXHIBIT_PANELS = PLACEMENTS.map((p) => {
  const room = roomGrid.get(`${w2g(p.x)},${w2gz(p.z)}`);
  let face = 0;
  if (room) {
    const dx = (g2w(room.cols[0]) + g2w(room.cols[1])) / 2 - p.x;
    const dz = (g2z(room.rows[0]) + g2z(room.rows[1])) / 2 - p.z;
    if (Math.abs(dz) >= Math.abs(dx)) face = dz >= 0 ? 0 : Math.PI;
    else face = dx > 0 ? Math.PI / 2 : -Math.PI / 2;
  }
  if (Number.isFinite(p.face)) face = p.face;
  const w = panelWidth(SPECIES[p.id]);
  const alongX = Math.abs(Math.sin(face)) < 0.5; // panel spans x when facing ±z
  const hx = (alongX ? w + 0.3 : PANEL_DEPTH) / 2;
  const hz = (alongX ? PANEL_DEPTH : w + 0.3) / 2;
  return {
    id: p.id,
    x: p.x,
    z: p.z,
    face,
    w,
    room: room ? room.id : null,
    minX: p.x - hx,
    maxX: p.x + hx,
    minZ: p.z - hz,
    maxZ: p.z + hz,
  };
});

/** Axis-aligned collision boxes standing on the floor (exhibit plinths). */
export const OBSTACLES = EXHIBIT_PANELS.map((p) => ({
  id: `panel:${p.id}`,
  minX: p.minX,
  maxX: p.maxX,
  minZ: p.minZ,
  maxZ: p.maxZ,
}));

/* ------------------------------------------------------------------ */
/* furniture                                                            */
/* ------------------------------------------------------------------ */

/**
 * Where the solid furniture stands. buildWorld draws it from these numbers
 * and PROP_OBSTACLES turns the same numbers into colliders, so the two can
 * never drift apart. Boxes are w (x) by d (z); round things have a radius r.
 */
export const PROPS = {
  desk: { x: -16, z: 52, w: 8, d: 2.2 }, // atrium information desk
  puzzle: { x: -78, z: 34, w: 5.5, d: 3.2 }, // bone assembly table
  console: { x: 0, z: -51.6, w: 2.2, d: 1 }, // battle projection console
  counter: { x: COURT.stallX, z: COURT.stallZ - 0.4, w: 6, d: 1.4 }, // ice cream counter (with its top); the vendor stands behind it
  volcano: { x: 54, z: 36, r: 4.6 }, // cone base
  pillar: { x: -16, z: 8, r: 1.45 }, // timeline pillar (bottom radius)
  statue: { x: 72, z: 55, r: 1.2 }, // ice cream cone statue
};

/** Free-standing atrium benches: { x, z, ry }, not sittable. */
export const ATRIUM_BENCHES = [
  { x: -6, z: 38, ry: 0 },
  { x: 6, z: 38, ry: Math.PI },
  { x: -26, z: 50, ry: Math.PI / 2 },
];

/** Potted plants: [x, z]. */
export const PLANTERS = [
  [-30, 44], [30, 44], [-36, 50], [36, 50], // atrium
  [68, 50], [88, 76], [68, 76], // ice cream court
];

/** Café tables in the ice cream court: [x, z]. */
export const CAFE_TABLES = [
  [81, 57],
  [86, 65],
  [72, 64],
  [80, 63],
];

const BENCH_LEN = 3.2;
const BENCH_DEPTH = 0.9;

/**
 * A bench's collision box. Its back is at local -z and a visitor sits facing
 * local +z. On a sittable bench the front of the seat stays free, so a
 * visitor can step right up to the seat spot (seat radius 0.9) to sit down;
 * the backrest and the rest of the seat still block. Benches only ever turn
 * in 90° steps, so the box stays axis-aligned.
 */
function benchBox(b, sittable) {
  const back = -BENCH_DEPTH / 2 - 0.01;
  const front = sittable ? -0.05 : BENCH_DEPTH / 2;
  const s = Math.round(Math.sin(b.ry));
  const c = Math.round(Math.cos(b.ry));
  // local (lx, lz) -> world (x + lx*c + lz*s, z - lx*s + lz*c)
  const xs = [];
  const zs = [];
  for (const lx of [-BENCH_LEN / 2, BENCH_LEN / 2]) {
    for (const lz of [back, front]) {
      xs.push(b.x + lx * c + lz * s);
      zs.push(b.z - lx * s + lz * c);
    }
  }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

function circleObstacle(id, x, z, r) {
  return { id, x, z, r, minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r };
}

function boxObstacle(id, { x, z, w, d }) {
  return { id, minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 };
}

/**
 * Colliders of the furniture: desks, tables, the counter, the volcano, the
 * timeline pillar, benches, planters... Kept apart from OBSTACLES (which
 * other modules treat as exhibit plinths) but resolveCollision checks both.
 * An entry with r is a circle around (x, z); minX..maxZ is then its bounding
 * box. Theatre seats are left out on purpose: the rows stay walkable.
 */
export const PROP_OBSTACLES = [
  // the desk's back is 0.9 m off the atrium's south wall, too narrow for a
  // visitor: the collider runs on to the wall so nobody gets wedged in there
  { ...boxObstacle("prop:desk", PROPS.desk), maxZ: g2z(roomAt(PROPS.desk.x, PROPS.desk.z).rows[1]) + CELL / 2 - WALL_HALF },
  boxObstacle("prop:puzzle", PROPS.puzzle),
  boxObstacle("prop:console", PROPS.console),
  boxObstacle("prop:counter", PROPS.counter),
  // the cone narrows quickly: collide with its girth at knee height
  circleObstacle("prop:volcano", PROPS.volcano.x, PROPS.volcano.z, PROPS.volcano.r * (1 - 0.5 / 5.8)),
  circleObstacle("prop:pillar", PROPS.pillar.x, PROPS.pillar.z, PROPS.pillar.r),
  circleObstacle("prop:statue", PROPS.statue.x, PROPS.statue.z, PROPS.statue.r),
  ...CAFE_TABLES.map(([x, z], i) => circleObstacle(`prop:table-${i + 1}`, x, z, 1.3)),
  ...PLANTERS.map(([x, z], i) => circleObstacle(`prop:planter-${i + 1}`, x, z, 0.7)),
  ...ATRIUM_BENCHES.map((b, i) => ({ id: `prop:bench-atrium-${i + 1}`, ...benchBox(b, false) })),
  ...BENCHES.map((b) => ({ id: `prop:bench-${b.id}`, ...benchBox(b, true) })),
];

/**
 * Free floor in front of (or behind) each panel where main.js may stand a 3D
 * fossil scan: up to maxLength (parallel to the panel) x maxDepth x maxHeight.
 * The picture is mounted above maxHeight so it stays readable.
 */
export const DISPLAY_MAX_H = 1.35;
export const DISPLAY_PANEL_BOTTOM = 2.0;
const DISPLAY_DEPTH = 1.6;
const DISPLAY_GAP = 0.35;

function boxesOverlap(a, b, margin = 0) {
  return a.minX < b.maxX + margin && a.maxX > b.minX - margin && a.minZ < b.maxZ + margin && a.maxZ > b.minZ - margin;
}

export const DISPLAYS = (() => {
  const out = [];
  for (const p of EXHIBIT_PANELS) {
    const room = ROOMS.find((r) => r.id === p.room);
    if (!room) continue;
    const maxLength = Math.max(1.6, Math.min(4, p.w));
    const bounds = {
      minX: g2w(room.cols[0]) - CELL / 2 + 1.2,
      maxX: g2w(room.cols[1]) + CELL / 2 - 1.2,
      minZ: g2z(room.rows[0]) - CELL / 2 + 1.2,
      maxZ: g2z(room.rows[1]) + CELL / 2 - 1.2,
    };
    for (const ry of [p.face, p.face + Math.PI]) {
      const fx = Math.round(Math.sin(ry));
      const fz = Math.round(Math.cos(ry));
      const dist = PANEL_DEPTH / 2 + DISPLAY_GAP + DISPLAY_DEPTH / 2;
      const x = p.x + fx * dist;
      const z = p.z + fz * dist;
      const hx = (fx ? DISPLAY_DEPTH : maxLength) / 2;
      const hz = (fx ? maxLength : DISPLAY_DEPTH) / 2;
      const box = { minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz };
      const inside =
        box.minX >= bounds.minX && box.maxX <= bounds.maxX && box.minZ >= bounds.minZ && box.maxZ <= bounds.maxZ;
      if (!inside) continue;
      if (EXHIBIT_PANELS.some((o) => o !== p && boxesOverlap(box, o, 1.0))) continue;
      if (out.some((d) => boxesOverlap(box, d.bounds, 1.0))) continue;
      out.push({
        speciesId: p.id,
        x,
        z,
        ry: ry > Math.PI ? ry - Math.PI * 2 : ry,
        floorY: 0,
        maxLength,
        maxDepth: DISPLAY_DEPTH,
        maxHeight: DISPLAY_MAX_H,
        bounds: box,
      });
      break;
    }
  }
  return out;
})();

/* ------------------------------------------------------------------ */
/* era windows                                                          */
/* ------------------------------------------------------------------ */

/** Eras you can look into (main.js shows /images/eras/<eraId>/{px,nx,py,ny,pz,nz}.jpg). */
export const ERAS = {
  triassic: { name: "Triassic", hall: "triassic" },
  jurassic: { name: "Jurassic", hall: "jurassic" },
  cretaceous: { name: "Cretaceous", hall: "cretaceous" },
  marine: { name: "Mesozoic Seas", hall: "marine" },
};

/** A glowing window on a wall of each era hall; ry = the way it faces. */
export const ERA_WINDOWS = [
  { era: "triassic", x: g2w(2) - CELL / 2 + 0.25, z: 12, ry: Math.PI / 2 },
  { era: "jurassic", x: 76, z: g2z(21) + CELL / 2 - 0.25, ry: Math.PI },
  { era: "cretaceous", x: -64, z: g2z(1) - CELL / 2 + 0.25, ry: 0 },
  { era: "marine", x: g2w(29) + CELL / 2 - 0.25, z: -70, ry: -Math.PI / 2 },
];
const ERA_WINDOW_W = 7;
const ERA_WINDOW_H = 4.4;


function insideObstacle(x, z, margin = 0) {
  const hit = (o) => x > o.minX - margin && x < o.maxX + margin && z > o.minZ - margin && z < o.maxZ + margin;
  return OBSTACLES.some(hit) || PROP_OBSTACLES.some(hit) || DISPLAYS.some((d) => hit(d.bounds));
}

/**
 * Where an exhibit's information placard stands: the first of a few spots
 * around the panel that is on walkable floor and clear of plinths, displays
 * and furniture. `ry` is the panel's facing. Candidates sit beside the panel
 * on its front (else its back) and are turned relative to the panel, toed in
 * by 0.6 rad so a visitor standing in front of the panel reads the placard
 * face on. Returns { px, pz, rot, back } with rot the placard's world
 * rotation.y (a PlaneGeometry faces +z, so its normal is (sin rot, cos rot))
 * and back = true when it stands behind the panel.
 */
export function placardSpot(spot) {
  const ry = spot.ry || 0;
  const fx = Math.sin(ry);
  const fz = Math.cos(ry);
  const rx = Math.cos(ry);
  const rz = -Math.sin(ry);
  const reach = (spot.pedestal || 0) / 2 + 1.7;
  // turning by +a swings the placard's normal towards the panel's right
  const candidates = [
    [fx * 2.6 + rx * reach, fz * 2.6 + rz * reach, ry - 0.6, false],
    [fx * 2.6 - rx * reach, fz * 2.6 - rz * reach, ry + 0.6, false],
    [fx * (reach + 1.4), fz * (reach + 1.4), ry, false],
    [-fx * 2.6 + rx * reach, -fz * 2.6 + rz * reach, ry + Math.PI + 0.6, true],
    [-fx * 2.6 - rx * reach, -fz * 2.6 - rz * reach, ry + Math.PI - 0.6, true],
  ];
  for (const [ox, oz, rot, back] of candidates) {
    const px = spot.x + ox;
    const pz = spot.z + oz;
    const clear =
      roomAt(px, pz) && roomAt(px + 1, pz) && roomAt(px - 1, pz) &&
      roomAt(px, pz + 1) && roomAt(px, pz - 1) && !insideObstacle(px, pz, 0.8);
    if (clear) return { px, pz, rot, back };
  }
  return { px: spot.x, pz: spot.z, rot: ry, back: false };
}

function benchSeats(b) {
  return [-0.8, 0.8].map((o, i) => ({
    id: `seat:bench:${b.id}-${i + 1}`,
    x: b.x + o * Math.cos(b.ry),
    z: b.z - o * Math.sin(b.ry),
    ry: b.ry,
  }));
}

/**
 * How far in front of its panel an exhibit's interaction point is, and its
 * reach: 5 m, cut down to 3/4 of the way to the next exhibit's point (never
 * under 3 m) so two neighbouring prompts barely overlap.
 */
const EXHIBIT_POINT_AHEAD = 3;
const EXHIBIT_POINT_RADIUS = 5;
const EXHIBIT_POINT_MIN_RADIUS = 3;

export function buildInteractables() {
  const list = [];
  for (const s of THEATRE_SEATS) {
    list.push({
      id: s.id,
      type: "seat",
      area: "theatre",
      x: s.x,
      z: s.z,
      radius: 0.9,
      label: "Sit and watch",
      key: "E",
      seat: { x: s.x, y: THEATRE_SEAT_Y, z: s.z, ry: s.ry },
    });
  }
  for (const b of BENCHES) {
    for (const s of benchSeats(b)) {
      list.push({
        id: s.id,
        type: "seat",
        area: b.custom ? "projection" : "bench", // custom benches bring their own model
        x: s.x,
        z: s.z,
        radius: 0.9,
        label: `Sit and admire ${b.looks}`,
        key: "E",
        seat: { x: s.x, y: BENCH_SEAT_Y, z: s.z, ry: s.ry },
      });
    }
  }
  // The point sits on the floor in front of the picture, not on the plinth:
  // whoever stands in front of a panel is always nearest to that panel's
  // point, even when the next panel is only 6 m away or right behind them.
  const points = EXHIBIT_PANELS.filter((p) => SPECIES[p.id]).map((p) => ({
    p,
    x: p.x + Math.sin(p.face) * EXHIBIT_POINT_AHEAD,
    z: p.z + Math.cos(p.face) * EXHIBIT_POINT_AHEAD,
  }));
  for (const { p, x, z } of points) {
    const spec = SPECIES[p.id];
    let gap = Infinity;
    for (const o of points) if (o.p !== p) gap = Math.min(gap, Math.hypot(o.x - x, o.z - z));
    list.push({
      id: `exhibit:${spec.id}`,
      type: "exhibit",
      x,
      z,
      radius: Math.max(EXHIBIT_POINT_MIN_RADIUS, Math.min(EXHIBIT_POINT_RADIUS, gap * 0.75)),
      label: `Examine ${spec.name}`,
      key: "E",
      exhibitId: spec.id,
    });
  }
  for (const w of ERA_WINDOWS) {
    const era = ERAS[w.era];
    list.push({
      id: `era:${w.era}`,
      type: "era",
      era: w.era,
      x: w.x + Math.sin(w.ry) * 2.6,
      z: w.z + Math.cos(w.ry) * 2.6,
      radius: 3.6,
      label: `Look through the window to the ${era.name}`,
      key: "E",
    });
  }
  list.push(
    {
      id: "theatre:screen",
      type: "battle",
      // projection console just inside the theatre entrance
      x: 0,
      z: -51,
      radius: 4.5,
      label: "Start a battle screening",
      key: "E",
    },
    {
      id: "guide",
      type: "guide",
      x: -16,
      z: 50,
      radius: 6,
      label: "Ask the museum guide",
      key: "E",
    },
    {
      id: "photo",
      type: "photo",
      x: 16,
      z: 49,
      radius: 6,
      label: "Take a group photo",
      key: "G",
    },
    {
      id: "digpit",
      type: "dig",
      x: -66,
      z: 34,
      radius: 7,
      label: "Dig for fossils",
      key: "E",
    },
    {
      id: "puzzle",
      type: "puzzle",
      x: -78,
      z: 34,
      radius: 7,
      label: "Assemble the skeleton",
      key: "E",
    },
    {
      id: "icestall",
      type: "icecream",
      x: COURT.stallX,
      z: COURT.stallZ - 3.2,
      radius: 6,
      label: "Order an ice cream",
      key: "E",
    },
    {
      id: "exit",
      type: "exit",
      x: COURT.exitX + 2.5,
      z: COURT.exitZ,
      radius: 4.5,
      label: "Leave the museum",
      key: "E",
    },
    {
      id: "timeline",
      type: "timeline",
      x: -16,
      z: 8,
      radius: 6,
      label: "Read the timeline",
      key: "E",
    }
  );
  return list;
}

export const HALL_LABEL = {
  cretaceous: "Cretaceous Hall",
  predator: "Predator Bay",
  triassic: "Triassic Hall",
  jurassic: "Jurassic Hall",
  marine: "Marine Reptile Hall",
  rotunda: "Grand Gallery",
  theater: "Screening Theatre",
  lobby: "Entrance Atrium",
  court: "Ice Cream Court",
  xpassage: "Exit Passage",
  porch: "Entrance Plaza",
  extinction: "Extinction Room",
};

/**
 * Material tag for the lookdev pass: userData.surface is one of floor,
 * ceiling, wall, trim, plinth, wood, metal, glass, fabric, emissive, image,
 * skip. A tag on a group covers its children unless they have their own.
 */
function tag(obj, surface, extra = {}) {
  obj.userData.surface = surface;
  Object.assign(obj.userData, extra);
  return obj;
}

/* ------------------------------------------------------------------ */
/* exhibit photo streaming                                              */
/* ------------------------------------------------------------------ */
const PHOTO_NEAR = 26; // always load a photo this close (m)
const PHOTO_HOP = 80; // photos in a hall seen down a corridor load within this
const PHOTO_FAR = 90; // photos outside the wanted halls unload beyond this
const PHOTO_PARALLEL = 3; // downloads in flight
const PHOTO_TICK = 0.4; // seconds between wanted-set updates

/**
 * Keeps only the photos around the visitor in video memory: the hall they
 * are in, the halls one doorway away, and halls behind a corridor if they
 * are close. Far ones go back to the name card and their texture is freed.
 * Decoding happens off the main thread (createImageBitmap) and at most one
 * new photo is handed to the GPU per frame, so walking never hitches.
 *
 *   photos.update(dt, x, z)   // every frame, with the visitor (or camera) position
 *   photos.stats()            // { loaded, loading, failed, wanted }
 */
function createPhotoStreamer(captions, fallbackLoader) {
  const hasBitmap = typeof createImageBitmap === "function" && typeof THREE.ImageBitmapLoader === "function";
  const bitmapLoader = hasBitmap
    ? new THREE.ImageBitmapLoader().setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" })
    : null;
  const panelRooms = new Set(captions.map((c) => c.panel.room).filter(Boolean));
  const ready = []; // [{ caption, tex, aspect }] waiting for their GPU upload
  let inFlight = 0;
  let timer = 0;
  let wantedCount = 0;
  let lastRoom = undefined;
  const direct = new Set();
  const hop = new Set();

  function roomsAround(id) {
    direct.clear();
    hop.clear();
    if (!id) return;
    direct.add(id);
    for (const n of roomNeighbours(id)) {
      direct.add(n);
      // corridors and links hold no photos: look through them to the next hall
      if (!panelRooms.has(n)) for (const m of roomNeighbours(n)) hop.add(m);
    }
  }

  function finish(caption, tex) {
    inFlight--;
    if (caption.state !== "loading") {
      // no longer wanted while it was downloading
      tex.dispose();
      tex.image?.close?.();
      return;
    }
    const img = tex.image;
    const aspect = img && img.width && img.height ? img.width / img.height : 3 / 2;
    ready.push({ caption, tex, aspect });
  }

  function load(caption) {
    caption.state = "loading";
    inFlight++;
    const fail = () => {
      inFlight--;
      // keep the name card; never retried
      if (caption.state === "loading") caption.state = "failed";
    };
    if (bitmapLoader) {
      bitmapLoader.load(
        caption.url,
        (bitmap) => {
          const tex = new THREE.Texture(bitmap);
          tex.flipY = false; // flipped while decoding
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          tex.needsUpdate = true;
          finish(caption, tex);
        },
        undefined,
        fail
      );
    } else {
      fallbackLoader.load(
        caption.url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          finish(caption, tex);
        },
        undefined,
        fail
      );
    }
  }

  function update(dt, x, z) {
    // one GPU upload per frame
    const next = ready.shift();
    if (next) {
      if (next.caption.state === "loading") {
        next.caption.show(next.tex, next.aspect);
        next.caption.state = "ready";
      } else {
        next.tex.dispose();
        next.tex.image?.close?.();
      }
    }
    timer -= dt;
    if (timer > 0 || !Number.isFinite(x) || !Number.isFinite(z)) return;
    timer = PHOTO_TICK;
    const room = roomAt(x, z);
    const id = room ? room.id : null;
    if (id !== lastRoom) {
      lastRoom = id;
      roomsAround(id);
    }
    // nearest first, so the photo in front of you is the first to arrive
    let wanted = 0;
    let best = null;
    let bestD = Infinity;
    for (const c of captions) {
      const d = Math.hypot(c.panel.x - x, c.panel.z - z);
      const want = d < PHOTO_NEAR || direct.has(c.panel.room) || (hop.has(c.panel.room) && d < PHOTO_HOP);
      if (want) wanted++;
      if (!want) {
        if (d > PHOTO_FAR && (c.state === "ready" || c.state === "loading")) {
          if (c.state === "ready") c.unload();
          else c.state = "none"; // finish() drops it on arrival
        }
        continue;
      }
      if (c.state === "none" && c.url && d < bestD) {
        bestD = d;
        best = c;
      }
    }
    wantedCount = wanted;
    // start the nearest wanted photos (a few at a time)
    while (best && inFlight < PHOTO_PARALLEL) {
      load(best);
      best = null;
      bestD = Infinity;
      for (const c of captions) {
        if (c.state !== "none" || !c.url) continue;
        const d = Math.hypot(c.panel.x - x, c.panel.z - z);
        const want = d < PHOTO_NEAR || direct.has(c.panel.room) || (hop.has(c.panel.room) && d < PHOTO_HOP);
        if (want && d < bestD) {
          bestD = d;
          best = c;
        }
      }
    }
  }

  return {
    update,
    stats() {
      let loaded = 0;
      let loading = 0;
      let failed = 0;
      for (const c of captions) {
        if (c.state === "ready") loaded++;
        else if (c.state === "loading") loading++;
        else if (c.state === "failed") failed++;
      }
      return { loaded, loading, failed, wanted: wantedCount, total: captions.length };
    },
    /** Per-panel state (tests / debugging). */
    list: () => captions.map((c) => ({ id: c.spec.id, room: c.panel.room, state: c.state, url: c.url })),
    /** Load every photo now (screenshots / tests). */
    loadAll() {
      for (const c of captions) if (c.state === "none" && c.url) load(c);
    },
  };
}

/* ------------------------------------------------------------------ */
/* presence lighting                                                    */
/* ------------------------------------------------------------------ */
// Like a real gallery's occupancy-sensed track lights: an exhibit rests at a
// calm level and comes up to full when the visitor walks up to it. Nothing
// here is a real light: the exhibit "spotlight" is an additive floor pool
// and beam (instance colours scale them) plus the backlit picture.
const PRESENCE_REST = 0.66; // pool / beam brightness at rest (1 = the old look)
const PRESENCE_FULL = 1.38; // ... with a visitor at the exhibit
const PRESENCE_PIC_REST = 0.86; // picture brightness at rest, x its own colour
const PRESENCE_PIC_FULL = 1.08;
const PRESENCE_NEAR = 4; // m from the plinth or its display case
const PRESENCE_RISE = 0.8; // s to come up
const PRESENCE_HOLD = 3; // s it stays up after the visitor leaves
const PRESENCE_FALL = 1.6; // s to settle back

function boxDistance(b, x, z) {
  const dx = Math.max(b.minX - x, 0, x - b.maxX);
  const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
  return Math.hypot(dx, dz);
}

/**
 *   presence.update(dt, x, z)   // every frame, with the local visitor's position
 *   presence.stats()            // { active, lit } (tests / debugging)
 * Only exhibits in the visitor's room are tested; ones still fading are kept
 * in a short active list. No allocations per frame.
 */
function createPresenceLighting(items, pools, beams) {
  const byRoom = new Map();
  for (const it of items) {
    if (!it.room) continue;
    if (!byRoom.has(it.room)) byRoom.set(it.room, []);
    byRoom.get(it.room).push(it);
  }
  const active = [];
  const c = new THREE.Color();
  const ease = (t) => t * t * (3 - 2 * t);
  function apply(it) {
    const e = ease(it.level);
    c.setScalar(PRESENCE_REST + (PRESENCE_FULL - PRESENCE_REST) * e);
    pools.setColorAt(it.i, c);
    beams.setColorAt(it.i, c);
    if (it.base < 0) it.base = it.mat.color.r;
    it.mat.color.setScalar(Math.min(1, it.base * (PRESENCE_PIC_REST + (PRESENCE_PIC_FULL - PRESENCE_PIC_REST) * e)));
  }
  // pictures start at the resting level too (after lookdev has set their colour)
  let primed = false;
  function prime() {
    primed = true;
    for (const it of items) apply(it);
    if (pools.instanceColor) pools.instanceColor.needsUpdate = true;
    if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
  }
  function update(dt, x, z) {
    if (!primed) prime();
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const step = Math.min(dt, 0.1);
    const room = roomAt(x, z);
    const list = room ? byRoom.get(room.id) : null;
    if (list) {
      for (let n = 0; n < list.length; n++) {
        const it = list[n];
        const d = Math.min(boxDistance(it.box, x, z), it.box2 ? boxDistance(it.box2, x, z) : Infinity);
        if (d > PRESENCE_NEAR) continue;
        it.hold = PRESENCE_HOLD;
        if (!it.active) {
          it.active = true;
          active.push(it);
        }
      }
    }
    if (!active.length) return;
    for (let n = active.length - 1; n >= 0; n--) {
      const it = active[n];
      if (it.hold > 0) {
        it.hold -= step;
        it.level = Math.min(1, it.level + step / PRESENCE_RISE);
      } else {
        it.level = Math.max(0, it.level - step / PRESENCE_FALL);
      }
      apply(it);
      if (it.level <= 0 && it.hold <= 0) {
        it.active = false;
        active[n] = active[active.length - 1];
        active.pop();
      }
    }
    if (pools.instanceColor) pools.instanceColor.needsUpdate = true;
    if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
  }
  return {
    update,
    stats() {
      let lit = 0;
      for (const it of items) if (it.level > 0.5) lit++;
      return { active: active.length, lit, total: items.length };
    },
    /** Per-exhibit level (tests / debugging). */
    level: (index) => (items[index] ? items[index].level : 0),
  };
}

export function buildWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const interactables = buildInteractables();
  const animated = [];

  // ---------------- floors & ceilings ----------------
  for (const room of ROOMS) {
    const w = (room.cols[1] - room.cols[0] + 1) * CELL;
    const d = (room.rows[1] - room.rows[0] + 1) * CELL;
    const cx = (g2w(room.cols[0]) + g2w(room.cols[1])) / 2;
    const cz = (g2z(room.rows[0]) + g2z(room.rows[1])) / 2;
    // plain colour: the lookdev pass puts its own PBR maps on tagged floors
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ color: room.floor, roughness: 0.9, metalness: 0.02 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, cz);
    floor.receiveShadow = true;
    group.add(floor);
    tag(floor, "floor", { room: room.id });

    const open = room.id === "court" || room.id === "porch";
    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({
        color: 0x0d1116,
        roughness: 1,
        transparent: open,
        opacity: open ? 0.32 : 1,
        side: THREE.DoubleSide,
      })
    );
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, room.h, cz);
    group.add(ceil);
    tag(ceil, "ceiling", { room: room.id });
  }

  // ---------------- walls ----------------
  const wallData = buildWallData();

  const wallGeo = new THREE.BoxGeometry(1, 1, 1);
  const walls = new THREE.InstancedMesh(
    wallGeo,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92 }),
    wallData.length
  );
  walls.castShadow = true;
  walls.receiveShadow = true;
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  wallData.forEach((w, i) => {
    const h = w.room ? w.room.h : 6;
    dummy.position.set(w.x, h / 2, w.z);
    dummy.scale.set(w.sx, h, w.sz);
    dummy.updateMatrix();
    walls.setMatrixAt(i, dummy.matrix);
    col.set(w.room ? w.room.wall : 0x22262b);
    walls.setColorAt(i, col);
  });
  walls.instanceMatrix.needsUpdate = true;
  if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
  group.add(walls);
  tag(walls, "wall");

  const trim = new THREE.InstancedMesh(
    wallGeo,
    new THREE.MeshStandardMaterial({ color: 0x15191e, roughness: 0.8 }),
    wallData.length
  );
  wallData.forEach((w, i) => {
    dummy.position.set(w.x, 0.35, w.z);
    dummy.scale.set(w.sx * 1.06, 0.7, w.sz * 1.06);
    dummy.updateMatrix();
    trim.setMatrixAt(i, dummy.matrix);
  });
  trim.instanceMatrix.needsUpdate = true;
  group.add(trim);
  tag(trim, "trim");

  // ---------------- lighting ----------------
  scene.add(new THREE.HemisphereLight(0xbfd4e6, 0x3a2f22, 0.75));
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));

  const sun = new THREE.DirectionalLight(0xfff0d8, 1.1);
  sun.position.set(60, 110, 50);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 320;
  sun.shadow.camera.left = -120;
  sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120;
  sun.shadow.camera.bottom = -120;
  sun.shadow.bias = -0.0007;
  scene.add(sun);
  scene.add(sun.target);

  // Real point lights are expensive: three.js does no light culling, so every
  // lit fragment in the museum loops over every point light. Each hall gets
  // one (two in the big halls, spread along the long side); passages get
  // none and are lit by their neighbours, the hemisphere/ambient fill and
  // their emissive ceiling fixtures. That keeps the scene under 20 lights.
  const fixtureGeo = new THREE.CylinderGeometry(0.55, 0.72, 0.22, 12);
  const fixtureMats = new Map(); // accent -> material
  for (const room of ROOMS) {
    if (room.dark) continue; // a projection room stays dark
    const w = (room.cols[1] - room.cols[0] + 1) * CELL;
    const d = (room.rows[1] - room.rows[0] + 1) * CELL;
    const cx = (g2w(room.cols[0]) + g2w(room.cols[1])) / 2;
    const cz = (g2z(room.rows[0]) + g2z(room.rows[1])) / 2;
    const hall = room.h > 6;
    const lights = hall && w * d >= 1000 ? 2 : 1;
    // mostly warm museum white with a hint of the hall's accent colour
    const tint = new THREE.Color(room.accent).lerp(new THREE.Color(0xffe2bd), 0.65);
    if (!fixtureMats.has(room.accent)) {
      fixtureMats.set(
        room.accent,
        new THREE.MeshStandardMaterial({
          color: 0x1b1f24,
          emissive: new THREE.Color(room.accent),
          emissiveIntensity: 1.8,
          roughness: 0.5,
        })
      );
    }
    for (let i = 0; i < lights; i++) {
      // one light: the middle; two: a quarter of the way in from each end
      const t = lights === 1 ? 0 : i === 0 ? -0.25 : 0.25;
      const lx = cx + (w >= d ? w * t : 0);
      const lz = cz + (w >= d ? 0 : d * t);
      if (hall) {
        // fewer lights than before, so each one carries a bit more
        const pl = new THREE.PointLight(tint, 160, Math.max(w, d) * 0.95, 2);
        pl.position.set(lx, room.h - 1.8, lz);
        group.add(pl);
      }
      const fix = new THREE.Mesh(fixtureGeo, fixtureMats.get(room.accent));
      fix.position.set(lx, room.h - 0.25, lz);
      group.add(fix);
      tag(fix, "emissive");
    }
  }

  // No hanging hall banners: one under the Grand Gallery's oculus sat in the
  // T. rex sightline and, turned edge-on to the doorways, they read as dark
  // slabs. The doorway signs already name every hall.

  // ---------------- doorway signs ----------------
  // every doorway gets a sign on each side naming where it leads; a corridor
  // is named after the halls beyond it.
  {
    const isPassage = (room) => room.h <= 6;
    const doors = new Map();
    for (const key of OPEN) {
      const [kind, rest] = key.split(":");
      const [c, r] = rest.split(",").map(Number);
      const a = roomGrid.get(`${c},${r}`);
      const b = kind === "h" ? roomGrid.get(`${c + 1},${r}`) : roomGrid.get(`${c},${r + 1}`);
      if (!a || !b) continue;
      const id = `${kind}:${a.id}:${b.id}`;
      if (!doors.has(id)) doors.set(id, { kind, a, b, cells: [] });
      doors.get(id).cells.push([c, r]);
    }
    const neighboursOf = (room) => {
      const out = new Set();
      for (const d of doors.values()) {
        if (d.a === room) out.add(d.b);
        if (d.b === room) out.add(d.a);
      }
      return out;
    };
    // a straight-through corridor (two doorways facing each other): the sign
    // over its far doorway, on the corridor side, only repeats the one over
    // its entrance and is seen stacked right above it from the hall, so it
    // is left out. A bent passage keeps it: its far end is out of sight.
    const straightPassage = (room) => {
      if (!isPassage(room)) return false;
      const own = [...doors.values()].filter((d) => d.a === room || d.b === room);
      return own.length === 2 && own[0].kind === own[1].kind;
    };
    const destName = (to, from) => {
      if (!isPassage(to)) return to.name;
      const beyond = [...neighboursOf(to)].filter((r) => r !== from && !isPassage(r));
      const name = beyond.length ? beyond.map((r) => r.name).join(" · ") : to.name;
      // the ice cream court is the tour's secret ending: from inside the museum
      // its doorway just says Exit
      return to.id === "xpassage" && from.id !== "court" ? "Exit" : name;
    };
    for (const d of doors.values()) {
      const n = d.cells.length;
      const mid = d.cells.reduce((s, [c, r]) => [s[0] + c / n, s[1] + r / n], [0, 0]);
      const lowH = Math.min(d.a.h, d.b.h);
      const highH = Math.max(d.a.h, d.b.h);
      const y = lowH - 0.65;
      const width = Math.min(n * CELL - 1, 8);
      // lintel over the doorway, up to the taller room's ceiling
      const lintelBottom = lowH - 1.3;
      const lintel = new THREE.Mesh(
        new THREE.BoxGeometry(d.kind === "h" ? 0.4 : n * CELL, highH - lintelBottom, d.kind === "h" ? n * CELL : 0.4),
        new THREE.MeshStandardMaterial({ color: d.a.h >= d.b.h ? d.a.wall : d.b.wall, roughness: 0.92 })
      );
      lintel.position.set(
        d.kind === "h" ? g2w(mid[0]) + CELL / 2 : g2w(mid[0]),
        (highH + lintelBottom) / 2,
        d.kind === "h" ? g2z(mid[1]) : g2z(mid[1]) + CELL / 2
      );
      group.add(lintel);
      tag(lintel, "wall", { room: (d.a.h >= d.b.h ? d.a : d.b).id });
      for (const [from, to, side] of [
        [d.a, d.b, -1],
        [d.b, d.a, 1],
      ]) {
        if (straightPassage(from)) continue;
        const text = destName(to, from).toUpperCase();
        // the canvas has the plane's aspect (110 px per 0.85 m both ways), so
        // a narrow one-cell doorway gets a narrower canvas, not squashed text
        const canvasW = Math.round((SIGN_H_PX * width) / SIGN_H);
        const sign = new THREE.Mesh(
          new THREE.PlaneGeometry(width, SIGN_H),
          new THREE.MeshBasicMaterial({
            map: makeTextTexture(text, {
              width: canvasW,
              height: SIGN_H_PX,
              fontSize: fitFontSize(text, text.length > 24 ? 44 : 60, canvasW - 48),
              color: `#${new THREE.Color(to.accent).getHexString()}`,
              bg: "#0d1217",
            }),
          })
        );
        if (d.kind === "h") {
          // wall line runs along z at x = east edge of cell c
          sign.position.set(g2w(mid[0]) + CELL / 2 + side * 0.22, y, g2z(mid[1]));
          sign.rotation.y = side < 0 ? -Math.PI / 2 : Math.PI / 2;
        } else {
          sign.position.set(g2w(mid[0]), y, g2z(mid[1]) + CELL / 2 + side * 0.22);
          sign.rotation.y = side < 0 ? Math.PI : 0;
        }
        group.add(sign);
        tag(sign, "skip");
      }
    }
  }

  // ---------------- shared props ----------------
  const pedestalMat = new THREE.MeshStandardMaterial({ color: 0x2e333a, roughness: 0.8 });
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xc9a227,
    roughness: 0.35,
    metalness: 0.85,
  });

  /** A placard on a brass post. withPost = false when the caller instances the posts itself. */
  function addPlacard(x, y, z, ry, title, sub, withPost = true) {
    const p = makePlacard(title, sub);
    p.position.set(x, y, z);
    p.rotation.y = ry;
    group.add(p);
    tag(p, "skip");
    if (!withPost) return p;
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, Math.max(0.2, y - 0.5), 8),
      brassMat
    );
    post.position.set(x, (y - 0.5) / 2, z);
    group.add(post);
    tag(post, "metal", { metal: "brass" });
    return p;
  }

  function addBench(x, z, ry) {
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.85 });
    const seat = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.16, 0.9), wood);
    seat.position.y = 0.5;
    seat.castShadow = true;
    g.add(seat);
    const back = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.5, 0.12), wood);
    back.position.set(0, 0.78, -0.4);
    g.add(back);
    for (const sx of [-1.3, 1.3]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.7), pedestalMat);
      leg.position.set(sx, 0.25, 0);
      g.add(leg);
      tag(leg, "metal", { metal: "black" });
    }
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    group.add(g);
    tag(g, "wood");
  }

  function addPlanter(x, z) {
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.55, 0.9, 12),
      new THREE.MeshStandardMaterial({ color: 0x7a6a58, roughness: 0.9 })
    );
    pot.position.set(x, 0.45, z);
    pot.castShadow = true;
    group.add(pot);
    tag(pot, "plinth");
    for (let i = 0; i < 7; i++) {
      const leaf = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 1.7 + rand(-0.3, 0.6), 5),
        new THREE.MeshStandardMaterial({ color: 0x3f7a45, roughness: 0.9 })
      );
      leaf.position.set(x + rand(-0.35, 0.35), 1.5 + rand(0, 0.5), z + rand(-0.35, 0.35));
      leaf.rotation.set(rand(-0.3, 0.3), rand(0, 3), rand(-0.3, 0.3));
      leaf.castShadow = true;
      group.add(leaf);
      tag(leaf, "skip");
    }
  }

  const exhibits = [];
  const spotPoolGeo = new THREE.CircleGeometry(1, 28);
  const spotPoolMat = new THREE.MeshBasicMaterial({
    map: radialTexture("rgba(255,214,160,0.55)", "rgba(255,190,120,0)"),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const spotBeamGeo = new THREE.CylinderGeometry(0.12, 1, 1, 20, 1, true);
  const spotBeamMat = new THREE.MeshBasicMaterial({
    map: beamTexture(),
    color: 0xffd9a8,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const spotFixtureGeo = new THREE.CylinderGeometry(0.35, 0.5, 0.4, 12);
  const spotFixtureMat = new THREE.MeshBasicMaterial({ color: 0xfff0d0, toneMapped: false });

  // ---------------- exhibit image panels ----------------
  // A framed, double-sided photo / painting of every species on a plinth.
  // The picture is /images/species/<id>.jpg; until it arrives (or if it is
  // missing) a name card is shown instead.
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.55, metalness: 0.25 });
  const plinthMat = new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.8 });
  const loader = new THREE.TextureLoader();
  const PANEL_BOTTOM = DISPLAY_PANEL_BOTTOM;
  const PANEL_MAX_H = 3.4;
  const captions = [];

  // Draw calls: the parts every panel shares (plinth, brass trim, frame,
  // backboard, placard post, light pool and beam) are one InstancedMesh
  // each for all 53 panels; the picture and the caption plate are one mesh
  // each with a front and a back face. Instance i of a part belongs to
  // EXHIBIT_PANELS[i] (frame/backboard: 2i and 2i+1).
  const nPanels = EXHIBIT_PANELS.length;
  const instanced = (geo, mat, count, surface, extra) => {
    const m = new THREE.InstancedMesh(geo, mat, count);
    m.count = 0;
    group.add(m);
    tag(m, surface, extra);
    return m;
  };
  const plinths = instanced(unitBox, plinthMat, nPanels, "plinth");
  plinths.castShadow = true;
  plinths.receiveShadow = true;
  const trims = instanced(unitBox, brassMat, nPanels, "metal", { metal: "brass" });
  const frames = instanced(unitBox, frameMat, nPanels * 2, "wood");
  const postGeo = new THREE.CylinderGeometry(0.07, 0.07, 1, 8);
  const posts = instanced(postGeo, brassMat, nPanels, "metal", { metal: "brass" });
  const pools = instanced(spotPoolGeo, spotPoolMat, nPanels, "skip");
  const beams = instanced(spotBeamGeo, spotBeamMat, nPanels, "skip");
  const imageGeo = twoSidedPlane(0.052);
  const captionGeo = twoSidedPlane(0.055);
  const partMatrix = new THREE.Matrix4();
  const partLocal = new THREE.Matrix4();
  const IDENTITY = new THREE.Matrix4(); // parts placed straight in world space
  /** Instance matrix: the panel's transform x a part offset (x, y, z) and scale. */
  const setPart = (mesh, i, base, x, y, z, sx, sy, sz) => {
    partLocal.makeScale(sx, sy, sz).setPosition(x, y, z);
    mesh.setMatrixAt(i, partMatrix.multiplyMatrices(base, partLocal));
    mesh.count = Math.max(mesh.count, i + 1);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.boundingSphere = null; // recomputed (lazily) from the instances
  };

  // Name card shown until (or instead of) the photo. Drawn at half the
  // 768x512 design size: it is only up while the photo streams in (or far
  // away), and 53 of them at full size were ~110 MB of video memory.
  function placeholderTexture(spec, accent) {
    const c = makeCanvas(384, 256);
    const ctx = c.getContext("2d");
    ctx.scale(0.5, 0.5);
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0, "#1b2228");
    g.addColorStop(1, "#11161a");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 768, 512);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 6;
    ctx.strokeRect(28, 28, 712, 456);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f6efe2";
    ctx.font = `800 ${spec.name.length > 14 ? 60 : 76}px Inter, system-ui, sans-serif`;
    ctx.fillText(spec.name, 384, 226);
    ctx.fillStyle = accent;
    ctx.font = "500 34px Inter, system-ui, sans-serif";
    ctx.fillText(spec.info?.era || "", 384, 310);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  function drawCaption(caption) {
    const { ctx, spec, accent, credit } = caption;
    ctx.clearRect(0, 0, 1024, 220);
    ctx.fillStyle = "#0e1316";
    ctx.fillRect(0, 0, 1024, 220);
    ctx.fillStyle = accent;
    ctx.fillRect(0, 0, 1024, 8);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "#fff6e6";
    ctx.font = "700 64px Inter, system-ui, sans-serif";
    ctx.fillText(spec.name, 40, 70);
    ctx.fillStyle = accent;
    ctx.font = "500 36px Inter, system-ui, sans-serif";
    ctx.fillText([spec.info?.era, spec.info?.length].filter(Boolean).join("  ·  "), 40, 138);
    if (credit) {
      ctx.fillStyle = "rgba(255,246,230,0.6)";
      ctx.font = "400 22px Inter, system-ui, sans-serif";
      const text = credit.length > 92 ? `${credit.slice(0, 90)}…` : credit;
      ctx.fillText(text, 40, 194);
    }
    caption.tex.needsUpdate = true;
  }

  const spotDummy = new THREE.Object3D();
  const presenceItems = [];
  const presenceRest = new THREE.Color().setScalar(PRESENCE_REST);
  let k = 0; // instance index of the next panel
  for (const panel of EXHIBIT_PANELS) {
    const spec = SPECIES[panel.id];
    if (!spec) continue;
    const i = k++;
    const room = roomAt(panel.x, panel.z);
    const accent = `#${new THREE.Color(room ? room.accent : 0xffc857).getHexString()}`;
    const g = new THREE.Group();
    g.position.set(panel.x, 0, panel.z);
    g.rotation.y = panel.face;
    g.updateMatrix();
    group.add(g);
    const base = g.matrix;

    setPart(plinths, i, base, 0, 0.4, 0, panel.w + 0.3, 0.8, PANEL_DEPTH);
    setPart(trims, i, base, 0, 0.8, 0, panel.w + 0.4, 0.06, PANEL_DEPTH + 0.1);

    const imageMat = new THREE.MeshBasicMaterial({ map: placeholderTexture(spec, accent) });
    const picture = new THREE.Mesh(imageGeo, imageMat);
    g.add(picture);
    tag(picture, "image");

    const layout = (aspect) => {
      let w = panel.w;
      let h = w / aspect;
      if (h > PANEL_MAX_H) {
        h = PANEL_MAX_H;
        w = h * aspect;
      }
      const y = PANEL_BOTTOM + h / 2;
      setPart(frames, 2 * i, base, 0, y, 0, w + 0.22, h + 0.22, 0.1);
      // backboard lifting the picture above a fossil model standing in front
      setPart(frames, 2 * i + 1, base, 0, 0.8 + (PANEL_BOTTOM - 0.8) / 2, 0, w + 0.22, PANEL_BOTTOM - 0.8 + 0.05, 0.09);
      picture.scale.set(w, h, 1);
      picture.position.set(0, y, 0);
      entry.y = PANEL_BOTTOM + h + 0.11;
      entry.width = w;
      entry.height = h;
    };

    // caption plate on both long faces of the plinth
    const capCanvas = makeCanvas(1024, 220);
    const capTex = new THREE.CanvasTexture(capCanvas);
    capTex.colorSpace = THREE.SRGBColorSpace;
    capTex.anisotropy = 4;
    const caption = { ctx: capCanvas.getContext("2d"), tex: capTex, spec, accent, credit: null };
    drawCaption(caption);
    captions.push(caption);
    // caption plate on the backboard, just under the picture (above any
    // model up to DISPLAY_MAX_H standing in front), front and back
    const capW = Math.min(panel.w, 2.4);
    const cap = new THREE.Mesh(captionGeo, new THREE.MeshBasicMaterial({ map: capTex }));
    cap.scale.set(capW, capW * (220 / 1024), 1);
    cap.position.set(0, PANEL_BOTTOM - 0.33, 0);
    g.add(cap);
    tag(cap, "skip");

    // the caption plate already names the animal: no separate standing placard,
    // so its instanced post is collapsed to nothing
    const { px, pz } = placardSpot({ x: panel.x, z: panel.z, ry: panel.face, pedestal: panel.w });
    const placard = null;
    setPart(posts, i, IDENTITY, px, 0.5, pz, 0, 0, 0);

    const entry = {
      id: spec.id,
      exhibitId: spec.id,
      name: spec.name,
      room: room ? room.id : null,
      x: panel.x,
      z: panel.z,
      y: 0,
      ry: panel.face,
      radius: panel.w / 2,
      width: panel.w,
      height: 0,
      image: `/images/species/${spec.id}.jpg`,
      placard: { x: px, z: pz },
      object: g,
      placardMesh: placard,
    };
    exhibits.push(entry);
    layout(3 / 2);

    // The photo streams: photos.update() loads it when the visitor is in or
    // next to its hall and frees it again once they are far away (a name
    // card stands in meanwhile). The frame keeps the photo's aspect after
    // an unload, so nothing jumps when it comes back.
    caption.panel = { x: panel.x, z: panel.z, room: room ? room.id : null };
    caption.state = "none"; // none | loading | ready | failed
    caption.url = null;
    caption.setUrl = (url) => {
      entry.image = url;
      caption.url = url;
    };
    caption.show = (tex, aspect) => {
      if (imageMat.map) imageMat.map.dispose();
      imageMat.map = tex;
      imageMat.needsUpdate = true;
      layout(aspect);
    };
    caption.unload = () => {
      const tex = imageMat.map;
      imageMat.map = placeholderTexture(spec, accent);
      imageMat.needsUpdate = true;
      if (tex) {
        tex.dispose();
        tex.image?.close?.(); // ImageBitmap
      }
      caption.state = "none";
    };

    // warm museum "spotlight": a pool of light on the floor, a soft beam and
    // a fixture overhead. Faked with additive meshes so 50+ exhibits cost no
    // real lights (swiftshader stays fast).
    const ceiling = room ? room.h : 10;
    const reach = Math.max(2.4, panel.w * 0.75);
    spotDummy.position.set(panel.x, 0.03, panel.z);
    spotDummy.rotation.set(-Math.PI / 2, 0, 0);
    spotDummy.scale.set(reach, reach, 1);
    spotDummy.updateMatrix();
    pools.setMatrixAt(i, spotDummy.matrix);
    pools.count = i + 1;
    const beamH = ceiling - 0.4;
    setPart(beams, i, IDENTITY, panel.x, beamH / 2, panel.z, reach, beamH, reach);
    // the fixture stays a mesh of its own: the lookdev pass gives every
    // ceiling fixture a housing and lens, and it skips instanced meshes
    const fixture = new THREE.Mesh(spotFixtureGeo, spotFixtureMat);
    fixture.position.set(panel.x, ceiling - 0.2, panel.z);
    group.add(fixture);
    tag(fixture, "emissive");

    // presence lighting: this exhibit's pool, beam and picture brighten as
    // the visitor walks up (see createPresenceLighting)
    const disp = DISPLAYS.find((d) => d.speciesId === panel.id);
    presenceItems.push({
      i,
      room: room ? room.id : null,
      box: { minX: panel.minX, maxX: panel.maxX, minZ: panel.minZ, maxZ: panel.maxZ },
      box2: disp ? disp.bounds : null,
      mat: imageMat,
      base: -1, // the picture's resting colour, read on the first update (lookdev sets it)
      level: 0,
      hold: 0,
      active: false,
    });
    pools.setColorAt(i, presenceRest);
    beams.setColorAt(i, presenceRest);
  }
  pools.instanceMatrix.needsUpdate = true;
  const presence = createPresenceLighting(presenceItems, pools, beams);

  // image credits, fetched once
  if (typeof fetch === "function") {
    fetch("/images/species/manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((manifest) => {
        if (!manifest) return;
        // only pictures listed in the manifest are requested, so a missing
        // image never produces a 404 in the console
        for (const caption of captions) {
          const m = manifest[caption.spec.id];
          if (!m) continue;
          const file = typeof m.file === "string" && m.file ? m.file.split("/").pop() : `${caption.spec.id}.jpg`;
          caption.setUrl(`/images/species/${file}`);
          if (!m.credit) continue;
          caption.credit = `Image: ${m.credit}${m.license ? ` · ${m.license}` : ""}`;
          drawCaption(caption);
        }
      })
      .catch(() => {
        /* no credits available */
      });
  }
  const photos = createPhotoStreamer(captions, loader);

  // ---------------- era windows ----------------
  // a glowing frame on the wall; the window "glass" is a soft sky gradient
  // until main.js opens the 360° view
  const eraTint = { triassic: "#e09a4a", jurassic: "#7bc47f", cretaceous: "#ff8a5c", marine: "#4fc3f7" };
  for (const w of ERA_WINDOWS) {
    const era = ERAS[w.era];
    const tint = eraTint[w.era] || "#ffd166";
    const c = makeCanvas(768, 480);
    const ctx = c.getContext("2d");
    const sky = ctx.createLinearGradient(0, 0, 0, 480);
    sky.addColorStop(0, w.era === "marine" ? "#0b3954" : "#f3c98b");
    sky.addColorStop(0.55, w.era === "marine" ? "#1f7a9c" : tint);
    sky.addColorStop(1, w.era === "marine" ? "#0a2233" : "#3b2a1c");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 768, 480);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 42px Inter, system-ui, sans-serif";
    ctx.fillText(`WINDOW TO THE ${era.name.toUpperCase()}`, 384, 220);
    ctx.font = "500 30px Inter, system-ui, sans-serif";
    ctx.fillText("press E to look through", 384, 290);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const wg = new THREE.Group();
    wg.position.set(w.x, 0, w.z);
    wg.rotation.y = w.ry;
    group.add(wg);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry(ERA_WINDOW_W, ERA_WINDOW_H),
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
    );
    glass.position.set(0, 1.2 + ERA_WINDOW_H / 2, 0.06);
    wg.add(glass);
    tag(glass, "emissive");
    const glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(tint), toneMapped: false });
    for (const [sx, sy, px, py] of [
      [ERA_WINDOW_W + 0.5, 0.25, 0, 1.2 - 0.12],
      [ERA_WINDOW_W + 0.5, 0.25, 0, 1.2 + ERA_WINDOW_H + 0.12],
      [0.25, ERA_WINDOW_H, -ERA_WINDOW_W / 2 - 0.12, 1.2 + ERA_WINDOW_H / 2],
      [0.25, ERA_WINDOW_H, ERA_WINDOW_W / 2 + 0.12, 1.2 + ERA_WINDOW_H / 2],
    ]) {
      const bar = new THREE.Mesh(unitBox, glowMat);
      bar.scale.set(sx, sy, 0.14);
      bar.position.set(px, py, 0.07);
      wg.add(bar);
      tag(bar, "metal", { metal: "brass" });
    }
    const sill = new THREE.Mesh(unitBox, brassMat);
    sill.scale.set(ERA_WINDOW_W + 0.8, 0.12, 0.6);
    sill.position.set(0, 1.0, 0.3);
    wg.add(sill);
    tag(sill, "metal", { metal: "brass" });
    const glow = new THREE.Mesh(spotPoolGeo, spotPoolMat);
    glow.scale.set(4, 2.4, 1);
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, 0.03, 1.6);
    wg.add(glow);
    tag(glow, "skip");
  }

  // ---------------- theatre ----------------
  const screenW = SCREEN.w;
  const screenH = SCREEN.h;
  // idle "poster": cinema.js keeps this texture as the screen's idle map,
  // swaps in its own while a screening runs and puts this one back after
  const screenTex = new THREE.CanvasTexture(screenPoster());
  screenTex.colorSpace = THREE.SRGBColorSpace;
  screenTex.anisotropy = 4;
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenH), screenMat);
  screen.position.set(SCREEN.x, SCREEN.y, SCREEN.z);
  group.add(screen);
  tag(screen, "emissive");
  const screenFrame = new THREE.Mesh(
    new THREE.BoxGeometry(screenW + 0.8, screenH + 0.8, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.7 })
  );
  screenFrame.position.set(SCREEN.x, SCREEN.y, SCREEN.z - 0.3);
  group.add(screenFrame);
  tag(screenFrame, "metal", { metal: "black" });
  // stage + curtains either side of the screen
  const stage = new THREE.Mesh(
    new THREE.BoxGeometry(screenW + 6, 0.5, 3.2),
    new THREE.MeshStandardMaterial({ color: 0x20252d, roughness: 0.8 })
  );
  stage.position.set(SCREEN.x, 0.25, SCREEN.z + 1.4);
  stage.receiveShadow = true;
  group.add(stage);
  tag(stage, "plinth");
  const curtainMat = new THREE.MeshStandardMaterial({ color: 0x6e1424, roughness: 0.95 });
  for (const sx of [-1, 1]) {
    const curtain = new THREE.Mesh(new THREE.BoxGeometry(2.4, 12.6, 0.4), curtainMat);
    curtain.position.set(SCREEN.x + sx * (screenW / 2 + 1.6), 6.3, SCREEN.z + 0.1);
    group.add(curtain);
    tag(curtain, "fabric");
  }

  // seats: one instanced mesh per part keeps 168 seats at 4 draw calls
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x8a2234, roughness: 0.85 });
  const seatFrameMat = new THREE.MeshStandardMaterial({ color: 0x1c2027, roughness: 0.6, metalness: 0.3 });
  const parts = [
    { geo: new THREE.BoxGeometry(0.98, 0.16, 0.86), mat: seatMat, pos: [0, THEATRE_SEAT_Y - 0.08, 0.04] },
    { geo: new THREE.BoxGeometry(0.98, 0.92, 0.16), mat: seatMat, pos: [0, 0.98, -0.42], rotX: -0.12 },
    { geo: new THREE.BoxGeometry(0.12, 0.62, 0.86), mat: seatFrameMat, pos: [-0.56, 0.31, 0] },
    { geo: new THREE.BoxGeometry(0.12, 0.62, 0.86), mat: seatFrameMat, pos: [0.56, 0.31, 0] },
  ];
  const seatDummy = new THREE.Object3D();
  const local = new THREE.Object3D();
  for (const part of parts) {
    const mesh = new THREE.InstancedMesh(part.geo, part.mat, THEATRE_SEATS.length);
    THEATRE_SEATS.forEach((s, i) => {
      seatDummy.position.set(s.x, 0, s.z);
      seatDummy.rotation.set(0, s.ry, 0);
      seatDummy.updateMatrix();
      local.position.set(...part.pos);
      local.rotation.set(part.rotX || 0, 0, 0);
      local.updateMatrix();
      mesh.setMatrixAt(i, seatDummy.matrix.clone().multiply(local.matrix));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    tag(mesh, part.mat === seatMat ? "fabric" : "metal", { metal: "black" });
  }
  // aisle step lights along the centre aisle and both block edges
  const stepLights = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.3, 0.025, 0.06),
    new THREE.MeshBasicMaterial({ color: 0x8a5a1c }),
    7 * 4
  );
  let sl = 0;
  for (let row = 0; row < 7; row++) {
    for (const x of [-17.6, -0.9, 0.9, 17.6]) {
      seatDummy.position.set(x, 0.03, -73 + row * 2.8 + 1.3);
      seatDummy.rotation.set(0, 0, 0);
      seatDummy.updateMatrix();
      stepLights.setMatrixAt(sl++, seatDummy.matrix);
    }
  }
  stepLights.instanceMatrix.needsUpdate = true;
  group.add(stepLights);
  tag(stepLights, "emissive");

  // projection console by the entrance (the "battle" interactable)
  const console_ = new THREE.Mesh(
    new THREE.BoxGeometry(PROPS.console.w, 1.1, PROPS.console.d),
    new THREE.MeshStandardMaterial({ color: 0x20262e, roughness: 0.6, metalness: 0.4 })
  );
  console_.position.set(PROPS.console.x, 0.55, PROPS.console.z);
  group.add(console_);
  tag(console_, "plinth");
  const consoleTop = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 0.8),
    new THREE.MeshBasicMaterial({
      map: makeTextTexture("▶ BATTLE SCREENING", { width: 512, height: 200, fontSize: 52, color: "#59d4e6", bg: "#0b1218" }),
    })
  );
  consoleTop.position.set(0, 1.3, -51.75);
  consoleTop.rotation.x = -Math.PI / 2 + 0.5;
  group.add(consoleTop);
  tag(consoleTop, "skip");


  // ---------------- atrium ----------------
  const desk = new THREE.Mesh(new THREE.BoxGeometry(PROPS.desk.w, 1.1, PROPS.desk.d), pedestalMat);
  desk.position.set(PROPS.desk.x, 0.55, PROPS.desk.z);
  desk.castShadow = true;
  group.add(desk);
  tag(desk, "plinth");
  addPlacard(-16, 2.3, 50.6, Math.PI, "INFORMATION DESK", "Ask our guide anything");

  const backdrop = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 8),
    new THREE.MeshBasicMaterial({
      map: makeTextTexture("DINO MUSEUM", {
        width: 1024,
        height: 512,
        fontSize: 82,
        color: "#ffd166",
        sub: "TAKE YOUR PICTURE!",
        subSize: 46,
      }),
    })
  );
  backdrop.position.set(16, 3.6, 52);
  backdrop.rotation.y = Math.PI;
  group.add(backdrop);
  tag(backdrop, "skip");

  for (const b of ATRIUM_BENCHES) addBench(b.x, b.z, b.ry);
  // benches in front of the big centrepieces (each holds two "seat" spots)
  for (const b of BENCHES) if (!b.custom) addBench(b.x, b.z, b.ry);
  // potted plants (the atrium's and the ice cream court's)
  for (const [x, z] of PLANTERS) addPlanter(x, z);

  // ---------------- triassic extras ----------------
  const pit = new THREE.Mesh(
    new THREE.CylinderGeometry(3.4, 3.2, 0.5, 20),
    new THREE.MeshStandardMaterial({ color: 0x5a4a34, roughness: 1 })
  );
  pit.position.set(-66, 0.1, 34);
  pit.receiveShadow = true;
  group.add(pit);
  tag(pit, "skip");
  for (let i = 0; i < 10; i++) {
    const bone = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.16, 1.6, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0xe4d5b4, roughness: 0.75 })
    );
    bone.position.set(-66 + rand(-2.4, 2.4), 0.4, 34 + rand(-2.4, 2.4));
    bone.rotation.set(rand(-0.4, 0.4), rand(0, 3), rand(-0.5, 0.5));
    group.add(bone);
    tag(bone, "skip");
  }

  const table = new THREE.Mesh(new THREE.BoxGeometry(PROPS.puzzle.w, 0.25, PROPS.puzzle.d), pedestalMat);
  table.position.set(PROPS.puzzle.x, 1.0, PROPS.puzzle.z);
  group.add(table);
  tag(table, "plinth");
  for (const sx of [-2.3, 2.3]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1, 2.8), pedestalMat);
    leg.position.set(-78 + sx, 0.5, 34);
    group.add(leg);
    tag(leg, "plinth");
  }
  for (let i = 0; i < 8; i++) {
    const b = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.14, 1.1, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0xe4d5b4, roughness: 0.75 })
    );
    b.position.set(-78 + rand(-2.2, 2.2), 1.25, 34 + rand(-1.2, 1.2));
    b.rotation.set(rand(-0.3, 0.3), rand(0, 3), Math.PI / 2);
    group.add(b);
    tag(b, "skip");
  }
  addPlacard(-78, 1.8, 36.3, 0, "BONE ASSEMBLY", "Rebuild the skeleton");

  // ---------------- jurassic volcano diorama ----------------
  const volcano = new THREE.Mesh(
    new THREE.ConeGeometry(PROPS.volcano.r, 5.8, 16),
    new THREE.MeshStandardMaterial({ color: 0x3b2b22, roughness: 1 })
  );
  volcano.position.set(PROPS.volcano.x, 2.9, PROPS.volcano.z);
  volcano.castShadow = true;
  group.add(volcano);
  tag(volcano, "skip");
  const lava = new THREE.Mesh(
    new THREE.CircleGeometry(1.2, 16),
    new THREE.MeshStandardMaterial({
      color: 0xff5a1f,
      emissive: 0xff4500,
      emissiveIntensity: 2.6,
      roughness: 0.4,
    })
  );
  lava.rotation.x = -Math.PI / 2;
  lava.position.set(PROPS.volcano.x, 5.6, PROPS.volcano.z);
  group.add(lava);
  tag(lava, "emissive");
  animated.push({ type: "lava", mesh: lava, base: 2.2 });

  // ---------------- exit passage ----------------
  // the way out leaves the far (east) wall of the Jurassic Hall

  // ---------------- wayfinding to the ice cream court ----------------
  {
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.5, metalness: 0.7 });
    const backMat = new THREE.MeshBasicMaterial({ color: 0x0d1217 });
    const cableGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6);
    for (const s of WAYFINDING) {
      const sign = new THREE.Group();
      sign.position.set(s.x, s.y, s.z);
      sign.rotation.y = s.ry;
      sign.name = s.id;
      sign.userData.wayfinding = s.id;
      group.add(sign);
      const lightbox = s.kind === "lightbox";
      // frame / housing: behind the face (wall and lightbox) or around it (hanging, two-sided)
      const depth = lightbox ? 0.26 : s.kind === "wall" ? 0.06 : 0.09;
      const rim = lightbox ? 0.1 : 0.05;
      const frame = new THREE.Mesh(new THREE.BoxGeometry(s.w + rim * 2, s.h + rim * 2, depth), frameMat);
      frame.position.z = s.kind === "hang" ? 0 : -depth / 2 - 0.004;
      sign.add(frame);
      tag(frame, "metal", { metal: lightbox ? "steel" : "black" });
      const face = new THREE.Mesh(
        new THREE.PlaneGeometry(s.w, s.h),
        new THREE.MeshBasicMaterial({ map: lightbox ? lightboxTexture(s) : wayfindingTexture(s), toneMapped: !lightbox })
      );
      face.position.z = s.kind === "hang" ? depth / 2 + 0.003 : 0.003;
      sign.add(face);
      // a lightbox glows (bloom picks it up); printed signs stay as authored
      tag(face, lightbox ? "emissive" : "skip");
      if (s.kind === "hang") {
        const back = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), backMat);
        back.rotation.y = Math.PI;
        back.position.z = -depth / 2 - 0.003;
        sign.add(back);
        tag(back, "skip");
        // two cables up to the ceiling
        const ceiling = (ROOMS.find((r) => r.id === s.room) || { h: s.y + 2 }).h;
        const len = Math.max(0.1, ceiling - (s.y + s.h / 2 + rim));
        for (const side of [-1, 1]) {
          const cable = new THREE.Mesh(cableGeo, frameMat);
          cable.scale.y = len;
          cable.position.set(side * (s.w / 2 - 0.3), s.h / 2 + rim + len / 2, 0);
          sign.add(cable);
          tag(cable, "metal", { metal: "steel" });
        }
      }
    }
  }

  // ---------------- ice cream court ----------------
  // A small kiosk sized for one vendor: a 6 m counter, a striped awning
  // 3 m up on two poles behind the vendor, the shop sign on its front edge.
  const stallX = COURT.stallX;
  const stallZ = COURT.stallZ;
  const C = PROPS.counter;
  const counter = new THREE.Mesh(
    new THREE.BoxGeometry(C.w - 0.3, 1.1, C.d - 0.3),
    new THREE.MeshStandardMaterial({ color: 0xf2f0e6, roughness: 0.7 })
  );
  counter.position.set(C.x, 0.55, C.z);
  counter.castShadow = true;
  group.add(counter);
  tag(counter, "plinth");
  const counterTop = new THREE.Mesh(
    new THREE.BoxGeometry(C.w, 0.12, C.d),
    new THREE.MeshStandardMaterial({ color: 0xff8fab, roughness: 0.5 })
  );
  counterTop.position.set(C.x, 1.16, C.z);
  group.add(counterTop);
  tag(counterTop, "plinth");
  // striped awning over the counter and the vendor, sloping down to the front
  const awningW = C.w + 0.4;
  const awningD = 2.8;
  const awningZ = stallZ + 0.1;
  const awningY = 3.0;
  for (let i = 0; i < 6; i++) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(awningW / 6, 0.14, awningD),
      new THREE.MeshStandardMaterial({ color: i % 2 ? 0xfff3e0 : 0xff8fab, roughness: 0.6 })
    );
    stripe.position.set(stallX - awningW / 2 + (i + 0.5) * (awningW / 6), awningY, awningZ);
    stripe.rotation.x = -0.12;
    group.add(stripe);
    tag(stripe, "fabric");
  }
  for (const sx of [-1, 1]) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, awningY + 0.2, 8),
      new THREE.MeshStandardMaterial({ color: 0xd8d3c4, roughness: 0.6 })
    );
    pole.position.set(stallX + sx * (awningW / 2 - 0.25), (awningY + 0.2) / 2, awningZ + awningD / 2 - 0.25);
    group.add(pole);
    tag(pole, "metal", { metal: "steel" });
  }
  // tubs of ice cream in the counter
  const tubColors = [0xff9aa2, 0x9be7c4, 0x8b5a3c, 0xff6b3d, 0x7aa8ff, 0xe0a96d, 0x9fd36b, 0xfff1d0];
  tubColors.forEach((c, i) => {
    const tub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.26, 0.26, 0.14, 14),
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 })
    );
    tub.position.set(stallX + (i - (tubColors.length - 1) / 2) * 0.64, 1.25, C.z + 0.15);
    group.add(tub);
    tag(tub, "skip");
  });
  // the shop sign stands on the awning's low front edge, facing the court
  const stallSign = new THREE.Mesh(
    new THREE.PlaneGeometry(5.4, 1.16),
    new THREE.MeshBasicMaterial({
      map: makeTextTexture("PREHISTORIC SCOOP", {
        width: 1024,
        height: 220,
        fontSize: 72,
        color: "#ff8fab",
        bg: "#1d1418",
        sub: "8 FLAVOURS · CONES & CUPS",
        subSize: 34,
      }),
    })
  );
  stallSign.position.set(stallX, awningY + 0.5, awningZ - awningD / 2 + 0.1);
  stallSign.rotation.y = Math.PI;
  group.add(stallSign);
  tag(stallSign, "skip");

  // flavour board on its own stand next to the counter
  const flavours = [
    "Strawberry", "Mint Choco", "Dino Dust", "Volcano Chilli",
    "Blueberry", "Salted Caramel", "Matcha", "Extinction Vanilla",
  ];
  const boardCanvas = makeCanvas(768, 512);
  {
    const ctx = boardCanvas.getContext("2d");
    ctx.fillStyle = "#1f2a24";
    ctx.fillRect(0, 0, 768, 512);
    ctx.strokeStyle = "#ffe066";
    ctx.lineWidth = 10;
    ctx.strokeRect(10, 10, 748, 492);
    ctx.fillStyle = "#ffe066";
    ctx.font = "800 64px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("FLAVOURS", 384, 70);
    ctx.font = "600 34px Inter, system-ui, sans-serif";
    ctx.fillStyle = "#fff6e6";
    flavours.forEach((f, i) => {
      ctx.fillText(f, i < 4 ? 200 : 568, 160 + (i % 4) * 85);
    });
  }
  const boardTex = new THREE.CanvasTexture(boardCanvas);
  boardTex.colorSpace = THREE.SRGBColorSpace;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.6), new THREE.MeshBasicMaterial({ map: boardTex }));
  board.position.set(stallX + C.w / 2 + 1.4, 2.0, C.z - 0.6);
  board.rotation.y = Math.PI - 0.35;
  group.add(board);
  tag(board, "skip");
  const boardPost = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8), brassMat);
  boardPost.position.set(stallX + C.w / 2 + 1.4, 0.6, C.z - 0.55);
  group.add(boardPost);
  tag(boardPost, "metal", { metal: "brass" });

  const statueCone = new THREE.Mesh(
    new THREE.ConeGeometry(1.7, 3.8, 20),
    new THREE.MeshStandardMaterial({ color: 0xd9a05b, roughness: 0.85 })
  );
  statueCone.position.set(PROPS.statue.x, 1.9, PROPS.statue.z);
  statueCone.rotation.x = Math.PI;
  statueCone.castShadow = true;
  group.add(statueCone);
  tag(statueCone, "skip");
  const scoop = new THREE.Mesh(
    new THREE.SphereGeometry(1.8, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0xff9aa2, roughness: 0.7 })
  );
  scoop.position.set(PROPS.statue.x, 4.6, PROPS.statue.z);
  scoop.castShadow = true;
  group.add(scoop);
  tag(scoop, "skip");

  for (const [x, z] of CAFE_TABLES) {
    const t = new THREE.Mesh(
      new THREE.CylinderGeometry(1.3, 1.3, 0.12, 18),
      new THREE.MeshStandardMaterial({ color: 0xe8e3d5, roughness: 0.7 })
    );
    t.position.set(x, 0.9, z);
    group.add(t);
    tag(t, "plinth");
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.9, 8),
      new THREE.MeshStandardMaterial({ color: 0x8b8b8b, roughness: 0.6 })
    );
    leg.position.set(x, 0.45, z);
    group.add(leg);
    tag(leg, "metal", { metal: "steel" });
    const parasol = new THREE.Mesh(
      new THREE.ConeGeometry(2, 0.8, 10),
      new THREE.MeshStandardMaterial({ color: x % 8 ? 0x7ad7f0 : 0xffd166, roughness: 0.7 })
    );
    parasol.position.set(x, 3.2, z);
    group.add(parasol);
    tag(parasol, "fabric");
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6), seatFrameMat);
    stick.position.set(x, 2.1, z);
    group.add(stick);
    tag(stick, "metal", { metal: "steel" });
  }

  // string lights criss-crossing the court
  const bulbColors = [0xff8fab, 0xffe066, 0x7ee081, 0x7ad7f0];
  const bulbs = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    3 * 18
  );
  let bi = 0;
  const bulbCol = new THREE.Color();
  const courtRoom = ROOMS.find((r) => r.id === "court");
  const cx0 = g2w(courtRoom.cols[0]) - CELL / 2 + 2;
  const cx1 = g2w(courtRoom.cols[1]) + CELL / 2 - 2;
  const cz0 = g2z(courtRoom.rows[0]) - CELL / 2 + 4;
  const cz1 = g2z(courtRoom.rows[1]) + CELL / 2 - 6; // stops short of the awning
  const czm = (cz0 + cz1) / 2;
  for (const [z0, z1] of [[cz0, cz1], [cz1, cz0], [czm, czm]]) {
    for (let i = 0; i < 18; i++) {
      const t = i / 17;
      seatDummy.position.set(cx0 + t * (cx1 - cx0), 8.2 - Math.sin(t * Math.PI) * 1.2, z0 + (z1 - z0) * t);
      seatDummy.rotation.set(0, 0, 0);
      seatDummy.updateMatrix();
      bulbs.setMatrixAt(bi, seatDummy.matrix);
      bulbs.setColorAt(bi, bulbCol.set(bulbColors[i % 4]));
      bi++;
    }
  }
  bulbs.instanceMatrix.needsUpdate = true;
  group.add(bulbs);
  tag(bulbs, "emissive");

  // the way out of the museum: a glowing door in the west wall
  const door = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 4.4),
    new THREE.MeshStandardMaterial({ color: 0x1c3524, emissive: 0x2f8f4e, emissiveIntensity: 0.6, roughness: 0.6 })
  );
  door.position.set(COURT.exitX + 0.05, 2.2, COURT.exitZ);
  door.rotation.y = Math.PI / 2;
  group.add(door);
  tag(door, "emissive");
  const doorSign = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 0.9),
    new THREE.MeshBasicMaterial({
      map: makeTextTexture("EXIT", { width: 512, height: 136, fontSize: 92, color: "#7ee081", bg: "#0c1410" }),
    })
  );
  doorSign.position.set(COURT.exitX + 0.06, 5.0, COURT.exitZ);
  doorSign.rotation.y = Math.PI / 2;
  group.add(doorSign);
  tag(doorSign, "skip");

  // ---------------- timeline pillar ----------------
  // A tapered pillar wrapped in a sleeve that follows the taper 2 cm outside
  // it (so no part of the label sinks into the pillar). The sleeve's canvas
  // has the aspect of the unrolled sleeve and carries the timeline three
  // times round, so it reads undistorted from any side.
  {
    const P = PROPS.pillar;
    const H = 4.8;
    const rBottom = P.r;
    const rTop = 1.2;
    const radiusAt = (y) => rBottom + ((rTop - rBottom) * y) / H;
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(rTop, rBottom, H, 20),
      new THREE.MeshStandardMaterial({ color: 0x353b44, roughness: 0.8 })
    );
    pillar.position.set(P.x, H / 2, P.z);
    pillar.castShadow = true;
    group.add(pillar);
    tag(pillar, "plinth");

    const y0 = 0.4;
    const y1 = H;
    const sleeveH = y1 - y0;
    const r0 = radiusAt(y0) + 0.02;
    const r1 = radiusAt(y1) + 0.02;
    const around = Math.PI * (r0 + r1); // mean circumference
    const texH = 1024;
    const texW = Math.round((texH * around) / sleeveH / 3) * 3;
    const c = makeCanvas(texW, texH);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#353b44"; // the pillar's own colour: the sleeve is opaque
    ctx.fillRect(0, 0, texW, texH);
    const eras = [
      ["TRIASSIC", "252 – 201 MILLION YEARS AGO", "#e09a4a"],
      ["JURASSIC", "201 – 145 MILLION YEARS AGO", "#7bc47f"],
      ["CRETACEOUS", "145 – 66 MILLION YEARS AGO", "#ff8a5c"],
    ];
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const third = texW / 3;
    for (let k = 0; k < 3; k++) {
      const mx = third * (k + 0.5);
      ctx.fillStyle = "#ffb703";
      ctx.font = "800 96px Inter, system-ui, sans-serif";
      ctx.fillText("MESOZOIC", mx, 120);
      ctx.fillStyle = "rgba(255,246,230,0.75)";
      ctx.font = "500 30px Inter, system-ui, sans-serif";
      ctx.fillText("THE AGE OF DINOSAURS", mx, 196);
      // oldest at the bottom, like rock layers
      eras.forEach(([name, span, color], i) => {
        const top = texH - (i + 1) * 250;
        ctx.fillStyle = color;
        ctx.fillRect(mx - third * 0.36, top + 30, third * 0.72, 8);
        ctx.font = "800 64px Inter, system-ui, sans-serif";
        ctx.fillText(name, mx, top + 110);
        ctx.fillStyle = "rgba(255,246,230,0.8)";
        ctx.font = "500 28px Inter, system-ui, sans-serif";
        ctx.fillText(span, mx, top + 180);
      });
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const sleeve = new THREE.Mesh(
      new THREE.CylinderGeometry(r1, r0, sleeveH, 20, 1, true),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 })
    );
    sleeve.position.set(P.x, y0 + sleeveH / 2, P.z);
    group.add(sleeve);
    tag(sleeve, "skip");
  }

  // ---------------- structure ----------------
  const spawn = SPAWN;

  for (let i = 0; i < 9; i++) {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(48, 0.4, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.8 })
    );
    beam.position.set(0, 14.4, -24 + i * 5);
    group.add(beam);
    tag(beam, "metal", { metal: "black" });
  }

  return {
    group,
    interactables,
    exhibits,
    seats: interactables.filter((it) => it.type === "seat"),
    displays: DISPLAYS.map((d) => ({ ...d, bounds: { ...d.bounds } })),
    eras: ERAS,
    eraWindows: ERA_WINDOWS,
    animated,
    spawn,
    screen,
    screenMat,
    screenTex,
    sun,
    photos,
    presence,
  };
}

/** Draws a wayfinding arrow centred on (cx, cy), `size` tall, rotated by `angle` (0 = up). */
function drawArrow(ctx, cx, cy, size, angle, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const s = size / 2;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -s); // tip
  ctx.lineTo(s * 0.86, -s * 0.06);
  ctx.lineTo(s * 0.3, -s * 0.06);
  ctx.lineTo(s * 0.3, s);
  ctx.lineTo(-s * 0.3, s);
  ctx.lineTo(-s * 0.3, -s * 0.06);
  ctx.lineTo(-s * 0.86, -s * 0.06);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

const WAY_FONT = "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const WAY_ACCENT = "#ff8fab";

/** Fits `text` into maxW px: the largest bold size <= size. */
function fitWayFont(ctx, text, weight, size, maxW) {
  let fs = size;
  for (; fs > size * 0.5; fs -= 2) {
    ctx.font = `${weight} ${fs}px ${WAY_FONT}`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return fs;
}

/**
 * A printed directional sign: dark plate, the arrow on a pink tile on the
 * side it points to (left when it points straight on), title and route.
 */
function wayfindingTexture(s) {
  const W = 1024;
  const H = Math.round((W * s.h) / s.w);
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#0d1217";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = WAY_ACCENT;
  ctx.fillRect(0, H - 8, W, 8);
  const angle = wayArrow(s);
  const tile = Math.round(H * 0.72);
  const pad = Math.round((H - tile) / 2);
  const right = angle > 0.01;
  const tx = right ? W - pad - tile : pad;
  ctx.fillStyle = WAY_ACCENT;
  ctx.beginPath();
  ctx.moveTo(tx + 18, pad);
  ctx.arcTo(tx + tile, pad, tx + tile, pad + tile, 18);
  ctx.arcTo(tx + tile, pad + tile, tx, pad + tile, 18);
  ctx.arcTo(tx, pad + tile, tx, pad, 18);
  ctx.arcTo(tx, pad, tx + tile, pad, 18);
  ctx.closePath();
  ctx.fill();
  drawArrow(ctx, tx + tile / 2, pad + tile / 2, tile * 0.68, angle, "#1a1216");
  const textX = right ? pad * 1.6 : tx + tile + pad * 1.4;
  const textW = W - tile - pad * 4;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff6e6";
  fitWayFont(ctx, s.title, 800, Math.round(H * 0.34), textW);
  ctx.fillText(s.title, textX, H * (s.sub ? 0.4 : 0.5));
  if (s.sub) {
    ctx.fillStyle = WAY_ACCENT;
    fitWayFont(ctx, s.sub, 500, Math.round(H * 0.2), textW);
    ctx.fillText(s.sub, textX, H * 0.73);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** The backlit exit lightbox: a standard green EXIT panel with a running figure side. */
function lightboxTexture(s) {
  const W = 1024;
  const H = Math.round((W * s.h) / s.w);
  const c = makeCanvas(W, H);
  const ctx = c.getContext("2d");
  const split = Math.round(W * 0.4);
  ctx.fillStyle = "#1fae5b";
  ctx.fillRect(0, 0, split, H);
  ctx.fillStyle = "#16934c";
  ctx.fillRect(split, 0, W - split, H);
  ctx.fillStyle = "#fffdf5";
  ctx.fillRect(split - 3, 0, 6, H);
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  fitWayFont(ctx, s.title, 900, Math.round(H * 0.56), split - 60);
  ctx.fillText(s.title, split / 2, H * 0.53);
  ctx.fillStyle = "#ffffff";
  fitWayFont(ctx, s.sub, 900, Math.round(H * 0.46), W - split - 70);
  ctx.fillText(s.sub, split + (W - split) / 2, H * 0.53);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function roomNameAt(x, z) {
  const r = roomAt(x, z);
  return r ? r.name : "Outside";
}
