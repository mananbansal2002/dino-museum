import * as THREE from "three";

/**
 * Special characters (character.js SPECIAL_PRESETS) on the Rocketbox avatars: their
 * outfit textures (made from the Rocketbox body textures by recolouring the UV regions —
 * see public/models/humans/special/), the parts the base mesh cannot show (a flared
 * skirt / kurta hem as a skinned mesh, long loose hair, short curls) and small add-ons
 * (glasses, sunglasses, earrings, a crossbody bag).
 *
 * Everything is built in character space at the rest pose (metres, +y up, +z forward,
 * +x the avatar's left) and rides the head / spine / pelvis bones, or the skeleton itself
 * for the skirts, so it follows every clip.
 */

const BASE = "/models/humans/special/";

/** UV boxes [u0, v0, u1, v1] of Rocketbox triangles a preset hides */
const FEMALE_PONYTAIL = [0.47, 0.6, 1.01, 1.01];
const FEMALE_COLLAR = [0.355, 0.765, 0.65, 0.945];
/** his shirt collar (UV box shared with the hip end of the torso island: only the part up at the neck) */
const MALE_COLLAR = [0.32, 0.82, 0.68, 0.99];
/** the female hair cards except the eyelashes */
const FEMALE_HAIR_CARDS = (u, v) => !(u > 0.72 && v > 0.8);

const HIM_HAIR = "#1e1712";
const HER_HAIR = "#33261c";

export const SPECIAL_ASSETS = {
  // the kurta has a band collar, not the shirt's pointed one
  "him-hills": { body: "him-hills-body.jpg", head: "him-head.jpg", hideBody: MALE_COLLAR, hideAbove: 1.3, hair: "curls", noCards: true, add: ["glasses"] },
  "him-rooftop": { body: "him-rooftop-body.jpg", head: "him-head.jpg", hair: "curls", noCards: true, add: ["glasses"] },
  "her-hills": {
    body: "her-hills-body.jpg",
    normal: "her-hills-normal.jpg",
    head: "her-head.jpg",
    hideHead: FEMALE_PONYTAIL,
    hideBody: FEMALE_COLLAR,
    hideCards: FEMALE_HAIR_CARDS,
    hair: "long",
    // a straight kurta hem over the hips with a row of white pom-poms
    skirt: { map: "her-hills-tunic.jpg", top: 1.0, hem: 0.785, ease: 0.012, flare: 0.035, repeat: 1, poms: true, roughness: 0.85 },
    add: ["sunglasses", "bag"],
  },
  "her-rooftop": {
    body: "her-rooftop-body.jpg",
    normal: "her-rooftop-normal.jpg",
    mr: "her-rooftop-mr.jpg",
    head: "her-head.jpg",
    hideHead: FEMALE_PONYTAIL,
    hideBody: FEMALE_COLLAR,
    hideCards: FEMALE_HAIR_CARDS,
    hair: "long",
    // the navy satin mini dress: gathered at the waist, flared to mid-thigh
    skirt: { map: "her-rooftop-skirt.jpg", top: 1.06, hem: 0.665, ease: 0.008, flare: 0.115, repeat: 1, satin: true, roughness: 0.42 },
    add: ["earrings"],
  },
};

/* ------------------------------------------------------------------ */
/* textures                                                             */
/* ------------------------------------------------------------------ */
const texLoader = new THREE.TextureLoader();
const textures = new Map();

/** A texture of the special set, loaded once (glTF orientation: flipY false). */
function loadTex(name, color = true) {
  if (!textures.has(name)) {
    textures.set(
      name,
      new Promise((resolve, reject) =>
        texLoader.load(
          BASE + name,
          (t) => {
            t.flipY = false;
            t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            t.anisotropy = 4;
            t.needsUpdate = true;
            resolve(t);
          },
          undefined,
          reject
        )
      )
    );
  }
  return textures.get(name);
}

/** Starts (and returns) every download a preset needs, so it can appear complete. */
export function preloadSpecial(preset) {
  const a = SPECIAL_ASSETS[preset];
  if (!a) return Promise.resolve(null);
  const jobs = [
    loadTex(a.body),
    loadTex(a.head),
    a.normal ? loadTex(a.normal, false) : null,
    a.mr ? loadTex(a.mr, false) : null,
    a.skirt ? loadTex(a.skirt.map) : null,
  ];
  return Promise.all(jobs);
}

/* ------------------------------------------------------------------ */
/* geometry helpers                                                     */
/* ------------------------------------------------------------------ */
/** attribute component c of item i (r160 has no getComponent); normalised values come out as floats */
const component = (attr, i, c) => (c === 0 ? attr.getX(i) : c === 1 ? attr.getY(i) : c === 2 ? attr.getZ(i) : attr.getW(i));
const filtered = new WeakMap();

