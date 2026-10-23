/**
 * Living diorama windows.
 *
 * Each era hall's "window to deep time" (world.js ERA_WINDOWS) becomes a
 * framed, museum-style diorama case: a dark lacquered wood casing with a
 * brass bead and an unlit sill, and behind the glass a living prehistoric
 * scene, a planted foreground berm of ferns, a herd moving past in the
 * middle distance, drifting mist and the era's photographic panorama as the
 * painted backdrop.
 *
 * The scene behind the glass is a portal: a small separate THREE.Scene drawn
 * into a render target through an off-axis (generalised) perspective
 * projection whose image plane IS the window rectangle, from the visitor's
 * actual eye position. Mapped onto the glass with plain 0..1 UVs, it shows
 * correct parallax from any viewpoint without cutting holes in the walls.
 *
 *   const dioramas = createDioramas({ scene, renderer, camera, quality: () => tier });
 *   dioramas.update(dt);      // once a frame, before the main render
 *
 * Cost control:
 *   - the case (3 draw calls per window) is built up front; the scene behind
 *     it is only loaded once a visitor reaches the hall (or a room next to
 *     it), and only rendered while its hall is where the camera is (or next
 *     door and close), the glass faces the camera and is inside its frustum;
 *   - materials and geometries are shared, ferns are instanced, mist is one
 *     instanced draw animated in its shader, nothing is allocated per frame;
 *   - quality tiers: low = smaller target, no MSAA, half the animals and
 *     ferns, no mist, no image-based lighting, drawn at ~30 Hz.
 *
 * Never touches the exit passage or the court: only era halls have windows.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { ERA_WINDOWS, ERAS, OBSTACLES, roomAt, roomNeighbours } from "./world.js";

/* ------------------------------------------------------------------ */
/* case geometry (window-local metres: x along the wall, y up, +z into   */
/* the room; the wall face is at z = -0.05)                              */
/* ------------------------------------------------------------------ */
const GLASS_W = 8.0;
const GLASS_H = 4.5;
const GLASS_Y0 = 1.25; // bottom edge of the glass above the floor
const GLASS_Z = 0.3; // glass plane, recessed behind the casing front
const CASE_FRONT = 0.46;
const APRON_FRONT = 0.74;
const WALL_FACE = -0.05;

const ASSET = "/models/diorama/";
const BASE_RT = { w: 1024, h: 576 };

/* ------------------------------------------------------------------ */
/* the eras                                                             */
/* ------------------------------------------------------------------ */
/**
 * yaw: panorama rotation (rad) so the chosen view sits behind the glass.
 * exposure: backdrop gain (the museum is ACES tone mapped).
 * herds: walkers crossing the scene. path z = depth behind the glass (m),
 *   x = [from, to] (they loop, pausing off-frame), stride = metres per
 *   second of clip per metre of body length.
 */
const ERA_CFG = {
  triassic: {
    yaw: 4.4,
    exposure: 1.4,
    tint: [1.0, 0.98, 0.95],
    sun: { dir: [0.55, 0.6, 0.55], color: 0xffe2b8, intensity: 3.0 },
    hemi: { sky: 0xbcd3ec, ground: 0x7a5a3a, intensity: 0.9 },
    fog: { color: 0xc7c3b8, near: 60, far: 1600 },
    ground: "dry_ground_rocks",
    groundTint: 0xf0dcc0,
    groundRepeat: 7,
    fernTint: 0xc9c08a,
    ferns: 22,
    treeFerns: 0,
    crest: 0.85,
    bermNear: 0.8,
    mist: { color: 0xeadfce, opacity: 0.1, count: 4, y: [0.2, 1.2], drift: 0.35 },
    rocks: 12,
    rockTint: 0xcdb89c,
    herds: [
      // Coelophysis: a loose, quick pack crossing the slope
      { asset: "raptor", clip: "Walk", length: 3.0, count: 6, z: [-9.5, -14], x: [-30, 30], speed: 1.0, spacing: 3.6, pause: [4, 10], tint: 0xf2e2c4, bothWays: true },
    ],
    fliers: [],
  },
  jurassic: {
    yaw: 3.6,
    exposure: 1.5,
    tint: [0.96, 1.0, 0.94],
    sun: { dir: [0.35, 0.8, -0.45], color: 0xfff0d0, intensity: 1.7 },
    hemi: { sky: 0xd8ecd0, ground: 0x3c4a2a, intensity: 1.1 },
    fog: { color: 0xa9b6a0, near: 30, far: 1000 },
    ground: "forest_ground_04",
    groundTint: 0xb8b49a,
    groundRepeat: 8,
    fernTint: 0xa8c890,
    ferns: 34,
    treeFerns: 3,
    crest: 1.05,
    mist: { color: 0xdfe8d8, opacity: 0.14, count: 5, y: [0.2, 1.6], drift: 0.18 },
    rocks: 7,
    rockTint: 0x8f9a78,
    herds: [
      // an Allosaurus pacing along the stream
      { asset: "allo", clip: "Take 001", sub: [39.733, 40.6], rootBone: "Bip002_011", length: 8.5, count: 1, z: [-13.5, -13.5], x: [-26, 26], speed: 0.55, spacing: 0, pause: [8, 16], bothWays: true },
    ],
    fliers: [],
  },
  cretaceous: {
    yaw: 2.8,
    exposure: 1.35,
    tint: [1.0, 0.96, 0.92],
    sun: { dir: [-0.15, 0.12, -1.0], color: 0xffb070, intensity: 2.4 },
    hemi: { sky: 0xc9d4e4, ground: 0x6a4a30, intensity: 0.75 },
    fog: { color: 0xd8c0a4, near: 70, far: 1800 },
    ground: "forest_ground_04",
    groundTint: 0xc8a888,
    groundRepeat: 8,
    fernTint: 0xb8b078,
    ferns: 30,
    treeFerns: 0,
    crest: 1.0,
    mist: { color: 0xf0d4b8, opacity: 0.1, count: 4, y: [0.2, 1.4], drift: 0.25 },
    rocks: 4,
    rockTint: 0xb09a84,
    herds: [
      // a titanosaur herd plodding along the horizon towards the mesa
      { asset: "sauropod", procedural: true, length: 21, count: 5, z: [-62, -105], x: [110, -110], speed: 1.0, spacing: 14, pause: [10, 20], bothWays: false },
    ],
    fliers: [
      { asset: "ptero", clip: "Animation", fitWingspan: true, speed: 0.8, length: 6, count: 2, center: [0, 32, -95], radius: [70, 30], period: 46 },
    ],
  },
  marine: {
    yaw: 0.6,
    exposure: 1.3,
    tint: [0.96, 0.99, 1.02],
    sun: { dir: [0.4, 0.55, -0.7], color: 0xfff4e0, intensity: 2.2 },
    hemi: { sky: 0xcfe0f0, ground: 0x3a4a52, intensity: 1.0 },
    fog: { color: 0xc8d4dc, near: 40, far: 900 },
    ground: "seaside_rock",
    groundTint: 0x9a968c,
    groundRepeat: 6,
    fernTint: 0x9aa070,
    ferns: 8,
    treeFerns: 0,
    crest: 0.55,
    bermNear: 0.7,
    water: { deep: 0x0d2a3a, shallow: 0x2f6070 },
    mist: { color: 0xeef3f6, opacity: 0.12, count: 5, y: [0.2, 1.5], drift: 0.6 },
    rocks: 14,
    rockTint: 0xa8a49a,
    herds: [],
    fliers: [
      { asset: "ptero", clip: "Animation", fitWingspan: true, speed: 0.8, length: 6, count: 4, center: [0, 22, -70], radius: [55, 22], period: 40 },
    ],
  },
};

