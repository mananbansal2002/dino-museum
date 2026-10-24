/**
 * Living exhibits: the life-size models placed by livemodels.js breathe, and
 * when the local visitor comes within a few metres they slowly turn the head
 * to follow them, like a museum animatronic: heavily damped, clamped, never a
 * snap, easing back to rest once the visitor walks on. The first time an
 * animal notices you it gives a low snort (rate limited).
 *
 * The Grand Gallery T. rex also puts on a short show every few minutes while
 * you are in the gallery: the hall dims, a spot sweeps onto it, it raises its
 * head and roars once, then the lights come back.
 *
 *   const living = createLiving({ camera, renderer, audio, busy, reducedMotion });
 *   living.attach({ p, m, model, clip, keys })   // once per spawned model
 *   living.update(dt, target, roomId)            // every frame, AFTER the mixers
 *   living.show()                                // start the T. rex show now
 *
 * Skinned models turn their neck chain + head bones (post-multiplied onto the
 * animation pose, so clips never overwrite it). The T. rex has no skeleton,
 * so its neck is bent in the vertex shader instead (same damped yaw / pitch,
 * plus a ribcage breath), which keeps its body, arms and feet still.
 *
 * Per frame: one frustum test per rig, then only rigs in view and in range
 * (or still easing back) do any work. No allocations in update().
 */

import * as THREE from "three";

/* ------------------------------------------------------------------ */
/* tuning                                                               */
/* ------------------------------------------------------------------ */

const ACTIVE_DIST = 45; // rigs further than this from the visitor rest
const NOTICE_GAP = 45; // s between snorts of one animal
const NOTICE_GAP_ANY = 10; // s between snorts of any animal
const SHOW_FIRST = [75, 150]; // s spent in the gallery before the first show
const SHOW_EVERY = [240, 360]; // s between shows
const SHOW_LEN = 15;
const SHOW_DIM = 0.4; // the hall loses this share of its light

/**
 * Per exhibit: range (m, head to visitor) at which it notices you, max yaw /
 * pitch (rad; up = raise, down = lower), spring omega (1/s, lower = slower),
 * max turn speed (rad/s), breath period (s, 0 = none), snort size.
 */
const PROFILES = {
  trex: { range: 10, yaw: 0.5, up: 0.1, down: 0.22, omega: 1.3, speed: 0.4, breath: 4.8, amp: 1, size: 1, drift: 1 },
  diplod: { range: 11, yaw: 0.42, up: 0.08, down: 0.2, omega: 1.0, speed: 0.28, breath: 6.2, amp: 1, size: 0.9, drift: 1 },
  allo: { range: 9, yaw: 0.55, up: 0.1, down: 0.24, omega: 1.6, speed: 0.5, breath: 3.9, amp: 0.6, size: 0.8, drift: 0.5 },
  raptor: { range: 5.5, yaw: 0.7, up: 0.12, down: 0.3, omega: 2.6, speed: 1.0, breath: 2.3, amp: 0.6, size: 0.3, drift: 0.5 },
  ptero: { range: 12, yaw: 0.3, up: 0.05, down: 0.35, omega: 1.4, speed: 0.5, breath: 0, amp: 0, size: 0, drift: 0.4 },
};
const DEFAULT_PROFILE = { range: 7, yaw: 0.45, up: 0.1, down: 0.22, omega: 1.5, speed: 0.5, breath: 4, amp: 0.8, size: 0.6, drift: 0.6 };

/**
 * The T. rex's bend, as fractions of its bounds (root space, +z forward):
 * the neck bends between `pivot` and `full` (share of the length back from
 * the snout), pitching around `pivotY` (share of the height); the ribcage
 * breathes around chestZ ± chestSigma at chestY. Vertices below gateY (the
 * arms) stay out of the neck bend; legs (below legY) stay out of the breath.
 */
const BEND = { pivot: 0.205, full: 0.13, pivotY: 0.8, headZ: 0.07, headY: 0.82, chestZ: 0.33, chestSigma: 0.09, chestY: 0.68, gateY: [0.55, 0.64], legY: [0.42, 0.55], breath: 0.022 };

/* ------------------------------------------------------------------ */
/* scratch objects (reused every frame)                                 */
/* ------------------------------------------------------------------ */

