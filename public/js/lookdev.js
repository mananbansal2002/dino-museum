/**
 * Look development: turns the blocky prototype museum into a lit, textured
 * natural-history interior. It runs AFTER buildWorld() and never edits
 * world.js. Instead it walks the scene and upgrades meshes either by tag
 * (mesh.userData.surface, or a tag on any ancestor group) or by the
 * recognisable traits world.js builds them with today.
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
 * Quality tiers: "low" (SwiftShader & co: textures only, no env / post /
 * particles), "medium" (+ HDRI reflections, dust, light cones), "high"
 * (+ MSAA composer, bloom, vignette/grain), "ultra" (+ GTAO). "auto" picks
 * low on software rasterisers and high elsewhere, and adapts pixel ratio
 * and tier to the measured frame time. `?lookdev=off|low|medium|high|ultra`
 * overrides everything.
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

function radialTexture(stops) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (const [t, col] of stops) g.addColorStop(t, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ------------------------------------------------------------------ */
/* world-space UV shader patch                                          */
/* ------------------------------------------------------------------ */
/*
 * Boxes in world.js are unit cubes scaled per instance and planes carry
 * 0..1 UVs, so textures would stretch. This patch projects the maps from
 * world position along the dominant world normal axis (box-projected
 * "triplanar-lite"), adds a low frequency colour variation that hides
 * tiling, and optionally darkens surfaces near the floor (contact AO).
 */
