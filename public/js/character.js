import * as THREE from "three";
import { clamp, damp, lerp, makeBlobShadow, makeNameTag } from "./util.js";

/* ------------------------------------------------------------------ */
/* look schema                                                          */
/*                                                                      */
/*   {                                                                  */
/*     body:      "male" | "female"                                     */
/*     skin:      "#rrggbb"   (SKIN_TONES or any valid hex)             */
/*     shirt:     "#rrggbb"   (SHIRT_COLORS or any valid hex)           */
/*     pants:     "#rrggbb"   (PANTS_COLORS or any valid hex)           */
/*     hair:      HAIR_STYLES id                                        */
/*     hairColor: "#rrggbb"   (HAIR_COLORS or any valid hex)            */
/*     accessory: ACCESSORIES id                                        */
/*   }                                                                  */
/*                                                                      */
/* normalizeLook() whitelists every field, so it is safe to run on      */
/* untrusted network input.                                             */
/* ------------------------------------------------------------------ */

export const BODY_TYPES = [
  { id: "male", name: "Male", icon: "♂" },
  { id: "female", name: "Female", icon: "♀" },
];

export const SKIN_TONES = [
  { id: "porcelain", name: "Porcelain", hex: "#f2d3bd" },
  { id: "peach", name: "Peach", hex: "#e6b48f" },
  { id: "honey", name: "Honey", hex: "#c98c5f" },
  { id: "bronze", name: "Bronze", hex: "#a2663f" },
  { id: "umber", name: "Umber", hex: "#75462b" },
  { id: "espresso", name: "Espresso", hex: "#4a2c1c" },
];

export const SHIRT_COLORS = [
  { id: "teal", name: "Museum Teal", hex: "#2ec4b6" },
  { id: "amber", name: "Fossil Amber", hex: "#ffb703" },
  { id: "cream", name: "Bone Cream", hex: "#f4ead5" },
  { id: "red", name: "Velvet Red", hex: "#e5383b" },
  { id: "space", name: "Deep Space", hex: "#3a0ca3" },
  { id: "fern", name: "Fern Green", hex: "#52b788" },
  { id: "lavender", name: "Lavender", hex: "#b892ff" },
  { id: "charcoal", name: "Charcoal", hex: "#2b2d42" },
];

export const PANTS_COLORS = [
  { id: "slate", name: "Slate", hex: "#495057" },
  { id: "denim", name: "Denim", hex: "#3f6fb5" },
  { id: "khaki", name: "Khaki", hex: "#b08968" },
  { id: "black", name: "Black", hex: "#1f1f24" },
  { id: "olive", name: "Olive", hex: "#6b705c" },
  { id: "plum", name: "Plum", hex: "#6d3b5e" },
];

export const HAIR_STYLES = [
  { id: "short", name: "Short" },
  { id: "bun", name: "Bun" },
  { id: "spiky", name: "Spiky" },
  { id: "long", name: "Long" },
  { id: "buzz", name: "Buzz" },
  { id: "mohawk", name: "Mohawk" },
  { id: "curly", name: "Curly" },
  { id: "bald", name: "Bald" },
];

export const HAIR_COLORS = [
  { id: "black", name: "Jet Black", hex: "#141414" },
  { id: "dark", name: "Dark Brown", hex: "#2b1d12" },
  { id: "brown", name: "Chestnut", hex: "#6b3f1d" },
  { id: "auburn", name: "Auburn", hex: "#8e3b1f" },
  { id: "blonde", name: "Blonde", hex: "#d9b46a" },
  { id: "grey", name: "Silver", hex: "#b9b9b9" },
  { id: "pink", name: "Punk Pink", hex: "#ff5d8f" },
  { id: "blue", name: "Electric Blue", hex: "#3a86ff" },
];

export const ACCESSORIES = [
  { id: "none", name: "None" },
  { id: "glasses", name: "Glasses" },
  { id: "cap", name: "Cap" },
  { id: "backpack", name: "Backpack" },
  { id: "headphones", name: "Headphones" },
  { id: "cape", name: "Dino Cape" },
  { id: "headlamp", name: "Headlamp" },
];

/** Hair used when the visitor has not picked a style for their body type. */
export const DEFAULT_HAIR = { male: "short", female: "long" };

export const DEFAULT_LOOK = Object.freeze({
  body: "male",
  skin: "#e6b48f",
  shirt: "#2ec4b6",
  pants: "#495057",
  hair: "short",
  hairColor: "#2b1d12",
  accessory: "cap",
});

/**
 * Sitting: the character's seat contact point is SIT_SEAT_OFFSET metres
 * above its root. To sit on a seat whose top surface is at height Y, place
 * the root at Y - SIT_SEAT_OFFSET (so a 0.45m bench → root on the floor).
 */
export const SIT_SEAT_OFFSET = 0.45;

const HEX_RE = /^#[0-9a-f]{6}$/;
const LEGACY_HAIR = { h1: "short", h2: "bun", h3: "spiky", h4: "long", h5: "buzz", h6: "mohawk", h7: "curly", none: "bald" };
const LEGACY_ACC = { a0: "none", a1: "glasses", a2: "cap", a3: "backpack", a4: "headphones", a5: "cape", a6: "headlamp" };

const ids = (list) => new Set(list.map((x) => x.id));
const BODY_IDS = ids(BODY_TYPES);
const HAIR_IDS = ids(HAIR_STYLES);
const ACC_IDS = ids(ACCESSORIES);

function cleanHex(v, palette, fallback) {
  if (typeof v !== "string") return fallback;
  const s = v.trim().toLowerCase();
  if (HEX_RE.test(s)) return s;
  // allow palette ids too ("teal", "peach", …)
  const hit = palette.find((c) => c.id === s);
  return hit ? hit.hex : fallback;
}

function cleanId(v, allowed, legacy, fallback) {
  if (typeof v !== "string") return fallback;
  const s = v.trim().toLowerCase();
  if (allowed.has(s)) return s;
  if (legacy && legacy[s] && allowed.has(legacy[s])) return legacy[s];
  return fallback;
}

