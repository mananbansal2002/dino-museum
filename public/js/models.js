import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { DEFAULT_HAIR } from "./character.js";
import { clamp, damp } from "./util.js";

/**
 * Rigged glTF visitor avatars: the realistic Microsoft Rocketbox pair (MIT, see
 * public/models/humans/LICENSE-rocketbox.txt), with the low-poly Quaternius pair
 * (CC0, poly.pizza — see public/models/CREDITS.md) as a fallback if one fails to load.
 *
 * Every model is loaded once and cloned per instance. Callers always get a
 * procedural fallback first; the glTF swaps in when it has loaded, so the
 * museum still works if no model downloads at all.
 *
 * NB: GLTFLoader names nodes with PropertyBinding.sanitizeNodeName, which strips
 * "." and turns spaces into "_" — "Palm.R" is "PalmR" and "Bip01 R Hand" is
 * "Bip01_R_Hand" at runtime.
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
 * Per model, measured in character space (metres, +y up, +z forward, +x the avatar's left):
 *   height / scale: standing height and the factor that brings the file to metres
 *   clips: game role → clip. A string loops; { name, from, to } plays that stretch once
 *     (actions, the sit-down) — jump is optional, without it the jump is a procedural tuck
 *   bones: role → bone name, "{s}" is the side (L / R). calfEnd marks IK feet (Quaternius),
 *     which must be carried along when the leg above them turns
 *   hand: where held props sit — offset in the hand bone's own frame, or (no offset) between
 *     the knuckles and the fingertips. scale shrinks props to the hand, drop lowers them so
 *     the fist closes round the middle of a cone rather than its tip
 *   toFace: the eat / photo arm pose — upper arm forward, forearm folded, upper arm inward (rad)
 *   recolor: "tint" (one baked texture: lean the body toward the shirt colour, hair by
 *     multiply) or "parts" (flat-coloured materials per garment)
 *   head / back: where the procedural hair + head accessory (centred on the head) and the
 *     back group (cape / backpack, origin at the spine base) sit, and how much to shrink
 *     them — the procedural character has a big stylised head and a wide torso
 *   sit: seats put the root SIT_SEAT_OFFSET (0.45 m) below their top. lift / forward move the
 *     seated model so its seat bones land on that; hipY is the hips' height in the sit clip
 *     (the sit-down blends the offset in as the hips drop towards it)
 *   walkSpeed / runSpeed: how fast a planted foot travels at timeScale 1 (m/s);
 *     runFrom: above this ground speed the run clip fits the feet better than a sped-up walk
 */
const ROCKETBOX_BONES = {
  hips: "Bip01_Pelvis",
  spine: "Bip01_Spine1",
  head: "Bip01_Head",
  upperArm: "Bip01_{s}_UpperArm",
  foreArm: "Bip01_{s}_Forearm",
  hand: "Bip01_{s}_Hand",
  thigh: "Bip01_{s}_Thigh",
  calf: "Bip01_{s}_Calf",
  foot: "Bip01_{s}_Foot",
  toe: "Bip01_{s}_Toe0",
};
const QUATERNIUS_BONES = {
  hips: "Body",
  spine: "Torso",
  head: "Head",
  upperArm: "UpperArm{s}",
  foreArm: "LowerArm{s}",
  hand: "Palm{s}",
  thigh: "UpperLeg{s}",
  calf: "LowerLeg{s}",
  calfEnd: "LowerLeg{s}_end",
  foot: "Foot{s}",
};