function patchWorldUV(mat, metersPerRepeat, { macro = 0.12, baseDarken = 0, offset = [0, 0] } = {}) {
  const s = (1 / metersPerRepeat).toFixed(5);
  const key = `lk-wuv-${s}-${macro}-${baseDarken}-${offset.join(",")}`;
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
          diffuseColor.rgb *= 1.0 + (n - 0.5) * ${macro.toFixed(3)};
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

export function applyLookdev({ renderer, scene, camera, quality = "auto" } = {}) {
  const override = urlOverride();
  if (override === "off") {
    return {
      composer: null,
      quality: "off",
      render: () => renderer.render(scene, camera),
      resize: (w, h) => renderer.setSize(w, h),
      setQuality: () => {},
      refresh: () => {},
      stats: () => ({ quality: "off" }),
    };
  }
  const gpu = detectSoftware(renderer);
  const requested = override && TIERS.includes(override) ? override : quality;
  const auto = requested === "auto";
  let tier = auto ? (gpu.software ? "low" : "high") : TIERS.includes(requested) ? requested : "high";
  const tierAtLeast = (t) => TIERS.indexOf(tier) >= TIERS.indexOf(t);
  const maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());
  const isWebGL2 = renderer.capabilities.isWebGL2;

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  /* ---------------- textures ---------------- */
  const loader = new THREE.TextureLoader();
  const texCache = new Map();
  function tex(name, kind) {
    const k = `${name}/${kind}`;
    if (texCache.has(k)) return texCache.get(k);
    const t = loader.load(`${TEX}${name}/${kind}.jpg`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = maxAniso;
    if (kind === "diff") t.colorSpace = THREE.SRGBColorSpace;
    texCache.set(k, t);
    return t;
  }
  function pbr(name, params = {}, { normal = true } = {}) {
    const m = new THREE.MeshStandardMaterial({
      map: tex(name, "diff"),
      roughnessMap: tex(name, "rough"),
      normalMap: normal ? tex(name, "nor") : null,
      ...params,
    });
    if (normal && params.normalScale === undefined) m.normalScale.set(0.8, 0.8);
    return m;
  }

  /* ---------------- material library ---------------- */
  const lib = {};
  const surfaceMats = new Set();
  function keep(m, surface) {
    m.userData.lkSurface = surface;
    m.userData.lkEnv = m.envMapIntensity;
    surfaceMats.add(m);
    return m;
  }
  lib.stoneFloor = keep(patchWorldUV(pbr("stone_floor", { roughness: 0.62, color: 0xe6ddd0, envMapIntensity: 0.75 }), 3.0, { macro: 0.1 }), "floor");
  lib.parquet = keep(patchWorldUV(pbr("parquet", { roughness: 0.72, color: 0xcdb9a2, envMapIntensity: 0.5 }), 3.4, { macro: 0.14 }), "floor");
  lib.parquet.roughnessMap = null; // the source map is glossier than museum-grade satin lacquer
  lib.terrazzo = keep(patchWorldUV(pbr("terrazzo", { roughness: 0.55, color: 0xe8e0d4, envMapIntensity: 0.6 }), 2.0, { macro: 0.08 }), "floor");
  lib.terrazzo.roughnessMap = null;
  lib.carpet = keep(patchWorldUV(pbr("plaster", { roughness: 1, color: 0x4a1c26, envMapIntensity: 0.2 }, { normal: false }), 1.2, { macro: 0.18 }), "floor");
  lib.plasterWall = keep(
    patchWorldUV(pbr("plaster", { roughness: 0.92, color: 0xffffff, envMapIntensity: 0.45 }), 3.2, { macro: 0.1, baseDarken: 0.28 }),
    "wall"
  );
  lib.ceiling = keep(
    patchWorldUV(pbr("plaster", { roughness: 0.95, color: 0xa39a8c, envMapIntensity: 0.5, side: THREE.DoubleSide }, { normal: false }), 4.0, {
      macro: 0.08,
    }),
    "ceiling"
  );
  lib.skylight = keep(
    new THREE.MeshStandardMaterial({
      color: 0xdfe9ef,
      roughness: 0.08,
      metalness: 0,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: THREE.DoubleSide,
      envMapIntensity: 1.2,
    }),
    "ceiling"
  );
  lib.trim = keep(patchWorldUV(pbr("plinth", { color: 0x2a2724, roughness: 0.55, envMapIntensity: 0.9 }), 1.5, { macro: 0.05 }), "trim");
  lib.plinth = keep(patchWorldUV(pbr("plinth", { color: 0x8a857c, roughness: 0.75, envMapIntensity: 0.7 }), 2.5, { macro: 0.1 }), "plinth");
  lib.wood = keep(patchWorldUV(pbr("wood", { color: 0xffffff, roughness: 0.62, envMapIntensity: 0.8 }), 1.6, { macro: 0.06 }), "wood");
  lib.brass = keep(new THREE.MeshStandardMaterial({ color: 0xc8a165, metalness: 1, roughness: 0.28, envMapIntensity: 1.1 }), "metal");
  lib.steel = keep(new THREE.MeshStandardMaterial({ color: 0xb8bcc2, metalness: 1, roughness: 0.3, envMapIntensity: 1.0 }), "metal");
  lib.blackMetal = keep(new THREE.MeshStandardMaterial({ color: 0x1a1b1d, metalness: 0.7, roughness: 0.42, envMapIntensity: 0.9 }), "metal");
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

  const floorMatCache = new Map();
  function floorFor(roomId) {
    if (floorMatCache.has(roomId)) return floorMatCache.get(roomId);
    let base;
    if (roomId === "theater") base = lib.carpet;
    else if (["rotunda", "lobby", "porch"].includes(roomId)) base = lib.stoneFloor;
    else if (["cretaceous", "triassic", "jurassic", "marine", "predator"].includes(roomId)) base = lib.parquet;
    else base = lib.terrazzo;
    floorMatCache.set(roomId, base);
    return base;
  }

  /* ---------------- classification ---------------- */
  const roomAt = typeof WORLD.roomAt === "function" ? WORLD.roomAt : () => null;
  const ROOMS = Array.isArray(WORLD.ROOMS) ? WORLD.ROOMS : [];
  const tmpV = new THREE.Vector3();
  const tmpN = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();

  function worldUp(mesh) {
    mesh.getWorldQuaternion(tmpQ);
    return tmpN.set(0, 0, 1).applyQuaternion(tmpQ).y; // planes face +Z locally
  }

  /** Best-guess surface for an untagged mesh built by today's world.js. */
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
      if (up > 0.9 && tmpV.y < 0.1 && m.map) return "floor";
      if (Math.abs(up) > 0.9 && tmpV.y > 3 && c === 0x0d1116) return "ceiling";
    }
    if (c === 0x2e333a || c === 0x353b44) return "plinth";
    if (c === 0xc9a227 && m.metalness > 0.5) return "metal:brass";
    if (c === 0x5a4632 || c === 0x22262c) return "wood";
    if (c === 0x5c1f2b) return "fabric";
    if (c === 0x15181d) return "metal:black";
    if (c === 0x8b8b8b || c === 0xd8d3c4) return "metal:steel";
    if (c === 0x1b1f24 && m.emissiveIntensity > 1) return "fixture";
    return null;
  }

  const stats = { upgraded: 0, merged: 0, mergedInto: 0, plinths: 0, lightsReplaced: 0 };
  const plinthBoxes = [];
  const wallMeshes = [];
  const mergeBuckets = new Map();

  function upgradeMesh(mesh) {
    if (mesh.userData.lkDone) return;
    mesh.userData.lkDone = true;
    if (mesh.isSkinnedMesh || mesh.isPoints || mesh.isLine || mesh.isSprite) return;
    let surface = tagOf(mesh) || guess(mesh);
    if (!surface || surface === "skip") return;
    let variant = null;
    if (surface.includes(":")) [surface, variant] = surface.split(":");
    if (surface === "metal") variant = variant || mesh.userData.metal || "brass";
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
        mesh.material = lib.plasterWall;
        mesh.receiveShadow = true;
        if (mesh.isInstancedMesh) {
          if (mesh.instanceColor) {
            const c = new THREE.Color();
            const hsl = {};
            const warm = new THREE.Color(0xeee3d0);
            for (let i = 0; i < mesh.count; i++) {
              mesh.getColorAt(i, c);
              c.getHSL(hsl);
              c.setHSL(hsl.h, Math.min(0.45, hsl.s * 0.8), THREE.MathUtils.clamp(hsl.l * 2.4, 0.34, 0.7));
              c.lerp(warm, 0.32);
              mesh.setColorAt(i, c);
            }
            mesh.instanceColor.needsUpdate = true;
          }
          wallMeshes.push(mesh);
        }
        break;
      }
      case "trim":
        mesh.material = lib.trim;
        break;
      case "plinth": {
        mesh.material = lib.plinth;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const g = mesh.geometry;
        if (!mesh.isInstancedMesh && g) {
          if (!g.boundingBox) g.computeBoundingBox();
          const b = g.boundingBox.clone().applyMatrix4(mesh.matrixWorld);
          const sx = b.max.x - b.min.x;
          const sz = b.max.z - b.min.z;
          const sy = b.max.y - b.min.y;
          // exhibit pedestals: roughly square, knee height or lower, >= 2 m
          if (sx >= 2 && sz >= 2 && sy < 1.6 && Math.max(sx, sz) / Math.min(sx, sz) < 2.2) {
            plinthBoxes.push(b);
          }
        }
        break;
      }
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
      case "fixture": {
        const m = old.clone();
        const accent = old.emissive.clone();
        m.emissive.copy(WARM).lerp(accent, 0.25);
        m.emissiveIntensity = 3.2;
        m.color.set(0x2a2622);
        m.metalness = 0.6;
        m.roughness = 0.35;
        mesh.material = m;
        break;
      }
      case "emissive":
        mesh.castShadow = false;
        break; // leave as authored; bloom picks it up
      case "image": {
        const m = old;
        if (m && m.map) {
          mesh.material = new THREE.MeshBasicMaterial({
            map: m.map,
            color: 0xeeeeee,
            toneMapped: false,
            transparent: m.transparent,
            side: m.side,
          });
        }
        mesh.castShadow = false;
        break;
      }
      default:
        return;
    }
    stats.upgraded++;
    if (
      mergeOk &&
      ["plinth", "wood", "metal", "fabric", "trim"].includes(surface) &&
      !mesh.isInstancedMesh &&
      !flagUp(mesh, "dynamic") &&
      !flagUp(mesh, "noMerge")
    ) {
      const k = mesh.material.uuid + (mesh.castShadow ? "s" : "") + (mesh.receiveShadow ? "r" : "");
      if (!mergeBuckets.has(k)) mergeBuckets.set(k, []);
      mergeBuckets.get(k).push(mesh);
    }
  }
  let mergeOk = true;

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
      mm.userData.surface = used[0].material.userData.lkSurface;
      parent.add(mm);
      for (const m of used) {
        m.parent && m.parent.remove(m);
      }
      stats.merged += used.length;
      stats.mergedInto++;
    }
    mergeBuckets.clear();
    if (parent.children.length) scene.add(parent);
  }

  /* ---------------- scene scan ---------------- */
  function scan(root = scene) {
    root.updateMatrixWorld(true);
    const meshes = [];
    root.traverse((o) => {
      if ((o.isMesh || o.isInstancedMesh) && !o.userData.lkDone) meshes.push(o);
    });
    for (const m of meshes) upgradeMesh(m);
    // every remaining standard material gets a sensible env response
    root.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m.isMeshStandardMaterial && m.userData.lkEnv === undefined) {
          m.userData.lkEnv = 0.6;
          m.envMapIntensity = envScale() * 0.6;
        }
      }
    });
    return meshes.length;
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
      sun.intensity = 0.55;
      sun.shadow.bias = -0.0005;
      sun.shadow.normalBias = 0.04;
    }
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
  }

  let lightTimer = 0;
  const wanted = new Set();
  function updateLights(dt) {
    if (!anchors.length) return;
    lightTimer -= dt;
    const camRoom = roomAt(camera.position.x, camera.position.z);
    if (lightTimer <= 0) {
      lightTimer = 0.25;
      const scored = anchors.map((a, i) => {
        const d = a.pos.distanceTo(camera.position);
        return { i, s: d + (camRoom && a.room !== camRoom.id ? 18 : 0) };
      });
      scored.sort((a, b) => a.s - b.s);
      wanted.clear();
      for (let k = 0; k < Math.min(LIGHT_POOL, scored.length); k++) wanted.add(scored[k].i);
      const free = [...wanted].filter((i) => !pool.some((l) => l.userData.anchor === i));
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
      l.intensity = l.userData.level * l.userData.peak || 0;
    }
  }
  function assign(l, i) {
    const a = anchors[i];
    l.userData.anchor = i;
    l.userData.leaving = false;
    l.position.copy(a.pos);
    l.position.y = Math.max(3.5, a.pos.y - 2.2);
    l.distance = Math.max(24, a.range * 1.1);
    l.userData.peak = 160;
  }

  /* ---------------- environment ---------------- */
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envTex = null;
  function envScale() {
    return tierAtLeast("medium") ? 1 : 0;
  }
  function setupEnvironment() {
    const room = pmrem.fromScene(new RoomEnvironment(renderer), 0.04);
    envTex = room.texture;
    applyEnv();
    new RGBELoader().load(
      HDRI,
      (hdr) => {
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const rt = pmrem.fromEquirectangular(hdr);
        hdr.dispose();
        const prev = envTex;
        envTex = rt.texture;
        applyEnv();
        if (prev) prev.dispose();
      },
      undefined,
      () => {
        /* keep the RoomEnvironment fallback */
      }
    );
  }
  function applyEnv() {
    const on = tierAtLeast("medium");
    scene.environment = on ? envTex : null;
    scene.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.isMeshStandardMaterial && m.userData.lkEnv !== undefined) m.envMapIntensity = m.userData.lkEnv * (on ? 1 : 0);
      }
    });
    // without the HDRI the hemisphere/ambient pair has to carry the fill light
    if (hemi) hemi.intensity = on ? 0.15 : 1.1;
    if (ambient) ambient.intensity = on ? 0.0 : 0.55;
  }

  /* ---------------- atmosphere ---------------- */
  const fogBase = new THREE.Color(0x231e19);
  const fogTarget = new THREE.Color();
  const fog = new THREE.FogExp2(fogBase.getHex(), 0.0075);
  scene.fog = fog;
  if (!scene.background || scene.background.isColor) scene.background = new THREE.Color(0x15120f);
  function updateFog(dt) {
    const r = roomAt(camera.position.x, camera.position.z);
    fogTarget.copy(fogBase);
    if (r && r.accent !== undefined) fogTarget.lerp(new THREE.Color(r.accent), 0.12);
    fog.color.lerp(fogTarget, Math.min(1, dt * 1.5));
    if (scene.background && scene.background.isColor) scene.background.copy(fog.color).multiplyScalar(0.6);
  }

  const fx = new THREE.Group();
  fx.name = "lookdev-fx";
  scene.add(fx);

  // dust motes drifting through the big halls
  const dustUniforms = { uTime: { value: 0 }, uScale: { value: 1 } };
  function buildDust() {
    const pos = [];
    const seed = [];
    for (const r of ROOMS) {
      if (!r.h || r.h < 9) continue;
      const x0 = WORLD.g2w(r.cols[0]) - WORLD.CELL / 2;
      const x1 = WORLD.g2w(r.cols[1]) + WORLD.CELL / 2;
      const z0 = WORLD.g2z(r.rows[0]) - WORLD.CELL / 2;
      const z1 = WORLD.g2z(r.rows[1]) + WORLD.CELL / 2;
      const n = Math.min(450, Math.round(((x1 - x0) * (z1 - z0)) / 7));
      for (let i = 0; i < n; i++) {
        pos.push(x0 + Math.random() * (x1 - x0), 0.6 + Math.random() * (r.h - 1.2), z0 + Math.random() * (z1 - z0));
        seed.push(Math.random() * 100);
      }
    }
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("seed", new THREE.Float32BufferAttribute(seed, 1));
    const m = new THREE.ShaderMaterial({
      uniforms: dustUniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute float seed; uniform float uTime; uniform float uScale; varying float vA;
        void main() {
          vec3 p = position;
          float t = uTime * 0.05 + seed;
          p.x += sin(t * 1.3 + seed) * 0.8; p.z += cos(t * 1.1 + seed * 2.0) * 0.8; p.y += sin(t * 0.7) * 0.6;
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          float d = -mv.z;
          vA = smoothstep(26.0, 6.0, d) * smoothstep(0.4, 1.5, d) * (0.5 + 0.5 * sin(uTime * 0.6 + seed * 7.0));
          gl_PointSize = uScale * 26.0 / max(d, 0.5);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5; float a = smoothstep(0.5, 0.0, length(c));
          gl_FragColor = vec4(vec3(1.0, 0.9, 0.75) * a * vA * 0.55, 1.0);
        }`,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.userData.lkDone = true;
    pts.renderOrder = 10;
    return pts;
  }

  // light cones + floor pools over each exhibit plinth (fake spotlights)
  const poolTex = radialTexture([
    [0, "rgba(255,226,190,0.7)"],
    [0.45, "rgba(255,214,170,0.3)"],
    [1, "rgba(255,200,150,0)"],
  ]);
  function buildExhibitLights() {
    if (!plinthBoxes.length) return [];
    const cones = [];
    const pools = [];
    for (const b of plinthBoxes) {
      const cx = (b.min.x + b.max.x) / 2;
      const cz = (b.min.z + b.max.z) / 2;
      const w = Math.max(b.max.x - b.min.x, b.max.z - b.min.z);
      const room = roomAt(cx, cz);
      const top = room && room.h ? room.h - 0.3 : 9.5;
      const bottom = b.max.y + 0.05;
      const h = top - bottom;
      const cg = new THREE.CylinderGeometry(0.35, w * 0.62, h, 24, 1, true);
      cg.translate(cx, bottom + h / 2, cz);
      // vertex alpha: brighter near the fixture, fading towards the plinth
      const p = cg.attributes.position;
      const col = new Float32Array(p.count * 4);
      for (let i = 0; i < p.count; i++) {
        const t = (p.getY(i) - bottom) / h;
        col.set([1, 0.88, 0.72, 0.03 + 0.11 * t], i * 4);
      }
      cg.setAttribute("color", new THREE.BufferAttribute(col, 4));
      cones.push(cg);
      const pg = new THREE.PlaneGeometry(w * 2.1, w * 2.1);
      pg.rotateX(-Math.PI / 2);
      pg.translate(cx, 0.02, cz);
      pools.push(pg);
      // fixture disc in the ceiling
    }
    const out = [];
    const coneMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: `
        attribute vec4 color; varying vec4 vC; varying float vF;
        void main() {
          vC = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 n = normalize(normalMatrix * normal);
          vF = pow(abs(dot(n, normalize(-mv.xyz))), 2.2);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec4 vC; varying float vF;
        void main() { gl_FragColor = vec4(vC.rgb * vC.a * vF * 0.5, 1.0); }`,
    });
    const cone = new THREE.Mesh(mergeGeometries(cones, false), coneMat);
    cone.userData.lkDone = true;
    cone.userData.lkTierMin = "medium";
    cone.renderOrder = 9;
    out.push(cone);
    const poolMat = new THREE.MeshBasicMaterial({
      map: poolTex,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      fog: true,
    });
    const poolMesh = new THREE.Mesh(mergeGeometries(pools, false), poolMat);
    poolMesh.userData.lkDone = true;
    out.push(poolMesh);
    cones.forEach((g) => g.dispose());
    pools.forEach((g) => g.dispose());
    stats.plinths = plinthBoxes.length;
    plinthBoxes.length = 0;
    return out;
  }

  // soft contact shadow strips on the floor along every wall base
  function buildContactStrips() {
    if (!wallMeshes.length) return null;
    const pos = [];
    const col = [];
    const idx = [];
    const m4 = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const W = 0.75;
    const quad = (ax, az, bx, bz, ox, oz) => {
      const i = pos.length / 3;
      pos.push(ax, 0.014, az, bx, 0.014, bz, bx + ox * W, 0.014, bz + oz * W, ax + ox * W, 0.014, az + oz * W);
      col.push(0, 0, 0, 0.42, 0, 0, 0, 0.42, 0, 0, 0, 0, 0, 0, 0, 0);
      idx.push(i, i + 2, i + 1, i, i + 3, i + 2);
    };
    for (const mesh of wallMeshes) {
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, m4);
        m4.premultiply(mesh.matrixWorld);
        m4.decompose(p, q, s);
        const hx = s.x / 2;
        const hz = s.z / 2;
        if (s.x >= s.z) {
          quad(p.x - hx, p.z - hz, p.x + hx, p.z - hz, 0, -1);
          quad(p.x + hx, p.z + hz, p.x - hx, p.z + hz, 0, 1);
        } else {
          quad(p.x - hx, p.z + hz, p.x - hx, p.z - hz, -1, 0);
          quad(p.x + hx, p.z - hz, p.x + hx, p.z + hz, 1, 0);
        }
      }
    }
    wallMeshes.length = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4));
    g.setIndex(idx);
    const m = new THREE.MeshBasicMaterial({
      color: 0x000000,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    // vertex colour alpha carries the fade; black rgb keeps it a darkening
    const strip = new THREE.Mesh(g, m);
    strip.userData.lkDone = true;
    strip.renderOrder = 1;
    return strip;
  }

  let dust = null;
  const exhibitFx = [];
  function buildFx() {
    if (!dust) {
      dust = buildDust();
      if (dust) fx.add(dust);
    }
    for (const o of buildExhibitLights()) {
      exhibitFx.push(o);
      fx.add(o);
    }
    const strips = buildContactStrips();
    if (strips) fx.add(strips);
    applyFxVisibility();
  }
  function applyFxVisibility() {
    if (dust) dust.visible = tierAtLeast("medium");
    for (const o of exhibitFx) o.visible = !o.userData.lkTierMin || tierAtLeast(o.userData.lkTierMin);
  }

  /* ---------------- post-processing ---------------- */
  let composer = null;
  let bloom = null;
  let gtao = null;
  let smaa = null;
  let grade = null;
  const GradeShader = {
    uniforms: {
      tDiffuse: { value: null },
      uTime: { value: 0 },
      uVignette: { value: 0.32 },
      uGrain: { value: 0.035 },
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
        // gentle warm highlights / cool shadows split tone
        float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
        c.rgb += (vec3(0.012, 0.006, -0.008) * l - vec3(0.004, 0.0, -0.006) * (1.0 - l));
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
      gtao = new GTAOPass(scene, camera, s.x, s.y);
      gtao.output = GTAOPass.OUTPUT.Default;
      gtao.blendIntensity = 0.8;
      gtao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1, thickness: 1, scale: 1 });
      composer.addPass(gtao);
    }
    bloom = new UnrealBloomPass(new THREE.Vector2(s.x, s.y), 0.25, 0.4, 0.9);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
    if (!isWebGL2) {
      smaa = new SMAAPass(s.x * pixelRatio, s.y * pixelRatio);
      composer.addPass(smaa);
    }
    grade = new ShaderPass(GradeShader);
    composer.addPass(grade);
  }
  function disposeComposer() {
    if (!composer) return;
    for (const p of composer.passes) p.dispose && p.dispose();
    composer.renderTarget1.dispose();
    composer.renderTarget2.dispose();
    composer = bloom = gtao = smaa = grade = null;
  }

  /* ---------------- setup ---------------- */
  setupLights();
  scan();
  if (mergeOk) mergeStatic();
  setupEnvironment();
  buildFx();
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

    // late-arriving meshes (async models, panels) get upgraded too
    rescanTimer -= dt;
    if (rescanTimer <= 0 && rescans < 20) {
      rescanTimer = 3;
      rescans++;
      const n = scan();
      if (n) {
        if (mergeOk) mergeStatic();
        buildFx();
        renderer.shadowMap.needsUpdate = true;
      }
    }

    updateLights(dt);
    updateFog(dt);
    dustUniforms.uTime.value = elapsed;
    dustUniforms.uScale.value = renderer.getPixelRatio() * (renderer.domElement.height / renderer.getPixelRatio() / 800);

    if (composer) {
      if (grade) grade.uniforms.uTime.value = elapsed;
      composer.render(dt);
    } else {
      renderer.render(scene, camera);
    }

    // adaptive quality (auto only): trade pixel ratio, then post, for frame time
    if (auto && dt > 0) {
      frameEMA += (dt * 1000 - frameEMA) * 0.05;
      if (frameEMA > 18 && document.visibilityState === "visible") slow += dt;
      else slow = Math.max(0, slow - dt * 0.5);
      if (slow > 2) {
        slow = 0;
        frameEMA = 16;
        if (tierAtLeast("high") && pixelRatio > 1) {
          pixelRatio = 1;
          renderer.setPixelRatio(1);
          const s = size();
          if (composer) {
            composer.setPixelRatio(1);
            composer.setSize(s.x, s.y);
          }
        } else if (tier === "high" && frameEMA > 30) {
          setQuality("medium", true);
        }
      }
    }
  }

  function resize(w, h) {
    renderer.setSize(w, h);
    if (composer) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    }
    if (bloom) bloom.setSize(w, h);
  }

  function setQuality(q, keepAuto = false) {
    if (!keepAuto && q !== "auto") {
      /* explicit choice disables the adaptive tier logic */
    }
    const next = q === "auto" ? (gpu.software ? "low" : "high") : q;
    if (!TIERS.includes(next) || next === tier) return;
    tier = next;
    applyEnv();
    applyFxVisibility();
    renderer.setPixelRatio(tierAtLeast("high") ? pixelRatio : Math.min(window.devicePixelRatio || 1, 1.25));
    buildComposer();
    api.composer = composer;
  }

  const api = {
    composer,
    get quality() {
      return tier;
    },
    render,
    resize,
    setQuality,
    refresh() {
      const n = scan();
      if (mergeOk) mergeStatic();
      buildFx();
      renderer.shadowMap.needsUpdate = true;
      return n;
    },
    stats() {
      return { tier, gpu: gpu.name, pixelRatio: renderer.getPixelRatio(), frameMs: +frameEMA.toFixed(1), ...stats };
    },
  };
  return api;
}