/** The geometry minus the triangles whose UV centroid `drop(u, v)` (cached, attributes shared). */
function withoutUV(geo, key, drop) {
  let byKey = filtered.get(geo);
  if (!byKey) filtered.set(geo, (byKey = new Map()));
  if (byKey.has(key)) return byKey.get(key);
  const uv = geo.attributes.uv;
  const src = geo.index;
  const keep = [];
  const n = src ? src.count : geo.attributes.position.count;
  for (let i = 0; i < n; i += 3) {
    const a = src ? src.getX(i) : i;
    const b = src ? src.getX(i + 1) : i + 1;
    const c = src ? src.getX(i + 2) : i + 2;
    const u = (uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3;
    const v = (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3;
    if (!drop(u, v, a, b, c)) keep.push(a, b, c);
  }
  const out = new THREE.BufferGeometry();
  for (const [k, attr] of Object.entries(geo.attributes)) out.setAttribute(k, attr);
  out.setIndex(keep);
  out.boundingBox = geo.boundingBox;
  out.boundingSphere = geo.boundingSphere;
  // shares the source's buffers: never disposed (that would drop them for the source too)
  out.userData.shared = true;
  byKey.set(key, out);
  return out;
}

const inBox = ([u0, v0, u1, v1]) => (u, v) => u >= u0 && u <= u1 && v >= v0 && v <= v1;

/**
 * Per bone, the matrix taking a skinned vertex (bind space) to where it renders in character
 * space at the current — rest — pose: inv(root) · bone · boneInverse · bindMatrix. A vertex
 * renders at the weighted blend of its bones' matrices (the mesh node's own transform does
 * not count for a skinned mesh).
 */
function boneMatrices(mesh, root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const { bones, boneInverses } = mesh.skeleton;
  return bones.map((b, i) => new THREE.Matrix4().copy(inv).multiply(b.matrixWorld).multiply(boneInverses[i]).multiply(mesh.bindMatrix));
}

const _blend = new THREE.Matrix4();
/** the blended skinning matrix of 4 (bone, weight) pairs */
function blendOf(mats, idx, wts) {
  const e = _blend.elements;
  e.fill(0);
  for (let c = 0; c < 4; c++) {
    const w = wts[c];
    if (!w) continue;
    const me = mats[idx[c]].elements;
    for (let k = 0; k < 16; k++) e[k] += me[k] * w;
  }
  return _blend;
}

/** Character-space rest positions of a skinned mesh's vertices. */
function restVertices(mesh, mats) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const si = g.attributes.skinIndex;
  const sw = g.attributes.skinWeight;
  const out = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  const idx = [0, 0, 0, 0], wts = [0, 0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    for (let c = 0; c < 4; c++) {
      idx[c] = component(si, i, c);
      wts[c] = component(sw, i, c);
    }
    v.fromBufferAttribute(pos, i).applyMatrix4(blendOf(mats, idx, wts));
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  return { pos: out, count: pos.count, mats, mesh };
}

/** A coarse 3D grid over points for neighbour queries. */
function pointGrid(sets, cell = 0.04) {
  const map = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (const s of sets) {
    for (let i = 0; i < s.count; i++) {
      const x = s.pos[i * 3], y = s.pos[i * 3 + 1], z = s.pos[i * 3 + 2];
      const k = key(x, y, z);
      let arr = map.get(k);
      if (!arr) map.set(k, (arr = []));
      arr.push(s, i);
    }
  }
  return {
    /** every [set, index, distance] within r of p */
    near(p, r) {
      const res = [];
      const n = Math.ceil(r / cell);
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), cz = Math.floor(p.z / cell);
      for (let dx = -n; dx <= n; dx++)
        for (let dy = -n; dy <= n; dy++)
          for (let dz = -n; dz <= n; dz++) {
            const arr = map.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!arr) continue;
            for (let j = 0; j < arr.length; j += 2) {
              const s = arr[j], i = arr[j + 1];
              const d = Math.hypot(s.pos[i * 3] - p.x, s.pos[i * 3 + 1] - p.y, s.pos[i * 3 + 2] - p.z);
              if (d < r) res.push([s, i, d]);
            }
          }
      return res;
    },
  };
}