export const HUMAN_MODELS = {
  male: {
    url: "/models/humans/male-real.glb",
    height: 1.82,
    scale: 1,
    clips: {
      idle: "Idle",
      walk: "Walk",
      run: "Run",
      sit: "Sit",
      // the first 0.2s is a standing pause; the clip starts 0.46m in front of the seat
      sitDown: { name: "SitDown", from: 0.2 },
      wave: { name: "Wave", from: 0, to: 2.3 },
      cheer: { name: "Cheer", from: 2, to: 4 },
      clap: { name: "Clap", from: 0.3, to: 3.5 },
    },
    bones: ROCKETBOX_BONES,
    hand: { bone: "Bip01_R_Hand", offset: [0.09, -0.01, 0.05], scale: 0.32, drop: 0.12 },
    toFace: [-1.0, -2.2, 0.55],
    recolor: { kind: "tint", body: "Male_Body", hair: "Male_HairLashes" },
    hairMaterials: ["Male_HairLashes"],
    head: { y: 1.695, z: 0.02, scale: 0.5 },
    back: { y: 1.0, z: 0.0, scale: [0.6, 0.82, 0.62] },
    sit: { lift: -0.01, forward: 0.08, hipY: 0.591 },
    walkSpeed: 1.02,
    runSpeed: 2.74,
    runFrom: 2.0,
    fallback: "maleLow",
  },
  female: {
    url: "/models/humans/female-real.glb",
    height: 1.74,
    scale: 1,
    clips: {
      idle: "Idle",
      walk: "Walk",
      run: "Run",
      sit: "Sit",
      sitDown: { name: "SitDown", from: 1.2 },
      wave: { name: "Wave", from: 0.1, to: 3.1 },
      cheer: { name: "Cheer", from: 2.5, to: 5.2 },
      clap: { name: "Clap", from: 1.5, to: 6 },
    },
    bones: ROCKETBOX_BONES,
    hand: { bone: "Bip01_R_Hand", offset: [0.09, -0.01, 0.05], scale: 0.3, drop: 0.12 },
    toFace: [-1.0, -2.2, 0.55],
    recolor: { kind: "tint", body: "Female_Body", hair: "Female_HairLashes" },
    hairMaterials: ["Female_HairLashes"],
    head: { y: 1.62, z: 0.0, scale: 0.48 },
    back: { y: 1.0, z: 0.0, scale: [0.62, 0.78, 0.58] },
    sit: { lift: -0.03, forward: 0.08, hipY: 0.611 },
    walkSpeed: 1.23,
    runSpeed: 2.61,
    runFrom: 2.0,
    fallback: "femaleLow",
  },
  maleLow: {
    url: "/models/humans/male.glb",
    prefix: "Man_",
    height: 1.8,
    scale: 1.8 / 4.84,
    clips: {
      idle: "Idle",
      walk: "Walk",
      run: "Run",
      sit: "Sitting",
      // the wind-up crouch (0–0.25s) happens before take-off; physics has already left the ground
      jump: { name: "Jump", from: 0.25 },
      cheer: "Clapping",
      clap: "Clapping",
    },
    bones: QUATERNIUS_BONES,
    hand: { bone: "PalmR", scale: 0.6, drop: 0 },
    toFace: [-0.3, -1.9, 0.65],
    recolor: { kind: "parts" },
    hairMaterials: ["Hair", "Hair2", "HairBase"],
    head: { y: 1.65, z: 0.065, scale: 0.52 },
    back: { y: 0.93, z: 0.025, scale: [0.57, 0.97, 0.56] },
    // the Sitting clip rests the thighs ~0.40m above the root and the hips ~0.22m behind it
    sit: { lift: 0.05, forward: 0.2 },
    walkSpeed: 1.66,
    runSpeed: 3.6,
    runFrom: 2.4,
  },
  femaleLow: {
    url: "/models/humans/female.glb",
    prefix: "Female_",
    height: 1.72,
    scale: 1.72 / 4.65,
    clips: {
      idle: "Idle",
      walk: "Walk",
      run: "Run",
      sit: "Sitting",
      jump: { name: "Jump", from: 0.25 },
      cheer: "Clapping",
      clap: "Clapping",
    },
    bones: QUATERNIUS_BONES,
    hand: { bone: "PalmR", scale: 0.6, drop: 0 },
    toFace: [-0.3, -1.9, 0.65],
    recolor: { kind: "parts" },
    hairMaterials: ["Hair", "Hair2", "HairBase"],
    head: { y: 1.578, z: 0.043, scale: 0.55 },
    back: { y: 0.88, z: 0.03, scale: [0.72, 0.96, 0.69] },
    sit: { lift: 0.062, forward: 0.2 },
    walkSpeed: 1.66,
    runSpeed: 3.6,
    runFrom: 2.4,
  },
};

