/**
 * Realistic props: swaps the primitive furniture that world.js builds
 * (theatre seats, benches, planters, café tables, dig pit, bone table,
 * volcano cone) for photoscanned CC0 models from Poly Haven, and dresses
 * the halls with plants, chandeliers, statues, vitrines and rope barriers.
 *
 *   import { placeProps } from "./props.js";
 *   placeProps({ scene, world, renderer, quality }).catch(() => {});
 *
 * Everything is additive and best-effort: a primitive is only hidden after
 * the model that replaces it has loaded, and a model that fails to load just
 * leaves the original geometry in place. Repeated models are drawn with one
 * InstancedMesh per material per room, so 168 cinema seats cost 1 draw call.
 * Credits / licences: /models/props/CREDITS.json (all CC0).
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as W from "./world.js";

const BASE = "/models/props/";
const FILES = {
  cinemaSeat: "cinema_seat.glb",
  cinemaSeatLod: "cinema_seat_lod.glb",
  bench: "bench.glb",
  ficus: "plant_ficus.glb",
  philodendron: "plant_philodendron.glb",
  succulent: "plant_succulent.glb",
  chandelier: "chandelier.glb",
  pendant: "pendant_globe.glb",
  bust: "marble_bust.glb",
  vase: "ceramic_vase.glb",
  whale: "bronze_whale.glb",
  shark: "bronze_shark.glb",
  ray: "bronze_ray.glb",
  microscope: "microscope.glb",
  bistro: "bistro_set.glb",
  chalkboard: "chalkboard.glb",
  rocks: "rocks_cluster.glb",
  rock: "rock.glb",
  boulder: "boulder.glb",
  trowel: "trowel.glb",
  spade: "spade.glb",
  bucket: "bucket.glb",
  crateLong: "crate_long.glb",
  crate: "crate.glb",
  table: "work_table.glb",
  magnifier: "magnifier.glb",
  clipboard: "clipboard.glb",
};

const CELL = W.CELL ?? 6;
const g2w = W.g2w ?? ((c) => (c - 15.5) * CELL);
const g2z = W.g2z ?? ((r) => (r - 14.5) * CELL);
const ROOMS = W.ROOMS ?? [];
const roomById = (id) => ROOMS.find((r) => r.id === id) || null;
const roomAt = (x, z) => (W.roomAt ? W.roomAt(x, z) : null);

/* ------------------------------------------------------------------ */
/* small helpers                                                        */
/* ------------------------------------------------------------------ */

let seed = 1337;
const rnd = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const rr = (a, b) => a + (b - a) * rnd();
const near = (a, b, eps = 0.03) => Number.isFinite(a) && Math.abs(a - b) < eps;

function rect(room) {
  const minX = g2w(room.cols[0]) - CELL / 2;
  const maxX = g2w(room.cols[1]) + CELL / 2;
  const minZ = g2z(room.rows[0]) - CELL / 2;
  const maxZ = g2z(room.rows[1]) + CELL / 2;
  return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2 };
}

/** Doorway segments (on the cell borders) parsed from world.js OPEN. */
function doorwaySegments() {
  const out = [];
  for (const key of W.OPEN ?? []) {
    const m = /^([vh]):(\d+),(\d+)$/.exec(key);
    if (!m) continue;
    const c = +m[2];
    const r = +m[3];
    if (m[1] === "v") {
      const z = g2z(r) + CELL / 2;
      out.push({ ax: g2w(c) - CELL / 2, az: z, bx: g2w(c) + CELL / 2, bz: z, kind: "v", c, r });
    } else {
      const x = g2w(c) + CELL / 2;
      out.push({ ax: x, az: g2z(r) - CELL / 2, bx: x, bz: g2z(r) + CELL / 2, kind: "h", c, r });
    }
  }
  return out;
}

/** Merge neighbouring OPEN cells into whole doorways. */
function doorways(segs) {
  const list = [];
  for (const s of segs) {
    const hit = list.find(
      (d) =>
        d.kind === s.kind &&
        (s.kind === "v" ? near(d.az, s.az) && (near(d.bx, s.ax) || near(d.ax, s.bx)) : near(d.ax, s.ax) && (near(d.bz, s.az) || near(d.az, s.bz)))
    );
    if (hit) {
      hit.ax = Math.min(hit.ax, s.ax);
      hit.az = Math.min(hit.az, s.az);
      hit.bx = Math.max(hit.bx, s.bx);
      hit.bz = Math.max(hit.bz, s.bz);
    } else list.push({ ...s });
  }
  return list;
}

function distToSeg(x, z, s) {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / l2));
  return Math.hypot(x - (s.ax + dx * t), z - (s.az + dz * t));
}

/* ------------------------------------------------------------------ */
/* environment map for the props only (metals look dead without one)    */
/* ------------------------------------------------------------------ */

function makeEnvMap(renderer) {
  const envScene = new THREE.Scene();
  const room = new THREE.Mesh(
    new THREE.BoxGeometry(20, 10, 20),
    new THREE.MeshBasicMaterial({ color: 0x3b3833, side: THREE.BackSide })
  );
  room.position.y = 4;
  envScene.add(room);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: 0x2a221b }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.99;
  envScene.add(floor);
  const panel = (w, h, color, x, y, z, rx, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    envScene.add(m);
  };
  const warm = new THREE.Color(0xffe2bd).multiplyScalar(6);
  const cool = new THREE.Color(0xcfe0ff).multiplyScalar(2.2);
  panel(5, 5, warm, -4, 8.9, -3, Math.PI / 2, 0);
  panel(5, 5, warm, 4, 8.9, 3, Math.PI / 2, 0);
  panel(3, 3, warm, 0, 8.9, -6, Math.PI / 2, 0);
  panel(6, 3, cool, 9.9, 4, 0, 0, -Math.PI / 2);
  panel(6, 3, cool.clone().multiplyScalar(0.6), -9.9, 4, 0, 0, Math.PI / 2);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(envScene, 0.04);
  pmrem.dispose();
  envScene.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      o.material.dispose();
    }
  });
  return rt.texture;
}

/* ------------------------------------------------------------------ */
/* model prototypes                                                     */
/* ------------------------------------------------------------------ */

const loader = new GLTFLoader();

/**
 * Loads a GLB and flattens it to { parts: [{ geometry, material }], box }:
 * every mesh baked into model space, meshes sharing a material merged.
 */
async function loadProto(name, prepMaterial) {
  const gltf = await loader.loadAsync(BASE + FILES[name]);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const byMat = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = deinterleave(o.geometry);
    g.applyMatrix4(o.matrixWorld);
    for (const key of Object.keys(g.attributes)) {
      if (!["position", "normal", "uv", "tangent", "color"].includes(key)) g.deleteAttribute(key);
    }
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(g);
  });
  const parts = [];
  for (const [material, geos] of byMat) {
    const m = prepMaterial(material, name);
    let merged = geos.length > 1 ? mergeGeometries(geos, false) : geos[0];
    if (!merged) {
      for (const g of geos) parts.push({ geometry: g, material: m });
      continue;
    }
    parts.push({ geometry: merged, material: m });
  }
  const box = new THREE.Box3();
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    p.geometry.computeBoundingSphere();
    box.union(p.geometry.boundingBox);
  }
  return { name, parts, box };
}

