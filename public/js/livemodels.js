/**
 * Life-size, licensed 3D dinosaur models (CC BY 4.0, see
 * /models/real/manifest.json) standing on low plinths behind brass rails.
 *
 *   const live = placeLiveModels({ scene, world, camera, quality });
 *   // every frame:
 *   live.update(dt, player.state);   // anything with { x, z }
 *   live.credits                     // [{ species, credit, license, source }]
 *   live.vitrines                    // [{ id, species, x, z, ry, state, scale: "1:N", box }]
 *   live.dispose();
 *
 * - Scale models: every species with a model also gets a museum vitrine at
 *   its picture panel's display spot (world.displays): a dark lacquered
 *   plinth with a brass edge, a glass case (tint + additive env reflection,
 *   no transmission pass), slim black frame, LED strips and a lit deck (all
 *   emissive, no extra lights), a "Scale model 1:N" label, and inside the
 *   same glTF (SkeletonUtils clone: geometry and textures are shared with
 *   the life-size one) frozen in a calm pose on a sculpted sand base. The
 *   cases and their collision boxes are built at once; the models load when
 *   the visitor comes within VITRINE_LOAD.
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
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
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
/* scale-model vitrines                                                 */
/* ------------------------------------------------------------------ */

const VITRINE_LOAD = 30; // fetch / clone the scale model inside this distance
const VITRINE_HIDE = 55; // the whole case is hidden beyond this
const VITRINE_PLINTH_H = 0.58;
const VITRINE_GLASS_H = 0.74; // plinth + glass + frame stays under display.maxHeight (1.35)
const VITRINE_FRAME = 0.016; // slim black frame bars
const VITRINE_LEDGE = 0.17; // label ledge in front of the glass
const VITRINE_BASE_H = 0.045; // sculpted sand base under the model
const VITRINE_E_CLEAR = 0.6; // keep the exhibit's E point at least this far off the plinth
const NICE_SCALES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 18, 20, 24, 25, 30, 35, 40, 50, 60, 75, 100, 150, 200];

/**
 * One case per species that has a model. heading: +1 = the animal walks to
 * the case's right (local +x), -1 to its left, 0 = faces the visitor; it is
 * then toed in by `toe` rad towards the visitor. pose = clip time in seconds
 * ("widest" = the frame with the widest wingspan). length = life size, m.
 */
const VITRINES = [
  { id: "trex", asset: "trex", species: "Tyrannosaurus rex", length: 12.3, clip: null, heading: 1, toe: 0.42 },
  { id: "raptor", asset: "raptor", species: "Velociraptor mongoliensis", length: 2, clip: "Idle_02", pose: 1.2, heading: -1, toe: 0.45 },
  { id: "deinonychus", asset: "raptor", species: "Deinonychus antirrhopus", length: 3.4, clip: "Sniff", pose: 1.0, heading: 1, toe: 0.45 },
  { id: "diplod", asset: "diplod", species: "Diplodocus", length: 25, clip: "Bip001|Take 001|BaseLayer", pose: 8.7, heading: -1, toe: 0.16 },
  { id: "ptero", asset: "ptero", species: "Pteranodon longiceps", length: 6, fit: "wingspan", clip: "Animation", pose: "widest", heading: 0, toe: 0.32, mount: "rod" },
  { id: "allo", asset: "allo", species: "Allosaurus fragilis", length: 8.5, clip: "Take 001", pose: 6.0, heading: 1, toe: 0.38 },
];

/** Adds a constant (or per-face up / side) vertex colour to a geometry. */
function tint(geo, side, top = side) {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  const cs = new THREE.Color(side);
  const ct = new THREE.Color(top);
  const ny = geo.attributes.normal;
  for (let i = 0; i < n; i++) {
    const c = ny && ny.getY(i) > 0.5 ? ct : cs;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return geo;
}
const boxAt = (w, h, d, x, y, z) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);

/** mergeGeometries for a mix of indexed / non-indexed parts that all carry position, normal, uv, color. */
function mergeParts(parts) {
  const anyNonIndexed = parts.some((g) => !g.index);
  const list = anyNonIndexed ? parts.map((g) => (g.index ? g.toNonIndexed() : g)) : parts;
  for (const g of list) for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv", "color"].includes(k)) g.deleteAttribute(k);
  const out = mergeGeometries(list, false);
  for (const g of parts) g.dispose();
  for (const g of list) g.dispose();
  out.computeBoundingSphere();
  return out;
}

