/**
 * Life-size scale: a brass measuring tape inlaid in the floor in front of
 * every exhibit, and a "you vs the animal" silhouette strip for its card.
 *
 *   const tapes = buildScaleTapes(group, world, SPECIES, { scene });
 *   tapes.list                 // [{ id, name, room, length, shown, truncated, wingspan, side, path, boxes }]
 *   tapes.skipped              // [{ id, why }]
 *   tapes.measureAt(x, z)      // { id, name, metres, length } when standing on a tape, else null
 *   tapes.dispose();
 *
 *   card.innerHTML += renderScaleHtml(ex, { shirt: "#3aa0ff", compareWith: "trex" });
 *
 * Floor tapes
 * - One 12 cm brass strip per exhibit, laid flat (no collider, nothing to
 *   trip on), starting at the picture panel's edge and as long as the animal
 *   (the upper bound of its info.length; "up to 7 m wingspan" -> 7 m).
 * - A dark engraved tick every metre (longer every 5 m), brass numerals
 *   beside it and an engraved brass plate at the far end: "12–13 m ·
 *   TYRANNOSAURUS REX · NOSE TO TAIL".
 * - The route is searched, not hard-coded: in front of (or behind) the
 *   panel, either direction, folding at up to two right angles to stay in
 *   the hall. It keeps clear of walls, doorways, plinths, display cases,
 *   live-model stands, furniture (a scan of the scene) and the other tapes.
 *   If even the best route is too short the tape stops early and its plate
 *   says how long the animal really was.
 * - 4 draw calls in all (strip + plates, ticks, numerals, plate engraving).
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as WORLD from "./world.js";
import { SPECIES as CATALOGUE } from "./species.js";

/* ------------------------------------------------------------------ */
/* lengths                                                              */
/* ------------------------------------------------------------------ */

/**
 * "12–13 m" -> { m: 13, min: 12, wingspan: false, label: "12–13 m" }
 * "~10 m" -> { m: 10, min: 10, ... }, "up to 7 m wingspan" -> { m: 7, wingspan: true, label: "7 m" }
 * null when the string holds no number.
 */
export function parseLength(str) {
  const s = String(str ?? "");
  const nums = [...s.matchAll(/\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0])).filter((n) => n > 0);
  if (!nums.length) return null;
  const label = s
    .replace(/wing\s*span/i, "")
    .replace(/up to/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    m: Math.max(...nums),
    min: Math.min(...nums),
    wingspan: /wing\s*span/i.test(s),
    approx: /~|c\.|about|up to/i.test(s),
    label,
  };
}

const fmtM = (m) => (Math.abs(m - Math.round(m)) < 0.05 ? String(Math.round(m)) : m.toFixed(1));

/* ------------------------------------------------------------------ */
/* floor tapes                                                          */
/* ------------------------------------------------------------------ */

const HW = 0.06; // half the strip width (12 cm strip)
const LANE = 0.36; // half-width of floor the tape needs (ticks + numerals)
const CLEAR = 0.3; // lane to plinths, cases, furniture
const WALL_CLEAR = 0.7; // lane edge to a wall
const DOOR_DEPTH = 1.8; // keep this far out of every doorway, both sides
const TAPE_CLEAR = 0.45; // between two tapes
const PLATE_L = 1.15; // end plate, along the tape
const PLATE_W = 0.3;
const PLATE_GAP = 0.12;
const PLATE_EXT = PLATE_GAP + PLATE_L + 0.05; // floor the plate needs past the end
const MIN_SHOWN = 2.5; // shorter than this and the tape is left out
const MIN_LEG = 1.4; // shortest leg between two folds
const OFFSETS = [1.15, 1.5, 1.95, 2.5, 3.1, 3.8]; // tape line from the panel centre
const STRIP_Y = 0.0045; // strip box height (sits on the floor)
const TICK_Y = 0.0062; // ticks stand just proud of the strip
const DECAL_Y = 0.0075; // numerals / plate engraving

const IGNORE_SURF = new Set(["floor", "ceiling", "wall"]);

function boxGap(a, b) {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dz = Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ);
  return Math.hypot(dx, dz);
}

function grow(b, m) {
  return { minX: b.minX - m, maxX: b.maxX + m, minZ: b.minZ - m, maxZ: b.maxZ + m };
}

function roomBox(room) {
  return {
    minX: WORLD.g2w(room.cols[0]) - WORLD.CELL / 2,
    maxX: WORLD.g2w(room.cols[1]) + WORLD.CELL / 2,
    minZ: WORLD.g2z(room.rows[0]) - WORLD.CELL / 2,
    maxZ: WORLD.g2z(room.rows[1]) + WORLD.CELL / 2,
  };
}

/** A box straddling every doorway in OPEN, DOOR_DEPTH into both rooms. */
function doorBoxes() {
  const out = [];
  for (const key of WORLD.OPEN || []) {
    const [kind, rest] = key.split(":");
    const [c, r] = rest.split(",").map(Number);
    if (kind === "v") {
      const z = WORLD.g2z(r) + WORLD.CELL / 2;
      const x = WORLD.g2w(c);
      out.push({ minX: x - WORLD.CELL / 2, maxX: x + WORLD.CELL / 2, minZ: z - DOOR_DEPTH, maxZ: z + DOOR_DEPTH, why: "doorway" });
    } else {
      const x = WORLD.g2w(c) + WORLD.CELL / 2;
      const z = WORLD.g2z(r);
      out.push({ minX: x - DOOR_DEPTH, maxX: x + DOOR_DEPTH, minZ: z - WORLD.CELL / 2, maxZ: z + WORLD.CELL / 2, why: "doorway" });
    }
  }
  return out;
}

/** Everything standing on the floor in the scene: plinths, benches, cases, statues, planters... */
function sceneBlockers(roots, skip) {
  const out = [];
  const b = new THREE.Box3();
  const m4 = new THREE.Matrix4();
  const surfaceOf = (o) => {
    for (let n = o; n; n = n.parent) if (n.userData?.surface && n.userData.surface !== "skip") return n.userData.surface;
    return null;
  };
  const shown = (o) => {
    for (let n = o; n; n = n.parent) if (!n.visible) return false;
    return true;
  };
  const push = (box, o) => {
    if (box.isEmpty() || box.min.y > 0.6 || box.max.y < 0.02) return; // hung up high, or a floor decal
    if (box.max.x - box.min.x > 30 || box.max.z - box.min.z > 30) return; // floors, structure, batches
    out.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, why: o.name || o.parent?.name || "decor" });
  };
  for (const r of roots) {
    if (!r) continue;
    r.updateMatrixWorld(true);
    r.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || !o.geometry) return;
      for (let n = o; n; n = n.parent) if (n === skip) return;
      if (IGNORE_SURF.has(surfaceOf(o)) || !shown(o)) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      if (list.every((m) => m && m.transparent && m.depthWrite === false)) return; // light pools, beams
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (o.isInstancedMesh) {
        if (o.count > 4000) return;
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, m4);
          push(b.copy(o.geometry.boundingBox).applyMatrix4(m4).applyMatrix4(o.matrixWorld), o);
        }
        return;
      }
      push(b.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld), o);
    });
  }
  return out;
}