/** Pushes p out of the body (away from the closest vertex) until it is `clear` metres off it. */
function pushOut(grid, p, clear, axis) {
  for (let pass = 0; pass < 3; pass++) {
    const hits = grid.near(p, clear);
    if (!hits.length) return p;
    // radially away from the body's vertical axis — stable for hair and straps
    const dx = p.x - axis.x, dz = p.z - axis.z;
    const r = Math.hypot(dx, dz) || 1;
    let worst = 0;
    for (const [, , d] of hits) worst = Math.max(worst, clear - d);
    p.x += (dx / r) * worst * 1.05;
    p.z += (dz / r) * worst * 1.05;
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* skirts                                                               */
/* ------------------------------------------------------------------ */
const SEG = 56;
const RINGS = 12;

/**
 * A skinned flared skirt round the body mesh's hips: its rings follow the body's own
 * cross-section (never narrower going down), plus `ease` and a `flare` towards the hem.
 * Each vertex takes the skin weights of the body vertices nearest it, so the front and
 * back follow the thighs when walking or sitting and the waist stays with the pelvis.
 */
function buildSkirt(body, opts, mats) {
  const { pos, count } = body;
  // body vertices of the trunk and thighs only
  const near = [];
  for (let i = 0; i < count; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1];
    if (Math.abs(x) < 0.26 && y > opts.hem - 0.12 && y < opts.top + 0.06) near.push(i);
  }
  let cx = 0, cz = 0, n = 0;
  for (const i of near) {
    const y = pos[i * 3 + 1];
    if (Math.abs(y - opts.top) < 0.03) {
      cx += pos[i * 3];
      cz += pos[i * 3 + 2];
      n++;
    }
  }
  cx /= n || 1;
  cz /= n || 1;
  const radius = (y, a) => {
    let r = 0;
    for (const i of near) {
      const vy = pos[i * 3 + 1];
      if (Math.abs(vy - y) > 0.02) continue;
      const dx = pos[i * 3] - cx, dz = pos[i * 3 + 2] - cz;
      let da = Math.atan2(dx, dz) - a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) < 0.16) r = Math.max(r, Math.hypot(dx, dz));
    }
    return r;
  };
  const ringR = [];
  for (let k = 0; k <= RINGS; k++) {
    const t = k / RINGS;
    const y = opts.top + (opts.hem - opts.top) * t;
    const row = [];
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const prev = k ? ringR[k - 1][j] - (opts.flare * Math.pow((k - 1) / RINGS, 1.3) + opts.ease) : 0;
      row.push(Math.max(radius(y, a), prev, 0.08) + opts.ease + opts.flare * Math.pow(t, 1.3));
    }
    // smooth round the ring so a stray vertex does not dent it
    let sm = row;
    for (let pass = 0; pass < 4; pass++) sm = sm.map((r, j) => (sm[(j + SEG - 1) % SEG] + 2 * r + sm[(j + 1) % SEG]) / 4);
    ringR.push(sm);
  }

  const P = [];
  const UV = [];
  const IDX = [];
  for (let k = 0; k <= RINGS; k++) {
    const t = k / RINGS;
    const y = opts.top + (opts.hem - opts.top) * t;
    for (let j = 0; j <= SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      // soft folds towards the hem
      const r = ringR[k][j % SEG] * (1 + Math.sin(a * 14) * 0.018 * t * (opts.satin ? 1 : 0.3));
      P.push(cx + Math.sin(a) * r, y, cz + Math.cos(a) * r);
      UV.push((j / SEG) * opts.repeat, t);
    }
  }
  const row = SEG + 1;
  for (let k = 0; k < RINGS; k++) {
    for (let j = 0; j < SEG; j++) {
      const a = k * row + j, b = a + 1, c = a + row, d = c + 1;
      IDX.push(a, c, b, b, c, d);
    }
  }
  const skirtCount = P.length / 3;

  // pom-poms along the hem (kurta)
  const groups = [[0, IDX.length, 0]];
  if (opts.poms) {
    const ball = new THREE.IcosahedronGeometry(0.0085, 1);
    const bp = ball.attributes.position;
    const start = IDX.length;
    const N = 44;
    for (let q = 0; q < N; q++) {
      const a = (q / N) * Math.PI * 2;
      const j = Math.round((q / N) * SEG) % SEG;
      const r = ringR[RINGS][j] + 0.002;
      const base = P.length / 3;
      const ox = cx + Math.sin(a) * r, oy = opts.hem - 0.006, oz = cz + Math.cos(a) * r;
      for (let i = 0; i < bp.count; i++) {
        P.push(ox + bp.getX(i), oy + bp.getY(i), oz + bp.getZ(i));
        UV.push(0, 1);
      }
      const bi = ball.index;
      if (bi) for (let i = 0; i < bi.count; i++) IDX.push(base + bi.getX(i));
      else for (let i = 0; i < bp.count; i++) IDX.push(base + i);
    }
    ball.dispose();
    groups.push([start, IDX.length - start, 1]);
  }

  // skin weights from the nearest body vertices
  const si = body.mesh.geometry.attributes.skinIndex;
  const sw = body.mesh.geometry.attributes.skinWeight;
  const total = P.length / 3;
  const skinIndex = new Uint16Array(total * 4);
  const skinWeight = new Float32Array(total * 4);
  const K = 10;
  const ringW = [];
  for (let v = 0; v < total; v++) {
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    // a pom-pom takes its hem's weights
    if (v >= skirtCount) {
      const j = Math.round(((Math.atan2(x - cx, z - cz) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * SEG) % SEG;
      const src = RINGS * row + j;
      for (let c = 0; c < 4; c++) {
        skinIndex[v * 4 + c] = skinIndex[src * 4 + c];
        skinWeight[v * 4 + c] = skinWeight[src * 4 + c];
      }
      continue;
    }
    const best = [];
    for (const i of near) {
      const d = Math.hypot(pos[i * 3] - x, (pos[i * 3 + 1] - y) * 1.5, pos[i * 3 + 2] - z);
      if (best.length < K || d < best[best.length - 1][1]) {
        best.push([i, d]);
        best.sort((p, q) => p[1] - q[1]);
        if (best.length > K) best.pop();
      }
    }
    const acc = new Map();
    for (const [i, d] of best) {
      const w = 1 / (d + 0.01);
      for (let c = 0; c < 4; c++) {
        const bw = component(sw, i, c);
        if (bw <= 0) continue;
        const b = component(si, i, c);
        // the trunk and thighs only: a knee's calf weight would drag the hem down when seated
        if (body.skirtBones && !body.skirtBones.has(b)) continue;
        acc.set(b, (acc.get(b) || 0) + bw * w);
      }
    }
    // lower down, the skirt hangs from the thighs: the front and sides follow them closely
    // (onto the lap when sitting); the back mostly stays with the pelvis — turned with a
    // seated thigh it would swing down under the knees
    const t = Math.floor(v / row) / RINGS;
    const front = (z - cz) / (Math.hypot(x - cx, z - cz) || 1);
    const k = Math.pow(t, 0.9) * (0.25 + 0.65 * Math.min(1, Math.max(0, (front + 0.6) / 1.1)));
    if (body.thighs && k > 0) {
      let tot = 0;
      for (const w of acc.values()) tot += w;
      for (const b of acc.keys()) acc.set(b, (acc.get(b) / tot) * (1 - k));
      const left = Math.min(1, Math.max(0, 0.5 + (x - cx) / 0.16));
      const { L, R } = body.thighs;
      acc.set(L, (acc.get(L) || 0) + k * left);
      acc.set(R, (acc.get(R) || 0) + k * (1 - left));
    }
    const top4 = [...acc.entries()].sort((p, q) => q[1] - p[1]).slice(0, 4);
    const sum = top4.reduce((s, e) => s + e[1], 0) || 1;
    top4.forEach(([b, w], c) => {
      skinIndex[v * 4 + c] = b;
      skinWeight[v * 4 + c] = w / sum;
    });
    ringW.push(v);
  }

  const geo = new THREE.BufferGeometry();
  // character space → the body mesh's own (bind) space
  const local = new Float32Array(P.length);
  const tmp = new THREE.Vector3();
  const inv = new THREE.Matrix4();
  for (let v = 0; v < total; v++) {
    const idx = [0, 1, 2, 3].map((c) => skinIndex[v * 4 + c]);
    const wts = [0, 1, 2, 3].map((c) => skinWeight[v * 4 + c]);
    inv.copy(blendOf(body.mats, idx, wts)).invert();
    tmp.set(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]).applyMatrix4(inv);
    local[v * 3] = tmp.x;
    local[v * 3 + 1] = tmp.y;
    local[v * 3 + 2] = tmp.z;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(local, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(UV, 2));
  geo.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geo.setAttribute("skinWeight", new THREE.BufferAttribute(skinWeight, 4));
  geo.setIndex(IDX);
  for (const [s, c, m] of groups) geo.addGroup(s, c, m);
  geo.computeVertexNormals();

  const mesh = new THREE.SkinnedMesh(geo, mats);
  const src = body.mesh;
  mesh.position.copy(src.position);
  mesh.quaternion.copy(src.quaternion);
  mesh.scale.copy(src.scale);
  mesh.bind(src.skeleton, src.bindMatrix);
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  mesh.name = "SpecialSkirt";
  return mesh;
}

/* ------------------------------------------------------------------ */
/* hair                                                                 */
/* ------------------------------------------------------------------ */
let strandTex = null;
/** dark hair strands with wispy, uneven ends (alpha-tested) */
function hairStrands() {
  if (strandTex) return strandTex;
  const w = 128, h = 256;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = "#211913";
  g.fillRect(0, 0, w, h);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 220; i++) {
    const x = rnd() * w;
    const l = 30 + rnd() * 50;
    g.strokeStyle = `rgba(${70 + rnd() * 40},${52 + rnd() * 28},${40 + rnd() * 20},${0.25 + rnd() * 0.35})`;
    g.lineWidth = 0.6 + rnd() * 1.2;
    g.beginPath();
    g.moveTo(x, 0);
    g.bezierCurveTo(x + (rnd() - 0.5) * 8, h * 0.3, x + (rnd() - 0.5) * 8, h * 0.6, x + (rnd() - 0.5) * 6, h);
    g.stroke();
    if (l > 100) break;
  }
  // uneven tips: alpha falls off over the last fifth, strand by strand; soft sides
  const img = g.getImageData(0, 0, w, h);
  const tip = new Float32Array(w);
  for (let x = 0; x < w; x++) tip[x] = h * (0.8 + rnd() * 0.2);
  for (let x = 1; x < w; x++) tip[x] = tip[x] * 0.4 + tip[x - 1] * 0.6;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const side = Math.min(x, w - 1 - x) / (w * 0.14);
      let a = Math.min(1, side) * (y < tip[x] ? 1 : 0);
      if (y > tip[x] - 12 && ((x * 7 + y) % 5) < 2) a = 0;
      img.data[o + 3] = a * 255;
    }
  }
  g.putImageData(img, 0, 0);
  strandTex = new THREE.CanvasTexture(c);
  strandTex.colorSpace = THREE.SRGBColorSpace;
  strandTex.anisotropy = 4;
  return strandTex;
}