/** Small deterministic PRNG so every case's sand base is the same on every visit. */
function rng(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/**
 * Sculpted base: an elliptic slab of sand with a lumpy top, a slightly
 * flared rim and a few pebbles; vertex colours carry the sand / rock tones
 * and a soft contact shadow under the animal (fx, fz = its footprint).
 */
function sandBaseGeometry(rx, rz, h, fx, fz, seed) {
  const rnd = rng(seed);
  const ph = Array.from({ length: 6 }, () => rnd() * Math.PI * 2);
  const lump = (x, z) =>
    Math.sin(x * 9.1 + ph[0]) * Math.cos(z * 7.3 + ph[1]) * 0.5 + Math.sin(x * 23 + z * 17 + ph[2]) * 0.25 + Math.cos(x * 41 - z * 37 + ph[3]) * 0.12;
  const top = new THREE.RingGeometry(0.0001, 1, 72, 22).rotateX(-Math.PI / 2);
  const side = new THREE.CylinderGeometry(1, 1.06, 1, 72, 1, true).translate(0, 0.5, 0);
  const sand = new THREE.Color(0xb9a07a);
  const rock = new THREE.Color(0x7a6650);
  const dark = new THREE.Color(0x4a3d30);
  const c = new THREE.Color();
  // top: lumps grow towards the rim, the middle stays level for the feet
  {
    const p = top.attributes.position;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const ux = p.getX(i);
      const uz = p.getZ(i);
      const r = Math.hypot(ux, uz);
      const x = ux * rx;
      const z = uz * rz;
      const n = lump(x, z);
      const edge = Math.max(0, (r - 0.85) / 0.15);
      const amp = (0.005 + 0.032 * r * r) * (1 - edge * edge);
      p.setXYZ(i, x, h + n * amp - edge * edge * 0.22 * h, z);
      // colour: sand with darker rocky patches, contact shadow under the animal
      const fine = Math.sin(x * 71 + ph[4]) * Math.sin(z * 67 + ph[5]) * 0.5 + (rnd() - 0.5) * 0.5;
      c.copy(sand).lerp(rock, Math.max(0, Math.min(1, n * 0.7 + fine * 0.35 + r * 0.3 - 0.05)));
      const fr = Math.hypot(x / Math.max(0.05, fx * 0.5), z / Math.max(0.05, fz * 0.5));
      const occ = 1 - 0.45 * Math.max(0, 1 - fr) ** 1.5;
      c.multiplyScalar(occ * (0.92 + rnd() * 0.12));
      col.set([c.r, c.g, c.b], i * 3);
    }
    top.setAttribute("color", new THREE.BufferAttribute(col, 3));
    top.computeVertexNormals();
  }
  {
    const p = side.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * rx, p.getY(i) * h * 0.78, p.getZ(i) * rz);
    tint(side, dark.clone().lerp(rock, 0.75));
    side.computeVertexNormals();
  }
  const parts = [top, side];
  // a few pebbles near the rim
  for (let k = 0; k < 9; k++) {
    const a = rnd() * Math.PI * 2;
    const r = 0.62 + rnd() * 0.28;
    const s = 0.012 + rnd() * 0.02;
    const peb = new THREE.IcosahedronGeometry(s, 1);
    peb.scale(1 + rnd() * 0.6, 0.55 + rnd() * 0.3, 1 + rnd() * 0.4).rotateY(rnd() * 3).translate(Math.cos(a) * r * rx, h + s * 0.15, Math.sin(a) * r * rz);
    tint(peb, c.copy(sand).lerp(rock, 0.4 + rnd() * 0.5).lerp(dark, rnd() * 0.25));
    parts.push(peb);
  }
  return mergeParts(parts);
}

/** Radial "pool of light" on the case deck (centre bright, edges dimmer). */
let deckTexCache = null;
function deckTexture() {
  if (deckTexCache) return deckTexCache;
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = S;
  const g = cv.getContext("2d");
  const grad = g.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.72);
  grad.addColorStop(0, "#ffffff");
  grad.addColorStop(0.55, "#d9d2c6");
  grad.addColorStop(1, "#8d877e");
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  // fine felt grain (random, so no moire at a distance)
  const img = g.getImageData(0, 0, S, S);
  const r = rng("deck");
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  deckTexCache = new THREE.CanvasTexture(cv);
  deckTexCache.colorSpace = THREE.SRGBColorSpace;
  return deckTexCache;
}