const _v = new THREE.Vector3();
const _head = new THREE.Vector3();
const _base = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _inv = new THREE.Matrix4();
const _pm = new THREE.Matrix4();
const _frustum = new THREE.Frustum();
const _sphere = new THREE.Sphere();
const UP = new THREE.Vector3(0, 1, 0);
const SIDE = new THREE.Vector3(1, 0, 0);

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
const ramp = (t, a, b) => smooth((t - a) / (b - a));
const rand = (a, b) => a + Math.random() * (b - a);

/** Critically damped spring step (implicit, stable for any dt), speed-capped. */
function spring(s, target, dt, omega, maxSpeed) {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const det = 1 / (f + dt * hoo);
  const x = (f * s.x + dt * s.v + dt * hoo * target) * det;
  let v = (s.v + hoo * (target - s.x)) * det;
  v = clamp(v, -maxSpeed, maxSpeed);
  s.x = clamp(x, s.x - maxSpeed * dt, s.x + maxSpeed * dt);
  s.v = v;
}

/** Breath curve 0..1: a quicker inhale, a long exhale, a short rest. */
function breathCurve(u) {
  if (u < 0.38) return smooth(u / 0.38);
  if (u < 0.9) return 1 - smooth((u - 0.38) / 0.52);
  return 0;
}

/* ------------------------------------------------------------------ */
/* skeleton rigs                                                        */
/* ------------------------------------------------------------------ */

/** Head bone + the unbroken run of neck bones above it (root first), and the chest. */
function findNeck(model) {
  let head = null;
  model.traverse((o) => {
    if (head || !o.isBone) return;
    if (/head/i.test(o.name) && !/nub|end|top|jaw|tip/i.test(o.name) && o.parent?.isBone && /neck/i.test(o.parent.name)) head = o;
  });
  if (!head) {
    model.traverse((o) => {
      if (!head && o.isBone && /head/i.test(o.name) && !/nub|end|top|jaw|tip/i.test(o.name)) head = o;
    });
  }
  if (!head) return null;
  const chain = [head];
  let b = head.parent;
  while (b && b.isBone && /neck/i.test(b.name)) {
    chain.unshift(b);
    b = b.parent;
  }
  const chest = b && b.isBone ? b : null;
  return { chain, chest };
}

function hasTrack(clip, bone) {
  if (!clip) return false;
  const name = `${bone.name}.quaternion`;
  return clip.tracks.some((t) => t.name === name);
}

function boneRig(place, model, clip) {
  const found = findNeck(model);
  if (!found) return null;
  const { chain, chest } = found;
  place.updateWorldMatrix(true, true);
  const n = chain.length - 1; // neck bones (without the head)
  // yaw: the head takes ~40 %, the neck the rest, more towards the head;
  // pitch: mostly the head and the top of the neck
  const yw = [];
  const pw = [];
  let neckY = 0;
  let neckP = 0;
  for (let i = 0; i < n; i++) {
    yw.push(1 + i);
    pw.push((1 + i) * (1 + i));
    neckY += 1 + i;
    neckP += (1 + i) * (1 + i);
  }
  yw.push(n ? neckY * 0.67 : 1);
  pw.push(n ? neckP : 1);
  const sy = yw.reduce((a, b) => a + b, 0);
  const sp = pw.reduce((a, b) => a + b, 0);
  const bones = [];
  const add = (bone, wy, wp, wb) => {
    const m = new THREE.Matrix4().copy(bone.matrixWorld).invert().multiply(place.matrixWorld);
    const sign = bone.matrixWorld.determinant() * place.matrixWorld.determinant() < 0 ? -1 : 1;
    bones.push({
      bone,
      saved: bone.quaternion.clone(),
      animated: hasTrack(clip, bone),
      yawAxis: UP.clone().transformDirection(m),
      pitchAxis: SIDE.clone().transformDirection(m),
      wy: wy * sign,
      wp: wp * sign,
      wb: wb * sign,
    });
  };
  // breathing: the chest rocks up on the inhale, the neck root takes most of it back
  if (chest) add(chest, 0, 0, 1);
  chain.forEach((bone, i) => add(bone, yw[i] / sy, pw[i] / sp, i === 0 ? -0.55 : 0));
  return { kind: "bones", bones, head: chain[chain.length - 1], neck: chain[0], names: [chest, ...chain].filter(Boolean).map((b) => b.name) };
}

/* ------------------------------------------------------------------ */
/* shader bend (models without a skeleton)                              */
/* ------------------------------------------------------------------ */