const MODELS = {
  raptor: { file: "/models/real/raptor.glb", forward: "+z", stride: 1.86 },
  allo: { file: "/models/real/allo.glb", forward: "+z" },
  sauropod: { file: "/models/real/sauropod.glb", forward: "-x", pose: 8.7, clip: "Bip001|Take 001|BaseLayer" },
  ptero: { file: "/models/real/ptero.glb", forward: "+z" },
};
const FORWARD_YAW = { "+z": 0, "-z": Math.PI, "+x": -Math.PI / 2, "-x": Math.PI / 2 };

function tierLevel(q) {
  const t = typeof q === "function" ? q() : q;
  if (t === "low" || t === "off") return 0;
  if (t === "medium") return 1;
  return 2;
}

/* ------------------------------------------------------------------ */
/* small shared helpers                                                 */
/* ------------------------------------------------------------------ */
let seed = 1337;
function rnd() {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
}
const lerp = (a, b, t) => a + (b - a) * t;

function woodGrainTexture() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = "#6b4a30";
  g.fillRect(0, 0, 64, 512);
  for (let i = 0; i < 90; i++) {
    const x = rnd() * 64;
    const w = 0.5 + rnd() * 2.5;
    g.fillStyle = `rgba(${30 + rnd() * 30},${15 + rnd() * 15},${8},${0.08 + rnd() * 0.18})`;
    g.fillRect(x, 0, w, 512);
  }
  for (let i = 0; i < 26; i++) {
    g.fillStyle = `rgba(255,220,170,${0.03 + rnd() * 0.04})`;
    g.fillRect(rnd() * 64, 0, 1, 512);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** A soft round blob (contact shadows). */
function blobTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  r.addColorStop(0, "rgba(0,0,0,0.85)");
  r.addColorStop(0.5, "rgba(0,0,0,0.4)");
  r.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

/** Box geometry with its own transform baked in (for merging). */
function boxAt(sx, sy, sz, x, y, z, uvScale = 1) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  if (uvScale !== 1) {
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * uvScale);
  }
  g.translate(x, y, z);
  return g;
}

/* ------------------------------------------------------------------ */
/* the glass: render target + fake reflection, vignette at the lip      */
/* ------------------------------------------------------------------ */
const GLASS_VERT = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const GLASS_FRAG = /* glsl */ `
  uniform sampler2D map;
  uniform float uReady;
  uniform vec3 uIdle;
  uniform vec3 uRoom;
  uniform float uGain;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vNormalW;
  void main() {
    vec3 col = texture2D(map, vUv).rgb * uGain;
    // the case lip shades the edges of the scene, the top most of all
    float ex = smoothstep(0.0, 0.03, vUv.x) * smoothstep(0.0, 0.03, 1.0 - vUv.x);
    float ey = smoothstep(0.0, 0.05, vUv.y) * smoothstep(0.0, 0.12, 1.0 - vUv.y);
    col *= mix(0.45, 1.0, ex * ey);
    col = mix(uIdle, col, uReady);
    // glass: Fresnel reflection of the dim gallery, a faint broad sheen
    vec3 V = normalize(cameraPosition - vWorld);
    float ndv = clamp(dot(V, normalize(vNormalW)), 0.0, 1.0);
    float fr = 0.025 + 0.6 * pow(1.0 - ndv, 5.0);
    float band = smoothstep(0.42, 0.5, fract(vUv.x * 0.55 + vUv.y * 0.32 + 0.18)) * smoothstep(0.62, 0.5, fract(vUv.x * 0.55 + vUv.y * 0.32 + 0.18));
    col += uRoom * (fr + 0.035 * band);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/* ------------------------------------------------------------------ */
/* backdrop: the era cube map on a sphere that follows the eye          */
/* ------------------------------------------------------------------ */
const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */ `
  uniform samplerCube tCube;
  uniform float uYaw;
  uniform float uExposure;
  uniform vec3 uTint;
  uniform vec3 uHaze;
  uniform float uHazeAmt;
  uniform float uContrast;
  uniform float uSat;
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    float c = cos(uYaw), s = sin(uYaw);
    d = vec3(c * d.x - s * d.z, d.y, s * d.x + c * d.z);
    vec3 col = textureCube(tCube, vec3(-d.x, d.y, d.z)).rgb;
    // the photographs are soft and hazy: a museum backdrop is painted crisper
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = max(mix(vec3(l), col, uSat), 0.0);
    col = pow(col, vec3(uContrast)) * uExposure * uTint;
    // a touch of aerial haze over the far ground, so the painted
    // backdrop and the modelled foreground share one atmosphere
    float h = 1.0 - smoothstep(-0.02, 0.12, abs(d.y + 0.01));
    col = mix(col, uHaze, h * uHazeAmt);
    gl_FragColor = vec4(col, 1.0);
  }
`;

/* ------------------------------------------------------------------ */
/* sea: summed travelling waves (normals only) + sky reflection         */
/* ------------------------------------------------------------------ */
const WATER_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const WATER_FRAG = /* glsl */ `
  uniform samplerCube tCube;
  uniform float uYaw;
  uniform float uExposure;
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uSun;
  varying vec3 vWorld;
  vec3 sky(vec3 d) {
    float c = cos(uYaw), s = sin(uYaw);
    d = vec3(c * d.x - s * d.z, d.y, s * d.x + c * d.z);
    return textureCube(tCube, vec3(-d.x, d.y, d.z)).rgb * uExposure;
  }
  void main() {
    vec3 toEye = cameraPosition - vWorld;
    float dist = length(toEye);
    vec3 V = toEye / dist;
    vec2 p = vWorld.xz;
    float fade = exp(-dist / 90.0);
    vec2 g = vec2(0.0);
    g += vec2(0.8, 0.6) * cos(dot(vec2(0.8, 0.6), p) * 0.31 + uTime * 0.9) * 0.10;
    g += vec2(-0.5, 0.86) * cos(dot(vec2(-0.5, 0.86), p) * 0.53 + uTime * 1.3) * 0.07;
    g += vec2(0.97, -0.24) * cos(dot(vec2(0.97, -0.24), p) * 1.1 + uTime * 1.9) * 0.05 * fade;
    g += vec2(0.2, 0.98) * cos(dot(vec2(0.2, 0.98), p) * 2.3 + uTime * 2.7) * 0.035 * fade;
    g += vec2(-0.9, 0.43) * cos(dot(vec2(-0.9, 0.43), p) * 4.7 + uTime * 3.6) * 0.02 * fade;
    vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
    vec3 R = reflect(-V, n);
    R.y = abs(R.y) + 0.02;
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
    vec3 body = mix(uShallow, uDeep, smoothstep(5.0, 60.0, dist));
    vec3 col = mix(body * 0.6, sky(normalize(R)), fres);
    // sun glitter
    float sp = pow(max(dot(R, uSun), 0.0), 220.0);
    col += vec3(1.0, 0.95, 0.85) * sp * 2.5;
    // towards the horizon the plane hands over to the panorama's own sea
    col = mix(col, sky(-V), smoothstep(300.0, 1400.0, dist));
    gl_FragColor = vec4(col, 1.0);
  }
