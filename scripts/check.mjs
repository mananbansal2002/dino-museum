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
    // headless Chrome profiles from test runs are not project code
    if (entry.startsWith("prof-")) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue; // dangling symlink or a file deleted mid-walk
    }
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

/* placements: every exhibit is a framed image panel on a plinth */
const placed = new Set();
const footprints = [];
const panels = new Map((world.EXHIBIT_PANELS || []).map((p) => [p.id, p]));
for (const p of PLACEMENTS) {
  if (!SPECIES[p.id]) fail(`placement references unknown species "${p.id}"`);
  if (placed.has(p.id)) fail(`species "${p.id}" is placed twice`);
  placed.add(p.id);

  const room = roomAt(p.x, p.z);
  if (!room) {
    fail(`placement ${p.id} at ${p.x},${p.z} is inside a wall`);
    continue;
  }
  const panel = panels.get(p.id);
  if (!panel) {
    fail(`placement ${p.id} has no image panel`);
    continue;
  }
  if (!(panel.w >= 1.5 && panel.w <= 4.6)) fail(`panel ${p.id} has an odd width ${panel.w}`);
  // the whole plinth has to stand on the floor of a single room
  for (const [cx, cz] of [
    [panel.minX, panel.minZ],
    [panel.maxX, panel.minZ],
    [panel.minX, panel.maxZ],
    [panel.maxX, panel.maxZ],
  ]) {
    const r = roomAt(cx, cz);
    if (!r || r.id !== room.id) {
      fail(`panel ${p.id} at ${p.x},${p.z} clips a wall near ${cx.toFixed(1)},${cz.toFixed(1)}`);
      break;
    }
  }
  footprints.push({ id: p.id, minX: panel.minX, maxX: panel.maxX, minZ: panel.minZ, maxZ: panel.maxZ });
}
const unplaced = SPECIES_LIST.filter((s) => !placed.has(s.id)).map((s) => s.id);
if (unplaced.length) warn(`not on the floor plan: ${unplaced.join(", ")}`);
console.log(`✓ ${PLACEMENTS.length} exhibit panels on the floor plan`);

/* world.js must not need the procedural dinosaur models any more */
if (/from\s+["']\.\/dinos\.js["']/.test(readFileSync(join(root, "public/js/world.js"), "utf8"))) {
  fail("world.js still imports dinos.js");
}

/* two exhibits must not share the same spot */
for (let i = 0; i < PLACEMENTS.length; i++) {
  for (let j = i + 1; j < PLACEMENTS.length; j++) {
    const a = PLACEMENTS[i];
    const b = PLACEMENTS[j];
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < 5) fail(`exhibits ${a.id} and ${b.id} are only ${d.toFixed(1)}m apart`);
  }
}