/** A point on the head ellipsoid {c, r} at azimuth a (0 = front, +x left) and polar p (0 = top). */
function onHead(head, a, p, lift = 0) {
  return new THREE.Vector3(
    head.c.x + Math.sin(a) * Math.sin(p) * (head.r.x + lift),
    head.c.y + Math.cos(p) * (head.r.y + lift),
    head.c.z + Math.cos(a) * Math.sin(p) * (head.r.z + lift)
  );
}

/**
 * A hair shell that fits the head exactly: the head mesh's own triangles above a hairline
 * plane tilted back by `tilt` (high on the forehead, above the ears, down to the nape),
 * pushed out along their normals in the vertex shader and skinned like the head.
 */
function buildScalp(headMesh, headRest, skull, tilt, color, offset, key) {
  const up = new THREE.Vector3(0, Math.cos(tilt), -Math.sin(tilt));
  const p = headRest.pos;
  const above = (i) =>
    ((p[i * 3 + 1] - skull.c.y) / skull.r.y) * up.y + ((p[i * 3 + 2] - skull.c.z) / skull.r.z) * up.z > 0.02;
  const geo = withoutUV(headMesh.geometry, key, (u, v, a, b, c) => !(above(a) && above(b) && above(c)));
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.03, envMapIntensity: 0.4 });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>\n\ttransformed += normalize( objectNormal ) * ${offset.toFixed(4)};`
    );
  };
  mat.customProgramCacheKey = () => `scalp-${offset}`;
  const mesh = new THREE.SkinnedMesh(geo, mat);
  mesh.position.copy(headMesh.position);
  mesh.quaternion.copy(headMesh.quaternion);
  mesh.scale.copy(headMesh.scale);
  mesh.bind(headMesh.skeleton, headMesh.bindMatrix);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.name = "SpecialScalp";
  return mesh;
}

const HIM_TILT = 0.5;
const CUT_UP = new THREE.Vector3(0, Math.cos(HIM_TILT), -Math.sin(HIM_TILT));

/** Short dark curls: hundreds of little lumps over the scalp, fuller on top. */
function buildCurls(head, headRest) {
  const mat = new THREE.MeshStandardMaterial({ color: HIM_HAIR, roughness: 0.58, metalness: 0.04, envMapIntensity: 0.4 });
  const ball = new THREE.IcosahedronGeometry(1, 1);
  // curl sites: the head mesh's own scalp vertices above the hairline, one per ~1 cm cell
  const sites = [];
  const seen = new Set();
  const { pos, count } = headRest;
  const v = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const inner = new THREE.Vector3(head.c.x, head.c.y - 0.03, head.c.z);
  for (let i = 0; i < count; i++) {
    v.set(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    const ry = (v.y - head.c.y) / head.r.y, rz = (v.z - head.c.z) / head.r.z;
    if (ry * CUT_UP.y + rz * CUT_UP.z < 0.06) continue;
    const key = `${Math.round(v.x / 0.0082)},${Math.round(v.y / 0.0082)},${Math.round(v.z / 0.0082)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sites.push(v.clone());
  }
  const mesh = new THREE.InstancedMesh(ball, mat, sites.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  sites.forEach((pt, i) => {
    dir.subVectors(pt, inner).normalize();
    const top = Math.max(0, dir.y);
    const h1 = Math.sin(i * 12.9898 + pt.x * 78.2) * 43758.5453;
    const rr = h1 - Math.floor(h1);
    // fuller on top, close at the sides and the nape
    const lift = 0.0005 + 0.0105 * top * top * top + rr * 0.0025;
    const s = 0.0052 + 0.0046 * top * top + rr * 0.0028;
    pt.addScaledVector(dir, lift);
    e.set(rr * 3, rr * 5, rr * 2);
    q.setFromEuler(e);
    m.compose(pt, q, new THREE.Vector3(s, s * (0.75 + rr * 0.3), s * 1.1));
    mesh.setMatrixAt(i, m);
    // a little light and shade between curls
    mesh.setColorAt(i, new THREE.Color().setScalar(0.78 + rr * 0.4));
  });
  mesh.castShadow = true;
  mesh.frustumCulled = false;
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}