`;

/* ------------------------------------------------------------------ */
/* mist: one instanced draw, drift + fbm in the shader                   */
/* ------------------------------------------------------------------ */
const MIST_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uDrift;
  uniform float uRange;
  varying vec2 vUv;
  varying float vSeed;
  varying float vEdge;
  void main() {
    vUv = uv;
    vec3 base = instanceMatrix[3].xyz;
    float sx = length(instanceMatrix[0].xyz);
    float sy = length(instanceMatrix[1].xyz);
    vSeed = fract(base.z * 0.173 + base.y * 0.31);
    base.x = mod(base.x + uTime * uDrift * (0.7 + vSeed * 0.6) + uRange * 0.5, uRange) - uRange * 0.5;
    vEdge = 1.0 - smoothstep(uRange * 0.36, uRange * 0.5, abs(base.x));
    vec4 mv = modelViewMatrix * vec4(base + vec3(position.x * sx, position.y * sy, 0.0), 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;
const MIST_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vSeed;
  varying float vEdge;
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return v;
  }
  void main() {
    vec2 p = vUv * vec2(3.0, 1.4) + vec2(uTime * 0.03 + vSeed * 10.0, uTime * 0.008);
    float n = fbm(p);
    float rx = smoothstep(0.0, 0.3, vUv.x) * smoothstep(1.0, 0.7, vUv.x);
    float ry = smoothstep(0.0, 0.35, vUv.y) * smoothstep(1.0, 0.55, vUv.y);
    float a = smoothstep(0.35, 0.8, n) * rx * ry * uOpacity * vEdge;
    gl_FragColor = vec4(uColor, a);
  }
`;

