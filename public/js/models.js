import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { DEFAULT_HAIR } from "./character.js";
import { clamp, damp } from "./util.js";

/**
 * Rigged glTF visitor avatars (CC0, Quaternius via poly.pizza — see public/models/CREDITS.md).
 *
 * Every model is loaded once and cloned per instance. Callers always get a
 * procedural fallback first; the glTF swaps in when it has loaded, so the
 * museum still works if a model fails to download.
 *
 * NB: GLTFLoader names nodes with PropertyBinding.sanitizeNodeName, which strips
 * "." — the file's "Palm.R" bone is "PalmR" at runtime.
 */

const loader = new GLTFLoader();
const cache = new Map();

export function loadGLB(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject))
    );
  }
  return cache.get(url);
}

/*
 * Per model, measured on the rest pose in character space (metres, +y up, +z forward,
 * +x the avatar's left):
 *   head / back: where the procedural hair + head accessory (centred on the head) and
 *     the back group (cape / backpack, origin at the spine base) sit, and how much to
 *     shrink them — the procedural character has a big stylised head and a wide torso
 *   sit: the Sitting clip rests the thighs ~0.40m above the root and the hips ~0.22m
 *     behind it, but seats put the root SIT_SEAT_OFFSET (0.45m) below their top
 *   walkSpeed / runSpeed: how fast a planted foot travels at timeScale 1 (m/s)
 */
export const HUMAN_MODELS = {
  male: {
    url: "/models/humans/male.glb",
    prefix: "Man_",
    fileHeight: 4.84,
    height: 1.8,
    head: { y: 1.65, z: 0.065, scale: 0.52 },
    back: { y: 0.93, z: 0.025, scale: [0.57, 0.97, 0.56] },
    sit: { lift: 0.05, forward: 0.2 },
    walkSpeed: 1.66,
    runSpeed: 3.6,
  },
  female: {
    url: "/models/humans/female.glb",
    prefix: "Female_",
    fileHeight: 4.65,
    height: 1.72,
    head: { y: 1.578, z: 0.043, scale: 0.55 },
    back: { y: 0.88, z: 0.03, scale: [0.72, 0.96, 0.69] },
    sit: { lift: 0.062, forward: 0.2 },
    walkSpeed: 1.66,
    runSpeed: 3.6,
  },
};

/** Turns a glTF clip name like "Armature|TRex_Walk" into "Walk". */
function clipKey(name, prefix) {
  const tail = name.split("|").pop();
  if (tail.startsWith(prefix)) return tail.slice(prefix.length);
  // a few files ship clips named after another species (e.g. Stegosaurus_Death)
  const i = tail.indexOf("_");
  return i >= 0 ? tail.slice(i + 1) : tail;
}

/**
 * A cloned, animated instance of a glTF.
 */
function createRig(gltf, prefix, scale, clips = gltf.animations) {
  const model = cloneSkinned(gltf.scene);
  const materials = new Map();
  model.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = false;
    // skinned meshes animate outside their bind-pose bounds
    o.frustumCulled = false;
    o.material = Array.isArray(o.material)
      ? o.material.map((m) => cloneMaterial(m, materials))
      : cloneMaterial(o.material, materials);
  });
  model.scale.setScalar(scale);

  const mixer = new THREE.AnimationMixer(model);
  const actions = {};
  for (const clip of clips) {
    actions[clipKey(clip.name, prefix)] = mixer.clipAction(clip);
  }

  let current = null;
  const rig = {
    model,
    mixer,
    actions,
    materials,
    disposed: false,
    get current() {
      return current;
    },
    has: (key) => !!actions[key],
    /**
     * Cross-fades to a clip. once: play a single time and hold the last frame.
     * restart: replay it even if it is already the current clip. startAt: clip time to start from.
     */
    play(key, { fade = 0.25, once = false, timeScale = 1, restart = false, startAt = 0 } = {}) {
      const next = actions[key];
      if (!next) return false;
      next.timeScale = timeScale;
      if (current === key && !restart) return true;
      const prev = current ? actions[current] : null;
      next.reset();
      next.time = startAt;
      next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = once;
      next.enabled = true;
      next.setEffectiveWeight(1);
      next.play();
      if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
      current = key;
      return true;
    },
    update(dt) {
      mixer.update(dt);
    },
    /** Frees what this instance owns (once). Geometry and textures are shared with the cached glTF. */
    dispose() {
      if (rig.disposed) return;
      rig.disposed = true;
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      const skeletons = new Set();
      model.traverse((o) => {
        if (o.isSkinnedMesh) skeletons.add(o.skeleton);
      });
      // each cloned skeleton owns a bone texture on the GPU
      for (const s of skeletons) s.dispose();
      for (const m of materials.values()) m.dispose();
    },
  };
  return rig;
}

