/**
 * Project health check.
 *
 *  1. Parses every JavaScript file in the project.
 *  2. Validates the museum data: species catalogue, exhibit placements,
 *     battle line-ups and, most importantly, that the floor plan is a single
 *     connected walkable space with nothing standing inside a wall.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, extname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const warnings = [];

function fail(msg) {
  problems.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}

/* ------------------------------------------------------------------ */
/* 1. syntax                                                            */
/* ------------------------------------------------------------------ */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", ".vercel", ".claude"].includes(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (extname(full) === ".js" || extname(full) === ".mjs") out.push(full);
  }
  return out;
}

const files = walk(root).filter((f) => !f.includes(`${join("public", "vendor")}`));
let parsed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    parsed++;
  } catch (err) {
    fail(`syntax error in ${relative(root, file)}\n${err.stderr?.toString().split("\n").slice(0, 4).join("\n")}`);
  }
}
console.log(`✓ parsed ${parsed}/${files.length} javascript files`);

/* ------------------------------------------------------------------ */
/* 2. data + floor plan                                                 */
/* ------------------------------------------------------------------ */
const { SPECIES, SPECIES_LIST } = await import(
  pathToFileURL(join(root, "public/js/species.js")).href
);
const { EXHIBITS, BATTLES } = await import(
  pathToFileURL(join(root, "public/js/exhibits.js")).href
);
const world = await import(pathToFileURL(join(root, "public/js/world.js")).href);

const { PLACEMENTS, ROOMS, GRID_W, GRID_H, CELL, roomAt, isSolid, g2w, g2z } = world;
const { createDino } = await import(pathToFileURL(join(root, "public/js/dinos.js")).href);
const THREE = await import("three");

/* species integrity */
const seen = new Set();
for (const s of SPECIES_LIST) {
  if (!s.id) fail("a species entry has no id");
  if (seen.has(s.id)) fail(`duplicate species id: ${s.id}`);
  seen.add(s.id);
  if (!s.info?.blurb) warn(`${s.id} has no blurb`);
  if (!s.info?.facts?.length) warn(`${s.id} has no facts`);
  if (!s.hall) warn(`${s.id} has no hall`);
}
console.log(`✓ ${SPECIES_LIST.length} species in the catalogue`);

/* exhibits */
for (const ex of EXHIBITS) {
  if (!SPECIES[ex.id]) fail(`exhibit ${ex.id} has no species`);
}
console.log(`✓ ${EXHIBITS.length} exhibit cards`);

/* battles */
for (const b of BATTLES) {
  if (!SPECIES[b.a]) fail(`battle ${b.id}: unknown fighter "${b.a}"`);
  if (!SPECIES[b.b]) fail(`battle ${b.id}: unknown fighter "${b.b}"`);
  if (!b.lines?.length) fail(`battle ${b.id} has no narration`);
  let last = -1;
  for (const [t] of b.lines || []) {
    if (t < last) fail(`battle ${b.id} narration is out of order`);
    last = t;
  }
}
console.log(`✓ ${BATTLES.length} battle screenings`);

/* placements */
const placed = new Set();
const footprints = [];
for (const p of PLACEMENTS) {
  if (!SPECIES[p.id]) fail(`placement references unknown species "${p.id}"`);
  if (placed.has(p.id)) fail(`species "${p.id}" is placed twice`);
  placed.add(p.id);

  const room = roomAt(p.x, p.z);
  if (!room) {
    fail(`placement ${p.id} at ${p.x},${p.z} is inside a wall`);
    continue;
  }
  // the real model footprint has to sit on walkable tiles
  const spec = SPECIES[p.id];
  const dino = createDino(spec, { skeleton: true, scale: p.scale || 1 });
  const box = new THREE.Box3().setFromObject(dino.group);
  const ry = p.ry || 0;
  const cos = Math.cos(ry);
  const sin = Math.sin(ry);
  let clipped = null;
  for (const cx of [box.min.x, box.max.x]) {
    for (const cz of [box.min.z, box.max.z]) {
      const wx = p.x + cx * cos + cz * sin;
      const wz = p.z - cx * sin + cz * cos;
      if (!roomAt(wx, wz)) clipped = clipped || [wx.toFixed(1), wz.toFixed(1)];
    }
  }
  if (clipped) {
    fail(`placement ${p.id} at ${p.x},${p.z} clips a wall near ${clipped.join(",")}`);
  }
  // remember the world footprint so mounts can be compared with each other
  const corners = [];
  for (const cx of [box.min.x, box.max.x]) {
    for (const cz of [box.min.z, box.max.z]) {
      corners.push([p.x + cx * cos + cz * sin, p.z - cx * sin + cz * cos]);
    }
  }
  footprints.push({
    id: p.id,
    minX: Math.min(...corners.map((c) => c[0])),
    maxX: Math.max(...corners.map((c) => c[0])),
    minZ: Math.min(...corners.map((c) => c[1])),
    maxZ: Math.max(...corners.map((c) => c[1])),
  });
  dino.dispose();
}
const unplaced = SPECIES_LIST.filter((s) => !placed.has(s.id)).map((s) => s.id);
if (unplaced.length) warn(`not on the floor plan: ${unplaced.join(", ")}`);
console.log(`✓ ${PLACEMENTS.length} skeletons on the floor plan`);

