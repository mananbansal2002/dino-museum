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
  // The end of the tour: a bent exit passage leaves the far end of the
  // Jurassic Hall, runs down the east side of the building and turns into the
  // Ice Cream Court. Neither is visible from the entrance; both are hidden on
  // the minimap until a visitor walks in ("secret").
  { id: "xpassage", name: "Exit Passage", cols: [30, 30], rows: [18, 22], floor: 0x3a3f45, wall: 0x44494f, accent: 0xff8fab, h: 6, secret: true },
  { id: "court", name: "Ice Cream Court", cols: [24, 30], rows: [23, 28], floor: 0x5c4b3c, wall: 0x6b5947, accent: 0xff8fab, h: 10, secret: true },
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
  // roped-off plinths
  for (const o of OBSTACLES) {
    if (x < o.minX - radius || x > o.maxX + radius || z < o.minZ - radius || z > o.maxZ + radius) continue;
    const p = pushOutOfBox(x, z, radius, o.minX, o.maxX, o.minZ, o.maxZ);
    if (p) [x, z] = p;
  }
  return [x, z];
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

function bannerTexture(title, sub, accent) {
  const c = makeCanvas(1024, 512);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, "#12181d");
  g.addColorStop(1, "#1c262d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 512);
  ctx.fillStyle = accent;
  ctx.fillRect(60, 90, 14, 300);
  ctx.fillRect(950, 90, 14, 300);
  ctx.fillStyle = "#f6efe2";
  ctx.font = "800 78px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(title, 110, 205);
  ctx.fillStyle = accent;
  ctx.font = "500 36px Inter, system-ui, sans-serif";
  ctx.fillText(sub, 110, 320);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
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
  { id: "krono", x: 64, z: -60, ry: Math.PI / 2, scale: 1, pedestal: 6 },
  { id: "plesio", x: 78, z: -58, ry: 0, scale: 1, pedestal: 6 },
  { id: "deino", x: 48, z: -48, ry: -Math.PI / 2, scale: 1, pedestal: 6 },
  { id: "ichthyo", x: 58, z: -54, ry: 0, scale: 1, pedestal: 4 },
  { id: "archelon", x: 68, z: -54, ry: 0, scale: 1, pedestal: 4 },

  // ---- Grand Gallery (centre) ----
  { id: "spino", x: -16, z: -22, ry: 0, scale: 1, pedestal: 8 },
  { id: "baryonyx", x: 12, z: -24, ry: Math.PI / 2, scale: 1, pedestal: 7 },
  { id: "dilo", x: -4, z: -18, ry: 0, scale: 1, pedestal: 4 },
  { id: "raptor", x: -18, z: -8, ry: 0, scale: 1, pedestal: 2.5 },
  { id: "deinonychus", x: -10, z: -8, ry: 0, scale: 1, pedestal: 3 },
  { id: "oviraptor", x: -4, z: -8, ry: 0, scale: 1, pedestal: 2.5 },
  { id: "ptero", x: 16, z: -10, ry: 0, scale: 1, pedestal: 5 },
  { id: "dimetrodon", x: 8, z: 4, ry: 0, scale: 1, pedestal: 5 },
  { id: "utahraptor", x: -8, z: 4, ry: 0, scale: 1, pedestal: 3.5 },
  { id: "doed", x: 18, z: 5, ry: 0, scale: 1, pedestal: 5 }, // Ice Age glyptodont: not a Cretaceous animal

  // ---- Entrance Atrium ----
  { id: "quetzal", x: 14, z: 34, ry: Math.PI / 2, scale: 0.7, pedestal: 0 },
  { id: "archaeopteryx", x: -30, z: 46, ry: 0, scale: 1.5, pedestal: 2 },
  { id: "rhampho", x: -24, z: 46, ry: 0, scale: 1.5, pedestal: 2 },
];

/**
 * Every point of interest. Kept outside of buildWorld so the data can be
 * validated by scripts/check.mjs without needing a WebGL context.
 */
export const SPAWN = { x: 0, z: g2z(21.5), ry: Math.PI };