/** Turns a glTF clip name like "Armature|TRex_Walk" into "Walk" (names without a prefix stay as they are). */
function clipKey(name, prefix) {
  const tail = name.split("|").pop();
  if (!prefix) return tail;
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
/**
 * The run clip's playback-rate ceiling. A sprint (8.4 m/s) asks for ~3× on the Rocketbox
 * run; past this the legs blur, so the feet skate a little instead.
 */
const RUN_RATE_MAX = 2.8;
const WALK_RATE_MAX = 2.0;
/** sit-down: how much faster than authored (the Rocketbox clips are slow and deliberate) */
const SIT_DOWN_RATE = 1.5;
/** clip actions (wave, cheer, clap) speed up by at most this to fit the requested duration */
const ACTION_RATE_MAX = 1.5;
/** while seated, how far the thighs may tilt to meet the floor, then the ankles bend (rad) */
const THIGH_TIP = 0.24;
const TOE_POINT = 0.8;
const TOE_LIFT = 0.45;
/** holding something: the forearm comes up so the prop is carried in front, not dangled */
const CARRY_LIFT = 1.15;
/** head accessories that sit over the glTF's own hair, so the procedural (capped) hair is used instead */
const COVERS_HAIR = new Set(["cap", "headphones"]);
/** actions drawn on top of the clips, for models without a clip of their own for them */
const OVERLAY_ACTIONS = new Set(["wave", "eat", "photo", "roar"]);
const SIDES = ["L", "R"];

const bodyOf = (look) => (look.body === "female" ? "female" : "male");

/* ---- recolouring ---- */

/** Flat-coloured garments (Quaternius): every material is one colour. */
function recolorParts(rig, look) {
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

/** body texture → how far it leans toward the shirt colour (clothes and skin share one map) */
const SHIRT_TINT = 0.25;
/** a multiply tint may brighten a dark hair texture by at most this much */
const HAIR_GAIN_MAX = 4;
const _white = new THREE.Color(1, 1, 1);
const _tint = new THREE.Color();

/**
 * Baked textures (Rocketbox): skin tones stay as photographed. The body leans a little
 * toward the shirt colour; the hair is multiplied so the texture's average lands on the
 * chosen colour (a straight multiply could only ever darken it).
 */
function recolorTint(rig, look, spec) {
  const body = rig.materials.get(spec.recolor.body);
  if (body && look.shirt) body.color.copy(_white).lerp(_tint.set(look.shirt), SHIRT_TINT);
  const hair = rig.materials.get(spec.recolor.hair);
  if (hair && look.hairColor) {
    const avg = textureAverage(hair.map);
    hair.color.set(look.hairColor);
    if (avg) {
      hair.color.r = Math.min(HAIR_GAIN_MAX, hair.color.r / Math.max(avg.r, 0.01));
      hair.color.g = Math.min(HAIR_GAIN_MAX, hair.color.g / Math.max(avg.g, 0.01));
      hair.color.b = Math.min(HAIR_GAIN_MAX, hair.color.b / Math.max(avg.b, 0.01));
    }
  }
}

const RECOLOR = { parts: recolorParts, tint: recolorTint };

/** The mean linear colour of a texture's opaque texels (cached per image), or null if unreadable. */
const textureAverages = new WeakMap();
function textureAverage(tex) {
  const img = tex?.image;
  if (!img) return null;
  if (textureAverages.has(img)) return textureAverages.get(img);
  let avg = null;
  try {
    const n = 64;
    const c = document.createElement("canvas");
    c.width = c.height = n;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    // GLTFLoader decodes to an ImageBitmap with flipY: false — orientation does not matter for a mean
    ctx.drawImage(img, 0, 0, n, n);
    const px = ctx.getImageData(0, 0, n, n).data;
    const sum = [0, 0, 0];
    let count = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 128) continue;
      sum[0] += px[i];
      sum[1] += px[i + 1];
      sum[2] += px[i + 2];
      count++;
    }
    if (count) {
      avg = new THREE.Color().setRGB(sum[0] / count / 255, sum[1] / count / 255, sum[2] / count / 255, THREE.SRGBColorSpace);
    }
  } catch {
    avg = null;
  }
  textureAverages.set(img, avg);
  return avg;
}