/**
 * Long, loose, wavy hair past the shoulders: a crown cap and two layers of strand ribbons
 * falling from it — in front of the shoulders at the sides of the face, down the back
 * behind — pushed clear of the body.
 */
function buildLongHair(head, grid, axis) {
  const map = hairStrands();
  const mat = new THREE.MeshStandardMaterial({
    map,
    color: 0xffffff,
    roughness: 0.7,
    metalness: 0.02,
    side: THREE.DoubleSide,
    alphaTest: 0.45,
    // dark hair should not mirror a bright environment (the customiser's room light)
    envMapIntensity: 0.35,
  });
  const g = new THREE.Group();

  const P = [], UV = [], IDX = [];
  const L = 22; // segments along a ribbon
  const ribbon = (a, layer, len, toFront) => {
    const width = 0.05 + layer * 0.008;
    const lift = 0.012 + layer * 0.009;
    // one smooth curve: from the crown over the skull, out over the ears, to where the strand
    // hangs — in front of the shoulder (never across the throat) or spread down the back
    const seed = Math.sin(a * 91.7 + layer * 13.1) * 0.5 + 0.5;
    const sx = Math.sign(Math.sin(a)) || 1;
    const c2 = onHead(head, a, Math.PI * 0.52, lift + 0.014);
    const target = toFront
      ? new THREE.Vector3(sx * (0.118 + 0.02 * layer + 0.02 * Math.abs(Math.cos(a))), 0, head.c.z + 0.035 + 0.02 * Math.cos(a))
      : new THREE.Vector3(Math.sin(a) * (0.12 + 0.012 * layer), 0, head.c.z - 0.075 + 0.03 * Math.cos(a) - 0.01 * layer);
    const ctrl = [
      onHead(head, a, 0.14 + layer * 0.05, lift),
      onHead(head, a, Math.PI * 0.3, lift + 0.006),
      c2,
      new THREE.Vector3((c2.x + target.x) / 2, c2.y - 0.1, (c2.z + target.z) / 2),
      new THREE.Vector3(target.x, c2.y - 0.2, target.z),
      new THREE.Vector3(target.x * 1.04, len, target.z),
    ];
    const curve = new THREE.CatmullRomCurve3(ctrl, false, "centripetal");
    const pts = curve.getSpacedPoints(L);
    for (let s = 0; s <= L; s++) {
      const pt = pts[s];
      if (pt.y > c2.y) continue;
      const k = Math.min(1, (c2.y - pt.y) / Math.max(0.05, c2.y - len));
      // waves, growing towards the ends
      const wv = Math.sin(k * Math.PI * 4.2 + seed * 6) * 0.015 * (0.45 + 0.8 * k);
      pt.x += Math.cos(a) * wv;
      pt.z -= Math.sin(a) * wv;
      pushOut(grid, pt, 0.022 + layer * 0.01, axis);
    }
    // smooth out the kinks the push-out leaves between neighbouring points
    for (let pass = 0; pass < 3; pass++) {
      for (let s = 1; s < L; s++) {
        if (pts[s].y > c2.y) continue;
        pts[s].lerp(new THREE.Vector3().addVectors(pts[s - 1], pts[s + 1]).multiplyScalar(0.5), 0.5);
      }
    }
    const base = P.length / 3;
    for (let s = 0; s <= L; s++) {
      const pt = pts[s];
      const nxt = pts[Math.min(L, s + 1)], prv = pts[Math.max(0, s - 1)];
      const along = new THREE.Vector3().subVectors(nxt, prv).normalize();
      const radial = new THREE.Vector3(pt.x - head.c.x, 0, pt.z - head.c.z).normalize();
      const across = new THREE.Vector3().crossVectors(along, radial).normalize();
      const t = s / L;
      const wdt = width * (0.8 + 0.4 * Math.sin(t * Math.PI)) * (s === 0 ? 0.6 : 1);
      for (const side of [-1, 1]) {
        P.push(pt.x + across.x * wdt * side * 0.5, pt.y + across.y * wdt * side * 0.5, pt.z + across.z * wdt * side * 0.5);
        UV.push(side < 0 ? 0 : 1, t);
      }
    }
    for (let s = 0; s < L; s++) {
      const i = base + s * 2;
      IDX.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
    }
  };
  const deg = Math.PI / 180;
  for (let layer = 0; layer < 2; layer++) {
    // symmetric about the face: from just behind the cheek round the back to the other cheek
    const from = 72 + layer * 5, to = 360 - from, n = layer ? 17 : 15;
    for (let q = 0; q <= n; q++) {
      const a = (from + ((to - from) * q) / n) * deg;
      const side = Math.abs(Math.sin(a));
      const front = Math.cos(a);
      // the strands at the sides fall in front of the shoulders, the rest down the back
      const toFront = front > -0.12;
      const len = toFront ? 1.31 - 0.02 * layer : 1.26 + 0.03 * (1 - side) - 0.02 * layer;
      ribbon(a, layer, len, toFront);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(UV, 2));
  geo.setIndex(IDX);
  geo.computeVertexNormals();
  const hair = new THREE.Mesh(geo, mat);
  hair.castShadow = true;
  hair.frustumCulled = false;
  g.add(hair);
  return g;
}

/* ------------------------------------------------------------------ */
/* add-ons                                                              */
/* ------------------------------------------------------------------ */
function std(hex, roughness = 0.5, metalness = 0) {
  return new THREE.MeshStandardMaterial({ color: hex, roughness, metalness });
}

/** thin round metal-rim glasses: eye centres at ±ex, height y, lens plane z */
function buildGlasses(eye) {
  const g = new THREE.Group();
  const frame = std("#2a2622", 0.3, 0.8);
  const lens = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, transmission: 0, transparent: true, opacity: 0.16, metalness: 0 });
  const R = 0.0225;
  for (const s of [-1, 1]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.0013, 6, 40), frame);
    rim.position.set(s * eye.x, eye.y, eye.z);
    g.add(rim);
    const glass = new THREE.Mesh(new THREE.CircleGeometry(R, 32), lens);
    glass.position.set(s * eye.x, eye.y, eye.z - 0.001);
    g.add(glass);
    // temple arm back to the ear
    const from = new THREE.Vector3(s * (eye.x + R), eye.y + 0.002, eye.z - 0.004);
    const to = new THREE.Vector3(s * eye.earX, eye.y + 0.004, eye.earZ);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.0011, 0.0011, from.distanceTo(to), 5), frame);
    arm.position.copy(from).lerp(to, 0.5);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
    g.add(arm);
  }
  // bridge
  const bridge = new THREE.Mesh(new THREE.TorusGeometry(eye.x - R, 0.0012, 5, 12, Math.PI), frame);
  bridge.position.set(0, eye.y + 0.002, eye.z + 0.002);
  bridge.scale.y = 0.6;
  g.add(bridge);
  return g;
}