function cloneMaterial(m, seen) {
  if (seen.has(m.name || m.uuid)) return seen.get(m.name || m.uuid);
  const c = m.clone();
  c.roughness = Math.max(0.55, c.roughness ?? 0.8);
  c.metalness = Math.min(0.1, c.metalness ?? 0);
  seen.set(m.name || m.uuid, c);
  return c;
}

/* ------------------------------------------------------------------ */
/* humans                                                               */
/* ------------------------------------------------------------------ */

/** m/s of a full-speed opts.speed of 1 (player.js RUN; character.update gets m/s ÷ RUN) */
const MAX_SPEED = 8.4;
/** above this ground speed (m/s) the Run clip fits the feet better than a sped-up Walk */
const RUN_FROM = 2.4;
/** the Jump clip's wind-up crouch (0–0.25s) happens before take-off; physics has already left the ground */
const JUMP_SKIP = 0.25;
/** on a seat taller than the Sitting clip's: how far the thighs slope down, then the toes point (rad) */
const THIGH_TIP = 0.21;
const TOE_POINT = 0.8;
/** the procedural visitor is chunkier than the glTF one: held props shrink to suit its hand */
const HELD_SCALE = 0.6;
/** head accessories that sit over the glTF's own hair, so the procedural (capped) hair is used instead */
const COVERS_HAIR = new Set(["cap", "headphones"]);
const HAIR_MATERIALS = new Set(["Hair", "Hair2", "HairBase"]);

const bodyOf = (look) => (look.body === "female" ? "female" : "male");

function recolorHuman(rig, look) {
  const set = (name, hex, k = 1) => {
    const m = rig.materials.get(name);
    if (m && hex) m.color.set(hex).multiplyScalar(k);
  };
  set("Skin", look.skin);
  set("Shirt", look.shirt);
  set("Shirt2", look.shirt, 0.78);
  set("Pants", look.pants);
  set("Hair", look.hairColor);
  set("Hair2", look.hairColor, 0.85);
  set("HairBase", look.hairColor, 0.85);
}

/**
 * The clips as the game plays them. Jump lifts the whole body ~0.43m in place,
 * which would stack on top of the physics jump: pin the root bone ("Body") and
 * the feet (separate IK bones under the armature root, so they must drop by the
 * same amount or the ankles split) to the ground, keeping only the crouch and the
 * tuck. Both bones' parent frame is y-up in these Quaternius rigs.
 */
const humanClips = new WeakMap();
function clipsFor(gltf) {
  let clips = humanClips.get(gltf);
  if (clips) return clips;
  const restY = gltf.scene.getObjectByName("Body")?.position.y;
  clips = gltf.animations.map((clip) =>
    /_Jump$/.test(clip.name) && restY !== undefined ? pinLift(clip, "Body", ["FootL", "FootR"], restY) : clip
  );
  humanClips.set(gltf, clips);
  return clips;
}