/* two skeletons must not share the same spot */
for (let i = 0; i < PLACEMENTS.length; i++) {
  for (let j = i + 1; j < PLACEMENTS.length; j++) {
    const a = PLACEMENTS[i];
    const b = PLACEMENTS[j];
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < 5) fail(`skeletons ${a.id} and ${b.id} are only ${d.toFixed(1)}m apart`);
  }
}

/* two skeletons must not be modelled inside each other */
for (let i = 0; i < footprints.length; i++) {
  for (let j = i + 1; j < footprints.length; j++) {
    const a = footprints[i];
    const b = footprints[j];
    const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
    if (ox > 0.4 && oz > 0.4) {
      fail(`skeletons ${a.id} and ${b.id} overlap (${ox.toFixed(1)}m x ${oz.toFixed(1)}m)`);
    }
  }
}

/* the museum has to be one connected space */
function walkableCells() {
  const out = [];
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      if (!isSolid(c, r)) out.push([c, r]);
    }
  }
  return out;
}

const cells = walkableCells();
const start = cells[0];
const seenCells = new Set([`${start[0]},${start[1]}`]);
const queue = [start];
while (queue.length) {
  const [c, r] = queue.shift();
  for (const [dc, dr] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const nc = c + dc;
    const nr = r + dr;
    const key = `${nc},${nr}`;
    if (seenCells.has(key)) continue;
    if (isSolid(nc, nr)) continue;
    seenCells.add(key);
    queue.push([nc, nr]);
  }
}
if (seenCells.size !== cells.length) {
  const orphans = cells.filter(([c, r]) => !seenCells.has(`${c},${r}`));
  fail(
    `the museum is not connected: ${orphans.length} unreachable tile(s) e.g. ${orphans
      .slice(0, 5)
      .map(([c, r]) => `${c},${r}`)
      .join(" ")}`
  );
} else {
  console.log(`✓ all ${cells.length} floor tiles are connected`);
}

/* spawn point */
const spawn = world.SPAWN;
if (!roomAt(spawn.x, spawn.z)) fail("the spawn point is not inside a room");
if (isSolid(Math.round(spawn.x / CELL + (GRID_W - 1) / 2), Math.round(spawn.z / CELL + (GRID_H - 1) / 2))) {
  fail("the spawn point is inside a wall");
}

/* interactables must be reachable */
const interactables = world.buildInteractables();
for (const it of interactables) {
  if (!roomAt(it.x, it.z)) fail(`interactable ${it.id} is inside a wall`);
}
const exhibitPoints = interactables.filter((i) => i.type === "exhibit").length;
if (exhibitPoints !== PLACEMENTS.length) {
  fail(`${exhibitPoints} exhibit points for ${PLACEMENTS.length} skeletons`);
}
console.log(`✓ ${interactables.length} points of interest`);

/* rooms must not overlap */
for (let i = 0; i < ROOMS.length; i++) {
  for (let j = i + 1; j < ROOMS.length; j++) {
    const a = ROOMS[i];
    const b = ROOMS[j];
    const overlap =
      a.cols[0] <= b.cols[1] &&
      b.cols[0] <= a.cols[1] &&
      a.rows[0] <= b.rows[1] &&
      b.rows[0] <= a.rows[1];
    if (overlap) fail(`rooms ${a.id} and ${b.id} overlap`);
  }
}

/* the walls have to seal every hall except the doorways in OPEN */
const walls = world.buildWallData();
const wallKeys = new Set();
for (const w of walls) {
  const key = `${w.x.toFixed(2)}:${w.z.toFixed(2)}:${w.sx}:${w.sz}`;
  if (wallKeys.has(key)) fail(`duplicate wall slab at ${w.x.toFixed(1)},${w.z.toFixed(1)}`);
  wallKeys.add(key);
}
const hasWallAt = (x, z) =>
  wallKeys.has(`${x.toFixed(2)}:${z.toFixed(2)}:0.4:6`) ||
  wallKeys.has(`${x.toFixed(2)}:${z.toFixed(2)}:6:0.4`);