function vitrineLabelTexture({ species, ratio, lifeNote, author, license }) {
  const W = 1024;
  const H = 256;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const g = cv.getContext("2d");
  g.fillStyle = "#efe7d6";
  g.fillRect(0, 0, W, H);
  g.strokeStyle = "#8a6a32";
  g.lineWidth = 6;
  g.strokeRect(14, 14, W - 28, H - 28);
  g.textBaseline = "middle";
  g.textAlign = "left";
  // line 1: "Scale model 1:N · " upright + the species in italics, centred together
  const fit = (font, text, max) => {
    let size = parseInt(/(\d+)px/.exec(font)[1], 10);
    g.font = font;
    while (g.measureText(text).width > max && size > 16) {
      size -= 2;
      g.font = font.replace(/\d+px/, `${size}px`);
    }
    return g.font;
  };
  const a = `Scale model ${ratio} · `;
  let fa = "bold 66px Georgia, 'Times New Roman', serif";
  let fb = "italic bold 66px Georgia, 'Times New Roman', serif";
  for (let size = 66; size > 20; size -= 2) {
    fa = fa.replace(/\d+px/, `${size}px`);
    fb = fb.replace(/\d+px/, `${size}px`);
    g.font = fa;
    const wa = g.measureText(a).width;
    g.font = fb;
    if (wa + g.measureText(species).width <= W - 90) break;
  }
  g.font = fa;
  const wa = g.measureText(a).width;
  g.font = fb;
  const wb = g.measureText(species).width;
  const x0 = (W - wa - wb) / 2;
  g.fillStyle = "#1f1a12";
  g.font = fa;
  g.fillText(a, x0, 92);
  g.font = fb;
  g.fillText(species, x0 + wa, 92);
  g.textAlign = "center";
  g.fillStyle = "#4b3f2c";
  g.font = fit("44px Georgia, 'Times New Roman', serif", lifeNote, W - 90);
  g.fillText(lifeNote, W / 2, 158);
  g.fillStyle = "#6b5d45";
  const cr = `3D model by ${author} · ${license}`;
  g.font = fit("italic 32px Georgia, 'Times New Roman', serif", cr, W - 90);
  g.fillText(cr, W / 2, 212);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * A fake case light for the miniatures, with no real light: a warm,
 * wrapped top-down term added to the indirect diffuse of their materials.
 */
const CASE_LIGHT = { value: new THREE.Color(0xffe3c0).multiplyScalar(0.55) };
function caseLightPatch(shader) {
  shader.uniforms.uCaseLight = CASE_LIGHT;
  shader.fragmentShader =
    "uniform vec3 uCaseLight;\n" +
    shader.fragmentShader.replace(
      "#include <lights_fragment_end>",
      `#include <lights_fragment_end>
      {
        vec3 caseUp = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
        float caseWrap = clamp( dot( normal, caseUp ) * 0.6 + 0.4, 0.0, 1.0 );
        reflectedLight.indirectDiffuse += material.diffuseColor * uCaseLight * caseWrap * caseWrap;
      }`
    );
}

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

  // one credit per species shown (life-size stands, then scale models of other species)
  const creditExtras = []; // [{ species, asset }] filled in by the vitrines below
  const refreshCredits = () => {
    credits.length = 0;
    const list = [...placed.map((p) => ({ species: p.ex.species, asset: p.ex.asset })), ...creditExtras];
    for (const { species, asset } of list) {
      if (credits.some((c) => c.species === species)) continue;
      const e = manifest[asset] || {};
      credits.push({ species, credit: e.credit || "", license: e.license || "", source: e.source || "" });
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

  /* ---------------- scale-model vitrines ---------------- */
  // shared by every case: 6 draw calls per case + the model's own meshes
  const vm = {
    lacquer: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.0 }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28, metalness: 0.8, emissive: 0x1c1408, emissiveIntensity: 0.4 }),
    deck: new THREE.MeshStandardMaterial({ color: 0xd8cdb8, map: deckTexture(), roughness: 0.92, emissive: 0xfff0da, emissiveMap: deckTexture(), emissiveIntensity: 0.32 }),
    led: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.15, 1.8) }),
    sand: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0.0, emissive: 0xffe8c8, emissiveIntensity: 0.06 }),
    // glass: a faint dark tint (both panes darken a little, as real glass
    // does) plus an additive layer that only adds the env / light reflections
    // with their Fresnel falloff. No transmission, so no extra scene pass.
    glassTint: new THREE.MeshBasicMaterial({ color: 0x0f1312, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }),
    glassRefl: new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.04, metalness: 0.0, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true }),
  };
  const VM_ENV = { lacquer: 0.6, metal: 1.1, deck: 0.25, sand: 0.35, glassRefl: 0.95 };
  // the museum HDRI is one warm global probe that matches no hall in
  // particular: keep the glass's reflections mostly neutral grey
  vm.glassRefl.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      "#include <opaque_fragment>\n  gl_FragColor.rgb = mix( vec3( dot( gl_FragColor.rgb, vec3( 0.299, 0.587, 0.114 ) ) ), gl_FragColor.rgb, 0.25 );"
    );
  };
  vm.glassRefl.customProgramCacheKey = () => "vitrine-glass";
  for (const [k, m] of Object.entries(vm)) {
    if (!m.isMeshStandardMaterial) continue;
    m.userData.lkEnv = VM_ENV[k] ?? 0.6;
    m.envMapIntensity = m.userData.lkEnv;
  }
  const miniMats = new Map(); // glTF material -> its miniature twin (shared by cases of the same asset)
  const vitrines = [];
  const vitrineInfo = [];

  function miniMaterial(m) {
    if (!m) return m;
    if (miniMats.has(m)) return miniMats.get(m);
    let mm;
    if (q <= 1 && m.isMeshPhysicalMaterial) {
      mm = new THREE.MeshStandardMaterial();
      THREE.MeshStandardMaterial.prototype.copy.call(mm, m);
    } else mm = m.clone(); // textures stay shared with the life-size model
    mm.envMapIntensity = 1.25;
    mm.userData.lkEnv = 1.25;
    mm.onBeforeCompile = caseLightPatch;
    mm.customProgramCacheKey = () => "vitrine-case-light";
    miniMats.set(m, mm);
    return mm;
  }

  /** world-space AABB of a local (x0..x1, z0..z1) rectangle in a frame turned by a multiple of 90°. */
  function worldRect(d, x0, x1, z0, z1) {
    const c = Math.round(Math.cos(d.ry));
    const s = Math.round(Math.sin(d.ry));
    const xs = [];
    const zs = [];
    for (const lx of [x0, x1])
      for (const lz of [z0, z1]) {
        xs.push(d.x + lx * c + lz * s);
        zs.push(d.z - lx * s + lz * c);
      }
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
  }

  function buildVitrine(spec, d) {
    const e = manifest[spec.asset] || {};
    const H = VITRINE_PLINTH_H;
    const GH = Math.min(VITRINE_GLASS_H, (d.maxHeight || 1.35) - H - VITRINE_FRAME);
    const L = Math.max(1.3, Math.min(3.1, (d.maxLength || 2) - 0.12)); // plinth length (along the panel)
    const D = Math.max(0.9, Math.min(1.32, (d.maxDepth || 1.6) - 0.24)); // plinth depth
    const gx = L / 2 - 0.035; // glass half length
    const gz0 = -D / 2 + 0.035; // glass back
    const gz1 = D / 2 - VITRINE_LEDGE; // glass front
    const gzc = (gz0 + gz1) / 2;
    const group = new THREE.Group();
    group.name = `live:vitrine:${spec.id}`;
    group.position.set(d.x, d.floorY || 0, d.z);
    group.rotation.y = d.ry;
    root.add(group);

    // plinth: lacquered body on a recessed black toe
    const body = tint(boxAt(L, H - 0.07, D, 0, 0.07 + (H - 0.07) / 2, 0), 0x1d1a17, 0x2a2622);
    const toe = tint(boxAt(L - 0.07, 0.07, D - 0.07, 0, 0.035, 0), 0x0c0b0a);
    const plinth = new THREE.Mesh(mergeParts([body, toe]), vm.lacquer);
    plinth.castShadow = shadows;
    plinth.receiveShadow = shadows;
    group.add(plinth);

    // metal: brass band round the plinth top, brass glass shoe, black frame, label bezel
    const BRASS = 0xc9a25a;
    const BLACK = 0x15120f;
    const metal = [];
    const bt = 0.008; // band protrusion
    metal.push(
      tint(boxAt(L + 2 * bt, 0.032, 2 * bt, 0, H - 0.014, D / 2), BRASS),
      tint(boxAt(L + 2 * bt, 0.032, 2 * bt, 0, H - 0.014, -D / 2), BRASS),
      tint(boxAt(2 * bt, 0.032, D, L / 2, H - 0.014, 0), BRASS),
      tint(boxAt(2 * bt, 0.032, D, -L / 2, H - 0.014, 0), BRASS)
    );
    const shoeH = 0.034;
    const sw = 0.014;
    metal.push(
      tint(boxAt(2 * gx + sw, shoeH, sw, 0, H + shoeH / 2, gz1), BRASS),
      tint(boxAt(2 * gx + sw, shoeH, sw, 0, H + shoeH / 2, gz0), BRASS),
      tint(boxAt(sw, shoeH, gz1 - gz0, gx, H + shoeH / 2, gzc), BRASS),
      tint(boxAt(sw, shoeH, gz1 - gz0, -gx, H + shoeH / 2, gzc), BRASS)
    );
    const f = VITRINE_FRAME;
    const yTop = H + GH;
    for (const x of [-gx, gx]) for (const z of [gz0, gz1]) metal.push(tint(boxAt(f, GH - shoeH, f, x, H + shoeH + (GH - shoeH) / 2, z), BLACK));
    for (const z of [gz0, gz1]) metal.push(tint(boxAt(2 * gx + f, f, f, 0, yTop, z), BLACK));
    for (const x of [-gx, gx]) metal.push(tint(boxAt(f, f, gz1 - gz0, x, yTop, gzc), BLACK));
    // label: a sloped brass-edged card on the ledge in front of the glass
    const LW = Math.min(0.56, L - 0.3);
    const LH = LW * 0.25;
    const tilt = -0.95; // face ~55° up towards a standing visitor
    const lz = (gz1 + D / 2) / 2 + 0.005;
    const ly = H + 0.012 + (LH / 2) * Math.sin(-tilt) * 0.95;
    const bezel = tint(new THREE.BoxGeometry(LW + 0.022, LH + 0.022, 0.012), BRASS);
    bezel.translate(0, 0, -0.007).rotateX(tilt).translate(0, ly, lz);
    const wedge = tint(new THREE.BoxGeometry(LW * 0.7, 0.03, 0.06), BLACK).translate(0, H + 0.015, lz - 0.01);
    metal.push(bezel, wedge);
    const metalMesh = new THREE.Mesh(mergeParts(metal), vm.metal);
    metalMesh.receiveShadow = shadows;
    group.add(metalMesh);

    // lit deck + LED strips under the top frame (front and back)
    const deck = new THREE.Mesh(new THREE.PlaneGeometry(2 * gx - 0.01, gz1 - gz0 - 0.01).rotateX(-Math.PI / 2).translate(0, H + 0.002, gzc), vm.deck);
    deck.receiveShadow = shadows;
    group.add(deck);
    const leds = new THREE.Mesh(
      mergeParts([
        tint(boxAt(2 * gx - 0.06, 0.006, 0.012, 0, yTop - f / 2 - 0.004, gz1 - 0.022), 0xffffff),
        tint(boxAt(2 * gx - 0.06, 0.006, 0.012, 0, yTop - f / 2 - 0.004, gz0 + 0.022), 0xffffff),
      ]),
      vm.led
    );
    group.add(leds);

    // glass: 4 walls + lid, one geometry, two materials
    const gW = 2 * gx;
    const gD = gz1 - gz0;
    const gh = GH - 0.002;
    const panes = [
      new THREE.PlaneGeometry(gW, gh).translate(0, H + gh / 2, gz1),
      new THREE.PlaneGeometry(gW, gh).rotateY(Math.PI).translate(0, H + gh / 2, gz0),
      new THREE.PlaneGeometry(gD, gh).rotateY(Math.PI / 2).translate(gx, H + gh / 2, gzc),
      new THREE.PlaneGeometry(gD, gh).rotateY(-Math.PI / 2).translate(-gx, H + gh / 2, gzc),
      new THREE.PlaneGeometry(gW, gD).rotateX(-Math.PI / 2).translate(0, H + gh, gzc),
    ].map((g) => tint(g, 0xffffff));
    const glassGeo = mergeParts(panes);
    const glassTint = new THREE.Mesh(glassGeo, vm.glassTint);
    const glassRefl = new THREE.Mesh(glassGeo, vm.glassRefl);
    glassTint.renderOrder = 1;
    glassRefl.renderOrder = 2;
    group.add(glassTint, glassRefl);

    // label card (texture is drawn once the scale is known; until then a plain card)
    const labelMat = new THREE.MeshStandardMaterial({ color: 0xefe7d6, roughness: 0.6, metalness: 0, emissive: 0xffffff, emissiveIntensity: 0.0 });
    labelMat.userData.lkEnv = 0.3;
    labelMat.envMapIntensity = 0.3;
    const label = new THREE.Mesh(new THREE.PlaneGeometry(LW, LH), labelMat);
    label.position.set(0, ly, lz);
    label.rotation.x = tilt;
    group.add(label);

    group.traverse((o) => (o.userData.surface = "skip"));
    const box = worldRect(d, -L / 2 - bt - 0.02, L / 2 + bt + 0.02, -D / 2 - bt - 0.02, D / 2 + bt + 0.02);
    return {
      group,
      label,
      labelMat,
      box,
      layout: {
        H,
        GH,
        L,
        D,
        gx,
        gz0,
        gz1,
        gzc,
        // free room for the animal (and its base) inside the glass
        intL: 2 * gx - 0.14,
        intD: gz1 - gz0 - 0.12,
        intH: GH - VITRINE_BASE_H - 0.07,
      },
      author: creditAuthor(e.credit),
    };
  }

  function drawVitrineLabel(vt, ratio) {
    const e = manifest[vt.spec.asset] || {};
    const s = vt.spec;
    const lifeNote = s.fit === "wingspan" ? `Life size: ${s.length} m wingspan` : `Life size: ${s.length} m long`;
    const tex = vitrineLabelTexture({ species: s.species, ratio, lifeNote, author: creditAuthor(e.credit), license: licenseLabel(e.license) });
    const m = vt.labelMat;
    m.map?.dispose();
    m.map = tex;
    m.emissiveMap = tex;
    m.color.set(0xffffff);
    m.emissiveIntensity = 0.22;
    m.needsUpdate = true;
  }

  const displaysList = world?.displays || WORLD.DISPLAYS || [];
  const exhibitPoints = (world?.interactables || []).filter((it) => it.type === "exhibit");
  for (const spec of VITRINES) {
    const d = displaysList.find((x) => x.speciesId === spec.id);
    if (!d) {
      console.warn(`[livemodels] no display spot for ${spec.id}: no scale model`);
      continue;
    }
    const vt = { spec, d, state: "idle", dist: Infinity, model: null, ratio: null, ...buildVitrine(spec, d) };
    // the exhibit's E point must stay reachable in front of the case
    const ep = exhibitPoints.find((it) => it.exhibitId === spec.id || it.id === `exhibit:${spec.id}`);
    if (ep) {
      const gap = pointBoxDist(ep.x, ep.z, vt.box);
      if (gap < VITRINE_E_CLEAR) console.warn(`[livemodels] vitrine ${spec.id}: exhibit point only ${gap.toFixed(2)} m from the case`);
      vt.eGap = gap;
    }
    if (obstacles) {
      vt.obstacle = { id: `live:vitrine:${spec.id}`, ...vt.box };
      obstacles.push(vt.obstacle);
    }
    vitrines.push(vt);
    const info = { id: spec.id, species: spec.species, x: +d.x.toFixed(2), z: +d.z.toFixed(2), ry: +d.ry.toFixed(3), state: "idle", scale: null, box: vt.box, ePointGap: vt.eGap != null ? +vt.eGap.toFixed(2) : null };
    vt.info = info;
    vitrineInfo.push(info);
    creditExtras.push({ species: spec.species, asset: spec.asset });
  }
  refreshCredits();

  async function spawnVitrine(vt) {
    vt.state = vt.info.state = "loading";
    await ready;
    const entry = manifest[vt.spec.asset];
    const gltf = entry?.file ? await loadAsset(entry.file) : null;
    if (disposed) return;
    if (!gltf) {
      vt.state = vt.info.state = "failed";
      return;
    }
    try {
      const spec = vt.spec;
      const lay = vt.layout;
      const clip = spec.clip ? gltf.animations.find((c) => c.name === spec.clip) || null : null;
      if (spec.clip && !clip) console.warn(`[livemodels] vitrine ${spec.id}: clip "${spec.clip}" not found, bind pose`);
      const model = cloneSkinned(gltf.scene);
      const rot = new THREE.Group();
      rot.rotation.y = FORWARD_YAW[entry.forward || "+z"] ?? 0;
      rot.add(model);
      const yawG = new THREE.Group();
      yawG.add(rot);
      const b = new THREE.Box3();
      if (clip) {
        // freeze one calm frame: the action stays bound, the mixer is never advanced
        const mixer = new THREE.AnimationMixer(model);
        mixer.clipAction(clip).play();
        let t = Number.isFinite(spec.pose) ? Math.min(spec.pose, clip.duration) : 0;
        if (spec.pose === "widest") {
          let best = -1;
          for (let i = 0; i < 24; i++) {
            mixer.setTime((clip.duration * i) / 24);
            preciseBounds(yawG, b);
            const w = b.max.x - b.min.x - 0.25 * (b.max.y - b.min.y); // wide and level
            if (w > best) {
              best = w;
              t = (clip.duration * i) / 24;
            }
          }
        }
        mixer.setTime(t);
      }
      // life-size scale from the forward length (or wingspan) ...
      preciseBounds(yawG, b);
      const fitNative = spec.fit === "wingspan" ? b.max.x - b.min.x : b.max.z - b.min.z;
      const sLife = spec.length / fitNative;
      // ... and the largest 1:N that fits the glass once turned
      const toe = spec.toe ?? 0.4;
      yawG.rotation.y = spec.heading === 0 ? toe : spec.heading * (Math.PI / 2 - toe);
      preciseBounds(yawG, b);
      const size = b.getSize(new THREE.Vector3());
      const lift = spec.mount === "rod" ? 0.24 : 0;
      const sMax = Math.min(lay.intL / size.x, lay.intD / size.z, (lay.intH - lift) / size.y);
      const N = NICE_SCALES.find((n) => sLife / n <= sMax) ?? Math.ceil(sLife / sMax);
      const s = sLife / N;
      yawG.scale.setScalar(s);
      const cx = (b.min.x + b.max.x) / 2;
      const cz = (b.min.z + b.max.z) / 2;
      yawG.position.set(-cx * s, -b.min.y * s, -cz * s);

      const prepared = new Set();
      model.traverse((o) => {
        o.userData.surface = "skip";
        if (!o.isMesh) return;
        o.castShadow = shadows;
        o.receiveShadow = shadows;
        o.material = Array.isArray(o.material) ? o.material.map(miniMaterial) : miniMaterial(o.material);
        prepared.add(o);
      });

      // sculpted base sized to the footprint
      const fx = size.x * s;
      const fz = size.z * s;
      // a flyer on a rod only needs a small rocky outcrop
      const rx = spec.mount === "rod" ? 0.2 : Math.min(lay.gx - 0.09, fx / 2 + 0.07);
      const rz = spec.mount === "rod" ? 0.15 : Math.min((lay.gz1 - lay.gz0) / 2 - 0.09, fz / 2 + 0.07);
      const baseY = lay.H + 0.002;
      const sand = new THREE.Mesh(sandBaseGeometry(rx, rz, VITRINE_BASE_H, spec.mount === "rod" ? 0.12 : fx * 0.85, spec.mount === "rod" ? 0.12 : fz * 0.85, spec.id), vm.sand);
      sand.position.set(0, baseY, lay.gzc);
      sand.receiveShadow = shadows;
      sand.castShadow = false;
      sand.userData.surface = "skip";
      vt.group.add(sand);

      const place = new THREE.Group();
      place.name = `live:vitrine:${spec.id}:model`;
      place.position.set(0, baseY + VITRINE_BASE_H - 0.004 + lift, lay.gzc);
      place.add(yawG);
      vt.group.add(place);
      if (spec.mount === "rod") {
        // brass display rod from the base into the body
        const top = (size.y * s) / 2;
        const rod = tint(new THREE.CylinderGeometry(0.006, 0.006, lift + top, 10).translate(0, (lift + top) / 2, 0), 0xc9a25a);
        const flange = tint(new THREE.CylinderGeometry(0.03, 0.036, 0.01, 20).translate(0, 0.005, 0), 0xc9a25a);
        const mount = new THREE.Mesh(mergeParts([rod, flange]), vm.metal);
        mount.position.set(0, baseY + VITRINE_BASE_H - 0.006, lay.gzc);
        mount.userData.surface = "skip";
        vt.group.add(mount);
        vt.mount = mount;
      }
      vt.group.updateMatrixWorld(true);
      for (const o of prepared) {
        if (o.isSkinnedMesh) {
          o.computeBoundingSphere();
          o.boundingSphere.radius *= 1.05;
        }
      }
      vt.model = place;
      vt.sand = sand;
      vt.ratio = `1:${N}`;
      vt.scale = s;
      vt.info.scale = vt.ratio;
      vt.info.modelSize = [+(size.x * s).toFixed(2), +(size.y * s).toFixed(2), +(size.z * s).toFixed(2)];
      drawVitrineLabel(vt, vt.ratio);
      vt.state = vt.info.state = "ready";
    } catch (err) {
      console.warn(`[livemodels] could not fill vitrine ${vt.spec.id}:`, err);
      vt.state = vt.info.state = "failed";
    }
  }

  function updateVitrines(px, pz) {
    for (const vt of vitrines) {
      vt.dist = pointBoxDist(px, pz, vt.box);
      vt.group.visible = vt.dist < VITRINE_HIDE;
      if (vt.state === "idle" && vt.dist < VITRINE_LOAD) spawnVitrine(vt);
    }
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
    updateVitrines(px, pz);
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
    for (const vt of vitrines) {
      if (vt.obstacle && obstacles) {
        const i = obstacles.indexOf(vt.obstacle);
        if (i >= 0) obstacles.splice(i, 1);
      }
    }
    scene.remove(root);
    disposeTree(root);
    deckTexCache = null;
    miniMats.clear();
    vitrines.length = 0;
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
    /** the scale-model cases: [{ id, species, x, z, ry, state, scale: "1:N", box, modelSize, ePointGap }] */
    vitrines: vitrineInfo,
    /** each loaded scale model's bounds in its case's frame next to the glass interior (for tests) */
    measureVitrines: () =>
      vitrines
        .filter((vt) => vt.model)
        .map((vt) => {
          vt.group.updateMatrixWorld(true);
          const wb = preciseBounds(vt.model, new THREE.Box3());
          const inv = vt.group.matrixWorld.clone().invert();
          const lb = new THREE.Box3();
          for (const x of [wb.min.x, wb.max.x]) for (const y of [wb.min.y, wb.max.y]) for (const z of [wb.min.z, wb.max.z]) lb.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(inv));
          const L = vt.layout;
          const r = (v) => +v.toFixed(3);
          return {
            id: vt.spec.id,
            scale: vt.ratio,
            model: { min: [r(lb.min.x), r(lb.min.y), r(lb.min.z)], max: [r(lb.max.x), r(lb.max.y), r(lb.max.z)] },
            glass: { min: [r(-L.gx), r(L.H), r(L.gz0)], max: [r(L.gx), r(L.H + L.GH), r(L.gz1)] },
            clips: lb.min.x < -L.gx || lb.max.x > L.gx || lb.min.z < L.gz0 || lb.max.z > L.gz1 || lb.max.y > L.H + L.GH || lb.min.y < L.H,
          };
        }),
    /** start loading everything now (e.g. for a screenshot tour) */
    preloadAll: () =>
      Promise.all([
        ...placed.filter((p) => p.state === "idle").map((p) => spawnModels(p)),
        ...vitrines.filter((vt) => vt.state === "idle").map((vt) => spawnVitrine(vt)),
      ]),
  };
}