/**
 * How far a lane (half-width LANE) can run from (x, z) along the axis
 * direction (dx, dz) before it comes within reach of a blocker or the wall.
 */
function freeRun(x, z, dx, dz, blockers, bounds) {
  let run;
  if (dx > 0.5) run = bounds.maxX - WALL_CLEAR - x;
  else if (dx < -0.5) run = x - (bounds.minX + WALL_CLEAR);
  else if (dz > 0.5) run = bounds.maxZ - WALL_CLEAR - z;
  else run = z - (bounds.minZ + WALL_CLEAR);
  // the lane's own sides have to be inside the room too
  if (Math.abs(dx) > 0.5 && (z - LANE < bounds.minZ + WALL_CLEAR || z + LANE > bounds.maxZ - WALL_CLEAR)) return 0;
  if (Math.abs(dz) > 0.5 && (x - LANE < bounds.minX + WALL_CLEAR || x + LANE > bounds.maxX - WALL_CLEAR)) return 0;
  for (const b of blockers) {
    // b is already grown by its clearance
    if (Math.abs(dx) > 0.5) {
      if (z + LANE <= b.minZ || z - LANE >= b.maxZ) continue;
      if (dx > 0) {
        if (b.maxX <= x) continue;
        run = Math.min(run, b.minX - x);
      } else {
        if (b.minX >= x) continue;
        run = Math.min(run, x - b.maxX);
      }
    } else {
      if (x + LANE <= b.minX || x - LANE >= b.maxX) continue;
      if (dz > 0) {
        if (b.maxZ <= z) continue;
        run = Math.min(run, b.minZ - z);
      } else {
        if (b.minZ >= z) continue;
        run = Math.min(run, z - b.maxZ);
      }
    }
    if (run <= 0) return 0;
  }
  return Math.max(0, run);
}

/** Floor box covered by a straight lane from (x, z) along (dx, dz), `len` long. */
function laneBox(x, z, dx, dz, len, half = LANE) {
  const x1 = x + dx * len;
  const z1 = z + dz * len;
  return {
    minX: Math.min(x, x1) - (Math.abs(dz) > 0.5 ? half : 0.02),
    maxX: Math.max(x, x1) + (Math.abs(dz) > 0.5 ? half : 0.02),
    minZ: Math.min(z, z1) - (Math.abs(dx) > 0.5 ? half : 0.02),
    maxZ: Math.max(z, z1) + (Math.abs(dx) > 0.5 ? half : 0.02),
  };
}

const perps = (dx, dz) => [
  [-dz, dx],
  [dz, -dx],
];

/** Candidate fold positions: as late as possible first, then earlier. */
function foldPoints(max) {
  const out = [];
  for (let t = max - 0.05; t >= MIN_LEG && out.length < 7; t -= 0.7) out.push(t);
  return out;
}

/**
 * The best route for one tape from `start` along `dir`: straight, one fold
 * or two folds. Returns { legs: [{x, z, dx, dz, len}], fitted } where the
 * route needs `need` metres (tape + end plate) and fitted <= need.
 */
function routeFrom(x, z, dx, dz, need, blockers, bounds) {
  let best = null;
  const offer = (legs) => {
    const fitted = legs.reduce((s, l) => s + l.len, 0);
    const turns = legs.length - 1;
    if (!best || fitted > best.fitted + 0.01 || (Math.abs(fitted - best.fitted) <= 0.01 && turns < best.turns)) {
      best = { legs, fitted, turns };
    }
  };
  const run1 = freeRun(x, z, dx, dz, blockers, bounds);
  if (run1 >= need) return { legs: [{ x, z, dx, dz, len: need }], fitted: need, turns: 0 };
  offer([{ x, z, dx, dz, len: run1 }]);
  for (const t1 of foldPoints(Math.min(run1, need))) {
    const cx = x + dx * t1;
    const cz = z + dz * t1;
    for (const [ex, ez] of perps(dx, dz)) {
      const rem1 = need - t1;
      const run2 = freeRun(cx, cz, ex, ez, blockers, bounds);
      if (run2 >= rem1) {
        offer([{ x, z, dx, dz, len: t1 }, { x: cx, z: cz, dx: ex, dz: ez, len: rem1 }]);
        if (best.fitted >= need - 0.01 && best.turns === 1) return best;
        continue;
      }
      offer([{ x, z, dx, dz, len: t1 }, { x: cx, z: cz, dx: ex, dz: ez, len: run2 }]);
      for (const t2 of foldPoints(Math.min(run2, rem1))) {
        const c2x = cx + ex * t2;
        const c2z = cz + ez * t2;
        for (const [gx, gz] of perps(ex, ez)) {
          // a U-turn back alongside the first leg needs room between them
          if (gx === -dx && gz === -dz && t2 < 2 * LANE + TAPE_CLEAR) continue;
          const rem2 = rem1 - t2;
          const run3 = Math.min(rem2, freeRun(c2x, c2z, gx, gz, blockers, bounds));
          const legs = [
            { x, z, dx, dz, len: t1 },
            { x: cx, z: cz, dx: ex, dz: ez, len: t2 },
            { x: c2x, z: c2z, dx: gx, dz: gz, len: run3 },
          ];
          // a U-turn must not run back over its own first leg
          if (gx === -dx && gz === -dz && run3 > 0 && boxGap(laneBox(x, z, dx, dz, t1), laneBox(c2x, c2z, gx, gz, run3)) < 0.1) continue;
          offer(legs);
        }
      }
    }
  }
  return best;
}

/** Chooses the route for one exhibit. Returns null when nothing usable fits. */
function planTape(panel, length, blockers, bounds) {
  const fx = Math.round(Math.sin(panel.face));
  const fz = Math.round(Math.cos(panel.face));
  // "along" = the reader's right when facing the panel's front
  const ax = fz;
  const az = -fx;
  const need = length + PLATE_EXT;
  let best = null;
  for (const side of [1, -1]) {
    for (const d of OFFSETS) {
      for (const dir of [1, -1]) {
        // start at the panel's edge, d in front of (or behind) it, and run along it
        const s0 = (-dir * panel.w) / 2;
        const x = panel.x + fx * side * d + ax * s0;
        const z = panel.z + fz * side * d + az * s0;
        const route = routeFrom(x, z, ax * dir, az * dir, need, blockers, bounds);
        if (!route) continue;
        const shown = Math.min(length, route.fitted - PLATE_EXT);
        if (shown < Math.min(MIN_SHOWN, length) - 0.01) continue;
        const full = shown >= length - 0.01;
        // full beats short; then the front, fewer folds, closer to the panel
        const score = (full ? 0 : 100 + (length - shown) * 4) + (side < 0 ? 2.5 : 0) + route.turns * 1.6 + d * 0.6 + (dir < 0 ? 0.05 : 0);
        if (!best || score < best.score) best = { score, side, d, dir, route, shown, full };
      }
    }
  }
  if (!best) return null;
  // trim the route to tape + plate
  const legs = [];
  let left = best.shown + PLATE_EXT;
  for (const l of best.route.legs) {
    if (left <= 0.001) break;
    const len = Math.min(l.len, left);
    if (len > 0.001) legs.push({ ...l, len });
    left -= len;
  }
  return { ...best, legs, fx, fz, ax, az };
}