/** Ice Cream Court furniture: x 48..90, z 48..84; visitors enter at the north-east corner. */
export const COURT = { stallX: 66, stallZ: 76, exitX: 48.2, exitZ: 79 };

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
  { id: "rotunda", x: 0, z: 9.5, ry: Math.PI, looks: "the Grand Gallery" },
  { id: "cretaceous", x: -78, z: -63, ry: Math.PI, looks: "the Cretaceous Hall" },
  { id: "marine", x: 49, z: -68.8, ry: Math.PI, looks: "the Mosasaurus" },
  { id: "jurassic", x: 71.5, z: 13.6, ry: -Math.PI / 2, looks: "the long-necks" },
];

/* ------------------------------------------------------------------ */
/* exhibit panels                                                       */
/* ------------------------------------------------------------------ */

/** Depth of a panel's plinth (front to back). */
export const PANEL_DEPTH = 0.9;

/** Image panel width: bigger animals get bigger pictures (1.8 m .. 4.5 m). */
export function panelWidth(spec) {
  const len = parseFloat(spec?.info?.length) || 4;
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
  return OBSTACLES.some(hit) || DISPLAYS.some((d) => hit(d.bounds));
}

function benchSeats(b) {
  return [-0.8, 0.8].map((o, i) => ({
    id: `seat:bench:${b.id}-${i + 1}`,
    x: b.x + o * Math.cos(b.ry),
    z: b.z - o * Math.sin(b.ry),
    ry: b.ry,
  }));
}

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
        area: "bench",
        x: s.x,
        z: s.z,
        radius: 0.9,
        label: `Sit and admire ${b.looks}`,
        key: "E",
        seat: { x: s.x, y: BENCH_SEAT_Y, z: s.z, ry: s.ry },
      });
    }
  }
  for (const spot of PLACEMENTS) {
    const spec = SPECIES[spot.id];
    if (!spec) continue;
    list.push({
      id: `exhibit:${spec.id}`,
      type: "exhibit",
      x: spot.x,
      z: spot.z,
      radius: 8,
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

export function buildWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const interactables = buildInteractables();
  const dinos = []; // exhibits are image panels now; kept for main.js compatibility
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

  for (const room of ROOMS) {
    const w = (room.cols[1] - room.cols[0] + 1) * CELL;
    const d = (room.rows[1] - room.rows[0] + 1) * CELL;
    const cx = (g2w(room.cols[0]) + g2w(room.cols[1])) / 2;
    const cz = (g2z(room.rows[0]) + g2z(room.rows[1])) / 2;
    const lights = Math.max(1, Math.min(6, Math.round((w * d) / 420)));
    for (let i = 0; i < lights; i++) {
      const lx = cx + (i % 2 === 0 ? -1 : 1) * w * 0.26;
      const lz = cz + (i < 2 ? -d * 0.26 : d * 0.26);
      // mostly warm museum white with a hint of the hall's accent colour
      const tint = new THREE.Color(room.accent).lerp(new THREE.Color(0xffe2bd), 0.65);
      const pl = new THREE.PointLight(tint, 110, Math.max(w, d) * 0.95, 2);
      pl.position.set(lx, room.h - 1.8, lz);
      group.add(pl);
      const fix = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.72, 0.22, 12),
        new THREE.MeshStandardMaterial({
          color: 0x1b1f24,
          emissive: new THREE.Color(room.accent),
          emissiveIntensity: 1.8,
          roughness: 0.5,
        })
      );
      fix.position.set(lx, room.h - 0.25, lz);
      group.add(fix);
      tag(fix, "emissive");
    }
  }

  // ---------------- hanging banners ----------------
  // hung high up under the ceiling so they never block the floor or a view
  for (const room of ROOMS) {
    if (room.h <= 6 || room.id === "porch" || room.id === "theater") continue;
    const cx = (g2w(room.cols[0]) + g2w(room.cols[1])) / 2;
    const cz = (g2z(room.rows[0]) + g2z(room.rows[1])) / 2;
    const w = Math.min((room.cols[1] - room.cols[0] + 1) * CELL - 8, 9);
    const banner = new THREE.Mesh(
      new THREE.PlaneGeometry(w, w * 0.5),
      new THREE.MeshBasicMaterial({
        map: bannerTexture(
          room.name.toUpperCase(),
          room.id === "court" ? "SCOOPS & DINOSAURS" : "DINOSAUR MUSEUM",
          `#${new THREE.Color(room.accent).getHexString()}`
        ),
        side: THREE.DoubleSide,
      })
    );
    banner.position.set(cx, room.h - 0.6 - w * 0.25, cz);
    banner.rotation.y = room.id === "rotunda" ? 0 : Math.PI / 2;
    group.add(banner);
    tag(banner, "skip");
  }

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
    const destName = (to, from) => {
      if (!isPassage(to)) return to.name;
      const beyond = [...neighboursOf(to)].filter((r) => r !== from && !isPassage(r));
      const name = beyond.length ? beyond.map((r) => r.name).join(" · ") : to.name;
      return to.id === "xpassage" && from.id !== "court" ? `Exit · ${name}` : name;
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
        const text = destName(to, from).toUpperCase();
        const sign = new THREE.Mesh(
          new THREE.PlaneGeometry(width, 0.85),
          new THREE.MeshBasicMaterial({
            map: makeTextTexture(text, {
              width: 1024,
              height: 110,
              fontSize: text.length > 24 ? 44 : 60,
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

  function addPlacard(x, y, z, ry, title, sub) {
    const p = makePlacard(title, sub);
    p.position.set(x, y, z);
    p.rotation.y = ry;
    group.add(p);
    tag(p, "skip");
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

  // ---------------- mounted skeletons ----------------
  // The information placard always ends up on walkable floor: we try the
  // spots around the mount and keep the first one that is inside the hall.
  function placardSpot(spot) {
    const ry = spot.ry || 0;
    const fx = Math.sin(ry);
    const fz = Math.cos(ry);
    const rx = Math.cos(ry);
    const rz = -Math.sin(ry);
    const reach = (spot.pedestal || 0) / 2 + 1.7;
    const candidates = [
      [fx * 2.6 + rx * reach, fz * 2.6 + rz * reach, 0.6],
      [fx * 2.6 - rx * reach, fz * 2.6 - rz * reach, -0.6],
      [fx * (reach + 1.4), fz * (reach + 1.4), 0],
      [-fx * 2.6 + rx * reach, -fz * 2.6 + rz * reach, Math.PI - 0.6],
      [-fx * 2.6 - rx * reach, -fz * 2.6 - rz * reach, Math.PI + 0.6],
      [0, 0, 0],
    ];
    for (const [ox, oz, rot] of candidates) {
      const px = spot.x + ox;
      const pz = spot.z + oz;
      const clear =
        roomAt(px, pz) && roomAt(px + 1, pz) && roomAt(px - 1, pz) &&
        roomAt(px, pz + 1) && roomAt(px, pz - 1) && !insideObstacle(px, pz, 0.8);
      if (clear) return { px, pz, rot };
    }
    return { px: spot.x, pz: spot.z, rot: 0 };
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
  const unitPlane = new THREE.PlaneGeometry(1, 1);
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2118, roughness: 0.55, metalness: 0.25 });
  const plinthMat = new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.8 });
  const loader = new THREE.TextureLoader();
  const PANEL_BOTTOM = DISPLAY_PANEL_BOTTOM;
  const PANEL_MAX_H = 3.4;
  const captions = [];

  function placeholderTexture(spec, accent) {
    const c = makeCanvas(768, 512);
    const ctx = c.getContext("2d");
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

  for (const panel of EXHIBIT_PANELS) {
    const spec = SPECIES[panel.id];
    if (!spec) continue;
    const room = roomAt(panel.x, panel.z);
    const accent = `#${new THREE.Color(room ? room.accent : 0xffc857).getHexString()}`;
    const g = new THREE.Group();
    g.position.set(panel.x, 0, panel.z);
    g.rotation.y = panel.face;
    group.add(g);

    const plinth = new THREE.Mesh(unitBox, plinthMat);
    plinth.scale.set(panel.w + 0.3, 0.8, PANEL_DEPTH);
    plinth.position.y = 0.4;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    g.add(plinth);
    tag(plinth, "plinth");
    const brass = new THREE.Mesh(unitBox, brassMat);
    brass.scale.set(panel.w + 0.4, 0.06, PANEL_DEPTH + 0.1);
    brass.position.y = 0.8;
    g.add(brass);
    tag(brass, "metal", { metal: "brass" });

    const imageMat = new THREE.MeshBasicMaterial({ map: placeholderTexture(spec, accent) });
    const frame = new THREE.Mesh(unitBox, frameMat);
    const front = new THREE.Mesh(unitPlane, imageMat);
    const back = new THREE.Mesh(unitPlane, imageMat);
    back.rotation.y = Math.PI;
    g.add(frame, front, back);
    tag(frame, "wood");
    tag(front, "image");
    tag(back, "image");
    // backboard lifting the picture above a fossil model standing in front
    const backboard = new THREE.Mesh(unitBox, frameMat);
    g.add(backboard);
    tag(backboard, "wood");

    const layout = (aspect) => {
      let w = panel.w;
      let h = w / aspect;
      if (h > PANEL_MAX_H) {
        h = PANEL_MAX_H;
        w = h * aspect;
      }
      const y = PANEL_BOTTOM + h / 2;
      frame.scale.set(w + 0.22, h + 0.22, 0.1);
      frame.position.y = y;
      front.scale.set(w, h, 1);
      front.position.set(0, y, 0.052);
      back.scale.set(w, h, 1);
      back.position.set(0, y, -0.052);
      backboard.scale.set(w + 0.22, PANEL_BOTTOM - 0.8 + 0.05, 0.09);
      backboard.position.set(0, 0.8 + (PANEL_BOTTOM - 0.8) / 2, 0);
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
    // model up to DISPLAY_MAX_H standing in front)
    const capW = Math.min(panel.w, 2.4);
    const capMat = new THREE.MeshBasicMaterial({ map: capTex });
    for (const side of [1, -1]) {
      const cap = new THREE.Mesh(unitPlane, capMat);
      cap.scale.set(capW, capW * (220 / 1024), 1);
      cap.position.set(0, PANEL_BOTTOM - 0.33, side * 0.055);
      if (side < 0) cap.rotation.y = Math.PI;
      g.add(cap);
      tag(cap, "skip");
    }

    const { px, pz, rot } = placardSpot({ x: panel.x, z: panel.z, ry: panel.face, pedestal: panel.w });
    const placard = addPlacard(px, 1.5, pz, rot, spec.name, spec.info.era);

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

    caption.load = (url) => {
      entry.image = url;
      loader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 4;
          const img = tex.image;
          const aspect = img && img.width && img.height ? img.width / img.height : 3 / 2;
          imageMat.map.dispose();
          imageMat.map = tex;
          imageMat.needsUpdate = true;
          layout(aspect);
        },
        undefined,
        () => {
          /* keep the name card */
        }
      );
    };

    // warm museum "spotlight": a pool of light on the floor, a soft beam and
    // a fixture overhead. Faked with additive meshes so 50+ exhibits cost no
    // real lights (swiftshader stays fast).
    const ceiling = room ? room.h : 10;
    const reach = Math.max(2.4, panel.w * 0.75);
    const pool = new THREE.Mesh(spotPoolGeo, spotPoolMat);
    pool.scale.set(reach, reach, 1);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(panel.x, 0.03, panel.z);
    group.add(pool);
    tag(pool, "skip");
    const beamH = ceiling - 0.4;
    const beam = new THREE.Mesh(spotBeamGeo, spotBeamMat);
    beam.scale.set(reach, beamH, reach);
    beam.position.set(panel.x, beamH / 2, panel.z);
    group.add(beam);
    tag(beam, "skip");
    const fixture = new THREE.Mesh(spotFixtureGeo, spotFixtureMat);
    fixture.position.set(panel.x, ceiling - 0.2, panel.z);
    group.add(fixture);
    tag(fixture, "emissive");
  }

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
          caption.load(`/images/species/${file}`);
          if (!m.credit) continue;
          caption.credit = `Image: ${m.credit}${m.license ? ` · ${m.license}` : ""}`;
          drawCaption(caption);
        }
      })
      .catch(() => {
        /* no credits available */
      });
  }

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
  const screenTex = new THREE.CanvasTexture(makeCanvas(64, 32));
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
    new THREE.BoxGeometry(2.2, 1.1, 1),
    new THREE.MeshStandardMaterial({ color: 0x20262e, roughness: 0.6, metalness: 0.4 })
  );
  console_.position.set(0, 0.55, -51.6);
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
  const desk = new THREE.Mesh(new THREE.BoxGeometry(8, 1.1, 2.2), pedestalMat);
  desk.position.set(-16, 0.55, 52);
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

  for (const [x, z, ry] of [
    [-6, 38, 0],
    [6, 38, Math.PI],
    [-26, 50, Math.PI / 2],
  ]) {
    addBench(x, z, ry);
  }
  // benches in front of the big centrepieces (each holds two "seat" spots)
  for (const b of BENCHES) addBench(b.x, b.z, b.ry);
  addPlanter(-30, 44);
  addPlanter(30, 44);
  addPlanter(-36, 50);
  addPlanter(36, 50);

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

  const table = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.25, 3.2), pedestalMat);
  table.position.set(-78, 1.0, 34);
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
    new THREE.ConeGeometry(4.6, 5.8, 16),
    new THREE.MeshStandardMaterial({ color: 0x3b2b22, roughness: 1 })
  );
  volcano.position.set(54, 2.9, 36);
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
  lava.position.set(54, 5.6, 36);
  group.add(lava);
  tag(lava, "emissive");
  animated.push({ type: "lava", mesh: lava, base: 2.2 });

  // ---------------- exit passage ----------------
  // the way out leaves the far (east) wall of the Jurassic Hall
  const bendSign = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 1.5),
    new THREE.MeshBasicMaterial({
      map: makeTextTexture("ICE CREAM  →", {
        width: 768, height: 250, fontSize: 92, color: "#ff8fab", bg: "#1a1216",
      }),
    })
  );
  bendSign.position.set(g2w(30) + CELL / 2 - 0.25, 3.2, (g2z(18) + g2z(19)) / 2);
  bendSign.rotation.y = -Math.PI / 2;
  group.add(bendSign);
  tag(bendSign, "skip");

  // ---------------- ice cream court ----------------
  const stallX = COURT.stallX;
  const stallZ = COURT.stallZ;
  const counter = new THREE.Mesh(
    new THREE.BoxGeometry(11, 1.2, 2.6),
    new THREE.MeshStandardMaterial({ color: 0xf2f0e6, roughness: 0.7 })
  );
  counter.position.set(stallX, 0.6, stallZ);
  counter.castShadow = true;
  group.add(counter);
  tag(counter, "plinth");
  const counterTop = new THREE.Mesh(
    new THREE.BoxGeometry(11.4, 0.16, 3),
    new THREE.MeshStandardMaterial({ color: 0xff8fab, roughness: 0.5 })
  );
  counterTop.position.set(stallX, 1.28, stallZ);
  group.add(counterTop);
  tag(counterTop, "plinth");
  // striped awning
  for (let i = 0; i < 8; i++) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(11.6 / 8, 0.3, 3.6),
      new THREE.MeshStandardMaterial({ color: i % 2 ? 0xfff3e0 : 0xff8fab, roughness: 0.6 })
    );
    stripe.position.set(stallX - 5.8 + (i + 0.5) * (11.6 / 8), 4.6, stallZ);
    stripe.rotation.x = 0.12;
    group.add(stripe);
    tag(stripe, "fabric");
  }
  for (const sx of [-5.4, 5.4]) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.13, 4.6, 8),
      new THREE.MeshStandardMaterial({ color: 0xd8d3c4, roughness: 0.6 })
    );
    pole.position.set(stallX + sx, 2.3, stallZ - 1.2);
    group.add(pole);
    tag(pole, "metal", { metal: "steel" });
  }
  // tubs of ice cream in the counter
  const tubColors = [0xff9aa2, 0x9be7c4, 0x8b5a3c, 0xff6b3d, 0x7aa8ff, 0xe0a96d, 0x9fd36b, 0xfff1d0];
  tubColors.forEach((c, i) => {
    const tub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.42, 0.42, 0.2, 14),
      new THREE.MeshStandardMaterial({ color: c, roughness: 0.6 })
    );
    tub.position.set(stallX - 4.2 + i * 1.2, 1.42, stallZ - 0.3);
    group.add(tub);
    tag(tub, "skip");
  });
  const stallSign = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 2),
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
  stallSign.position.set(stallX, 5.9, stallZ - 1.6);
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
  const board = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.8), new THREE.MeshBasicMaterial({ map: boardTex }));
  board.position.set(stallX + 9, 2.4, stallZ - 2);
  board.rotation.y = Math.PI - 0.35;
  group.add(board);
  tag(board, "skip");
  const boardPost = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.2, 8), brassMat);
  boardPost.position.set(stallX + 9, 0.6, stallZ - 1.95);
  group.add(boardPost);
  tag(boardPost, "metal", { metal: "brass" });

  const statueCone = new THREE.Mesh(
    new THREE.ConeGeometry(1.7, 3.8, 20),
    new THREE.MeshStandardMaterial({ color: 0xd9a05b, roughness: 0.85 })
  );
  statueCone.position.set(62, 1.9, 60);
  statueCone.rotation.x = Math.PI;
  statueCone.castShadow = true;
  group.add(statueCone);
  tag(statueCone, "skip");
  const scoop = new THREE.Mesh(
    new THREE.SphereGeometry(1.8, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0xff9aa2, roughness: 0.7 })
  );
  scoop.position.set(62, 4.6, 60);
  scoop.castShadow = true;
  group.add(scoop);
  tag(scoop, "skip");

  for (const [x, z] of [
    [76, 58],
    [80, 66],
    [56, 70],
    [72, 66],
  ]) {
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
  addPlanter(52, 52);
  addPlanter(86, 81);
  addPlanter(52, 66);

  // string lights criss-crossing the court
  const bulbColors = [0xff8fab, 0xffe066, 0x7ee081, 0x7ad7f0];
  const bulbs = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.16, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    3 * 18
  );
  let bi = 0;
  const bulbCol = new THREE.Color();
  for (const [z0, z1] of [[52, 80], [80, 52], [66, 66]]) {
    for (let i = 0; i < 18; i++) {
      const t = i / 17;
      seatDummy.position.set(50 + t * 38, 8.2 - Math.sin(t * Math.PI) * 1.2, z0 + (z1 - z0) * t);
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
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.45, 4.8, 20),
    new THREE.MeshStandardMaterial({ color: 0x353b44, roughness: 0.8 })
  );
  pillar.position.set(-16, 2.4, 8);
  pillar.castShadow = true;
  group.add(pillar);
  tag(pillar, "plinth");
  const eraPlane = new THREE.Mesh(
    new THREE.CylinderGeometry(1.26, 1.26, 4.4, 20, 1, true),
    new THREE.MeshStandardMaterial({
      map: makeTextTexture("MESOZOIC", {
        width: 512,
        height: 1024,
        fontSize: 64,
        color: "#ffb703",
        sub: "TRIASSIC · JURASSIC · CRETACEOUS",
        subSize: 24,
      }),
      side: THREE.DoubleSide,
      roughness: 0.8,
    })
  );
  eraPlane.position.set(-16, 2.6, 8);
  group.add(eraPlane);
  tag(eraPlane, "skip");

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
    dinos,
    animated,
    spawn,
    screen,
    screenMat,
    screenTex,
    sun,
  };
}

export function roomNameAt(x, z) {
  const r = roomAt(x, z);
  return r ? r.name : "Outside";
}