function pinLift(clip, root, feet, restY) {
  const src = clip.tracks.find((t) => t.name === `${root}.position`);
  if (!src) return clip;
  const lift = src.createInterpolant();
  const out = clip.clone();
  for (const track of out.tracks) {
    if (track.name !== src.name && !feet.some((f) => track.name === `${f}.position`)) continue;
    const v = track.values;
    for (let i = 0; i < track.times.length; i++) {
      v[i * 3 + 1] -= Math.max(0, lift.evaluate(track.times[i])[1] - restY);
    }
  }
  return out;
}

/**
 * A group under `bone` placed, for the rig's current (rest) pose, at the character-space
 * point `pos` with no rotation and unit scale — so things built in character space ride
 * the bone whatever its roll and the armature's ×100 scale. The rig must not be parented
 * yet, so its matrixWorld is character space.
 */
function mountOnBone(rig, bone, pos) {
  rig.model.updateMatrixWorld(true);
  const mount = new THREE.Group();
  new THREE.Matrix4()
    .copy(bone.matrixWorld)
    .invert()
    .multiply(new THREE.Matrix4().makeTranslation(pos.x, pos.y, pos.z))
    .decompose(mount.position, mount.quaternion, mount.scale);
  bone.add(mount);
  return mount;
}

const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/**
 * Swaps the procedural body of a character (character.js) for the rigged
 * glTF of the matching body type, keeping the same public API. The name tag,
 * blob shadow, hair style, accessories and held items keep working.
 * Resolves to true once swapped (or if it already was), false if it kept the
 * procedural body (download failed, character disposed, or a newer upgrade won).
 */