/** Point and direction `s` metres along a polyline of legs. */
function along(legs, s) {
  let acc = 0;
  for (let i = 0; i < legs.length; i++) {
    const l = legs[i];
    if (s <= acc + l.len + 1e-6 || i === legs.length - 1) {
      const t = Math.max(0, s - acc);
      return { x: l.x + l.dx * t, z: l.z + l.dz * t, dx: l.dx, dz: l.dz, leg: i };
    }
    acc += l.len;
  }
  return null;
}

/* ---------------- textures ---------------- */

const NUM_CELL_W = 128;
const NUM_CELL_H = 64;
const NUM_COLS = 8;
const NUM_MAX = 40;

function numeralAtlas() {
  const rows = Math.ceil((NUM_MAX + 1) / NUM_COLS);
  const c = document.createElement("canvas");
  c.width = NUM_CELL_W * NUM_COLS;
  c.height = NUM_CELL_H * rows;
  const g = c.getContext("2d");
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = "700 50px 'Inter', 'Helvetica Neue', Arial, sans-serif";
  for (let n = 0; n <= NUM_MAX; n++) {
    const cx = (n % NUM_COLS) * NUM_CELL_W + NUM_CELL_W / 2;
    const cy = Math.floor(n / NUM_COLS) * NUM_CELL_H + NUM_CELL_H / 2 + 2;
    g.fillStyle = "rgba(40,26,8,0.9)";
    g.fillText(String(n), cx + 2, cy + 2);
    g.fillStyle = "#f0d48e";
    g.fillText(String(n), cx, cy);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, w: c.width, h: c.height };
}

const PLATE_CELL_W = 512;
const PLATE_CELL_H = 128;
const PLATE_COLS = 4;

function fitFont(g, text, weight, size, maxW) {
  let s = size;
  for (; s > 10; s -= 1) {
    g.font = `${weight} ${s}px 'Inter', 'Helvetica Neue', Arial, sans-serif`;
    if (g.measureText(text).width <= maxW) break;
  }
  return s;
}

function plateAtlas(plates) {
  const rows = Math.max(1, Math.ceil(plates.length / PLATE_COLS));
  const c = document.createElement("canvas");
  c.width = PLATE_CELL_W * PLATE_COLS;
  c.height = PLATE_CELL_H * rows;
  const g = c.getContext("2d");
  plates.forEach((p, i) => {
    const x0 = (i % PLATE_COLS) * PLATE_CELL_W;
    const y0 = Math.floor(i / PLATE_COLS) * PLATE_CELL_H;
    // brushed brass
    const grad = g.createLinearGradient(x0, y0, x0, y0 + PLATE_CELL_H);
    grad.addColorStop(0, "#e2c27c");
    grad.addColorStop(0.5, "#c9a35a");
    grad.addColorStop(1, "#a9853f");
    g.fillStyle = grad;
    g.fillRect(x0, y0, PLATE_CELL_W, PLATE_CELL_H);
    g.globalAlpha = 0.12;
    for (let k = 0; k < 40; k++) {
      g.fillStyle = k % 2 ? "#fff3cf" : "#6b4d1c";
      g.fillRect(x0, y0 + Math.random() * PLATE_CELL_H, PLATE_CELL_W, 1);
    }
    g.globalAlpha = 1;
    g.strokeStyle = "rgba(60,40,12,0.75)";
    g.lineWidth = 3;
    g.strokeRect(x0 + 8, y0 + 8, PLATE_CELL_W - 16, PLATE_CELL_H - 16);
    // engraving
    g.fillStyle = "#2b1c08";
    g.textBaseline = "middle";
    g.textAlign = "left";
    const big = p.big;
    fitFont(g, big, 800, 58, 200);
    g.fillText(big, x0 + 24, y0 + PLATE_CELL_H / 2 + 3);
    const bw = g.measureText(big).width;
    const tx = x0 + 24 + bw + 18;
    const maxW = x0 + PLATE_CELL_W - 22 - tx;
    g.fillRect(tx - 10, y0 + 30, 2, PLATE_CELL_H - 60);
    fitFont(g, p.name, 700, 30, maxW);
    g.fillText(p.name, tx, y0 + PLATE_CELL_H / 2 - 17);
    fitFont(g, p.note, 600, 21, maxW);
    g.fillStyle = "#4a3410";
    g.fillText(p.note, tx, y0 + PLATE_CELL_H / 2 + 20);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, w: c.width, h: c.height };
}

/* ---------------- geometry ---------------- */

/** Flat quads: pushQuad(centre, right (unit xz), up (unit xz), width, height, uv rect). */
function quadBuilder() {
  const pos = [];
  const uv = [];
  const idx = [];
  return {
    push(cx, cy, cz, rx, rz, ux, uz, w, h, u0, v0, u1, v1) {
      const n = pos.length / 3;
      const hw = w / 2;
      const hh = h / 2;
      const corner = (sr, su) => pos.push(cx + rx * hw * sr + ux * hh * su, cy, cz + rz * hw * sr + uz * hh * su);
      corner(-1, -1);
      corner(1, -1);
      corner(1, 1);
      corner(-1, 1);
      uv.push(u0, v0, u1, v0, u1, v1, u0, v1);
      idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
    },
    build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const normals = new Float32Array(pos.length);
      for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
      g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
      g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      return g;
    },
    get count() {
      return idx.length / 6;
    },
  };
}

/** An axis-aligned box on the floor: centre (x, z), size sx * sy * sz, bottom at y0. */
function floorBox(list, x, z, sx, sz, y0, sy) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.translate(x, y0 + sy / 2, z);
  list.push(g);
}

/**
 * Lays a life-size brass tape in front of every exhibit panel.
 *
 * @param {THREE.Object3D} group   parent for the tapes (the scene or world.group)
 * @param {object} world           buildWorld()'s result (displays, group)
 * @param {object} SPECIES         the catalogue (species.js)
 * @param {object} [opts]
 *   scene: THREE.Scene to scan for furniture (default: group's root)
 *   panels: exhibit panels (default world.js EXHIBIT_PANELS)
 *   only: [ids] lay just these
 */