const reportedDoors = new Set();
for (const room of ROOMS) {
  for (let c = room.cols[0]; c <= room.cols[1]; c++) {
    for (let r = room.rows[0]; r <= room.rows[1]; r++) {
      const sides = [
        { key: `h:${c - 1},${r}`, a: world.roomAt(g2w(c) - 3.01, g2z(r)), b: room, x: g2w(c) - 3, z: g2z(r) },
        { key: `h:${c},${r}`, a: room, b: world.roomAt(g2w(c) + 3.01, g2z(r)), x: g2w(c) + 3, z: g2z(r) },
        { key: `v:${c},${r - 1}`, a: world.roomAt(g2w(c), g2z(r) - 3.01), b: room, x: g2w(c), z: g2z(r) - 3 },
        { key: `v:${c},${r}`, a: room, b: world.roomAt(g2w(c), g2z(r) + 3.01), x: g2w(c), z: g2z(r) + 3 },
      ];
      for (const { key, a, b, x, z } of sides) {
        const same = a && b && a.id === b.id;
        const doorway = a && b && a.id !== b.id && world.OPEN.has(key);
        if (same) continue;
        if (doorway) {
          if (hasWallAt(x, z) && !reportedDoors.has(key)) {
            reportedDoors.add(key);
            fail(`the doorway ${key} between ${a.id} and ${b.id} is blocked by a wall`);
          }
          continue;
        }
        if (!hasWallAt(x, z)) {
          fail(`the wall between ${a?.id || "void"} and ${b?.id || "void"} is missing at ${x},${z}`);
        }
      }
    }
  }
}
console.log(`✓ ${walls.length} wall slabs, every hall is sealed`);

/* the vendored three.js build has to exist */
for (const asset of [
  "public/vendor/three/three.module.js",
  "public/vendor/socket.io.min.js",
  "public/index.html",
  "public/css/style.css",
]) {
  if (!existsSync(join(root, asset))) fail(`missing asset: ${asset}`);
}

/* ------------------------------------------------------------------ */
/* 3. module graph + dom contract                                      */
/* ------------------------------------------------------------------ */
const clientDir = join(root, "public/js");
const clientFiles = readdirSync(clientDir).filter((f) => f.endsWith(".js"));

/** Collects the names a module exports. */
function exportsOf(file) {
  const src = readFileSync(file, "utf8");
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(src)) names.add("default");
  return names;
}

const exportCache = new Map();
for (const file of clientFiles) {
  const full = join(clientDir, file);
  if (!exportCache.has(full)) exportCache.set(full, exportsOf(full));
}

for (const file of clientFiles) {
  const full = join(clientDir, file);
  const src = readFileSync(full, "utf8");
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    // bare "three/addons/..." specifiers map to the vendored copy (see the importmap)
    const target = m[3].startsWith("three/addons/")
      ? join(root, "public", "vendor", "three", "addons", m[3].slice("three/addons/".length))
      : join(clientDir, m[3].replace(/^\.\//, ""));
    if (!existsSync(target)) {
      fail(`${file} imports "${m[3]}" which does not exist`);
      continue;
    }
    if (!exportCache.has(target)) exportCache.set(target, exportsOf(target));
    const available = exportCache.get(target);
    for (const part of m[2].split(",")) {
      const name = part.split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!available.has(name)) {
        fail(`${file} imports "${name}" from "${m[3]}" but that module does not export it`);
      }
    }
  }
}

/* every element the client looks up has to exist in the page */
const html = readFileSync(join(root, "public/index.html"), "utf8");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
if (htmlIds.size !== [...html.matchAll(/id="([^"]+)"/g)].length) {
  fail("index.html contains duplicate element ids");
}
for (const file of clientFiles) {
  const src = readFileSync(join(clientDir, file), "utf8");
  for (const m of src.matchAll(/getElementById\("([^"]+)"\)/g)) {
    const id = m[1];
    if (htmlIds.has(id)) continue;
    // ids that are created on the fly live in a template inside the same file
    if (new RegExp(`id="${id}"`).test(src)) continue;
    fail(`${file} looks up the element #${id} which is not in index.html`);
  }
}
console.log(`✓ ${clientFiles.length} client modules resolve, the dom contract holds`);

/* ------------------------------------------------------------------ */
console.log("");
for (const w of warnings) console.log(`⚠ ${w}`);
if (problems.length) {
  console.log("");
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} problem(s) found`);
  process.exit(1);
}
console.log("✓ museum data is consistent — all good");
