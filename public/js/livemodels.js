/**
 * Life-size, licensed 3D dinosaur models (CC BY 4.0, see
 * /models/real/manifest.json) standing on low plinths behind brass rails.
 *
 *   const live = placeLiveModels({ scene, world, camera, quality });
 *   // every frame:
 *   live.update(dt, player.state);   // anything with { x, z }
 *   live.credits                     // [{ species, credit, license, source }]
 *   live.dispose();
 *
 * - Plinths, rails, credit plaques and their collision boxes are built at
 *   once (they are cheap). The heavy glTF models are only fetched when the
 *   visitor is within LOAD_DIST of a plinth or in its room / a room next to
 *   it, and their animation mixers stop beyond PAUSE_DIST.
 * - Collision: a footprint box per plinth is pushed into world.js's
 *   OBSTACLES array, which resolveCollision() reads live.
 * - Every spot is validated at start-up against the room walls, doorways,
 *   the image panels (OBSTACLES), the 3D display plinths (world.displays) and
 *   the seats / interactables. If world.js has moved something into the way,
 *   the spot is nudged to the nearest clear place, or skipped with a warning.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import * as WORLD from "./world.js";

const MANIFEST_URL = "/models/real/manifest.json";
const LOAD_DIST = 40;
const PAUSE_DIST = 60;
const HIDE_DIST = 95;
const KEY_RANGE = 35; // stands within this distance get a key light
const KEY_POOL = 2; // spot lights shared by the nearest stands (fixed light count)
const KEY_COLOR = 0xffe2c4; // warm white, ~3500 K
const MODEL_ENV = 1.0; // envMapIntensity on the model skins (scene.environment / HDRI)

const CLEAR_EXHIBIT = 2.0; // rail to image panels / display plinths
const CLEAR_WALL = 2.0; // rail to walls (statues and plants stand ~1 m off the walls)
const CLEAR_DOOR = 3.0; // rail to any doorway
const CLEAR_SEAT = 1.5; // rail to a seat / interactable's own radius
const CLEAR_OWN = 1.2; // between two of our own exhibits
const CLEAR_DECOR = 1.0; // rail to benches, placards, planters, statues, dioramas
const RAIL_OFFSET = 0.45; // rail runs this far outside the plinth
const PLAQUE_DEPTH = 0.32; // the plaque sticks out of the front rail by this much

/** Used until (or if) the manifest can't be fetched. Mirrors manifest.json. */
const FALLBACK_MANIFEST = {
  trex: {
    file: "/models/real/trex.glb",
    credit: "\"Tyrant King - Tyrannosaurus\" by Marcel Schanz (https://sketchfab.com/mschanz); textures converted/resized",
    license: "CC-BY-4.0",
    source: "https://sketchfab.com/3d-models/tyrant-king-tyrannosaurus-6465a297fa784598adc49f6e0042d449",
    forward: "+z",
    length_m_target: 12.3,
  },
  raptor: {
    file: "/models/real/raptor.glb",
    credit: "\"PBR Velociraptor (Animated)\" by Ferocious Industries (https://sketchfab.com/ferociousindustries.matthias); textures resized, animation subset",
    license: "CC-BY-4.0",
    source: "https://sketchfab.com/3d-models/pbr-velociraptor-animated-8f1744af7b0847a2aabe3df90be802f0",
    forward: "+z",
    length_m_target: 2,
  },
  diplod: {
    file: "/models/real/sauropod.glb",
    credit: "\"Brachiosaurus_AR card\" by Zinaida.Kovrova (https://sketchfab.com/Zinaida.Kovrova); textures resized",
    license: "CC-BY-4.0",
    source: "https://sketchfab.com/3d-models/brachiosaurus-ar-card-751b32784e1a4ddd9c95aa88d7640ab7",
    forward: "-x",
    length_m_target: 26,
  },
  ptero: {
    file: "/models/real/ptero.glb",
    credit: "\"Animated Flying Pteradactal Dinosaur Loop\" by LasquetiSpice (https://sketchfab.com/LasquetiSpice); textures resized",
    license: "CC-BY-4.0",
    source: "https://sketchfab.com/3d-models/animated-flying-pteradactal-dinosaur-loop-09f6b1ff7bfd4a2d8d9c0b9827f2a708",
    forward: "+z",
    length_m_target: 6,
  },
  allo: {
    file: "/models/real/allo.glb",
    credit: "\"Allosaurus\" by Alexey Zaika (https://sketchfab.com/lexazaixa25); textures converted, animation resampled",
    license: "CC-BY-4.0",
    source: "https://sketchfab.com/3d-models/allosaurus-f4fc28a57eed418d9f7bf0178805c2ab",
    forward: "+z",
    length_m_target: 8.5,
  },
};

/**
 * The exhibits. x/z = plinth centre; ry = the way the plinth's front (and
 * the animal) faces, a multiple of 90° so the footprint stays axis-aligned.
 * plinth.w runs across the front, plinth.l front to back.
 * animals[]: one per model on the plinth. dx/dz/ry are in the plinth frame.
 *   clip: name of the clip to loop (null = static), sub: [start, end] seconds
 *   of a long clip to use (played ping-pong), speed: timeScale.
 *   fit: "length" (forward axis) or "wingspan" (x axis).
 */