export function buildScaleTapes(group, world, SPECIES = CATALOGUE, opts = {}) {
  const root = new THREE.Group();
  root.name = "scale-tapes";
  root.userData.surface = "skip"; // own materials: keep the lookdev pass off
  group.add(root);

  const panels = opts.panels || WORLD.EXHIBIT_PANELS || [];
  let scene = opts.scene || null;
  if (!scene) {
    scene = group;
    while (scene.parent) scene = scene.parent;
  }
  const scanRoots = [world?.group, scene.getObjectByName?.("props"), scene.getObjectByName?.("live-models"), scene.getObjectByName?.("gelateria")];
  const uniqRoots = [...new Set(scanRoots.filter(Boolean))];

  const fixed = [
    ...(WORLD.OBSTACLES || []).map((b) => ({ ...grow(b, CLEAR), why: b.id || "plinth" })),
    ...(WORLD.PROP_OBSTACLES || []).map((b) => ({ ...grow(b, CLEAR), why: b.id || "furniture" })),
    ...(world?.displays || WORLD.DISPLAYS || []).filter((d) => d.bounds).map((d) => ({ ...grow(d.bounds, CLEAR), why: "display " + d.speciesId })),
    ...sceneBlockers(uniqRoots, root).map((b) => ({ ...grow(b, CLEAR), why: b.why })),
    ...doorBoxes(),
    ...(opts.blockers || []).map((b) => ({ ...grow(b, CLEAR), why: b.id || "extra" })),
  ];
  const placedLanes = [];

  const jobs = [];
  for (const p of panels) {
    const spec = SPECIES[p.id];
    if (!spec || (opts.only && !opts.only.includes(p.id))) continue;
    const len = parseLength(spec.info?.length);
    if (!len) continue;
    const room = WORLD.ROOMS.find((r) => r.id === p.room);
    // the secret rooms stay a surprise: nothing of ours is ever laid in them
    if (!room || room.secret) continue;
    jobs.push({ p, spec, len, room });
  }
  // the biggest animals pick their floor first
  jobs.sort((a, b) => b.len.m - a.len.m);

  const list = [];
  const skipped = [];
  for (const job of jobs) {
    const { p, spec, len, room } = job;
    const bounds = roomBox(room);
    const reach = len.m + PLATE_EXT + 4;
    const near = (b) => b.maxX > p.x - reach && b.minX < p.x + reach && b.maxZ > p.z - reach && b.minZ < p.z + reach;
    const blockers = [...fixed.filter(near), ...placedLanes.filter(near)];
    const plan = planTape(p, len.m, blockers, bounds);
    if (!plan) {
      skipped.push({ id: p.id, why: "no clear floor in front of or behind the panel" });
      continue;
    }
    const boxes = plan.legs.map((l) => laneBox(l.x, l.z, l.dx, l.dz, l.len));
    for (const b of boxes) placedLanes.push({ ...grow(b, TAPE_CLEAR), why: "tape " + p.id });
    list.push({
      id: p.id,
      name: spec.name,
      room: room.id,
      length: len.m,
      min: len.min,
      label: len.label,
      wingspan: len.wingspan,
      shown: +plan.shown.toFixed(2),
      truncated: !plan.full,
      side: plan.side > 0 ? "front" : "back",
      offset: plan.d,
      folds: plan.legs.length - 1,
      legs: plan.legs,
      plan,
      path: (() => {
        const pts = [{ x: plan.legs[0].x, z: plan.legs[0].z }];
        let left = plan.shown;
        for (const l of plan.legs) {
          const t = Math.min(l.len, left);
          pts.push({ x: +(l.x + l.dx * t).toFixed(3), z: +(l.z + l.dz * t).toFixed(3) });
          left -= t;
          if (left <= 0.001) break;
        }
        return pts;
      })(),
      boxes,
    });
  }

  /* ---------------- meshes ---------------- */
  const stripParts = [];
  const tickParts = [];
  const numerals = quadBuilder();
  const plateQuads = quadBuilder();
  const atlas = numeralAtlas();
  const plateInfo = list.map((t) => ({
    big: t.label || `${fmtM(t.length)} m`,
    name: t.name.toUpperCase(),
    note: t.truncated
      ? `TAPE ENDS AT ${fmtM(t.shown)} m · THE ANIMAL WAS ${fmtM(t.length)} m`
      : t.wingspan
        ? "WINGTIP TO WINGTIP · LIFE SIZE"
        : "NOSE TO TAIL · LIFE SIZE",
  }));
  const plates = list.length ? plateAtlas(plateInfo) : null;

  list.forEach((t, ti) => {
    const { plan } = t;
    // text "up" points away from the reader, who faces the panel
    const textFrame = (dx, dz) => {
      const parallel = Math.abs(dx * plan.ax + dz * plan.az) > 0.5;
      let ux, uz;
      if (parallel) {
        ux = -plan.fx * plan.side;
        uz = -plan.fz * plan.side;
      } else {
        // across the panel: read along the tape
        ux = dz;
        uz = -dx;
      }
      return { ux, uz, rx: -uz, rz: ux };
    };

    // strip: one box per leg, corners overlapped by the strip's width
    let left = t.shown;
    t.legs.forEach((l, i) => {
      const len = Math.min(l.len, left);
      if (len <= 0.001) return;
      left -= len;
      const a = i > 0 ? HW : 0.01;
      const b = left > 0.001 ? HW : 0.01;
      const x0 = l.x - l.dx * a;
      const z0 = l.z - l.dz * a;
      const x1 = l.x + l.dx * (len + b);
      const z1 = l.z + l.dz * (len + b);
      const sx = Math.abs(l.dx) > 0.5 ? Math.abs(x1 - x0) : HW * 2;
      const sz = Math.abs(l.dz) > 0.5 ? Math.abs(z1 - z0) : HW * 2;
      floorBox(stripParts, (x0 + x1) / 2, (z0 + z1) / 2, sx, sz, 0.0005, STRIP_Y);
    });

    // ticks + numerals
    const whole = Math.floor(t.shown + 1e-6);
    const every = t.shown > 14 ? 2 : 1;
    const marks = [];
    for (let m = 0; m <= whole; m++) marks.push(m);
    if (t.shown - whole > 0.05) marks.push(t.shown);
    for (const m of marks) {
      const at = along(t.legs, m);
      if (!at) continue;
      const { ux, uz } = textFrame(at.dx, at.dz);
      const isEnd = m === t.shown || m === 0;
      const major = isEnd || m % 5 === 0;
      const tickW = isEnd ? 0.03 : major ? 0.022 : 0.014;
      // a tick runs across the strip; majors stick out on the numeral side
      const across = major ? HW * 2 + 0.08 : HW * 2 - 0.016;
      const shift = major ? 0.04 : 0;
      const cx = at.x + ux * shift;
      const cz = at.z + uz * shift;
      const along_x = Math.abs(at.dx) > 0.5;
      floorBox(tickParts, cx, cz, along_x ? tickW : across, along_x ? across : tickW, 0.0005, TICK_Y);
      // the lower bound of a range gets its own notch on the other side
      const isNumber = Number.isInteger(m) && m <= NUM_MAX && (m % every === 0 || m === whole);
      if (isNumber && !(m === whole && t.shown - whole > 0.05 && m !== 0 && m % every !== 0)) {
        const col = m % NUM_COLS;
        const row = Math.floor(m / NUM_COLS);
        const u0 = (col * NUM_CELL_W) / atlas.w;
        const u1 = ((col + 1) * NUM_CELL_W) / atlas.w;
        const v1 = 1 - (row * NUM_CELL_H) / atlas.h;
        const v0 = 1 - ((row + 1) * NUM_CELL_H) / atlas.h;
        const f = textFrame(at.dx, at.dz);
        const off = HW + (major ? 0.2 : 0.16);
        const h = major ? 0.19 : 0.15;
        numerals.push(at.x + f.ux * off, DECAL_Y, at.z + f.uz * off, f.rx, f.rz, f.ux, f.uz, h * 2, h, u0, v0, u1, v1);
      }
    }
    // the shortest estimate of a range: a small notch on the reader's side
    if (t.min < t.length - 0.2 && t.min <= t.shown) {
      const at = along(t.legs, t.min);
      const { ux, uz } = textFrame(at.dx, at.dz);
      const along_x = Math.abs(at.dx) > 0.5;
      const cx = at.x - ux * (HW + 0.03);
      const cz = at.z - uz * (HW + 0.03);
      floorBox(tickParts, cx, cz, along_x ? 0.02 : 0.07, along_x ? 0.07 : 0.02, 0.0005, TICK_Y);
    }

    // end plate, just past the end of the tape
    const end = along(t.legs, t.shown);
    const last = t.legs[end.leg];
    const pcx = end.x + last.dx * (PLATE_GAP + PLATE_L / 2);
    const pcz = end.z + last.dz * (PLATE_GAP + PLATE_L / 2);
    const along_x = Math.abs(last.dx) > 0.5;
    floorBox(stripParts, pcx, pcz, along_x ? PLATE_L + 0.03 : PLATE_W + 0.03, along_x ? PLATE_W + 0.03 : PLATE_L + 0.03, 0.0005, STRIP_Y);
    let f = textFrame(last.dx, last.dz);
    // the plate's long side follows the tape
    if (Math.abs(f.rx * last.dx + f.rz * last.dz) < 0.5) f = { ux: last.dz, uz: -last.dx, rx: last.dx, rz: last.dz };
    const col = ti % PLATE_COLS;
    const row = Math.floor(ti / PLATE_COLS);
    const u0 = (col * PLATE_CELL_W) / plates.w;
    const u1 = ((col + 1) * PLATE_CELL_W) / plates.w;
    const v1 = 1 - (row * PLATE_CELL_H) / plates.h;
    const v0 = 1 - ((row + 1) * PLATE_CELL_H) / plates.h;
    plateQuads.push(pcx, DECAL_Y, pcz, f.rx, f.rz, f.ux, f.uz, PLATE_L, PLATE_W, u0, v0, u1, v1);
    t.plate = { x: +pcx.toFixed(3), z: +pcz.toFixed(3) };
    t.end = { x: +end.x.toFixed(3), z: +end.z.toFixed(3) };
  });

  // polished brass that still reads in a dim hall: half metal, a touch of glow
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xd8b062,
    metalness: 0.45,
    roughness: 0.34,
    emissive: 0x6a4c16,
    emissiveIntensity: 0.45,
    envMapIntensity: 1.2,
  });
  const tickMat = new THREE.MeshStandardMaterial({ color: 0x2a1d0c, metalness: 0.4, roughness: 0.55 });
  const decal = (map) =>
    new THREE.MeshStandardMaterial({
      map,
      emissive: 0xffffff,
      emissiveMap: map,
      emissiveIntensity: 0.28,
      metalness: 0.35,
      roughness: 0.4,
      transparent: false,
      alphaTest: 0.35,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  const numMat = decal(atlas.tex);
  const plateMat = plates ? decal(plates.tex) : null;
  if (plateMat) plateMat.alphaTest = 0;

  const meshes = [];
  const add = (geo, mat, name) => {
    if (!geo) return;
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.receiveShadow = true;
    m.castShadow = false;
    m.userData.surface = "skip";
    m.matrixAutoUpdate = false;
    root.add(m);
    meshes.push(m);
  };
  if (stripParts.length) add(mergeGeometries(stripParts), brassMat, "scale-tapes:strip");
  if (tickParts.length) add(mergeGeometries(tickParts), tickMat, "scale-tapes:ticks");
  if (numerals.count) add(numerals.build(), numMat, "scale-tapes:numerals");
  if (plateQuads.count) add(plateQuads.build(), plateMat, "scale-tapes:plates");
  for (const g of [...stripParts, ...tickParts]) g.dispose();

  if (skipped.length) console.warn("[scaletape] no tape for: " + skipped.map((s) => s.id).join(", "));

  /** Which tape (if any) is under (x, z), and how far along it. */
  function measureAt(x, z, radius = 0.45) {
    let best = null;
    for (const t of list) {
      let acc = 0;
      let left = t.shown;
      for (const l of t.legs) {
        const len = Math.min(l.len, left);
        if (len <= 0) break;
        const s = Math.max(0, Math.min(len, (x - l.x) * l.dx + (z - l.z) * l.dz));
        const px = l.x + l.dx * s;
        const pz = l.z + l.dz * s;
        const d = Math.hypot(x - px, z - pz);
        if (d <= radius && (!best || d < best.d)) best = { d, id: t.id, name: t.name, metres: +(acc + s).toFixed(1), length: t.length, wingspan: t.wingspan };
        acc += len;
        left -= len;
      }
    }
    if (!best) return null;
    const { d, ...out } = best;
    void d;
    return out;
  }

  return {
    group: root,
    list: list.map(({ plan, ...rest }) => rest),
    skipped,
    measureAt,
    dispose() {
      root.parent?.remove(root);
      for (const m of meshes) m.geometry.dispose();
      for (const m of [brassMat, tickMat, numMat, plateMat]) m?.dispose();
      atlas.tex.dispose();
      plates?.tex.dispose();
    },
  };
}

/* ------------------------------------------------------------------ */
/* card silhouette strip                                                */
/* ------------------------------------------------------------------ */

const HUMAN_H = 1.75;
const HUMAN_W = 0.5;

/** Polygon helpers, in metres with y up. */
function ellipse(cx, cy, rx, ry, rot = 0, n = 28) {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.cos(a) * rx;
    const y = Math.sin(a) * ry;
    out.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return out;
}

/** A tapered limb from a to b (radius r0 -> r1), bent sideways by `bend` metres. */
function limb(a, b, r0, r1, bend = 0, n = 10) {
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const L = Math.hypot(dx, dy) || 1;
  const nx = -dy / L;
  const ny = dx / L;
  const pts = [];
  const side = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const k = 4 * t * (1 - t) * bend;
    const cx = ax + dx * t + nx * k;
    const cy = ay + dy * t + ny * k;
    const r = r0 + (r1 - r0) * t;
    pts.push([cx + nx * r, cy + ny * r]);
    side.push([cx - nx * r, cy - ny * r]);
  }
  return [...pts, ...side.reverse()];
}

