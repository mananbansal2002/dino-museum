/**
 * Look development: turns the blocky prototype museum into a lit, textured
 * natural-history interior. It runs AFTER buildWorld() and never edits
 * world.js. It walks the scene and upgrades meshes by tag
 * (mesh.userData.surface, or a tag on any ancestor group) or, for untagged
 * meshes, by the traits world.js builds them with. It then adds the
 * architecture a real gallery has: panelled wainscot with skirting and a
 * dado rail, crown moulding, pilasters, door casings, coffered or beamed
 * ceilings, an oculus over the Grand Gallery and a skylight lantern over
 * the atrium. All of it is instanced or merged, so it costs a handful of
 * draw calls.
 *
 *   const lookdev = applyLookdev({ renderer, scene, camera });
 *   ...
 *   lookdev.render();          // instead of renderer.render(scene, camera)
 *   lookdev.resize(w, h);      // from the window resize handler
 *
 * Tags understood (userData.surface):
 *   floor | ceiling | wall | trim | plinth | wood | metal | glass | fabric |
 *   emissive | image | skip
 * Optional: userData.room = "<room id>" (floors/walls), userData.metal =
 * "brass" | "steel" | "black", userData.dynamic / userData.noMerge = true.
 *
 * Quality tiers: "low" (SwiftShader & co: textures + architecture only),
 * "medium" (+ HDRI reflections, light shafts), "high" (+ MSAA composer,
 * bloom, vignette/grain), "ultra" (+ GTAO). "auto" picks low on software
 * rasterisers and high elsewhere, then adapts pixel ratio and tier to the
 * measured frame time. `?lookdev=off|low|medium|high|ultra` overrides it.
 */
import * as THREE from "three";
import * as WORLD from "./world.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";

const TIERS = ["low", "medium", "high", "ultra"];
const TEX = "/textures/";
const HDRI = "/textures/env/hall_of_mammals_512.hdr";
const WARM = new THREE.Color(0xffe2c4); // ~3500K
const LIGHT_POOL = 6;

/** Curated museum paint per hall (sRGB). Unknown rooms fall back to their own wall colour. */
const PAINT = {
  rotunda: 0xd6c09c,
  lobby: 0xdecbae,
  porch: 0xcfc8b8,
  cretaceous: 0x9a5e45,
  predator: 0x6e3034,
  triassic: 0xae8550,
  jurassic: 0x56705a,
  marine: 0x2f5866,
  theater: 0x4d3a3f,
  court: 0xe2c3b4,
};
const CORRIDOR_PAINT = 0xc9bea9;

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function detectSoftware(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const s = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return { software: /swiftshader|llvmpipe|software|softpipe/i.test(s), name: s };
  } catch {
    return { software: false, name: "unknown" };
  }
}

