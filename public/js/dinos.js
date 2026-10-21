import * as THREE from "three";
import { boneBetween, clamp, lerp, rand } from "./util.js";

/**
 * Every dinosaur in the museum is generated from code.
 *
 * A rig is a chain of spine joints (tail -> hips -> chest -> neck -> head)
 * with tapered body segments, limbs with a walk cycle, a species specific
 * skull and a set of ornaments (plates, horns, sails, wings, flippers...).
 * The same rig renders as bones for the museum mounts and as living animals
 * for the holograms and the battle screenings.
 */

export const BONE_MAT = new THREE.MeshStandardMaterial({
  color: 0xe6d8b8,
  roughness: 0.72,
  metalness: 0.02,
});
export const BONE_DARK = new THREE.MeshStandardMaterial({
  color: 0xc9b48c,
  roughness: 0.8,
});

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.72,
    metalness: opts.metalness ?? 0.03,
    flatShading: !!opts.flat,
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.transparent,
    opacity: opts.opacity ?? 1,
  });
}

function spike(r, h, material) {
  const g = new THREE.ConeGeometry(r, h, 7);
  g.translate(0, h / 2, 0);
  return new THREE.Mesh(g, material);
}

function ellipsoid(rx, ry, rz, material, seg = 12) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, seg, Math.max(6, seg / 2)), material);
  m.scale.set(rx, ry, rz);
  return m;
}

function finGeometry(height, width) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0);
  shape.quadraticCurveTo(0, height * 0.45, width / 2, 0);
  shape.lineTo(width / 2, -0.12);
  shape.lineTo(-width / 2, -0.12);
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 12);
}

function crescent(width, height) {
  const shape = new THREE.Shape();
  shape.moveTo(0, height);
  shape.quadraticCurveTo(width * 0.55, 0, 0, -height);
  shape.quadraticCurveTo(-width * 0.55, 0, 0, height);
  return new THREE.ShapeGeometry(shape, 14);
}

const HEAD_BUILDERS = {};

/**
 * @param {object} spec   species rig definition
 * @param {object} opts   { skeleton, scale }
 */