const tri = (a, b, c) => [a, b, c];

/** Side-on (or, for flyers measured by wingspan, front-on) outline of a species. */
export function silhouette(spec, len) {
  const plan = spec.plan || "biped";
  const f = spec.features || {};
  const H = spec.hip ?? 3;
  const B = spec.body ?? 5;
  const r = spec.r || [1.2, 1.1, 0.6, 0.3];
  const neck = spec.neck ?? 1.5;
  const rise = spec.neckRise ?? 1;
  const head = spec.head ?? 1.5;
  const tail = spec.tail ?? 5;
  const shapes = [];
  const headFor = (nx, ny, tilt = -0.08) => {
    const t = spec.headType || "theropod";
    const ry = { theropod: 0.24, raptor: 0.2, duckbill: 0.2, fish: 0.14, beak: 0.2, dome: 0.32, ceratopsian: 0.26 }[t] ?? 0.22;
    const cx = nx + head * 0.4;
    if (t === "theropod" || t === "raptor" || t === "fish") {
      // a wedge: deep at the jaw joint, tapering to the snout
      const db = head * ry * 2.1;
      const df = db * (t === "fish" ? 0.55 : 0.42);
      const x0 = nx - head * 0.12;
      const x1 = nx + head * 0.92;
      const c = Math.cos(tilt);
      const s = Math.sin(tilt);
      const rot = ([x, y]) => [nx + (x - nx) * c - (y - ny) * s, ny + (x - nx) * s + (y - ny) * c];
      shapes.push(
        [
          [x0, ny + db * 0.5],
          [x0 + head * 0.38, ny + db * 0.55],
          [x1 - head * 0.08, ny + df * 0.55],
          [x1, ny + df * 0.2],
          [x1 - head * 0.04, ny - df * 0.5],
          [x0 + head * 0.34, ny - db * 0.45],
          [x0, ny - db * 0.3],
        ].map(rot)
      );
    } else shapes.push(ellipse(cx, ny, head * 0.52, head * ry, tilt));
    if (t === "ceratopsian" || f.frill) shapes.push(ellipse(nx - head * 0.12, ny + head * 0.3, head * 0.3, head * 0.44, -0.85));
    if (f.horns) shapes.push(tri([cx - head * 0.05, ny + head * 0.12], [cx + head * 0.12, ny + head * 0.12], [cx + head * 0.45, ny + head * 0.62]));
    if (f.noseHorn) shapes.push(tri([cx + head * 0.25, ny + head * 0.1], [cx + head * 0.38, ny + head * 0.1], [cx + head * 0.42, ny + head * 0.38]));
    if (f.crest || f.headCrest) shapes.push(tri([cx - head * 0.3, ny + head * 0.12], [cx + head * 0.15, ny + head * 0.15], [cx - head * 0.6, ny + head * 0.55]));
  };

  if (plan === "flyer" && len?.wingspan) {
    // front view, wings spread: drawn straight in metres
    const S = len.m;
    const y = Math.max(1.4, S * 0.16 + 0.5);
    const bw = S * 0.035;
    for (const k of [1, -1]) {
      shapes.push([
        [k * bw * 0.6, y + S * 0.02],
        [k * S * 0.2, y + S * 0.075],
        [k * S * 0.5, y + S * 0.035],
        [k * S * 0.31, y - S * 0.015],
        [k * S * 0.14, y - S * 0.045],
        [k * bw * 0.8, y - S * 0.07],
      ]);
      shapes.push(limb([k * bw * 0.5, y - S * 0.06], [k * bw * 1.6, y - S * 0.13], S * 0.008, S * 0.004));
    }
    shapes.push(ellipse(0, y - S * 0.02, bw, S * 0.06));
    shapes.push(ellipse(0, y + S * 0.065, bw * 0.75, S * 0.035));
    if (f.crest) shapes.push(tri([-bw * 0.4, y + S * 0.09], [bw * 0.4, y + S * 0.09], [0, y + S * 0.15]));
    return { shapes, front: true };
  }

  if (plan === "marine") {
    const y = Math.max(r[0] * 1.6, 1.2);
    shapes.push(ellipse(0, y, B * 0.55, r[0] * 0.72));
    const nx0 = B * 0.45;
    const nx1 = nx0 + neck;
    const ny1 = y + rise * 0.25;
    shapes.push(limb([nx0, y + r[0] * 0.1], [nx1, ny1], r[2] * 0.9, r[2] * 0.6, rise * 0.05));
    headFor(nx1 - head * 0.05, ny1, -0.04);
    const tx = -B * 0.45 - tail;
    shapes.push(limb([-B * 0.45, y], [tx, y - r[0] * 0.25], r[1] * 0.7, 0.05, -0.1));
    if (f.tailFin) {
      shapes.push(tri([tx + 0.2 * r[0], y - r[0] * 0.25], [tx - 0.5 * r[0], y + r[0] * 0.9], [tx - 0.1 * r[0], y - r[0] * 0.2]));
      shapes.push(tri([tx + 0.2 * r[0], y - r[0] * 0.25], [tx - 0.4 * r[0], y - r[0] * 1.0], [tx - 0.1 * r[0], y - r[0] * 0.3]));
    }
    if (f.dorsalFin) shapes.push(tri([-B * 0.08, y + r[0] * 0.6], [B * 0.12, y + r[0] * 0.6], [-B * 0.14, y + r[0] * 1.15]));
    const flip = (spec.foot ?? 2) * 0.85;
    shapes.push(limb([B * 0.25, y - r[0] * 0.45], [B * 0.25 - flip * 0.75, y - r[0] * 0.45 - flip * 0.55], r[0] * 0.28, r[0] * 0.08));
    shapes.push(limb([-B * 0.3, y - r[0] * 0.45], [-B * 0.3 - flip * 0.7, y - r[0] * 0.45 - flip * 0.45], r[0] * 0.24, r[0] * 0.07));
    return { shapes };
  }

  if (plan === "quad") {
    const sauropod = rise > 2.5;
    const sh = sauropod ? H * 1.15 : H * 0.85;
    const fx = B * 0.75;
    const tilt = Math.atan2(sh - H, fx);
    shapes.push(ellipse(fx * 0.5, (H + sh) / 2 + r[0] * 0.05, fx * 0.5 + r[0] * 0.95, r[0] * 0.76, tilt));
    // legs: hind straight under the hip, front under the shoulder (far pair a step apart)
    shapes.push(limb([-B * 0.05, H * 0.95], [-B * 0.08, 0.05], r[0] * 0.46, r[0] * 0.24, -0.08 * H));
    shapes.push(limb([fx - B * 0.05, sh - r[0] * 0.15], [fx - B * 0.07, 0.05], r[0] * 0.34, r[0] * 0.22, 0.04 * H));
    shapes.push(limb([0, H], [B * 0.04, 0.05], r[0] * 0.56, r[0] * 0.3, -0.1 * H));
    shapes.push(limb([fx, sh - r[0] * 0.1], [fx + B * 0.02, 0.05], r[0] * 0.42, r[0] * 0.26, 0.05 * H));
    shapes.push(ellipse(B * 0.06, 0.08, r[0] * 0.38, 0.1));
    shapes.push(ellipse(fx + B * 0.03, 0.08, r[0] * 0.3, 0.1));
    // neck
    const horiz = Math.sqrt(Math.max(neck * neck - rise * rise, 0.3 * neck * neck));
    const n0 = [fx + r[0] * 0.55, sh + r[0] * 0.3];
    const n1 = [n0[0] + horiz, sh + rise];
    shapes.push(limb(n0, n1, r[2] * 1.15, r[2] * 0.62, sauropod ? -horiz * 0.12 : 0));
    headFor(n1[0] - head * 0.1, n1[1], sauropod ? -0.25 : -0.12);
    // tail
    const t0 = [-r[0] * 0.7, H + r[0] * 0.1];
    const t1 = [t0[0] - tail, sauropod ? H * 0.35 : H * 0.55];
    shapes.push(limb(t0, t1, r[1] * 0.7, 0.04, sauropod ? -tail * 0.06 : -tail * 0.04));
    if (f.plates) {
      for (let i = 0; i < 9; i++) {
        const x = -B * 0.5 + i * B * 0.16;
        const yb = H + r[0] * 0.65 - Math.abs(x - B * 0.15) * 0.06;
        const s = r[0] * (0.55 + 0.4 * Math.sin(((i + 1) / 10) * Math.PI));
        shapes.push(tri([x - s * 0.45, yb], [x + s * 0.45, yb], [x, yb + s]));
      }
    }
    if (f.spikes) {
      shapes.push(limb([t1[0] + 0.8, t1[1] + 0.1], [t1[0] - 0.1, t1[1] + r[0] * 0.8], 0.08, 0.01));
      shapes.push(limb([t1[0] + 0.6, t1[1] + 0.1], [t1[0] - 0.4, t1[1] + r[0] * 0.6], 0.08, 0.01));
    }
    if (f.club) shapes.push(ellipse(t1[0], t1[1], r[1] * 0.38, r[1] * 0.26));
    if (f.sail) shapes.push(ellipse(fx * 0.4, H + r[0] * 0.5, B * 0.36, r[0] * 1.5, 0, 32).filter((p) => p[1] >= H + r[0] * 0.5));
    if (f.armor) shapes.push(ellipse(fx * 0.45, (H + sh) / 2 + r[0] * 0.35, B * 0.58, r[0] * 0.7, tilt));
    return { shapes };
  }

  // biped (and flyers measured nose to tail)
  shapes.push(ellipse(B * 0.32, H + r[0] * 0.15, B * 0.56, r[0] * 0.78, 0.08));
  const n0 = [B * 0.78, H + r[0] * 0.4];
  const n1 = [n0[0] + neck * 0.6, H + rise * 0.7 + r[0] * 0.25];
  shapes.push(limb(n0, n1, r[2] * 1.05, r[2] * 0.72, -neck * 0.1));
  headFor(n1[0] - head * 0.12, n1[1]);
  const t0 = [-B * 0.08, H + r[0] * 0.2];
  const t1 = [t0[0] - tail, H * 0.72];
  shapes.push(limb(t0, t1, r[1] * 0.68, 0.03, -tail * 0.03));
  // hind legs: thigh forward, shin back, foot forward onto the ground
  const leg = (dx, k) => {
    const hip = [dx, H];
    const knee = [dx + H * 0.16, H * 0.5];
    const ankle = [dx - H * 0.06, H * 0.14];
    const toe = [ankle[0] + H * 0.24, 0.03];
    shapes.push(limb(hip, knee, r[0] * 0.5 * k, r[0] * 0.26 * k));
    shapes.push(limb(knee, ankle, r[0] * 0.26 * k, r[0] * 0.12 * k));
    shapes.push(limb(ankle, toe, r[0] * 0.12 * k, r[0] * 0.06 * k));
  };
  leg(-H * 0.12, 0.9);
  leg(0, 1);
  if (f.arms || f.wings) {
    const a0 = [B * 0.66, H - r[0] * 0.1];
    const al = f.wings ? (spec.features.wingLen || 1) * 0.5 : H * 0.28;
    shapes.push(limb(a0, [a0[0] + al * 0.35, a0[1] - al], r[0] * 0.18, r[0] * 0.06, al * 0.15));
  }
  if (f.sail) {
    const arc = ellipse(B * 0.3, H + r[0] * 0.55, B * 0.38, r[0] * 1.02, 0.05, 32).filter((p) => p[1] >= H + r[0] * 0.5);
    shapes.push(arc);
  }
  return { shapes };
}