/** Returns a fresh, fully validated look. Unknown / bad fields fall back to defaults. */
export function normalizeLook(look) {
  const src = look && typeof look === "object" ? look : {};
  const body = cleanId(src.body, BODY_IDS, null, DEFAULT_LOOK.body);
  const hairIn = src.hair ?? src.hairStyle;
  return {
    body,
    skin: cleanHex(src.skin, SKIN_TONES, DEFAULT_LOOK.skin),
    shirt: cleanHex(src.shirt, SHIRT_COLORS, DEFAULT_LOOK.shirt),
    pants: cleanHex(src.pants, PANTS_COLORS, DEFAULT_LOOK.pants),
    hair: cleanId(hairIn, HAIR_IDS, LEGACY_HAIR, DEFAULT_HAIR[body]),
    hairColor: cleanHex(src.hairColor, HAIR_COLORS, DEFAULT_LOOK.hairColor),
    accessory: cleanId(src.accessory, ACC_IDS, LEGACY_ACC, "none"),
  };
}

export function randomLook() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const body = pick(BODY_TYPES).id;
  // bias towards the body's default hair so random looks read clearly
  const hair = Math.random() < 0.35 ? DEFAULT_HAIR[body] : pick(HAIR_STYLES).id;
  return {
    body,
    skin: pick(SKIN_TONES).hex,
    shirt: pick(SHIRT_COLORS).hex,
    pants: pick(PANTS_COLORS).hex,
    hair,
    hairColor: pick(HAIR_COLORS).hex,
    accessory: pick(ACCESSORIES).id,
  };
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */
function m(hex, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(hex),
    roughness: opts.roughness ?? 0.72,
    metalness: opts.metalness ?? 0.04,
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
    emissive: opts.emissive ? new THREE.Color(opts.emissive) : undefined,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
  });
}

function mesh(geo, mat, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(geo, mat);
  o.position.set(x, y, z);
  return o;
}

/** Lathe from [y, r] pairs (bottom → top). */
function lathe(profile, segments = 20) {
  return new THREE.LatheGeometry(
    profile.map(([y, r]) => new THREE.Vector2(r, y)),
    segments
  );
}

/** Deterministic pseudo random in [0,1) from an integer. */
function hash(i) {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

const smooth = (t) => t * t * (3 - 2 * t);

/** Removes every child, disposing geometries and non-shared materials. */
function clearGroup(group, shared) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && !shared.has(o.material)) o.material.dispose();
    });
  }
}

/* body-type proportions */
const BODY = {
  male: {
    shoulderX: 0.33,
    hipX: 0.115,
    armR: 0.074,
    foreR: 0.064,
    handR: 0.074,
    thighR: 0.112,
    shinR: 0.086,
    neckR: 0.074,
    headR: 0.215,
    armZ: 0.07,
    torso: [
      [0.0, 0.235],
      [0.1, 0.24],
      [0.22, 0.255],
      [0.34, 0.285],
      [0.43, 0.3],
      [0.49, 0.28],
      [0.54, 0.2],
      [0.565, 0.09],
      [0.575, 0.0],
    ],
    torsoDepth: 0.66,
    hips: [
      [-0.19, 0.0],
      [-0.16, 0.17],
      [-0.08, 0.215],
      [0.0, 0.24],
      [0.12, 0.235],
    ],
  },
  female: {
    shoulderX: 0.27,
    hipX: 0.122,
    armR: 0.06,
    foreR: 0.052,
    handR: 0.062,
    thighR: 0.108,
    shinR: 0.078,
    neckR: 0.062,
    headR: 0.205,
    armZ: 0.17,
    torso: [
      [0.0, 0.225],
      [0.08, 0.2],
      [0.17, 0.182],
      [0.27, 0.2],
      [0.36, 0.228],
      [0.43, 0.228],
      [0.49, 0.205],
      [0.54, 0.155],
      [0.565, 0.07],
      [0.572, 0.0],
    ],
    torsoDepth: 0.7,
    hips: [
      [-0.2, 0.0],
      [-0.175, 0.19],
      [-0.1, 0.268],
      [-0.01, 0.28],
      [0.08, 0.25],
      [0.12, 0.225],
    ],
  },
};

const HIP_Y = 0.88; // pelvis joint height when standing (feet on the root)
const THIGH = 0.42;
const SHIN = 0.38; // knee → ankle; the foot adds 0.08 to reach the ground
const SPINE_Y = 0.05; // spine base above the pelvis joint
const SHOULDER_Y = 0.46; // shoulder joints above the spine base
const HEAD_Y = 0.69; // head centre above the spine base (≈1.62m world)
const SIT_HIP_Y = SIT_SEAT_OFFSET + 0.11; // hip joint sits one thigh-radius above the seat

/* ------------------------------------------------------------------ */
/* character                                                            */
/* ------------------------------------------------------------------ */
/**
 * Builds a stylised visitor character.
 *
 * API: { group, body, attachments, head, handAnchor, tag, look, setLook, setName,
 *        playAction, setHeld, setSitting, update, dispose }
 */