/* ------------------------------------------------------------------ */
/* main entry                                                           */
/* ------------------------------------------------------------------ */
export function createDioramas({ scene, renderer, camera, quality = "high" } = {}) {
  const level0 = tierLevel(quality);
  const root = new THREE.Group();
  root.name = "dioramas";
  root.userData.surface = "skip"; // lookdev: these materials are final
  scene.add(root);

  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  const cubeLoader = new THREE.CubeTextureLoader();
  const cache = new Map();
  const load = (key, fn) => {
    if (!cache.has(key)) cache.set(key, fn().catch((err) => {
      console.warn(`[diorama] could not load ${key}`, err);
      return null;
    }));
    return cache.get(key);
  };
  const gltf = (url) => load(url, () => loader.loadAsync(url));
  const tex = (url, srgb = true, repeat = 1) =>
    load(`${url}|${srgb}|${repeat}`, () =>
      texLoader.loadAsync(url).then((t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(repeat, repeat);
        t.anisotropy = 4;
        return t;
      })
    );
  const cube = (era) =>
    load(`cube:${era}`, () =>
      cubeLoader.loadAsync(["px", "nx", "py", "ny", "pz", "nz"].map((f) => `/images/eras/${era}/${f}.jpg`)).then((t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
      })
    );

  /* ---------------- shared case materials ---------------- */
  const grain = woodGrainTexture();
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x8a5e3c, map: grain, roughness: 0.48, metalness: 0 });
  const woodDarkMat = new THREE.MeshStandardMaterial({ color: 0x4a3020, map: grain, roughness: 0.55, metalness: 0 });
  const brassMat = new THREE.MeshStandardMaterial({ color: 0xc09a5a, roughness: 0.33, metalness: 0.85 });
  woodMat.userData.lkEnv = 0.4;
  brassMat.userData.lkEnv = 1.0;
  const caseGeo = buildCaseGeometry();

  const rtType = renderer.extensions?.has?.("EXT_color_buffer_float") || renderer.extensions?.has?.("EXT_color_buffer_half_float") ? THREE.HalfFloatType : THREE.UnsignedByteType;
  const blobTex = blobTexture();
  const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.42, color: 0x000000 });
  const blobGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  const windows = [];
  for (const w of ERA_WINDOWS) {
    const cfg = ERA_CFG[w.era];
    const era = ERAS[w.era];
    if (!cfg || !era) continue;
    windows.push(makeWindow(w, cfg, era.hall));
  }

  /** The three merged case meshes + the glass of one window. */
  function makeWindow(w, cfg, hall) {
    const g = new THREE.Group();
    g.name = `diorama-${w.era}`;
    g.position.set(w.x, 0, w.z);
    g.rotation.y = w.ry;
    root.add(g);
    const wood = new THREE.Mesh(caseGeo.wood, woodMat);
    const dark = new THREE.Mesh(caseGeo.dark, woodDarkMat);
    const brass = new THREE.Mesh(caseGeo.brass, brassMat);
    for (const m of [wood, dark, brass]) {
      m.receiveShadow = true;
      g.add(m);
    }
    const idle = new THREE.Color(cfg.fog.color).multiplyScalar(0.35);
    const glassMat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        uReady: { value: 0 },
        uIdle: { value: idle },
        uRoom: { value: new THREE.Color(0.16, 0.13, 0.1) },
        uGain: { value: 1 },
      },
      vertexShader: GLASS_VERT,
      fragmentShader: GLASS_FRAG,
    });
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(GLASS_W, GLASS_H), glassMat);
    glass.position.set(0, GLASS_Y0 + GLASS_H / 2, GLASS_Z);
    g.add(glass);
    g.updateMatrixWorld(true);

    // the cabinet below the glass sticks out of the wall: block walkers
    const fx = Math.sin(w.ry);
    const fz = Math.cos(w.ry);
    const rx = Math.cos(w.ry);
    const rz = -Math.sin(w.ry);
    const halfW = GLASS_W / 2 + 0.5;
    const pts = [
      [-halfW, WALL_FACE],
      [halfW, WALL_FACE],
      [-halfW, APRON_FRONT + 0.06],
      [halfW, APRON_FRONT + 0.06],
    ].map(([a, o]) => [w.x + rx * a + fx * o, w.z + rz * a + fz * o]);
    const obstacle = {
      minX: Math.min(...pts.map((p) => p[0])),
      maxX: Math.max(...pts.map((p) => p[0])),
      minZ: Math.min(...pts.map((p) => p[1])),
      maxZ: Math.max(...pts.map((p) => p[1])),
      id: `diorama:${w.era}`,
    };
    if (Array.isArray(OBSTACLES)) OBSTACLES.push(obstacle);

    // world-space bounds for the visibility test
    const center = new THREE.Vector3(0, GLASS_Y0 + GLASS_H / 2, GLASS_Z);
    g.localToWorld(center);
    const normal = new THREE.Vector3(fx, 0, fz);

    return {
      era: w.era,
      hall,
      cfg,
      group: g,
      glass,
      glassMat,
      center,
      sphere: new THREE.Sphere(center.clone(), Math.hypot(GLASS_W, GLASS_H) / 2 + 0.3),
      normal,
      state: "idle", // idle | loading | ready | failed
      d: null, // the diorama behind the glass, once built
      fade: 0,
      frame: 0,
      acc: 0,
    };
  }

  /* ---------------- per-frame ---------------- */
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const eye = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  let roomTimer = 0;
  let camRoom = null;
  let camNeighbours = null;
  let clock = 0;
  let disposed = false;

  function nearHall(win, dist) {
    if (!camRoom) return false;
    if (camRoom === win.hall) return true;
    return dist < 48 && roomNeighbours(win.hall).has(camRoom);
  }

  function update(dt) {
    if (disposed || !dt) return;
    clock += dt;
    roomTimer -= dt;
    if (roomTimer <= 0) {
      roomTimer = 0.25;
      const r = roomAt(camera.position.x, camera.position.z);
      camRoom = r ? r.id : null;
      camNeighbours = camRoom ? roomNeighbours(camRoom) : null;
    }
    // the 360° era viewer is open: nothing of the museum is drawn
    if (typeof document !== "undefined" && document.body?.classList?.contains("immersive")) return;

    let frustumReady = false;
    const level = tierLevel(quality);
    for (let i = 0; i < windows.length; i++) {
      const win = windows[i];
      const dist = camera.position.distanceTo(win.center);
      const near = nearHall(win, dist);
      if (near && win.state === "idle") build(win);
      if (win.state !== "ready" || !near) continue;
      tmp.copy(camera.position).sub(win.center);
      if (tmp.dot(win.normal) < 0.35) continue; // behind or edge-on
      if (!frustumReady) {
        frustumReady = true;
        camera.updateMatrixWorld();
        projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projView);
      }
      if (!frustum.intersectsSphere(win.sphere)) continue;
      // low tier: ~30 Hz is plenty for a scene this slow
      win.acc += dt;
      if (level === 0 && (++win.frame & 1)) continue;
      const step = win.acc;
      win.acc = 0;
      if (win.fade < 1) {
        // wall-clock fade: frame dt is capped, so slow devices would crawl
        const now = performance.now();
        win.fade = Math.min(1, win.fade + Math.min(0.5, (now - (win.fadeT || now)) / 900));
        win.fadeT = now;
        win.glassMat.uniforms.uReady.value = win.fade * win.fade * (3 - 2 * win.fade);
      }
      win.d.animate(step, clock);
      renderWindow(win, level);
    }
  }

  function renderWindow(win, level) {
    const d = win.d;
    // eye in diorama space (window-local, glass plane at z = 0)
    eye.copy(camera.position);
    win.group.worldToLocal(eye);
    eye.z -= GLASS_Z;
    if (eye.z < 0.25) return;
    const n = eye.z;
    const left = -GLASS_W / 2 - eye.x;
    const right = GLASS_W / 2 - eye.x;
    const bottom = GLASS_Y0 - eye.y;
    const top = GLASS_Y0 + GLASS_H - eye.y;
    const cam = d.camera;
    cam.position.copy(eye);
    cam.updateMatrixWorld();
    cam.projectionMatrix.makePerspective(left, right, top, bottom, n, 2600);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    d.sky.position.copy(eye);
    d.ensureTarget(level);

    const prevTarget = renderer.getRenderTarget();
    const prevShadow = renderer.shadowMap.enabled;
    const prevAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.enabled = false;
    renderer.setRenderTarget(d.target);
    renderer.clear(true, true, false);
    renderer.render(d.scene, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.enabled = prevShadow;
    renderer.shadowMap.autoUpdate = prevAuto;
  }

  /* ---------------- building one diorama ---------------- */
  function build(win) {
    win.state = "loading";
    const level = tierLevel(quality);
    buildDiorama(win.era, win.cfg, level)
      .then(async (d) => {
        if (disposed) return;
        win.d = d;
        d.ensureTarget(level);
        win.glassMat.uniforms.map.value = d.target.texture;
        // compile its programs without blocking, against its own target
        if (typeof renderer.compileAsync === "function") {
          const prev = renderer.getRenderTarget();
          renderer.setRenderTarget(d.target);
          let p;
          try {
            p = renderer.compileAsync(d.scene, d.camera);
          } finally {
            renderer.setRenderTarget(prev);
          }
          await Promise.race([p, new Promise((r) => setTimeout(r, 5000))]).catch(() => {});
        }
        // upload textures one per idle slice instead of in the first frame
        for (const t of d.textures) {
          await new Promise((r) => (window.requestIdleCallback ? window.requestIdleCallback(r, { timeout: 300 }) : setTimeout(r, 16)));
          try {
            renderer.initTexture(t);
          } catch {
            /* drawn on first use instead */
          }
        }
        win.state = "ready";
      })
      .catch((err) => {
        console.warn(`[diorama] ${win.era}: could not build`, err);
        win.state = "failed";
      });
  }

  async function buildDiorama(eraId, cfg, level) {
    seed = 1000 + eraId.length * 97 + eraId.charCodeAt(0);
    const want = [cube(eraId), gltf(`${ASSET}fern_02.gltf`), tex(`${ASSET}fern_02_alpha.jpg`, false)];
    want.push(tex(`${ASSET}${cfg.ground}_diff.jpg`, true, cfg.groundRepeat), tex(`${ASSET}${cfg.ground}_nor.jpg`, false, cfg.groundRepeat));
    if (cfg.treeFerns) want.push(tex(`${ASSET}palm_tree_bark_diff.jpg`, true), tex(`${ASSET}palm_tree_bark_nor.jpg`, false));
    const assetsNeeded = new Set([...cfg.herds.map((h) => h.asset), ...cfg.fliers.map((f) => f.asset)]);
    const modelP = {};
    for (const a of assetsNeeded) modelP[a] = gltf(MODELS[a].file);
    const [cubeTex, fernGltf, fernAlpha, groundMap, groundNor, barkMap, barkNor] = await Promise.all(want);
    const models = {};
    for (const a of assetsNeeded) models[a] = await modelP[a];
    if (!cubeTex) throw new Error("no panorama");

    const dscene = new THREE.Scene();
    const textures = [];
    const dcam = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 2600);
    dscene.fog = new THREE.Fog(cfg.fog.color, cfg.fog.near, cfg.fog.far);

    /* backdrop */
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        tCube: { value: cubeTex },
        uYaw: { value: cfg.yaw },
        uExposure: { value: cfg.exposure },
        uTint: { value: new THREE.Vector3(...cfg.tint) },
        uHaze: { value: new THREE.Color(cfg.fog.color).multiplyScalar(cfg.exposure * 0.9) },
        uHazeAmt: { value: 0.1 },
        uContrast: { value: cfg.contrast ?? 1.15 },
        uSat: { value: cfg.sat ?? 1.15 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(2000, 48, 24), skyMat);
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    dscene.add(sky);

    /* light */
    const sun = new THREE.DirectionalLight(cfg.sun.color, cfg.sun.intensity);
    sun.position.set(...cfg.sun.dir).multiplyScalar(100);
    dscene.add(sun);
    dscene.add(sun.target);
    const hemi = new THREE.HemisphereLight(cfg.hemi.sky, cfg.hemi.ground, cfg.hemi.intensity);
    dscene.add(hemi);
    if (level >= 1) {
      // image-based light from the same (rotated) panorama
      try {
        const envScene = new THREE.Scene();
        const envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMat);
        envScene.add(envSky);
        const pmrem = new THREE.PMREMGenerator(renderer);
        const envRT = pmrem.fromScene(envScene, 0, 0.1, 100);
        pmrem.dispose();
        envSky.geometry.dispose();
        dscene.environment = envRT.texture;
        hemi.intensity *= 0.45;
      } catch (err) {
        console.warn("[diorama] no environment light", err);
      }
    }

    /* foreground berm */
    const groundMat = new THREE.MeshStandardMaterial({
      color: cfg.groundTint,
      map: groundMap,
      normalMap: groundNor,
      roughness: 0.95,
      metalness: 0,
    });
    groundMat.normalScale.set(1.2, 1.2);
    if (groundMap) textures.push(groundMap);
    if (groundNor) textures.push(groundNor);
    const bermGeo = bermGeometry(cfg.crest, cfg.bermNear ?? 1.0);
    const berm = new THREE.Mesh(bermGeo, groundMat);
    dscene.add(berm);
    const heightAt = bermGeo.userData.heightAt;

    /* ferns */
    const wind = { value: 0 };
    const time = { value: 0 };
    const fernParts = [];
    if (fernGltf) {
      fernGltf.scene.traverse((o) => {
        if (o.isMesh) fernParts.push(o);
      });
    }
    const fernCount = Math.round(cfg.ferns * [0.5, 0.75, 1][level]);
    const ferns = [];
    if (fernParts.length) {
      const base = fernParts[0].material;
      const fernMat = base.clone();
      fernMat.color.set(cfg.fernTint).multiplyScalar(1.8);
      // a little light through the fronds (they are thin)
      fernMat.emissive = new THREE.Color(cfg.fernTint).multiplyScalar(0.06);
      fernMat.alphaMap = fernAlpha;
      if (fernAlpha) {
        fernAlpha.flipY = false;
        fernAlpha.wrapS = fernAlpha.wrapT = THREE.ClampToEdgeWrapping;
        fernAlpha.needsUpdate = true;
        textures.push(fernAlpha);
      }
      if (fernMat.map) textures.push(fernMat.map);
      if (fernMat.normalMap) textures.push(fernMat.normalMap);
      fernMat.alphaTest = 0.5;
      fernMat.transparent = false;
      fernMat.side = THREE.DoubleSide;
      fernMat.roughness = 0.75;
      fernMat.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = time;
        shader.uniforms.uWind = wind;
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uWind;")
          .replace(
            "#include <begin_vertex>",
            `#include <begin_vertex>
            #ifdef USE_INSTANCING
              vec3 ip = instanceMatrix[3].xyz;
            #else
              vec3 ip = vec3(0.0);
            #endif
            float ph = ip.x * 0.37 + ip.z * 0.53;
            float hh = max(transformed.y, 0.0);
            float r = length(transformed.xz);
            float sway = sin(uTime * 1.1 + ph) * 0.65 + sin(uTime * 2.7 + ph * 1.9) * 0.25 + sin(uTime * 5.3 + r * 9.0 + ph) * 0.1;
            transformed.x += sway * uWind * (hh * 1.6 + r * 0.25);
            transformed.z += sway * uWind * 0.5 * (hh * 1.6 + r * 0.2) * cos(ph);
            transformed.y += sin(uTime * 1.6 + r * 6.0 + ph) * uWind * r * 0.08;`
          );
      };
      fernMat.customProgramCacheKey = () => "diorama-fern";
      // scatter: crest + slope, denser at the edges of the frame
      const spots = [];
      for (let i = 0; i < fernCount; i++) {
        const u = rnd();
        const x = lerp(-15, 15, u) * (0.65 + 0.35 * Math.abs(u * 2 - 1));
        const z = -lerp(1.2, 11, Math.pow(rnd(), 0.8));
        // keep a sight-line open in the middle of the view
        const s = lerp(1.6, 3.4, rnd()) * (z < -6 ? 1.15 : 1) * (Math.abs(x) < 4 && z < -2.5 ? 0.55 : 1);
        spots.push([x, z, s]);
      }
      // big fronds close to the glass at both sides frame the view, the
      // way a diorama's foreground plants overlap the case edges
      const frame = level === 0 ? 2 : 3;
      for (const side of [-1, 1]) {
        for (let i = 0; i < frame; i++) {
          spots.push([side * lerp(3.2, 6.5, rnd()), -lerp(1.0, 3.5, rnd()), lerp(4.2, 6.2, rnd()) * (cfg.frameFerns ?? 1)]);
        }
      }
      // tree ferns: a trunk with a crown of fronds (Jurassic)
      const trees = [];
      if (cfg.treeFerns) {
        const barkMat = new THREE.MeshStandardMaterial({ color: 0x6a5240, map: barkMap, normalMap: barkNor, roughness: 0.9 });
        if (barkMap) {
          barkMap.repeat.set(1, 3);
          textures.push(barkMap);
        }
        if (barkNor) {
          barkNor.repeat.set(1, 3);
          textures.push(barkNor);
        }
        const placesT = [[-6.2, -6, 4.6], [7.0, -9, 5.4], [-1.5, -16, 6.2], [13, -12, 4.4]];
        for (let i = 0; i < Math.min(cfg.treeFerns + (level === 2 ? 1 : 0), placesT.length); i++) {
          const [x, z, h] = placesT[i];
          const y0 = heightAt(x, z) - 0.2;
          const trunkGeo = new THREE.CylinderGeometry(0.26, 0.42, h, 12, 8);
          // a gentle lean and taper wobble
          const pos = trunkGeo.attributes.position;
          for (let k = 0; k < pos.count; k++) {
            const yy = pos.getY(k) + h / 2;
            pos.setX(k, pos.getX(k) + Math.sin(yy * 0.6 + i) * 0.12 + yy * 0.05 * (i % 2 ? 1 : -1));
          }
          trunkGeo.computeVertexNormals();
          const trunk = new THREE.Mesh(trunkGeo, barkMat);
          trunk.position.set(x, y0 + h / 2, z);
          dscene.add(trunk);
          trees.push([x + h * 0.05 * (i % 2 ? 1 : -1), y0 + h - 0.05, z]);
        }
      }
      // one InstancedMesh per fern variant
      const perPart = fernParts.map(() => []);
      spots.forEach((s, i) => perPart[i % fernParts.length].push(s));
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const v = new THREE.Vector3();
      const sc = new THREE.Vector3();
      fernParts.forEach((part, pi) => {
        const list = perPart[pi];
        const count = list.length + (pi < 2 ? trees.length * 2 : 0);
        if (!count) return;
        const geo = part.geometry.clone();
        // the gltf nodes sit on a 1 m grid: centre each clump on its own root
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
        const im = new THREE.InstancedMesh(geo, fernMat, Math.ceil(count));
        let k = 0;
        for (const [x, z, s] of list) {
          e.set((rnd() - 0.5) * 0.15, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.15);
          q.setFromEuler(e);
          v.set(x, heightAt(x, z) - 0.05, z);
          sc.set(s, s * lerp(0.9, 1.35, rnd()), s);
          im.setMatrixAt(k++, m4.compose(v, q, sc));
        }
        if (pi < 2) {
          // two crossed, drooping fern clumps make each crown
          for (const [x, y, z] of trees) {
            for (let c = 0; c < 2; c++) {
              e.set(c ? 0.25 : -0.2, rnd() * Math.PI * 2, c ? -0.2 : 0.25);
              q.setFromEuler(e);
              v.set(x, y - 0.25, z);
              const s = 8.5 + pi * 1.2;
              sc.set(s, s * 1.1, s);
              im.setMatrixAt(k++, m4.compose(v, q, sc));
            }
          }
        }
        im.count = k;
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        dscene.add(im);
        ferns.push(im);
      });
    }

    /* the sea: a wave-lit plane reflecting the same sky */
    if (cfg.water) {
      const waterMat = new THREE.ShaderMaterial({
        uniforms: {
          tCube: { value: cubeTex },
          uYaw: { value: cfg.yaw },
          uExposure: { value: cfg.exposure },
          uTime: time,
          uDeep: { value: new THREE.Color(cfg.water.deep) },
          uShallow: { value: new THREE.Color(cfg.water.shallow) },
          uSun: { value: new THREE.Vector3(...cfg.sun.dir).normalize() },
        },
        vertexShader: WATER_VERT,
        fragmentShader: WATER_FRAG,
        fog: false,
      });
      const water = new THREE.Mesh(new THREE.PlaneGeometry(6000, 3000, 1, 1).rotateX(-Math.PI / 2).translate(0, 0.05, -1500 - 4), waterMat);
      water.frustumCulled = false;
      dscene.add(water);
    }

    /* rocks: half-buried, breaking up the crest line */
    if (cfg.rocks) {
      const rockMat = groundMat.clone();
      rockMat.color.set(cfg.rockTint);
      rockMat.roughness = 0.9;
      const n = Math.round(cfg.rocks * [0.6, 0.8, 1][level]);
      const rim = new THREE.InstancedMesh(rockGeometry(), rockMat, n);
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const v = new THREE.Vector3();
      const sc = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        const x = lerp(-17, 17, rnd());
        const z = -lerp(2.5, 10, rnd());
        const s = lerp(0.35, 1.3, Math.pow(rnd(), 1.5)) * (Math.abs(x) > 6 ? 1.3 : 1);
        e.set((rnd() - 0.5) * 0.5, rnd() * 6.28, (rnd() - 0.5) * 0.5);
        q.setFromEuler(e);
        v.set(x, heightAt(x, z) - s * 0.25, z);
        sc.set(s * lerp(1, 1.7, rnd()), s * lerp(0.55, 0.9, rnd()), s);
        rim.setMatrixAt(i, m4.compose(v, q, sc));
      }
      rim.instanceMatrix.needsUpdate = true;
      rim.computeBoundingSphere();
      dscene.add(rim);
    }

    /* mist */
    let mist = null;
    if (level >= 1 && cfg.mist.count) {
      const mistMat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: time,
          uDrift: { value: cfg.mist.drift },
          uRange: { value: 140 },
          uColor: { value: new THREE.Color(cfg.mist.color) },
          uOpacity: { value: cfg.mist.opacity },
        },
        vertexShader: MIST_VERT,
        fragmentShader: MIST_FRAG,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      const n = Math.round(cfg.mist.count * (level === 2 ? 1 : 0.7));
      mist = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mistMat, n);
      const m4 = new THREE.Matrix4();
      for (let i = 0; i < n; i++) {
        const z = -lerp(12, 70, rnd());
        const w = lerp(18, 36, rnd()) * (1 + -z / 80);
        const h = lerp(1.6, 3.2, rnd());
        const y = lerp(cfg.mist.y[0], cfg.mist.y[1], rnd()) + h * 0.2;
        m4.makeScale(w, h, 1);
        m4.setPosition(lerp(-70, 70, rnd()), y, z);
        mist.setMatrixAt(i, m4);
      }
      mist.frustumCulled = false;
      mist.renderOrder = 5;
      dscene.add(mist);
    }

    /* animals */
    const walkers = [];
    const fliers = [];
    const mixers = [];
    for (const h of cfg.herds) {
      const src = models[h.asset];
      if (!src) continue;
      const count = Math.max(1, Math.round(h.count * [0.5, 0.75, 1][level]));
      const proto = prepareModel(src, MODELS[h.asset], h);
      for (let i = 0; i < count; i++) {
        const a = spawnAnimal(proto, h, i, count);
        dscene.add(a.holder);
        if (a.blob) dscene.add(a.blob);
        walkers.push(a);
      }
    }
    for (const f of cfg.fliers) {
      const src = models[f.asset];
      if (!src) continue;
      const count = Math.max(1, Math.round(f.count * [0.5, 1, 1][level]));
      const proto = prepareModel(src, MODELS[f.asset], f);
      for (let i = 0; i < count; i++) {
        const a = spawnFlier(proto, f, i, count);
        dscene.add(a.holder);
        fliers.push(a);
      }
    }
    for (const w of walkers) if (w.mixer) mixers.push(w.mixer);
    for (const f of fliers) if (f.mixer) mixers.push(f.mixer);

    /* render target */
    let target = null;
    let targetLevel = -1;
    function ensureTarget(lv) {
      if (target && targetLevel === lv) return;
      const s = [0.5, 0.75, 1][lv];
      const w = Math.round(BASE_RT.w * s);
      const h = Math.round(BASE_RT.h * s);
      if (!target) {
        target = new THREE.WebGLRenderTarget(w, h, {
          type: rtType,
          samples: [0, 2, 4][lv],
          colorSpace: rtType === THREE.HalfFloatType ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace,
          depthBuffer: true,
        });
        target.texture.generateMipmaps = false;
        target.texture.minFilter = THREE.LinearFilter;
        api.target = target;
      } else {
        target.setSize(w, h);
      }
      targetLevel = lv;
    }

    function animate(dt, t) {
      time.value = t;
      wind.value = 0.05 + 0.03 * Math.sin(t * 0.21) + 0.02 * Math.sin(t * 0.57);
      for (let i = 0; i < walkers.length; i++) walkers[i].step(dt, t);
      for (let i = 0; i < fliers.length; i++) fliers[i].step(dt, t);
      for (let i = 0; i < mixers.length; i++) mixers[i].update(dt);
      for (let i = 0; i < walkers.length; i++) walkers[i].post?.();
    }

    const api = { scene: dscene, camera: dcam, sky, textures, animate, ensureTarget, target: null, walkers, fliers };
    return api;

    /* --- helpers that need this diorama's state --- */
    function spawnAnimal(proto, h, i, count) {
      const holder = new THREE.Group();
      const inner = proto.instance();
      holder.add(inner.root);
      const dir0 = Math.sign(h.x[1] - h.x[0]) || 1;
      const zBase = lerp(h.z[0], h.z[1], count > 1 ? i / (count - 1) : 0.5) + (rnd() - 0.5) * 3;
      const blob = proto.footprint
        ? Object.assign(new THREE.Mesh(blobGeo, blobMat), {})
        : null;
      if (blob) blob.scale.set(proto.footprint[0], 1, proto.footprint[1]);
      const st = {
        holder,
        blob,
        mixer: inner.mixer,
        dir: dir0,
        x: 0,
        z: zBase,
        wait: 0,
        // the herd walks as a loose column
        lag: i * (h.spacing || 0) + rnd() * (h.spacing || 0) * 0.4,
        speed: proto.speed * (0.96 + rnd() * 0.08),
        wob: rnd() * 10,
      };
      const span = Math.abs(h.x[1] - h.x[0]);
      const startX = (d) => (d > 0 ? Math.min(h.x[0], h.x[1]) : Math.max(h.x[0], h.x[1]));
      // the first pass is already under way when a visitor walks in
      st.x = startX(st.dir) + st.dir * (span * 0.42 - st.lag);
      st.step = (dt, t) => {
        if (st.wait > 0) {
          st.wait -= dt;
          holder.visible = false;
          if (blob) blob.visible = false;
          if (st.wait <= 0) {
            if (h.bothWays) st.dir = -st.dir;
            st.x = startX(st.dir) - st.dir * st.lag;
          }
          return;
        }
        st.x += st.dir * st.speed * dt;
        const end = st.dir > 0 ? Math.max(h.x[0], h.x[1]) : Math.min(h.x[0], h.x[1]);
        if ((end - st.x) * st.dir < 0) {
          st.wait = lerp(h.pause[0], h.pause[1], rnd()) + (st.lag > 0 ? 0.01 : 0);
          return;
        }
        const zz = st.z + Math.sin(st.x * 0.05 + st.wob) * 1.2;
        const yy = heightAt(st.x, zz) > 0.05 ? heightAt(st.x, zz) : 0;
        holder.visible = true;
        holder.position.set(st.x, yy, zz);
        holder.rotation.y = (st.dir > 0 ? Math.PI / 2 : -Math.PI / 2) - Math.cos(st.x * 0.05 + st.wob) * 0.06 * st.dir;
        if (blob) {
          blob.visible = true;
          blob.position.set(st.x, yy + 0.04, zz);
          blob.rotation.y = holder.rotation.y;
        }
        inner.step?.(dt, t);
      };
      st.post = inner.post;
      return st;
    }

    function spawnFlier(proto, f, i, count) {
      const holder = new THREE.Group();
      const inner = proto.instance();
      holder.add(inner.root);
      const ph = (i / count) * Math.PI * 2 + rnd() * 0.8;
      const rad = 0.75 + rnd() * 0.5;
      const alt = (rnd() - 0.5) * 10;
      const dirSign = i % 2 ? 1 : -1;
      const st = {
        holder,
        mixer: inner.mixer,
        step: (dt, t) => {
          const a = ph + dirSign * (t / f.period) * Math.PI * 2;
          const x = f.center[0] + Math.cos(a) * f.radius[0] * rad;
          const z = f.center[2] + Math.sin(a) * f.radius[1] * rad;
          const y = f.center[1] + alt + Math.sin(t * 0.3 + ph) * 2.5;
          holder.position.set(x, y, z);
          // tangent heading (+z forward) and a bank into the turn
          const tx = -Math.sin(a) * f.radius[0] * dirSign;
          const tz = Math.cos(a) * f.radius[1] * dirSign;
          holder.rotation.set(0, Math.atan2(tx, tz), 0);
          holder.rotateZ(-0.28 * dirSign);
        },
      };
      return st;
    }
  }

  /**
   * A model ready to clone: orientation, scale to `length` metres, feet on
   * y = 0, clip (optionally a sub-range with the root motion taken out) or a
   * procedural quadruped gait for clip-less sauropods.
   */
  function prepareModel(gltfData, info, spec) {
    const yaw = FORWARD_YAW[info.forward || "+z"] ?? 0;
    const probe = cloneSkinned(gltfData.scene);
    const rot = new THREE.Group();
    rot.rotation.y = yaw;
    rot.add(probe);
    let clip = null;
    if (spec.clip) clip = gltfData.animations.find((c) => c.name === spec.clip) || null;
    const poseClip = info.clip ? gltfData.animations.find((c) => c.name === info.clip) : null;
    // measure in the pose it will be shown in
    const mixer0 = new THREE.AnimationMixer(probe);
    if (poseClip && Number.isFinite(info.pose)) {
      mixer0.clipAction(poseClip).play();
      mixer0.setTime(info.pose);
    } else if (clip) {
      mixer0.clipAction(clip).play();
      mixer0.setTime(spec.sub ? spec.sub[0] : 0);
    }
    rot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(rot, true);
    const size = box.getSize(new THREE.Vector3());
    const natural = spec.fitWingspan ? size.x : size.z;
    const scale = spec.length / Math.max(1e-6, natural);
    const lift = -box.min.y * scale;

    // root motion of a sub-clip: measured on the probe, cancelled at run time
    let sub = null;
    let speed = spec.speed;
    if (clip && spec.sub) {
      const fps = 30;
      sub = THREE.AnimationUtils.subclip(clip, `${clip.name}#dio`, Math.round(spec.sub[0] * fps), Math.round(spec.sub[1] * fps), fps);
      const rb = probe.getObjectByName(spec.rootBone);
      if (rb) {
        mixer0.stopAllAction();
        const act = mixer0.clipAction(sub);
        act.play();
        mixer0.setTime(0);
        rot.updateMatrixWorld(true);
        const a = rb.getWorldPosition(new THREE.Vector3());
        const la = rb.position.clone();
        mixer0.setTime(sub.duration - 1e-4);
        rot.updateMatrixWorld(true);
        const b = rb.getWorldPosition(new THREE.Vector3());
        const lb = rb.position.clone();
        const dist = Math.hypot(b.x - a.x, b.z - a.z) * scale;
        sub.userData = { rootBone: spec.rootBone, la, lb, dist };
        speed = (dist / sub.duration) * spec.speed; // m/s at timeScale spec.speed
      }
    } else if (clip && info.stride) {
      speed = info.stride * scale * spec.speed;
    }
    mixer0.stopAllAction();
    mixer0.uncacheRoot(probe);

    const footprint = spec.procedural || spec.asset === "allo" || spec.asset === "raptor"
      ? [size.x * scale * 1.2 + 0.6, size.z * scale * 0.85]
      : null;
    // procedural walkers: the swing axis of each leg bone, in bone space
    const gait = spec.procedural ? gaitRig(probe, poseClip, info.pose, yaw) : null;
    if (spec.procedural) speed = spec.length * 0.075 * spec.speed;

    const tintCol = spec.tint ? new THREE.Color(spec.tint) : null;
    const tinted = new Map();

    return {
      speed,
      footprint,
      instance() {
        const model = cloneSkinned(gltfData.scene);
        model.traverse((o) => {
          if (!o.isMesh) return;
          o.frustumCulled = false; // skinned bounds lag behind the walk
          if (tintCol && o.material) {
            if (!tinted.has(o.material)) {
              const m = o.material.clone();
              m.color.multiply(tintCol);
              tinted.set(o.material, m);
            }
            o.material = tinted.get(o.material);
          }
        });
        const r = new THREE.Group();
        r.rotation.y = yaw;
        r.scale.setScalar(scale);
        r.position.y = lift;
        r.add(model);
        let mixer = null;
        let step = null;
        let post = null;
        if (gait) {
          // freeze the chosen pose, then swing the legs ourselves
          const m = new THREE.AnimationMixer(model);
          m.clipAction(poseClip).play();
          m.setTime(info.pose);
          m.stopAllAction();
          m.clipAction(poseClip).play();
          m.setTime(info.pose);
          const bones = gait.map((g) => ({ ...g, bone: model.getObjectByName(g.name) })).filter((g) => g.bone);
          for (const g of bones) g.base = g.bone.quaternion.clone();
          const q = new THREE.Quaternion();
          const phase0 = rnd();
          const pelvis = model.getObjectByName(gait.pelvis);
          const pelvisY = pelvis ? pelvis.position.y : 0;
          step = (dt, t) => {
            const cyc = t / 2.6 + phase0;
            for (const g of bones) {
              const p = (cyc + g.phase) * Math.PI * 2;
              let ang;
              if (g.kind === "upper") ang = Math.sin(p) * g.amp;
              else ang = Math.max(0, Math.cos(p)) * g.amp; // flex while the leg swings forward
              q.setFromAxisAngle(g.axis, ang);
              g.bone.quaternion.copy(g.base).multiply(q);
            }
            if (pelvis) pelvis.position.y = pelvisY + Math.sin(cyc * Math.PI * 4) * gait.bob;
          };
        } else if (clip) {
          mixer = new THREE.AnimationMixer(model);
          const use = sub || clip;
          const act = mixer.clipAction(use);
          act.play();
          act.timeScale = spec.speed;
          act.time = rnd() * use.duration;
          if (sub && sub.userData?.rootBone) {
            const rb = model.getObjectByName(sub.userData.rootBone);
            const { la, lb } = sub.userData;
            if (rb) {
              // hold the root on the spot: the holder does the travelling
              post = () => {
                const f = act.time / sub.duration;
                rb.position.x -= (lb.x - la.x) * f;
                rb.position.z -= (lb.z - la.z) * f;
              };
            }
          }
        }
        return { root: r, mixer, step, post };
      },
    };
  }

  /** Leg bones of the 3ds Max biped sauropod and their swing axes. */
  function gaitRig(probe, poseClip, pose, yaw) {
    const m = new THREE.AnimationMixer(probe);
    if (poseClip) {
      m.clipAction(poseClip).play();
      m.setTime(pose);
    }
    probe.updateMatrixWorld(true);
    // lateral axis of the animal in model space (forward is -x: lateral is z)
    const lateral = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), 0);
    const rootInv = new THREE.Quaternion();
    probe.getWorldQuaternion(rootInv).invert();
    const find = (prefix) => {
      let hit = null;
      probe.traverse((o) => {
        if (!hit && o.isBone && o.name.startsWith(prefix)) hit = o;
      });
      return hit;
    };
    const legs = [
      // lateral sequence walk: LH, LF, RH, RF a quarter cycle apart
      { upper: "Bip001_L_Thigh", lower: "Bip001_L_Calf", phase: 0, amp: 0.3, flex: 0.45 },
      { upper: "Bip001_L_UpperArm", lower: "Bip001_L_Forearm", phase: 0.25, amp: 0.26, flex: 0.35 },
      { upper: "Bip001_R_Thigh", lower: "Bip001_R_Calf", phase: 0.5, amp: 0.3, flex: 0.45 },
      { upper: "Bip001_R_UpperArm", lower: "Bip001_R_Forearm", phase: 0.75, amp: 0.26, flex: 0.35 },
    ];
    const out = [];
    const wq = new THREE.Quaternion();
    for (const l of legs) {
      for (const [kind, name, amp] of [["upper", l.upper, l.amp], ["lower", l.lower, l.flex]]) {
        const b = find(name);
        if (!b) continue;
        b.getWorldQuaternion(wq);
        wq.premultiply(rootInv);
        const axis = lateral.clone().applyQuaternion(wq.invert()).normalize();
        out.push({ name: b.name, kind, axis, amp, phase: l.phase });
      }
    }
    const pelvis = find("Bip001_Pelvis");
    out.pelvis = pelvis ? pelvis.name : null;
    out.bob = 0.6;
    m.stopAllAction();
    m.uncacheRoot(probe);
    void yaw;
    return out;
  }

  /* ---------------- case geometry ---------------- */
  function buildCaseGeometry() {
    const W = GLASS_W;
    const H = GLASS_H;
    const y0 = GLASS_Y0;
    const S = 0.42; // stile / rail width
    const D = CASE_FRONT - WALL_FACE;
    const zc = (WALL_FACE + CASE_FRONT) / 2;
    const wood = [
      boxAt(W + 2 * S, 0.44, D, 0, y0 + H + 0.22, zc), // head rail
      boxAt(S, H, D, -(W / 2 + S / 2), y0 + H / 2, zc), // stiles
      boxAt(S, H, D, W / 2 + S / 2, y0 + H / 2, zc),
      boxAt(W + 2 * S + 0.1, 0.1, D + 0.14, 0, y0 + H + 0.49, zc + 0.07), // cornice
      boxAt(W + 2 * S + 0.24, 0.08, D + 0.22, 0, y0 + H + 0.58, zc + 0.11),
      boxAt(W + 2 * S + 0.16, 0.07, APRON_FRONT - WALL_FACE + 0.08, 0, y0 - 0.02, (WALL_FACE + APRON_FRONT) / 2 + 0.04), // sill cap
    ];
    const dark = [
      boxAt(W + 2 * S, y0 - 0.05, APRON_FRONT - WALL_FACE, 0, (y0 - 0.05) / 2, (WALL_FACE + APRON_FRONT) / 2), // cabinet
      boxAt(W + 2 * S + 0.06, 0.16, APRON_FRONT - WALL_FACE + 0.04, 0, 0.08, (WALL_FACE + APRON_FRONT) / 2 + 0.02), // plinth
      boxAt(W - 0.2, 0.24, 0.04, 0, y0 + H + 0.22, CASE_FRONT + 0.02), // head-rail fascia (shadow line)
    ];
    // raised panels on the cabinet front
    const pw = (W + 2 * S - 0.5) / 3;
    for (let i = 0; i < 3; i++) {
      wood.push(boxAt(pw - 0.16, y0 - 0.55, 0.035, -((W + 2 * S - 0.5) / 2) + pw * (i + 0.5), 0.62, APRON_FRONT + 0.015));
    }
    const bead = 0.05;
    const bz = GLASS_Z + 0.02;
    const brass = [
      boxAt(W + bead * 2, bead, 0.05, 0, y0 + H + bead / 2, bz),
      boxAt(W + bead * 2, bead, 0.05, 0, y0 - bead / 2 + 0.02, bz),
      boxAt(bead, H, 0.05, -W / 2 - bead / 2, y0 + H / 2, bz),
      boxAt(bead, H, 0.05, W / 2 + bead / 2, y0 + H / 2, bz),
      boxAt(W + 2 * S + 0.16, 0.028, 0.028, 0, y0 - 0.07, APRON_FRONT + 0.11), // sill nosing rod
    ];
    const merge = (list) => {
      const g = mergeGeometries(list, false);
      list.forEach((x) => x.dispose());
      return g;
    };
    return { wood: merge(wood), dark: merge(dark), brass: merge(brass) };
  }

  /** A lumpy boulder (shared by every rock instance). */
  let rockGeo = null;
  function rockGeometry() {
    if (rockGeo) return rockGeo;
    const g = new THREE.IcosahedronGeometry(1, 3);
    const p = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const k =
        1 +
        0.22 * Math.sin(v.x * 2.1 + v.y * 1.3) +
        0.12 * Math.sin(v.y * 4.7 - v.z * 3.1) +
        0.06 * Math.sin(v.z * 9.3 + v.x * 7.7);
      v.multiplyScalar(k);
      // flat-ish base and a few facets
      if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.3;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    rockGeo = g;
    return g;
  }

  /**
   * The foreground berm behind the glass: a planted bank that rises just
   * behind the glass, crests 5-8 m back and falls away below the eye line
   * (so its back never shows), hiding the seam with the panorama's ground.
   */
  function bermGeometry(crest, near) {
    const W = 64;
    const D = 26;
    const geo = new THREE.PlaneGeometry(W, D, 96, 52);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, 0, -D / 2 + 0.6);
    const pos = geo.attributes.position;
    const n2 = (x, z) =>
      Math.sin(x * 0.37 + 1.3) * 0.5 + Math.sin(x * 0.91 + z * 0.3) * 0.25 + Math.sin(x * 2.3 - z * 1.7) * 0.08 + Math.sin(z * 0.8 + x * 0.2) * 0.2;
    const heightAt = (x, z) => {
      const d = -z; // metres behind the glass
      const crestD = 6.2 + Math.sin(x * 0.21) * 1.4;
      let h;
      if (d < crestD) h = lerp(near, crest, Math.pow(Math.max(0, d) / crestD, 0.8));
      else h = crest - Math.pow((d - crestD) / 7, 1.6) * (crest + 1.2);
      // a dip in the middle of the view, banks rising towards the frame edges
      h += -0.18 * Math.exp(-(x * x) / 18) + Math.min(1.2, (x * x) / 260);
      h += n2(x, z) * (0.12 + 0.3 * Math.exp(-((d - crestD) ** 2) / 10));
      return Math.max(-1.3, h);
    };
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, heightAt(x, z));
    }
    geo.computeVertexNormals();
    geo.userData.heightAt = heightAt;
    return geo;
  }

  return {
    root,
    windows,
    update,
    /** Debug: force-build every diorama now. */
    buildAll() {
      for (const w of windows) if (w.state === "idle") build(w);
    },
    dispose() {
      disposed = true;
      scene.remove(root);
      for (const w of windows) {
        w.d?.target?.dispose();
        const i = OBSTACLES.findIndex((o) => o.id === `diorama:${w.era}`);
        if (i >= 0) OBSTACLES.splice(i, 1);
      }
    },
  };
}