function bounds(shapes) {
  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minY = Infinity;
  for (const s of shapes) for (const [x, y] of s) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, maxX, minY, maxY };
}

/** The species' outline scaled to its real size, nose (or wingtip) at x = 0, facing -x, feet on y = 0. */
function scaledOutline(spec) {
  const len = parseLength(spec.info?.length);
  if (!len) return null;
  const { shapes, front } = silhouette(spec, len);
  const b = bounds(shapes);
  const k = front ? 1 : len.m / (b.maxX - b.minX);
  // nose to the left (towards the visitor); front views are symmetric
  const map = ([x, y]) => [front ? x - b.minX : (b.maxX - x) * k, y * k];
  const out = shapes.map((s) => s.map(map));
  const ob = bounds(out);
  return { shapes: out, length: len.m, width: ob.maxX, height: ob.maxY, len, front: !!front };
}

/** A 1.75 m adult, front-ish, feet at (0, 0), in metres. */
function humanShapes() {
  // right half of a standing adult, neck to crotch; mirrored for the left
  const right = [
    [0.05, 1.5], [0.16, 1.47], [0.205, 1.42], [0.225, 1.2], [0.245, 0.9], [0.232, 0.84], [0.2, 0.85],
    [0.19, 1.12], [0.172, 1.25], [0.166, 1.0], [0.16, 0.9], [0.13, 0.07], [0.145, 0], [0.03, 0], [0.034, 0.07], [0.02, 0.8],
  ];
  const k = HUMAN_H / 1.75;
  const body = [...right, [0, 0.82], ...right.slice().reverse().map(([x, y]) => [-x, y])].map(([x, y]) => [x * k, y * k]);
  return [
    ellipse(0, HUMAN_H - 0.115, 0.093, 0.115, 0, 24), // head
    [[-0.045, HUMAN_H - 0.2], [0.045, HUMAN_H - 0.2], [0.05, 1.5 * k], [-0.05, 1.5 * k]], // neck
    body,
  ];
}