export function createCharacter(lookInput = {}, opts = {}) {
  const look = normalizeLook(lookInput);
  const root = new THREE.Group();
  const shadow = makeBlobShadow(0.55, 0.4);
  shadow.position.y = 0.02;
  root.add(shadow);

  /* shared materials (recoloured in place by setLook) */
  const skinMat = m(look.skin, { roughness: 0.78 });
  const shirtMat = m(look.shirt, { roughness: 0.82 });
  const shirtDarkMat = m(look.shirt, { roughness: 0.85 });
  const pantsMat = m(look.pants, { roughness: 0.88 });
  const hairMat = m(look.hairColor, { roughness: 0.62, metalness: 0.08 });
  const shoeMat = m("#2a2d34", { roughness: 0.55 });
  const soleMat = m("#e9e4da", { roughness: 0.7 });
  const beltMat = m("#3a2a1e", { roughness: 0.5, metalness: 0.1 });
  const eyeWhiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35 });
  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x1a1a20 });
  const mouthMat = m("#7d3b3b", { roughness: 0.6 });
  const blushMat = m("#ff8a80", { roughness: 0.9, transparent: true, opacity: 0.35 });
  shirtDarkMat.color.multiplyScalar(0.78);
  const shared = new Set([
    skinMat, shirtMat, shirtDarkMat, pantsMat, hairMat, shoeMat, soleMat, beltMat,
    eyeWhiteMat, pupilMat, mouthMat, blushMat,
  ]);

  /* ---------------- rig (persistent joints) ---------------- */
  const body = new THREE.Group(); // vertical offset (bob / sitting)
  root.add(body);
  const pelvis = new THREE.Group();
  pelvis.position.y = HIP_Y;
  body.add(pelvis);
  const hipsMesh = new THREE.Group();
  pelvis.add(hipsMesh);

  const spine = new THREE.Group();
  spine.position.y = SPINE_Y;
  pelvis.add(spine);
  const chest = new THREE.Group(); // breathing scale
  spine.add(chest);
  const torsoMesh = new THREE.Group();
  chest.add(torsoMesh);
  const back = new THREE.Group(); // backpack / cape follow the torso
  spine.add(back);

  const neck = new THREE.Group();
  neck.position.y = 0.55;
  spine.add(neck);
  const head = new THREE.Group();
  head.position.y = HEAD_Y;
  spine.add(head);
  const faceGroup = new THREE.Group();
  head.add(faceGroup);
  const hairGroup = new THREE.Group();
  head.add(hairGroup);
  const accessoryGroup = new THREE.Group();
  head.add(accessoryGroup);

  function makeArm(side) {
    const group = new THREE.Group();
    spine.add(group);
    const upperMesh = new THREE.Group();
    group.add(upperMesh);
    const elbow = new THREE.Group();
    elbow.position.y = -0.3;
    group.add(elbow);
    const foreMesh = new THREE.Group();
    elbow.add(foreMesh);
    return { side, group, upperMesh, elbow, foreMesh };
  }
  const armL = makeArm(-1);
  const armR = makeArm(1);

  function makeLeg(side) {
    const group = new THREE.Group();
    pelvis.add(group);
    const thighMesh = new THREE.Group();
    group.add(thighMesh);
    const knee = new THREE.Group();
    knee.position.y = -THIGH;
    group.add(knee);
    const shinMesh = new THREE.Group();
    knee.add(shinMesh);
    const ankle = new THREE.Group();
    ankle.position.y = -SHIN;
    knee.add(ankle);
    return { side, group, thighMesh, knee, shinMesh, ankle };
  }
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  // held item (ice cream cone) lives in the right hand
  const handAnchor = new THREE.Group();
  handAnchor.position.set(0, -0.32, 0.04);
  armR.elbow.add(handAnchor);

  let mouth = null;
  let cape = null;
  let dims = BODY[look.body];

  /* ---------------- mesh building ---------------- */
  function buildBody() {
    dims = BODY[look.body];
    const female = look.body === "female";
    for (const g of [hipsMesh, torsoMesh, back, neck, faceGroup, hairGroup, accessoryGroup,
      armL.upperMesh, armL.foreMesh, armR.upperMesh, armR.foreMesh,
      legL.thighMesh, legL.shinMesh, legL.ankle, legR.thighMesh, legR.shinMesh, legR.ankle]) {
      clearGroup(g, shared);
    }
    cape = null;

    // torso
    const torso = new THREE.Mesh(lathe(dims.torso, 22), shirtMat);
    torso.scale.z = dims.torsoDepth;
    torsoMesh.add(torso);
    // collar
    const collar = mesh(new THREE.TorusGeometry(dims.neckR + 0.018, 0.018, 6, 16), shirtDarkMat, 0, 0.556, 0);
    collar.rotation.x = Math.PI / 2;
    torsoMesh.add(collar);
    // hem / belt
    const belt = mesh(new THREE.CylinderGeometry(dims.torso[0][1] + 0.006, dims.torso[0][1] + 0.006, 0.05, 22, 1, true), beltMat, 0, 0.0, 0);
    belt.scale.z = dims.torsoDepth;
    torsoMesh.add(belt);
    const buckle = mesh(new THREE.BoxGeometry(0.06, 0.04, 0.02), m("#d4b36a", { metalness: 0.6, roughness: 0.3 }), 0, 0, dims.torso[0][1] * dims.torsoDepth + 0.006);
    torsoMesh.add(buckle);

    // hips / pants
    const hips = new THREE.Mesh(lathe(dims.hips, 22), pantsMat);
    hips.scale.z = 0.78;
    hipsMesh.add(hips);
    if (female) {
      // flared skirt over the hips
      const skirt = new THREE.Mesh(
        lathe([[-0.34, 0.35], [-0.2, 0.32], [-0.08, 0.3], [0.02, 0.29], [0.09, 0.262], [0.14, 0.232]], 24),
        m(look.pants, { roughness: 0.85, side: THREE.DoubleSide })
      );
      skirt.scale.z = 0.82;
      hipsMesh.add(skirt);
    }

    // neck
    neck.add(mesh(new THREE.CylinderGeometry(dims.neckR, dims.neckR * 1.15, 0.16, 12), skinMat, 0, 0.02, 0));

    // arms
    for (const arm of [armL, armR]) {
      arm.group.position.set(arm.side * dims.shoulderX, SHOULDER_Y, 0);
      const shoulder = mesh(new THREE.SphereGeometry(dims.armR * 1.18, 12, 10), shirtMat, 0, -0.015, 0);
      arm.upperMesh.add(shoulder);
      const sleeve = mesh(new THREE.CapsuleGeometry(dims.armR * 1.1, 0.1, 4, 12), shirtMat, 0, -0.08, 0);
      arm.upperMesh.add(sleeve);
      arm.upperMesh.add(mesh(new THREE.CapsuleGeometry(dims.armR, 0.2, 4, 10), skinMat, 0, -0.18, 0));
      arm.foreMesh.add(mesh(new THREE.CapsuleGeometry(dims.foreR, 0.2, 4, 10), skinMat, 0, -0.14, 0));
      const hand = mesh(new THREE.SphereGeometry(dims.handR, 12, 10), skinMat, 0, -0.31, 0.01);
      hand.scale.set(0.9, 1.1, 0.75);
      arm.foreMesh.add(hand);
      const thumb = mesh(new THREE.CapsuleGeometry(dims.handR * 0.32, dims.handR * 0.6, 3, 6), skinMat, -arm.side * dims.handR * 0.6, -0.29, 0.04);
      thumb.rotation.z = -arm.side * 0.5;
      arm.foreMesh.add(thumb);
    }

    // legs
    for (const leg of [legL, legR]) {
      leg.group.position.set(leg.side * dims.hipX, 0, 0);
      leg.thighMesh.add(mesh(new THREE.CapsuleGeometry(dims.thighR, THIGH - dims.thighR * 2 + 0.06, 4, 12), pantsMat, 0, -THIGH / 2, 0));
      const shin = mesh(new THREE.CylinderGeometry(dims.thighR * 0.85, dims.shinR, SHIN, 12), pantsMat, 0, -SHIN / 2, 0);
      leg.shinMesh.add(shin);
      leg.shinMesh.add(mesh(new THREE.SphereGeometry(dims.thighR * 0.86, 10, 8), pantsMat, 0, 0, 0));
      // shoe
      const shoe = mesh(new THREE.CapsuleGeometry(0.062, 0.14, 4, 10), shoeMat, 0, -0.035, 0.05);
      shoe.rotation.x = Math.PI / 2;
      shoe.scale.set(female ? 1.1 : 1.3, 1, 0.75);
      leg.ankle.add(shoe);
      const sole = mesh(new THREE.BoxGeometry(female ? 0.13 : 0.155, 0.025, 0.28), soleMat, 0, -0.068, 0.05);
      leg.ankle.add(sole);
    }

    // head
    head.position.y = HEAD_Y;
    buildFace(female);
    buildHair(hairGroup, look, hairMat, dims.headR);
    buildAccessory(accessoryGroup, look, dims.headR, shared);

    // back attachments (children of the spine, so they follow the torso)
    const maxR = Math.max(...dims.torso.map((q) => q[1]));
    const backZ = -maxR * dims.torsoDepth;
    const surfaceZ = (y, x) => {
      // front surface of the elliptical torso at height y / offset x
      let r = dims.torso[0][1];
      for (let i = 1; i < dims.torso.length; i++) {
        const [y0, r0] = dims.torso[i - 1];
        const [y1, r1] = dims.torso[i];
        if (y >= y0 && y <= y1) r = lerp(r0, r1, (y - y0) / (y1 - y0 || 1));
      }
      return Math.sqrt(Math.max(0, r * r - x * x)) * dims.torsoDepth;
    };
    if (look.accessory === "backpack") {
      const pack = buildBackpack(look);
      pack.position.set(0, 0.3, backZ - 0.08);
      back.add(pack);
      const strapMat = m("#3b3328", { roughness: 0.7 });
      for (const s of [-1, 1]) {
        const x = s * maxR * 0.42;
        const front = mesh(new THREE.BoxGeometry(0.045, 0.34, 0.02), strapMat, x, 0.36, surfaceZ(0.36, x) + 0.008);
        back.add(front);
        const top = mesh(new THREE.BoxGeometry(0.045, 0.025, surfaceZ(0.5, x) * 2 + 0.04), strapMat, x, 0.535, 0);
        back.add(top);
      }
    } else if (look.accessory === "cape") {
      cape = buildCape(look, dims);
      cape.position.set(0, 0.53, backZ - 0.025);
      back.add(cape);
      const clasp = mesh(new THREE.SphereGeometry(0.035, 10, 8), m("#ffd166", { metalness: 0.6, roughness: 0.3 }), 0, 0.53, surfaceZ(0.53, 0) + 0.01);
      back.add(clasp);
      // ties from the clasp over the shoulders
      for (const s of [-1, 1]) {
        const tie = mesh(new THREE.BoxGeometry(0.02, 0.02, 0.22), cape.children[0].material, s * 0.09, 0.545, 0.02);
        tie.rotation.y = s * 0.5;
        back.add(tie);
      }
    }
  }

  function buildFace(female) {
    const R = dims.headR;
    const skull = mesh(new THREE.SphereGeometry(R, 24, 18), skinMat);
    skull.scale.set(1, 1.08, 0.97);
    faceGroup.add(skull);
    // jaw / chin softens the sphere
    const jaw = mesh(new THREE.SphereGeometry(R * 0.78, 16, 12), skinMat, 0, -R * 0.38, R * 0.12);
    jaw.scale.set(female ? 0.92 : 1.02, 0.75, 0.9);
    faceGroup.add(jaw);
    // ears
    for (const s of [-1, 1]) {
      const ear = mesh(new THREE.SphereGeometry(R * 0.2, 8, 8), skinMat, s * R * 0.98, -0.0, 0);
      ear.scale.set(0.5, 1, 0.8);
      faceGroup.add(ear);
    }
    const eyeY = R * 0.12;
    const eyeX = R * 0.38;
    const eyeZ = R * 0.86;
    const eyeR = female ? R * 0.22 : R * 0.2;
    for (const s of [-1, 1]) {
      const white = mesh(new THREE.SphereGeometry(eyeR, 12, 10), eyeWhiteMat, s * eyeX, eyeY, eyeZ);
      white.scale.set(1, 1.15, 0.55);
      faceGroup.add(white);
      const pupil = mesh(new THREE.SphereGeometry(eyeR * 0.52, 10, 8), pupilMat, s * eyeX, eyeY - eyeR * 0.05, eyeZ + eyeR * 0.42);
      faceGroup.add(pupil);
      const glint = mesh(new THREE.SphereGeometry(eyeR * 0.16, 6, 5), eyeWhiteMat, s * eyeX + eyeR * 0.22, eyeY + eyeR * 0.25, eyeZ + eyeR * 0.6);
      faceGroup.add(glint);
      // brows in hair colour
      const brow = mesh(new THREE.BoxGeometry(eyeR * 2.2, female ? 0.012 : 0.02, 0.02), hairMat, s * eyeX, eyeY + eyeR * 1.75, eyeZ + 0.01);
      brow.rotation.z = -s * (female ? 0.18 : 0.08);
      faceGroup.add(brow);
      if (female) {
        const lash = mesh(new THREE.BoxGeometry(eyeR * 0.9, 0.012, 0.01), pupilMat, s * (eyeX + eyeR * 0.85), eyeY + eyeR * 0.85, eyeZ + 0.005);
        lash.rotation.z = s * 0.6;
        faceGroup.add(lash);
      }
      const blush = mesh(new THREE.SphereGeometry(R * 0.13, 8, 6), blushMat, s * R * 0.55, -R * 0.2, R * 0.78);
      blush.scale.set(1, 0.6, 0.3);
      faceGroup.add(blush);
    }
    const nose = mesh(new THREE.SphereGeometry(R * 0.13, 10, 8), skinMat, 0, -R * 0.12, R * 0.97);
    nose.scale.set(0.9, 1, 0.8);
    faceGroup.add(nose);
    mouthMat.color.set(female ? "#b8505a" : "#7d3b3b");
    // smile: lower half of a torus
    mouth = mesh(new THREE.TorusGeometry(R * 0.16, R * 0.032, 6, 14, Math.PI), mouthMat, 0, -R * 0.3, R * 0.93);
    mouth.rotation.set(-0.25, 0, Math.PI);
    faceGroup.add(mouth);
  }

  buildBody();

  // name tag
  const tag = makeNameTag(opts.name || "Visitor", opts.tagColor || "#ffffff");
  tag.position.y = 2.28;
  tag.scale.set(1.5, 0.38, 1);
  root.add(tag);

  /* ---------------- animation state ---------------- */
  const st = {
    phase: 0,
    time: Math.random() * 10, // de-sync idle breathing between visitors
    speed: 0,
    gait: 0,
    sit: 0,
    sitTarget: 0,
    action: null,
    actionT: 0,
    actionDur: 1,
  };

  const P = () => ({
    bodyY: 0, pelvisRx: 0, pelvisRy: 0, pelvisRz: 0,
    spineRx: 0, spineRy: 0, spineRz: 0,
    headRx: 0, headRy: 0,
    lHip: 0, rHip: 0, lHipZ: 0, rHipZ: 0, lKnee: 0, rKnee: 0,
    lArmX: 0, rArmX: 0, lArmZ: 0, rArmZ: 0, lElbow: 0, rElbow: 0, lElbowZ: 0, rElbowZ: 0,
    capeRx: 0, mouthY: 1,
  });
  const pose = P();
  const sitPose = P();

  function blendInto(a, b, t) {
    if (t <= 0) return;
    for (const k in a) a[k] = lerp(a[k], b[k], t);
  }

  const api = {
    group: root,
    /** every procedural body mesh (not the name tag / blob shadow) — hide to swap in another avatar */
    body,
    /**
     * the look's add-ons, rebuilt in place by setLook: hair + head accessory (centred on
     * the head) and the back group (cape / backpack, origin at the spine base). Another
     * avatar can re-parent them onto its own bones (models.js) and put them back here.
     */
    attachments: { hair: hairGroup, accessory: accessoryGroup, back },
    disposed: false,
    head,
    handAnchor,
    tag,
    look,
    setLook(newLook) {
      const prevBody = api.look.body;
      const merged = { ...api.look, ...(newLook || {}) };
      // switching body without choosing hair → pick that body's default hair
      if (newLook && newLook.body && newLook.body !== prevBody && !("hair" in newLook) && api.look.hair === DEFAULT_HAIR[prevBody]) {
        delete merged.hair;
      }
      const next = normalizeLook(merged);
      Object.assign(api.look, next);
      skinMat.color.set(api.look.skin);
      shirtMat.color.set(api.look.shirt);
      shirtDarkMat.color.set(api.look.shirt).multiplyScalar(0.78);
      pantsMat.color.set(api.look.pants);
      hairMat.color.set(api.look.hairColor);
      buildBody();
    },
    setName(name, tagColor) {
      root.remove(api.tag);
      api.tag.material.map?.dispose();
      api.tag.material.dispose();
      const t = makeNameTag(name, tagColor || "#ffffff");
      // keep whatever the owner did to the old tag (main.js hides your own,
      // remote.js anchors, sizes and fades the others every frame)
      t.position.copy(api.tag.position);
      t.scale.copy(api.tag.scale);
      t.center.copy(api.tag.center);
      t.visible = api.tag.visible;
      t.material.opacity = api.tag.material.opacity;
      root.add(t);
      api.tag = t;
    },
    playAction(name, duration = 1.2) {
      st.action = name;
      st.actionT = duration;
      st.actionDur = Math.max(0.2, duration);
    },
    setHeld(object3d) {
      while (handAnchor.children.length) handAnchor.remove(handAnchor.children[0]);
      if (object3d) handAnchor.add(object3d);
    },
    /**
     * Sit down (true) or stand up (false). Blends smoothly (~0.4s) and
     * overrides the walk cycle while seated. The seat contact is
     * SIT_SEAT_OFFSET (0.45m) above the root, so put the root at
     * seatSurfaceY - SIT_SEAT_OFFSET.
     */
    setSitting(on) {
      st.sitTarget = on ? 1 : 0;
    },
    isSitting: () => st.sitTarget === 1,
    /** Frees every geometry / material / texture owned by this character. */
    dispose() {
      if (api.disposed) return;
      api.disposed = true;
      root.parent?.remove(root);
      const mats = new Set();
      root.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) for (const mm of [].concat(o.material)) mats.add(mm);
      });
      for (const mm of shared) mats.add(mm);
      for (const mm of mats) {
        for (const key of ["map", "alphaMap", "emissiveMap", "normalMap", "roughnessMap"]) mm[key]?.dispose?.();
        mm.dispose();
      }
    },
    /**
     * opts.speed: 0..1 (1 = running).
     * opts.anim: optional "idle" | "walk" | "run" | "jump" | "sit". "sit" sits for as long
     * as it is passed (in addition to setSitting); walk/run imply a speed when none is given.
     */
    update(dt, uopts = {}) {
      if (api.disposed) return;
      dt = Math.min(dt, 0.1);
      st.time += dt;
      const t = st.time;
      const anim = uopts.anim;
      const animSpeed = anim === "run" ? 1 : anim === "walk" ? 0.45 : 0;
      const targetSpeed = clamp(uopts.speed ?? animSpeed, 0, 1);
      st.speed = damp(st.speed, targetSpeed, 8, dt);
      const sitGoal = st.sitTarget === 1 || anim === "sit" ? 1 : 0;
      st.sit = damp(st.sit, sitGoal, 7, dt);
      if (Math.abs(st.sit - sitGoal) < 0.001) st.sit = sitGoal;
      st.jump = damp(st.jump || 0, anim === "jump" ? 1 : 0, 12, dt);
      const sitW = smooth(st.sit);
      const s = st.speed;
      // gait weight: how much of the walk cycle is visible (0 = standing)
      st.gait = damp(st.gait, s > 0.03 ? 1 : 0, 6, dt);
      const g = st.gait * (1 - sitW);

      // cadence: ~1.7 strides/s walking, ~2.7 running
      st.phase += dt * Math.PI * 2 * (0.75 + 1.95 * s) * (0.35 + 0.65 * st.gait);
      const p = st.phase;
      const sp = Math.sin(p);
      const cp = Math.cos(p);

      /* ---- locomotion + idle ---- */
      const legA = g * (0.32 + 0.42 * s);
      const kneeA = g * (0.55 + 0.75 * s);
      pose.lHip = -sp * legA;
      pose.rHip = sp * legA;
      // knee bends while the leg swings forward, a little on contact
      pose.lKnee = Math.max(0, -cp) * kneeA + g * 0.08 + Math.max(0, sp) * g * 0.1;
      pose.rKnee = Math.max(0, cp) * kneeA + g * 0.08 + Math.max(0, -sp) * g * 0.1;
      pose.lHipZ = 0;
      pose.rHipZ = 0;

      const armA = g * (0.3 + 0.55 * s);
      const breath = Math.sin(t * 1.7);
      pose.lArmX = sp * armA + (1 - g) * breath * 0.02;
      pose.rArmX = -sp * armA + (1 - g) * breath * 0.02;
      pose.lArmZ = -dims.armZ - (1 - g) * (0.02 + breath * 0.015);
      pose.rArmZ = dims.armZ + (1 - g) * (0.02 + breath * 0.015);
      pose.lElbow = -(0.18 + g * (0.25 + 0.75 * s)) - Math.max(0, sp) * armA * 0.4;
      pose.rElbow = -(0.18 + g * (0.25 + 0.75 * s)) - Math.max(0, -sp) * armA * 0.4;
      pose.lElbowZ = 0;
      pose.rElbowZ = 0;

      // body lowest at contact (legs apart), highest when passing
      const bobA = g * (0.025 + 0.045 * s);
      pose.bodyY = bobA * (Math.abs(cp) - 0.5) * 2 - g * s * 0.03;
      pose.pelvisRy = -sp * g * (0.08 + 0.06 * s);
      pose.pelvisRz = -sp * g * 0.035 + (1 - g) * Math.sin(t * 0.45) * 0.012;
      pose.pelvisRx = 0;
      pose.spineRx = g * s * 0.2 + (1 - g) * breath * 0.012;
      pose.spineRy = sp * g * (0.13 + 0.06 * s);
      pose.spineRz = sp * g * 0.025;
      pose.headRx = -g * s * 0.12;
      pose.headRy = (1 - g) * (Math.sin(t * 0.37) * 0.16 + Math.sin(t * 0.91) * 0.05) - pose.spineRy * 0.7;
      pose.capeRx = 0.06 + s * 0.65 + Math.sin(t * 7 + 1) * 0.04 * (0.3 + s);
      pose.mouthY = lerp(pose.mouthY, 1, Math.min(1, dt * 8));

      /* ---- airborne tuck ---- */
      if (st.jump > 0.001) {
        const j = st.jump;
        pose.lHip = lerp(pose.lHip, -0.55, j);
        pose.rHip = lerp(pose.rHip, -0.25, j);
        pose.lKnee = lerp(pose.lKnee, 0.95, j);
        pose.rKnee = lerp(pose.rKnee, 0.55, j);
        pose.lArmX = lerp(pose.lArmX, -0.5, j);
        pose.rArmX = lerp(pose.rArmX, -0.5, j);
        pose.lArmZ = lerp(pose.lArmZ, -0.7, j);
        pose.rArmZ = lerp(pose.rArmZ, 0.7, j);
        pose.lElbow = lerp(pose.lElbow, -0.6, j);
        pose.rElbow = lerp(pose.rElbow, -0.6, j);
        pose.bodyY = lerp(pose.bodyY, 0, j);
        pose.capeRx = lerp(pose.capeRx, 0.5, j);
      }

      /* ---- sitting ---- */
      if (sitW > 0) {
        Object.assign(sitPose, pose);
        sitPose.bodyY = SIT_HIP_Y - HIP_Y + breath * 0.004;
        sitPose.pelvisRx = 0;
        sitPose.pelvisRy = 0;
        sitPose.pelvisRz = 0;
        sitPose.lHip = -1.42;
        sitPose.rHip = -1.42;
        sitPose.lHipZ = -0.07;
        sitPose.rHipZ = 0.07;
        sitPose.lKnee = 1.4;
        sitPose.rKnee = 1.4;
        sitPose.spineRx = -0.05 + breath * 0.012;
        sitPose.spineRy = 0;
        sitPose.spineRz = 0;
        sitPose.headRx = 0.04;
        // hands resting on the thighs
        sitPose.lArmX = -0.25;
        sitPose.rArmX = -0.25;
        sitPose.lArmZ = -dims.armZ * 0.6;
        sitPose.rArmZ = dims.armZ * 0.6;
        sitPose.lElbow = -0.9;
        sitPose.rElbow = -0.9;
        sitPose.capeRx = 0.35;
        blendInto(pose, sitPose, sitW);
      }

      /* ---- actions (layered over everything) ---- */
      if (st.actionT > 0) {
        st.actionT -= dt;
        const el = st.actionDur - st.actionT; // elapsed
        const k = smooth(clamp(Math.min(el / 0.22, st.actionT / 0.3), 0, 1));
        const a = st.action;
        const tgt = { ...pose };
        if (a === "wave") {
          tgt.rArmZ = 2.55;
          tgt.rArmX = -0.25;
          tgt.rElbow = -0.25;
          tgt.rElbowZ = 0.35 + Math.sin(el * 11) * 0.45;
          tgt.headRy = 0.15;
          tgt.headRx = -0.06;
        } else if (a === "cheer") {
          const bounce = Math.abs(Math.sin(el * 7.5));
          tgt.lArmZ = -2.6 - bounce * 0.15;
          tgt.rArmZ = 2.6 + bounce * 0.15;
          tgt.lArmX = -0.2;
          tgt.rArmX = -0.2;
          tgt.lElbow = -0.2 - bounce * 0.25;
          tgt.rElbow = -0.2 - bounce * 0.25;
          tgt.lElbowZ = -0.2;
          tgt.rElbowZ = 0.2;
          tgt.headRx = -0.2;
          tgt.mouthY = 2.2;
          tgt.bodyY = pose.bodyY + bounce * 0.12 * (1 - sitW);
          if (sitW < 0.5) {
            tgt.lKnee = pose.lKnee + (1 - bounce) * 0.25;
            tgt.rKnee = pose.rKnee + (1 - bounce) * 0.25;
          }
        } else if (a === "roar") {
          tgt.headRx = -0.4;
          tgt.lArmX = -1.1;
          tgt.rArmX = -1.1;
          tgt.lArmZ = -0.6;
          tgt.rArmZ = 0.6;
          tgt.lElbow = -0.9;
          tgt.rElbow = -0.9;
          tgt.spineRx = pose.spineRx + 0.12;
          tgt.mouthY = 3.2;
        } else if (a === "photo") {
          tgt.rArmX = -1.7;
          tgt.rElbow = -1.1;
          tgt.lArmX = -1.4;
          tgt.lElbow = -1.3;
          tgt.lArmZ = 0.35;
          tgt.rArmZ = -0.35;
        } else if (a === "eat") {
          const chew = Math.sin(el * 9) * 0.1;
          tgt.rArmX = -1.15;
          tgt.rElbow = -1.5;
          tgt.headRx = 0.22 + chew;
          tgt.mouthY = 1 + Math.abs(chew) * 6;
        }
        blendInto(pose, tgt, k);
        if (st.actionT <= 0) st.action = null;
      }

      /* ---- apply ---- */
      body.position.y = pose.bodyY;
      pelvis.rotation.set(pose.pelvisRx, pose.pelvisRy, pose.pelvisRz);
      spine.rotation.set(pose.spineRx, pose.spineRy, pose.spineRz);
      head.rotation.set(pose.headRx, pose.headRy, 0);
      chest.scale.set(1 + breath * 0.008, 1 + breath * 0.01, 1 + breath * 0.012);
      legL.group.rotation.set(pose.lHip, 0, pose.lHipZ);
      legR.group.rotation.set(pose.rHip, 0, pose.rHipZ);
      legL.knee.rotation.x = pose.lKnee;
      legR.knee.rotation.x = pose.rKnee;
      // keep feet roughly level with the ground
      legL.ankle.rotation.x = -(pose.lHip + pose.lKnee) * 0.7;
      legR.ankle.rotation.x = -(pose.rHip + pose.rKnee) * 0.7;
      armL.group.rotation.set(pose.lArmX, 0, pose.lArmZ);
      armR.group.rotation.set(pose.rArmX, 0, pose.rArmZ);
      armL.elbow.rotation.set(pose.lElbow, 0, pose.lElbowZ);
      armR.elbow.rotation.set(pose.rElbow, 0, pose.rElbowZ);
      if (mouth) mouth.scale.set(1, pose.mouthY, 1);
      if (cape) cape.rotation.x = pose.capeRx;
      api.tag.position.y = 2.28 + pose.bodyY;
    },
  };

  return api;
}