const EXHIBITS = [
  {
    id: "trex",
    asset: "trex",
    species: "Tyrannosaurus rex",
    room: "rotunda",
    // centrepiece of the Grand Gallery, staring down the South Corridor at
    // everyone who walks in; the bench at (0, 9.5) looks straight at it
    x: 3.03,
    z: -7.95,
    ry: 0,
    plinth: { w: 3.3, l: 13.4, h: 0.45 },
    animals: [{ clip: null, length: 12.3 }],
    sizeNote: "Life size · 12.3 m",
    // key light: dist = metres from the target, 45° up and in front; side = sideways share; lux ~ illuminance at the target
    key: { dist: 10, side: 0.35, angle: 0.62, lux: 11 },
  },
  {
    id: "diplod",
    asset: "diplod",
    species: "Diplodocus",
    room: "rotunda",
    // along the east side of the T. rex; the gallery only has a 19 m clear run
    // between the Baryonyx and Dimetrodon panels, so it is shown at ~70 %.
    // Its only clip grazes with the head sunk below its feet and swings the
    // neck 6 m sideways, so it is frozen at the head-up, straight-ahead frame.
    x: 8.875,
    z: -10.17,
    ry: 0,
    plinth: { w: 3.79, l: 17.7, h: 0.45 },
    animals: [{ clip: "Bip001|Take 001|BaseLayer", pose: 8.7, length: 25, fitToPlinth: true }],
    sizeNote: null, // filled in from the actual scale
    key: { dist: 11, side: 0.35, angle: 0.72, lux: 10 },
  },
  {
    id: "raptor",
    asset: "raptor",
    species: "Velociraptor mongoliensis",
    room: "predator",
    // north-east corner of Predator Bay, facing the bay and the Grand Gallery door
    x: -30.5,
    z: -37.2,
    ry: 0,
    plinth: { w: 4.6, l: 3.4, h: 0.6 },
    animals: [
      // the pair eye up visitors from both sides of the plaque
      { clip: "Idle_02", speed: 0.55, length: 2, dx: -1.0, dz: 0.2, ry: 0.4, phase: 0, glow: 0.15 },
      { clip: "Idle_02", speed: 0.5, length: 2, dx: 1.05, dz: -0.3, ry: -0.85, mirror: true, phase: 1.9, glow: 0.15 },
    ],
    sizeNote: "Life size · 2 m",
    key: { dist: 5, side: -0.3, angle: 0.55, lux: 5 },
  },
  {
    id: "allo",
    asset: "allo",
    species: "Allosaurus fragilis",
    room: "jurassic",
    // west side of the Jurassic Hall between the Brachiosaurus panel and the
    // volcano diorama, head towards the hall's north entrance
    x: 55,
    z: 21,
    ry: Math.PI,
    plinth: { w: 3.0, l: 10.0, h: 0.45 },
    // "Take 001" is a 74 s reel (walks, roars, bites); 5–9 s is a calm,
    // stationary idle, played back and forth
    animals: [{ clip: "Take 001", sub: [5.0, 9.0], speed: 0.5, length: 8.5 }],
    sizeNote: "Life size · 8.5 m",
    key: { dist: 7.5, side: 0.35, angle: 0.62, lux: 8 },
  },
  {
    id: "ptero",
    asset: "ptero",
    species: "Pteranodon longiceps",
    room: "cretaceous",
    // circles high over the Cretaceous Hall, around the hanging hall banner
    flight: { cx: -63, cz: -63, radius: 9, y: 6.9, period: 46, bank: 0.22, bob: 0.3 },
    // a small reading stand on the floor carries its plaque
    x: -63,
    z: -63,
    ry: 0,
    lectern: true,
    animals: [{ clip: "Animation", speed: 0.75, length: 6, fit: "wingspan", glow: 0.12 }],
    sizeNote: "Life size · 6 m wingspan",
  },
];

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

const FORWARD_YAW = { "+z": 0, "-z": Math.PI, "+x": -Math.PI / 2, "-x": Math.PI / 2 };

function qualityLevel(q) {
  if (typeof q === "number") return q;
  return { low: 0, medium: 1, med: 1, high: 2, ultra: 3 }[String(q || "high").toLowerCase()] ?? 2;
}

function creditAuthor(credit) {
  const m = /\bby\s+(.+?)\s*(\(|;|$)/.exec(credit || "");
  return m ? m[1].trim() : credit || "unknown";
}
function creditTitle(credit) {
  const m = /^"(.+?)"/.exec(credit || "");
  return m ? m[1] : "";
}
function licenseLabel(lic) {
  return /cc-?by-?4/i.test(lic || "") ? "CC BY 4.0" : lic || "";
}

function boxDist(a, b) {
  const dx = Math.max(0, a.minX - b.maxX, b.minX - a.maxX);
  const dz = Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ);
  return Math.hypot(dx, dz);
}
function pointBoxDist(x, z, b) {
  const dx = Math.max(0, b.minX - x, x - b.maxX);
  const dz = Math.max(0, b.minZ - z, z - b.maxZ);
  return Math.hypot(dx, dz);
}

/** Doorway openings as thin boxes (from world.js's OPEN set). */
function doorwayBoxes() {
  const { OPEN, g2w, g2z, CELL } = WORLD;
  const out = [];
  if (!OPEN || !g2w || !g2z) return out;
  const h = (CELL || 6) / 2;
  for (const key of OPEN) {
    const [kind, rest] = key.split(":");
    const [c, r] = rest.split(",").map(Number);
    if (kind === "v") {
      const z = g2z(r) + h;
      out.push({ minX: g2w(c) - h, maxX: g2w(c) + h, minZ: z, maxZ: z, key });
    } else {
      const x = g2w(c) + h;
      out.push({ minX: x, maxX: x, minZ: g2z(r) - h, maxZ: g2z(r) + h, key });
    }
  }
  return out;
}