function urlOverride() {
  try {
    const q = new URLSearchParams(window.location.search).get("lookdev");
    return q ? q.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The surface tag of a mesh: its own, else the nearest tagged ancestor. */
function tagOf(obj) {
  for (let o = obj; o; o = o.parent) {
    if (o.userData && o.userData.surface) return o.userData.surface;
  }
  return null;
}

function flagUp(obj, key) {
  for (let o = obj; o; o = o.parent) if (o.userData && o.userData[key]) return true;
  return false;
}

const hex = (m) => (m && m.color ? m.color.getHex() : -1);

function radialTexture(stops, size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const h = size / 2;
  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  for (const [t, col] of stops) g.addColorStop(t, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function roomBounds(r) {
  const C = WORLD.CELL;
  return {
    x0: WORLD.g2w(r.cols[0]) - C / 2,
    x1: WORLD.g2w(r.cols[1]) + C / 2,
    z0: WORLD.g2z(r.rows[0]) - C / 2,
    z1: WORLD.g2z(r.rows[1]) + C / 2,
  };
}

/** Collects axis-aligned boxes and emits one InstancedMesh. */
function boxBatch(material, name) {
  const items = [];
  return {
    add(cx, cy, cz, sx, sy, sz) {
      if (sx > 0.001 && sy > 0.001 && sz > 0.001) items.push([cx, cy, cz, sx, sy, sz]);
    },
    build() {
      if (!items.length) return null;
      const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, items.length);
      const m = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const p = new THREE.Vector3();
      const s = new THREE.Vector3();
      items.forEach(([cx, cy, cz, sx, sy, sz], i) => {
        m.compose(p.set(cx, cy, cz), q, s.set(sx, sy, sz));
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      mesh.name = name;
      mesh.userData.lkDone = true;
      return mesh;
    },
  };
}

/* ------------------------------------------------------------------ */
/* world-space UV shader patch                                          */
/* ------------------------------------------------------------------ */
/*
 * Boxes in world.js are unit cubes scaled per instance and planes carry
 * 0..1 UVs, so textures would stretch. This patch projects the maps from
 * world position along the dominant world normal axis (box-projected
 * "triplanar-lite"), adds a low frequency colour variation that hides
 * tiling, an optional gain (so mid-grey albedo maps can carry light paint
 * colours) and optional darkening near the floor (contact AO).
 */
function patchWorldUV(mat, metersPerRepeat, { macro = 0.1, baseDarken = 0, gain = 1, offset = [0, 0] } = {}) {
  const s = (1 / metersPerRepeat).toFixed(5);
  const key = `lk-wuv-${s}-${macro}-${baseDarken}-${gain}-${offset.join(",")}`;
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vLkWorld;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec4 lkP = vec4(transformed, 1.0);
        vec3 lkN = objectNormal;
        #ifdef USE_INSTANCING
          lkP = instanceMatrix * lkP;
          lkN = mat3(instanceMatrix) * lkN;
        #endif
        lkP = modelMatrix * lkP;
        lkN = abs(normalize(mat3(modelMatrix) * lkN));
        vLkWorld = lkP.xyz;
        vec2 lkUv = (lkN.y > max(lkN.x, lkN.z)) ? lkP.xz : ((lkN.x > lkN.z) ? lkP.zy : lkP.xy);
        lkUv = lkUv * ${s} + vec2(${offset[0].toFixed(3)}, ${offset[1].toFixed(3)});
        #ifdef USE_MAP
          vMapUv = lkUv;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv = lkUv;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv = lkUv;
        #endif`
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vLkWorld;
        float lkHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float lkNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(lkHash(i), lkHash(i + vec2(1.0, 0.0)), f.x),
                     mix(lkHash(i + vec2(0.0, 1.0)), lkHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        {
          vec2 q = vLkWorld.xz * 0.09 + vec2(vLkWorld.y * 0.13);
          float n = lkNoise(q) * 0.65 + lkNoise(q * 3.1) * 0.35;
          diffuseColor.rgb *= ${gain.toFixed(3)} * (1.0 + (n - 0.5) * ${macro.toFixed(3)});
          diffuseColor.rgb *= mix(${(1 - baseDarken).toFixed(3)}, 1.0, smoothstep(0.05, 1.6, vLkWorld.y));
        }`
      );
  };
  mat.needsUpdate = true;
  return mat;
}

/* ------------------------------------------------------------------ */
/* main entry                                                           */
/* ------------------------------------------------------------------ */

export function applyLookdev({ renderer, scene, camera, quality = "auto", adaptive } = {}) {
  const override = urlOverride();
  if (override === "off") {
    return {
      composer: null,
      quality: "off",
      render: () => renderer.render(scene, camera),
      resize: (w, h) => renderer.setSize(w, h),
      setQuality: () => {},
      refresh: () => 0,
      stats: () => ({ tier: "off" }),
    };
  }
  const gpu = detectSoftware(renderer);
  const requested = override && TIERS.includes(override) ? override : quality;
  // adaptive: trade pixel ratio and tier for frame time. On for "auto", and
  // for a tier main.js picked itself (not for ?lookdev= or a chosen tier).
  let auto = override && TIERS.includes(override) ? false : adaptive ?? requested === "auto";
  let tier = requested === "auto" ? (gpu.software ? "low" : "high") : TIERS.includes(requested) ? requested : "high";
  const tierAtLeast = (t) => TIERS.indexOf(tier) >= TIERS.indexOf(t);
  const maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const isWebGL2 = renderer.capabilities.isWebGL2;

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  /* ---------------- textures ---------------- */
  // ImageBitmaps are decoded off the main thread (an <img> is decoded
  // synchronously on its first upload: ~10-150 ms of jank per map)
  const bitmaps =
    typeof createImageBitmap === "function" && typeof THREE.ImageBitmapLoader === "function"
      ? new THREE.ImageBitmapLoader().setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" })
      : null;
  const loader = new THREE.TextureLoader();
  const texCache = new Map();
  function load(url) {
    if (!bitmaps) return loader.load(url);
    const t = new THREE.Texture();
    t.flipY = false; // flipped while decoding
    bitmaps.load(
      url,
      (bmp) => {
        t.image = bmp;
        t.needsUpdate = true;
      },
      undefined,
      () => {
        /* the material keeps its flat colour */
      }
    );
    return t;
  }
  function tex(name, kind) {
    const k = `${name}/${kind}`;
    if (texCache.has(k)) return texCache.get(k);
    const t = load(`${TEX}${name}/${kind}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = maxAniso;
    if (kind === "diff") t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(k, t);
    return t;
  }
  function pbr(name, params = {}, { normal = true, rough = true, normalScale = 0.8 } = {}) {
    const m = new THREE.MeshStandardMaterial({
      map: tex(name, "diff"),
      roughnessMap: rough ? tex(name, "rough") : null,
      normalMap: normal ? tex(name, "nor") : null,
      ...params,
    });
    if (normal) m.normalScale.set(normalScale, normalScale);
    return m;
  }

  /* ---------------- material library ---------------- */
  const lib = {};
  const libMats = [];
  const detailMaps = new WeakMap(); // not userData: material.clone() JSON-copies userData
  /**
   * The low tier (software rasterisers) drops normal and roughness maps from
   * the library materials: every extra texture fetch is CPU time there.
   */
  function applyDetailMaps(full) {
    for (const m of libMats) {
      const d = detailMaps.get(m);
      if (!d) continue;
      const want = full ? d : { normalMap: null, roughnessMap: null };
      if (m.normalMap !== want.normalMap || m.roughnessMap !== want.roughnessMap) {
        m.normalMap = want.normalMap;
        m.roughnessMap = want.roughnessMap;
        m.needsUpdate = true;
      }
    }
  }
  function keep(m, surface) {
    libMats.push(m);
    detailMaps.set(m, { normalMap: m.normalMap || null, roughnessMap: m.roughnessMap || null });
    m.userData.lkSurface = surface;
    m.userData.lkEnv = m.envMapIntensity;
    return m;
  }
  lib.stoneFloor = keep(
    patchWorldUV(pbr("stone_floor", { roughness: 0.78, color: 0xd0b498, envMapIntensity: 0.32 }), 3.0, { macro: 0.2 }),
    "floor"
  );
  lib.parquet = keep(
    patchWorldUV(pbr("parquet", { roughness: 0.72, color: 0xc4b09a, envMapIntensity: 0.5 }, { rough: false }), 3.4, { macro: 0.14 }),
    "floor"
  );
  lib.terrazzo = keep(
    patchWorldUV(pbr("terrazzo", { roughness: 0.6, color: 0xd6cec2, envMapIntensity: 0.55 }, { rough: false }), 2.0, { macro: 0.1 }),
    "floor"
  );
  lib.carpet = keep(
    patchWorldUV(pbr("plaster", { roughness: 1, color: 0x4a1c26, envMapIntensity: 0.2 }, { normal: false }), 1.2, { macro: 0.18 }),
    "floor"
  );
  // plaster albedo is mid grey: the gain lets instance / paint colours read true
  const plasterOpts = { macro: 0.035, baseDarken: 0.1, gain: 1.7 };
  lib.plasterWall = keep(
    patchWorldUV(pbr("plaster", { roughness: 0.9, color: 0xffffff, envMapIntensity: 0.4 }, { normalScale: 0.35 }), 3.2, plasterOpts),
    "wall"
  );
  const paintCache = new Map();
  function paintFor(roomId, fallback) {
    const k = roomId || `#${fallback}`;
    if (paintCache.has(k)) return paintCache.get(k);
    const m = keep(
      patchWorldUV(
        pbr("plaster", { roughness: 0.9, color: paintColor(roomId, fallback), envMapIntensity: 0.4 }, { normalScale: 0.35 }),
        3.2,
        plasterOpts
      ),
      "wall"
    );
    paintCache.set(k, m);
    return m;
  }
  lib.ceiling = keep(
    patchWorldUV(pbr("plaster", { roughness: 0.95, color: 0xe4dccd, envMapIntensity: 0.5, side: THREE.DoubleSide }, { normal: false }), 4.0, {
      macro: 0.04,
      gain: 1.5,
    }),
    "ceiling"
  );
  lib.moulding = keep(
    patchWorldUV(pbr("plaster", { roughness: 0.8, color: 0xf1e9da, envMapIntensity: 0.5 }, { normalScale: 0.25 }), 3.2, { macro: 0.03, gain: 1.6 }),
    "moulding"
  );
  // open courts get a glazed daylight roof (the glazing bars come from the architecture pass)
  lib.skylight = new THREE.MeshBasicMaterial({ color: 0xcfdce6, side: THREE.DoubleSide, fog: false });
  lib.trim = keep(patchWorldUV(pbr("wood", { color: 0x8a7a6a, roughness: 0.6, envMapIntensity: 0.7 }), 1.6, { macro: 0.05 }), "trim");
  lib.plinth = keep(patchWorldUV(pbr("plinth", { color: 0x8a857c, roughness: 0.75, envMapIntensity: 0.7 }), 2.5, { macro: 0.1 }), "plinth");
  lib.wood = keep(patchWorldUV(pbr("wood", { color: 0xffffff, roughness: 0.6, envMapIntensity: 0.8 }), 1.6, { macro: 0.06 }), "wood");
  lib.wainscot = keep(patchWorldUV(pbr("wood", { color: 0xb59a80, roughness: 0.55, envMapIntensity: 0.8 }), 1.6, { macro: 0.05 }), "wood");
  lib.brass = keep(new THREE.MeshStandardMaterial({ color: 0xc8a165, metalness: 1, roughness: 0.28, envMapIntensity: 1.1 }), "metal");
  lib.steel = keep(new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 1, roughness: 0.3, envMapIntensity: 1.0 }), "metal");
  lib.blackMetal = keep(new THREE.MeshStandardMaterial({ color: 0x1a1b1d, metalness: 0.7, roughness: 0.42, envMapIntensity: 0.9 }), "metal");
  lib.housing = keep(new THREE.MeshStandardMaterial({ color: 0x2b2a28, metalness: 0.6, roughness: 0.38, envMapIntensity: 0.9 }), "metal");
  lib.velvet = keep(new THREE.MeshStandardMaterial({ color: 0x6e1a28, roughness: 0.96, envMapIntensity: 0.25 }), "fabric");
  lib.glass = keep(
    new THREE.MeshStandardMaterial({
      color: 0xdbe8ee,
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      envMapIntensity: 1.4,
    }),
    "glass"
  );

  const roomAt = typeof WORLD.roomAt === "function" ? WORLD.roomAt : () => null;
  const ROOMS = Array.isArray(WORLD.ROOMS) ? WORLD.ROOMS : [];
  const roomById = new Map(ROOMS.map((r) => [r.id, r]));
  const isPassage = (r) => !r || r.h <= 6;

  function paintColor(roomId, fallback) {
    if (roomId && PAINT[roomId] !== undefined) return PAINT[roomId];
    const r = roomById.get(roomId);
    if (r && isPassage(r)) return CORRIDOR_PAINT;
    if (fallback !== undefined) {
      const c = new THREE.Color(fallback);
      const hsl = {};
      c.getHSL(hsl);
      c.setHSL(hsl.h, Math.min(0.35, hsl.s), THREE.MathUtils.clamp(hsl.l * 2.2, 0.35, 0.7));
      return c.getHex();
    }
    return CORRIDOR_PAINT;
  }

  function floorFor(roomId) {
    if (roomId === "theater") return lib.carpet;
    if (["rotunda", "lobby", "porch"].includes(roomId)) return lib.stoneFloor;
    if (["cretaceous", "triassic", "jurassic", "marine", "predator"].includes(roomId)) return lib.parquet;
    return lib.terrazzo;
  }

  /* ---------------- classification ---------------- */
  const tmpV = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();

  function worldUp(mesh) {
    mesh.getWorldQuaternion(tmpQ);
    return tmpN.set(0, 0, 1).applyQuaternion(tmpQ).y; // planes face +Z locally
  }

  /** Best-guess surface for an untagged mesh built by an older world.js. */
  function guess(mesh) {
    const m = mesh.material;
    if (!m || Array.isArray(m) || !m.isMeshStandardMaterial) return null;
    const g = mesh.geometry && mesh.geometry.type;
    const c = hex(m);
    if (mesh.isInstancedMesh && g === "BoxGeometry") {
      if (mesh.instanceColor && mesh.count > 20) return "wall";
      if (c === 0x15191e) return "trim";
    }
    if (g === "PlaneGeometry") {
      mesh.getWorldPosition(tmpV);
      const up = worldUp(mesh);
      if (up > 0.9 && tmpV.y < 0.1) return "floor";
      if (Math.abs(up) > 0.9 && tmpV.y > 3 && c === 0x0d1116) return "ceiling";
    }
    if (c === 0x2e333a || c === 0x353b44) return "plinth";
    if (c === 0xc9a227 && m.metalness > 0.5) return "metal:brass";
    if (c === 0x5a4632 || c === 0x22262c) return "wood";
    if (c === 0x5c1f2b) return "fabric";
    if (c === 0x15181d) return "metal:black";
    if (c === 0x1b1f24 && m.emissiveIntensity > 1) return "emissive";
    return null;
  }

  const stats = { upgraded: 0, merged: 0, mergedInto: 0, fixtures: 0, lightsReplaced: 0, architecture: 0 };
  const mergeBuckets = new Map();
  const lensGeos = [];
  const haloGeos = [];

  /** A glowing cylinder near the ceiling becomes a dark can with a graded lens. */
  function fixturise(mesh) {
    const g = mesh.geometry;
    if (!g || g.type !== "CylinderGeometry" || mesh.isInstancedMesh) return false;
    mesh.getWorldPosition(tmpV);
    if (tmpV.y < 3) return false;
    const p = g.parameters || {};
    const s = new THREE.Vector3();
    mesh.getWorldScale(s);
    const rb = (p.radiusBottom || 0.5) * Math.max(s.x, s.z);
    const hh = ((p.height || 0.2) * s.y) / 2;
    if (rb > 1.5) return false;
    mesh.material = lib.housing;
    mesh.castShadow = false;
    const lens = new THREE.CircleGeometry(rb * 0.72, 24);
    lens.rotateX(Math.PI / 2); // face down
    lens.translate(tmpV.x, tmpV.y - hh - 0.004, tmpV.z);
    lensGeos.push(lens);
    const room = roomAt(tmpV.x, tmpV.z);
    const ceilY = room && room.h ? room.h - 0.012 : tmpV.y + hh + 0.15;
    const halo = new THREE.CircleGeometry(rb * 3.4, 24);
    halo.rotateX(Math.PI / 2);
    halo.translate(tmpV.x, ceilY, tmpV.z);
    haloGeos.push(halo);
    stats.fixtures++;
    return true;
  }

  function upgradeMesh(mesh) {
    if (mesh.userData.lkDone) return;
    mesh.userData.lkDone = true;
    if (mesh.isSkinnedMesh || mesh.isPoints || mesh.isLine || mesh.isSprite) return;
    const tagged = tagOf(mesh);
    let surface = tagged || guess(mesh);
    if (!surface || surface === "skip") return;
    let variant = null;
    if (surface.includes(":")) [surface, variant] = surface.split(":");
    if (surface === "metal") variant = variant || mesh.userData.metal || flagMetal(mesh) || "brass";
    const old = mesh.material;

    switch (surface) {
      case "floor": {
        mesh.getWorldPosition(tmpV);
        const room = mesh.userData.room || (roomAt(tmpV.x, tmpV.z) || {}).id || "";
        mesh.material = floorFor(room);
        mesh.receiveShadow = true;
        break;
      }
      case "ceiling": {
        const open = old && old.transparent && old.opacity < 0.9;
        mesh.material = open ? lib.skylight : lib.ceiling;
        mesh.castShadow = false;
        break;
      }
      case "wall": {
        mesh.receiveShadow = true;
        if (mesh.isInstancedMesh) {
          mesh.material = lib.plasterWall;
          paintInstances(mesh);
        } else {
          mesh.getWorldPosition(tmpV);
          const room = mesh.userData.room || (roomAt(tmpV.x, tmpV.z) || {}).id;
          mesh.material = paintFor(room, old && old.color ? old.color.getHex() : undefined);
        }
        break;
      }
      case "trim":
        mesh.material = lib.trim;
        break;
      case "plinth":
        mesh.material = lib.plinth;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        break;
      case "wood":
        mesh.material = lib.wood;
        break;
      case "metal":
        mesh.material = variant === "steel" ? lib.steel : variant === "black" ? lib.blackMetal : lib.brass;
        break;
      case "fabric":
        mesh.material = lib.velvet;
        break;
      case "glass":
        mesh.material = lib.glass;
        mesh.castShadow = false;
        break;
      case "emissive":
        mesh.castShadow = false;
        fixturise(mesh); // ceiling lamps get housings; screens/windows stay as authored
        break;
      case "image":
        // keep the authored material (world.js swaps its map when the photo
        // arrives) and just make it read as a backlit lightbox
        if (old && old.isMeshBasicMaterial) {
          old.toneMapped = false;
          old.color.setScalar(0.92);
        }
        mesh.castShadow = false;
        break;
      default:
        return;
    }
    stats.upgraded++;
    // only untagged, guessed props are merged: tagged meshes belong to code
    // that may still move, rescale or swap them
    if (
      !tagged &&
      ["plinth", "wood", "metal", "fabric"].includes(surface) &&
      !mesh.isInstancedMesh &&
      !flagUp(mesh, "dynamic") &&
      !flagUp(mesh, "noMerge")
    ) {
      const k = mesh.material.uuid + (mesh.castShadow ? "s" : "") + (mesh.receiveShadow ? "r" : "");
      if (!mergeBuckets.has(k)) mergeBuckets.set(k, []);
      mergeBuckets.get(k).push(mesh);
    }
  }
  function flagMetal(mesh) {
    for (let o = mesh; o; o = o.parent) if (o.userData && o.userData.metal) return o.userData.metal;
    return null;
  }

  /** Repaint wall instances with each hall's paint (wallData order == instance order). */
  function paintInstances(mesh) {
    if (!mesh.instanceColor) return;
    const data = typeof WORLD.buildWallData === "function" ? WORLD.buildWallData() : null;
    const c = new THREE.Color();
    for (let i = 0; i < mesh.count; i++) {
      const room = data && data.length === mesh.count ? data[i].room : null;
      if (room) c.set(paintColor(room.id, room.wall));
      else {
        mesh.getColorAt(i, c);
        c.set(paintColor(null, c.getHex()));
      }
      mesh.setColorAt(i, c);
    }
    mesh.instanceColor.needsUpdate = true;
  }

  /** Merge static props that share a material into one draw call each. */
  function mergeStatic() {
    const parent = new THREE.Group();
    parent.name = "lookdev-merged";
    for (const list of mergeBuckets.values()) {
      if (list.length < 2) continue;
      const geos = [];
      const used = [];
      for (const mesh of list) {
        const g = mesh.geometry;
        if (!g || !g.attributes.position || !g.attributes.normal || !g.attributes.uv || !g.index) continue;
        if (mesh.morphTargetInfluences) continue;
        const ng = new THREE.BufferGeometry();
        ng.setIndex(g.index.clone());
        for (const a of ["position", "normal", "uv"]) ng.setAttribute(a, g.attributes[a].clone());
        ng.applyMatrix4(mesh.matrixWorld);
        geos.push(ng);
        used.push(mesh);
      }
      if (geos.length < 2) continue;
      const merged = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mm = new THREE.Mesh(merged, used[0].material);
      mm.castShadow = used[0].castShadow;
      mm.receiveShadow = used[0].receiveShadow;
      mm.matrixAutoUpdate = false;
      mm.userData.lkDone = true;
      parent.add(mm);
      for (const m of used) m.parent && m.parent.remove(m);
      stats.merged += used.length;
      stats.mergedInto++;
    }
    mergeBuckets.clear();
    if (parent.children.length) scene.add(parent);
  }

  /* ---------------- authored light effects ---------------- */
  // world.js fakes exhibit spotlights with additive open cones. They are
  // restyled here (not by tag): half the strength, fading out within the top
  // 60% of the beam, and only one cone per spot.
  const beamTex = (() => {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 128;
    const ctx = c.getContext("2d");
    const g = ctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.3, "rgba(255,255,255,0.35)");
    g.addColorStop(0.6, "rgba(255,255,255,0)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 128);
    return new THREE.CanvasTexture(c);
  })();
  const tamedMats = new WeakSet();
  const beamSpots = [];
  function tameBeam(mesh) {
    const g = mesh.geometry;
    const m = mesh.material;
    if (!g || g.type !== "CylinderGeometry" || !(g.parameters && g.parameters.openEnded)) return;
    if (!m || !m.isMeshBasicMaterial || m.blending !== THREE.AdditiveBlending) return;
    if (!tamedMats.has(m)) {
      tamedMats.add(m);
      m.opacity *= 0.5;
      m.map = beamTex;
      m.needsUpdate = true;
    }
    mesh.getWorldPosition(tmpV);
    if (beamSpots.some((p) => Math.hypot(p.x - tmpV.x, p.z - tmpV.z) < 2.2)) {
      mesh.visible = false;
      stats.beamsHidden = (stats.beamsHidden || 0) + 1;
    } else beamSpots.push({ x: tmpV.x, z: tmpV.z });
  }

  // festoon lights (an instanced string of small emissive spheres): warm
  // filament bulbs hung on a thin dark wire instead of loose coloured dots
  function stringLights(mesh) {
    if (!mesh.isInstancedMesh || mesh.userData.lkDone || mesh.count < 8) return;
    const g = mesh.geometry;
    if (!g || g.type !== "SphereGeometry" || (g.parameters && g.parameters.radius > 0.3)) return;
    if (!mesh.material || !mesh.material.isMeshBasicMaterial) return;
    const m4 = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    const c = new THREE.Color();
    const warm = [0xffd9a0, 0xffe6bf, 0xffcf8a];
    const runs = [];
    let run = [];
    let prev = null;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m4);
      m4.premultiply(mesh.matrixWorld);
      m4.decompose(p, q, sc);
      if (prev && prev.distanceTo(p) > 4.5) {
        runs.push(run);
        run = [];
      }
      run.push(p.clone());
      prev = p.clone();
      // smaller, warm bulbs
      mesh.getMatrixAt(i, m4);
      m4.decompose(p, q, sc);
      sc.multiplyScalar(0.6);
      m4.compose(p, q, sc);
      mesh.setMatrixAt(i, m4);
      if (mesh.instanceColor) mesh.setColorAt(i, c.set(warm[i % warm.length]));
    }
    if (run.length) runs.push(run);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    const tubes = [];
    for (const r of runs) {
      if (r.length < 2) continue;
      // the wire sags slightly between bulbs and the bulbs hang just below it
      const pts = [];
      for (let i = 0; i < r.length; i++) {
        pts.push(r[i].clone().add(new THREE.Vector3(0, 0.12, 0)));
        if (i < r.length - 1) pts.push(r[i].clone().lerp(r[i + 1], 0.5).add(new THREE.Vector3(0, 0.02, 0)));
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      tubes.push(new THREE.TubeGeometry(curve, pts.length * 4, 0.012, 4, false));
    }
    if (tubes.length) {
      const wire = new THREE.Mesh(mergeGeometries(tubes, false), lib.blackMetal);
      wire.userData.lkDone = true;
      fx.add(wire);
      tubes.forEach((t) => t.dispose());
    }
    stats.stringLights = (stats.stringLights || 0) + mesh.count;
  }

  /* ---------------- scene scan ---------------- */
  function scan(root = scene) {
    root.updateMatrixWorld(true);
    const meshes = [];
    root.traverse((o) => {
      if ((o.isMesh || o.isInstancedMesh) && !o.userData.lkDone) meshes.push(o);
    });
    for (const m of meshes) {
      tameBeam(m);
      stringLights(m);
      upgradeMesh(m);
    }
    // every remaining standard material gets a sensible env response
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.isMeshStandardMaterial && m.userData.lkEnv === undefined) {
          m.userData.lkEnv = 0.6;
          m.envMapIntensity = envOn() ? 0.6 : 0;
        }
      }
    });
    flushFixtures();
    return meshes.length;
  }

  const fx = new THREE.Group();
  fx.name = "lookdev-fx";
  scene.add(fx);

  const lensMat = new THREE.MeshBasicMaterial({
    map: radialTexture([
      [0, "#fffaf0"],
      [0.45, "#ffe9c8"],
      [0.8, "#d8b689"],
      [1, "#6b5640"],
    ]),
    toneMapped: false,
  });
  const haloMat = new THREE.MeshBasicMaterial({
    map: radialTexture([
      [0, "rgba(255,228,190,0.0)"],
      [0.22, "rgba(255,228,190,0.32)"],
      [0.5, "rgba(255,220,180,0.12)"],
      [1, "rgba(255,210,170,0)"],
    ]),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  function flushFixtures() {
    if (lensGeos.length) {
      const m = new THREE.Mesh(mergeGeometries(lensGeos.splice(0), false), lensMat);
      m.userData.lkDone = true;
      fx.add(m);
    }
    if (haloGeos.length) {
      const m = new THREE.Mesh(mergeGeometries(haloGeos.splice(0), false), haloMat);
      m.userData.lkDone = true;
      m.renderOrder = 2;
      fx.add(m);
    }
  }

  /* ---------------- architecture ---------------- */
  const shaftMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uStrength: { value: 0.1 } },
    vertexShader: `
      uniform float uStrength; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 n = normalize(normalMatrix * normal);
        float f = pow(abs(dot(n, normalize(-mv.xyz))), 2.5);
        vA = f * uv.y * uv.y * uStrength;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying float vA;
      void main() { gl_FragColor = vec4(vec3(1.0, 0.95, 0.86) * vA, 1.0); }`,
  });
  const daylightMat = new THREE.MeshBasicMaterial({
    map: radialTexture([
      [0, "#fbfdff"],
      [0.6, "#e6f0f7"],
      [0.92, "#c8d8e4"],
      [1, "#8ea2b2"],
    ]),
    toneMapped: false,
  });
  const floorGlowMat = new THREE.MeshBasicMaterial({
    map: radialTexture([
      [0, "rgba(255,246,228,0.32)"],
      [0.6, "rgba(255,240,220,0.14)"],
      [1, "rgba(255,240,220,0)"],
    ]),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const archFx = [];

  function buildArchitecture() {
    if (typeof WORLD.buildWallData !== "function" || !ROOMS.length) return;
    const wood = boxBatch(lib.wainscot, "lookdev-wainscot");
    const mould = boxBatch(lib.moulding, "lookdev-moulding");
    const metal = boxBatch(lib.blackMetal, "lookdev-glazing");
    const brass = boxBatch(lib.brass, "lookdev-rail");
    const C = WORLD.CELL;
    const walls = WORLD.buildWallData();
    const r2 = (v) => Math.round(v * 100) / 100;
    const segKey = (x, z) => `${r2(x)},${r2(z)}`;
    const segs = new Set(walls.map((w) => segKey(w.x, w.z)));
    const windows = Array.isArray(WORLD.ERA_WINDOWS) ? WORLD.ERA_WINDOWS : [];
    const nearWindow = (x, z, pad) => windows.some((w) => Math.hypot(w.x - x, w.z - z) < pad);
    const pilasterDone = new Set();
    const doorDone = new Set();

    /** Box on a wall face: a = along offset, y = centre height, out = distance off the face. */
    for (const w of walls) {
      const alongX = w.sx >= w.sz;
      const L = alongX ? w.sx : w.sz;
      const T = alongX ? w.sz : w.sx;
      for (const s of [-1, 1]) {
        const px = alongX ? w.x : w.x + s * 1.2;
        const pz = alongX ? w.z + s * 1.2 : w.z;
        const room = roomAt(px, pz);
        if (!room) continue;
        const h = room.h || 6;
        const fx0 = alongX ? w.x : w.x + (s * T) / 2;
        const fz0 = alongX ? w.z + (s * T) / 2 : w.z;
        const put = (batch, a, y, out, along, height, depth) => {
          const cx = alongX ? fx0 + a : fx0 + s * out;
          const cz = alongX ? fz0 + s * out : fz0 + a;
          batch.add(cx, y, cz, alongX ? along : depth, height, alongX ? depth : along);
        };
        const theatre = room.id === "theater";
        const winHere = nearWindow(w.x, w.z, 4.6);

        // panelled wainscot, skirting and dado rail
        if (!theatre) {
          put(wood, 0, 0.6, 0.02, L, 1.2, 0.05);
          put(wood, 0, 0.09, 0.05, L, 0.18, 0.06); // skirting
          put(wood, 0, 1.19, 0.06, L + 0.02, 0.07, 0.08); // dado rail
          const n = Math.max(1, Math.round(L / 1.5));
          const pw = L / n;
          for (let i = 0; i < n; i++) {
            const a = -L / 2 + pw * (i + 0.5);
            put(wood, a, 0.66, 0.055, pw - 0.26, 0.68, 0.03); // raised field
          }
        }
        // crown moulding (stepped) at the ceiling line
        put(mould, 0, h - 0.17, 0.07, L + 0.02, 0.34, 0.14);
        put(mould, 0, h - 0.05, 0.15, L + 0.02, 0.1, 0.3);
        put(mould, 0, h - 0.4, 0.04, L + 0.02, 0.07, 0.08);
        if (!isPassage(room) && !theatre && h >= 9 && !winHere) {
          // picture rail
          put(brass, 0, 3.4, 0.03, L, 0.04, 0.04);
        }

        // pilasters at every bay line in the halls
        if (!isPassage(room) && !theatre) {
          for (const e of [-L / 2, L / 2]) {
            const ex = alongX ? w.x + e : fx0;
            const ez = alongX ? fz0 : w.z + e;
            const k = `${r2(ex)},${r2(ez)},${s},${alongX}`;
            if (pilasterDone.has(k) || (winHere && nearWindow(ex, ez, 4.4))) continue;
            pilasterDone.add(k);
            const ea = e;
            put(mould, ea, 0.65, 0.1, 0.92, 1.3, 0.2); // pedestal base
            put(mould, ea, (1.3 + h - 0.75) / 2, 0.075, 0.7, h - 0.75 - 1.3, 0.15); // shaft
            put(mould, ea, h - 0.6, 0.12, 0.96, 0.3, 0.24); // capital
          }
        }

        // door casings: a slab end whose continuation is an opening between rooms
        for (const dir of [-1, 1]) {
          const nx = alongX ? w.x + dir * C : w.x;
          const nz = alongX ? w.z : w.z + dir * C;
          if (segs.has(segKey(nx, nz))) continue;
          const a1 = alongX ? roomAt(nx, nz - 1.2) : roomAt(nx - 1.2, nz);
          const a2 = alongX ? roomAt(nx, nz + 1.2) : roomAt(nx + 1.2, nz);
          if (!a1 || !a2 || a1.id === a2.id) continue; // must be a doorway between two rooms
          const lowH = Math.min(a1.h || 6, a2.h || 6);
          const jambH = lowH - 1.3;
          const ex = alongX ? w.x + (dir * L) / 2 : w.x;
          const ez = alongX ? w.z : w.z + (dir * L) / 2;
          const jk = `${r2(ex)},${r2(ez)}`;
          if (doorDone.has(jk)) continue;
          doorDone.add(jk);
          // jamb casing wrapping the exposed wall end
          const ja = (dir * L) / 2 + dir * 0.12;
          const cx = alongX ? w.x + ja : w.x;
          const cz = alongX ? w.z : w.z + ja;
          mould.add(cx, jambH / 2, cz, alongX ? 0.3 : T + 0.24, jambH, alongX ? T + 0.24 : 0.3);
          // head casing under the lintel across the opening
          let k = 1;
          while (k < 8 && !segs.has(segKey(alongX ? w.x + dir * C * (k + 1) : w.x, alongX ? w.z : w.z + dir * C * (k + 1)))) k++;
          if (k < 8 && dir > 0) {
            const span = k * C;
            const mid = L / 2 + span / 2;
            const hx = alongX ? w.x + mid : w.x;
            const hz = alongX ? w.z : w.z + mid;
            mould.add(hx, jambH + 0.12, hz, alongX ? span : T + 0.24, 0.3, alongX ? T + 0.24 : span);
          }
        }
      }
    }

    // ceilings: coffers in the grand spaces, beams in the halls, glazing over open courts
    for (const room of ROOMS) {
      const b = roomBounds(room);
      const h = room.h || 6;
      const cx = (b.x0 + b.x1) / 2;
      const cz = (b.z0 + b.z1) / 2;
      const W = b.x1 - b.x0;
      const D = b.z1 - b.z0;
      if (room.id === "court" || room.id === "porch") {
        for (let x = b.x0 + 3; x < b.x1 - 0.5; x += 3) metal.add(x, h - 0.1, cz, 0.12, 0.2, D);
        for (let z = b.z0 + 3; z < b.z1 - 0.5; z += 3) metal.add(cx, h - 0.1, z, W, 0.2, 0.12);
        continue;
      }
      if (room.id === "theater" || isPassage(room)) continue;
      if (room.id === "rotunda" || room.id === "lobby") {
        // slimmer ribs with a fillet under each one read as moulded plaster
        // coffers rather than joists; the lower atrium gets a finer grid
        const grand = room.id === "rotunda";
        const sp = grand ? 4 : 3;
        const depth = grand ? 0.5 : 0.3;
        const rib = grand ? 0.32 : 0.22;
        const y = h - depth / 2;
        const fy = h - depth - 0.025;
        const fw = rib + 0.14;
        const holeR = room.id === "rotunda" ? 7.2 : 0;
        const lantern = room.id === "lobby" ? { hx: Math.min(20, W * 0.3), hz: Math.min(5, D * 0.22) } : null;
        const skip = (x, z) =>
          (holeR && Math.hypot(x - cx, z - cz) < holeR) ||
          (lantern && Math.abs(x - cx) < lantern.hx + 0.4 && Math.abs(z - cz) < lantern.hz + 0.4);
        for (let x = b.x0 + sp; x < b.x1 - 0.5; x += sp) {
          for (let z = b.z0; z < b.z1 - 0.01; z += sp) {
            const zc = z + sp / 2;
            if (!skip(x, zc)) {
              mould.add(x, y, zc, rib, depth, sp + rib);
              mould.add(x, fy, zc, fw, 0.05, sp + fw);
            }
          }
        }
        for (let z = b.z0 + sp; z < b.z1 - 0.5; z += sp) {
          for (let x = b.x0; x < b.x1 - 0.01; x += sp) {
            const xc = x + sp / 2;
            if (!skip(xc, z)) {
              mould.add(xc, y, z, sp + rib, depth, rib);
              mould.add(xc, fy, z, sp + fw, 0.05, fw);
            }
          }
        }
        if (holeR) {
          buildOculus(cx, cz, h, 6);
          hideOldRoofBeams(b, h);
        }
        if (lantern) buildLantern(cx, cz, h, lantern.hx, lantern.hz, metal);
        continue;
      }
      // halls: transverse beams on the bay lines + a perimeter beam
      const alongX = W >= D;
      if (alongX) {
        for (let x = b.x0 + C; x < b.x1 - 0.5; x += C) mould.add(x, h - 0.45, cz, 0.55, 0.9, D);
      } else {
        for (let z = b.z0 + C; z < b.z1 - 0.5; z += C) mould.add(cx, h - 0.45, z, W, 0.9, 0.55);
      }
    }

    for (const batch of [wood, mould, metal, brass]) {
      const m = batch.build();
      if (m) {
        fx.add(m);
        stats.architecture += m.count;
      }
    }
  }

  /**
   * world.js hangs a row of long black structural beams under the Grand
   * Gallery ceiling; the coffered ceiling replaces them (they would cut
   * straight across the oculus), so they are hidden rather than restyled.
   */
  function hideOldRoofBeams(b, h) {
    scene.traverse((o) => {
      if (!o.isMesh || o.userData.lkDone === undefined || o.parent === fx) return;
      const g = o.geometry;
      if (!g || g.type !== "BoxGeometry") return;
      const p = g.parameters || {};
      if ((p.width || 0) < 20 || (p.height || 1) > 1) return;
      o.getWorldPosition(tmpV);
      if (tmpV.y > h - 1.5 && tmpV.x > b.x0 && tmpV.x < b.x1 && tmpV.z > b.z0 && tmpV.z < b.z1) o.visible = false;
    });
  }

  function buildOculus(cx, cz, h, r) {
    const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 48), daylightMat);
    disc.rotation.x = Math.PI / 2;
    disc.position.set(cx, h - 0.03, cz);
    disc.userData.lkDone = true;
    fx.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.25, 0.32, 10, 64), lib.moulding);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(cx, h - 0.3, cz);
    ring.userData.lkDone = true;
    fx.add(ring);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(r + 0.9, 0.18, 8, 64), lib.moulding);
    ring2.rotation.x = Math.PI / 2;
    ring2.position.set(cx, h - 0.6, cz);
    ring2.userData.lkDone = true;
    fx.add(ring2);
    // muntins radiating across the glass
    const bars = boxBatch(lib.blackMetal, "lookdev-oculus-bars");
    bars.add(cx, h - 0.08, cz, r * 2, 0.12, 0.14);
    bars.add(cx, h - 0.08, cz, 0.14, 0.12, r * 2);
    const bm = bars.build();
    if (bm) fx.add(bm);
    // a slanted daylight shaft down to the floor + the patch it lights
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.95, r * 1.25, h - 0.1, 40, 1, true), shaftMat);
    shaft.position.set(cx, (h - 0.1) / 2, cz);
    shaft.userData.lkDone = true;
    shaft.userData.lkTierMin = "medium";
    shaft.renderOrder = 9;
    fx.add(shaft);
    archFx.push(shaft);
    const patch = new THREE.Mesh(new THREE.CircleGeometry(r * 1.5, 40), floorGlowMat);
    patch.rotation.x = -Math.PI / 2;
    patch.position.set(cx, 0.025, cz);
    patch.userData.lkDone = true;
    fx.add(patch);
  }

  function buildLantern(cx, cz, h, hx, hz, metal) {
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2, hz * 2), daylightMat);
    glass.rotation.x = Math.PI / 2;
    glass.position.set(cx, h - 0.03, cz);
    glass.userData.lkDone = true;
    fx.add(glass);
    for (let x = cx - hx + 2; x < cx + hx - 0.5; x += 2) metal.add(x, h - 0.1, cz, 0.1, 0.16, hz * 2);
    metal.add(cx, h - 0.1, cz, hx * 2, 0.16, 0.1);
    // deep surround
    const m = lib.moulding;
    const frame = boxBatch(m, "lookdev-lantern-frame");
    frame.add(cx, h - 0.45, cz - hz - 0.2, hx * 2 + 0.8, 0.9, 0.4);
    frame.add(cx, h - 0.45, cz + hz + 0.2, hx * 2 + 0.8, 0.9, 0.4);
    frame.add(cx - hx - 0.2, h - 0.45, cz, 0.4, 0.9, hz * 2);
    frame.add(cx + hx + 0.2, h - 0.45, cz, 0.4, 0.9, hz * 2);
    const fm = frame.build();
    if (fm) fx.add(fm);
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, h - 0.1, hz * 2), shaftMat);
    shaft.geometry.deleteAttribute("uv");
    // a box has no 0..1 height uv: synthesise one so the shaft fades towards the floor
    const pos = shaft.geometry.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) uv[i * 2 + 1] = pos.getY(i) > 0 ? 1 : 0;
    shaft.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    shaft.position.set(cx, (h - 0.1) / 2, cz);
    shaft.userData.lkDone = true;
    shaft.userData.lkTierMin = "medium";
    shaft.renderOrder = 9;
    fx.add(shaft);
    archFx.push(shaft);
  }

  /* ---------------- lights ---------------- */
  // world.js scatters ~50 accent-tinted point lights; replace them with a
  // small pool of neutral warm lights that follow the visitor.
  const anchors = [];
  const pool = [];
  let hemi = null;
  let ambient = null;
  let sun = null;
  function setupLights() {
    const remove = [];
    scene.traverse((o) => {
      if (o.isPointLight && !o.userData.lkPool && !flagUp(o, "keepLight")) {
        o.getWorldPosition(tmpV);
        const room = roomAt(tmpV.x, tmpV.z);
        anchors.push({ pos: tmpV.clone(), room: room ? room.id : null, range: o.distance || 30 });
        remove.push(o);
      }
      if (o.isHemisphereLight) hemi = hemi || o;
      if (o.isAmbientLight) ambient = ambient || o;
      if (o.isDirectionalLight && o.castShadow) sun = sun || o;
    });
    for (const l of remove) l.parent.remove(l);
    stats.lightsReplaced = remove.length;
    for (let i = 0; i < LIGHT_POOL; i++) {
      const l = new THREE.PointLight(WARM, 0, 30, 2);
      l.userData.lkPool = true;
      l.userData.anchor = -1;
      l.userData.level = 0;
      scene.add(l);
      pool.push(l);
    }
    if (sun) {
      sun.color.set(0xffe9cf);
      sun.intensity = 0.5;
      sun.shadow.bias = -0.0005;
      sun.shadow.normalBias = 0.04;
    }
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Shadows only on high and up, and only from the key light (the sun): on
   * medium / low the shadow map is neither drawn nor sampled.
   */
  let shadowsOn = null;
  function applyShadows() {
    const on = tierAtLeast("high");
    if (on === shadowsOn) return;
    const first = shadowsOn === null;
    shadowsOn = on;
    renderer.shadowMap.enabled = on;
    if (sun) sun.castShadow = on;
    renderer.shadowMap.needsUpdate = true;
    if (first) return; // nothing compiled yet
    // the shadow defines are baked into the programs: rebuild them
    scene.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
    });
  }

  let lightTimer = 0;
  const wanted = new Set();
  const scored = [];
  const free = [];
  const byScore = (a, b) => a.s - b.s;
  function updateLights(dt) {
    if (!anchors.length) return;
    lightTimer -= dt;
    const camRoom = roomAt(camera.position.x, camera.position.z);
    if (lightTimer <= 0) {
      lightTimer = 0.25;
      // reused records: no garbage four times a second
      if (scored.length !== anchors.length) {
        scored.length = 0;
        for (let i = 0; i < anchors.length; i++) scored.push({ i, s: 0 });
      }
      for (const r of scored) {
        const a = anchors[r.i];
        r.s = a.pos.distanceTo(camera.position) + (camRoom && a.room !== camRoom.id ? 18 : 0);
      }
      scored.sort(byScore);
      wanted.clear();
      for (let k = 0; k < Math.min(LIGHT_POOL, scored.length); k++) wanted.add(scored[k].i);
      free.length = 0;
      for (const i of wanted) if (!pool.some((l) => l.userData.anchor === i)) free.push(i);
      for (const l of pool) {
        if (l.userData.anchor >= 0 && !wanted.has(l.userData.anchor)) l.userData.leaving = true;
        if (l.userData.anchor < 0 && free.length) assign(l, free.shift());
      }
    }
    const k = Math.min(1, dt * 3);
    for (const l of pool) {
      const target = l.userData.leaving || l.userData.anchor < 0 ? 0 : 1;
      l.userData.level += (target - l.userData.level) * k;
      if (l.userData.leaving && l.userData.level < 0.02) {
        l.userData.leaving = false;
        l.userData.anchor = -1;
        l.userData.level = 0;
      }
      l.intensity = l.userData.level * (l.userData.peak || 0);
    }
  }
  function assign(l, i) {
    const a = anchors[i];
    l.userData.anchor = i;
    l.userData.leaving = false;
    l.position.copy(a.pos);
    l.position.y = Math.max(3.5, a.pos.y - 2.2);
    l.distance = Math.max(24, a.range * 1.1);
    l.userData.peak = 150;
  }

  /* ---------------- environment ---------------- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTex = null;
  function envOn() {
    return tierAtLeast("medium");
  }
  let envRequested = false;
  let envSettled = null;
  /**
   * Resolves once the environment the first frame will use is in place:
   * the HDRI, or the RoomEnvironment fallback if it fails or takes > 4 s.
   * (The two PMREMs differ in size, and every standard material's shader
   * depends on it: compiling before the HDRI arrived compiled them twice.)
   */
  const envReady = new Promise((r) => (envSettled = r));
  /** PMREM work only happens once a tier that uses reflections is active. */
  function setupEnvironment() {
    if (envRequested || !envOn()) {
      applyEnv();
      if (!envOn()) envSettled();
      return;
    }
    envRequested = true;
    let fallbackTimer = 0;
    const fallback = () => {
      clearTimeout(fallbackTimer);
      if (envTex) return;
      envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
      applyEnv();
      envSettled();
    };
    fallbackTimer = setTimeout(fallback, 4000);
    new RGBELoader().load(
      HDRI,
      (hdr) => {
        clearTimeout(fallbackTimer);
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const rt = pmrem.fromEquirectangular(hdr);
        hdr.dispose();
        const prev = envTex;
        envTex = rt.texture;
        applyEnv();
        if (prev) prev.dispose();
        envSettled();
      },
      undefined,
      fallback
    );
  }
  function applyEnv() {
    const on = envOn();
    scene.environment = on ? envTex : null;
    applyDetailMaps(on);
    scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.isMeshStandardMaterial && m.userData.lkEnv !== undefined) m.envMapIntensity = on ? m.userData.lkEnv : 0;
      }
    });
    // without the HDRI the hemisphere/ambient pair has to carry the fill light
    if (hemi) hemi.intensity = on ? 0.15 : 1.1;
    if (ambient) ambient.intensity = on ? 0.0 : 0.55;
  }

  /* ---------------- atmosphere ---------------- */
  const fogBase = new THREE.Color(0x2a241e);
  const fogTarget = new THREE.Color();
  const fog = new THREE.FogExp2(fogBase.getHex(), 0.0045);
  scene.fog = fog;
  if (!scene.background || scene.background.isColor) scene.background = new THREE.Color(0x15120f);
  const accentTmp = new THREE.Color();
  function updateFog(dt) {
    const r = roomAt(camera.position.x, camera.position.z);
    fogTarget.copy(fogBase);
    if (r && r.accent !== undefined) fogTarget.lerp(accentTmp.set(r.accent), 0.04);
    fog.color.lerp(fogTarget, Math.min(1, dt * 1.5));
    if (scene.background && scene.background.isColor) scene.background.copy(fog.color).multiplyScalar(0.6);
  }

  function applyFxVisibility() {
    for (const o of archFx) o.visible = !o.userData.lkTierMin || tierAtLeast(o.userData.lkTierMin);
  }

  /* ---------------- post-processing ---------------- */
  let composer = null;
  let bloom = null;
  let grade = null;
  const GradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uVignette: { value: 0.28 },
      uGrain: { value: 0.025 },
    },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform float uTime; uniform float uVignette; uniform float uGrain; varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        vec2 d = vUv - 0.5;
        float v = smoothstep(0.85, 0.2, length(d * vec2(1.15, 1.0)));
        c.rgb *= mix(1.0 - uVignette, 1.0, v);
        float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        c.rgb += vec3(0.010, 0.005, -0.006) * l - vec3(0.003, 0.0, -0.005) * (1.0 - l);
        c.rgb += (h(vUv * 1000.0 + fract(uTime)) - 0.5) * uGrain;
        gl_FragColor = c;
      }`,
  };
  let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  function size() {
    const v = new THREE.Vector2();
    renderer.getSize(v);
    return v;
  }
  function buildComposer() {
    disposeComposer();
    if (!tierAtLeast("high")) return;
    const s = size();
    const rt = new THREE.WebGLRenderTarget(s.x * pixelRatio, s.y * pixelRatio, {
      type: THREE.HalfFloatType,
      samples: isWebGL2 ? 4 : 0,
    });
    composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(pixelRatio);
    composer.setSize(s.x, s.y);
    composer.addPass(new RenderPass(scene, camera));
    if (tierAtLeast("ultra")) {
      const gtao = new GTAOPass(scene, camera, s.x, s.y);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.8;
      gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1, thickness: 1, scale: 1 });
      composer.addPass(gtao);
    }
    bloom = new UnrealBloomPass(new THREE.Vector2(s.x, s.y), 0.25, 0.4, 0.9);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    if (!isWebGL2) composer.addPass(new SMAAPass(s.x * pixelRatio, s.y * pixelRatio));
    grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
  }
  function disposeComposer() {
    if (!composer) return;
    for (const p of composer.passes) p.dispose && p.dispose();
    composer.renderTarget1.dispose();
    composer.renderTarget2.dispose();
    composer = bloom = grade = null;
  }

  /* ---------------- setup ---------------- */
  setupLights();
  scan();
  mergeStatic();
  buildArchitecture();
  setupEnvironment();
  applyFxVisibility();
  applyShadows();
  renderer.setPixelRatio(tierAtLeast("high") ? pixelRatio : Math.min(window.devicePixelRatio || 1, 1.25));
  buildComposer();
  renderer.shadowMap.needsUpdate = true;

  /* ---------------- per-frame ---------------- */
  let last = performance.now();
  let elapsed = 0;
  let rescanTimer = 2;
  let rescans = 0;
  let slow = 0;
  let frameEMA = 16;
  function render() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    elapsed += dt;

    // late-arriving meshes (async models, props) get upgraded too
    rescanTimer -= dt;
    if (rescanTimer <= 0 && rescans < 20) {
      rescanTimer = 3;
      rescans++;
      if (scan()) {
        mergeStatic();
        renderer.shadowMap.needsUpdate = true;
      }
    }

    updateLights(dt);
    updateFog(dt);

    if (composer) {
      if (grade) grade.uniforms.uTime.value = elapsed;
      composer.render(dt);
    } else {
      renderer.render(scene, camera);
    }

    // adaptive quality (auto only): trade pixel ratio, then post, for frame time
    // (skipped while shaders compile and textures upload right after boot)
    // (held while main.js renders only some frames, e.g. behind the join screen)
    if (api.hold) {
      frameEMA = 16;
      slow = 0;
    } else if (auto && dt > 0 && elapsed > 8) {
      frameEMA += (dt * 1000 - frameEMA) * 0.05;
      if (frameEMA > 18 && document.visibilityState === "visible") slow += dt;
      else slow = Math.max(0, slow - dt * 0.5);
      if (slow > 2) {
        slow = 0;
        if (tierAtLeast("high") && pixelRatio > 1) {
          pixelRatio = 1;
          renderer.setPixelRatio(1);
          const s = size();
          if (composer) {
            composer.setPixelRatio(1);
            composer.setSize(s.x, s.y);
          }
        } else if (tier === "high" && frameEMA > 33) {
          setTier("medium");
        } else if (tier === "medium" && frameEMA > 45) {
          setTier("low");
        }
        frameEMA = 16;
      }
    }
  }

  function resize(w, h) {
    renderer.setSize(w, h);
    if (composer) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    }
  }

  /**
   * A tier picked by the visitor (or "auto"): a manual pick stops the
   * adaptation. { manual: false } is a governor's step that keeps auto on.
   */
  function setQuality(q, { manual = true } = {}) {
    if (manual && (q === "auto" || TIERS.includes(q))) auto = q === "auto";
    setTier(q);
  }

  function setTier(q) {
    const next = q === "auto" ? (gpu.software ? "low" : "high") : q;
    if (!TIERS.includes(next) || next === tier) return;
    tier = next;
    setupEnvironment();
    applyFxVisibility();
    applyShadows();
    renderer.setPixelRatio(tierAtLeast("high") ? pixelRatio : Math.min(window.devicePixelRatio || 1, 1.25));
    buildComposer();
    api.composer = composer;
  }

  const api = {
    composer,
    /** true: do not adapt the tier to the frame time for now */
    hold: false,
    envReady,
    /**
     * Compile the scene's shaders without blocking (KHR_parallel_shader_compile).
     * With a composer the scene is drawn into a render target, and the
     * programs differ from on-screen ones (no tone mapping, linear output),
     * so compile them for that target.
     */
    compileAsync() {
      if (typeof renderer.compileAsync !== "function") return Promise.resolve();
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(composer ? composer.renderTarget1 : null);
      try {
        return renderer.compileAsync(scene, camera);
      } finally {
        renderer.setRenderTarget(prev);
      }
    },
    get quality() {
      return tier;
    },
    get auto() {
      return auto;
    },
    render,
    resize,
    setQuality,
    refresh() {
      const n = scan();
      mergeStatic();
      renderer.shadowMap.needsUpdate = true;
      return n;
    },
    stats() {
      return { tier, gpu: gpu.name, pixelRatio: renderer.getPixelRatio(), frameMs: +frameEMA.toFixed(1), ...stats };
    },
  };
  return api;
}