export async function upgradeCharacter(character) {
  if (character.rig) return true;
  // a later call — e.g. a body swap while this one downloads — supersedes this one
  const token = (character.rigToken = (character.rigToken || 0) + 1);
  let body;
  let gltf;
  do {
    body = bodyOf(character.look);
    try {
      gltf = await loadGLB(HUMAN_MODELS[body].url);
    } catch (err) {
      console.warn("[models] keeping the procedural avatar:", err?.message || err);
      return false;
    }
    if (character.disposed || token !== character.rigToken) return false;
    // the look may have changed body while the model downloaded
  } while (bodyOf(character.look) !== body);

  const spec = HUMAN_MODELS[body];
  const scale = spec.height / spec.fileHeight;
  const rig = createRig(gltf, spec.prefix, scale, clipsFor(gltf));
  recolorHuman(rig, character.look);

  const bones = {};
  rig.model.traverse((o) => {
    if (o.isBone || o.name.endsWith("_end")) bones[o.name] = o;
  });
  const glbHair = [];
  rig.model.traverse((o) => {
    if (o.isMesh && HAIR_MATERIALS.has(o.material.name)) glbHair.push(o);
  });
  const restPos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);

  // mounts are measured on the rest pose, before the first mixer update and before
  // the model joins the character group
  rig.model.updateMatrixWorld(true);
  const span = (a, b, fallback) => (a && b ? restPos(a).distanceTo(restPos(b)) : fallback);
  const thigh = span(bones.UpperLegL, bones.LowerLegL, 0.3);
  // ankle → shoe tip (the toe bone ends mid-shoe); geometry is in bind pose = rest pose here
  let foot = 0.22;
  rig.model.traverse((o) => {
    if (!o.isMesh || o.material.name !== "Shoes" || !bones.FootL) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    foot = new THREE.Box3().copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld).max.z - restPos(bones.FootL).z;
  });

  // held items: in the grip of the right hand (between the knuckles and the fingertips, just in front)
  const hand = new THREE.Group();
  hand.scale.setScalar(HELD_SCALE);
  const palm = bones.PalmR;
  if (palm) {
    const grip = restPos(bones.MiddleHandR || palm);
    if (bones.FingersR) grip.lerp(restPos(bones.FingersR), 0.5);
    grip.z += 0.03;
    mountOnBone(rig, palm, grip).add(hand);
  } else {
    rig.model.add(hand);
  }

  // procedural hair / head accessory / back items move onto the head and torso bones
  const att = character.attachments;
  const homes = [];
  if (att && bones.Head && bones.Torso) {
    const headFit = new THREE.Group();
    headFit.scale.setScalar(spec.head.scale);
    mountOnBone(rig, bones.Head, new THREE.Vector3(0, spec.head.y, spec.head.z)).add(headFit);
    const backFit = new THREE.Group();
    backFit.scale.set(...spec.back.scale);
    mountOnBone(rig, bones.Torso, new THREE.Vector3(0, spec.back.y, spec.back.z)).add(backFit);
    for (const [group, fit] of [[att.hair, headFit], [att.accessory, headFit], [att.back, backFit]]) {
      homes.push([group, group.parent]);
      fit.add(group);
    }
  }
  const syncHair = () => {
    // the glTF's own hair is its body's default style; other styles (and hats over it) use the procedural hair
    const own = !att || (character.look.hair === DEFAULT_HAIR[body] && !COVERS_HAIR.has(character.look.accessory));
    for (const o of glbHair) o.visible = own;
    if (att) att.hair.visible = !own;
  };
  syncHair();

  rig.play("Idle", { fade: 0 });

  // hide the procedural mesh, keep tag + shadow + anything else non-body
  const procedural = character.body;
  if (procedural) procedural.visible = false;
  character.group.add(rig.model);

  const st = {
    sitting: false,
    action: null,
    actionT: 0,
    actionDur: 1,
    airborne: false,
    lastY: character.group.position.y,
    vy: 0,
    sitW: 0,
  };
  const procUpdate = character.update.bind(character);
  const procSetLook = character.setLook.bind(character);
  const procSetSitting = character.setSitting?.bind(character);
  const procPlayAction = character.playAction.bind(character);
  const procSetHeld = character.setHeld.bind(character);
  const procDispose = character.dispose?.bind(character);

  character.rig = rig;
  character.modelBody = body;

  character.setHeld = (object3d) => {
    while (hand.children.length) hand.remove(hand.children[0]);
    if (object3d) {
      object3d.rotation.set(0, 0, 0);
      object3d.position.set(0, 0, 0);
      hand.add(object3d);
    }
  };
  // anything the procedural hand already holds moves across
  if (character.handAnchor?.children.length) character.setHeld(character.handAnchor.children[0]);

  /** back to the procedural body: attachments and the held item go home */
  const uninstall = () => {
    const item = hand.children[0] || null;
    character.group.remove(rig.model);
    for (const [group, parent] of homes) parent.add(group);
    if (att) att.hair.visible = true;
    rig.dispose();
    if (procedural) procedural.visible = true;
    character.update = procUpdate;
    character.setLook = procSetLook;
    character.playAction = procPlayAction;
    character.setHeld = procSetHeld;
    if (procSetSitting) character.setSitting = procSetSitting;
    if (procDispose) character.dispose = procDispose;
    character.rig = null;
    character.modelBody = null;
    procSetHeld(item);
  };

  character.setLook = (newLook) => {
    procSetLook(newLook);
    if (bodyOf(character.look) !== body) {
      // body type changed: rebuild with the other model (it picks the held item up again)
      uninstall();
      upgradeCharacter(character);
      return;
    }
    recolorHuman(rig, character.look);
    syncHair();
  };

  character.setSitting = (v) => {
    procSetSitting?.(v);
    st.sitting = !!v;
  };

  character.playAction = (name, duration = 1.2) => {
    procPlayAction(name, duration);
    st.action = name;
    st.actionT = duration;
    st.actionDur = Math.max(0.2, duration);
  };

  if (procDispose) {
    character.dispose = () => {
      // detach the rig first: its geometry is shared with every avatar of this body type
      uninstall();
      procDispose();
    };
  }

  /* ---- pose overlays ----
   * The mixer only writes a bone when its clip value changed since the last frame,
   * so anything layered on top is undone before the next mixer update. */
  const saved = new Map();
  const touched = new Set();
  const touch = (b) => {
    let s = saved.get(b);
    if (!s) saved.set(b, (s = { p: new THREE.Vector3(), q: new THREE.Quaternion() }));
    if (!touched.has(b)) {
      s.p.copy(b.position);
      s.q.copy(b.quaternion);
      touched.add(b);
    }
  };
  const restorePose = () => {
    for (const b of touched) {
      const s = saved.get(b);
      b.position.copy(s.p);
      b.quaternion.copy(s.q);
    }
    touched.clear();
  };
  /** Rotates a bone about its joint by `angle` around a character-space axis. */
  const turn = (b, ax, ay, az, angle) => {
    if (!b || !angle) return;
    touch(b);
    _q.identity();
    for (let o = b.parent; o && o !== rig.model; o = o.parent) _q.premultiply(o.quaternion);
    _v.set(ax, ay, az).applyQuaternion(_q.invert());
    b.quaternion.premultiply(_qa.setFromAxisAngle(_v, angle));
  };
  /** Character-space position of a node in the current pose. */
  const posOf = (o, out) => {
    out.set(0, 0, 0);
    for (; o && o !== character.group; o = o.parent) {
      o.updateMatrix();
      out.applyMatrix4(o.matrix);
    }
    return out;
  };
  /** Moves a bone by a character-space offset (metres). */
  const shift = (b, d) => {
    if (!b) return;
    touch(b);
    const chain = [];
    for (let o = b.parent; o && o !== character.group; o = o.parent) chain.push(o);
    for (let i = chain.length - 1; i >= 0; i--) {
      d.applyQuaternion(_q.copy(chain[i].quaternion).invert()).divide(chain[i].scale);
    }
    b.position.add(d);
  };

  /**
   * The Sitting clip plants the feet flat at the root, made for a 0.45m seat. On a
   * taller one (root above the floor) the feet would float: slope the thighs down a
   * little (shins stay upright, the feet — IK bones — come along) and point the toes
   * for the rest, like legs dangling from a high bench. Seats stand on the museum
   * floor (y = 0).
   */
  const reachFloor = (w) => {
    const need = Math.max(0, character.group.position.y + spec.sit.lift * w);
    const tip = Math.min(THIGH_TIP, Math.asin(Math.min(1, need / thigh)));
    const rest = Math.max(0, need - thigh * Math.sin(tip));
    const toe = Math.min(TOE_POINT, Math.asin(Math.min(1, rest / foot)));
    if (tip < 0.001) return;
    for (const s of ["L", "R"]) {
      const end = bones[`LowerLeg${s}_end`];
      if (end) posOf(end, _a);
      turn(bones[`UpperLeg${s}`], 1, 0, 0, tip * w);
      turn(bones[`LowerLeg${s}`], 1, 0, 0, -tip * w);
      if (end) shift(bones[`Foot${s}`], posOf(end, _b).sub(_a));
      turn(bones[`Foot${s}`], 1, 0, 0, toe * w);
    }
  };

  character.update = (dt, opts = {}) => {
    // the procedural rig still runs (cheap) so its state stays coherent
    procUpdate(dt, opts);
    restorePose();
    const speed = Math.max(0, opts.speed ?? 0);
    const mps = speed * MAX_SPEED;
    if (st.actionT > 0) st.actionT -= dt;
    const anim = opts.anim;

    // a new take-off: the first airborne frame, or rising again after a landing that
    // no frame saw (a buffered jump, or remote snapshots that skipped it)
    const y = character.group.position.y;
    const vy = dt > 0 ? (y - st.lastY) / dt : 0;
    const takeoff = anim === "jump" && (!st.airborne || (st.vy <= 0 && vy > 0.5));
    st.airborne = anim === "jump";
    st.lastY = y;
    st.vy = vy;

    const running = rig.current === "Run" ? mps > RUN_FROM - 0.3 : mps > RUN_FROM;
    if (st.sitting || anim === "sit") {
      rig.play("Sitting", { fade: 0.35, once: true });
    } else if (anim === "jump") {
      rig.play("Jump", { fade: 0.12, once: true, restart: takeoff, startAt: JUMP_SKIP });
    } else if (st.actionT > 0 && st.action === "cheer") {
      rig.play("Clapping", { fade: 0.2 });
    } else if (anim === "run" || (speed > 0.06 && running)) {
      // match the clip's foot speed to the ground speed so the feet do not skate
      rig.play("Run", { fade: 0.2, timeScale: clamp(mps / spec.runSpeed, 0.7, 2.4) });
    } else if (speed > 0.06 || anim === "walk") {
      rig.play("Walk", { fade: 0.22, timeScale: clamp(mps / spec.walkSpeed, 0.5, 1.6) });
    } else {
      rig.play("Idle", { fade: 0.3 });
    }
    rig.update(dt);

    // sitting: lift the thighs onto the seat top and the hips over the seat point
    st.sitW = damp(st.sitW, rig.current === "Sitting" ? 1 : 0, 9, dt);
    if (st.sitW < 0.001) st.sitW = 0;
    rig.model.position.set(0, spec.sit.lift * st.sitW, spec.sit.forward * st.sitW);
    if (st.sitW > 0) reachFloor(st.sitW);

    // arm poses layered on top of the clip (character space: +x left, +y up, +z forward)
    if (st.actionT > 0 && !st.sitting) {
      const el = st.actionDur - st.actionT;
      const k0 = clamp(Math.min(el / 0.22, st.actionT / 0.3), 0, 1);
      const k = k0 * k0 * (3 - 2 * k0);
      if (st.action === "wave") {
        turn(bones.UpperArmR, 0, 0, 1, -2.5 * k);
        turn(bones.LowerArmR, 0, 0, 1, -(0.35 + Math.sin(el * 11) * 0.45) * k);
        turn(bones.Head, 0, 1, 0, -0.15 * k);
      } else if (st.action === "eat" || st.action === "photo") {
        // hand (and whatever it holds) up to the face; photo uses both hands
        for (const [s, side] of st.action === "photo" ? [["R", 1], ["L", -1]] : [["R", 1]]) {
          turn(bones[`UpperArm${s}`], 1, 0, 0, -0.3 * k);
          turn(bones[`LowerArm${s}`], 1, 0, 0, -1.9 * k);
          turn(bones[`UpperArm${s}`], 0, 1, 0, 0.65 * side * k);
        }
        if (st.action === "eat") turn(bones.Head, 1, 0, 0, (0.12 + Math.sin(el * 9) * 0.06) * k);
      } else if (st.action === "roar") {
        // claws out (arms forward, wrists bent down), head thrown back
        for (const [s, side] of [["R", 1], ["L", -1]]) {
          turn(bones[`UpperArm${s}`], 1, 0, 0, -1.0 * k);
          turn(bones[`UpperArm${s}`], 0, 0, 1, -0.35 * side * k);
          turn(bones[`LowerArm${s}`], 1, 0, 0, -0.55 * k);
          turn(bones[`Palm${s}`], 1, 0, 0, 0.7 * k);
        }
        turn(bones.Torso, 1, 0, 0, -0.12 * k);
        turn(bones.Head, 1, 0, 0, -0.4 * k);
      }
    }

    // held props ride the grip but stay upright — nobody eats an ice cream upside down
    _q.identity();
    for (let o = hand.parent; o && o !== rig.model; o = o.parent) _q.premultiply(o.quaternion);
    hand.quaternion.copy(_q.invert());
  };

  return true;
}

/** Start downloading the common models early. */
export function preloadModels(kinds = ["male", "female"]) {
  for (const k of kinds) {
    const spec = HUMAN_MODELS[k];
    if (spec) loadGLB(spec.url).catch(() => {});
  }
}