/* ------------------------------------------------------------------ */
/* main entry                                                           */
/* ------------------------------------------------------------------ */

export async function placeProps({ scene, world, renderer, quality = "high" } = {}) {
  if (!scene || !world) throw new Error("placeProps needs { scene, world }");
  // idempotent: a second call returns the first result
  if (scene.userData.__propsPromise) return scene.userData.__propsPromise;
  const run = build({ scene, world, renderer, quality });
  scene.userData.__propsPromise = run;
  run.catch(() => {
    delete scene.userData.__propsPromise;
  });
  return run;
}

async function build({ scene, world, renderer, quality }) {
  seed = 1337; // same layout every visit
  const q = quality === "low" ? 0 : quality === "medium" ? 1 : 2;
  const shadows = q > 0;
  const stats = { loaded: [], failed: [], hidden: 0, placed: {} };
  const ropeGeos = [];
  const postSpots = [];
  const hiddenMeshes = [];

  const root = new THREE.Group();
  root.name = "props";
  root.userData.surface = "skip";
  root.userData.props = true;
  scene.add(root);

  const envMap = scene.environment ? null : renderer ? makeEnvMap(renderer) : null;
  const tune = (mat) => {
    if (envMap && "envMap" in mat && !mat.envMap) {
      mat.envMap = envMap;
      mat.envMapIntensity = mat.metalness > 0.5 ? 0.9 : 0.45;
    }
    mat.needsUpdate = true;
    return mat;
  };
  const prepMaterial = (mat, name) => {
    const m = mat;
    if (m.map) m.map.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 1);
    if (name === "chandelier" && /lamp/i.test(m.name)) {
      m.emissive = new THREE.Color(0xffd6a0);
      m.emissiveMap = m.map || null;
      m.emissiveIntensity = 0.9;
    }
    if (name === "pendant" && /globe|glass/i.test(m.name)) {
      m.emissive = new THREE.Color(0xfff1d6);
      m.emissiveIntensity = 1.4;
      m.transparent = false;
      m.opacity = 1;
    }
    if (m.transparent || m.alphaMode === "BLEND") m.depthWrite = false;
    return tune(m);
  };

  /* ---------- load every model in parallel; failures are tolerated ---------- */
  const protos = {};
  await Promise.all(
    Object.keys(FILES).map(async (name) => {
      try {
        protos[name] = await loadProto(name, prepMaterial);
        stats.loaded.push(name);
      } catch (err) {
        stats.failed.push(name);
        console.warn(`[props] ${FILES[name]} failed to load`, err?.message || err);
      }
    })
  );

  /* ---------- procedural prototypes (always available) ---------- */
  const brass = tune(new THREE.MeshStandardMaterial({ color: 0xc8a050, metalness: 1, roughness: 0.28 }));
  const velvet = tune(new THREE.MeshStandardMaterial({ color: 0x5a0a16, roughness: 0.82 }));
  const marble = tune(new THREE.MeshStandardMaterial({ color: 0xe9e5dc, roughness: 0.32 }));
  const slate = tune(new THREE.MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.55, metalness: 0.05 }));
  const darkWood = tune(new THREE.MeshStandardMaterial({ color: 0x3a2618, roughness: 0.6 }));
  const glass = tune(
    new THREE.MeshStandardMaterial({ color: 0xdfeff2, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.14, depthWrite: false })
  );
  const blackMetal = tune(new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.8, roughness: 0.4 }));

  const post = (() => {
    // classic brass stanchion: weighted base, slim pole, ball finial
    const pts = [
      [0, 0], [0.17, 0], [0.17, 0.018], [0.15, 0.03], [0.06, 0.05], [0.03, 0.08], [0.025, 0.1],
      [0.025, 0.86], [0.035, 0.875], [0.035, 0.9], [0.028, 0.91], [0.045, 0.935], [0.045, 0.955], [0.03, 0.985], [0, 0.995],
    ].map(([x, y]) => new THREE.Vector2(x, y));
    const geo = new THREE.LatheGeometry(pts, 20);
    geo.computeBoundingBox();
    return { name: "stanchion", parts: [{ geometry: geo, material: brass }], box: geo.boundingBox.clone() };
  })();
  const boxProto = (name, w, h, d, material, y0 = 0) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    geo.translate(0, y0 + h / 2, 0);
    geo.computeBoundingBox();
    return { name, parts: [{ geometry: geo, material }], box: geo.boundingBox.clone() };
  };
  const pedestal = (name, material, h = 1.05, w = 0.56) => {
    const geos = [
      new THREE.BoxGeometry(w + 0.14, 0.08, w + 0.14).translate(0, 0.04, 0),
      new THREE.BoxGeometry(w, h - 0.14, w).translate(0, 0.08 + (h - 0.14) / 2, 0),
      new THREE.BoxGeometry(w + 0.1, 0.06, w + 0.1).translate(0, h - 0.03, 0),
    ];
    const geo = mergeGeometries(geos, false);
    geo.computeBoundingBox();
    return { name, parts: [{ geometry: geo, material }], box: geo.boundingBox.clone(), top: h };
  };
  const marblePedestal = pedestal("pedestal-marble", marble, 1.1, 0.62);
  const slatePedestal = pedestal("pedestal-slate", slate, 0.95, 1.1);
  const vitrineBase = boxProto("vitrine-base", 1.3, 0.9, 0.8, darkWood);
  const vitrineGlass = boxProto("vitrine-glass", 1.24, 0.62, 0.74, glass, 0.9);
  const vitrineFrame = (() => {
    const geos = [];
    const t = 0.025;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) geos.push(new THREE.BoxGeometry(t, 0.62, t).translate(sx * 0.62, 1.21, sz * 0.37));
    for (const sz of [-1, 1]) geos.push(new THREE.BoxGeometry(1.26, t, t).translate(0, 1.52, sz * 0.37));
    for (const sx of [-1, 1]) geos.push(new THREE.BoxGeometry(t, t, 0.76).translate(sx * 0.62, 1.52, 0));
    const geo = mergeGeometries(geos, false);
    geo.computeBoundingBox();
    return { name: "vitrine-frame", parts: [{ geometry: geo, material: brass }], box: geo.boundingBox.clone() };
  })();
  const chain = (() => {
    const geo = new THREE.CylinderGeometry(0.012, 0.012, 1, 6).translate(0, 0.5, 0);
    geo.computeBoundingBox();
    return { name: "chain", parts: [{ geometry: geo, material: blackMetal }], box: geo.boundingBox.clone() };
  })();

  /* ---------- batching: one InstancedMesh per proto part per room ---------- */
  const batches = new Map();
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _off = new THREE.Matrix4();

  /**
   * Queue one instance. Options: x, y, z, ry, rx, rz, s (number or [sx,sy,sz]),
   * ground (default true: model's lowest point on y), off [ox,oy,oz] model-space
   * offset, centre (centre model on x/z), shadow (default true), room (cull key).
   */
  function add(proto, o) {
    if (!proto) return false;
    const s = Array.isArray(o.s) ? o.s : [o.s ?? 1, o.s ?? 1, o.s ?? 1];
    const off = [0, 0, 0];
    if (o.centre) {
      off[0] = -(proto.box.min.x + proto.box.max.x) / 2;
      off[2] = -(proto.box.min.z + proto.box.max.z) / 2;
    }
    if (o.off) for (let i = 0; i < 3; i++) off[i] += o.off[i];
    let y = o.y ?? 0;
    if (o.ground !== false && !o.rx && !o.rz) y -= (proto.box.min.y + off[1]) * s[1];
    _off.makeTranslation(off[0], off[1], off[2]);
    _e.set(o.rx || 0, o.ry || 0, o.rz || 0, "YXZ");
    _q.setFromEuler(_e);
    _p.set(o.x, y, o.z);
    _s.set(s[0], s[1], s[2]);
    _m.compose(_p, _q, _s).multiply(_off);
    const room = o.room ?? roomAt(o.x, o.z)?.id ?? "none";
    const key = `${proto.name}|${room}|${o.shadow === false ? 0 : 1}`;
    if (!batches.has(key)) batches.set(key, { proto, room, shadow: o.shadow !== false, matrices: [] });
    batches.get(key).matrices.push(_m.clone());
    stats.placed[proto.name] = (stats.placed[proto.name] || 0) + 1;
    return true;
  }

  /** Lay a model flat on the ground (rx/rz) and lift it so it rests on y. */
  function addLying(proto, o) {
    if (!proto) return false;
    const s = o.s ?? 1;
    const g = new THREE.Box3().copy(proto.box);
    const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(o.rx || 0, 0, o.rz || 0, "YXZ"));
    g.applyMatrix4(m);
    return add(proto, { ...o, y: (o.y ?? 0) - g.min.y * s, ground: false });
  }

  /* ---------- collect what world.js built ---------- */
  const meshes = [];
  scene.traverse((o) => {
    if (o.isMesh && o !== root && !isUnder(o, root)) meshes.push(o);
  });
  const wp = new THREE.Vector3();
  const info = meshes.map((m) => {
    m.getWorldPosition(wp);
    return { mesh: m, type: m.geometry?.type, p: m.geometry?.parameters || {}, x: wp.x, y: wp.y, z: wp.z };
  });
  const hide = (list) => {
    for (const it of list) {
      if (it.mesh.visible) {
        it.mesh.visible = false;
        hiddenMeshes.push(it.mesh);
        stats.hidden++;
      }
    }
  };
  const within = (it, x, z, r) => Math.hypot(it.x - x, it.z - z) <= r;

  /* ---------- obstacle map for free-standing decor ---------- */
  const IGNORE_SURF = new Set(["floor", "ceiling", "wall", "trim"]);
  const blockers = [];
  {
    const b = new THREE.Box3();
    for (const it of info) {
      const m = it.mesh;
      if (m.isInstancedMesh || m.isSkinnedMesh) continue;
      const surf = surfaceOf(m);
      if (IGNORE_SURF.has(surf)) continue;
      if (!visibleChain(m)) continue;
      b.setFromObject(m);
      if (b.isEmpty() || b.min.y > 2.4) continue; // high signs/banners don't block the floor
      if (b.max.x - b.min.x > 30 || b.max.z - b.min.z > 30) continue;
      blockers.push({ minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z, mesh: m });
    }
  }
  const segs = doorwaySegments();
  const doors = doorways(segs);
  const interactables = world.interactables || [];
  const panels = W.EXHIBIT_PANELS || [];
  const displays = world.displays || W.DISPLAYS || [];
  const eraWindows = W.ERA_WINDOWS || [];
  const taken = []; // decor placed by us: { x, z, r }
  const hidden = new Set();

  function isFree(x, z, r, { room = null, ignoreSeats = false } = {}) {
    if (room) {
      const R = rect(room);
      if (x - r < R.minX + 0.25 || x + r > R.maxX - 0.25 || z - r < R.minZ + 0.25 || z + r > R.maxZ - 0.25) return false;
    }
    for (const s of segs) if (distToSeg(x, z, s) < r + 1.6) return false;
    for (const it of interactables) {
      if (ignoreSeats && it.type === "seat") continue;
      const extra = it.type === "seat" ? 0.9 : 0;
      if (Math.hypot(it.x - x, it.z - z) < r + 1.2 + extra) return false;
    }
    for (const p of panels) if (x > p.minX - r - 1 && x < p.maxX + r + 1 && z > p.minZ - r - 1 && z < p.maxZ + r + 1) return false;
    for (const d of displays) {
      const b = d.bounds;
      if (b && x > b.minX - r - 0.8 && x < b.maxX + r + 0.8 && z > b.minZ - r - 0.8 && z < b.maxZ + r + 0.8) return false;
    }
    for (const w of eraWindows) if (Math.hypot(w.x - x, w.z - z) < r + 4.8) return false;
    for (const b of blockers) {
      if (hidden.has(b.mesh)) continue;
      if (x > b.minX - r - 0.35 && x < b.maxX + r + 0.35 && z > b.minZ - r - 0.35 && z < b.maxZ + r + 0.35) return false;
    }
    for (const t of taken) if (Math.hypot(t.x - x, t.z - z) < r + t.r + 0.5) return false;
    return true;
  }
  const claim = (x, z, r) => taken.push({ x, z, r });
  const hideTracked = (list) => {
    for (const it of list) hidden.add(it.mesh);
    hide(list);
  };

  /* ================================================================== */
  /* 1. theatre seats                                                    */
  /* ================================================================== */
  const theatreSeats = interactables.filter((i) => i.type === "seat" && i.area === "theatre" && i.seat);
  if (protos.cinemaSeat && theatreSeats.length) {
    const P = protos.cinemaSeat;
    // the armchair cushion top is at 0.50 m; scale so it lands on seat.y
    const s = (theatreSeats[0].seat.y ?? 0.5) / 0.5;
    for (const it of theatreSeats) {
      const o = { x: it.seat.x, z: it.seat.z, ry: it.seat.ry, s, off: [0, 0, 0.02], room: "theater", shadow: false };
      // "low": only the 400-triangle stand-in; otherwise it is drawn when the
      // theatre is only seen from the neighbouring rooms
      if (q > 0 || !protos.cinemaSeatLod) add(P, o);
      if (protos.cinemaSeatLod) add(protos.cinemaSeatLod, o);
    }
    // hide the primitive seat parts: InstancedMeshes with one instance per seat inside the theatre
    const theatre = roomById("theater");
    const seatParts = info.filter((it) => {
      if (!it.mesh.isInstancedMesh || it.mesh.count !== theatreSeats.length) return false;
      it.mesh.getMatrixAt(0, _m);
      _p.setFromMatrixPosition(_m);
      const r = roomAt(_p.x, _p.z);
      return r && theatre && r.id === theatre.id;
    });
    // older world.js variants: individual fabric meshes inside the theatre
    if (!seatParts.length) {
      for (const it of info) {
        if (surfaceOf(it.mesh) === "fabric" && roomAt(it.x, it.z)?.id === "theater" && it.y < 1.6) seatParts.push(it);
      }
    }
    hideTracked(seatParts);
  }

  /* ================================================================== */
  /* 2. benches (all of world.js's addBench calls)                       */
  /* ================================================================== */
  if (protos.bench) {
    const P = protos.bench;
    const benchSeats = info.filter((it) => it.type === "BoxGeometry" && near(it.p.width, 3.2) && near(it.p.height, 0.16) && near(it.p.depth, 0.9));
    const done = [];
    for (const it of benchSeats) {
      const g = it.mesh.parent;
      if (!g) continue;
      g.updateWorldMatrix(true, false);
      const pos = new THREE.Vector3().setFromMatrixPosition(g.matrixWorld);
      const ry = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(g.matrixWorld), "YXZ").y;
      // seat height 0.45 in the model -> 0.56 at 1.25x (world bench seat is 0.58)
      add(P, { x: pos.x, z: pos.z, ry, s: 1.25, centre: true });
      done.push({ x: pos.x, z: pos.z });
      claim(pos.x, pos.z, 1.7);
      const parts = info.filter((o) => isUnder(o.mesh, g));
      hideTracked(parts);
    }
    // fallback: interactable benches that the geometry scan missed
    const groups = new Map();
    for (const it of interactables) {
      if (it.type !== "seat" || it.area !== "bench" || !it.seat) continue;
      const key = String(it.id).replace(/-\d+$/, "");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    for (const list of groups.values()) {
      const x = list.reduce((a, b) => a + b.seat.x, 0) / list.length;
      const z = list.reduce((a, b) => a + b.seat.z, 0) / list.length;
      if (done.some((d) => Math.hypot(d.x - x, d.z - z) < 1)) continue;
      add(P, { x, z, ry: list[0].seat.ry, s: 1.25, centre: true });
      claim(x, z, 1.7);
      hideTracked(info.filter((o) => surfaceOf(o.mesh) === "wood" && within(o, x, z, 1.5) && o.y < 1.2));
    }
  }

  /* ================================================================== */
  /* 3. planters -> real potted plants                                   */
  /* ================================================================== */
  const plantPick = (i) => (i % 2 === 1 ? protos.philodendron : protos.ficus) || protos.ficus || protos.philodendron;
  {
    const pots = info.filter((it) => it.type === "CylinderGeometry" && near(it.p.radiusTop, 0.7) && near(it.p.radiusBottom, 0.55) && near(it.p.height, 0.9));
    pots.forEach((pot, i) => {
      const P = plantPick(i);
      if (!P) return;
      const big = P === protos.ficus;
      add(P, { x: pot.x, z: pot.z, ry: rr(0, Math.PI * 2), s: big ? 1.55 : 1.7, centre: true });
      claim(pot.x, pot.z, 0.8);
      const leaves = info.filter((o) => o.type === "ConeGeometry" && near(o.p.radius, 0.22) && within(o, pot.x, pot.z, 0.8));
      hideTracked([pot, ...leaves]);
    });
  }

  /* ================================================================== */
  /* 4. ice cream court                                                  */
  /* ================================================================== */
  const court = roomById("court");
  const COURT = W.COURT || { stallX: 66, stallZ: 76 };
  const stall = interactables.find((i) => i.type === "icecream") || { x: COURT.stallX, z: COURT.stallZ - 3.2, radius: 6 };
  if (court) {
    const inCourt = (it) => roomAt(it.x, it.z)?.id === "court";
    // café tables (top + leg + parasol + stick) -> bistro sets
    const tops = info.filter((it) => inCourt(it) && it.type === "CylinderGeometry" && near(it.p.radiusTop, 1.3) && near(it.p.height, 0.12));
    if (protos.bistro) {
      tops.forEach((t, i) => {
        add(protos.bistro, { x: t.x, z: t.z, ry: (i * 1.3) % Math.PI, centre: true });
        if (q > 0 && protos.succulent) add(protos.succulent, { x: t.x - 0.08, z: t.z + 0.05, y: 0.73, s: 1.1, centre: true, ground: false, off: [0, -protos.succulent.box.min.y, 0] });
        claim(t.x, t.z, 1.2);
        hideTracked(info.filter((o) => inCourt(o) && within(o, t.x, t.z, 0.35) && /Cylinder|Cone/.test(o.type || "")));
      });
      // a few more sets so the court reads as a café
      if (q > 0) {
        const R = rect(court);
        const extra = [];
        for (let x = R.minX + 4; x <= R.maxX - 4; x += 3.8) {
          for (let z = R.minZ + 4; z <= R.maxZ - 4; z += 3.8) extra.push([x, z]);
        }
        let n = 0;
        for (const [x, z] of extra.sort(() => rnd() - 0.5)) {
          if (n >= (q > 1 ? 9 : 4)) break;
          if (Math.hypot(x - stall.x, z - stall.z) < (stall.radius || 6) + 2.5) continue;
          if (Math.hypot(x - COURT.stallX, z - COURT.stallZ) < 8) continue;
          if (!isFree(x, z, 1.1, { room: court })) continue;
          add(protos.bistro, { x, z, ry: rr(0, Math.PI), centre: true });
          if (protos.succulent) add(protos.succulent, { x, z, y: 0.73, s: 1.1, centre: true, ground: false, off: [0, -protos.succulent.box.min.y, 0] });
          claim(x, z, 1.1);
          n++;
        }
      }
    }
    // the cartoon ice-cream statue -> planted island + menu board
    const statue = info.filter(
      (it) => inCourt(it) && ((it.type === "ConeGeometry" && near(it.p.radius, 1.7) && near(it.p.height, 3.8)) || (it.type === "SphereGeometry" && near(it.p.radius, 1.8)))
    );
    if (statue.length && protos.ficus) {
      const sx = statue[0].x;
      const sz = statue[0].z;
      add(protos.ficus, { x: sx, z: sz, ry: 0.4, s: 1.9, centre: true });
      if (protos.philodendron) {
        add(protos.philodendron, { x: sx + 1.1, z: sz + 0.7, ry: 2.1, s: 1.6, centre: true });
        add(protos.philodendron, { x: sx - 1.0, z: sz + 0.9, ry: 4.2, s: 1.4, centre: true });
      }
      if (protos.chalkboard) add(protos.chalkboard, { x: sx + 0.4, z: sz + 2.2, ry: 0.25, s: 1.1, centre: true });
      claim(sx, sz, 2.4);
      hideTracked(statue);
    }
    // plants along the court walls
    if (q > 0) {
      let n = 0;
      for (const sp of wallSpots(court, 1.0, 5)) {
        if (n >= (q > 1 ? 6 : 3)) break;
        if (Math.hypot(sp.x - stall.x, sp.z - stall.z) < (stall.radius || 6) + 1.5) continue;
        if (!isFree(sp.x, sp.z, 0.6, { room: court })) continue;
        const P = plantPick(n);
        add(P, { x: sp.x, z: sp.z, ry: rr(0, 6.28), s: P === protos.ficus ? 1.5 : 1.6, centre: true });
        claim(sp.x, sp.z, 0.6);
        n++;
      }
    }
  }

  /* ================================================================== */
  /* 5. dig site (triassic)                                              */
  /* ================================================================== */
  const digIt = interactables.find((i) => i.type === "dig");
  if (digIt) {
    const pit = info.find((it) => it.type === "CylinderGeometry" && near(it.p.radiusTop, 3.4) && within(it, digIt.x, digIt.z, 1.5));
    const cx = pit ? pit.x : digIt.x;
    const cz = pit ? pit.z : digIt.z;
    const ground = await makeDigGround(tune).catch((e) => {
      console.warn("[props] dig ground textures failed", e?.message || e);
      return null;
    });
    if (ground && (protos.rocks || protos.rock)) {
      ground.position.set(cx, 0, cz);
      ground.receiveShadow = shadows;
      root.add(ground);
      // a scatter of photoscanned rocks half sunk in the soil
      const P = protos.rock;
      if (P) {
        for (let i = 0; i < 7; i++) {
          const a = (i / 7) * Math.PI * 2 + rr(-0.3, 0.3);
          const d = rr(0.7, 2.4);
          add(P, { x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d, y: 0.03, ry: rr(0, 6.28), s: rr(1.0, 1.9) });
        }
        // spoil stones kicked up onto the berm
        for (let i = 0; i < 9; i++) {
          const a = rr(0, Math.PI * 2);
          add(P, { x: cx + Math.cos(a) * rr(2.9, 3.2), z: cz + Math.sin(a) * rr(2.9, 3.2), y: 0.1, ry: rr(0, 6.28), s: rr(0.8, 1.4) });
        }
      }
      if (protos.rocks) {
        add(protos.rocks, { x: cx - 1.2, z: cz - 0.6, y: 0.08, ry: 0.8, s: 1.6, centre: true });
        add(protos.rocks, { x: cx + 1.0, z: cz + 1.0, y: 0.08, ry: 2.6, s: 1.3, centre: true });
      }
      if (protos.trowel) addLying(protos.trowel, { x: cx + 0.6, z: cz - 0.9, y: 0.1, ry: 0.9, s: 1.2 });
      if (protos.trowel) addLying(protos.trowel, { x: cx - 0.4, z: cz + 1.6, y: 0.1, ry: 2.4, s: 1.2 });
      if (protos.spade) addLying(protos.spade, { x: cx + 2.2, z: cz + 0.3, y: 0.12, ry: 1.2, rx: Math.PI / 2, s: 1.1 });
      if (protos.bucket) add(protos.bucket, { x: cx + 1.9, z: cz - 1.6, y: 0.1, ry: 0.4, s: 1.1 });
      if (protos.crateLong) add(protos.crateLong, { x: cx - 2.1, z: cz + 1.3, y: 0.08, ry: 0.9, s: 1.1, centre: true });
      // archaeologists' 1 m string grid on little stakes
      {
        const strings = [];
        const stakes = [];
        const lim = 2.6;
        for (let k = -2; k <= 2; k++) {
          const off = k * 1.0;
          const half = Math.sqrt(Math.max(0, lim * lim - off * off));
          strings.push(new THREE.BoxGeometry(half * 2, 0.008, 0.008).translate(cx, 0.24, cz + off));
          strings.push(new THREE.BoxGeometry(0.008, 0.008, half * 2).translate(cx + off, 0.24, cz));
          for (const sgn of [-1, 1]) {
            stakes.push(new THREE.BoxGeometry(0.04, 0.3, 0.04).translate(cx + sgn * half, 0.15, cz + off));
            stakes.push(new THREE.BoxGeometry(0.04, 0.3, 0.04).translate(cx + off, 0.15, cz + sgn * half));
          }
        }
        const sm = new THREE.Mesh(mergeGeometries(strings, false), new THREE.MeshStandardMaterial({ color: 0xe8e2d0, roughness: 0.9 }));
        const st = new THREE.Mesh(mergeGeometries(stakes, false), tune(new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.8 })));
        for (const m of [sm, st]) {
          m.userData.surface = "skip";
          m.castShadow = q > 1;
          root.add(m);
        }
      }
      // low rope barrier with a gap facing the hall
      const hall = roomAt(cx, cz);
      const hc = hall ? rect(hall) : { cx, cz: cz - 10 };
      const facing = Math.atan2(hc.cz - cz, hc.cx - cx);
      const pts = [];
      const N = 12;
      for (let i = 0; i <= N; i++) {
        const a = facing + 0.55 + (i / N) * (Math.PI * 2 - 1.1);
        pts.push([cx + Math.cos(a) * 4.1, cz + Math.sin(a) * 4.1]);
      }
      ropeLine(pts, 0.62);
      claim(cx, cz, 4.4);
      hideTracked(info.filter((it) => (it === pit) || (it.type === "CapsuleGeometry" && within(it, cx, cz, 3.8))));
    }
  }

  /* ================================================================== */
  /* 6. bone assembly table                                              */
  /* ================================================================== */
  const puzIt = interactables.find((i) => i.type === "puzzle");
  if (puzIt && protos.table) {
    const top = info.find((it) => it.type === "BoxGeometry" && near(it.p.width, 5.5) && near(it.p.depth, 3.2) && within(it, puzIt.x, puzIt.z, 2));
    const cx = top ? top.x : puzIt.x;
    const cz = top ? top.z : puzIt.z;
    const sx = 2.6;
    const sy = 1.15;
    const sz = 2.2;
    add(protos.table, { x: cx, z: cz, s: [sx, sy, sz], centre: true });
    const ty = protos.table.box.max.y * sy;
    const on = (P, o) => P && add(P, { ...o, y: ty + (o.y || 0) });
    on(protos.crate, { x: cx - 0.9, z: cz - 0.25, ry: 0.12, s: 0.9, centre: true });
    on(protos.microscope, { x: cx + 0.95, z: cz - 0.3, ry: -0.6, s: 1.1 });
    if (protos.magnifier) addLying(protos.magnifier, { x: cx + 0.25, z: cz + 0.35, y: ty, ry: 0.7, rx: -Math.PI / 2, s: 1.2 });
    on(protos.clipboard, { x: cx - 0.15, z: cz + 0.4, ry: -0.25, s: 1.1 });
    if (protos.rock) {
      for (let i = 0; i < 5; i++) on(protos.rock, { x: cx + 0.1 + i * 0.28, z: cz + 0.1 + (i % 2) * 0.15 - 0.4, ry: i * 1.7, s: rr(0.7, 1.1) });
    }
    if (protos.trowel) addLying(protos.trowel, { x: cx + 1.1, z: cz + 0.45, y: ty, ry: 1.9, s: 1.1 });
    // work lamps hanging over the table
    const hall = roomAt(cx, cz);
    if (protos.pendant && hall) {
      for (const dx of [-0.75, 0.75]) hangPendant(cx + dx, cz, hall.h, 3.0);
    }
    claim(cx, cz, 2.2);
    const extra = info.filter(
      (it) =>
        (it === top) ||
        (it.type === "BoxGeometry" && near(it.p.width, 0.22) && near(it.p.depth, 2.8) && within(it, cx, cz, 3)) ||
        (it.type === "CapsuleGeometry" && within(it, cx, cz, 3.2))
    );
    hideTracked(extra);
  }

  /* ================================================================== */
  /* 7. volcano diorama -> boulder formation                             */
  /* ================================================================== */
  {
    const cone = info.find((it) => it.type === "ConeGeometry" && near(it.p.radius, 4.6) && near(it.p.height, 5.8));
    if (cone && protos.boulder) {
      const cx = cone.x;
      const cz = cone.z;
      add(protos.boulder, { x: cx, z: cz, ry: 0.5, s: 2.1, centre: true });
      add(protos.boulder, { x: cx + 2.6, z: cz - 1.4, ry: 2.4, s: 1.05, centre: true });
      add(protos.boulder, { x: cx - 2.3, z: cz + 1.3, ry: 4.0, s: 0.8, centre: true });
      if (protos.rocks) {
        add(protos.rocks, { x: cx - 2.2, z: cz - 2.6, ry: 1.1, s: 2.2, centre: true });
        add(protos.rocks, { x: cx + 2.9, z: cz + 2.0, ry: 3.3, s: 1.8, centre: true });
      }
      // a dim magma glow deep in the crack between the rocks
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(0.9, 20),
        new THREE.MeshStandardMaterial({ color: 0x220800, emissive: 0xff4a12, emissiveIntensity: 1.6, roughness: 1 })
      );
      glow.rotation.x = -Math.PI / 2;
      glow.scale.set(1.6, 0.45, 1);
      glow.position.set(cx + 1.25, 0.02, cz - 0.85);
      glow.rotation.z = 0.9;
      glow.userData.surface = "skip";
      root.add(glow);
      // keep visitors back: brass stanchions around the formation
      const r = 5.6;
      const pts = [];
      for (let i = 0; i <= 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r * 0.85]);
      }
      if (q > 0) ropeLine(pts, 0.92);
      claim(cx, cz, r + 0.4);
      const lava = info.filter((it) => it.type === "CircleGeometry" && near(it.p.radius, 1.2) && within(it, cx, cz, 1.5));
      hideTracked([cone, ...lava]);
    }
  }

  /* ================================================================== */
  /* 8. decor: plants by doorways and in corners                         */
  /* ================================================================== */
  const decorRooms = ["lobby", "rotunda", "cretaceous", "marine", "predator", "triassic", "jurassic"];
  const plantBudget = [6, 16, 28][q];
  let plants = 0;
  const putPlant = (x, z, room) => {
    if (plants >= plantBudget) return false;
    const P = plantPick(plants);
    if (!P) return false;
    if (!isFree(x, z, 0.6, { room })) return false;
    add(P, { x, z, ry: rr(0, 6.28), s: P === protos.ficus ? rr(1.4, 1.7) : rr(1.5, 1.8), centre: true });
    claim(x, z, 0.6);
    plants++;
    return true;
  };
  // flank each doorway on both sides, inside each room it connects
  for (const d of doors) {
    const horiz = d.kind === "v"; // wall runs along x
    const mx = (d.ax + d.bx) / 2;
    const mz = (d.az + d.bz) / 2;
    for (const side of [-1, 1]) {
      const room = roomAt(mx + (horiz ? 0 : side * 0.5), mz + (horiz ? side * 0.5 : 0));
      if (!room || !decorRooms.includes(room.id)) continue;
      for (const end of [-1, 1]) {
        const x = horiz ? (end < 0 ? d.ax - 1.4 : d.bx + 1.4) : mx + side * 0.95;
        const z = horiz ? mz + side * 0.95 : end < 0 ? d.az - 1.4 : d.bz + 1.4;
        putPlant(x, z, room);
      }
    }
  }
  for (const id of decorRooms) {
    const room = roomById(id);
    if (!room) continue;
    for (const sp of wallSpots(room, 1.0, 999)) if (sp.corner) putPlant(sp.x, sp.z, room);
  }

  /* ---------- statues on pedestals ---------- */
  const pedestalRow = (roomId, items, Ped, maxN) => {
    const room = roomById(roomId);
    if (!room) return;
    let n = 0;
    const R = rect(room);
    // mid-wall spots first, never crammed into a corner
    const spots = wallSpots(room, 1.0, 3)
      .filter((s) => !s.corner)
      .map((s) => {
        const ns = Math.abs(Math.sin(s.ry)) < 0.5; // on a north/south wall
        const edge = ns ? Math.min(s.x - R.minX, R.maxX - s.x) : Math.min(s.z - R.minZ, R.maxZ - s.z);
        const along = ns ? Math.abs(s.x - R.cx) / (R.maxX - R.minX) : Math.abs(s.z - R.cz) / (R.maxZ - R.minZ);
        return { s, k: along, edge };
      })
      .filter((a) => a.edge > 4)
      .sort((a, b) => a.k - b.k)
      .map((a) => a.s);
    const used = [];
    for (const sp of spots) {
      if (n >= Math.min(maxN, items.length)) break;
      if (used.some((u) => Math.hypot(u.x - sp.x, u.z - sp.z) < 8)) continue;
      const it = items[n];
      // big pieces stand a little further off the wall so they never clip it
      let push = 0;
      if (it.proto) {
        const b = it.proto.box;
        push = Math.max(0, (Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * it.s) / 2 - 0.6);
      }
      const x = sp.x + Math.sin(sp.ry) * push;
      const z = sp.z + Math.cos(sp.ry) * push;
      const r = 0.75 + push * 0.5;
      if (!isFree(x, z, r, { room })) continue;
      used.push(sp);
      if (!it.proto) {
        n++;
        continue;
      }
      add(Ped, { x, z, ry: sp.ry });
      add(it.proto, { x, z, y: Ped.top ?? 1.05, ry: sp.ry + (it.turn || 0), s: it.s, centre: true });
      claim(x, z, r);
      n++;
    }
  };
  pedestalRow(
    "rotunda",
    [
      { proto: protos.bust, s: 2.0 },
      { proto: protos.vase, s: 2.2 },
      { proto: protos.bust, s: 2.0 },
      { proto: protos.vase, s: 2.2 },
    ],
    marblePedestal,
    [1, 2, 4][q]
  );
  pedestalRow(
    "marine",
    [
      { proto: protos.whale, s: 1.6, turn: 0.4 },
      { proto: protos.shark, s: 2.3, turn: -0.5 },
      { proto: protos.ray, s: 2.0, turn: 0.3 },
    ],
    slatePedestal,
    [1, 3, 3][q]
  );
  pedestalRow("lobby", [{ proto: protos.vase, s: 2.2 }, { proto: protos.vase, s: 2.2 }], marblePedestal, [0, 2, 2][q]);

  /* ---------- vitrines with instruments ---------- */
  if (q > 0) {
    for (const id of ["cretaceous", "triassic"]) {
      const room = roomById(id);
      if (!room) continue;
      for (const sp of wallSpots(room, 1.0, 3)) {
        if (sp.corner) continue;
        if (!isFree(sp.x, sp.z, 0.7, { room })) continue;
        add(vitrineBase, { x: sp.x, z: sp.z, ry: sp.ry });
        add(vitrineGlass, { x: sp.x, z: sp.z, ry: sp.ry, ground: false, shadow: false });
        add(vitrineFrame, { x: sp.x, z: sp.z, ry: sp.ry, ground: false });
        if (protos.microscope) add(protos.microscope, { x: sp.x + Math.cos(sp.ry) * 0.3, z: sp.z - Math.sin(sp.ry) * 0.3, y: 0.9, ry: sp.ry + 0.5, s: 1.2, centre: true });
        if (protos.rock) {
          add(protos.rock, { x: sp.x - Math.cos(sp.ry) * 0.3, z: sp.z + Math.sin(sp.ry) * 0.3, y: 0.9, ry: sp.ry, s: 1.3, centre: true });
        }
        claim(sp.x, sp.z, 0.8);
        break;
      }
    }
  }

  /* ---------- chandeliers under the ceiling lights of the grand rooms ---------- */
  if (protos.chandelier) {
    for (const id of ["lobby", "rotunda"]) {
      const room = roomById(id);
      if (!room) continue;
      const fixtures = info.filter(
        (it) => it.type === "CylinderGeometry" && near(it.p.radiusTop, 0.55) && near(it.p.radiusBottom, 0.72) && roomAt(it.x, it.z)?.id === id
      );
      const s = id === "rotunda" ? 3.2 : 2.6;
      for (const f of fixtures.slice(0, q === 0 ? 2 : 8)) {
        const drop = id === "rotunda" ? 4.2 : 3.2; // chain length below the ceiling
        const topY = room.h - drop;
        add(protos.chandelier, { x: f.x, z: f.z, y: topY, s, ground: false, shadow: false, ry: rr(0, 6.28) });
        add(chain, { x: f.x, z: f.z, y: topY, s: [1, drop, 1], ground: false, shadow: false });
      }
    }
  }

  /* ================================================================== */
  /* build the instanced meshes                                          */
  /* ================================================================== */
  for (const [key, b] of batches) {
    for (const part of b.proto.parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, b.matrices.length);
      b.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = shadows && b.shadow && !part.material.transparent;
      mesh.receiveShadow = shadows;
      mesh.name = `prop:${key}`;
      mesh.userData.surface = "skip";
      mesh.userData.prop = b.proto.name;
      mesh.userData.propRoom = b.room;
      if (protos.cinemaSeatLod && b.proto.name === "cinemaSeatLod" && q > 0) mesh.userData.lod = "far";
      if (protos.cinemaSeatLod && b.proto.name === "cinemaSeat") mesh.userData.lod = "near";
      root.add(mesh);
    }
  }
  if (ropeGeos.length) {
    const geo = mergeGeometries(ropeGeos, false);
    if (geo) {
      const ropes = new THREE.Mesh(geo, velvet);
      ropes.castShadow = false;
      ropes.receiveShadow = shadows;
      ropes.userData.surface = "skip";
      ropes.name = "prop:ropes";
      root.add(ropes);
    }
  }
  if (postSpots.length) {
    for (const [x, z] of postSpots) add(post, { x, z, room: "all-posts" });
    const b = batches.get(`stanchion|all-posts|1`);
    if (b) {
      const mesh = new THREE.InstancedMesh(post.parts[0].geometry, brass, b.matrices.length);
      b.matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = shadows && q > 1;
      mesh.userData.surface = "skip";
      mesh.name = "prop:stanchions";
      root.add(mesh);
    }
  }

  stats.drawables = root.children.length;

  /* ---------- per-room culling: only draw props of rooms you could see into ---------- */
  const adj = new Map();
  for (const sg of segs) {
    const a = sg.kind === "v" ? roomAt(g2w(sg.c), g2z(sg.r)) : roomAt(g2w(sg.c), g2z(sg.r));
    const b = sg.kind === "v" ? roomAt(g2w(sg.c), g2z(sg.r + 1)) : roomAt(g2w(sg.c + 1), g2z(sg.r));
    if (!a || !b || a.id === b.id) continue;
    if (!adj.has(a.id)) adj.set(a.id, new Set());
    if (!adj.has(b.id)) adj.set(b.id, new Set());
    adj.get(a.id).add(b.id);
    adj.get(b.id).add(a.id);
  }
  const reach = new Map(); // roomId -> Set of rooms within 2 doorways
  const reachable = (id) => {
    if (reach.has(id)) return reach.get(id);
    const set = new Set([id]);
    let frontier = [id];
    for (let depth = 0; depth < 2; depth++) {
      const next = [];
      for (const r of frontier) for (const n of adj.get(r) || []) if (!set.has(n)) (set.add(n), next.push(n));
      frontier = next;
    }
    reach.set(id, set);
    return set;
  };
  const roomMeshes = root.children.filter((m) => m.userData.propRoom && ROOMS.some((r) => r.id === m.userData.propRoom));
  let lastRoom;
  let cullOn = true;
  const prevHook = scene.onBeforeRender;
  const hook = function (rend, sc, cam, ...rest) {
    if (typeof prevHook === "function") prevHook.call(this, rend, sc, cam, ...rest);
    if (!cullOn || !cam) return;
    const r = roomAt(cam.position.x, cam.position.z);
    const id = r ? r.id : null;
    if (id === lastRoom) return;
    lastRoom = id;
    const vis = id ? reachable(id) : null;
    const nearTheatre = !id || id === "theater" || id === "ncorridor";
    for (const m of roomMeshes) {
      const lod = m.userData.lod;
      m.visible = (!vis || vis.has(m.userData.propRoom)) && (!lod || (lod === "near") === nearTheatre);
    }
  };
  scene.onBeforeRender = hook;

  return {
    group: root,
    stats,
    /** Turn per-room culling off/on (on by default). */
    setCulling(on) {
      cullOn = !!on;
      lastRoom = undefined;
      if (!cullOn) for (const m of roomMeshes) m.visible = m.userData.lod !== "far";
    },
    /** Remove every prop and bring back the primitives they replaced. */
    dispose() {
      if (scene.onBeforeRender === hook) scene.onBeforeRender = prevHook;
      for (const m of hiddenMeshes) m.visible = true;
      delete scene.userData.__propsPromise;
      root.removeFromParent();
      root.traverse((o) => o.isInstancedMesh && o.dispose());
    },
  };

  /* ---------------- hoisted helpers that close over state ---------------- */

  function hangPendant(x, z, ceilingH, bottomY) {
    const P = protos.pendant;
    const h = (P.box.max.y - P.box.min.y) * 1.2;
    const topY = bottomY + h;
    add(P, { x, z, y: bottomY, s: 1.2, ground: true, shadow: false, centre: true });
    add(chain, { x, z, y: topY - 0.02, s: [0.8, ceilingH - topY, 0.8], ground: false, shadow: false });
  }

  /** Brass posts at each point with a sagging velvet rope between neighbours. */
  function ropeLine(points, height = 0.9) {
    for (const p of points) {
      if (postSpots.some(([x, z]) => Math.hypot(x - p[0], z - p[1]) < 0.3)) continue;
      postSpots.push(p);
    }
    const hookY = height * 0.93;
    for (let i = 0; i < points.length - 1; i++) {
      const [ax, az] = points[i];
      const [bx, bz] = points[i + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.4) continue;
      const sag = Math.min(0.22, len * 0.09);
      const pts = [];
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        pts.push(new THREE.Vector3(ax + (bx - ax) * t, hookY - Math.sin(Math.PI * t) * sag, az + (bz - az) * t));
      }
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.022, 6, false);
      ropeGeos.push(tube);
    }
  }

  /** Candidate spots along the inside of a room's walls (facing inwards). */
  function wallSpots(room, inset, step) {
    const R = rect(room);
    const out = [];
    const corners = [
      [R.minX + inset, R.minZ + inset],
      [R.maxX - inset, R.minZ + inset],
      [R.maxX - inset, R.maxZ - inset],
      [R.minX + inset, R.maxZ - inset],
    ];
    for (const [x, z] of corners) out.push({ x, z, ry: Math.atan2(R.cx - x, R.cz - z), corner: true });
    if (step < 100) {
      for (let x = R.minX + CELL / 2; x <= R.maxX - CELL / 2 + 0.01; x += step) {
        out.push({ x, z: R.minZ + inset, ry: 0, corner: false });
        out.push({ x, z: R.maxZ - inset, ry: Math.PI, corner: false });
      }
      for (let z = R.minZ + CELL / 2; z <= R.maxZ - CELL / 2 + 0.01; z += step) {
        out.push({ x: R.minX + inset, z, ry: Math.PI / 2, corner: false });
        out.push({ x: R.maxX - inset, z, ry: -Math.PI / 2, corner: false });
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* dig site ground: a soil disc with a raised berm (PBR, CC0 texture)   */
/* ------------------------------------------------------------------ */

async function makeDigGround(tune) {
  const tl = new THREE.TextureLoader();
  const load = (f, srgb) =>
    tl.loadAsync(BASE + "textures/" + f).then((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 4;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    });
  const [map, normalMap, arm] = await Promise.all([
    load("dry_ground_rocks_diff_1k.jpg", true),
    load("dry_ground_rocks_nor_gl_1k.jpg", false),
    load("dry_ground_rocks_arm_1k.jpg", false),
  ]);
  const R = 3.45;
  const rings = 22;
  const segs = 72;
  const pos = [];
  const uv = [];
  const idx = [];
  const height = (r, a) => {
    const t = r / R;
    const berm = Math.exp(-Math.pow((t - 0.86) / 0.09, 2)) * 0.2;
    const fade = t > 0.96 ? Math.max(0, 1 - (t - 0.96) / 0.04) : 1;
    const noise = (Math.sin(a * 5 + r * 3.1) + Math.sin(a * 11 - r * 5.3) * 0.5 + Math.sin(r * 9.7 + a * 2) * 0.4) * 0.012;
    return Math.max(0.005, (0.045 + berm + noise) * fade + 0.004);
  };
  pos.push(0, height(0, 0), 0);
  uv.push(0.5 * 2.4, 0.5 * 2.4);
  for (let i = 1; i <= rings; i++) {
    const r = (i / rings) * R;
    for (let j = 0; j < segs; j++) {
      const a = (j / segs) * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      pos.push(x, height(r, a), z);
      uv.push((x / (2 * R) + 0.5) * 2.4, (z / (2 * R) + 0.5) * 2.4);
    }
  }
  for (let j = 0; j < segs; j++) idx.push(0, 1 + ((j + 1) % segs), 1 + j);
  for (let i = 1; i < rings; i++) {
    const a0 = 1 + (i - 1) * segs;
    const b0 = 1 + i * segs;
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      idx.push(a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = tune(
    new THREE.MeshStandardMaterial({ map, normalMap, aoMap: arm, roughnessMap: arm, metalnessMap: null, roughness: 1, metalness: 0 })
  );
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "prop:dig-ground";
  mesh.userData.surface = "skip";
  return mesh;
}

/** Plain (non-interleaved) copy of a geometry so mergeGeometries can join it. */
function deinterleave(src) {
  const g = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(src.attributes)) {
    if (!attr.isInterleavedBufferAttribute) {
      g.setAttribute(name, attr.clone());
      continue;
    }
    const n = attr.count;
    const k = attr.itemSize;
    // getX() returns de-normalised floats for normalised data, so store floats
    const arr = attr.normalized ? new Float32Array(n * k) : new attr.array.constructor(n * k);
    const get = ["getX", "getY", "getZ", "getW"];
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) arr[i * k + c] = attr[get[c]](i);
    g.setAttribute(name, new THREE.BufferAttribute(arr, k, false));
  }
  if (src.index) g.setIndex(src.index.clone());
  for (const grp of src.groups) g.addGroup(grp.start, grp.count, grp.materialIndex);
  return g;
}

function isUnder(o, parent) {
  for (let p = o.parent; p; p = p.parent) if (p === parent) return true;
  return false;
}
function surfaceOf(o) {
  for (let p = o; p; p = p.parent) if (p.userData && p.userData.surface) return p.userData.surface;
  return null;
}
function visibleChain(o) {
  for (let p = o; p; p = p.parent) if (p.visible === false) return false;
  return true;
}
