import * as THREE from "three";
import { clamp, damp, lerp, makeBlobShadow, makeNameTag } from "./util.js";

export const SKIN_TONES = [
  { id: "s1", name: "Porcelain", hex: "#f2d3bd" },
  { id: "s2", name: "Peach", hex: "#e6b48f" },
  { id: "s3", name: "Honey", hex: "#c98c5f" },
  { id: "s4", name: "Bronze", hex: "#a2663f" },
  { id: "s5", name: "Umber", hex: "#75462b" },
  { id: "s6", name: "Espresso", hex: "#4a2c1c" },
];

export const SHIRT_COLORS = [
  { id: "c1", name: "Museum Teal", hex: "#2ec4b6" },
  { id: "c2", name: "Fossil Amber", hex: "#ffb703" },
  { id: "c3", name: "Bone Cream", hex: "#f4ead5" },
  { id: "c4", name: "Velvet Red", hex: "#e5383b" },
  { id: "c5", name: "Deep Space", hex: "#3a0ca3" },
  { id: "c6", name: "Fern Green", hex: "#52b788" },
  { id: "c7", name: "Lavender", hex: "#b892ff" },
  { id: "c8", name: "Charcoal", hex: "#2b2d42" },
];

export const PANTS_COLORS = [
  { id: "p1", name: "Slate", hex: "#495057" },
  { id: "p2", name: "Denim", hex: "#3f6fb5" },
  { id: "p3", name: "Khaki", hex: "#b08968" },
  { id: "p4", name: "Black", hex: "#1f1f24" },
  { id: "p5", name: "Olive", hex: "#6b705c" },
];

export const HAIR_STYLES = [
  { id: "h1", name: "Short", hex: "#2b1d12" },
  { id: "h2", name: "Bun", hex: "#4a2c17" },
  { id: "h3", name: "Spiky", hex: "#141414" },
  { id: "h4", name: "Long", hex: "#6b3f1d" },
  { id: "h5", name: "Buzz", hex: "#3b2b20" },
  { id: "h6", name: "Mohawk", hex: "#ff5d8f" },
  { id: "h7", name: "Curly", hex: "#1c1108" },
];

export const ACCESSORIES = [
  { id: "a0", name: "None" },
  { id: "a1", name: "Round Glasses" },
  { id: "a2", name: "Explorer Cap" },
  { id: "a3", name: "Backpack" },
  { id: "a4", name: "Headphones" },
  { id: "a5", name: "Dino Cape" },
  { id: "a6", name: "Headlamp" },
];

export const DEFAULT_LOOK = {
  skin: "#e6b48f",
  shirt: "#2ec4b6",
  pants: "#495057",
  hair: "short",
  hairColor: "#2b1d12",
  accessory: "cap",
};

function color(hex) {
  return new THREE.Color(hex);
}

function m(hex, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(hex),
    roughness: opts.roughness ?? 0.72,
    metalness: opts.metalness ?? 0.04,
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
  });
}

export function randomLook() {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const hair = pick(HAIR_STYLES);
  return {
    skin: pick(SKIN_TONES).hex,
    shirt: pick(SHIRT_COLORS).hex,
    pants: pick(PANTS_COLORS).hex,
    hair: hair.id,
    hairColor: hair.hex,
    accessory: pick(ACCESSORIES).id,
  };
}

export function normalizeLook(look) {
  const l = { ...DEFAULT_LOOK, ...(look || {}) };
  return l;
}

/**
 * Builds a stylised visitor character.
 */