/** room id -> Set of room ids it has a doorway into. */
function roomAdjacency() {
  const { OPEN, g2w, g2z, roomAt } = WORLD;
  const adj = new Map();
  if (!OPEN || !roomAt) return adj;
  const link = (a, b) => {
    if (!a || !b || a.id === b.id) return;
    if (!adj.has(a.id)) adj.set(a.id, new Set());
    if (!adj.has(b.id)) adj.set(b.id, new Set());
    adj.get(a.id).add(b.id);
    adj.get(b.id).add(a.id);
  };
  for (const key of OPEN) {
    const [kind, rest] = key.split(":");
    const [c, r] = rest.split(",").map(Number);
    const a = roomAt(g2w(c), g2z(r));
    const b = kind === "v" ? roomAt(g2w(c), g2z(r + 1)) : roomAt(g2w(c + 1), g2z(r));
    link(a, b);
  }
  return adj;
}

function roomBounds(roomId) {
  const { ROOMS, g2w, g2z, CELL } = WORLD;
  const room = (ROOMS || []).find((r) => r.id === roomId);
  if (!room) return null;
  const h = (CELL || 6) / 2;
  return {
    room,
    minX: g2w(room.cols[0]) - h,
    maxX: g2w(room.cols[1]) + h,
    minZ: g2z(room.rows[0]) - h,
    maxZ: g2z(room.rows[1]) + h,
  };
}

/* ------------------------------------------------------------------ */
/* plinth, rail, plaque                                                 */
/* ------------------------------------------------------------------ */

function makeMaterials(shadows) {
  return {
    stone: new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.7, metalness: 0.0 }),
    brass: new THREE.MeshStandardMaterial({ color: 0xc7a25a, roughness: 0.32, metalness: 0.55, emissive: 0x2a1c05, emissiveIntensity: 0.35 }),
    shadows,
  };
}

/** Rail posts every <= 1.6 m round a w x l rectangle, two brass tubes between them. */
function railParts(w, l) {
  const hw = w / 2 + RAIL_OFFSET;
  const hl = l / 2 + RAIL_OFFSET;
  const corners = [
    [-hw, -hl],
    [hw, -hl],
    [hw, hl],
    [-hw, hl],
  ];
  const parts = [];
  const postH = 0.95;
  const post = new THREE.CylinderGeometry(0.035, 0.045, postH, 10);
  post.translate(0, postH / 2, 0);
  const foot = new THREE.CylinderGeometry(0.11, 0.13, 0.05, 14);
  foot.translate(0, 0.025, 0);
  const knob = new THREE.SphereGeometry(0.055, 12, 8);
  knob.translate(0, postH + 0.02, 0);
  const addPost = (x, z) => {
    for (const g of [post, foot, knob]) parts.push(g.clone().translate(x, 0, z));
  };
  const addTube = (x0, z0, x1, z1, y, r) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const g = new THREE.CylinderGeometry(r, r, len, 8, 1, true);
    g.rotateZ(Math.PI / 2); // along x
    g.rotateY(-Math.atan2(z1 - z0, x1 - x0));
    g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
    parts.push(g);
  };
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[(i + 1) % 4];
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.ceil(len / 1.6));
    for (let k = 0; k < n; k++) addPost(x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n);
    addTube(x0, z0, x1, z1, postH - 0.03, 0.026);
    addTube(x0, z0, x1, z1, 0.5, 0.016);
  }
  post.dispose();
  foot.dispose();
  knob.dispose();
  return parts;
}

