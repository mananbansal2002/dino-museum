/**
 * Ambient museum visitors: a small local crowd of realistic Rocketbox people
 * (MIT, /models/humans/*-real.glb) who look at the picture panels, clap at
 * the life-size dinosaurs, rest on the benches, catch a screening in the
 * theatre and stroll between the halls.
 *
 *   const crowd = createCrowd({ scene, world, camera, count: 12, quality });
 *   // every frame:
 *   crowd.update(dt, S.player?.state, remote.list);   // anything with { x, z }
 *   crowd.npcs        // live NPC records (state, x, z, goal...)
 *   crowd.debug()     // JSON-friendly snapshot
 *   crowd.dispose();
 *
 * - Not networked: every client runs its own crowd from a fixed seed, so the
 *   behaviour is stable run to run. NPCs carry no name tag or bubble: only
 *   real players are labelled, so friends stand out from background visitors.
 * - Navigation: a 0.5 m walkability grid built from world.js (rooms, doorways,
 *   wall slabs, plinths, furniture, 3D display cases, theatre seats), A* with
 *   a wall-clearance penalty, line-of-sight path smoothing, and the final
 *   steering always goes through resolveCollision(), so nobody walks through
 *   a wall or a plinth. world.js's OBSTACLES array grows at run time
 *   (livemodels pushes its plinths/vitrines into it): the grid is rebuilt
 *   when it changes.
 * - Manners: NPCs keep >= 0.8 m from each other and from players, slow down,
 *   wait and sidestep instead of pushing through, step aside when a player
 *   walks up to them, leave a spot a player lingers at, never pick a spot a
 *   player is standing at, and repath / quietly relocate out of view when
 *   stuck for more than 4 s.
 * - Cost: mixers tick every frame within 20 m of the camera, at 15 Hz up to
 *   45 m and not at all beyond; NPCs beyond 70 m are hidden. Geometry and
 *   textures are shared between clones; only the clothes / hair materials
 *   are cloned (one shader program for all of them). Shadows on high/ultra.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import * as W from "./world.js";

/* ------------------------------------------------------------------ */
/* tuning                                                               */
/* ------------------------------------------------------------------ */

const SEED = 0x5eed_d1a0;
const RES = 0.5; // nav grid resolution (m)
const NAV_R = 0.42; // clearance a nav cell keeps from walls / plinths
const BODY_R = 0.3; // collision radius when steering
const PERSONAL = 0.8; // minimum distance to anyone else
const WALL_HALF = 0.2; // world.js wall slabs are 0.4 m thick
const ANIM_NEAR = 20; // full-rate mixers
const ANIM_FAR = 45; // 15 Hz mixers up to here, frozen beyond
const HIDE_DIST = 70;
const STUCK_TIME = 4;
const PATHS_PER_FRAME = 2;
const COURT_UNLOCK = 420; // seconds before anyone wanders into the ice cream court (and then rarely)

const ASSETS = {
  male: { url: "/models/humans/male-real.glb", walk: 1.0 },
  female: { url: "/models/humans/female-real.glb", walk: 1.2 },
};

/**
 * Outfits as [hue rotation (rad), saturation, value] applied to the authored
 * texture: the male atlas has a pale blue shirt and dark jeans, the female
 * one a pink blouse and mid-blue jeans. 0,1,1 = as authored.
 */
const TOPS = {
  male: [
    [0, 1, 1], // pale blue
    [0, 0.05, 1.12], // white
    [0, 0.12, 0.62], // grey
    [0.1, 1.6, 0.5], // navy
    [2.9, 1.5, 0.95], // sand
    [-1.9, 1.8, 0.8], // olive / green
    [1.1, 1.5, 0.75], // plum
    [2.4, 2.4, 0.62], // rust
    [0, 0.08, 0.32], // charcoal
    [-0.6, 1.8, 0.85], // teal
  ],
  female: [
    [0, 1, 1], // pink
    [2.6, 1.1, 0.9], // teal
    [-2.7, 1.0, 0.8], // green
    [0.9, 1.0, 0.95], // coral
    [-1.3, 1.1, 0.75], // blue
    [0, 0.06, 1.1], // white
    [0, 0.1, 0.4], // black
    [1.5, 1.2, 1.05], // mustard
    [-0.5, 0.9, 0.6], // purple
    [0.35, 0.8, 0.55], // burgundy
  ],
};
const BOTTOMS = {
  male: [[0, 1, 1], [0, 1.1, 1.5], [0, 0.1, 0.55], [3.1, 0.8, 2.2], [0, 0.12, 1.6], [3.0, 0.9, 1.4]],
  female: [[0, 1, 1], [0, 1.1, 0.55], [0, 0.08, 0.38], [3.1, 0.7, 1.35], [0, 0.1, 0.9], [0.2, 1.2, 0.75]],
};
const HAIR = [0xffffff, 0xd9c8b8, 0x8a6a52, 0x5a4636, 0x3a302a, 0x26211e, 0xa86b4c, 0xc9c3bd];

