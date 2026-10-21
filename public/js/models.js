import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

/**
 * Rigged glTF visitor avatars (CC0, Quaternius via poly.pizza — see public/models/CREDITS.md).
 *
 * Every model is loaded once and cloned per instance. Callers always get a
 * procedural fallback first; the glTF swaps in when it has loaded, so the
 * museum still works if a model fails to download.
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

export const HUMAN_MODELS = {
  male: { url: "/models/humans/male.glb", prefix: "Man_", fileHeight: 4.84, height: 1.8 },
  female: { url: "/models/humans/female.glb", prefix: "Female_", fileHeight: 4.65, height: 1.72 },
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
function createRig(gltf, prefix, scale) {
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
  for (const clip of gltf.animations) {
    actions[clipKey(clip.name, prefix)] = mixer.clipAction(clip);
  }

  let current = null;
  const rig = {
    model,
    mixer,
    actions,
    materials,
    get current() {
      return current;
    },
    has: (key) => !!actions[key],
    /** Cross-fades to a clip. once: play a single time and hold the last frame. */
    play(key, { fade = 0.25, once = false, timeScale = 1, restart = false } = {}) {
      const next = actions[key];
      if (!next) return false;
      next.timeScale = timeScale;
      if (current === key && !restart) return true;
      const prev = current ? actions[current] : null;
      next.reset();
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
    dispose() {
      mixer.stopAllAction();
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
 * Swaps the procedural body of a character (character.js) for the rigged
 * glTF of the matching body type, keeping the same public API. The name tag,
 * blob shadow and held items keep working. Resolves to true once swapped.
 */
export async function upgradeCharacter(character) {
  const body = character.look.body === "female" ? "female" : "male";
  const spec = HUMAN_MODELS[body];
  let gltf;
  try {
    gltf = await loadGLB(spec.url);
  } catch (err) {
    console.warn("[models] keeping the procedural avatar:", err?.message || err);
    return false;
  }
  if (character.disposed) return false;

  const scale = spec.height / spec.fileHeight;
  const rig = createRig(gltf, spec.prefix, scale);
  recolorHuman(rig, character.look);
  rig.play("Idle", { fade: 0 });

  const bones = {};
  rig.model.traverse((o) => {
    if (o.isBone) bones[o.name] = o;
  });

  // hide the procedural mesh, keep tag + shadow + anything else non-body
  const procedural = character.body;
  if (procedural) procedural.visible = false;
  character.group.add(rig.model);

  // held items follow the right palm; undo the model scale for them
  const hand = new THREE.Group();
  hand.scale.setScalar(1 / scale);
  hand.position.set(0, 0.25, 0.1);
  (bones["Palm.R"] || rig.model).add(hand);

  const st = { sitting: false, action: null, actionT: 0, airborne: false, lastSpeed: 0 };
  const procUpdate = character.update.bind(character);
  const procSetLook = character.setLook.bind(character);
  const procSetSitting = character.setSitting?.bind(character);
  const procPlayAction = character.playAction.bind(character);

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

  character.setLook = (newLook) => {
    const before = character.look.body;
    procSetLook(newLook);
    recolorHuman(rig, character.look);
    if ((character.look.body === "female" ? "female" : "male") !== body && before !== undefined) {
      // body type changed: rebuild with the other model
      character.group.remove(rig.model);
      rig.dispose();
      if (procedural) procedural.visible = true;
      character.update = procUpdate;
      character.setLook = procSetLook;
      character.playAction = procPlayAction;
      if (procSetSitting) character.setSitting = procSetSitting;
      upgradeCharacter(character);
    }
  };

  character.setSitting = (v) => {
    procSetSitting?.(v);
    st.sitting = !!v;
  };

  character.playAction = (name, duration = 1.2) => {
    procPlayAction(name, duration);
    st.action = name;
    st.actionT = duration;
  };

  character.update = (dt, opts = {}) => {
    // the procedural rig still runs (cheap) so its state stays coherent
    procUpdate(dt, opts);
    const speed = Math.max(0, opts.speed ?? 0);
    st.lastSpeed = speed;
    if (st.actionT > 0) st.actionT -= dt;
    const anim = opts.anim;

    if (st.sitting || anim === "sit") {
      rig.play("Sitting", { fade: 0.35, once: true });
    } else if (anim === "jump") {
      rig.play("Jump", { fade: 0.12, once: true });
    } else if (st.actionT > 0 && (st.action === "cheer" || st.action === "roar")) {
      rig.play("Clapping", { fade: 0.2 });
    } else if (speed > 0.72 || anim === "run") {
      rig.play("Run", { fade: 0.2, timeScale: 0.8 + speed * 0.4 });
    } else if (speed > 0.06 || anim === "walk") {
      rig.play("Walk", { fade: 0.22, timeScale: Math.max(0.6, speed * 1.6) });
    } else {
      rig.play("Idle", { fade: 0.3 });
    }
    rig.update(dt);
    if (rig.current === "Run" || rig.current === "Walk") {
      const a = rig.actions[rig.current];
      a.timeScale = rig.current === "Run" ? 0.8 + speed * 0.4 : Math.max(0.6, speed * 1.6);
    }

    // arm poses layered on top of the clip
    if (st.actionT > 0 && !st.sitting) {
      const k = Math.min(1, st.actionT / 0.35);
      const upper = bones["UpperArm.R"];
      const lower = bones["LowerArm.R"];
      if (st.action === "wave" && upper && lower) {
        upper.rotation.z += 2.2 * k;
        lower.rotation.z += (0.5 + Math.sin(performance.now() / 90) * 0.45) * k;
      } else if ((st.action === "eat" || st.action === "photo") && upper && lower) {
        upper.rotation.x -= 1.1 * k;
        lower.rotation.x -= 1.4 * k;
      }
    }
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