/** One-draw-call plinth: a box whose top face is a lighter stone (vertex colours). */
function plinthGeometry(w, h, l) {
  const g = new THREE.BoxGeometry(w, h, l);
  g.translate(0, h / 2, 0);
  g.clearGroups();
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const side = new THREE.Color(0x2f2b27);
  const top = new THREE.Color(0x48423c);
  const ny = g.attributes.normal;
  for (let i = 0; i < n; i++) {
    const c = ny.getY(i) > 0.5 ? top : side;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

/** Minimal merge for non-indexed + indexed BufferGeometries (position/normal/uv). */
function mergeSimple(geos) {
  let vCount = 0;
  let iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, vo * 3);
    const n = g.attributes.position.count;
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.array[i] + vo;
    else for (let i = 0; i < n; i++) idx[io++] = i + vo;
    vo += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

function plaqueTexture({ species, author, title, license, sizeNote }) {
  const W = 1024;
  const H = 512;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d");
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, "#e2c37c");
  grad.addColorStop(0.45, "#b88d43");
  grad.addColorStop(0.7, "#d6b267");
  grad.addColorStop(1, "#9c7533");
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // brushed lines
  g.globalAlpha = 0.08;
  for (let y = 0; y < H; y += 3) {
    g.fillStyle = (y / 3) % 2 ? "#fff" : "#000";
    g.fillRect(0, y, W, 1);
  }
  g.globalAlpha = 1;
  g.strokeStyle = "#5e431a";
  g.lineWidth = 10;
  g.strokeRect(18, 18, W - 36, H - 36);
  g.lineWidth = 3;
  g.strokeRect(34, 34, W - 68, H - 68);
  const engrave = (text, y, font, color = "#2e2109") => {
    g.font = font;
    g.textAlign = "center";
    g.textBaseline = "middle";
    let size = parseInt(/(\d+)px/.exec(font)[1], 10);
    while (g.measureText(text).width > W - 120 && size > 14) {
      size -= 2;
      g.font = font.replace(/\d+px/, `${size}px`);
    }
    g.fillStyle = "rgba(255,240,200,0.55)";
    g.fillText(text, W / 2 + 2, y + 2);
    g.fillStyle = color;
    g.fillText(text, W / 2, y);
  };
  engrave(species, 130, "italic bold 84px Georgia, 'Times New Roman', serif");
  engrave(`— model by ${author}, ${license}`, 250, "600 46px Georgia, 'Times New Roman', serif");
  if (title) engrave(`“${title}” · sketchfab.com`, 330, "36px Georgia, 'Times New Roman', serif", "#4a3512");
  if (sizeNote) engrave(sizeNote, 410, "bold 38px Georgia, 'Times New Roman', serif", "#4a3512");
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Sloped reading plaque on a short brass post standing at (0, 0, z): the
 * brass parts come back as geometry (merged with the rail by the caller),
 * the engraved plate as its own mesh.
 */
const PLAQUE_TILT = -0.62; // face tilted up towards the reader
const PLAQUE_Y = 0.98;
function plaqueBrassParts(z) {
  const post = new THREE.CylinderGeometry(0.04, 0.05, 0.9, 10).translate(0, 0.45, z);
  const foot = new THREE.CylinderGeometry(0.16, 0.19, 0.05, 16).translate(0, 0.025, z);
  const back = new THREE.BoxGeometry(0.86, 0.45, 0.03).translate(0, 0, -0.016).rotateX(PLAQUE_TILT).translate(0, PLAQUE_Y, z);
  return [post, foot, back];
}
function plaquePlate(info, z) {
  const tex = plaqueTexture(info);
  const face = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.38, metalness: 0.35, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.18 });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 0.41), face);
  plate.position.set(0, PLAQUE_Y, z);
  plate.rotation.x = PLAQUE_TILT;
  plate.translateZ(0.001);
  plate.userData.dispose = () => {
    tex.dispose();
    face.dispose();
  };
  return plate;
}

/* ------------------------------------------------------------------ */
/* model loading & fitting                                              */
/* ------------------------------------------------------------------ */

const _box = new THREE.Box3();

/** Precise (skinned) bounds of `root` in its own frame. */
function preciseBounds(root, target = new THREE.Box3()) {
  root.updateMatrixWorld(true);
  target.makeEmpty();
  root.traverse((o) => {
    if (o.isMesh && o.visible) {
      _box.makeEmpty();
      _box.expandByObject(o, true);
      target.union(_box);
    }
  });
  return target;
}

function pickClip(gltf, spec) {
  if (!spec.clip || !gltf.animations?.length) return null;
  let clip = gltf.animations.find((c) => c.name === spec.clip) || null;
  if (!clip) return null;
  if (spec.sub) {
    const fps = 30;
    clip = THREE.AnimationUtils.subclip(clip, `${clip.name}#${spec.sub.join("-")}`, Math.round(spec.sub[0] * fps), Math.round(spec.sub[1] * fps), fps);
  }
  return clip;
}

/**
 * Measure one asset + clip combination once: orientation-corrected,
 * animated bounds (several samples over the clip).
 */
function measure(gltf, entry, spec, clip) {
  const scene = cloneSkinned(gltf.scene);
  const rot = new THREE.Group();
  rot.rotation.y = FORWARD_YAW[entry.forward || "+z"] ?? 0;
  rot.add(scene);
  const mixer = clip ? new THREE.AnimationMixer(scene) : null;
  const first = new THREE.Box3();
  const all = new THREE.Box3();
  const b = new THREE.Box3();
  const posed = Number.isFinite(spec.pose);
  const samples = clip && !posed ? 5 : 1;
  for (let i = 0; i < samples; i++) {
    if (mixer) {
      mixer.stopAllAction();
      const a = mixer.clipAction(clip);
      a.play();
      mixer.setTime(posed ? spec.pose : (clip.duration * i) / samples);
    }
    preciseBounds(rot, b);
    if (i === 0) first.copy(b);
    all.union(b);
  }
  mixer?.stopAllAction();
  mixer?.uncacheRoot(scene);
  return { first, all };
}

/* ------------------------------------------------------------------ */
/* main entry                                                           */
/* ------------------------------------------------------------------ */