/** aviator sunglasses pushed up on the head */
function buildSunglasses(head) {
  const g = new THREE.Group();
  const frame = std("#c9a45c", 0.25, 0.9);
  const lens = new THREE.MeshStandardMaterial({ color: "#1a1d22", roughness: 0.08, metalness: 0.6 });
  for (const s of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.absellipse(0, 0, 0.024, 0.019, 0, Math.PI * 2);
    const lg = new THREE.ShapeGeometry(shape, 16);
    const l = new THREE.Mesh(lg, lens);
    l.position.set(s * 0.031, -0.004, 0);
    l.rotation.z = s * 0.12;
    g.add(l);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.0215, 0.0012, 5, 32), frame);
    rim.scale.set(1.12, 0.88, 1);
    rim.position.copy(l.position);
    rim.rotation.z = l.rotation.z;
    g.add(rim);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.003, 0.11), frame);
    arm.position.set(s * 0.058, 0.002, -0.052);
    arm.rotation.y = s * 0.08;
    g.add(arm);
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.002, 0.002), frame);
  bar.position.set(0, 0.012, 0.001);
  g.add(bar);
  // on top of the hair, just behind the hairline, tilted back with the skull
  const at = onHead(head, 0, 0.5, 0.018);
  g.position.copy(at);
  g.rotation.x = -0.6;
  return g;
}

function buildEarrings(ears) {
  const g = new THREE.Group();
  const gold = std("#d8b35c", 0.25, 0.95);
  for (const s of [-1, 1]) {
    const stud = new THREE.Mesh(new THREE.SphereGeometry(0.0032, 10, 8), gold);
    stud.position.set(s * ears.x, ears.y, ears.z);
    g.add(stud);
    const drop = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 10, 8), gold);
    drop.position.set(s * (ears.x + 0.001), ears.y - 0.011, ears.z);
    drop.scale.y = 1.4;
    g.add(drop);
  }
  return g;
}