const QUALITY_COUNT = { low: 5, medium: 9, med: 9, high: null, ultra: null };

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TAU = Math.PI * 2;
const wrapAngle = (a) => {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ------------------------------------------------------------------ */
/* navigation grid                                                      */
/* ------------------------------------------------------------------ */

function createNav(world) {
  const X0 = -(W.GRID_W * W.CELL) / 2;
  const Z0 = -(W.GRID_H * W.CELL) / 2;
  const NX = Math.round((W.GRID_W * W.CELL) / RES);
  const NZ = Math.round((W.GRID_H * W.CELL) / RES);
  const N = NX * NZ;
  const wallMask = new Uint8Array(N); // 1 = blocked by structure (static)
  const mask = new Uint8Array(N); // 1 = blocked (structure + obstacles)
  const clear = new Float32Array(N); // metres to the nearest blocked cell
  const roomIdx = new Int16Array(N).fill(-1);
  const roomIds = W.ROOMS.map((r) => r.id);

  const cx = (i) => X0 + (i + 0.5) * RES;
  const cz = (j) => Z0 + (j + 0.5) * RES;
  const ix = (x) => Math.floor((x - X0) / RES);
  const jz = (z) => Math.floor((z - Z0) / RES);
  const inside = (i, j) => i >= 0 && j >= 0 && i < NX && j < NZ;

  // walls between 6 m cells, precomputed once (passable() builds string keys)
  const floor = (c, r) => !W.isSolid(c, r);
  const wallEdge = (c, r, nc, nr) => {
    const a = floor(c, r);
    const b = floor(nc, nr);
    if (a !== b) return true;
    if (!a) return false;
    return !W.passable(c, r, nc, nr);
  };
  const GW = W.GRID_W;
  const GH = W.GRID_H;
  const edges = new Uint8Array(GW * GH); // bit0 W, bit1 E, bit2 N(-z), bit3 S(+z), bits4..7 corners
  for (let r = 0; r < GH; r++) {
    for (let c = 0; c < GW; c++) {
      if (!floor(c, r)) continue;
      let b = 0;
      if (wallEdge(c, r, c - 1, r)) b |= 1;
      if (wallEdge(c, r, c + 1, r)) b |= 2;
      if (wallEdge(c, r, c, r - 1)) b |= 4;
      if (wallEdge(c, r, c, r + 1)) b |= 8;
      let k = 0;
      for (const sz of [-1, 1]) {
        for (const sx of [-1, 1]) {
          if (wallEdge(c + sx, r, c + sx, r + sz) || wallEdge(c, r + sz, c + sx, r + sz)) b |= 16 << k;
          k++;
        }
      }
      edges[r * GW + c] = b;
    }
  }
  const d = NAV_R + WALL_HALF;
  for (let j = 0; j < NZ; j++) {
    const z = cz(j);
    for (let i = 0; i < NX; i++) {
      const x = cx(i);
      const c = W.w2g(x);
      const r = W.w2gz(z);
      const k = j * NX + i;
      if (W.isSolid(c, r)) {
        wallMask[k] = 1;
        continue;
      }
      const room = W.roomAt(x, z);
      if (room) roomIdx[k] = roomIds.indexOf(room.id);
      const lx = x - (W.g2w(c) - W.CELL / 2);
      const lz = z - (W.g2z(r) - W.CELL / 2);
      const e = edges[r * GW + c];
      let blocked =
        (lx < d && e & 1) || (W.CELL - lx < d && e & 2) || (lz < d && e & 4) || (W.CELL - lz < d && e & 8);
      if (!blocked) {
        let q = 0;
        for (const sz of [-1, 1]) {
          for (const sx of [-1, 1]) {
            if (e & (16 << q)) {
              const ddx = sx < 0 ? lx : W.CELL - lx;
              const ddz = sz < 0 ? lz : W.CELL - lz;
              if (ddx * ddx + ddz * ddz < d * d) blocked = true;
            }
            q++;
          }
        }
      }
      if (blocked) wallMask[k] = 1;
    }
  }

  const rasterBox = (minX, maxX, minZ, maxZ, pad) => {
    const i0 = Math.max(0, ix(minX - pad));
    const i1 = Math.min(NX - 1, ix(maxX + pad));
    const j0 = Math.max(0, jz(minZ - pad));
    const j1 = Math.min(NZ - 1, jz(maxZ + pad));
    for (let j = j0; j <= j1; j++) {
      const z = cz(j);
      for (let i = i0; i <= i1; i++) {
        const x = cx(i);
        const qx = clamp(x, minX, maxX);
        const qz = clamp(z, minZ, maxZ);
        if ((x - qx) ** 2 + (z - qz) ** 2 < pad * pad) mask[j * NX + i] = 1;
      }
    }
  };
  const rasterCircle = (x0, z0, r, pad) => {
    const R = r + pad;
    const i0 = Math.max(0, ix(x0 - R));
    const i1 = Math.min(NX - 1, ix(x0 + R));
    const j0 = Math.max(0, jz(z0 - R));
    const j1 = Math.min(NZ - 1, jz(z0 + R));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if ((cx(i) - x0) ** 2 + (cz(j) - z0) ** 2 < R * R) mask[j * NX + i] = 1;
      }
    }
  };
  const rasterRotRect = (x0, z0, ry, lx0, lx1, lz0, lz1, pad) => {
    const R = Math.max(Math.abs(lx0), Math.abs(lx1), Math.abs(lz0), Math.abs(lz1)) + pad + RES;
    const s = Math.sin(ry);
    const c = Math.cos(ry);
    for (let j = Math.max(0, jz(z0 - R)); j <= Math.min(NZ - 1, jz(z0 + R)); j++) {
      for (let i = Math.max(0, ix(x0 - R)); i <= Math.min(NX - 1, ix(x0 + R)); i++) {
        const dx = cx(i) - x0;
        const dz = cz(j) - z0;
        // world -> local (object turned by ry about y): lx = dx*c - dz*s, lz = dx*s + dz*c
        const lx = dx * c - dz * s;
        const lz = dx * s + dz * c;
        const qx = clamp(lx, lx0, lx1);
        const qz = clamp(lz, lz0, lz1);
        if ((lx - qx) ** 2 + (lz - qz) ** 2 < pad * pad) mask[j * NX + i] = 1;
      }
    }
  };

  let signature = "";
  const obstacleSig = () =>
    `${(W.OBSTACLES || []).length}/${(W.PROP_OBSTACLES || []).length}/${(world?.displays || W.DISPLAYS || []).length}`;

  function rebuild() {
    signature = obstacleSig();
    mask.set(wallMask);
    for (const list of [W.OBSTACLES || [], W.PROP_OBSTACLES || []]) {
      for (const o of list) {
        if (Number.isFinite(o.r)) rasterCircle(o.x, o.z, o.r, NAV_R);
        else rasterBox(o.minX, o.maxX, o.minZ, o.maxZ, NAV_R);
      }
    }
    for (const dsp of world?.displays || W.DISPLAYS || []) {
      const b = dsp.bounds;
      if (b) rasterBox(b.minX, b.maxX, b.minZ, b.maxZ, NAV_R);
    }
    // theatre seats are walkable for players, but walking *through* a row
    // looks wrong: keep NPCs in the aisles and the gaps between rows
    for (const s of W.THEATRE_SEATS || []) rasterRotRect(s.x, s.z, s.ry, -0.62, 0.62, -0.55, 0.5, NAV_R - 0.1);
    // clearance: two-pass chamfer distance transform
    const BIG = 1e6;
    for (let k = 0; k < N; k++) clear[k] = mask[k] ? 0 : BIG;
    const D1 = RES;
    const D2 = RES * Math.SQRT2;
    for (let j = 0; j < NZ; j++) {
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        if (!clear[k]) continue;
        let v = clear[k];
        if (i > 0) v = Math.min(v, clear[k - 1] + D1);
        if (j > 0) {
          v = Math.min(v, clear[k - NX] + D1);
          if (i > 0) v = Math.min(v, clear[k - NX - 1] + D2);
          if (i < NX - 1) v = Math.min(v, clear[k - NX + 1] + D2);
        }
        clear[k] = v;
      }
    }
    for (let j = NZ - 1; j >= 0; j--) {
      for (let i = NX - 1; i >= 0; i--) {
        const k = j * NX + i;
        if (!clear[k]) continue;
        let v = clear[k];
        if (i < NX - 1) v = Math.min(v, clear[k + 1] + D1);
        if (j < NZ - 1) {
          v = Math.min(v, clear[k + NX] + D1);
          if (i < NX - 1) v = Math.min(v, clear[k + NX + 1] + D2);
          if (i > 0) v = Math.min(v, clear[k + NX - 1] + D2);
        }
        clear[k] = v;
      }
    }
  }
  rebuild();

  const idx = (x, z) => {
    const i = ix(x);
    const j = jz(z);
    return inside(i, j) ? j * NX + i : -1;
  };
  const walkable = (x, z) => {
    const k = idx(x, z);
    return k >= 0 && !mask[k];
  };
  const clearance = (x, z) => {
    const k = idx(x, z);
    return k >= 0 ? clear[k] : 0;
  };

  /** nearest walkable cell to (x, z) within maxR metres, or -1 */
  function nearestFree(x, z, maxR = 4) {
    const i0 = ix(x);
    const j0 = jz(z);
    if (inside(i0, j0) && !mask[j0 * NX + i0]) return j0 * NX + i0;
    const rings = Math.ceil(maxR / RES);
    let best = -1;
    let bestD = Infinity;
    for (let rr = 1; rr <= rings; rr++) {
      for (let dj = -rr; dj <= rr; dj++) {
        for (let di = -rr; di <= rr; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== rr) continue;
          const i = i0 + di;
          const j = j0 + dj;
          if (!inside(i, j) || mask[j * NX + i]) continue;
          const dd = (cx(i) - x) ** 2 + (cz(j) - z) ** 2;
          if (dd < bestD) {
            bestD = dd;
            best = j * NX + i;
          }
        }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  /** straight walk from a to b stays on free cells */
  function lineFree(ax, az, bx, bz) {
    const L = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(L / (RES * 0.5)));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      if (!walkable(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }

  // A* scratch
  const g = new Float32Array(N);
  const parent = new Int32Array(N);
  const stamp = new Uint32Array(N);
  const closed = new Uint32Array(N);
  let search = 0;
  const heap = new Int32Array(N);
  const fval = new Float32Array(N);
  let hsize = 0;
  const hpush = (k) => {
    let p = hsize++;
    heap[p] = k;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (fval[heap[q]] <= fval[heap[p]]) break;
      const t = heap[q];
      heap[q] = heap[p];
      heap[p] = t;
      p = q;
    }
  };
  const hpop = () => {
    const top = heap[0];
    heap[0] = heap[--hsize];
    let p = 0;
    for (;;) {
      const l = p * 2 + 1;
      const r = l + 1;
      let m = p;
      if (l < hsize && fval[heap[l]] < fval[heap[m]]) m = l;
      if (r < hsize && fval[heap[r]] < fval[heap[m]]) m = r;
      if (m === p) break;
      const t = heap[m];
      heap[m] = heap[p];
      heap[p] = t;
      p = m;
    }
    return top;
  };
  const NB = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ];
  let expandedTotal = 0;

  /**
   * Path from (ax, az) to (bx, bz) as [[x, z], ...] (smoothed, ending exactly
   * at b), or null. Cells near walls / plinths cost extra so paths keep to
   * the middle of corridors and doorways.
   */
  function findPath(ax, az, bx, bz, maxExpand = 70000) {
    const s = nearestFree(ax, az, 3);
    const t = nearestFree(bx, bz, 4);
    if (s < 0 || t < 0) return null;
    search++;
    hsize = 0;
    const ti = t % NX;
    const tj = (t / NX) | 0;
    const h = (k) => {
      const dx = Math.abs((k % NX) - ti);
      const dz = Math.abs(((k / NX) | 0) - tj);
      return (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz)) * RES * 1.25; // weighted A*: a touch greedy, far fewer expansions
    };
    g[s] = 0;
    parent[s] = -1;
    stamp[s] = search;
    fval[s] = h(s);
    hpush(s);
    let found = false;
    let expanded = 0;
    while (hsize) {
      const k = hpop();
      if (closed[k] === search) continue;
      closed[k] = search;
      if (k === t) {
        found = true;
        break;
      }
      if (++expanded > maxExpand) break;
      const i = k % NX;
      const j = (k / NX) | 0;
      for (const [di, dj, w] of NB) {
        const ni = i + di;
        const nj = j + dj;
        if (!inside(ni, nj)) continue;
        const nk = nj * NX + ni;
        if (mask[nk] || closed[nk] === search) continue;
        if (di && dj && (mask[j * NX + ni] || mask[nj * NX + i])) continue; // no corner cutting
        const c = clear[nk];
        const pen = c < 1.6 ? (1.6 - c) * 1.2 : 0;
        const ng = g[k] + w * RES * (1 + pen);
        if (stamp[nk] === search && ng >= g[nk]) continue;
        stamp[nk] = search;
        g[nk] = ng;
        parent[nk] = k;
        fval[nk] = ng + h(nk);
        hpush(nk);
      }
    }
    expandedTotal += expanded;
    if (!found) return null;
    const raw = [];
    for (let k = t; k >= 0; k = parent[k]) raw.push([cx(k % NX), cz((k / NX) | 0)]);
    raw.reverse();
    // string pulling: keep the farthest waypoint still in line of sight
    const out = [];
    let ax0 = ax;
    let az0 = az;
    let a = 0;
    while (a < raw.length - 1) {
      let b = raw.length - 1;
      while (b > a + 1 && !lineFree(ax0, az0, raw[b][0], raw[b][1])) b--;
      out.push(raw[b]);
      ax0 = raw[b][0];
      az0 = raw[b][1];
      a = b;
    }
    // the exact goal (may sit just off the grid, e.g. in front of a seat)
    const last = out[out.length - 1] || [ax, az];
    if (Math.hypot(last[0] - bx, last[1] - bz) > 0.05) out.push([bx, bz]);
    return out;
  }

  /** free cells with at least minClear metres of room, grouped by room id */
  function spots(minClear) {
    const byRoom = new Map();
    for (let k = 0; k < N; k++) {
      if (mask[k] || clear[k] < minClear || roomIdx[k] < 0) continue;
      const id = roomIds[roomIdx[k]];
      if (!byRoom.has(id)) byRoom.set(id, []);
      byRoom.get(id).push(k);
    }
    return byRoom;
  }

  return {
    NX,
    NZ,
    RES,
    rebuild,
    changed: () => obstacleSig() !== signature,
    walkable,
    clearance,
    lineFree,
    findPath,
    spots,
    cellPos: (k) => [cx(k % NX), cz((k / NX) | 0)],
    roomIdAt: (x, z) => {
      const k = idx(x, z);
      return k >= 0 && roomIdx[k] >= 0 ? roomIds[roomIdx[k]] : null;
    },
    get expanded() {
      return expandedTotal;
    },
  };
}