/* two panels must not stand inside each other */
for (let i = 0; i < footprints.length; i++) {
  for (let j = i + 1; j < footprints.length; j++) {
    const a = footprints[i];
    const b = footprints[j];
    const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
    if (ox > -0.8 && oz > -0.8) {
      fail(`panels ${a.id} and ${b.id} overlap or leave no gap (${ox.toFixed(1)}m x ${oz.toFixed(1)}m)`);
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
  fail(`${exhibitPoints} exhibit points for ${PLACEMENTS.length} exhibits`);
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

/* collision has to agree with the drawn walls: no slab between two tiles
   that resolveCollision lets you walk between, and no invisible walls */
{
  const { passable, resolveCollision } = world;
  let slabsChecked = 0;
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      if (isSolid(c, r)) continue;
      for (const [dc, dr] of [
        [1, 0],
        [0, 1],
      ]) {
        const nc = c + dc;
        const nr = r + dr;
        if (isSolid(nc, nr)) continue;
        const bx = dc ? g2w(c) + CELL / 2 : g2w(c);
        const bz = dr ? g2z(r) + CELL / 2 : g2z(r);
        const slab = hasWallAt(bx, bz);
        const open = passable(c, r, nc, nr);
        if (slab && open) fail(`a wall slab at ${bx},${bz} separates tiles ${c},${r} and ${nc},${nr} that collision treats as passable`);
        if (!slab && !open) fail(`an invisible wall blocks ${c},${r} -> ${nc},${nr}`);
        if (!slab) continue;
        slabsChecked++;
        // walk into the middle of the slab from both sides, with a small and
        // with a huge (slow frame) step: the visitor must stay on its side
        const R = 0.52;
        for (const dir of [-1, 1]) {
          for (const [step, withPrev] of [
            [0.4, false],
            [0.4, true],
            [2.5, true],
          ]) {
            const from = [bx - dc * dir * (R + 0.3), bz - dr * dir * (R + 0.3)];
            const to = [from[0] + dc * dir * step, from[1] + dr * dir * step];
            const [x, z] = withPrev
              ? resolveCollision(to[0], to[1], R, from[0], from[1])
              : resolveCollision(to[0], to[1], R);
            const side = dc ? (x - bx) * -dir : (z - bz) * -dir;
            if (side < R + 0.19) {
              fail(`resolveCollision lets a visitor through the wall at ${bx},${bz} (step ${step})`);
            }
          }
        }
      }
    }
  }
  console.log(`✓ ${slabsChecked} internal wall slabs block movement, doorways stay open`);
}

/* the ice cream court is the reward at the end of the tour */
{
  const spawnRoom = roomAt(spawn.x, spawn.z);
  const court = ROOMS.find((r) => r.id === "court");
  if (!court) fail("there is no ice cream court");
  else {
    const courtTiles = [];
    for (let c = court.cols[0]; c <= court.cols[1]; c++) {
      for (let r = court.rows[0]; r <= court.rows[1]; r++) courtTiles.push([c, r]);
    }
    // not next to the entrance
    for (const [c, r] of courtTiles) {
      for (const [dc, dr] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const n = world.roomAt(g2w(c + dc), g2z(r + dr));
        if (n && n.id === spawnRoom.id) fail(`the ice cream court touches the ${spawnRoom.name} at ${c},${r}`);
      }
    }
    // reachable only through at least one exhibit hall
    const halls = new Set(world.EXHIBIT_HALLS || []);
    if (!halls.size) fail("world.js does not export EXHIBIT_HALLS");
    const roomSeen = new Set([spawnRoom.id]);
    const rq = [spawnRoom];
    while (rq.length) {
      const room = rq.shift();
      for (let c = room.cols[0]; c <= room.cols[1]; c++) {
        for (let r = room.rows[0]; r <= room.rows[1]; r++) {
          for (const [dc, dr] of [
            [1, 0],
            [-1, 0],
            [0, 1],
            [0, -1],
          ]) {
            if (!world.passable(c, r, c + dc, r + dr)) continue;
            const n = world.roomAt(g2w(c + dc), g2z(r + dr));
            if (!n || roomSeen.has(n.id) || halls.has(n.id)) continue;
            roomSeen.add(n.id);
            rq.push(n);
          }
        }
      }
    }
    if (roomSeen.has("court")) fail("the ice cream court can be reached from the entrance without visiting a hall");

    // no line of sight from the spawn point to any part of the court
    const tileOf = (x, z) => [world.w2g(x), world.w2gz(z)];
    const stepOk = (a, b) => {
      if (a[0] === b[0] && a[1] === b[1]) return true;
      const dc = b[0] - a[0];
      const dr = b[1] - a[1];
      if (Math.abs(dc) + Math.abs(dr) === 1) return world.passable(a[0], a[1], b[0], b[1]);
      // corner crossing: visible if either way round the corner is open
      const viaC = [b[0], a[1]];
      const viaR = [a[0], b[1]];
      return (
        (world.passable(a[0], a[1], viaC[0], viaC[1]) && world.passable(viaC[0], viaC[1], b[0], b[1])) ||
        (world.passable(a[0], a[1], viaR[0], viaR[1]) && world.passable(viaR[0], viaR[1], b[0], b[1]))
      );
    };
    const lineOfSight = (x0, z0, x1, z1) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.ceil(len / 0.2);
      let prev = tileOf(x0, z0);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const cur = tileOf(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
        if (!stepOk(prev, cur)) return false;
        prev = cur;
      }
      return true;
    };
    let rays = 0;
    for (const [c, r] of courtTiles) {
      for (const [ox, oz] of [
        [0, 0],
        [-2.8, -2.8],
        [2.8, -2.8],
        [-2.8, 2.8],
        [2.8, 2.8],
      ]) {
        rays++;
        if (lineOfSight(spawn.x, spawn.z, g2w(c) + ox, g2z(r) + oz)) {
          fail(`the ice cream court tile ${c},${r} is visible from the spawn point`);
          break;
        }
      }
    }
    // the guard itself has to work: the spawn room can see itself
    if (!lineOfSight(spawn.x, spawn.z, g2w(spawnRoom.cols[0]), g2z(spawnRoom.rows[0]))) {
      fail("line-of-sight check is broken (spawn cannot see its own room)");
    }
    console.log(`✓ the ice cream court is hidden from the entrance (${rays} sight lines blocked)`);
  }
}