/** a small tan crossbody bag: the strap over the right shoulder, the bag at the left hip */
function buildBag(grid, axis) {
  const leather = std("#9a6a43", 0.55, 0.05);
  const dark = std("#7a5134", 0.6, 0.05);
  const goldM = std("#d2b06a", 0.3, 0.9);
  const bag = new THREE.Group();
  const bw = 0.17, bh = 0.13, bd = 0.05;
  const body = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), leather);
  bag.add(body);
  const flap = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.004, bh * 0.55, 0.006), dark);
  flap.position.set(0, bh * 0.22, bd / 2 + 0.003);
  bag.add(flap);
  const clasp = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.004, 14), goldM);
  clasp.rotation.x = Math.PI / 2;
  clasp.position.set(0, bh * 0.0, bd / 2 + 0.007);
  bag.add(clasp);
  // bag at the left hip, a little forward, its back against the hip
  const at = pushOut(grid, new THREE.Vector3(0.15, 0.86, 0.12), bd / 2 + 0.012, axis);
  bag.position.copy(at);
  bag.rotation.y = 0.55;

  // the strap: right shoulder → across the chest → bag; and over the back → bag
  const ctrl = [
    [0.13, 0.93, 0.13],
    [0.05, 1.12, 0.15],
    [-0.05, 1.3, 0.12],
    [-0.11, 1.43, 0.06],
    [-0.12, 1.46, 0.0],
    [-0.1, 1.42, -0.07],
    [-0.02, 1.25, -0.11],
    [0.12, 1.0, -0.08],
    [0.18, 0.92, 0.04],
  ].map(([x, y, z]) => pushOut(grid, new THREE.Vector3(x, y, z), 0.012, axis));
  const curve = new THREE.CatmullRomCurve3(ctrl);
  const strapPts = curve.getPoints(60).map((p) => pushOut(grid, p, 0.01, axis));
  const strap = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(strapPts), 80, 0.0035, 5), dark);
  strap.scale.set(1, 1, 1);
  return { bag, strap };
}

/* ------------------------------------------------------------------ */
/* the per-rig controller                                               */
/* ------------------------------------------------------------------ */

/**
 * Created once per rig at its rest pose (before the first mixer update, before the model
 * joins the character group). mounts: { head, spine, hips } groups on those bones at the
 * character-space origin. set(preset) dresses the rig as that preset, or undresses it.
 */