/**
 * The clips as the game plays them. The Quaternius Jump lifts the whole body ~0.43m
 * in place, which would stack on top of the physics jump: pin the root bone ("Body")
 * and the feet (separate IK bones under the armature root, so they must drop by the
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

/** A clip role from the spec as { name, from, to } (to: the clip's end when not given). */
function clipOf(spec, rig, role) {
  const c = spec.clips[role];
  if (!c) return null;
  const name = typeof c === "string" ? c : c.name;
  const action = rig.actions[name];
  if (!action) return null;
  const dur = action.getClip().duration;
  return { name, from: Math.min(c.from ?? 0, dur), to: Math.min(c.to ?? dur, dur) };
}

/**
 * A group under `bone` placed, for the rig's current (rest) pose, at the character-space
 * point `pos` with no rotation and unit scale — so things built in character space ride
 * the bone whatever its roll and the armature's scale. The rig must not be parented
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

/** Loads the body's model, or its low-poly stand-in if that fails. */
async function loadHuman(body) {
  let spec = HUMAN_MODELS[body];
  try {
    return { spec, gltf: await loadGLB(spec.url) };
  } catch (err) {
    if (!spec.fallback) throw err;
    console.warn("[models] using the low-poly avatar:", err?.message || err);
    spec = HUMAN_MODELS[spec.fallback];
    return { spec, gltf: await loadGLB(spec.url) };
  }
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
  let loaded;
  do {
    body = bodyOf(character.look);
    try {
      loaded = await loadHuman(body);
    } catch (err) {
      console.warn("[models] keeping the procedural avatar:", err?.message || err);
      return false;
    }
    if (character.disposed || token !== character.rigToken) return false;
    // the look may have changed body while the model downloaded
  } while (bodyOf(character.look) !== body);

  const { spec, gltf } = loaded;
  const rig = createRig(gltf, spec.prefix, spec.scale, clipsFor(gltf));
  const recolor = () => RECOLOR[spec.recolor.kind](rig, character.look, spec);
  recolor();

  const named = {};
  rig.model.traverse((o) => {
    if (o.isBone || o.name.endsWith("_end")) named[o.name] = o;
  });
  /** bone for a role in the spec ("upperArm", "R" → "Bip01_R_UpperArm") */
  const boneOf = (role, side = "") => (spec.bones[role] ? named[spec.bones[role].replace("{s}", side)] : undefined);
  const head = boneOf("head");
  const spine = boneOf("spine");
  const hips = boneOf("hips");
  const arm = {};
  const leg = {};
  for (const s of SIDES) {
    arm[s] = { upper: boneOf("upperArm", s), fore: boneOf("foreArm", s), hand: boneOf("hand", s) };
    leg[s] = { thigh: boneOf("thigh", s), calf: boneOf("calf", s), calfEnd: boneOf("calfEnd", s), foot: boneOf("foot", s), toe: boneOf("toe", s) };
  }
  const glbHair = [];
  rig.model.traverse((o) => {
    if (o.isMesh && spec.hairMaterials.includes(o.material.name)) glbHair.push(o);
  });
  const restPos = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);

  // mounts are measured on the rest pose, before the first mixer update and before
  // the model joins the character group
  rig.model.updateMatrixWorld(true);
  const span = (a, b, fallback) => (a && b ? restPos(a).distanceTo(restPos(b)) : fallback);
  const thighLen = span(leg.L.thigh, leg.L.calf, 0.3);
  // ankle → toe tip, for pointing / lifting the toes
  let footLen = leg.L.toe ? span(leg.L.foot, leg.L.toe, 0.15) + 0.05 : 0.22;
  if (!leg.L.toe) {
    // the Quaternius toe bone ends mid-shoe: measure to the shoe tip (bind pose = rest pose here)
    rig.model.traverse((o) => {
      if (!o.isMesh || o.material.name !== "Shoes" || !leg.L.foot) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      footLen = new THREE.Box3().copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld).max.z - restPos(leg.L.foot).z;
    });
  }
  // how far the reference point of each foot (toe, else ankle) sits above the sole when standing
  for (const s of SIDES) leg[s].sole = leg[s].toe || leg[s].foot ? restPos(leg[s].toe || leg[s].foot).y : 0;
  const standHipY = hips ? restPos(hips).y : 0;

  // held items: in the grip of the right hand, kept upright (see the end of update)
  const hand = new THREE.Group();
  const grip = new THREE.Group();
  hand.scale.setScalar(spec.hand.scale);
  grip.position.y = -spec.hand.drop;
  hand.add(grip);
  const palm = named[spec.hand.bone];
  if (palm && spec.hand.offset) {
    const mount = new THREE.Group();
    mount.position.fromArray(spec.hand.offset);
    palm.add(mount);
    mount.add(hand);
  } else if (palm) {
    // between the knuckles and the fingertips, just in front
    const at = restPos(named.MiddleHandR || palm);
    if (named.FingersR) at.lerp(restPos(named.FingersR), 0.5);
    at.z += 0.03;
    mountOnBone(rig, palm, at).add(hand);
  } else {
    rig.model.add(hand);
  }

  // procedural hair / head accessory / back items move onto the head and spine bones
  const att = character.attachments;
  const homes = [];
  if (att && head && spine) {
    const headFit = new THREE.Group();
    headFit.scale.setScalar(spec.head.scale);
    mountOnBone(rig, head, new THREE.Vector3(0, spec.head.y, spec.head.z)).add(headFit);
    const backFit = new THREE.Group();
    backFit.scale.set(...spec.back.scale);
    mountOnBone(rig, spine, new THREE.Vector3(0, spec.back.y, spec.back.z)).add(backFit);
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

  const clips = {};
  for (const role of Object.keys(spec.clips)) clips[role] = clipOf(spec, rig, role);
  const alreadySeated = !!character.isSitting?.();
  rig.play(clips[alreadySeated ? "sit" : "idle"]?.name || clips.idle.name, { fade: 0 });

  // hide the procedural mesh, keep tag + shadow + anything else non-body
  const procedural = character.body;
  if (procedural) procedural.visible = false;
  character.group.add(rig.model);

  const st = {
    sitting: alreadySeated,
    sitDown: false,
    action: null,
    actionT: 0,
    actionDur: 1,
    // a clip action (wave / cheer / clap): its clip stretch and rate, and whether it still has to start
    clip: null,
    clipRate: 1,
    clipStart: false,
    airborne: false,
    lastY: character.group.position.y,
    vy: 0,
    sitW: alreadySeated ? 1 : 0,
    tuck: 0,
    carry: 0,
  };
  const procUpdate = character.update.bind(character);
  const procSetLook = character.setLook.bind(character);
  const procSetSitting = character.setSitting?.bind(character);
  const procPlayAction = character.playAction.bind(character);
  const procSetHeld = character.setHeld.bind(character);
  const procDispose = character.dispose?.bind(character);

  character.rig = rig;
  character.modelBody = body;
  character.modelSpec = spec;

  character.setHeld = (object3d) => {
    while (grip.children.length) grip.remove(grip.children[0]);
    if (object3d) {
      object3d.rotation.set(0, 0, 0);
      object3d.position.set(0, 0, 0);
      grip.add(object3d);
    }
  };
  // anything the procedural hand already holds moves across
  if (character.handAnchor?.children.length) character.setHeld(character.handAnchor.children[0]);

  /** back to the procedural body: attachments and the held item go home */
  const uninstall = () => {
    const item = grip.children[0] || null;
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
    character.modelSpec = null;
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
    recolor();
    syncHair();
  };

  character.setSitting = (v) => {
    procSetSitting?.(v);
    // a fresh sit plays the sit-down first; standing up cuts straight back to the feet
    if (v && !st.sitting) st.sitDown = !!clips.sitDown;
    if (!v) st.sitDown = false;
    st.sitting = !!v;
  };

  character.playAction = (name, duration = 1.2) => {
    procPlayAction(name, duration);
    st.action = name;
    const seg = clips[name];
    if (seg && seg.to > seg.from) {
      // the clip sets the pace: sped up a little to fit the requested time, never cut short
      const len = seg.to - seg.from;
      st.clip = seg;
      st.clipRate = clamp(len / Math.max(0.2, duration), 1, ACTION_RATE_MAX);
      st.clipStart = true;
      duration = len / st.clipRate;
    } else {
      st.clip = null;
      if (!OVERLAY_ACTIONS.has(name)) st.action = null;
    }
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
   * Seated feet meet the museum floor (y = 0) whatever the seat height. The sit clips
   * plant them for one particular seat: on a taller one they would float, on a lower one
   * sink. Tilt the thigh at the hip (the shin keeps its angle, so the foot rises or falls
   * with the knee — IK feet are carried along), then bend the ankle for the rest, like
   * legs dangling from a high bench or toes tucked under a low one.
   */
  const lowPoint = (L) => posOf(L.toe || L.foot, _a).y - L.sole;
  const reachFloor = (w) => {
    const floor = -character.group.position.y;
    for (const s of SIDES) {
      const L = leg[s];
      if (!L.thigh || !L.calf || !L.foot) continue;
      const gap = lowPoint(L) - floor; // + floating, - sinking
      if (Math.abs(gap) < 0.004) continue;
      const tip = clamp(Math.asin(clamp(gap / thighLen, -1, 1)), -THIGH_TIP, THIGH_TIP) * w;
      if (L.calfEnd) posOf(L.calfEnd, _b);
      turn(L.thigh, 1, 0, 0, tip);
      turn(L.calf, 1, 0, 0, -tip);
      if (L.calfEnd) shift(L.foot, posOf(L.calfEnd, _v).sub(_b));
      const rest = lowPoint(L) - floor;
      turn(L.foot, 1, 0, 0, clamp(Math.asin(clamp(rest / footLen, -1, 1)), -TOE_LIFT, TOE_POINT) * w);
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
    const moving = speed > 0.06 || anim === "walk" || anim === "run";
    // walking off (or jumping) ends a clip action: its legs stand still
    if (st.clip && (moving || anim === "jump")) st.actionT = 0;
    if (st.actionT <= 0) st.clip = null;

    // a new take-off: the first airborne frame, or rising again after a landing that
    // no frame saw (a buffered jump, or remote snapshots that skipped it)
    const y = character.group.position.y;
    const vy = dt > 0 ? (y - st.lastY) / dt : 0;
    const takeoff = anim === "jump" && (!st.airborne || (st.vy <= 0 && vy > 0.5));
    st.airborne = anim === "jump";
    st.lastY = y;
    st.vy = vy;

    const running = rig.current === clips.run.name ? mps > spec.runFrom - 0.3 : mps > spec.runFrom;
    const seated = st.sitting || anim === "sit";
    if (seated) {
      const down = st.sitDown && clips.sitDown;
      if (down) {
        rig.play(down.name, { fade: 0.2, once: true, timeScale: SIT_DOWN_RATE, startAt: down.from });
        const a = rig.actions[down.name];
        if (a.paused || a.time >= down.to - 0.05) st.sitDown = false;
      }
      if (!st.sitDown) rig.play(clips.sit.name, { fade: down ? 0.3 : 0.35 });
    } else if (anim === "jump") {
      if (clips.jump) {
        rig.play(clips.jump.name, { fade: 0.12, once: true, restart: takeoff, startAt: clips.jump.from });
      } else {
        // no jump clip: hold on to the stride (slowed right down) and tuck the legs below
        if (![clips.walk.name, clips.run.name, clips.idle.name].includes(rig.current)) rig.play(clips.idle.name, { fade: 0.15 });
        const a = rig.actions[rig.current];
        if (a) a.timeScale = damp(a.timeScale, 0.2, 8, dt);
      }
    } else if (st.clip) {
      rig.play(st.clip.name, { fade: 0.2, once: true, timeScale: st.clipRate, restart: st.clipStart, startAt: st.clip.from });
      st.clipStart = false;
    } else if (anim === "run" || (speed > 0.06 && running)) {
      // match the clip's foot speed to the ground speed so the feet do not skate
      rig.play(clips.run.name, { fade: 0.2, timeScale: clamp(mps / spec.runSpeed, 0.7, RUN_RATE_MAX) });
    } else if (moving) {
      rig.play(clips.walk.name, { fade: 0.22, timeScale: clamp(mps / spec.walkSpeed, 0.5, WALK_RATE_MAX) });
    } else {
      rig.play(clips.idle.name, { fade: rig.current === clips.sit.name ? 0.2 : 0.3 });
    }
    rig.update(dt);

    // sitting: the seat bones onto the seat top. With the sit-down clip the offset follows
    // the hips down (it starts standing on the floor in front of the seat); otherwise it eases in
    const inSeat = rig.current === clips.sit.name || (clips.sitDown && rig.current === clips.sitDown.name);
    if (inSeat && spec.sit.hipY && hips) {
      const hipY = posOf(hips, _a).y - rig.model.position.y;
      st.sitW = clamp((standHipY - hipY) / (standHipY - spec.sit.hipY), 0, 1);
    } else {
      st.sitW = damp(st.sitW, inSeat ? 1 : 0, 9, dt);
      if (st.sitW < 0.001) st.sitW = 0;
    }
    const w = st.sitW;
    // sitting down: until the hips drop, the feet stay on the floor even if the root is up on a seat
    const ground = inSeat && spec.sit.hipY ? y * (1 - w) : 0;
    rig.model.position.set(0, spec.sit.lift * w - ground, spec.sit.forward * w);
    if (w > 0 && inSeat) reachFloor(w);

    // airborne without a jump clip: knees up, arms out a little
    st.tuck = damp(st.tuck, anim === "jump" && !clips.jump ? 1 : 0, 12, dt);
    if (st.tuck < 0.001) st.tuck = 0;
    if (st.tuck > 0 && !seated) {
      const k = st.tuck;
      turn(leg.L.thigh, 1, 0, 0, -0.5 * k);
      turn(leg.L.calf, 1, 0, 0, 0.85 * k);
      turn(leg.R.thigh, 1, 0, 0, -0.2 * k);
      turn(leg.R.calf, 1, 0, 0, 0.45 * k);
      turn(arm.L.upper, 0, 0, 1, 0.3 * k);
      turn(arm.R.upper, 0, 0, 1, -0.3 * k);
    }

    // arm poses layered on top of the clip (character space: +x left, +y up, +z forward)
    const overlay = st.actionT > 0 && !st.clip && !st.sitting ? st.action : null;
    // carrying: the hand with the prop comes forward, unless an action has the arm
    const carry = grip.children.length > 0 && !st.clip && overlay !== "eat" && overlay !== "photo" && overlay !== "wave";
    st.carry = damp(st.carry, carry ? 1 : 0, 8, dt);
    if (st.carry > 0.001) {
      turn(arm.R.upper, 1, 0, 0, -0.2 * st.carry);
      turn(arm.R.fore, 1, 0, 0, -CARRY_LIFT * st.carry);
      // elbow in, so the hand comes round in front of the body rather than out to the side
      turn(arm.R.upper, 0, 1, 0, 0.3 * st.carry);
    }
    if (overlay) {
      const el = st.actionDur - st.actionT;
      const k0 = clamp(Math.min(el / 0.22, st.actionT / 0.3), 0, 1);
      const k = k0 * k0 * (3 - 2 * k0);
      if (overlay === "wave") {
        turn(arm.R.upper, 0, 0, 1, -2.5 * k);
        turn(arm.R.fore, 0, 0, 1, -(0.35 + Math.sin(el * 11) * 0.45) * k);
        turn(head, 0, 1, 0, -0.15 * k);
      } else if (overlay === "eat" || overlay === "photo") {
        // hand (and whatever it holds) up to the face; photo uses both hands
        const [up, fold, inward] = spec.toFace;
        for (const [s, side] of overlay === "photo" ? [["R", 1], ["L", -1]] : [["R", 1]]) {
          turn(arm[s].upper, 1, 0, 0, up * k);
          turn(arm[s].fore, 1, 0, 0, fold * k);
          turn(arm[s].upper, 0, 1, 0, inward * side * k);
        }
        if (overlay === "eat") turn(head, 1, 0, 0, (0.12 + Math.sin(el * 9) * 0.06) * k);
      } else if (overlay === "roar") {
        // claws out (arms forward, wrists bent down), head thrown back
        for (const [s, side] of [["R", 1], ["L", -1]]) {
          turn(arm[s].upper, 1, 0, 0, -1.0 * k);
          turn(arm[s].upper, 0, 0, 1, -0.35 * side * k);
          turn(arm[s].fore, 1, 0, 0, -0.55 * k);
          turn(arm[s].hand, 1, 0, 0, 0.7 * k);
        }
        turn(spine, 1, 0, 0, -0.12 * k);
        turn(head, 1, 0, 0, -0.4 * k);
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