function hexColor(n, mixTo = 0xe8dcc4, t = 0.45) {
  const c = new THREE.Color(n ?? 0x9a8a6a).lerp(new THREE.Color(mixTo), t);
  return "#" + c.getHexString();
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The card's "you vs the animal" strip: an inline SVG with a 1.75 m adult
 * next to the animal's silhouette, to scale on a metre ground line, plus a
 * 12 m bus outline for the big ones. `ex` is an exhibit record (or a
 * species id). Options: shirt (CSS colour for the visitor), compareWith
 * (another species id, drawn as a dashed outline), width/height (viewBox).
 */
export function renderScaleHtml(ex, opts = {}) {
  const id = typeof ex === "string" ? ex : ex?.dino || ex?.id;
  const spec = CATALOGUE[id];
  if (!spec) return "";
  const a = scaledOutline(spec);
  if (!a) return "";
  const other = opts.compareWith && opts.compareWith !== id && CATALOGUE[opts.compareWith] ? scaledOutline(CATALOGUE[opts.compareWith]) : null;

  const W = opts.width || 640;
  const Hpx = opts.height || 210;
  const padL = 18;
  const padR = 18;
  const top = 34; // room for the dimension line
  const ground = Hpx - 34; // room for the ruler numbers
  const gap = 0.7; // metres between the visitor and the animal
  const YOU_HALF = 36; // half the "You · 1.75 m" label, px
  const bus = a.length >= 10 && !other ? { l: 12, h: 3.2 } : null;
  const span = Math.max(a.width, other ? other.width : 0, bus ? bus.l : 0);
  const worldH = Math.max(HUMAN_H, a.height, other ? other.height : 0, bus ? bus.h : 0);
  // the visitor's label must clear both the card edge and the animal's nose
  const place = (k) => {
    const ox = Math.max(padL + (HUMAN_W / 2) * k, YOU_HALF + 2);
    const ax = Math.max(ox + (HUMAN_W / 2 + gap) * k, ox + YOU_HALF + 6);
    return { ox, ax };
  };
  let k = (ground - top) / worldH;
  for (let i = 0; i < 3; i++) {
    const { ax } = place(k);
    if (ax + span * k <= W - padR + 0.5) break;
    k = Math.min(k, (W - padR - ax) / span);
  }
  let { ox, ax } = place(k);
  // a small animal leaves the strip half empty: centre the group instead
  const slack = W - padR - (ax + span * k);
  if (slack > 8) {
    ox += slack / 2;
    ax += slack / 2;
  }
  const P = (x0, pts) => "M" + pts.map(([x, y]) => `${(x0 + x * k).toFixed(1)},${(ground - y * k).toFixed(1)}`).join("L") + "Z";
  const paths = (x0, shapes) => shapes.map((s) => `<path d="${P(x0, s)}"/>`).join("");

  const parts = [];
  // ruler: metres from the animal's nose; labels at least ~30 px apart
  const rulerEnd = span;
  const step = [0.1, 0.25, 0.5, 1, 2, 5, 10].find((s) => s * k >= 30) ?? 10;
  const minor = (step / 2) * k >= 7 ? step / 2 : step;
  const fmtTick = (m) => (step < 1 ? String(+m.toFixed(2)) : String(Math.round(m)));
  const lastLabel = Math.floor(rulerEnd / step + 1e-6) * step;
  const ticks = [];
  for (let i = 0; i * minor <= rulerEnd + 1e-6; i++) {
    const m = i * minor;
    const x = ax + m * k;
    const labelled = Math.abs(m / step - Math.round(m / step)) < 1e-6;
    ticks.push(`<line x1="${x.toFixed(1)}" y1="${ground}" x2="${x.toFixed(1)}" y2="${ground + (labelled ? 7 : 4)}"/>`);
    if (labelled) {
      const unit = Math.abs(m - lastLabel) < 1e-6 ? " m" : "";
      ticks.push(`<text x="${x.toFixed(1)}" y="${ground + 19}" text-anchor="middle">${fmtTick(m)}${unit}</text>`);
    }
  }
  parts.push(`<g class="scaleRuler"><line x1="${padL - 6}" y1="${ground}" x2="${W - padR + 6}" y2="${ground}"/>${ticks.join("")}</g>`);

  if (bus) {
    const bx = ax;
    const bw = bus.l * k;
    const bh = bus.h * k;
    const wheel = 0.5 * k;
    parts.push(
      `<g class="scaleBus"><rect x="${bx.toFixed(1)}" y="${(ground - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${(bh - wheel * 0.6).toFixed(1)}" rx="${(0.4 * k).toFixed(1)}"/>` +
        `<circle cx="${(bx + 2.2 * k).toFixed(1)}" cy="${(ground - wheel).toFixed(1)}" r="${wheel.toFixed(1)}"/><circle cx="${(bx + bw - 2.6 * k).toFixed(1)}" cy="${(ground - wheel).toFixed(1)}" r="${wheel.toFixed(1)}"/>` +
        `</g>`
    );
  }
  if (other) {
    parts.push(`<g class="scaleOther">${paths(ax, other.shapes)}</g>`);
    parts.push(`<text class="scaleOtherLabel" x="${(ax + other.width * k - 2).toFixed(1)}" y="${(ground - other.height * k - 4).toFixed(1)}" text-anchor="end">${esc(CATALOGUE[opts.compareWith].name)} · ${esc(other.len.label)}</text>`);
  }
  parts.push(`<g class="scaleAnimal" fill="${hexColor(spec.color)}">${paths(ax, a.shapes)}</g>`);
  // the bus label goes where the animal is not: low in the bus's back end
  // for most (tails run high there, legs stand further forward), top left for
  // the long sauropods (whose legs fill the back end but whose necks rise
  // well clear of the front); a halo keeps it readable either way
  if (bus) {
    const long = a.length >= 16;
    const lx = long ? ax + 6 : ax + bus.l * k - 6;
    const ly = long ? ground - bus.h * k + 13 : ground - 0.5 * k * 0.6 - 6;
    parts.push(`<text class="scaleBusLabel" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${long ? "start" : "end"}">12 m bus</text>`);
  }
  // the visitor
  const shirt = opts.shirt ? ` style="fill:${esc(opts.shirt)}"` : "";
  parts.push(`<g class="scaleHuman"${shirt}>${paths(ox, humanShapes())}</g>`);
  parts.push(`<text class="scaleYou" x="${ox.toFixed(1)}" y="${(ground - HUMAN_H * k - 6).toFixed(1)}" text-anchor="middle">You · 1.75 m</text>`);
  // dimension line over the animal
  const dy = Math.max(14, ground - a.height * k - 12);
  const x0 = ax;
  const x1 = ax + a.width * k;
  const dimLabel = `${a.len.label}${a.len.wingspan ? " wingspan" : " long"}`;
  parts.push(
    `<g class="scaleDim"><line x1="${x0.toFixed(1)}" y1="${dy}" x2="${x1.toFixed(1)}" y2="${dy}"/>` +
      `<line x1="${x0.toFixed(1)}" y1="${dy - 5}" x2="${x0.toFixed(1)}" y2="${dy + 5}"/><line x1="${x1.toFixed(1)}" y1="${dy - 5}" x2="${x1.toFixed(1)}" y2="${dy + 5}"/>` +
      `<text x="${((x0 + x1) / 2).toFixed(1)}" y="${dy - 6}" text-anchor="middle">${esc(dimLabel)}</text></g>`
  );

  const what = a.len.wingspan ? `wingtip to wingtip` : `nose to tail`;
  const vs = Math.round(a.length / HUMAN_H);
  const versus =
    a.length >= HUMAN_H * 1.5
      ? `about ${vs} visitors laid end to end`
      : a.length < HUMAN_H * 0.6
        ? `shorter than your leg`
        : `about your own height`;
  const title = `${spec.name} (${a.len.label} ${what}) beside a 1.75 m adult`;
  return `
    <figure class="scaleStrip" data-species="${esc(id)}">
      <svg viewBox="0 0 ${W} ${Hpx}" role="img" aria-label="${esc(title)}" preserveAspectRatio="xMidYMid meet">
        <title>${esc(title)}</title>
        ${parts.join("")}
      </svg>
      <figcaption><b>To scale:</b> ${esc(a.len.label)} ${what}, ${esc(versus)}.${
        a.len.wingspan ? " Seen head-on, wings spread." : ""
      } Outline is schematic.</figcaption>
    </figure>`;
}
