import * as THREE from "three";
import { createDino } from "./dinos.js";
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
  { id: "theater", name: "Screening Theatre", cols: [11, 20], rows: [1, 6], floor: 0x1b2431, wall: 0x24303f, accent: 0x59d4e6, h: 10 },
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
  { id: "xpassage", name: "Exit Passage", cols: [23, 23], rows: [20, 23], floor: 0x3a3f45, wall: 0x44494f, accent: 0xff8fab, h: 5 },
  { id: "court", name: "Ice Cream Court", cols: [24, 29], rows: [22, 27], floor: 0x5c4b3c, wall: 0x6b5947, accent: 0xff8fab, h: 10 },
];

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
  "h:22,20", "h:22,21", "h:22,22", "h:22,23", // lobby -> exit passage
  "h:23,22", "h:23,23", // exit passage -> ice cream court
]);

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

/** Circle vs solid cells collision resolve. Returns corrected [x, z]. */
export function resolveCollision(x, z, radius) {
  const c0 = w2g(x - radius);
  const c1 = w2g(x + radius);
  const r0 = w2gz(z - radius);
  const r1 = w2gz(z + radius);
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      if (!isSolid(c, r)) continue;
      const minX = g2w(c) - CELL / 2;
      const maxX = minX + CELL;
      const minZ = g2z(r) - CELL / 2;
      const maxZ = minZ + CELL;
      const cx = Math.max(minX, Math.min(x, maxX));
      const cz = Math.max(minZ, Math.min(z, maxZ));
      const dx = x - cx;
      const dz = z - cz;
      const dist2 = dx * dx + dz * dz;
      if (dist2 < radius * radius) {
        const dist = Math.sqrt(dist2) || 0.0001;
        const push = radius - dist;
        x += (dx / dist) * push;
        z += (dz / dist) * push;
      }
    }
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