/* seats: walkable, reachable, clear of exhibits, facing what they look at */
{
  const seats = interactables.filter((i) => i.type === "seat");
  if (!seats.length) fail("there are no seats");
  for (const s of seats) {
    const c = world.w2g(s.x);
    const r = world.w2gz(s.z);
    if (isSolid(c, r)) fail(`seat ${s.id} is inside a wall`);
    else if (!seenCells.has(`${c},${r}`)) fail(`seat ${s.id} is not reachable`);
    if (!s.seat || !Number.isFinite(s.seat.y) || !Number.isFinite(s.seat.ry)) fail(`seat ${s.id} has no seat pose`);
    if (s.radius < 0.5 || s.radius > 1.5) fail(`seat ${s.id} has an odd radius ${s.radius}`);
    // the visitor must be able to stand at the seat
    const [rx, rz] = world.resolveCollision(s.x, s.z, 0.52);
    if (Math.hypot(rx - s.x, rz - s.z) > s.radius - 0.1) fail(`seat ${s.id} is too close to a wall to sit on`);
    for (const f of footprints) {
      if (s.x > f.minX - 0.4 && s.x < f.maxX + 0.4 && s.z > f.minZ - 0.4 && s.z < f.maxZ + 0.4) {
        fail(`seat ${s.id} stands in the exhibit ${f.id}`);
      }
    }
    if (s.area === "theatre") {
      const room = roomAt(s.x, s.z);
      if (!room || room.id !== "theater") fail(`theatre seat ${s.id} is outside the theatre`);
      const S = world.SCREEN;
      const want = Math.atan2(S.x - s.x, S.z - s.z);
      const diff = Math.abs(((s.seat.ry - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (diff > 0.05) fail(`theatre seat ${s.id} does not face the screen`);
    }
  }
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      if (Math.hypot(seats[i].x - seats[j].x, seats[i].z - seats[j].z) < 1.1) {
        fail(`seats ${seats[i].id} and ${seats[j].id} overlap`);
      }
    }
  }
  const battle = interactables.find((i) => i.type === "battle");
  if (!battle || roomAt(battle.x, battle.z)?.id !== "theater") fail("the battle screening console is not in the theatre");
  console.log(`✓ ${seats.length} seats are walkable and reachable`);
}

/* fossil display spots in front of the panels: on the floor of the hall,
   clear of plinths, seats, other displays and every point of interest */
{
  const displays = world.DISPLAYS || [];
  if (displays.length < PLACEMENTS.length * 0.8) {
    fail(`only ${displays.length} display spots for ${PLACEMENTS.length} exhibits`);
  }
  const ids = new Set();
  for (const d of displays) {
    if (ids.has(d.speciesId)) fail(`two display spots for ${d.speciesId}`);
    ids.add(d.speciesId);
    if (!(d.maxLength > 0 && d.maxHeight > 0)) fail(`display ${d.speciesId} has no size`);
    const b = d.bounds;
    const panelRoom = roomAt(PLACEMENTS.find((p) => p.id === d.speciesId).x, PLACEMENTS.find((p) => p.id === d.speciesId).z);
    for (const [cx, cz] of [
      [b.minX - 1, b.minZ - 1],
      [b.maxX + 1, b.minZ - 1],
      [b.minX - 1, b.maxZ + 1],
      [b.maxX + 1, b.maxZ + 1],
    ]) {
      const r = roomAt(cx, cz);
      if (!r || r.id !== panelRoom.id) {
        fail(`display ${d.speciesId} is too close to a wall or doorway`);
        break;
      }
    }
    for (const f of footprints) {
      if (f.minX < b.maxX + 0.9 && f.maxX > b.minX - 0.9 && f.minZ < b.maxZ + 0.9 && f.maxZ > b.minZ - 0.9) {
        if (f.id !== d.speciesId) fail(`display ${d.speciesId} crowds the panel ${f.id}`);
      }
    }
    for (const it of interactables) {
      if (it.exhibitId === d.speciesId && it.type === "exhibit") continue;
      if (it.x > b.minX - 0.8 && it.x < b.maxX + 0.8 && it.z > b.minZ - 0.8 && it.z < b.maxZ + 0.8) {
        fail(`display ${d.speciesId} covers the interactable ${it.id}`);
      }
    }
  }
  console.log(`✓ ${displays.length} fossil display spots are clear`);
}

/* era windows */
{
  const eras = world.ERAS || {};
  for (const [id, era] of Object.entries(eras)) {
    if (!ROOMS.some((r) => r.id === era.hall)) fail(`era ${id} lives in an unknown hall ${era.hall}`);
    const it = interactables.find((i) => i.type === "era" && i.era === id);
    if (!it) fail(`era ${id} has no window`);
    else if (roomAt(it.x, it.z)?.id !== era.hall) fail(`the window to the ${era.name} is not in the ${era.hall} hall`);
  }
  console.log(`✓ ${Object.keys(eras).length} era windows`);
}

/* fine-grained walk test with the real collision code: every point of
   interest must be reachable on foot from the spawn point */
{
  const R = 0.52;
  const STEP = 0.5;
  const x0 = -(GRID_W * CELL) / 2;
  const z0 = -(GRID_H * CELL) / 2;
  const nx = Math.round((GRID_W * CELL) / STEP);
  const nz = Math.round((GRID_H * CELL) / STEP);
  const free = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + (i + 0.5) * STEP;
      const z = z0 + (j + 0.5) * STEP;
      if (isSolid(world.w2g(x), world.w2gz(z))) continue;
      const [rx, rz] = world.resolveCollision(x, z, R);
      if (Math.abs(rx - x) < 1e-6 && Math.abs(rz - z) < 1e-6) free[j * nx + i] = 1;
    }
  }
  const idx = (x, z) => {
    const i = Math.floor((x - x0) / STEP);
    const j = Math.floor((z - z0) / STEP);
    return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i;
  };
  const reached = new Uint8Array(nx * nz);
  const s0 = idx(spawn.x, spawn.z);
  if (s0 < 0 || !free[s0]) fail("the visitor cannot stand on the spawn point");
  else {
    const q = [s0];
    reached[s0] = 1;
    while (q.length) {
      const k = q.pop();
      const i = k % nx;
      const j = (k - i) / nx;
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const kk = jj * nx + ii;
        if (!free[kk] || reached[kk]) continue;
        reached[kk] = 1;
        q.push(kk);
      }
    }
    const reachableNear = (x, z, radius) => {
      const n = Math.ceil(radius / STEP);
      for (let dj = -n; dj <= n; dj++) {
        for (let di = -n; di <= n; di++) {
          const px = x + di * STEP;
          const pz = z + dj * STEP;
          if (Math.hypot(px - x, pz - z) > radius - 0.05) continue;
          const k = idx(px, pz);
          if (k >= 0 && reached[k]) return true;
        }
      }
      return false;
    };
    let unreachable = 0;
    for (const it of interactables) {
      if (!reachableNear(it.x, it.z, it.radius)) {
        unreachable++;
        fail(`the interactable ${it.id} cannot be reached on foot`);
      }
    }
    for (const room of ROOMS) {
      const cx = (g2w(room.cols[0]) + g2w(room.cols[1])) / 2;
      const cz = (g2z(room.rows[0]) + g2z(room.rows[1])) / 2;
      if (!reachableNear(cx, cz, CELL)) fail(`the ${room.name} cannot be reached on foot`);
    }
    if (!unreachable) console.log(`✓ every point of interest is reachable on foot (collision walk test)`);
  }
}

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