export function placeLiveModels({ scene, world, camera, quality = "high" } = {}) {
  const q = qualityLevel(quality);
  const shadows = q >= 2;
  const mats = makeMaterials(shadows);
  mats.stone.userData.lkEnv = 0.5;
  mats.brass.userData.lkEnv = 1.0;
  const root = new THREE.Group();
  root.name = "live-models";
  root.userData.surface = "skip"; // keep the lookdev pass off these materials
  scene.add(root);

  const obstacles = Array.isArray(WORLD.OBSTACLES) ? WORLD.OBSTACLES : null;
  if (!obstacles) console.warn("[livemodels] world.js exports no OBSTACLES array: plinths will not block players");

  const adjacency = roomAdjacency();
  const doors = doorwayBoxes();
  const manifest = { ...FALLBACK_MANIFEST };
  const loader = new GLTFLoader();
  const gltfCache = new Map(); // url -> Promise<gltf|null>
  const measureCache = new Map(); // asset|clip -> { first, all }
  const credits = [];
  const report = [];
  const placed = []; // runtime exhibit state
  let disposed = false;

  const ready = fetch(MANIFEST_URL)
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (m) for (const k of Object.keys(m)) manifest[k] = { ...manifest[k], ...m[k] };
    })
    .catch(() => {
      /* fallback credits stay */
    });

  /* ---------------- validation ---------------- */
  // free-standing decor that is in neither OBSTACLES nor displays: benches,
  // placards, planters, the volcano diorama, props.js statues and boulders...
  const IGNORE_SURF = new Set(["floor", "ceiling", "wall", "trim"]);
  const surfaceOf = (o) => {
    for (let n = o; n; n = n.parent) if (n.userData?.surface) return n.userData.surface;
    return null;
  };
  const shown = (o) => {
    for (let n = o; n; n = n.parent) if (!n.visible) return false;
    return true;
  };
  function sceneBlockers() {
    const out = [];
    const roots = [world?.group, scene.getObjectByName("props")].filter(Boolean);
    const b = new THREE.Box3();
    const m4 = new THREE.Matrix4();
    const push = (box, o) => {
      if (box.isEmpty() || box.min.y > 2.4 || box.max.y < 0.15) return; // high signs, floor decals
      if (box.max.x - box.min.x > 30 || box.max.z - box.min.z > 30) return; // floors, structure
      out.push({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, minY: box.min.y, maxY: box.max.y, name: o.name || `${o.parent?.name || ""}/${o.geometry?.type || "mesh"}` });
    };
    for (const r of roots) {
      r.updateMatrixWorld(true);
      r.traverse((o) => {
        if (!o.isMesh || o.isSkinnedMesh || !o.geometry) return;
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
  const decor = sceneBlockers();

  const panelBoxes = () => (obstacles || []).filter((o) => !String(o.id || "").startsWith("live:"));
  const displayBoxes = () => (world?.displays || WORLD.DISPLAYS || []).map((d) => d.bounds).filter(Boolean);
  const pointsOfInterest = () =>
    (world?.interactables || []).filter((it) => it.type !== "exhibit" && Number.isFinite(it.x) && Number.isFinite(it.z));

  function footprint(ex, x, z) {
    if (ex.lectern && !ex.plinth) return { minX: x - 0.35, maxX: x + 0.35, minZ: z - 0.3, maxZ: z + 0.3 };
    const turned = Math.abs(Math.sin(ex.ry)) > 0.5;
    const w = ex.plinth.w / 2 + RAIL_OFFSET + 0.08;
    const l = ex.plinth.l / 2 + RAIL_OFFSET + 0.08;
    // the plaque sticks out of the front rail
    const fx = Math.round(Math.sin(ex.ry));
    const fz = Math.round(Math.cos(ex.ry));
    const box = turned
      ? { minX: x - l, maxX: x + l, minZ: z - w, maxZ: z + w }
      : { minX: x - w, maxX: x + w, minZ: z - l, maxZ: z + l };
    if (fx > 0) box.maxX += PLAQUE_DEPTH;
    if (fx < 0) box.minX -= PLAQUE_DEPTH;
    if (fz > 0) box.maxZ += PLAQUE_DEPTH;
    if (fz < 0) box.minZ -= PLAQUE_DEPTH;
    return box;
  }

  function problems(ex, box) {
    const out = [];
    const rb = roomBounds(ex.room);
    if (!rb) return ["unknown room " + ex.room];
    if (box.minX < rb.minX + CLEAR_WALL || box.maxX > rb.maxX - CLEAR_WALL || box.minZ < rb.minZ + CLEAR_WALL || box.maxZ > rb.maxZ - CLEAR_WALL)
      out.push("too close to a wall");
    for (const d of doors) if (boxDist(box, d) < CLEAR_DOOR) out.push("blocks doorway " + d.key);
    for (const o of panelBoxes()) if (boxDist(box, o) < CLEAR_EXHIBIT) out.push("near " + (o.id || "obstacle"));
    for (const d of displayBoxes()) if (boxDist(box, d) < CLEAR_EXHIBIT) out.push("near a display plinth");
    for (const it of pointsOfInterest()) if (pointBoxDist(it.x, it.z, box) < (it.radius || 1) + CLEAR_SEAT) out.push("near " + it.id);
    for (const p of placed) if (p.box && boxDist(box, p.box) < CLEAR_OWN) out.push("near live:" + p.ex.id);
    for (const d of decor) if (boxDist(box, d) < CLEAR_DECOR) out.push("near " + d.name);
    return out;
  }

  function choosePosition(ex) {
    const base = problems(ex, footprint(ex, ex.x, ex.z));
    if (!base.length) return { x: ex.x, z: ex.z, nudged: false };
    // spiral out in 0.25 m steps up to 6 m
    const tries = [];
    for (let dx = -6; dx <= 6; dx += 0.25) for (let dz = -6; dz <= 6; dz += 0.25) tries.push([dx, dz, dx * dx + dz * dz]);
    tries.sort((a, b) => a[2] - b[2]);
    for (const [dx, dz] of tries) {
      if (!problems(ex, footprint(ex, ex.x + dx, ex.z + dz)).length) return { x: ex.x + dx, z: ex.z + dz, nudged: true, why: base };
    }
    return { skip: true, why: base };
  }

  /* ---------------- build plinths ---------------- */
  function buildStand(ex, x, z) {
    const group = new THREE.Group();
    group.name = `live:${ex.id}`;
    group.position.set(x, 0, z);
    group.rotation.y = ex.ry;
    root.add(group);
    const e = manifest[ex.asset] || {};
    const author = creditAuthor(e.credit);
    const plaqueInfo = {
      species: ex.species,
      author,
      title: creditTitle(e.credit),
      license: licenseLabel(e.license),
      sizeNote: ex.sizeNote,
    };
    // 3 draw calls per stand: plinth, all the brass, the engraved plate
    const plaqueZ = ex.plinth ? ex.plinth.l / 2 + RAIL_OFFSET + 0.2 : 0;
    const brassParts = plaqueBrassParts(plaqueZ);
    if (ex.plinth) {
      const { w, l, h } = ex.plinth;
      const plinth = new THREE.Mesh(plinthGeometry(w, h, l), mats.stone);
      plinth.castShadow = shadows;
      plinth.receiveShadow = shadows;
      group.add(plinth);
      brassParts.push(...railParts(w, l));
    }
    const brass = new THREE.Mesh(mergeSimple(brassParts), mats.brass);
    brass.receiveShadow = shadows;
    group.add(brass);
    const plate = plaquePlate(plaqueInfo, plaqueZ);
    group.add(plate);
    group.userData.plate = plate;
    group.userData.plaqueZ = plaqueZ;
    return group;
  }

  for (const ex of EXHIBITS) {
    const pos = choosePosition(ex);
    if (pos.skip) {
      console.warn(`[livemodels] no clear spot for ${ex.id} in ${ex.room}: ${[...new Set(pos.why)].join("; ")} — skipped`);
      report.push({ id: ex.id, skipped: true, why: pos.why });
      continue;
    }
    if (pos.nudged) console.warn(`[livemodels] ${ex.id} moved to (${pos.x.toFixed(2)}, ${pos.z.toFixed(2)}): ${[...new Set(pos.why)].join("; ")}`);
    const box = footprint(ex, pos.x, pos.z);
    const stand = buildStand(ex, pos.x, pos.z);
    let obstacle = null;
    if (obstacles) {
      obstacle = { id: `live:${ex.id}`, ...box };
      obstacles.push(obstacle);
    }
    const p = {
      ex,
      x: pos.x,
      z: pos.z,
      box,
      stand,
      obstacle,
      state: "idle", // idle | loading | ready | failed
      models: [], // { holder, mixer, spec }
      flightT: Math.random() * 10,
      dist: Infinity,
    };
    placed.push(p);
    report.push({ id: ex.id, room: ex.room, x: +pos.x.toFixed(2), z: +pos.z.toFixed(2), ry: ex.ry, footprint: box, nudged: !!pos.nudged, why: pos.why ? [...new Set(pos.why)] : undefined });
  }

  // one credit per species shown
  const refreshCredits = () => {
    credits.length = 0;
    for (const p of placed) {
      const e = manifest[p.ex.asset] || {};
      credits.push({ species: p.ex.species, credit: e.credit || "", license: e.license || "", source: e.source || "" });
    }
  };
  refreshCredits();
  ready.then(refreshCredits);

  /* ---------------- lazy model loading ---------------- */
  function loadAsset(url) {
    if (!gltfCache.has(url)) {
      gltfCache.set(
        url,
        new Promise((resolve) => {
          loader.load(
            url,
            (g) => resolve(g),
            undefined,
            (err) => {
              console.warn(`[livemodels] could not load ${url}:`, err?.message || err);
              resolve(null);
            }
          );
        })
      );
    }
    return gltfCache.get(url);
  }

  function prepareMeshes(obj, glow = 0) {
    obj.traverse((o) => {
      o.userData.surface = "skip";
      if (!o.isMesh) return;
      o.castShadow = shadows;
      o.receiveShadow = shadows;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of list) {
        if (!m) continue;
        let mat = m;
        if (q <= 1 && m.isMeshPhysicalMaterial) {
          // physical extras (specular/ior) are not worth it on low settings
          mat = new THREE.MeshStandardMaterial();
          THREE.MeshStandardMaterial.prototype.copy.call(mat, m);
          o.material = mat;
        }
        // reflect the museum HDRI (scene.environment); lookdev.js honours lkEnv
        mat.envMapIntensity = MODEL_ENV;
        mat.userData.lkEnv = MODEL_ENV;
        // a touch of self-illumination for spots the hall lights barely reach
        if (glow > 0 && mat.map && !mat.emissiveMap && mat.emissive) {
          mat.emissiveMap = mat.map;
          mat.emissive.setScalar(1);
          mat.emissiveIntensity = glow;
          mat.needsUpdate = true;
        }
      }
    });
  }

  async function spawnModels(p) {
    p.state = "loading";
    await ready;
    const entry = manifest[p.ex.asset];
    if (!entry?.file) {
      p.state = "failed";
      console.warn(`[livemodels] no manifest entry for ${p.ex.asset}`);
      return;
    }
    const gltf = await loadAsset(entry.file);
    if (disposed) return;
    if (!gltf) {
      p.state = "failed";
      return;
    }
    try {
      const plinthTop = p.ex.plinth ? p.ex.plinth.h : 0;
      for (const spec of p.ex.animals) {
        const clip = pickClip(gltf, spec);
        if (spec.clip && !clip) console.warn(`[livemodels] ${p.ex.id}: clip "${spec.clip}" not found, shown static`);
        const mkey = `${entry.file}|${clip ? clip.name : "-"}|${spec.pose ?? ""}`;
        if (!measureCache.has(mkey)) measureCache.set(mkey, measure(gltf, entry, spec, clip));
        const { first, all } = measureCache.get(mkey);
        const size = first.getSize(new THREE.Vector3());
        const fit = spec.fit === "wingspan" ? all.max.x - all.min.x : size.z;
        let s = spec.length / fit;
        let note = null;
        if (spec.fitToPlinth && p.ex.plinth) {
          const sl = (p.ex.plinth.l - 0.5) / (all.max.z - all.min.z);
          const sw = (p.ex.plinth.w - 0.3) / (all.max.x - all.min.x);
          const sMax = Math.min(sl, sw);
          if (sMax < s) {
            note = `Shown at ${Math.round((sMax / s) * 100)}% · life size ${spec.length} m`;
            s = sMax;
          }
        }
        if (note && !p.ex.sizeNote) {
          p.ex.sizeNote = note;
          // redraw the plaque with the size note
          const old = p.stand.userData.plate;
          const e = manifest[p.ex.asset] || {};
          const plate = plaquePlate(
            { species: p.ex.species, author: creditAuthor(e.credit), title: creditTitle(e.credit), license: licenseLabel(e.license), sizeNote: note },
            p.stand.userData.plaqueZ
          );
          p.stand.remove(old);
          disposeTree(old);
          p.stand.add(plate);
          p.stand.userData.plate = plate;
        }
        const model = cloneSkinned(gltf.scene);
        // clones share materials; give glowing ones their own copies
        if (spec.glow) model.traverse((o) => { if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone(); });
        prepareMeshes(model, spec.glow || 0);
        const rot = new THREE.Group();
        rot.rotation.y = FORWARD_YAW[entry.forward || "+z"] ?? 0;
        rot.add(model);
        const holder = new THREE.Group();
        const sx = spec.mirror ? -s : s;
        holder.scale.set(sx, s, s);
        const cx = (first.min.x + first.max.x) / 2;
        const cz = (first.min.z + first.max.z) / 2;
        // centre on the plinth, lowest point of the clip on the plinth top;
        // a flyer is centred on its flight path instead
        const baseY = p.ex.flight ? (all.min.y + all.max.y) / 2 : all.min.y;
        holder.position.set(-cx * sx, -baseY * s, -cz * s);
        holder.add(rot);
        const place = new THREE.Group();
        place.name = `live:${p.ex.id}:model`;
        place.add(holder);
        if (p.ex.flight) {
          root.add(place);
        } else {
          place.position.set(spec.dx || 0, plinthTop, spec.dz || 0);
          place.rotation.y = spec.ry || 0;
          p.stand.add(place);
        }
        let mixer = null;
        if (clip) {
          mixer = new THREE.AnimationMixer(model);
          const action = mixer.clipAction(clip);
          if (spec.sub) action.setLoop(THREE.LoopPingPong, Infinity);
          action.timeScale = spec.speed ?? 1;
          action.play();
          mixer.setTime(Number.isFinite(spec.pose) ? spec.pose : (spec.phase || 0) % clip.duration);
          if (Number.isFinite(spec.pose)) mixer = null; // frozen pose: never advance
        }
        // skinned bounds for frustum culling, with room for the animation
        model.updateMatrixWorld(true);
        model.traverse((o) => {
          if (o.isSkinnedMesh) {
            o.computeBoundingSphere();
            o.boundingSphere.radius *= 1.35;
          }
        });
        p.models.push({ place, holder, mixer, spec, scale: s });
        p.scale = s;
        p.height = Math.max(p.height || 0, (all.max.y - all.min.y) * s);
      }
      p.state = "ready";
    } catch (err) {
      console.warn(`[livemodels] could not place ${p.ex.id}:`, err);
      p.state = "failed";
    }
  }

  /* ---------------- key lights ---------------- */
  // A small fixed pool of spot lights follows the nearest loaded stands.
  // They are created once (the first time a stand needs one) and afterwards
  // only re-aimed and faded by intensity, so the scene's light count, and
  // with it every material's shader, never changes again.
  let keys = null;
  function ensureKeys() {
    if (keys) return;
    keys = [];
    for (let i = 0; i < KEY_POOL; i++) {
      const l = new THREE.SpotLight(KEY_COLOR, 0, 30, 0.6, 0.55, 2);
      l.name = `live:key${i}`;
      l.castShadow = false;
      l.userData.keepLight = true; // lookdev.js: not one of the room lights
      l.userData.stand = null;
      l.userData.level = 0;
      l.userData.peak = 0;
      root.add(l);
      root.add(l.target);
      keys.push(l);
    }
  }
  function aimKey(l, p) {
    const k = p.ex.key;
    const y = (p.ex.plinth ? p.ex.plinth.h : 0) + (p.height || 2) * 0.5;
    const fx = Math.sin(p.ex.ry);
    const fz = Math.cos(p.ex.ry);
    const c = k.dist * Math.SQRT1_2; // 45° above the target, out in front
    l.position.set(p.x + fx * c + fz * c * k.side, y + c, p.z + fz * c - fx * c * k.side);
    l.target.position.set(p.x, y, p.z);
    l.target.updateMatrixWorld();
    l.angle = k.angle;
    l.distance = k.dist * 3;
    l.userData.peak = k.lux * k.dist * k.dist; // candela for ~lux at the target (decay 2)
    l.userData.stand = p;
  }
  function updateKeys(dt) {
    const want = placed
      .filter((p) => p.ex.key && p.state === "ready" && p.dist < KEY_RANGE)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, KEY_POOL);
    if (!want.length && !keys) return;
    ensureKeys();
    const fade = Math.min(1, dt * 1.5);
    for (const l of keys) {
      const on = l.userData.stand && want.includes(l.userData.stand);
      l.userData.level += ((on ? 1 : 0) - l.userData.level) * fade;
      if (!on && l.userData.level < 0.01) {
        l.userData.level = 0;
        l.userData.stand = null;
      }
    }
    for (const p of want) {
      if (keys.some((l) => l.userData.stand === p)) continue;
      const free = keys.find((l) => !l.userData.stand);
      if (free) aimKey(free, p);
    }
    for (const l of keys) l.intensity = l.userData.level * l.userData.peak;
  }

  /* ---------------- per frame ---------------- */
  const tmp = new THREE.Vector3();
  function update(dt = 0, playerPos) {
    if (disposed) return;
    let px;
    let pz;
    if (playerPos && Number.isFinite(playerPos.x)) {
      px = playerPos.x;
      pz = playerPos.z;
    } else if (camera) {
      camera.getWorldPosition(tmp);
      px = tmp.x;
      pz = tmp.z;
    } else return;
    const here = WORLD.roomAt ? WORLD.roomAt(px, pz) : null;
    const near = here ? adjacency.get(here.id) : null;
    for (const p of placed) {
      p.dist = pointBoxDist(px, pz, p.box);
      if (p.state === "idle") {
        const inReach = p.dist < LOAD_DIST || (here && (here.id === p.ex.room || near?.has(p.ex.room)));
        if (inReach) spawnModels(p);
        continue;
      }
      if (p.state !== "ready") continue;
      const flying = p.ex.flight;
      const distModel = flying ? Math.hypot(px - flying.cx, pz - flying.cz) : p.dist;
      const visible = distModel < HIDE_DIST;
      for (const m of p.models) {
        m.place.visible = visible;
        if (m.mixer && distModel < PAUSE_DIST) m.mixer.update(dt);
      }
      if (flying && visible) {
        p.flightT += dt;
        const f = flying;
        const a = (p.flightT / f.period) * Math.PI * 2;
        for (const m of p.models) {
          m.place.position.set(f.cx + Math.cos(a) * f.radius, f.y + Math.sin(a * 3.1) * f.bob, f.cz + Math.sin(a) * f.radius);
          m.place.rotation.order = "YXZ";
          m.place.rotation.y = -a; // heading = tangent of the circle
          m.place.rotation.z = f.bank; // lean into the (right-hand) turn
          m.place.rotation.x = Math.cos(a * 3.1) * 0.05;
        }
      }
    }
    updateKeys(dt);
  }

  function disposeTree(obj) {
    obj.traverse((o) => {
      if (o.userData?.dispose) o.userData.dispose();
      if (o.geometry) o.geometry.dispose();
      const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of list) {
        if (m === mats.stone || m === mats.brass) continue;
        for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "specularColorMap", "specularIntensityMap"]) m[k]?.dispose?.();
        m.dispose();
      }
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const p of placed) {
      for (const m of p.models) m.mixer?.stopAllAction();
      if (p.obstacle && obstacles) {
        const i = obstacles.indexOf(p.obstacle);
        if (i >= 0) obstacles.splice(i, 1);
      }
    }
    scene.remove(root);
    disposeTree(root);
    mats.stone.dispose();
    mats.brass.dispose();
    gltfCache.clear();
    measureCache.clear();
    placed.length = 0;
  }

  return {
    update,
    credits,
    dispose,
    ready,
    /** where everything ended up (for debugging / tests) */
    report,
    /** runtime state, e.g. live.debug().map(p => p.state) */
    debug: () =>
      placed.map((p) => ({
        id: p.ex.id,
        state: p.state,
        x: p.x,
        z: p.z,
        dist: +p.dist.toFixed(1),
        key: keys ? +(keys.find((l) => l.userData.stand === p)?.intensity || 0).toFixed(0) : 0,
        scale: p.scale,
        sizeNote: p.ex.sizeNote,
        box: p.box,
      })),
    /** decor boxes the spots were checked against */
    decor,
    /** world-space skinned bounds of every loaded model (slow; for tests) */
    measureWorld: () =>
      placed.flatMap((p) =>
        p.models.map((m) => {
          const b = preciseBounds(m.place, new THREE.Box3());
          const r = (v) => +v.toFixed(2);
          return { id: p.ex.id, min: [r(b.min.x), r(b.min.y), r(b.min.z)], max: [r(b.max.x), r(b.max.y), r(b.max.z)], size: [r(b.max.x - b.min.x), r(b.max.y - b.min.y), r(b.max.z - b.min.z)] };
        })
      ),
    /** start loading everything now (e.g. for a screenshot tour) */
    preloadAll: () => Promise.all(placed.filter((p) => p.state === "idle").map((p) => spawnModels(p))),
  };
}