/* ------------------------------------------------------------------ */
/* hair                                                                 */
/* ------------------------------------------------------------------ */
function buildHair(group, look, hairMat, R = 0.21) {
  const style = look.hair;
  if (style === "bald") return;
  // under a cap only the hair below the crown shows
  const capped = look.accessory === "cap";

  const capFor = (thetaLen, scale = 1.06, y = 0.012) => {
    const c = new THREE.Mesh(
      new THREE.SphereGeometry(R, 22, 14, 0, Math.PI * 2, 0, Math.PI * thetaLen),
      hairMat
    );
    c.position.y = y;
    c.scale.set(scale, scale * 1.08, scale);
    return c;
  };

  if (style === "buzz" || style === "mohawk") {
    // close crop, tilted back so the forehead stays clear
    const c = capFor(0.52, 1.022, 0.0);
    c.rotation.x = -0.62;
    group.add(c);
  }
  if (style === "buzz") return;

  // base cap, tilted back so the brows and forehead show
  const cap = style === "mohawk" ? null : capFor(0.6);
  if (cap) {
    cap.rotation.x = -0.95;
    group.add(cap);
  }

  if (style === "short") {
    if (capped) return;
    // little side-swept fringe
    const fringe = mesh(new THREE.SphereGeometry(R * 0.5, 12, 8), hairMat, R * 0.3, R * 0.72, R * 0.62);
    fringe.scale.set(1.5, 0.45, 0.8);
    fringe.rotation.z = -0.3;
    group.add(fringe);
  } else if (style === "bun") {
    const bun = mesh(new THREE.SphereGeometry(R * 0.48, 14, 12), hairMat, 0, R * 1.0, -R * 0.72);
    group.add(bun);
    const tie = mesh(new THREE.TorusGeometry(R * 0.3, R * 0.06, 6, 14), m("#ff8fab"), 0, R * 0.8, -R * 0.55);
    tie.rotation.x = -0.9;
    group.add(tie);
  } else if (style === "spiky") {
    if (capped) return;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      const rr = i === 0 ? 0 : R * 0.48;
      const sp = new THREE.Mesh(new THREE.ConeGeometry(R * 0.24, R * 0.85, 6), hairMat);
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr - R * 0.05;
      sp.position.set(x, R * 0.98, z);
      sp.rotation.set((z / R) * 0.9, 0, -(x / R) * 0.9);
      group.add(sp);
    }
  } else if (style === "long") {
    const backHair = new THREE.Mesh(new THREE.CapsuleGeometry(R * 0.9, R * 1.5, 6, 14), hairMat);
    backHair.position.set(0, -R * 0.6, -R * 0.55);
    backHair.scale.set(1.05, 0.82, 0.5);
    group.add(backHair);
    for (const s of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.CapsuleGeometry(R * 0.26, R * 1.5, 4, 10), hairMat);
      side.position.set(s * R * 0.86, -R * 0.55, -R * 0.02);
      side.rotation.z = s * 0.06;
      group.add(side);
    }
    const fringe = mesh(new THREE.SphereGeometry(R * 0.62, 14, 8), hairMat, -R * 0.2, R * 0.68, R * 0.58);
    fringe.scale.set(1.45, 0.42, 0.75);
    fringe.rotation.z = 0.25;
    if (!capped) group.add(fringe);
  } else if (style === "mohawk") {
    if (capped) return;
    // shaved sides with a crest of fins
    for (let i = 0; i < 6; i++) {
      const a = -0.5 + i * 0.36;
      const fin = new THREE.Mesh(new THREE.ConeGeometry(R * 0.16, R * 0.9, 4), hairMat);
      fin.position.set(0, Math.cos(a) * R * 1.05, Math.sin(a) * R * 1.05 * -1 + R * 0.1);
      fin.rotation.x = -a;
      fin.scale.set(0.6, 1, 1.6);
      group.add(fin);
    }
  } else if (style === "curly") {
    // deterministic curls on a golden-angle spiral (same on every client)
    const N = 26;
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const yN = 1 - (i / (N - 1)) * 0.95; // 1 → 0.05 (top hemisphere)
      const rad = Math.sqrt(1 - yN * yN);
      const a = i * golden;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      if (z > 0.55 && yN < 0.55) continue; // keep the face clear
      if (capped && yN > 0.4) continue;
      const cr = R * (0.26 + hash(i) * 0.08);
      const c = new THREE.Mesh(new THREE.SphereGeometry(cr, 9, 7), hairMat);
      c.position.set(x * R * 1.0, yN * R * 1.02 + R * 0.06, z * R * 1.0 - R * 0.04);
      group.add(c);
    }
  }
}