export function createCharacter(lookInput = {}, opts = {}) {
  const look = normalizeLook(lookInput);
  const root = new THREE.Group();
  const shadow = makeBlobShadow(0.55, 0.4);
  shadow.position.y = 0.02;
  root.add(shadow);

  const body = new THREE.Group();
  root.add(body);

  const skinMat = m(look.skin, { roughness: 0.85 });
  const shirtMat = m(look.shirt, { roughness: 0.8 });
  const pantsMat = m(look.pants, { roughness: 0.85 });
  const hairMat = m(look.hairColor, { roughness: 0.95 });
  const shoeMat = m("#22252b", { roughness: 0.6 });

  // torso
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.29, 0.42, 6, 14), shirtMat);
  torso.position.y = 1.16;
  torso.scale.set(1.05, 1, 0.82);
  body.add(torso);

  const hips = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.14, 5, 12), pantsMat);
  hips.position.y = 0.82;
  hips.scale.set(1.02, 1, 0.85);
  body.add(hips);

  // neck + head
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.12, 10), skinMat);
  neck.position.y = 1.49;
  body.add(neck);

  const head = new THREE.Group();
  head.position.y = 1.62;
  body.add(head);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.23, 18, 14), skinMat);
  skull.scale.set(1, 1.08, 0.96);
  head.add(skull);

  const eyeWhite = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 })
  );
  eyeWhite.position.set(-0.085, 0.03, 0.195);
  eyeWhite.scale.set(1, 1.15, 0.6);
  head.add(eyeWhite);
  const eyeWhite2 = eyeWhite.clone();
  eyeWhite2.position.x = 0.085;
  head.add(eyeWhite2);

  const pupilMat = new THREE.MeshBasicMaterial({ color: 0x1a1a20 });
  const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), pupilMat);
  pupil.position.set(-0.085, 0.03, 0.228);
  head.add(pupil);
  const pupil2 = pupil.clone();
  pupil2.position.x = 0.085;
  head.add(pupil2);

  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 6), skinMat);
  nose.position.set(0, -0.035, 0.225);
  head.add(nose);

  const mouth = new THREE.Mesh(
    new THREE.BoxGeometry(0.09, 0.018, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x7d3b3b, roughness: 0.6 })
  );
  mouth.position.set(0, -0.095, 0.215);
  head.add(mouth);

  // hair
  const hairGroup = new THREE.Group();
  head.add(hairGroup);
  buildHair(hairGroup, look, hairMat);

  // accessory
  const accessoryGroup = new THREE.Group();
  head.add(accessoryGroup);
  buildAccessory(accessoryGroup, look, m, shirtMat);

  // arms
  function buildArm(side) {
    const g = new THREE.Group();
    g.position.set(side * 0.33, 1.36, 0);
    body.add(g);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.28, 4, 10), shirtMat);
    upper.position.y = -0.2;
    g.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.36;
    g.add(elbow);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.26, 4, 10), skinMat);
    fore.position.y = -0.17;
    elbow.add(fore);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), skinMat);
    hand.position.y = -0.33;
    elbow.add(hand);
    return { group: g, elbow, hand };
  }
  const armL = buildArm(-1);
  const armR = buildArm(1);

  // legs
  function buildLeg(side) {
    const g = new THREE.Group();
    g.position.set(side * 0.13, 0.82, 0);
    body.add(g);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.115, 0.28, 4, 10), pantsMat);
    thigh.position.y = -0.19;
    g.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.36;
    g.add(knee);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.26, 4, 10), pantsMat);
    shin.position.y = -0.18;
    knee.add(shin);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.11, 0.29), shoeMat);
    foot.position.set(0, -0.36, 0.055);
    knee.add(foot);
    return { group: g, knee };
  }
  const legL = buildLeg(-1);
  const legR = buildLeg(1);

  // held item (ice cream cone)
  const handAnchor = new THREE.Group();
  handAnchor.position.set(0, -0.34, 0.04);
  armR.elbow.add(handAnchor);

  // name tag
  const tag = makeNameTag(opts.name || "Visitor", opts.tagColor || "#ffffff");
  tag.position.y = 2.28;
  tag.scale.set(1.5, 0.38, 1);
  root.add(tag);

  const st = {
    phase: 0,
    speed: 0,
    anim: "idle",
    action: null,
    actionT: 0,
    bob: 0,
  };

  const api = {
    group: root,
    head,
    handAnchor,
    tag,
    look,
    setLook(newLook) {
      Object.assign(api.look, newLook);
      skinMat.color.set(api.look.skin);
      shirtMat.color.set(api.look.shirt);
      pantsMat.color.set(api.look.pants);
      hairMat.color.set(api.look.hairColor);
      hairGroup.clear();
      buildHair(hairGroup, api.look, hairMat);
      accessoryGroup.clear();
      buildAccessory(accessoryGroup, api.look, m, shirtMat);
    },
    setName(name, tagColor) {
      root.remove(tag);
      tag.material.map.dispose();
      const t = makeNameTag(name, tagColor || "#ffffff");
      t.position.y = 2.28;
      t.scale.set(1.5, 0.38, 1);
      root.add(t);
      api.tag = t;
    },
    playAction(name, duration = 1.2) {
      st.action = name;
      st.actionT = duration;
    },
    setHeld(object3d) {
      while (handAnchor.children.length) handAnchor.remove(handAnchor.children[0]);
      if (object3d) handAnchor.add(object3d);
    },
    update(dt, opts = {}) {
      const targetSpeed = clamp(opts.speed ?? 0, 0, 1);
      st.speed = damp(st.speed, targetSpeed, 9, dt);
      const running = st.anim === "run";
      const moving = st.speed > 0.05;
      st.phase += dt * (3 + st.speed * 9);

      if (st.actionT > 0) st.actionT -= dt;

      const p = st.phase;
      const swing = moving ? 0.55 + st.speed * 0.55 : 0;

      legL.group.rotation.x = Math.sin(p) * swing;
      legR.group.rotation.x = Math.sin(p + Math.PI) * swing;
      legL.knee.rotation.x = Math.max(0, -Math.sin(p)) * swing * 1.1;
      legR.knee.rotation.x = Math.max(0, -Math.sin(p + Math.PI)) * swing * 1.1;

      const armSwing = moving ? Math.sin(p + Math.PI) * (0.45 + st.speed * 0.4) : Math.sin(p * 0.5) * 0.05;
      armL.group.rotation.x = armSwing;
      armR.group.rotation.x = -armSwing;
      armL.group.rotation.z = 0.12;
      armR.group.rotation.z = -0.12;
      armL.elbow.rotation.x = -0.2 - Math.abs(armSwing) * 0.3;
      armR.elbow.rotation.x = -0.2 - Math.abs(armSwing) * 0.3;

      const bob = moving ? Math.abs(Math.sin(p)) * 0.055 * (1 + st.speed) : Math.sin(p * 0.6) * 0.012;
      body.position.y = bob;
      body.rotation.z = Math.sin(p) * (moving ? 0.035 : 0.008);
      head.position.y = 1.62 + bob * 0.4;
      head.rotation.y = Math.sin(p * 0.4) * 0.1;

      // actions
      if (st.action === "roar") {
        const k = clamp(st.actionT / 0.8, 0, 1);
        head.rotation.x = -0.4 * k;
        armL.group.rotation.x = -1.1 * k;
        armR.group.rotation.x = -1.1 * k;
        armL.group.rotation.z = 0.6 * k;
        armR.group.rotation.z = -0.6 * k;
        mouth.scale.y = 1 + k * 2.2;
      } else if (st.action === "wave") {
        const k = clamp(st.actionT / 1.0, 0, 1);
        armR.group.rotation.x = -2.2 * k;
        armR.group.rotation.z = -0.5 * k;
        armR.elbow.rotation.x = -0.4 - Math.sin(p * 8) * 0.3 * k;
      } else if (st.action === "photo") {
        const k = clamp(st.actionT / 0.9, 0, 1);
        armR.group.rotation.x = -1.7 * k;
        armR.elbow.rotation.x = -1.1 * k;
      } else if (st.action === "eat") {
        const k = clamp(st.actionT / 2.2, 0, 1);
        const chew = Math.sin(st.actionT * 9) * 0.12 * k;
        armR.group.rotation.x = -1.15 * k;
        armR.elbow.rotation.x = -1.5 * k;
        head.rotation.x = 0.25 * k + chew;
        mouth.scale.y = 1 + Math.abs(chew) * 4;
      } else if (st.action === "cheer") {
        const k = clamp(st.actionT / 1.4, 0, 1);
        armL.group.rotation.x = -2.4 * k;
        armR.group.rotation.x = -2.4 * k;
        body.position.y += Math.abs(Math.sin(p * 3)) * 0.12 * k;
      } else {
        mouth.scale.y = lerp(mouth.scale.y, 1, Math.min(1, dt * 8));
      }

      if (running && st.actionT <= 0) {
        body.rotation.x = 0.14;
        head.rotation.x = -0.1;
      } else if (st.actionT <= 0) {
        body.rotation.x = lerp(body.rotation.x, 0, Math.min(1, dt * 8));
      }
    },
  };

  return api;
}