/* ------------------------------------------------------------------ */
/* clothes recolouring                                                  */
/* ------------------------------------------------------------------ */

/**
 * The Rocketbox body texture is an atlas of shirt, trousers, shoes and the
 * bare forearms / hands. Top and trousers are recoloured separately in the
 * shader (YIQ hue rotation + saturation + value), told apart by their UV
 * zones in each atlas; skin zones are only recoloured where the texel is
 * clearly not skin (YCbCr test), so cuffs follow the shirt and hands keep
 * their colour. Two programs in all (one per atlas layout).
 */
function makeClothesMaterial(base, top, bottom, female) {
  const m = base.clone();
  const uniforms = {
    uTop: { value: new THREE.Vector3(...top) },
    uBottom: { value: new THREE.Vector3(...bottom) },
  };
  m.userData.crowdOutfit = uniforms;
  // UV zones (glTF uv: origin top-left of the image)
  const zones = female
    ? {
        bottoms: "uv.y > 0.565 && ( uv.x < 0.325 || uv.x > 0.672 )",
        skin: "( uv.y < 0.49 && ( uv.x < 0.235 || uv.x > 0.765 ) ) || ( uv.y > 0.44 && uv.y < 0.56 && abs( uv.x - 0.5 ) < 0.05 )",
      }
    : {
        bottoms: "uv.y < 0.44 && ( uv.x < 0.285 || uv.x > 0.715 )",
        skin: "uv.y > 0.725 && ( uv.x < 0.43 || uv.x > 0.57 )",
      };
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "void main() {",
        `uniform vec3 uTop;
uniform vec3 uBottom;
vec3 crowdHSV( vec3 c, vec3 k ) {
  float y = dot( c, vec3( 0.299, 0.587, 0.114 ) );
  float i = dot( c, vec3( 0.596, -0.274, -0.322 ) );
  float q = dot( c, vec3( 0.211, -0.523, 0.312 ) );
  float ch = cos( k.x ), sh = sin( k.x );
  float i2 = ( i * ch - q * sh ) * k.y;
  float q2 = ( i * sh + q * ch ) * k.y;
  return vec3( y + 0.956 * i2 + 0.621 * q2, y - 0.272 * i2 - 0.647 * q2, y - 1.106 * i2 + 1.703 * q2 ) * k.z;
}
vec3 crowdRecolor( vec3 lin, vec2 uv ) {
  vec3 c = pow( max( lin, vec3( 0.0 ) ), vec3( 1.0 / 2.2 ) );
  bool bottoms = ${zones.bottoms};
  vec3 o = crowdHSV( c, bottoms ? uBottom : uTop );
  if ( ${zones.skin} ) {
    float cb = 0.5 - 0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
    float cr = 0.5 + 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b;
    float skin = smoothstep( 0.28, 0.31, cb ) * ( 1.0 - smoothstep( 0.46, 0.49, cb ) )
               * smoothstep( 0.51, 0.54, cr ) * ( 1.0 - smoothstep( 0.625, 0.65, cr ) );
    o = mix( o, c, skin );
  }
  return pow( clamp( o, 0.0, 1.0 ), vec3( 2.2 ) );
}
void main() {`
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  sampledDiffuseColor.rgb = crowdRecolor( sampledDiffuseColor.rgb, vMapUv );
  diffuseColor *= sampledDiffuseColor;
#endif`
      );
  };
  m.customProgramCacheKey = () => (female ? "crowd-clothes-f1" : "crowd-clothes-m1");
  return m;
}

/* ------------------------------------------------------------------ */
/* the crowd                                                            */
/* ------------------------------------------------------------------ */