function tileTexture(color, tile = 64, contrast = 0.08) {
  const c = makeCanvas(128, 128);
  const ctx = c.getContext("2d");
  ctx.fillStyle = `#${new THREE.Color(color).getHexString()}`;
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = `rgba(0,0,0,${contrast + 0.06})`;
  ctx.lineWidth = 2;
  for (let i = 0; i <= 128; i += tile) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, 128);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(128, i);
    ctx.stroke();
  }
  ctx.fillStyle = `rgba(255,255,255,${contrast * 0.5})`;
  for (let x = 0; x < 128; x += tile) {
    for (let y = 0; y < 128; y += tile) {
      ctx.fillRect(x + 1, y + 1, tile - 2, tile - 2);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
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
  { id: "doed", x: -57, z: -47, ry: 0, scale: 1, pedestal: 5 },
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
  { id: "apo", x: 78, z: 22, ry: 0, scale: 0.6, pedestal: 6 },
  { id: "kentrosaurus", x: 66, z: 29.5, ry: 0, scale: 1, pedestal: 5 },
  { id: "wuerho", x: 78, z: 35, ry: 0, scale: 1, pedestal: 4 },

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

export function buildInteractables() {
  const list = [];
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
  list.push(
    {
      id: "holo:trex",
      type: "holo",
      x: 0,
      z: -4,
      radius: 7,
      label: "Holographic T-Rex — press V to make it roar",
      key: "V",
      exhibitId: "trex",
    },
    {
      id: "holo:mosa",
      type: "holo",
      x: 39,
      z: -60,
      radius: 7,
      label: "Holographic Mosasaurus — press V to make it roar",
      key: "V",
      exhibitId: "mosa",
    },
    {
      id: "theatre:screen",
      type: "battle",
      x: 0,
      z: g2z(2.4) + 8,
      radius: 10,
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
      x: 66,
      z: 48,
      radius: 8,
      label: "Order an ice cream",
      key: "E",
    },
    {
      id: "exit",
      type: "exit",
      x: 40,
      z: 39,
      radius: 5,
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
  porch: "Entrance Plaza",
};

export function buildWorld(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const interactables = buildInteractables();
  const dinos = [];
  const animated = [];

  // ---------------- floors & ceilings ----------------
  for (const room of ROOMS) {
    const w = (room.cols[1] - room.cols[0] + 1) * CELL;
    const d = (room.rows[1] - room.rows[0] + 1) * CELL;
    const cx = (g2w(room.cols[0]) + g2w(room.cols[1])) / 2;
    const cz = (g2z(room.rows[0]) + g2z(room.rows[1])) / 2;
    const tex = tileTexture(room.floor, 64, 0.05);
    tex.repeat.set(w / 3, d / 3);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0.02 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, cz);
    floor.receiveShadow = true;
    group.add(floor);

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
      const pl = new THREE.PointLight(room.accent, 90, Math.max(w, d) * 0.95, 2);
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
    }
  }

  // ---------------- hanging banners ----------------
  for (const room of ROOMS) {
    if (room.id.includes("corridor") || room.id.includes("link") || room.id === "porch") continue;
    const cx = (g2w(room.cols[0]) + g2w(room.cols[1])) / 2;
    const cz = (g2z(room.rows[0]) + g2z(room.rows[1])) / 2;
    const w = Math.min((room.cols[1] - room.cols[0] + 1) * CELL - 8, 26);
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
    banner.position.set(cx, Math.min(room.h - 2.6, 7.4), cz);
    banner.rotation.y = room.id === "rotunda" ? 0 : Math.PI / 2;
    group.add(banner);
  }

  // ---------------- shared props ----------------
  const pedestalMat = new THREE.MeshStandardMaterial({ color: 0x2e333a, roughness: 0.8 });
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xc9a227,
    roughness: 0.35,
    metalness: 0.85,
  });

  function addPedestal(x, z, w = 4, h = 0.9) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), pedestalMat);
    base.position.set(x, h / 2, z);
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.12, w + 0.2), brassMat);
    edge.position.set(x, h - 0.02, z);
    group.add(edge);
  }

  function addPlacard(x, y, z, ry, title, sub) {
    const p = makePlacard(title, sub);
    p.position.set(x, y, z);
    p.rotation.y = ry;
    group.add(p);
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, Math.max(0.2, y - 0.5), 8),
      brassMat
    );
    post.position.set(x, (y - 0.5) / 2, z);
    group.add(post);
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
    }
    g.position.set(x, 0, z);
    g.rotation.y = ry;
    group.add(g);
  }

  function addPlanter(x, z) {
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.55, 0.9, 12),
      new THREE.MeshStandardMaterial({ color: 0x7a6a58, roughness: 0.9 })
    );
    pot.position.set(x, 0.45, z);
    pot.castShadow = true;
    group.add(pot);
    for (let i = 0; i < 7; i++) {
      const leaf = new THREE.Mesh(
        new THREE.ConeGeometry(0.22, 1.7 + rand(-0.3, 0.6), 5),
        new THREE.MeshStandardMaterial({ color: 0x3f7a45, roughness: 0.9 })
      );
      leaf.position.set(x + rand(-0.35, 0.35), 1.5 + rand(0, 0.5), z + rand(-0.35, 0.35));
      leaf.rotation.set(rand(-0.3, 0.3), rand(0, 3), rand(-0.3, 0.3));
      leaf.castShadow = true;
      group.add(leaf);
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
        roomAt(px, pz + 1) && roomAt(px, pz - 1);
      if (clear) return { px, pz, rot };
    }
    return { px: spot.x, pz: spot.z, rot: 0 };
  }

  for (const spot of PLACEMENTS) {
    const spec = SPECIES[spot.id];
    if (!spec) continue;
    if (spot.pedestal) addPedestal(spot.x, spot.z, spot.pedestal, 0.9);
    const dino = createDino(spec, { skeleton: true, scale: spot.scale || 1 });
    dino.group.position.set(spot.x, spot.pedestal ? 0.95 : 0, spot.z);
    dino.group.rotation.y = spot.ry || 0;
    group.add(dino.group);
    dinos.push(dino);
    animated.push({ dino, speed: 0, anim: "idle" });

    const { px, pz, rot } = placardSpot(spot);
    addPlacard(px, 1.5, pz, rot, spec.name, spec.info.era);
  }

  // ---------------- holograms ----------------
  function holoify(dino, tint = 0x59e0ff) {
    const holoMat = new THREE.MeshStandardMaterial({
      color: tint,
      emissive: tint,
      emissiveIntensity: 1.0,
      transparent: true,
      opacity: 0.34,
      roughness: 0.3,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    dino.group.traverse((o) => {
      if (o.isMesh) {
        o.material = holoMat;
        o.castShadow = false;
      }
    });
    return dino;
  }

  const holoTrex = holoify(createDino(SPECIES.trex, { scale: 1.05 }));
  holoTrex.group.position.set(0, 0.2, -4);
  holoTrex.group.rotation.y = Math.PI;
  group.add(holoTrex.group);
  animated.push({ dino: holoTrex, speed: 0, anim: "idle", holo: true });

  const holoMosa = holoify(createDino(SPECIES.mosa, { scale: 0.6 }), 0x4fc3f7);
  holoMosa.group.position.set(39, 0.2, -60);
  holoMosa.group.rotation.y = 0;
  group.add(holoMosa.group);
  animated.push({ dino: holoMosa, speed: 0, anim: "idle", holo: true });

  // ---------------- theatre ----------------
  const screenW = 30;
  const screenH = 15;
  const screenTex = new THREE.CanvasTexture(makeCanvas(64, 32));
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenH), screenMat);
  screen.position.set(0, 5.6, g2z(1) + 0.6);
  group.add(screen);
  const screenFrame = new THREE.Mesh(
    new THREE.BoxGeometry(screenW + 1.4, screenH + 1.4, 0.5),
    new THREE.MeshStandardMaterial({ color: 0x15181d, roughness: 0.7 })
  );
  screenFrame.position.set(0, 5.6, g2z(1) + 0.3);
  group.add(screenFrame);

  const seatMat = new THREE.MeshStandardMaterial({ color: 0x5c1f2b, roughness: 0.9 });
  for (let row = 0; row < 5; row++) {
    for (let i = 0; i < 13; i++) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.5, 0.95), seatMat);
      seat.position.set((i - 6) * 1.5, 0.45, g2z(2.4) + row * 1.8);
      seat.castShadow = true;
      group.add(seat);
      const backRest = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.85, 0.18), seatMat);
      backRest.position.set((i - 6) * 1.5, 0.9, g2z(2.4) + row * 1.8 - 0.45);
      group.add(backRest);
    }
  }


  // ---------------- atrium ----------------
  const desk = new THREE.Mesh(new THREE.BoxGeometry(8, 1.1, 2.2), pedestalMat);
  desk.position.set(-16, 0.55, 52);
  desk.castShadow = true;
  group.add(desk);
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

  for (const [x, z, ry] of [
    [-6, 38, 0],
    [6, 38, Math.PI],
    [-26, 50, Math.PI / 2],
  ]) {
    addBench(x, z, ry);
  }
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
  for (let i = 0; i < 10; i++) {
    const bone = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.16, 1.6, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0xe4d5b4, roughness: 0.75 })
    );
    bone.position.set(-66 + rand(-2.4, 2.4), 0.4, 34 + rand(-2.4, 2.4));
    bone.rotation.set(rand(-0.4, 0.4), rand(0, 3), rand(-0.5, 0.5));
    group.add(bone);
  }

  const table = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.25, 3.2), pedestalMat);
  table.position.set(-78, 1.0, 34);
  group.add(table);
  for (const sx of [-2.3, 2.3]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1, 2.8), pedestalMat);
    leg.position.set(-78 + sx, 0.5, 34);
    group.add(leg);
  }
  for (let i = 0; i < 8; i++) {
    const b = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.14, 1.1, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0xe4d5b4, roughness: 0.75 })
    );
    b.position.set(-78 + rand(-2.2, 2.2), 1.25, 34 + rand(-1.2, 1.2));
    b.rotation.set(rand(-0.3, 0.3), rand(0, 3), Math.PI / 2);
    group.add(b);
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
  animated.push({ type: "lava", mesh: lava, base: 2.2 });

  // ---------------- ice cream court ----------------
  const stallZ = 52;
  const counter = new THREE.Mesh(
    new THREE.BoxGeometry(11, 1.2, 2.6),
    new THREE.MeshStandardMaterial({ color: 0xf2f0e6, roughness: 0.7 })
  );
  counter.position.set(66, 0.6, stallZ);
  counter.castShadow = true;
  group.add(counter);
  const counterTop = new THREE.Mesh(
    new THREE.BoxGeometry(11.4, 0.16, 3),
    new THREE.MeshStandardMaterial({ color: 0xff8fab, roughness: 0.5 })
  );
  counterTop.position.set(66, 1.28, stallZ);
  group.add(counterTop);
  const canopy = new THREE.Mesh(
    new THREE.BoxGeometry(11.6, 0.3, 3.4),
    new THREE.MeshStandardMaterial({ color: 0xffe066, roughness: 0.6 })
  );
  canopy.position.set(66, 4.4, stallZ);
  group.add(canopy);
  for (const sx of [-5, 5]) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.13, 4.4, 8),
      new THREE.MeshStandardMaterial({ color: 0xd8d3c4, roughness: 0.6 })
    );
    pole.position.set(66 + sx, 2.2, stallZ);
    group.add(pole);
  }
  const stallSign = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 2),
    new THREE.MeshBasicMaterial({
      map: makeTextTexture("PREHISTORIC SCOOP", {
        width: 1024,
        height: 220,
        fontSize: 66,
        color: "#ff8fab",
        sub: "8 FLAVOURS · CONES & CUPS",
        subSize: 34,
      }),
      side: THREE.DoubleSide,
    })
  );
  stallSign.position.set(66, 4.2, stallZ + 1.9);
  stallSign.rotation.y = Math.PI;
  group.add(stallSign);

  const flavours = [
    "Strawberry", "Mint Choco", "Dino Dust", "Volcano Chilli",
    "Blueberry", "Salted Caramel", "Matcha", "Extinction Vanilla",
  ];
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(7.4, 2.6),
    new THREE.MeshBasicMaterial({
      map: makeTextTexture("FLAVOURS", {
        width: 1024,
        height: 360,
        fontSize: 52,
        color: "#ffe066",
        sub: flavours.slice(0, 4).join(" · "),
        subSize: 24,
      }),
      side: THREE.DoubleSide,
    })
  );
  board.position.set(66, 2.4, stallZ + 1.4);
  board.rotation.y = Math.PI;
  group.add(board);

  const statueCone = new THREE.Mesh(
    new THREE.ConeGeometry(1.7, 3.8, 20),
    new THREE.MeshStandardMaterial({ color: 0xd9a05b, roughness: 0.85 })
  );
  statueCone.position.set(66, 1.9, g2z(26));
  statueCone.castShadow = true;
  group.add(statueCone);
  const scoop = new THREE.Mesh(
    new THREE.SphereGeometry(1.7, 20, 14),
    new THREE.MeshStandardMaterial({ color: 0xff9aa2, roughness: 0.7 })
  );
  scoop.position.set(66, 3.9, g2z(26));
  scoop.castShadow = true;
  group.add(scoop);

  for (const [x, z] of [
    [80, g2z(24)],
    [60, g2z(26)],
    [80, g2z(27)],
  ]) {
    const t = new THREE.Mesh(
      new THREE.CylinderGeometry(1.3, 0.35, 0.16, 14),
      new THREE.MeshStandardMaterial({ color: 0xe8e3d5, roughness: 0.7 })
    );
    t.position.set(x, 0.9, z);
    group.add(t);
    const leg = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 0.9, 8),
      new THREE.MeshStandardMaterial({ color: 0x8b8b8b, roughness: 0.6 })
    );
    leg.position.set(x, 0.45, z);
    group.add(leg);
  }
  addPlanter(82, stallZ);
  addPlanter(58, stallZ);


  const arch = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 2.4),
    new THREE.MeshBasicMaterial({
      map: makeTextTexture("EXIT · ICE CREAM COURT", {
        width: 1024,
        height: 320,
        fontSize: 58,
        color: "#7ee081",
      }),
      side: THREE.DoubleSide,
    })
  );
  arch.position.set(g2w(22) + 1.4, 3.4, g2z(21));
  arch.rotation.y = Math.PI / 2;
  group.add(arch);

  // ---------------- timeline pillar ----------------
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.45, 4.8, 20),
    new THREE.MeshStandardMaterial({ color: 0x353b44, roughness: 0.8 })
  );
  pillar.position.set(-16, 2.4, 8);
  pillar.castShadow = true;
  group.add(pillar);
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

  // ---------------- structure ----------------
  const spawn = SPAWN;

  for (let i = 0; i < 9; i++) {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(48, 0.4, 0.6),
      new THREE.MeshStandardMaterial({ color: 0x22262c, roughness: 0.8 })
    );
    beam.position.set(0, 14.4, -24 + i * 5);
    group.add(beam);
  }

  return {
    group,
    interactables,
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