const BEND_HEAD = /* glsl */ `
uniform float lvYaw;
uniform float lvPitch;
uniform float lvBreath;
uniform mat4 lvToRoot;
uniform mat4 lvFromRoot;
uniform vec4 lvNeck;  // pivot z, full z, pivot y, gate mid z
uniform vec4 lvChest; // centre z, sigma, centre y, -
uniform vec4 lvGate;  // arm gate y0, y1, leg gate y0, y1
mat3 lvRot(vec3 p) {
  float w = smoothstep(lvNeck.x, lvNeck.y, p.z);
  w *= max(smoothstep(lvGate.x, lvGate.y, p.y), smoothstep(lvNeck.w, lvNeck.y, p.z));
  float a = lvYaw * w;
  float b = lvPitch * w;
  float ca = cos(a), sa = sin(a), cb = cos(b), sb = sin(b);
  mat3 ry = mat3(ca, 0.0, -sa, 0.0, 1.0, 0.0, sa, 0.0, ca);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cb, sb, 0.0, -sb, cb);
  return ry * rx;
}
`;

function patchBend(mat, uniforms) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\n${BEND_HEAD}`)
      .replace(
        "#include <beginnormal_vertex>",
        `#include <beginnormal_vertex>
        vec3 lvP = (lvToRoot * vec4(position, 1.0)).xyz;
        mat3 lvR = lvRot(lvP);
        objectNormal = normalize(mat3(lvFromRoot) * (lvR * (mat3(lvToRoot) * objectNormal)));
        #ifdef USE_TANGENT
          objectTangent = normalize(mat3(lvFromRoot) * (lvR * (mat3(lvToRoot) * objectTangent)));
        #endif`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          vec3 q = lvP;
          float dz = (q.z - lvChest.x) / lvChest.y;
          float wc = exp(-dz * dz) * smoothstep(lvGate.z, lvGate.w, q.y) * lvBreath;
          q.x *= 1.0 + wc;
          q.y = lvChest.z + (q.y - lvChest.z) * (1.0 + 0.6 * wc);
          vec3 piv = vec3(0.0, lvNeck.z, lvNeck.x);
          q = piv + lvR * (q - piv);
          transformed = (lvFromRoot * vec4(q, 1.0)).xyz;
        }`
      );
  };
  mat.customProgramCacheKey = () => "lv-bend";
  mat.needsUpdate = true;
}

function bendRig(place, model) {
  model.updateWorldMatrix(true, true);
  const toModel = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const box = new THREE.Box3();
  const tmpBox = new THREE.Box3();
  const meshes = [];
  model.traverse((o) => {
    if (!o.isMesh || o.isSkinnedMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const toRoot = new THREE.Matrix4().multiplyMatrices(toModel, o.matrixWorld);
    box.union(tmpBox.copy(o.geometry.boundingBox).applyMatrix4(toRoot));
    meshes.push({ o, toRoot });
  });
  if (!meshes.length) return null;
  const L = box.max.z - box.min.z;
  const H = box.max.y - box.min.y;
  const zf = (f) => box.max.z - f * L;
  const yf = (f) => box.min.y + f * H;
  const shared = {
    lvYaw: { value: 0 },
    lvPitch: { value: 0 },
    lvBreath: { value: 0 },
    lvNeck: { value: new THREE.Vector4(zf(BEND.pivot), zf(BEND.full), yf(BEND.pivotY), zf((BEND.pivot + BEND.full) / 2)) },
    lvChest: { value: new THREE.Vector4(zf(BEND.chestZ), BEND.chestSigma * L, yf(BEND.chestY), 0) },
    lvGate: { value: new THREE.Vector4(yf(BEND.gateY[0]), yf(BEND.gateY[1]), yf(BEND.legY[0]), yf(BEND.legY[1])) },
  };
  for (const { o, toRoot } of meshes) {
    const own = { ...shared, lvToRoot: { value: toRoot }, lvFromRoot: { value: toRoot.clone().invert() } };
    // own copies: the gltf's materials are shared with the miniature in its case
    const list = Array.isArray(o.material) ? o.material : [o.material];
    const next = list.map((m) => {
      const c = m.clone();
      patchBend(c, own);
      return c;
    });
    o.material = Array.isArray(o.material) ? next : next[0];
  }
  // fixed points in the place frame: the neck pivot and the head
  place.updateWorldMatrix(true, true);
  const modelToPlace = new THREE.Matrix4().copy(place.matrixWorld).invert().multiply(model.matrixWorld);
  const pivot = new THREE.Vector3(0, yf(BEND.pivotY), zf(BEND.pivot)).applyMatrix4(modelToPlace);
  const head = new THREE.Vector3(0, yf(BEND.headY), zf(BEND.headZ)).applyMatrix4(modelToPlace);
  const chest = new THREE.Vector3(0, yf(BEND.chestY), zf(BEND.chestZ)).applyMatrix4(modelToPlace);
  return { kind: "bend", u: shared, pivot, headLocal: head, chestLocal: chest, names: ["(no skeleton: vertex-shader neck bend)"] };
}

/* ------------------------------------------------------------------ */
/* the living layer                                                     */
/* ------------------------------------------------------------------ */

export function createLiving({ camera, renderer, audio, busy, reducedMotion } = {}) {
  const rigs = [];
  let time = 0;
  let lastSnort = -1e9;

  function attach({ p, m, model, clip, keys }) {
    try {
      const id = p.ex.id;
      const prof = PROFILES[id] || DEFAULT_PROFILE;
      const rig = boneRig(m.place, model, clip) || (p.ex.flight ? null : bendRig(m.place, model));
      if (!rig) return null;
      Object.assign(rig, {
        id,
        p,
        m,
        prof,
        keys,
        yaw: { x: 0, v: 0 },
        pitch: { x: 0, v: 0 },
        attending: false,
        idle: true,
        live: 0, // 0..1 fade of breath / drift when the rig wakes or rests
        seed: Math.random() * 100,
        breathU: Math.random(),
        breathRate: prof.breath ? 1 / (prof.breath * rand(0.93, 1.07)) : 0,
        breath: 0,
        lastNotice: -1e9,
        snortAt: -1,
        extraPitch: 0,
        extraBreath: 0,
        tremble: 0,
        radius: (p.ex.animals?.[0]?.length || 4) * 0.6 + 1.5,
      });
      rigs.push(rig);
      m.rig = rig;
      return rig;
    } catch (err) {
      console.warn(`[living] ${p?.ex?.id}: could not rig`, err);
      return null;
    }
  }

  /** Head position (world) and the yaw pivot (world) of a rig. */
  function headOf(rig, head, base) {
    if (rig.kind === "bones") {
      head.setFromMatrixPosition(rig.head.matrixWorld);
      base.setFromMatrixPosition(rig.neck.parent ? rig.neck.parent.matrixWorld : rig.neck.matrixWorld);
    } else {
      const mw = rig.m.place.matrixWorld;
      head.copy(rig.headLocal).applyMatrix4(mw);
      base.copy(rig.pivot).applyMatrix4(mw);
    }
  }

  function snort(rig, target) {
    if (!audio?.snort || !rig.prof.size) return;
    if (audio.channelOn && audio.channelOn("roars") === false) return;
    headOf(rig, _head, _base);
    const d = _head.distanceTo(target);
    const e = camera ? camera.matrixWorld.elements : null;
    let pan = 0;
    if (e) {
      _v.copy(_head).sub(camera.position).normalize();
      pan = clamp(_v.x * e[0] + _v.y * e[1] + _v.z * e[2], -1, 1) * 0.7;
    }
    audio.snort(rig.prof.size, { distance: d, range: 25, pan });
  }

  function apply(rig) {
    const yaw = rig.yaw.x;
    const pitch = clamp(rig.pitch.x + rig.extraPitch, -0.32, 0.3) + rig.tremble;
    const breath = rig.breath;
    if (rig.kind === "bend") {
      rig.u.lvYaw.value = yaw;
      // the head rises a hair on the inhale
      rig.u.lvPitch.value = pitch - breath * 0.006 * rig.prof.amp;
      rig.u.lvBreath.value = breath * BEND.breath;
      return;
    }
    const mixed = !!rig.m.mixed;
    const b = breath * 0.009 * rig.prof.amp;
    for (const j of rig.bones) {
      const bone = j.bone;
      if (j.animated && mixed) j.saved.copy(bone.quaternion);
      else bone.quaternion.copy(j.saved);
      const a = yaw * j.wy;
      const c = pitch * j.wp - b * j.wb;
      if (a) bone.quaternion.multiply(_q1.setFromAxisAngle(j.yawAxis, a));
      if (c) bone.quaternion.multiply(_q2.setFromAxisAngle(j.pitchAxis, c));
    }
  }

  function rest(rig) {
    rig.idle = true;
    rig.yaw.x = rig.yaw.v = rig.pitch.x = rig.pitch.v = 0;
    rig.breath = 0;
    rig.live = 0;
    if (rig.kind === "bend") {
      rig.u.lvYaw.value = rig.u.lvPitch.value = rig.u.lvBreath.value = 0;
    } else {
      for (const j of rig.bones) j.bone.quaternion.copy(j.saved);
    }
  }

  /**
   * Call right before a model's mixer.update(): puts the clean pose back.
   * The mixer only writes a bone whose animated value changed since its last
   * write, so without this a held / constant track would keep our offset and
   * it would pile up frame after frame.
   */
  function beforeMix(m) {
    const rig = m.rig;
    if (!rig || rig.idle || rig.kind !== "bones") return;
    for (const j of rig.bones) j.bone.quaternion.copy(j.saved);
  }

  /* ---------------- per frame ---------------- */
  function update(dt, target, roomId, cameraDriven = false) {
    if (!rigs.length || !target) return;
    time += dt;
    if (camera) {
      _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_pm);
    }
    for (let i = 0; i < rigs.length; i++) {
      const rig = rigs[i];
      const place = rig.m.place;
      if (!place.visible && rig.idle) continue;
      _sphere.center.setFromMatrixPosition(place.matrixWorld);
      _sphere.radius = rig.radius;
      const near = _sphere.center.distanceTo(target) < ACTIVE_DIST + rig.radius;
      const inView = !camera || _frustum.intersectsSphere(_sphere);
      const active = near && inView && place.visible;
      const showing = show.rig === rig && show.on;
      if (!active && !showing) {
        if (rig.idle) continue;
        // ease back to rest even off screen, then stop
        if (Math.abs(rig.yaw.x) + Math.abs(rig.pitch.x) + Math.abs(rig.yaw.v) + Math.abs(rig.pitch.v) < 0.002 && rig.live < 0.02) {
          rest(rig);
          continue;
        }
      }
      rig.idle = false;
      const prof = rig.prof;
      rig.live += ((active || showing ? 1 : 0) - rig.live) * Math.min(1, dt * 0.8);

      // where is the visitor, seen from the animal?
      headOf(rig, _head, _base);
      _inv.copy(place.matrixWorld).invert();
      _v.copy(target).applyMatrix4(_inv);
      _base.applyMatrix4(_inv);
      _head.applyMatrix4(_inv);
      const rawYaw = Math.atan2(_v.x - _base.x, _v.z - _base.z);
      const dist = Math.hypot(_v.x - _head.x, _v.y - _head.y, _v.z - _head.z) * place.matrixWorld.getMaxScaleOnAxis();
      const ahead = Math.abs(rawYaw) < (rig.attending ? 2.1 : 1.85);
      const was = rig.attending;
      rig.attending = active && ahead && dist < prof.range * (was ? 1.25 : 1);
      if (rig.attending && !was) {
        if (time - rig.lastNotice > NOTICE_GAP) rig.snortAt = time + rand(0.7, 1.3);
        rig.lastNotice = Math.max(rig.lastNotice, time - NOTICE_GAP + 8); // re-entering right away stays quiet
      }
      if (rig.snortAt > 0 && time >= rig.snortAt) {
        rig.snortAt = -1;
        if (rig.attending && time - lastSnort > NOTICE_GAP_ANY && !(show.on && show.rig === rig)) {
          lastSnort = time;
          rig.lastNotice = time;
          snort(rig, target);
        }
      }

      // targets: the visitor (clamped), else straight ahead; plus a slow drift
      let ty = 0;
      let tp = 0;
      if (rig.attending) {
        ty = clamp(rawYaw, -prof.yaw, prof.yaw);
        const horiz = Math.max(0.6, Math.hypot(_v.x - _head.x, _v.z - _head.z));
        tp = clamp(Math.atan2(_head.y - _v.y, horiz), -prof.up, prof.down);
        // softer at the edge of the range
        const edge = smooth((prof.range * 1.25 - dist) / (prof.range * 0.5));
        ty *= edge;
        tp *= edge;
      }
      const s = rig.seed;
      const drift = prof.drift * rig.live;
      ty += drift * (0.035 * Math.sin(time * 0.17 + s) + 0.02 * Math.sin(time * 0.071 + s * 1.7));
      tp += drift * (0.015 * Math.sin(time * 0.13 + s * 2.3) + 0.01 * Math.sin(time * 0.29 + s));
      spring(rig.yaw, ty, dt, prof.omega, prof.speed);
      spring(rig.pitch, tp, dt, prof.omega, prof.speed * 0.7);

      if (rig.breathRate) {
        rig.breathU = (rig.breathU + dt * rig.breathRate * (1 + rig.extraBreath * 0.3)) % 1;
        rig.breath = (breathCurve(rig.breathU) - 0.5 + rig.extraBreath) * rig.live;
      }
      apply(rig);
    }
    updateShow(dt, target, roomId, cameraDriven);
  }

  /* ---------------- the T. rex show ---------------- */
  const show = {
    on: false,
    t: 0,
    rig: null,
    light: null,
    timer: 0,
    next: rand(SHOW_FIRST[0], SHOW_FIRST[1]),
    baseExposure: 1,
    dim: 0,
    spot: 0,
    roared: false,
    abort: false,
    origin: new THREE.Vector3(),
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    shakeX: 0,
    shakeY: 0,
    shakeZ: 0,
    count: 0,
  };
  let trex = null; // cached: no closure per frame
  const isTrex = (r) => r.id === "trex";
  const trexRig = () => trex || (trex = rigs.find(isTrex) || null);
  const isBusy = () => {
    try {
      return !!busy?.();
    } catch {
      return false;
    }
  };
  const motionReduced = () => {
    try {
      if (reducedMotion) return !!reducedMotion();
      return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  };

  function startShow() {
    const rig = trexRig();
    if (!rig || show.on || !renderer) return false;
    const p = rig.p;
    show.on = true;
    show.t = 0;
    show.rig = rig;
    show.roared = false;
    show.abort = false;
    show.forced = false;
    show.count++;
    show.baseExposure = renderer.toneMappingExposure;
    show.light = rig.keys?.borrow?.(p) || null;
    // a spot high up in front of the animal, off to its left; it starts on
    // the floor out in the gallery and sweeps up onto the head and chest
    const fx = Math.sin(p.ex.ry);
    const fz = Math.cos(p.ex.ry);
    rig.m.place.updateWorldMatrix(true, false);
    show.to.copy(rig.headLocal || rig.chestLocal || _v.set(0, 3, 4));
    if (rig.kind === "bend") show.to.lerp(rig.chestLocal, 0.35);
    show.to.applyMatrix4(rig.m.place.matrixWorld);
    show.origin.set(p.x + fx * 9 - fz * 6, Math.min(13.5, show.to.y + 8.5), p.z + fz * 9 + fx * 6);
    show.from.set(p.x + fx * 13 + fz * 7, 0, p.z + fz * 13 - fx * 7);
    return true;
  }

  function endShow() {
    if (renderer) renderer.toneMappingExposure = show.baseExposure;
    if (show.light) show.rig?.keys?.release?.(show.light);
    show.light = null;
    show.on = false;
    show.dim = show.spot = 0;
    if (show.rig) {
      show.rig.extraPitch = 0;
      show.rig.extraBreath = 0;
      show.rig.tremble = 0;
    }
    show.timer = 0;
    show.next = rand(SHOW_EVERY[0], SHOW_EVERY[1]);
  }

  function updateShow(dt, target, roomId, cameraDriven) {
    const rig = trexRig();
    if (!rig) return;
    const here = roomId === rig.p.ex.room;
    if (!show.on) {
      if (here && !isBusy()) {
        show.timer += dt;
        if (show.timer >= show.next) startShow();
      }
      if (!show.on) return;
    }
    show.t += dt;
    const t = show.t;
    if (!show.abort && (!here || isBusy()) && !show.forced) show.abort = true;

    let dim;
    let spot;
    let lift;
    if (show.abort) {
      const k = Math.min(1, dt * 1.6);
      dim = show.dim - show.dim * k;
      spot = show.spot - show.spot * k;
      lift = rig.extraPitch - rig.extraPitch * k;
      rig.extraBreath -= rig.extraBreath * k;
      rig.tremble = 0;
      if (dim < 0.01 && spot < 0.01 && Math.abs(lift) < 0.005) {
        endShow();
        return;
      }
    } else {
      // 0-2.5 s the hall dims; 1-5.5 s the spot sweeps onto the animal;
      // 4.5-7.5 s the head rises (a deep breath in); ~7.9 s one roar, the
      // head thrusts forward; 10.5-13 s it settles; 12-15 s the lights return
      dim = ramp(t, 0, 2.5) * (1 - ramp(t, 12, 15));
      spot = ramp(t, 0.8, 2.4) * (1 - ramp(t, 11.5, 14.2));
      lift = -0.2 * ramp(t, 4.5, 7.6) + 0.17 * ramp(t, 7.8, 8.7) + 0.03 * ramp(t, 10.5, 13);
      rig.extraBreath = 0.9 * ramp(t, 5, 7.6) * (1 - ramp(t, 7.9, 10));
      const roaring = ramp(t, 7.9, 8.3) * (1 - ramp(t, 9.6, 10.6));
      rig.tremble = roaring * 0.004 * Math.sin(t * 47) * Math.sin(t * 5.3 + 1);
      if (!show.roared && t >= 7.9) {
        show.roared = true;
        if (audio?.roar && !(audio.channelOn && audio.channelOn("roars") === false)) {
          headOf(rig, _head, _base);
          const d = _head.distanceTo(target);
          let pan = 0;
          if (camera) {
            const e = camera.matrixWorld.elements;
            _v.copy(_head).sub(camera.position).normalize();
            pan = clamp(_v.x * e[0] + _v.y * e[1] + _v.z * e[2], -1, 1) * 0.6;
          }
          audio.roar(1.0, { kind: "trex", distance: Math.max(2, d * 0.6), range: 60, pan });
        }
      }
      if (t >= SHOW_LEN) {
        endShow();
        return;
      }
    }
    show.dim = dim;
    show.spot = spot;
    rig.extraPitch = lift;
    if (renderer) renderer.toneMappingExposure = show.baseExposure * (1 - SHOW_DIM * dim);

    const l = show.light;
    if (l) {
      const u = ramp(t, 1.0, 5.5);
      l.position.copy(show.origin);
      // the beam glides across the floor, then climbs onto the animal
      l.target.position.lerpVectors(show.from, show.to, u);
      l.target.position.y = show.to.y * smooth(u * 1.15);
      l.target.updateMatrixWorld();
      l.angle = 0.26 - 0.07 * u;
      l.penumbra = 0.45;
      l.distance = 60;
      const d2 = l.position.distanceToSquared(show.to);
      l.intensity = spot * 24 * d2; // ~24 lux on the animal (the hall is dimmed around it)
    }

    // the floor shakes a little under the roar (only on a camera the player
    // controller re-places every frame, so the offset never accumulates)
    if (camera && cameraDriven) {
      show.shakeX = show.shakeY = show.shakeZ = 0;
      if (!show.abort && !motionReduced() && t > 7.95 && t < 10.2) {
        const env = ramp(t, 7.95, 8.15) * (1 - ramp(t, 8.6, 10.2)) * 0.016;
        show.shakeX = env * (Math.sin(t * 61) * 0.6 + Math.sin(t * 37 + 2) * 0.4);
        show.shakeY = env * (Math.sin(t * 53 + 1) * 0.6 + Math.sin(t * 29) * 0.4) * 0.7;
        show.shakeZ = env * (Math.sin(t * 47 + 4) * 0.6 + Math.sin(t * 31 + 3) * 0.4);
        camera.position.x += show.shakeX;
        camera.position.y += show.shakeY;
        camera.position.z += show.shakeZ;
      }
    }
  }

  return {
    attach,
    beforeMix,
    update,
    /** start the T. rex show now (debug / tests); returns false if it cannot */
    show() {
      const ok = startShow();
      if (ok) show.forced = true;
      return ok;
    },
    /** the rigs themselves (tests / console) */
    rigs,
    get showing() {
      return show.on ? +show.t.toFixed(2) : false;
    },
    dispose() {
      if (show.on) endShow();
      rigs.length = 0;
      trex = null;
    },
    debug: () => ({
      time: +time.toFixed(2),
      show: { on: show.on, t: +show.t.toFixed(2), timer: +show.timer.toFixed(1), next: +show.next.toFixed(1), count: show.count },
      rigs: rigs.map((r) => ({
        id: r.id,
        kind: r.kind,
        bones: r.names,
        attending: r.attending,
        idle: r.idle,
        yaw: +((r.yaw.x * 180) / Math.PI).toFixed(1),
        pitch: +((r.pitch.x * 180) / Math.PI).toFixed(1),
        breath: +r.breath.toFixed(2),
      })),
    }),
  };
}