export function createCrowd({ scene, world, camera, count = 12, quality = "high" } = {}) {
  const q = String(quality || "high").toLowerCase();
  const total = QUALITY_COUNT[q] != null ? Math.min(count, QUALITY_COUNT[q]) : count;
  const shadows = q === "high" || q === "ultra";
  const rng = mulberry32(SEED);
  const rand = (a, b) => a + (b - a) * rng();
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];

  const root = new THREE.Group();
  root.name = "crowd";
  root.userData.surface = "skip"; // lookdev: leave these materials alone
  scene.add(root);

  const nav = createNav(world);
  const npcs = [];
  const taken = new Map(); // slot / seat key -> npc
  const pathQueue = [];
  const players = []; // [{x, z}] this frame
  let clock = 0;
  let disposed = false;
  let navCheckT = 0;
  const stats = { paths: 0, failedPaths: 0, teleports: 0, mixersTicked: 0, visible: 0 };

  /* ---------------- targets ---------------- */

  const panels = new Map((W.EXHIBIT_PANELS || []).map((p) => [p.id, p]));
  const interactables = world?.interactables || [];
  let exhibitSlots = [];
  let liveSlots = [];
  let wanderSpots = new Map();
  const seats = interactables
    .filter((it) => it.type === "seat" && it.seat)
    .map((it) => ({ key: it.id, area: it.area, x: it.seat.x, z: it.seat.z, y: it.seat.y, ry: it.seat.ry, row: Number((/:(\d+)-/.exec(it.id) || [])[1]) || 0 }));

  const okSpot = (x, z, room) => {
    if (!nav.walkable(x, z)) return false;
    if (room && nav.roomIdAt(x, z) !== room) return false;
    const [rx, rz] = W.resolveCollision(x, z, BODY_R + 0.05);
    return Math.abs(rx - x) < 1e-3 && Math.abs(rz - z) < 1e-3;
  };
  const spaced = (list, x, z, min) => list.every((s) => Math.hypot(s.x - x, s.z - z) >= min);

  function buildTargets() {
    exhibitSlots = [];
    for (const it of interactables) {
      if (it.type !== "exhibit") continue;
      const p = panels.get(it.exhibitId) || [...panels.values()].find((pp) => `exhibit:${pp.id}` === it.id);
      if (!p) continue;
      const fx = Math.sin(p.face);
      const fz = Math.cos(p.face);
      const rx = Math.cos(p.face);
      const rz = -Math.sin(p.face);
      const lat = Math.min(1.25, p.w / 2);
      const mine = [];
      for (const dist of [2.2, 2.7, 3.2, 3.8]) {
        for (const l of [0, -lat, lat]) {
          if (mine.length >= 3) break;
          const x = p.x + fx * dist + rx * l;
          const z = p.z + fz * dist + rz * l;
          if (!okSpot(x, z, p.room) || !spaced(mine, x, z, 1.0)) continue;
          // look at the picture (mounted above the display case)
          mine.push({ key: `ex:${p.id}:${mine.length}`, kind: "exhibit", group: p.id, x, z, face: Math.atan2(p.x - x, p.z - z), room: p.room });
        }
      }
      exhibitSlots.push(...mine);
    }
    liveSlots = [];
    for (const o of W.OBSTACLES || []) {
      if (!String(o.id).startsWith("live:") || String(o.id).startsWith("live:vitrine:")) continue;
      const mx = (o.minX + o.maxX) / 2;
      const mz = (o.minZ + o.maxZ) / 2;
      const room = nav.roomIdAt(mx, mz);
      const hx = (o.maxX - o.minX) / 2;
      const hz = (o.maxZ - o.minZ) / 2;
      const mine = [];
      const out = 1.4;
      for (const t of [0, -0.4, 0.4]) {
        for (const [sx, sz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
          if (mine.length >= 4) break;
          const x = sx ? mx + sx * (hx + out) : mx + t * hx * 2;
          const z = sz ? mz + sz * (hz + out) : mz + t * hz * 2;
          if (!okSpot(x, z, room) || !spaced(mine, x, z, 1.3)) continue;
          if (!spaced(exhibitSlots, x, z, 0.9)) continue;
          mine.push({ key: `live:${o.id}:${mine.length}`, kind: "live", group: o.id, x, z, face: Math.atan2(mx - x, mz - z), room });
        }
      }
      liveSlots.push(...mine);
    }
    wanderSpots = nav.spots(1.6);
  }
  buildTargets();

  const nearPlayer = (x, z, r) => players.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < r * r);
  const groupCount = (group) => {
    let n = 0;
    for (const v of npcs) if (v.goal?.group === group) n++;
    return n;
  };

  function wanderPoint(rooms, { from = null, min = 0 } = {}) {
    for (let tries = 0; tries < 12; tries++) {
      const list = wanderSpots.get(pick(rooms));
      if (!list || !list.length) continue;
      const [x, z] = nav.cellPos(pick(list));
      if (from && Math.hypot(x - from.x, z - from.z) < min) continue;
      if (!nearPlayer(x, z, 3) && npcs.every((o) => Math.hypot(o.x - x, o.z - z) > 1.5)) return { x, z };
    }
    return null;
  }

  /** A goal for npc: { kind, x, z, face, key?, seat? } */
  function pickGoal(n, allow = null) {
    const here = { x: n.x, z: n.z };
    // visitors mostly drift to the next thing nearby, now and then cross the museum
    const near = (s) => 0.002 + Math.exp(-Math.hypot(s.x - here.x, s.z - here.z) / 8);
    const free = (s) => !taken.has(s.key) && !nearPlayer(s.x, s.z, 2.6);
    const options = [];
    const add = (w, make) => w > 0 && options.push({ w, make });
    const weigh = (list) => list.reduce((s, x) => s + x.w, 0);
    const choose = (cands) => {
      const t = weigh(cands) * rng();
      let acc = 0;
      for (const c of cands) if ((acc += c.w) >= t) return c.s;
      return cands[cands.length - 1]?.s;
    };
    const want = (k) => !allow || allow === k;
    // an activity whose nearest option is across the museum is picked less often
    const reach = (c) => {
      let d = Infinity;
      for (const o of c) d = Math.min(d, Math.hypot(o.s.x - here.x, o.s.z - here.z));
      return allow ? 1 : 0.15 + 0.85 * Math.exp(-d / 25);
    };
    if (want("exhibit")) {
      const c = exhibitSlots
        .filter((s) => free(s) && s.group !== n.lastGroup && groupCount(s.group) < 2 && (s.room !== "court" || clock > COURT_UNLOCK))
        .map((s) => ({ s, w: near(s) * (s.room === n.room ? 4 : 1) }));
      if (c.length) add((allow ? 1 : 0.55) * reach(c), () => ({ ...choose(c), kind: "exhibit" }));
    }
    if (want("live")) {
      const c = liveSlots.filter((s) => free(s) && s.group !== n.lastGroup && groupCount(s.group) < 3).map((s) => ({ s, w: near(s) }));
      if (c.length) add((allow ? 1 : 0.2) * reach(c), () => ({ ...choose(c), kind: "live" }));
    }
    if (want("bench")) {
      const c = seats
        .filter((s) => s.area === "bench" && free(s) && !nearPlayer(s.x, s.z, 1.5))
        .map((s) => ({ s, w: near(s) }));
      if (c.length && n.lastKind !== "bench") add((allow ? 1 : 0.12) * reach(c), () => ({ ...seatGoal(choose(c)) }));
    }
    if (want("theatre")) {
      const c = seats
        .filter((s) => s.area === "theatre" && free(s) && !nearPlayer(s.x, s.z, 1.8) && seatNeighboursFree(s))
        .map((s) => ({ s, w: s.row >= 2 && s.row <= 5 ? 1 : 0.4 }));
      if (c.length && n.lastKind !== "theatre") add((allow ? 1 : 0.045) * (n.room === "theater" ? 3 : 1), () => ({ ...seatGoal(choose(c)) }));
    }
    if (want("wander")) {
      add(allow ? 1 : 0.07, () => {
        // mostly a stroll across the current hall, sometimes on to another one
        const hallish = [...(W.EXHIBIT_HALLS || []), "lobby"];
        const stay = !allow && hallish.includes(n.room) && rng() < 0.7;
        const p = stay ? wanderPoint([n.room], { from: here, min: 6 }) : wanderPoint(hallish.filter((r) => r !== n.room));
        return p && { kind: "wander", x: p.x, z: p.z, face: null };
      });
    }
    if (want("court") && (allow || clock > COURT_UNLOCK)) {
      add(allow ? 1 : 0.02, () => {
        const p = wanderPoint(["court"]);
        return p && { kind: "court", x: p.x, z: p.z, face: null };
      });
    }
    for (let tries = 0; tries < 4 && options.length; tries++) {
      const t = weigh(options) * rng();
      let acc = 0;
      let o = options[options.length - 1];
      for (const op of options) if ((acc += op.w) >= t) { o = op; break; }
      const g = o.make();
      if (g && Number.isFinite(g.x)) return g;
    }
    const p = wanderPoint([n.room || "rotunda", "rotunda", "lobby"]);
    return p ? { kind: "wander", x: p.x, z: p.z, face: null } : null;
  }

  function seatNeighboursFree(s) {
    // theatre visitors leave a seat between strangers
    for (const o of seats) {
      if (o === s || o.area !== "theatre" || o.row !== s.row) continue;
      if (Math.abs(o.x - s.x) < 1.5 && taken.has(o.key)) return false;
    }
    return true;
  }

  /* ---------------- assets ---------------- */

  const loader = new GLTFLoader();
  const templates = {};
  const ownedMats = [];

  function prepTemplate(gltf, sex) {
    const scn = gltf.scene;
    const clips = {};
    for (const c of gltf.animations) clips[c.name.replace(/^.*\|/, "")] = c;
    const bip = (clip) => clip?.tracks.find((t) => /(^|\.|\/)Bip01\.position$/.test(t.name) || t.name === "Bip01.position");
    const sitY = bip(clips.Sit)?.values[1] ?? 0.59;
    const sitDownZ = bip(clips.SitDown)?.values[2] ?? 0.46;
    let body = null;
    let hair = null;
    const meshes = [];
    scn.traverse((o) => {
      if (!o.isMesh) return;
      meshes.push(o);
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (/_Body$/i.test(m.name)) body = m;
        if (/Hair/i.test(m.name)) hair = m;
      }
    });
    // a generous bounding sphere from the rest pose (shared by every clone)
    scn.updateMatrixWorld(true);
    const spheres = new Map();
    for (const m of meshes) {
      if (m.isSkinnedMesh) {
        m.skeleton.update();
        m.computeBoundingSphere();
        const s = m.boundingSphere.clone();
        s.radius *= 1.25;
        spheres.set(m.name, s);
      }
    }
    templates[sex] = { scene: scn, clips, sitY, sitDownZ, body, hair, spheres, walk: ASSETS[sex].walk };
  }

  const ready = Promise.all(
    Object.entries(ASSETS).map(([sex, a]) =>
      loader
        .loadAsync(a.url)
        .then((g) => prepTemplate(g, sex))
        .catch((e) => console.warn(`[crowd] could not load ${a.url}`, e))
    )
  ).then(() => {
    if (disposed) return;
    const sexes = Object.keys(templates);
    if (!sexes.length) return;
    for (let i = 0; i < total; i++) {
      const sex = templates[i % 2 ? "female" : "male"] ? (i % 2 ? "female" : "male") : sexes[0];
      npcs.push(makeNpc(i, sex));
    }
    for (const n of npcs) initialPlace(n);
  });

  function makeNpc(i, sex) {
    const T = templates[sex];
    const model = cloneSkinned(T.scene);
    const tops = TOPS[sex];
    const bots = BOTTOMS[sex];
    const t0 = tops[(i * 7 + (i >> 1) * 3) % tops.length];
    const b0 = bots[(i * 5 + 1) % bots.length];
    const top = [t0[0] + rand(-0.15, 0.15), t0[1] * rand(0.9, 1.1), t0[2] * rand(0.94, 1.05)];
    const bottom = [b0[0] + rand(-0.1, 0.1), b0[1] * rand(0.9, 1.1), b0[2] * rand(0.94, 1.05)];
    const bodyMat = T.body ? makeClothesMaterial(T.body, top, bottom, sex === "female") : null;
    const hairMat = T.hair ? T.hair.clone() : null;
    if (hairMat) hairMat.color.multiply(new THREE.Color(HAIR[Math.floor(rng() * HAIR.length)]));
    if (bodyMat) ownedMats.push(bodyMat);
    if (hairMat) ownedMats.push(hairMat);
    model.traverse((o) => {
      if (!o.isMesh) return;
      const swap = (m) => (m === T.body && bodyMat ? bodyMat : m === T.hair && hairMat ? hairMat : m);
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
      o.castShadow = shadows;
      o.receiveShadow = shadows;
      const s = T.spheres.get(o.name);
      if (o.isSkinnedMesh && s) o.boundingSphere = s.clone();
    });
    const scale = rand(0.94, 1.06);
    const holder = new THREE.Group();
    holder.name = `crowd-npc-${i}`;
    holder.add(model);
    holder.scale.setScalar(scale);
    root.add(holder);
    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    for (const [name, clip] of Object.entries(T.clips)) actions[name] = mixer.clipAction(clip);
    return {
      id: i,
      sex,
      T,
      holder,
      model,
      mixer,
      actions,
      cur: null,
      curName: "",
      scale,
      cruise: rand(1.1, 1.3),
      x: 0,
      z: 0,
      y: 0,
      ry: 0,
      speed: 0,
      room: null,
      state: "idle",
      timer: 0,
      goal: null,
      path: null,
      wp: 0,
      pathPending: false,
      lastKind: null,
      lastGroup: null,
      waitT: 0,
      sideT: 0,
      sideSign: 1,
      stuckT: 0,
      stuckRef: [0, 0],
      stuckClock: 0,
      repaths: 0,
      nearT: 0,
      gestureT: 0,
      gesture: null,
      mixAcc: 0,
      animRate: 0,
      bodyMat,
      hairMat,
    };
  }

  /* ---------------- animation ---------------- */

  function play(n, name, { fade = 0.3, once = false, timeScale = 1, at = null } = {}) {
    const a = n.actions[name];
    if (!a) return null;
    if (n.cur === a && !once) {
      a.timeScale = timeScale;
      return a;
    }
    a.reset();
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.timeScale = timeScale;
    a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = once;
    if (at != null) a.time = at;
    a.play();
    if (n.cur && n.cur !== a) n.cur.crossFadeTo(a, fade, false);
    else if (fade > 0) a.fadeIn(fade);
    n.cur = a;
    n.curName = name;
    n.forceTick = true;
    return a;
  }
  const clipDur = (n, name) => n.actions[name]?.getClip().duration || 1;
  const idle = (n, fade = 0.4) => play(n, "Idle", { fade, at: n.curName === "Idle" ? null : rng() * clipDur(n, "Idle") });

  /* ---------------- seats ---------------- */

  /** root / approach placement for a seat (Rocketbox Sit puts the pelvis at the root's xz) */
  function seatGoal(s) {
    const fx = Math.sin(s.ry);
    const fz = Math.cos(s.ry);
    const back = s.area === "theatre" ? 0.06 : 0.16;
    const rootX = s.x - fx * back;
    const rootZ = s.z - fz * back;
    return { kind: s.area === "theatre" ? "theatre" : "bench", key: s.key, seat: s, rootX, rootZ, x: rootX, z: rootZ, face: s.ry };
  }
  function seatApproach(n, g) {
    const off = n.T.sitDownZ * n.scale;
    return [g.rootX + Math.sin(g.face) * off, g.rootZ + Math.cos(g.face) * off];
  }
  function seatRootY(n, s) {
    // pelvis ~0.1 m above the cushion; split the difference on high seats
    // (feet a touch off the floor, a touch of cushion squash) rather than
    // dangling legs, and on low ones sink the feet at most 4 cm
    const y = seatSurface(s) + 0.1 * n.scale - n.T.sitY * n.scale;
    return y > 0 ? y * 0.5 : Math.max(y, -0.04);
  }

  /**
   * The real cushion height: props.js swaps the primitive benches / theatre
   * seats for glTF furniture whose seat is not at world.js's nominal height.
   * Probe straight down a hand's width in front of the seat point (clear of
   * the backrest); cached per seat for a minute, props load late.
   */
  const surfaceCache = new Map();
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const tmpV = new THREE.Vector3();
  function seatSurface(s) {
    const c = surfaceCache.get(s.key);
    if (c && clock - c.t < 60) return c.y;
    let y = s.y;
    try {
      const px = s.x + Math.sin(s.ry) * 0.12;
      const pz = s.z + Math.cos(s.ry) * 0.12;
      const cands = [];
      scene.traverseVisible((o) => {
        if (!o.isMesh || o.isSkinnedMesh || o === root) return;
        const g = o.geometry;
        if (!g) return;
        if (o.isInstancedMesh) {
          if (o.count > 400) return;
          cands.push(o);
          return;
        }
        if (!g.boundingSphere) g.computeBoundingSphere();
        tmpSphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld);
        if (tmpSphere.radius > 12) return; // floors, walls
        if ((tmpSphere.center.x - px) ** 2 + (tmpSphere.center.z - pz) ** 2 < tmpSphere.radius ** 2) cands.push(o);
      });
      ray.set(tmpV.set(px, 1.0, pz), down);
      ray.far = 0.75;
      let best = -1;
      for (const h of ray.intersectObjects(cands, false)) if (h.point.y > 0.25 && h.point.y < 0.9) best = Math.max(best, h.point.y);
      if (best > 0) y = best;
    } catch (e) {
      /* keep the nominal height */
    }
    surfaceCache.set(s.key, { y, t: clock });
    return y;
  }

  /* ---------------- behaviour ---------------- */

  function release(n) {
    if (n.goal?.key && taken.get(n.goal.key) === n) taken.delete(n.goal.key);
  }

  function setGoal(n, g) {
    release(n);
    n.goal = g;
    if (g?.key) taken.set(g.key, n);
  }

  function think(n, allow = null) {
    const g = pickGoal(n, allow);
    if (!g) {
      n.state = "idle";
      n.timer = rand(2, 4);
      idle(n);
      return;
    }
    setGoal(n, g);
    requestPath(n);
  }

  function goalPoint(n) {
    const g = n.goal;
    if (g.seat) return seatApproach(n, g);
    return [g.x, g.z];
  }

  function requestPath(n) {
    n.state = "walk";
    n.path = null;
    n.wp = 0;
    n.pathPending = true;
    if (!pathQueue.includes(n)) pathQueue.push(n);
  }

  function solvePath(n) {
    n.pathPending = false;
    if (!n.goal) return;
    const [gx, gz] = goalPoint(n);
    const p = nav.findPath(n.x, n.z, gx, gz);
    stats.paths++;
    if (!p) {
      stats.failedPaths++;
      release(n);
      n.goal = null;
      n.state = "idle";
      n.timer = rand(1, 2.5);
      return;
    }
    n.path = p;
    n.wp = 0;
    n.stuckT = 0;
    n.stuckRef = [n.x, n.z];
    n.stuckClock = 0;
  }

  function arrive(n) {
    const g = n.goal;
    n.path = null;
    n.speed = 0;
    n.lastKind = g.kind;
    n.lastGroup = g.group || null;
    n.repaths = 0;
    if (g.seat) {
      n.state = "turnToSit";
      n.timer = 1.2;
      idle(n, 0.3);
      return;
    }
    n.state = "view";
    n.nearT = 0;
    const base = g.kind === "wander" ? rand(3, 7) : g.kind === "court" ? rand(8, 16) : rand(9, 22);
    n.timer = base;
    n.gesture = null;
    n.gestureT = rand(1.2, 3.5);
    if (g.kind === "live" && rng() < 0.5) n.gesture = "Clap";
    else if (rng() < 0.55) n.gesture = "LookAround";
    if (g.face == null && g.kind !== "wander") g.face = n.ry;
    idle(n, 0.45);
  }

  function startSit(n) {
    const g = n.goal;
    n.x = g.rootX;
    n.z = g.rootZ;
    n.ry = g.face;
    n.state = "sitDown";
    const dur = clipDur(n, "SitDown");
    const k = clamp(dur / 2.6, 1, 1.9);
    play(n, "SitDown", { fade: 0.2, once: true, timeScale: k });
    n.timer = dur / k;
    n.sitDur = n.timer;
    n.sitY = seatRootY(n, g.seat);
  }

  function startStand(n) {
    n.state = "standUp";
    const dur = clipDur(n, "SitDown");
    const k = clamp(dur / 2.2, 1, 2.1);
    const a = play(n, "SitDown", { fade: 0.25, once: true, timeScale: -k });
    if (a) a.time = dur;
    n.timer = dur / k;
    n.sitDur = n.timer;
  }

  function finishStand(n) {
    const [ax, az] = seatApproach(n, n.goal);
    n.x = ax;
    n.z = az;
    n.y = 0;
    idle(n, 0.2);
    release(n);
    n.goal = null;
    n.state = "idle";
    n.timer = rand(0.4, 1.2);
  }

  /** step a metre away from a player who walked right up */
  function yieldTo(n, p) {
    let dx = n.x - p.x;
    let dz = n.z - p.z;
    const d = Math.hypot(dx, dz) || 1;
    dx /= d;
    dz /= d;
    for (const [ox, oz] of [
      [dx, dz],
      [-dz, dx],
      [dz, -dx],
    ]) {
      const tx = n.x + ox * 1.1;
      const tz = n.z + oz * 1.1;
      if (nav.walkable(tx, tz) && nav.lineFree(n.x, n.z, tx, tz) && !nearPlayer(tx, tz, PERSONAL + 0.2)) {
        n.resume = { state: n.state, timer: n.timer, face: n.goal?.face ?? n.ry };
        n.state = "walk";
        n.path = [[tx, tz]];
        n.wp = 0;
        n.yielding = true;
        return true;
      }
    }
    return false;
  }

  function initialPlace(n) {
    // start from a random hall so the first picks spread over the museum
    const start = wanderPoint([...(W.EXHIBIT_HALLS || []), "lobby"]) || { x: 0, z: 0 };
    n.x = start.x;
    n.z = start.z;
    n.room = nav.roomIdAt(n.x, n.z);
    const kinds = ["exhibit", "exhibit", "exhibit", "live", "wander", "bench", "theatre", "exhibit"];
    let g = null;
    for (let t = 0; t < 6 && !g; t++) g = pickGoal(n, kinds[(n.id + t) % kinds.length]);
    if (!g) return teleportHidden(n, true);
    setGoal(n, g);
    if (g.seat) {
      n.x = g.rootX;
      n.z = g.rootZ;
      n.ry = g.face;
      n.state = "sit";
      n.timer = rand(8, 30);
      n.y = seatRootY(n, g.seat);
      play(n, "Sit", { fade: 0, at: rng() * clipDur(n, "Sit") });
    } else {
      n.x = g.x;
      n.z = g.z;
      n.ry = g.face ?? rand(-Math.PI, Math.PI);
      arrive(n);
      n.timer *= rng();
      n.timer += 1;
      if (n.cur) n.cur.time = rng() * clipDur(n, "Idle");
    }
    n.room = nav.roomIdAt(n.x, n.z);
  }

  const frustum = new THREE.Frustum();
  const projM = new THREE.Matrix4();
  const tmpSphere = new THREE.Sphere(new THREE.Vector3(), 1.2);

  function inView(x, z) {
    if (!camera) return false;
    tmpSphere.center.set(x, 1, z);
    return frustum.intersectsSphere(tmpSphere);
  }

  function teleportHidden(n, anywhere = false) {
    stats.teleports++;
    release(n);
    n.goal = null;
    const cam = camera ? camera.position : new THREE.Vector3();
    const camRoom = nav.roomIdAt(cam.x, cam.z);
    const rooms = [...(W.EXHIBIT_HALLS || []), "lobby"];
    for (let t = 0; t < 30; t++) {
      const p = wanderPoint(rooms);
      if (!p) continue;
      const far = Math.hypot(p.x - cam.x, p.z - cam.z) > 25;
      const hidden = anywhere || !inView(p.x, p.z) || nav.roomIdAt(p.x, p.z) !== camRoom;
      if (far && hidden) {
        n.x = p.x;
        n.z = p.z;
        n.y = 0;
        n.room = nav.roomIdAt(p.x, p.z);
        n.state = "idle";
        n.timer = rand(0.5, 2);
        n.path = null;
        idle(n, 0);
        return;
      }
    }
    n.state = "idle";
    n.timer = 2;
  }

  /* ---------------- per-frame ---------------- */

  function others(n) {
    // other NPCs + players, as { x, z, moving, dx, dz }
    const list = [];
    for (const o of npcs) {
      if (o === n || (o.x - n.x) ** 2 + (o.z - n.z) ** 2 > 6.25) continue;
      if (o.state === "sit" || o.state === "sitDown" || o.state === "standUp") continue;
      list.push({ x: o.x, z: o.z, moving: o.speed > 0.2, dx: Math.sin(o.ry), dz: Math.cos(o.ry), npc: o });
    }
    for (const p of players) if ((p.x - n.x) ** 2 + (p.z - n.z) ** 2 <= 6.25) list.push({ x: p.x, z: p.z, moving: false, player: true });
    return list;
  }

  function steer(n, dt) {
    if (n.pathPending || !n.path) {
      n.speed = Math.max(0, n.speed - 3 * dt);
      return;
    }
    let [tx, tz] = n.path[n.wp];
    let dx = tx - n.x;
    let dz = tz - n.z;
    let dist = Math.hypot(dx, dz);
    const lastWp = n.wp === n.path.length - 1;
    if (!lastWp && dist < 0.45) {
      n.wp++;
      [tx, tz] = n.path[n.wp];
      dx = tx - n.x;
      dz = tz - n.z;
      dist = Math.hypot(dx, dz);
    }
    if (lastWp && dist < 0.12) {
      n.x = tx;
      n.z = tz;
      if (n.yielding) {
        n.yielding = false;
        n.path = null;
        n.speed = 0;
        const r = n.resume;
        n.state = r.state;
        n.timer = r.timer;
        if (n.goal) n.goal.face = r.face;
        idle(n, 0.3);
        return;
      }
      arrive(n);
      return;
    }
    let ux = dx / (dist || 1);
    let uz = dz / (dist || 1);
    // remaining path length for a soft arrival
    let remain = dist;
    for (let k = n.wp + 1; k < n.path.length; k++) remain += Math.hypot(n.path[k][0] - n.path[k - 1][0], n.path[k][1] - n.path[k - 1][1]);
    let want = n.cruise * clamp(remain / 1.1, 0.25, 1);

    // local avoidance
    const px = uz;
    const pz = -ux; // a consistent "right" for everybody
    let side = 0;
    let slow = 1;
    const near = others(n);
    for (const o of near) {
      const rx = o.x - n.x;
      const rz = o.z - n.z;
      const d = Math.hypot(rx, rz);
      const ahead = rx * ux + rz * uz;
      if (ahead <= 0 || d > 2.4) continue;
      const lat = rx * px + rz * pz; // + = on our right
      if (Math.abs(lat) > 1.0) continue;
      // the goal is next to this person (e.g. a seat): just slow down
      if (o.npc && Math.hypot(o.x - tx, o.z - tz) < 0.6 && lastWp) continue;
      const headOn = o.moving && o.dx * ux + o.dz * uz < -0.4;
      side += headOn ? 0.9 : -Math.sign(lat || 0.01) * (1 - Math.abs(lat)) * (1 - d / 2.4) * 1.6;
      if (d < 1.0 && Math.abs(lat) < 0.7) slow = 0;
      else slow = Math.min(slow, clamp((d - 1.0) / 1.2, 0.3, 1));
    }
    if (slow === 0) {
      n.waitT += dt;
      if (n.waitT > 1.2 && n.sideT <= 0) {
        // politely sidestep to whichever side is open
        const r = nav.walkable(n.x + px * 0.8, n.z + pz * 0.8);
        const l = nav.walkable(n.x - px * 0.8, n.z - pz * 0.8);
        n.sideSign = r && (!l || rng() < 0.6) ? 1 : -1;
        n.sideT = 0.9;
        n.waitT = 0;
      }
    } else n.waitT = Math.max(0, n.waitT - dt);
    let vx = ux;
    let vz = uz;
    if (n.sideT > 0) {
      n.sideT -= dt;
      vx = px * n.sideSign + ux * 0.2;
      vz = pz * n.sideSign + uz * 0.2;
      want = 0.55;
      slow = 1;
    } else if (side) {
      vx += px * side;
      vz += pz * side;
    }
    const vl = Math.hypot(vx, vz) || 1;
    vx /= vl;
    vz /= vl;
    want *= slow;

    // turn towards the travel direction; walk slower while turning hard
    const targetRy = Math.atan2(vx, vz);
    const err = wrapAngle(targetRy - n.ry);
    n.ry = wrapAngle(n.ry + clamp(err, -4.5 * dt, 4.5 * dt));
    want *= clamp(Math.cos(err), 0.1, 1);
    const acc = want > n.speed ? 1.6 : 4;
    n.speed += clamp(want - n.speed, -acc * dt, acc * dt);
    const step = n.speed * dt;
    // move along the facing (no crab-walking), nudged towards the wanted direction
    const mx = Math.sin(n.ry) * 0.7 + vx * 0.3;
    const mz = Math.cos(n.ry) * 0.7 + vz * 0.3;
    const ml = Math.hypot(mx, mz) || 1;
    let nx = n.x + (mx / ml) * step;
    let nz = n.z + (mz / ml) * step;
    // personal space: never end a step inside someone else's 0.8 m
    for (const o of near) {
      const rx = nx - o.x;
      const rz = nz - o.z;
      const d = Math.hypot(rx, rz);
      if (d < PERSONAL && d > 1e-4) {
        const before = Math.hypot(n.x - o.x, n.z - o.z);
        if (d < before) {
          nx = o.x + (rx / d) * Math.min(PERSONAL, Math.max(before, d));
          nz = o.z + (rz / d) * Math.min(PERSONAL, Math.max(before, d));
        }
      }
    }
    // the seat approach is off the nav grid (between theatre rows): walls and
    // plinths still always come from resolveCollision
    [nx, nz] = W.resolveCollision(nx, nz, BODY_R, n.x, n.z);
    const moved = Math.hypot(nx - n.x, nz - n.z);
    n.x = nx;
    n.z = nz;
    if (moved < step * 0.3 && step > 0.004) n.speed *= 0.85; // scraping along something

    // stuck watchdog
    n.stuckClock += dt;
    if (n.stuckClock >= 1) {
      const prog = Math.hypot(n.x - n.stuckRef[0], n.z - n.stuckRef[1]);
      n.stuckT = prog < 0.25 ? n.stuckT + n.stuckClock : 0;
      n.stuckRef = [n.x, n.z];
      n.stuckClock = 0;
      if (n.stuckT > STUCK_TIME) {
        n.stuckT = 0;
        if (n.yielding) {
          n.yielding = false;
          think(n);
        } else if (n.repaths++ < 2) requestPath(n);
        else teleportHidden(n);
      }
    }
  }

  function faceTowards(n, ry, dt, rate = 2.4) {
    const err = wrapAngle(ry - n.ry);
    n.ry = wrapAngle(n.ry + clamp(err, -rate * dt, rate * dt));
    return Math.abs(err);
  }

  function behave(n, dt) {
    switch (n.state) {
      case "idle": {
        n.timer -= dt;
        if (n.timer <= 0) think(n);
        break;
      }
      case "walk": {
        steer(n, dt);
        break;
      }
      case "view": {
        const g = n.goal;
        if (g?.face != null) faceTowards(n, g.face, dt, 1.8);
        n.timer -= dt;
        // gestures: a look around, or a round of applause at a live dinosaur
        if (n.gesture) {
          n.gestureT -= dt;
          if (n.gestureT <= 0 && n.curName === "Idle") {
            if (n.gesture === "Clap") {
              play(n, "Clap", { fade: 0.35, at: 0 });
              n.gestureEnd = rand(2.6, 4.2);
            } else {
              play(n, "LookAround", { fade: 0.4, once: true });
              n.gestureEnd = clipDur(n, "LookAround") - 0.3;
            }
            n.gesture = null;
          }
        }
        if (n.gestureEnd != null) {
          n.gestureEnd -= dt;
          if (n.gestureEnd <= 0) {
            n.gestureEnd = null;
            idle(n, 0.5);
          }
        }
        // a player standing right on top of us: step aside; lingering close: move on
        let close = null;
        for (const p of players) {
          const d = Math.hypot(p.x - n.x, p.z - n.z);
          if (d < 0.75) close = p;
          if (d < 1.8) n.nearT += dt;
        }
        if (close && yieldTo(n, close)) break;
        if (n.nearT > 3.5) n.timer = Math.min(n.timer, 0);
        if (n.timer <= 0) {
          n.gestureEnd = null;
          release(n);
          n.goal = null;
          n.state = "idle";
          n.timer = rand(0.2, 1.0);
          if (n.curName !== "Idle") idle(n, 0.4);
        }
        break;
      }
      case "turnToSit": {
        n.timer -= dt;
        const err = faceTowards(n, n.goal.face, dt, 3);
        if (err < 0.08 || n.timer <= 0) startSit(n);
        break;
      }
      case "sitDown": {
        n.timer -= dt;
        const k = 1 - clamp(n.timer / n.sitDur, 0, 1);
        n.y = n.sitY * clamp((k - 0.3) / 0.6, 0, 1);
        if (n.timer <= 0) {
          n.y = n.sitY;
          n.state = "sit";
          play(n, "Sit", { fade: 0.35, at: rng() * clipDur(n, "Sit") * 0.5 });
          n.timer = n.goal.kind === "theatre" ? rand(25, 55) : rand(15, 40);
        }
        break;
      }
      case "sit": {
        n.timer -= dt;
        const s = n.goal.seat;
        if (nearPlayer(s.x, s.z, 0.75)) n.nearT += dt;
        else n.nearT = 0;
        if (n.timer <= 0 || n.nearT > 1) {
          n.nearT = 0;
          startStand(n);
        }
        break;
      }
      case "standUp": {
        n.timer -= dt;
        const k = clamp(n.timer / n.sitDur, 0, 1); // 1 -> 0
        n.y = n.sitY * clamp((k - 0.1) / 0.6, 0, 1);
        if (n.timer <= 0) finishStand(n);
        break;
      }
      default:
        n.state = "idle";
    }
  }

  function animate(n, dt, camDist) {
    // locomotion blend
    if (n.state === "walk") {
      if (n.speed > 0.2) {
        const ts = clamp(n.speed / (n.T.walk * n.scale), 0.35, 1.6);
        if (n.curName !== "Walk") play(n, "Walk", { fade: 0.3, timeScale: ts, at: rng() * clipDur(n, "Walk") });
        else n.cur.timeScale = ts;
      } else if (n.speed < 0.08 && n.curName === "Walk") idle(n, 0.3);
      else if (n.curName === "Walk") n.cur.timeScale = clamp(n.speed / (n.T.walk * n.scale), 0.35, 1.6);
    }
    // mixer LOD
    if (camDist > ANIM_FAR) {
      n.mixAcc = Math.min(n.mixAcc + dt, 0.5);
      n.animRate = 0;
      if (!n.holder.visible) return;
      if (n.forceTick) {
        // a clip changed while frozen: settle the cross-fade once so a far
        // visitor never shows the bind pose or a half-blended one
        n.forceTick = false;
        n.mixer.update(1.0);
        n.mixAcc = 0;
        stats.mixersTicked++;
      } else if (n.state === "walk" && n.speed > 0.2 && n.mixAcc >= 1 / 6 && inView(n.x, n.z)) {
        // a frozen walker gliding along would read as sliding: 6 Hz in view
        n.mixer.update(n.mixAcc);
        n.mixAcc = 0;
        n.animRate = 6;
        stats.mixersTicked++;
      }
      return;
    }
    n.forceTick = false;
    n.mixAcc += dt;
    const step = camDist > ANIM_NEAR ? 1 / 15 : 0;
    if (n.mixAcc >= step) {
      n.mixer.update(Math.min(n.mixAcc, 0.5));
      n.mixAcc = 0;
      stats.mixersTicked++;
    }
    n.animRate = camDist > ANIM_NEAR ? 15 : 60;
  }

  function update(dt, playerPos, remotes = []) {
    if (disposed) return;
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    clock += dt;
    players.length = 0;
    if (playerPos && Number.isFinite(playerPos.x) && Number.isFinite(playerPos.z)) players.push({ x: playerPos.x, z: playerPos.z });
    for (const r of remotes || []) if (r && Number.isFinite(r.x) && Number.isFinite(r.z)) players.push({ x: r.x, z: r.z });
    if (!npcs.length) return;

    navCheckT -= dt;
    if (navCheckT <= 0) {
      navCheckT = 1;
      if (nav.changed()) {
        nav.rebuild();
        buildTargets();
      }
    }
    if (camera) {
      camera.updateMatrixWorld();
      projM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projM);
    }
    for (let k = 0; k < PATHS_PER_FRAME && pathQueue.length; k++) {
      const n = pathQueue.shift();
      if (n.pathPending) solvePath(n);
    }
    const cam = camera ? camera.position : null;
    stats.mixersTicked = 0;
    stats.visible = 0;
    for (const n of npcs) {
      behave(n, dt);
      n.room = nav.roomIdAt(n.x, n.z) || n.room;
      const camDist = cam ? Math.hypot(n.x - cam.x, n.z - cam.z) : 0;
      n.holder.visible = camDist < HIDE_DIST;
      if (n.holder.visible) stats.visible++;
      n.holder.position.set(n.x, n.y, n.z);
      n.holder.rotation.y = n.ry;
      animate(n, dt, camDist);
    }
  }

  /* ---------------- debug / tests ---------------- */

  /**
   * Put NPC i straight into an activity (for screenshots / tests):
   * kind = "exhibit" | "live" | "bench" | "theatre" | "wander" | "court".
   * With { instant: true } it is placed there already doing it; otherwise it
   * walks. near = { x, z } prefers the target closest to that point.
   */
  function place(i, kind, { instant = true, near = null } = {}) {
    const n = npcs[i];
    if (!n) return null;
    release(n);
    n.goal = null;
    let g = null;
    if (near && (kind === "exhibit" || kind === "live" || kind === "bench" || kind === "theatre")) {
      const pool =
        kind === "exhibit" ? exhibitSlots : kind === "live" ? liveSlots : seats.filter((s) => s.area === kind);
      const best = pool
        .filter((s) => !taken.has(s.key))
        .sort((a, b) => Math.hypot(a.x - near.x, a.z - near.z) - Math.hypot(b.x - near.x, b.z - near.z))[0];
      if (best) g = best.ry != null && best.area ? seatGoal(best) : { ...best, kind };
    }
    if (!g) g = pickGoal(n, kind);
    if (!g) return null;
    setGoal(n, g);
    n.y = 0;
    if (!instant) {
      requestPath(n);
    } else if (g.seat) {
      n.x = g.rootX;
      n.z = g.rootZ;
      n.ry = g.face;
      n.state = "sit";
      n.timer = 60;
      n.y = seatRootY(n, g.seat);
      play(n, "Sit", { fade: 0 });
    } else {
      n.x = g.x;
      n.z = g.z;
      n.ry = g.face ?? n.ry;
      arrive(n);
      n.timer = 60;
    }
    return { kind: g.kind, x: +g.x.toFixed(2), z: +g.z.toFixed(2), key: g.key || null };
  }

  function dispose() {
    disposed = true;
    for (const n of npcs) {
      n.mixer.stopAllAction();
      n.mixer.uncacheRoot(n.model);
    }
    scene.remove(root);
    for (const m of ownedMats) m.dispose();
    for (const T of Object.values(templates)) {
      T.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
          m.dispose();
        }
      });
    }
    npcs.length = 0;
    taken.clear();
  }

  return {
    update,
    npcs,
    ready,
    dispose,
    root,
    nav,
    place,
    /** the spots NPCs pick from (for tests) */
    targets: () => ({ exhibit: exhibitSlots.length, live: liveSlots.length, seats: seats.length, rooms: [...wanderSpots.keys()] }),
    stats: () => ({ ...stats, npcs: npcs.length, pathQueue: pathQueue.length, expanded: nav.expanded }),
    debug: () =>
      npcs.map((n) => ({
        id: n.id,
        sex: n.sex,
        state: n.state,
        anim: n.curName,
        x: +n.x.toFixed(2),
        z: +n.z.toFixed(2),
        y: +n.y.toFixed(3),
        seatY: n.goal?.seat ? +(surfaceCache.get(n.goal.seat.key)?.y ?? n.goal.seat.y).toFixed(3) : null,
        ry: +n.ry.toFixed(2),
        speed: +n.speed.toFixed(2),
        room: n.room,
        goal: n.goal ? { kind: n.goal.kind, key: n.goal.key || null, x: +n.goal.x.toFixed(1), z: +n.goal.z.toFixed(1) } : null,
        timer: +n.timer.toFixed(1),
        visible: n.holder.visible,
        animRate: n.animRate,
      })),
  };
}