export function createDino(spec, opts = {}) {
  const skeleton = !!opts.skeleton;
  const scale = opts.scale ?? 1;
  const root = new THREE.Group();
  root.name = `dino:${spec.id || "species"}`;

  const bodyMat = skeleton ? BONE_MAT : mat(spec.color, { roughness: 0.78 });
  const bellyMat = skeleton ? BONE_DARK : mat(spec.belly, { roughness: 0.85 });
  const accentMat = skeleton ? BONE_MAT : mat(spec.accent, { roughness: 0.7 });
  const eyeMat = skeleton ? BONE_MAT : mat(spec.eye || 0xffd34d, { roughness: 0.4 });
  const feat = spec.features || {};
  const plan = spec.plan || "biped";

  const s = (spec.scale || 1) * scale;
  const H = spec.hip * s;
  const B = spec.body * s;
  const N = spec.neck * s;
  const T = spec.tail * s;

  // ---------------- spine chain ----------------
  const joints = [];
  const tailSteps = spec.tailSteps || 5;
  for (let i = 0; i < tailSteps; i++) {
    const f = i / (tailSteps - 1);
    joints.push({
      name: `tail${i}`,
      pos: new THREE.Vector3(0, lerp(H * 0.3, H * 0.92, f * f * 0.9 + f * 0.1), -T * (1 - f)),
      r: lerp(spec.r[3], spec.r[0] * 0.85, f),
    });
  }
  joints.push({ name: "hip", pos: new THREE.Vector3(0, H, 0), r: spec.r[0] });
  joints.push({ name: "chest", pos: new THREE.Vector3(0, H + 0.22 * s, B * 0.52), r: spec.r[1] });
  joints.push({ name: "neck0", pos: new THREE.Vector3(0, H + 0.55 * s, B * 0.8), r: spec.r[2] });
  joints.push({
    name: "neck1",
    pos: new THREE.Vector3(0, H + spec.neckRise * 0.62 * s, B * 0.88 + N * 0.5),
    r: spec.r[2] * 0.86,
  });
  joints.push({
    name: "head",
    pos: new THREE.Vector3(0, H + spec.neckRise * s, B * 0.9 + N),
    r: spec.r[2] * 0.7,
  });

  const segments = [];
  const spine = new THREE.Group();
  root.add(spine);

  for (let i = 0; i < joints.length; i++) {
    const j = joints[i];
    const g = new THREE.Group();
    g.position.copy(j.pos);
    g.name = j.name;
    spine.add(g);
    const next = joints[i + 1];
    const len = next ? j.pos.distanceTo(next.pos) : 0;

    if (skeleton) {
      const vert = new THREE.Mesh(
        new THREE.CylinderGeometry(j.r * 0.22, j.r * 0.22, Math.max(0.14, len * 0.6), 6),
        BONE_MAT
      );
      vert.rotation.x = Math.PI / 2;
      vert.position.z = len * 0.3;
      g.add(vert);
      if (next && j.r > spec.r[2] * 1.15) {
        const neural = new THREE.Mesh(
          new THREE.BoxGeometry(j.r * 0.14, j.r * 0.55, j.r * 0.22),
          BONE_MAT
        );
        neural.position.y = j.r * 0.52;
        neural.position.z = len * 0.2;
        g.add(neural);
      }
    } else {
      const seg = ellipsoid(j.r, j.r * 0.92, len * 0.6 + j.r * 0.42, bodyMat, 14);
      seg.position.z = len * 0.3;
      g.add(seg);
    }
    segments.push({ group: g, joint: j, len, index: i });
  }

  if (!skeleton) {
    const belly = ellipsoid(spec.r[0] * 0.84, spec.r[0] * 0.48, B * 0.34, bellyMat, 12);
    belly.position.set(0, H - spec.r[0] * 0.44, B * 0.28);
    spine.add(belly);
  }

  // ---------------- ribs ----------------
  if (skeleton) {
    const chest = joints.find((j) => j.name === "chest");
    const ribCount = 7;
    for (let i = 0; i < ribCount; i++) {
      const f = i / (ribCount - 1);
      const ribR = lerp(spec.r[0], spec.r[1], 0.4) * (0.92 - f * 0.16);
      const torus = new THREE.Mesh(
        new THREE.TorusGeometry(ribR, ribR * 0.07, 5, 14, Math.PI * 1.05),
        BONE_MAT
      );
      torus.position.set(0, chest.pos.y - ribR * 0.04, lerp(B * 0.05, B * 0.48, f) * s);
      torus.rotation.set(Math.PI / 2, 0, 0);
      spine.add(torus);
      const t2 = torus.clone();
      t2.scale.x = -1;
      spine.add(t2);
    }
  }

  // ---------------- limbs ----------------
  function buildLeg(parent, origin, thighLen, shinLen, footLen, width, flipper = false) {
    const hipGroup = new THREE.Group();
    hipGroup.position.copy(origin);
    parent.add(hipGroup);
    const limbMat = skeleton ? BONE_MAT : bodyMat;

    const thigh = new THREE.Group();
    hipGroup.add(thigh);
    if (skeleton) {
      thigh.add(
        boneBetween(new THREE.Vector3(), new THREE.Vector3(0, -thighLen, 0), thighLen * 0.07, BONE_MAT)
      );
      const knee = new THREE.Mesh(new THREE.SphereGeometry(thighLen * 0.1, 8, 6), BONE_MAT);
      knee.position.y = -thighLen;
      thigh.add(knee);
    } else {
      const m = ellipsoid(width, thighLen * 0.58, width * 1.05, limbMat, 10);
      m.position.y = -thighLen * 0.5;
      thigh.add(m);
    }

    const knee = new THREE.Group();
    knee.position.y = -thighLen;
    thigh.add(knee);
    if (skeleton) {
      knee.add(
        boneBetween(new THREE.Vector3(), new THREE.Vector3(0, -shinLen, 0), shinLen * 0.055, BONE_MAT)
      );
      const ankle = new THREE.Mesh(new THREE.SphereGeometry(shinLen * 0.08, 8, 6), BONE_MAT);
      ankle.position.y = -shinLen;
      knee.add(ankle);
    } else {
      const m = ellipsoid(width * 0.78, shinLen * 0.55, width * 0.85, limbMat, 10);
      m.position.y = -shinLen * 0.5;
      knee.add(m);
    }

    const ankle = new THREE.Group();
    ankle.position.y = -shinLen;
    knee.add(ankle);
    if (skeleton) {
      ankle.add(
        boneBetween(
          new THREE.Vector3(0, 0, 0),
          new THREE.Vector3(0, -footLen * 0.4, footLen * 0.2),
          footLen * 0.045,
          BONE_MAT
        )
      );
      for (let t = 0; t < 3; t++) {
        ankle.add(
          boneBetween(
            new THREE.Vector3(0, -footLen * 0.4, footLen * 0.2),
            new THREE.Vector3((t - 1) * footLen * 0.18, -footLen * 0.42, footLen * 0.55),
            footLen * 0.032,
            BONE_MAT
          )
        );
      }
    } else if (flipper) {
      const paddle = new THREE.Mesh(
        new THREE.CapsuleGeometry(width * 0.6, footLen * 1.3, 4, 10),
        limbMat
      );
      paddle.rotation.x = Math.PI / 2;
      paddle.position.set(0, -footLen * 0.1, footLen * 0.55);
      paddle.scale.set(1, 0.5, 1);
      ankle.add(paddle);
    } else {
      const foot = new THREE.Mesh(
        new THREE.BoxGeometry(width * 1.45, footLen * 0.2, footLen * 1.1),
        accentMat
      );
      foot.position.set(0, -footLen * 0.1, footLen * 0.22);
      ankle.add(foot);
    }
    return { hip: hipGroup, thigh, knee, ankle };
  }

  const legs = [];
  const hipJoint = joints.find((j) => j.name === "hip");
  const chestJoint = joints.find((j) => j.name === "chest");
  const legHalf = (spec.legs || 0.6) * s;

  if (plan === "biped" || plan === "flyer") {
    for (const side of [-1, 1]) {
      legs.push(
        buildLeg(
          spine,
          new THREE.Vector3(side * legHalf, hipJoint.pos.y, hipJoint.pos.z),
          spec.thigh * s,
          spec.shin * s,
          spec.foot * s,
          spec.r[0] * 0.46
        )
      );
    }
  } else if (plan === "quad") {
    for (const side of [-1, 1]) {
      legs.push(
        buildLeg(
          spine,
          new THREE.Vector3(side * legHalf, hipJoint.pos.y, hipJoint.pos.z),
          spec.thigh * s,
          spec.shin * s,
          spec.foot * s,
          spec.r[0] * 0.42
        )
      );
      legs.push(
        buildLeg(
          spine,
          new THREE.Vector3(side * legHalf * 0.92, chestJoint.pos.y, chestJoint.pos.z),
          spec.thigh * 0.92 * s,
          spec.shin * 0.92 * s,
          spec.foot * s,
          spec.r[1] * 0.4
        )
      );
    }
  } else if (plan === "marine") {
    for (const side of [-1, 1]) {
      legs.push(
        buildLeg(
          spine,
          new THREE.Vector3(side * legHalf * 1.15, chestJoint.pos.y - spec.r[1] * 0.2, chestJoint.pos.z + B * 0.12),
          spec.thigh * 0.55 * s,
          spec.shin * 0.55 * s,
          spec.foot * 1.7 * s,
          spec.r[1] * 0.5,
          true
        )
      );
      legs.push(
        buildLeg(
          spine,
          new THREE.Vector3(side * legHalf * 0.8, hipJoint.pos.y - spec.r[0] * 0.15, hipJoint.pos.z),
          spec.thigh * 0.45 * s,
          spec.shin * 0.45 * s,
          spec.foot * 1.4 * s,
          spec.r[0] * 0.42,
          true
        )
      );
    }
  }

  // ---------------- head ----------------
  const headJoint = joints[joints.length - 1];
  const headGroup = new THREE.Group();
  headGroup.position.copy(headJoint.pos);
  const neck1 = joints[joints.length - 2];
  const dir = headJoint.pos.clone().sub(neck1.pos).normalize();
  headGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  spine.add(headGroup);

  const headLen = spec.head * s;
  const jaw = new THREE.Group();
  headGroup.add(jaw);

  const skullMat = skeleton ? BONE_MAT : bodyMat;
  const jawMat = skeleton ? BONE_DARK : bellyMat;

  function addEyes(scale = 1, top = 0) {
    if (skeleton) return;
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(headLen * 0.1 * scale, 10, 8), eyeMat);
      eye.position.set(side * headLen * 0.33, headLen * 0.12 + top, headLen * 0.26);
      eye.scale.y = 1.05;
      headGroup.add(eye);
      const pupil = new THREE.Mesh(
        new THREE.SphereGeometry(headLen * 0.055 * scale, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0x10100c })
      );
      pupil.position.set(side * headLen * 0.39, headLen * 0.12 + top, headLen * 0.29);
      headGroup.add(pupil);
    }
  }

  function addTeeth(count = 7, size = 0.2) {
    if (skeleton) return;
    for (let i = 0; i < count; i++) {
      const t = spike(headLen * 0.045, headLen * size, mat(0xfff6e2));
      t.position.set(0, -headLen * 0.1, headLen * 0.2 + (i / count) * headLen * 0.62);
      t.rotation.x = Math.PI;
      headGroup.add(t);
    }
  }

  const headType = spec.headType || "theropod";

  if (headType === "theropod" || headType === "raptor") {
    const skull = ellipsoid(headLen * 0.42, headLen * 0.38, headLen * 0.5, skullMat, 14);
    skull.position.z = headLen * 0.18;
    headGroup.add(skull);
    const snout = new THREE.Mesh(
      new THREE.BoxGeometry(headLen * 0.4, headLen * 0.28, headLen * 0.56),
      skullMat
    );
    snout.position.set(0, -headLen * 0.04, headLen * 0.58);
    headGroup.add(snout);
    jaw.position.set(0, -headLen * 0.12, headLen * 0.1);
    const jawMesh = new THREE.Mesh(
      new THREE.BoxGeometry(headLen * 0.34, headLen * 0.15, headLen * 0.8),
      jawMat
    );
    jawMesh.position.z = headLen * 0.34;
    jaw.add(jawMesh);
    addEyes();
    addTeeth(headType === "raptor" ? 5 : 7, 0.2);
  } else if (headType === "duckbill") {
    const skull = ellipsoid(headLen * 0.34, headLen * 0.32, headLen * 0.42, skullMat, 14);
    skull.position.z = headLen * 0.12;
    headGroup.add(skull);
    const beak = new THREE.Mesh(
      new THREE.BoxGeometry(headLen * 0.34, headLen * 0.16, headLen * 0.72),
      skeleton ? BONE_MAT : accentMat
    );
    beak.position.set(0, -headLen * 0.08, headLen * 0.78);
    headGroup.add(beak);
    jaw.position.set(0, -headLen * 0.16, headLen * 0.2);
    const jawMesh = new THREE.Mesh(
      new THREE.BoxGeometry(headLen * 0.3, headLen * 0.1, headLen * 0.9),
      jawMat
    );
    jawMesh.position.z = headLen * 0.42;
    jaw.add(jawMesh);
    addEyes(1.05, headLen * 0.06);
  } else if (headType === "ceratopsian") {
    const skull = ellipsoid(headLen * 0.4, headLen * 0.34, headLen * 0.46, skullMat, 14);
    skull.position.z = headLen * 0.2;
    headGroup.add(skull);
    const beak = new THREE.Mesh(
      new THREE.ConeGeometry(headLen * 0.2, headLen * 0.42, 8),
      skeleton ? BONE_MAT : accentMat
    );
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, -headLen * 0.1, headLen * 0.86);
    headGroup.add(beak);
    jaw.position.set(0, -headLen * 0.16, headLen * 0.16);
    const jawMesh = new THREE.Mesh(
      new THREE.BoxGeometry(headLen * 0.34, headLen * 0.13, headLen * 0.66),
      jawMat
    );
    jawMesh.position.z = headLen * 0.36;
    jaw.add(jawMesh);
    addEyes(0.9);
  } else if (headType === "dome") {
    const skull = ellipsoid(headLen * 0.34, headLen * 0.32, headLen * 0.44, skullMat, 14);
    skull.position.z = headLen * 0.16;
    headGroup.add(skull);
    const dome = new THREE.Mesh(
      new THREE.SphereGeometry(headLen * 0.36, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
      skeleton ? BONE_MAT : accentMat
    );
    dome.position.set(0, headLen * 0.2, headLen * 0.02);
    headGroup.add(dome);
    const beak = new THREE.Mesh(
      new THREE.ConeGeometry(headLen * 0.14, headLen * 0.3, 8),
      skeleton ? BONE_MAT : accentMat
    );
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, -headLen * 0.12, headLen * 0.72);
    headGroup.add(beak);
    jaw.position.set(0, -headLen * 0.16, headLen * 0.1);
    const jawMesh = new THREE.Mesh(
      new THREE.BoxGeometry(headLen * 0.28, headLen * 0.12, headLen * 0.56),
      jawMat
    );
    jawMesh.position.z = headLen * 0.3;
    jaw.add(jawMesh);
    addEyes(0.85);
  } else if (headType === "beak") {
    const skull = ellipsoid(headLen * 0.3, headLen * 0.3, headLen * 0.36, skullMat, 14);
    skull.position.z = headLen * 0.1;
    headGroup.add(skull);
    const beak = new THREE.Mesh(
      new THREE.ConeGeometry(headLen * 0.13, headLen * 0.85, 8),
      skeleton ? BONE_MAT : accentMat
    );
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, -headLen * 0.02, headLen * 0.72);
    headGroup.add(beak);
    addEyes(1.05);
  } else if (headType === "fish") {
    const skull = ellipsoid(headLen * 0.3, headLen * 0.32, headLen * 0.6, skullMat, 14);
    skull.position.z = headLen * 0.28;
    headGroup.add(skull);
    const snout = new THREE.Mesh(
      new THREE.ConeGeometry(headLen * 0.24, headLen * 0.8, 10),
      skullMat
    );
    snout.rotation.x = Math.PI / 2;
    snout.position.set(0, -headLen * 0.02, headLen * 0.86);
    headGroup.add(snout);
    jaw.position.set(0, -headLen * 0.14, headLen * 0.16);
    const jawMesh = new THREE.Mesh(
      new THREE.BoxGeometry(headLen * 0.26, headLen * 0.12, headLen * 0.8),
      jawMat
    );
    jawMesh.position.z = headLen * 0.44;
    jaw.add(jawMesh);
    addTeeth(9, 0.16);
    addEyes(1.2, headLen * 0.08);
  }

  // ornaments on the head
  if (feat.noseHorn) {
    const nose = spike(headLen * 0.06, headLen * 0.45, accentMat);
    nose.position.set(0, headLen * 0.02, headLen * 0.86);
    nose.rotation.x = -1.35;
    headGroup.add(nose);
  }
  if (feat.horns) {
    for (const side of [-1, 1]) {
      const horn = spike(headLen * 0.07, headLen * 0.85, accentMat);
      horn.position.set(side * headLen * 0.26, headLen * 0.2, headLen * 0.45);
      horn.rotation.x = -0.9;
      horn.rotation.z = side * 0.25;
      headGroup.add(horn);
    }
  }
  if (feat.frill) {
    const frill = new THREE.Mesh(
      new THREE.CircleGeometry(headLen * 0.95, 16, 0, Math.PI * 1.55),
      accentMat
    );
    frill.position.set(0, headLen * 0.12, -headLen * 0.15);
    frill.rotation.y = -Math.PI * 0.28;
    frill.material.side = THREE.DoubleSide;
    headGroup.add(frill);
    const spikes = feat.frillSpikes || 0;
    for (let i = 0; i < spikes; i++) {
      const a = -Math.PI * 0.75 + (i / Math.max(1, spikes - 1)) * Math.PI * 1.5;
      const sp = spike(headLen * 0.055, headLen * (feat.longFrillSpikes ? 0.75 : 0.24), accentMat);
      sp.position.set(
        Math.sin(a) * headLen * 0.92,
        headLen * 0.12 + Math.cos(a) * headLen * 0.5,
        -headLen * 0.15
      );
      sp.rotation.x = -a + Math.PI / 2;
      headGroup.add(sp);
    }
  }
  if (feat.crest) {
    const crest = new THREE.Mesh(
      new THREE.ConeGeometry(headLen * 0.06, headLen * 0.9, 4),
      accentMat
    );
    crest.rotation.x = -0.25;
    crest.position.set(0, headLen * 0.42, headLen * 0.02);
    headGroup.add(crest);
  }
  if (feat.headCrest) {
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(headLen * 0.3, headLen * 0.5, headLen * 0.62, headLen * 0.34);
    shape.quadraticCurveTo(headLen * 0.3, headLen * 0.12, 0, 0);
    const crestGeo = new THREE.ExtrudeGeometry(shape, { depth: headLen * 0.1, bevelEnabled: false });
    const crest = new THREE.Mesh(crestGeo, accentMat);
    crest.position.set(0, headLen * 0.16, -headLen * 0.1);
    crest.rotation.y = Math.PI / 2;
    headGroup.add(crest);
  }
  if (feat.dumbbells) {
    for (const side of [-1, 1]) {
      const knuckle = new THREE.Mesh(
        new THREE.SphereGeometry(headLen * 0.14, 10, 8),
        accentMat
      );
      knuckle.position.set(side * headLen * 0.34, headLen * 0.34, headLen * 0.1);
      headGroup.add(knuckle);
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(headLen * 0.07, headLen * 0.07, headLen * 0.3, 8),
        accentMat
      );
      stem.position.set(side * headLen * 0.3, headLen * 0.24, headLen * 0.05);
      stem.rotation.z = side * 0.3;
      headGroup.add(stem);
    }
  }

  // ---------------- arms ----------------
  const arms = [];
  if (feat.arms) {
    const armLen = (spec.armLen || 0.9) * s;
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      const origin = new THREE.Vector3(
        side * spec.r[1] * 0.78,
        chestJoint.pos.y - spec.r[1] * 0.28,
        chestJoint.pos.z + B * 0.2
      );
      g.position.copy(origin);
      spine.add(g);
      const upper = ellipsoid(armLen * 0.2, armLen * 0.4, armLen * 0.2, skeleton ? BONE_MAT : bodyMat, 8);
      upper.position.y = -armLen * 0.34;
      g.add(upper);
      const fore = new THREE.Group();
      fore.position.y = -armLen * 0.6;
      g.add(fore);
      const foreMesh = ellipsoid(armLen * 0.16, armLen * 0.36, armLen * 0.16, skeleton ? BONE_MAT : bodyMat, 8);
      foreMesh.position.y = -armLen * 0.28;
      fore.add(foreMesh);
      if (feat.sickle) {
        const claw = new THREE.Mesh(
          new THREE.ConeGeometry(armLen * 0.09, armLen * 0.5, 6),
          skeleton ? BONE_MAT : mat(0x2b2119)
        );
        claw.position.set(0, -armLen * 0.6, armLen * 0.06);
        claw.rotation.x = -0.5;
        fore.add(claw);
      }
      if (feat.thumbSpike) {
        const sp = spike(armLen * 0.1, armLen * 0.6, skeleton ? BONE_MAT : accentMat);
        sp.position.set(0, -armLen * 0.62, armLen * 0.05);
        sp.rotation.x = -0.6;
        fore.add(sp);
      }
      arms.push({ group: g, fore });
    }
  }

  // ---------------- back ornaments ----------------
  if (feat.plates) {
    const n = 9;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const idx = 2 + Math.floor(f * (joints.length - 5));
      const j = joints[idx];
      const h = lerp(1.5, 0.7, Math.abs(f - 0.35) * 1.6) * s;
      for (const side of [-1, 1]) {
        const plate = new THREE.Mesh(
          new THREE.BoxGeometry(0.12 * s, h, h * 1.15),
          accentMat
        );
        plate.position.set(side * 0.42 * s, j.pos.y + j.r * 0.75 + h * 0.4, j.pos.z);
        plate.rotation.z = side * 0.22;
        plate.rotation.x = -0.12;
        spine.add(plate);
      }
    }
  }

  if (feat.spikes) {
    for (let i = 0; i < 4; i++) {
      const side = i < 2 ? -1 : 1;
      const sp = spike(0.16 * s, 1.1 * s, accentMat);
      sp.position.set(side * 0.2 * s, H * 0.45, -T * 0.96);
      sp.rotation.z = side * 0.9;
      sp.rotation.x = -0.5;
      spine.add(sp);
    }
  }

  if (feat.shoulderSpikes) {
    for (const side of [-1, 1]) {
      const sp = spike(0.2 * s, 1.5 * s, accentMat);
      sp.position.set(side * 0.6 * s, H + spec.r[0] * 0.7, B * 0.5);
      sp.rotation.z = side * 0.55;
      spine.add(sp);
    }
  }

  if (feat.spineRow) {
    const n = 14;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const idx = 2 + Math.floor(f * (joints.length - 4));
      const j = joints[idx];
      const sp = spike(0.11 * s, 0.7 * s, accentMat);
      sp.position.set(0, j.pos.y + j.r * 0.85, j.pos.z);
      sp.rotation.x = -0.25;
      spine.add(sp);
    }
  }

  if (feat.sail) {
    const n = 10;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const idx = 2 + Math.floor(f * (joints.length - 6));
      const j = joints[idx];
      const h = lerp(1.2, 2.6, Math.sin(f * Math.PI)) * s;
      const fin = new THREE.Mesh(finGeometry(h, h * 0.85), accentMat);
      fin.material.side = THREE.DoubleSide;
      fin.position.set(0, j.pos.y + j.r * 0.8, j.pos.z);
      fin.rotation.y = Math.PI / 2;
      spine.add(fin);
    }
  }

  if (feat.club) {
    const club = new THREE.Group();
    club.position.set(0, H * 0.38, -T * 0.97);
    spine.add(club);
    for (const side of [-1, 1]) {
      const knob = ellipsoid(0.45 * s, 0.45 * s, 0.45 * s, accentMat, 10);
      knob.position.set(side * 0.3 * s, 0, 0);
      club.add(knob);
    }
  }

  if (feat.clubSpikes) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const sp = spike(0.12 * s, 0.7 * s, accentMat);
      sp.position.set(Math.cos(a) * 0.55 * s, H * 0.38 + Math.sin(a) * 0.55 * s, -T * 0.94);
      sp.rotation.z = -a;
      spine.add(sp);
    }
  }

  if (feat.armor) {
    for (let i = 0; i < 12; i++) {
      const f = i / 11;
      const idx = 2 + Math.floor(f * (joints.length - 4));
      const j = joints[idx];
      const band = new THREE.Mesh(
        new THREE.TorusGeometry(j.r * 1.02, 0.12 * s, 4, 12),
        accentMat
      );
      band.rotation.x = Math.PI / 2;
      band.position.set(0, j.pos.y, j.pos.z);
      spine.add(band);
    }
  }

  if (feat.feathers) {
    for (let i = 0; i < 5; i++) {
      const f = i / 4;
      const j = joints[2 + Math.floor(f * 4)];
      const feather = new THREE.Mesh(new THREE.ConeGeometry(0.12 * s, 0.6 * s, 5), accentMat);
      feather.position.set(0, j.pos.y + j.r * 0.9, j.pos.z);
      feather.rotation.x = -0.5;
      spine.add(feather);
    }
  }

  if (feat.tailVane) {
    const vane = new THREE.Mesh(
      finGeometry(0.9 * s, 0.7 * s),
      accentMat
    );
    vane.material.side = THREE.DoubleSide;
    vane.position.set(0, H * 0.32, -T * 0.98);
    vane.rotation.y = Math.PI / 2;
    spine.add(vane);
  }

  if (feat.tailFin) {
    const fin = new THREE.Mesh(crescent(1.5 * s, 2.4 * s), accentMat);
    fin.material.side = THREE.DoubleSide;
    fin.position.set(0, H * 0.3, -T * 0.94);
    fin.rotation.y = Math.PI / 2;
    spine.add(fin);
  }

  if (feat.dorsalFin) {
    const fin = new THREE.Mesh(finGeometry(1.6 * s, 1.3 * s), accentMat);
    fin.material.side = THREE.DoubleSide;
    const j = joints[3];
    fin.position.set(0, j.pos.y + j.r * 0.9, j.pos.z);
    fin.rotation.y = Math.PI / 2;
    spine.add(fin);
  }

  if (feat.hump) {
    const hump = ellipsoid(spec.r[0] * 0.7, spec.r[0] * 0.55, B * 0.3, bodyMat, 12);
    hump.position.set(0, H + spec.r[0] * 0.5, B * 0.35);
    spine.add(hump);
  }

  if (feat.wings) {
    const wingLen = (spec.wingLen || 4.4) * s;
    for (const side of [-1, 1]) {
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.quadraticCurveTo(wingLen * 0.45, wingLen * 0.34, wingLen, wingLen * 0.06);
      shape.quadraticCurveTo(wingLen * 0.55, -wingLen * 0.1, 0, -wingLen * 0.22);
      shape.closePath();
      const geo = new THREE.ShapeGeometry(shape, 14);
      const wing = new THREE.Mesh(
        geo,
        skeleton
          ? BONE_MAT
          : new THREE.MeshStandardMaterial({
              color: spec.color,
              roughness: 0.85,
              side: THREE.DoubleSide,
            })
      );
      wing.rotation.x = -Math.PI / 2;
      wing.rotation.y = Math.PI / 2;
      wing.position.set(
        side * spec.r[1] * 0.6,
        chestJoint.pos.y + spec.r[1] * 0.5,
        chestJoint.pos.z
      );
      wing.name = `wing${side > 0 ? "R" : "L"}`;
      spine.add(wing);
      const spar = boneBetween(
        new THREE.Vector3(),
        new THREE.Vector3(side * wingLen, 0, 0),
        0.12 * s,
        skeleton ? BONE_MAT : accentMat
      );
      spar.position.copy(wing.position);
      spine.add(spar);
    }
  }

  // ---------------- animation ----------------
  const state = { phase: rand(0, Math.PI * 2), speed: 0, anim: "idle", jaw: 0 };

  const api = {
    group: root,
    spec,
    skeleton,
    scale: s,
    head: headGroup,
    jaw,
    parts: { segments, legs, arms, spine, headGroup, jaw },
    setAnim(name) {
      state.anim = name;
    },
    update(dt, opts = {}) {
      const target = opts.speed ?? state.speed;
      state.speed += (target - state.speed) * Math.min(1, dt * 8);
      const moving = state.speed > 0.06;
      const swimming = plan === "marine";
      state.phase += dt * (swimming ? 1.6 + state.speed * 2.2 : 2.4 + state.speed * 7.5);
      const sw = Math.sin(state.phase);
      const sw2 = Math.sin(state.phase * 2);

      const amp = moving ? (swimming ? 0.35 : 0.42 + state.speed * 0.35) : 0;
      legs.forEach((leg, i) => {
        const off = i % 2 === 0 ? 0 : Math.PI;
        const p = state.phase + off + (i >= 2 ? Math.PI * 0.5 : 0);
        const a = Math.sin(p) * amp;
        leg.thigh.rotation.x = a;
        leg.knee.rotation.x = Math.max(0, -Math.sin(p - 0.7)) * amp * 1.3;
        leg.ankle.rotation.x = -a * 0.35;
        if (swimming) leg.hip.rotation.z = (i % 2 === 0 ? 1 : -1) * 0.25;
      });

      arms.forEach((arm, i) => {
        const off = i === 0 ? Math.PI : 0;
        arm.group.rotation.x = moving ? Math.sin(state.phase + off) * 0.35 : Math.sin(state.phase * 0.6) * 0.05;
        arm.group.rotation.z = (i === 0 ? 1 : -1) * 0.14;
        arm.fore.rotation.x = moving ? -Math.abs(Math.sin(state.phase + off)) * 0.4 : 0;
      });

      segments.forEach((seg, i) => {
        const t = i / segments.length;
        const wave = Math.sin(state.phase * 0.9 - i * 0.5) * (0.02 + t * 0.05) * (moving ? 1.4 : 0.6);
        seg.group.rotation.y = wave;
        seg.group.rotation.x = Math.sin(state.phase * 0.9 - i * 0.35) * 0.02 * (moving ? 1.5 : 0.7);
      });

      const bobAmount = moving ? (swimming ? 0.05 : 0.09) * s : 0.02 * s;
      spine.position.y = Math.abs(sw2) * bobAmount;
      spine.rotation.z = sw * 0.012;

      let jawOpen = 0;
      let headPitch = 0;
      if (state.anim === "roar") {
        jawOpen = 0.55 + Math.sin(state.phase * 3) * 0.25;
        headPitch = -0.22;
      } else if (state.anim === "attack") {
        jawOpen = Math.max(0, Math.sin(state.phase * 4)) * 0.8;
        headPitch = 0.12;
      } else if (state.anim === "eat") {
        jawOpen = 0.25 + Math.abs(Math.sin(state.phase * 2.5)) * 0.3;
        headPitch = 0.3;
      } else if (state.anim === "dead") {
        jawOpen = 0.12;
        headPitch = 0.5;
      } else {
        jawOpen = Math.max(0, Math.sin(state.phase * 0.7)) * 0.06;
        headPitch = Math.sin(state.phase * 0.5) * 0.05;
      }
      state.jaw += (jawOpen - state.jaw) * Math.min(1, dt * 9);
      jaw.rotation.x = state.jaw * 0.55;
      headGroup.rotation.x = headPitch;

      const wingR = root.getObjectByName("wingR");
      if (wingR) {
        const flapping = state.anim === "fly" || state.anim === "roar";
        const flap = flapping ? Math.sin(state.phase * 4) * 0.45 : Math.sin(state.phase * 0.8) * 0.06;
        wingR.rotation.z = -flap;
        root.getObjectByName("wingL").rotation.z = flap;
      }
    },
    dispose() {
      root.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
    },
  };

  api.update(0.016, { speed: 0 });
  return api;
}

export { HEAD_BUILDERS };