function buildHair(group, look, hairMat) {
  const style = look.hair;
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.235, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62),
    hairMat
  );
  cap.position.y = 0.015;
  cap.scale.set(1.03, 1.06, 1.03);
  group.add(cap);

  if (style === "bun") {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), hairMat);
    bun.position.set(0, 0.19, -0.2);
    group.add(bun);
  } else if (style === "spiky") {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      const sp = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.19, 5), hairMat);
      sp.position.set(Math.cos(a) * 0.1, 0.19, Math.sin(a) * 0.1);
      sp.rotation.set(Math.sin(a) * 0.5, 0, -Math.cos(a) * 0.5);
      group.add(sp);
    }
  } else if (style === "long") {
    const back = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.19, 0.34, 5, 12),
      hairMat
    );
    back.position.set(0, -0.16, -0.09);
    back.scale.set(1, 1, 0.7);
    group.add(back);
  } else if (style === "mohawk") {
    const moh = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.26, 0.36), hairMat);
    moh.position.set(0, 0.2, 0);
    moh.rotation.x = -0.08;
    group.add(moh);
  } else if (style === "curly") {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const r = 0.13 + Math.random() * 0.06;
      const c = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), hairMat);
      c.position.set(Math.cos(a) * r, 0.16 + Math.random() * 0.05, Math.sin(a) * r);
      group.add(c);
    }
  }
}