/* ------------------------------------------------------------------ */
/* head accessories                                                     */
/* ------------------------------------------------------------------ */
function buildAccessory(group, look, R = 0.21) {
  // NB: materials made here are owned by the group and disposed on rebuild
  const acc = look.accessory;
  if (acc === "glasses") {
    const frameMat = m("#20242b", { roughness: 0.3, metalness: 0.6 });
    const lensMat = new THREE.MeshStandardMaterial({
      color: 0x9fd3ff,
      roughness: 0.05,
      metalness: 0.2,
      transparent: true,
      opacity: 0.28,
    });
    const z = R * 1.0;
    for (const side of [-1, 1]) {
      const rim = mesh(new THREE.TorusGeometry(R * 0.2, R * 0.035, 6, 18), frameMat, side * R * 0.38, R * 0.12, z);
      group.add(rim);
      const lens = mesh(new THREE.CircleGeometry(R * 0.2, 16), lensMat, side * R * 0.38, R * 0.12, z - 0.002);
      group.add(lens);
      const arm = mesh(new THREE.BoxGeometry(0.008, 0.012, R * 0.95), frameMat, side * R * 0.6, R * 0.14, R * 0.5);
      arm.rotation.y = side * 0.12;
      group.add(arm);
    }
    group.add(mesh(new THREE.BoxGeometry(R * 0.2, 0.01, 0.01), frameMat, 0, R * 0.16, z));
  } else if (acc === "cap") {
    const capMat = m(look.shirt, { roughness: 0.75 });
    const crown = new THREE.Mesh(
      new THREE.SphereGeometry(R * 1.1, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.5),
      capMat
    );
    crown.position.y = R * 0.18;
    crown.scale.y = 0.85;
    crown.rotation.x = -0.12;
    group.add(crown);
    const brim = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 0.85, R * 0.85, 0.02, 20, 1, false, -Math.PI / 2, Math.PI),
      capMat
    );
    brim.position.set(0, R * 0.22, R * 0.75);
    brim.scale.set(1, 1, 0.75);
    brim.rotation.x = 0.12;
    group.add(brim);
    group.add(mesh(new THREE.SphereGeometry(R * 0.09, 8, 6), m("#ffffff"), 0, R * 1.12, -R * 0.05));
    const badge = mesh(new THREE.CircleGeometry(R * 0.18, 14), m("#ffd166", { roughness: 0.5 }), 0, R * 0.62, R * 0.92);
    badge.rotation.x = -0.45;
    group.add(badge);
  } else if (acc === "headphones") {
    const hpMat = m("#22252b", { roughness: 0.45, metalness: 0.3 });
    const padMat = m("#ff8fab", { roughness: 0.7 });
    const band = new THREE.Mesh(new THREE.TorusGeometry(R * 1.12, R * 0.09, 8, 20, Math.PI), hpMat);
    band.position.y = R * 0.08;
    band.rotation.y = Math.PI / 2;
    band.rotation.order = "YXZ";
    group.add(band);
    for (const side of [-1, 1]) {
      const cup = mesh(new THREE.CylinderGeometry(R * 0.36, R * 0.36, R * 0.26, 16), hpMat, side * R * 1.08, R * 0.02, 0);
      cup.rotation.z = Math.PI / 2;
      group.add(cup);
      const pad = mesh(new THREE.CylinderGeometry(R * 0.26, R * 0.26, R * 0.05, 14), padMat, side * R * 1.23, R * 0.02, 0);
      pad.rotation.z = Math.PI / 2;
      group.add(pad);
    }
  } else if (acc === "headlamp") {
    const strap = new THREE.Mesh(new THREE.TorusGeometry(R * 1.06, R * 0.07, 6, 24), m("#22252b"));
    strap.position.y = R * 0.42;
    strap.rotation.x = Math.PI / 2 - 0.12;
    strap.scale.set(1, 1, 1);
    group.add(strap);
    const housing = mesh(new THREE.BoxGeometry(R * 0.5, R * 0.36, R * 0.25), m("#ffb703", { roughness: 0.4 }), 0, R * 0.5, R * 1.02);
    group.add(housing);
    const lens = mesh(
      new THREE.CircleGeometry(R * 0.13, 14),
      m("#fff6c2", { emissive: "#fff2a0", emissiveIntensity: 1.6, roughness: 0.2 }),
      0, R * 0.5, R * 1.15
    );
    group.add(lens);
  }
}