export function createSpecialRig({ rig, body, mounts }) {
  const parts = { body: null, head: null, cards: [] };
  rig.model.traverse((o) => {
    if (!o.isSkinnedMesh) return;
    const n = o.material.name || "";
    if (n.endsWith("_Body")) parts.body = o;
    else if (n.endsWith("_Head")) parts.head = o;
    else if (n.endsWith("_HairLashes")) parts.cards.push(o);
  });
  if (!parts.body || !parts.head) return null;
  const original = {
    bodyGeo: parts.body.geometry,
    headGeo: parts.head.geometry,
    cardGeo: parts.cards.map((c) => c.geometry),
    map: parts.body.material.map,
    normalMap: parts.body.material.normalMap,
    mr: parts.body.material.roughnessMap,
    metal: parts.body.material.metalnessMap,
    headMap: parts.head.material.map,
  };
  const mats = boneMatrices(parts.body, rig.model);
  const bodyRest = restVertices(parts.body, mats);
  // the thigh bones, by which side of the body they are on (+x is the avatar's left)
  {
    const bones = parts.body.skeleton.bones;
    const inv = new THREE.Matrix4().copy(rig.model.matrixWorld).invert();
    const th = bones.map((b, i) => [i, b]).filter(([, b]) => /Thigh$/.test(b.name));
    bodyRest.skirtBones = new Set(bones.map((b, i) => (/Pelvis|Spine|Thigh$/.test(b.name) ? i : -1)).filter((i) => i >= 0));
    if (th.length === 2) {
      const x = th.map(([, b]) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv).x);
      bodyRest.thighs = x[0] > x[1] ? { L: th[0][0], R: th[1][0] } : { L: th[1][0], R: th[0][0] };
    }
  }
  const headRest = restVertices(parts.head, parts.head.skeleton === parts.body.skeleton ? mats : boneMatrices(parts.head, rig.model));
  const grid = pointGrid([bodyRest, headRest]);

  // the skull as an ellipsoid fitted to the head mesh above the ears
  let mn = new THREE.Vector3(Infinity, Infinity, Infinity), mx = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let top = -Infinity;
  for (let i = 0; i < headRest.count; i++) top = Math.max(top, headRest.pos[i * 3 + 1]);
  const eyeLine = top - (body === "male" ? 0.13 : 0.12);
  for (let i = 0; i < headRest.count; i++) {
    const y = headRest.pos[i * 3 + 1];
    if (y < eyeLine) continue;
    const x = headRest.pos[i * 3], z = headRest.pos[i * 3 + 2];
    // the female head mesh has the ponytail below the crown, at the back: skip anything that far back
    if (body === "female" && z < -0.12) continue;
    mn.min(new THREE.Vector3(x, y, z));
    mx.max(new THREE.Vector3(x, y, z));
  }
  const skull = {
    c: new THREE.Vector3((mn.x + mx.x) / 2, eyeLine, (mn.z + mx.z) / 2),
    r: new THREE.Vector3((mx.x - mn.x) / 2, top - eyeLine, (mx.z - mn.z) / 2),
  };
  // where the face is: eyes ~3 cm under the brow line, the front of the head
  const axis = new THREE.Vector3(skull.c.x, 0, skull.c.z);

  let current = "none";
  let built = [];
  let skirt = null;
  const dispose = (o) =>
    o.traverse((c) => {
      if (!c.geometry?.userData.shared) c.geometry?.dispose();
      for (const m of [].concat(c.material || [])) m.dispose();
    });

  function clear() {
    for (const [o] of built) {
      o.parent?.remove(o);
      dispose(o);
    }
    built = [];
    if (skirt) {
      skirt.parent?.remove(skirt);
      skirt.geometry.dispose();
      for (const m of [].concat(skirt.material)) m.dispose();
      skirt = null;
    }
    parts.body.geometry = original.bodyGeo;
    parts.head.geometry = original.headGeo;
    parts.cards.forEach((c, i) => (c.geometry = original.cardGeo[i]));
    const bm = parts.body.material;
    bm.map = original.map;
    bm.normalMap = original.normalMap;
    bm.roughnessMap = original.mr;
    bm.metalnessMap = original.metal;
    bm.needsUpdate = true;
    parts.head.material.map = original.headMap;
    parts.head.material.needsUpdate = true;
  }

  const add = (mount, o) => {
    mount.add(o);
    built.push([o]);
  };

  /** Dresses the rig. Resolves once the textures are on (immediately if cached). */
  async function set(preset) {
    const a = SPECIAL_ASSETS[preset];
    if (preset === current) return;
    current = preset;
    clear();
    if (!a) return;
    let tex;
    try {
      tex = await preloadSpecial(preset);
    } catch (err) {
      console.warn("[special] textures failed, keeping the base outfit:", err?.message || err);
      tex = null;
    }
    if (current !== preset || rig.disposed) return;
    const [map, headMap, normalMap, mr, skirtMap] = tex || [];
    const bm = parts.body.material;
    if (map) {
      bm.map = map;
      if (normalMap) bm.normalMap = normalMap;
      if (mr) {
        bm.roughnessMap = mr;
        bm.metalnessMap = mr;
      }
      bm.needsUpdate = true;
    }
    if (headMap) {
      parts.head.material.map = headMap;
      parts.head.material.needsUpdate = true;
    }
    if (a.hideHead) {
      // the ponytail's UV islands share their box with the bottom of the face island (the
      // throat): only drop what hangs behind the head
      const box = inBox(a.hideHead);
      const back = skull.c.z - 0.085;
      parts.head.geometry = withoutUV(original.headGeo, "ponytail", (u, v, i, j, k) => box(u, v) && Math.min(headRest.pos[i * 3 + 2], headRest.pos[j * 3 + 2], headRest.pos[k * 3 + 2]) < back);
    }
    if (a.hideBody) {
      const box = inBox(a.hideBody);
      const above = a.hideAbove ?? -Infinity;
      // near the neck only (her sleeve tabs share the collar's UV box; their slots would show)
      parts.body.geometry = withoutUV(
        original.bodyGeo,
        "collar",
        (u, v, i) => box(u, v) && bodyRest.pos[i * 3 + 1] > above && Math.abs(bodyRest.pos[i * 3]) < 0.2
      );
    }
    if (a.hideCards) parts.cards.forEach((c, i) => (c.geometry = withoutUV(original.cardGeo[i], "cards", a.hideCards)));

    if (a.skirt) {
      const s = a.skirt;
      const mat = s.satin
        ? new THREE.MeshPhysicalMaterial({
            map: skirtMap || null,
            color: skirtMap ? 0xffffff : 0x1f264c,
            roughness: s.roughness,
            metalness: 0.05,
            sheen: 0.8,
            sheenColor: new THREE.Color("#6f7cc0"),
            sheenRoughness: 0.35,
            side: THREE.DoubleSide,
          })
        : new THREE.MeshStandardMaterial({ map: skirtMap || null, color: skirtMap ? 0xffffff : 0x6476cc, roughness: s.roughness, side: THREE.DoubleSide });
      const mats = [mat, std("#f6f5f1", 0.95)];
      skirt = buildSkirt(bodyRest, s, mats);
      parts.body.parent.add(skirt);
    }

    if (a.hair === "curls") {
      add(parts.head.parent, buildScalp(parts.head, headRest, skull, HIM_TILT, HIM_HAIR, 0.003, "him-scalp"));
      add(mounts.head, buildCurls(skull, headRest));
    }
    if (a.hair === "long") {
      add(parts.head.parent, buildScalp(parts.head, headRest, skull, 0.5, HER_HAIR, 0.005, "her-scalp"));
      add(mounts.head, buildLongHair(skull, grid, axis));
    }
    for (const what of a.add || []) {
      if (what === "glasses") {
        add(mounts.head, buildGlasses({ x: 0.033, y: skull.c.y - 0.004, z: skull.c.z + skull.r.z + 0.006, earX: skull.r.x + 0.004, earZ: skull.c.z - 0.01 }));
      } else if (what === "sunglasses") {
        add(mounts.head, buildSunglasses(skull));
      } else if (what === "earrings") {
        add(mounts.head, buildEarrings({ x: skull.r.x - 0.004, y: skull.c.y - 0.06, z: skull.c.z - 0.008 }));
      } else if (what === "bag") {
        const { bag, strap } = buildBag(grid, axis);
        add(mounts.hips, bag);
        add(mounts.spine, strap);
      }
    }
  }

  return {
    set,
    get preset() {
      return current;
    },
    skull,
    thighs: bodyRest.thighs,
    dispose() {
      current = "none";
      clear();
    },
  };
}