function buildAccessory(group, look, matFn, shirtMat) {
  const acc = look.accessory;
  if (acc === "glasses") {
    const lensMat = new THREE.MeshStandardMaterial({
      color: 0x223344,
      roughness: 0.2,
      metalness: 0.6,
      transparent: true,
      opacity: 0.85,
    });
    for (const side of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.014, 6, 14), lensMat);
      lens.position.set(side * 0.085, 0.03, 0.215);
      group.add(lens);
    }
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.012), lensMat);
    bridge.position.set(0, 0.03, 0.215);
    group.add(bridge);
  } else if (acc === "cap") {
    const capMat = matFn(look.shirt, { roughness: 0.75 });
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.235, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
      capMat
    );
    cap.position.y = 0.04;
    group.add(cap);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.03, 0.2), capMat);
    brim.position.set(0, 0.045, 0.22);
    group.add(brim);
  } else if (acc === "headphones") {
    const hpMat = matFn("#22252b", { roughness: 0.5, metalness: 0.3 });
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.025, 6, 16, Math.PI), hpMat);
    band.position.y = 0.02;
    band.rotation.y = Math.PI / 2;
    group.add(band);
    for (const side of [-1, 1]) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.06, 12), hpMat);
      cup.position.set(side * 0.23, 0.02, 0);
      cup.rotation.z = Math.PI / 2;
      group.add(cup);
    }
  } else if (acc === "headlamp") {
    const lampMat = matFn("#ffd166", { roughness: 0.3 });
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.05, 12), lampMat);
    lamp.position.set(0, 0.1, 0.21);
    lamp.rotation.x = Math.PI / 2;
    group.add(lamp);
    const strap = new THREE.Mesh(
      new THREE.TorusGeometry(0.235, 0.02, 5, 16, Math.PI),
      matFn("#22252b")
    );
    strap.position.y = 0.02;
    strap.rotation.y = Math.PI / 2;
    group.add(strap);
  }
}

export function buildBackpack(look) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(look.shirt).multiplyScalar(0.7),
    roughness: 0.8,
  });
  const pack = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.46, 0.2), mat);
  g.add(pack);
  const pocket = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.18, 0.1), mat);
  pocket.position.set(0, -0.12, 0.12);
  g.add(pocket);
  return g;
}

export function buildCape(look) {
  const geo = new THREE.BufferGeometry();
  const w = 0.62;
  const h = 0.95;
  const verts = new Float32Array([
    -w / 2, 0, 0, w / 2, 0, 0, -w / 2, -h, 0.08, w / 2, -h, 0.08,
  ]);
  geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geo.setIndex([0, 1, 2, 1, 3, 2]);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(look.shirt).lerp(new THREE.Color(0x000000), 0.25),
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  return new THREE.Mesh(geo, mat);
}