/* ------------------------------------------------------------------ */
/* back attachments                                                     */
/* ------------------------------------------------------------------ */
export function buildBackpack(look) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(normalizeLook(look).shirt).lerp(new THREE.Color("#5a4632"), 0.65),
    roughness: 0.8,
  });
  const trim = new THREE.MeshStandardMaterial({ color: 0x2b2d34, roughness: 0.6 });
  const pack = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.2, 4, 12), mat);
  pack.scale.set(1.15, 1, 0.62);
  g.add(pack);
  const pocket = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.06), mat);
  pocket.position.set(0, -0.1, -0.1);
  g.add(pocket);
  const flap = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.07), trim);
  flap.position.set(0, -0.03, -0.11);
  g.add(flap);
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.36, 12), m("#52b788", { roughness: 0.8 }));
  roll.rotation.z = Math.PI / 2;
  roll.position.set(0, 0.25, -0.02);
  g.add(roll);
  return g;
}

export function buildCape(look, dims = BODY.male) {
  const l = normalizeLook(look);
  const w = dims.shoulderX * 2 + 0.06;
  const h = 1.05;
  const geo = new THREE.PlaneGeometry(w, h, 6, 10);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i) - h / 2; // top edge at 0
    const t = -y / h; // 0 top → 1 bottom
    const spread = 1 + t * 0.35; // flares towards the hem
    const nx = x * spread;
    // wrap around the back, deeper at the shoulders
    const z = -((nx / (w / 2)) ** 2) * -0.06 * (1 - t * 0.6) - t * 0.04;
    pos.setXYZ(i, nx, y, z);
  }
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color("#b3202c").lerp(new THREE.Color(l.shirt), 0.22),
    roughness: 0.75,
    side: THREE.DoubleSide,
  });
  const g = new THREE.Group();
  const cloth = new THREE.Mesh(geo, mat);
  g.add(cloth);
  // little dino spikes down the back of the cape
  const spikeMat = m("#ffd166", { roughness: 0.5 });
  for (let i = 0; i < 4; i++) {
    const sp = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.08, 4), spikeMat);
    sp.position.set(0, -0.15 - i * 0.2, -0.045 - i * 0.012);
    sp.rotation.x = -Math.PI / 2;
    g.add(sp);
  }
  return g;
}
