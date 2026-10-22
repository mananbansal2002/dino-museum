import * as THREE from "three";
import { createCharacter } from "./character.js";
import { angleLerp, clamp, damp, NAME_TAG_ASPECT, NAME_TAG_PILL } from "./util.js";

function toCss(color) {
  if (typeof color === "number") return `#${color.toString(16).padStart(6, "0")}`;
  return color || "#ffffff";
}

const INTERP_DELAY = 140; // ms behind the newest snapshot (updates arrive every ~90ms)
const MAX_EXTRAPOLATE = 120; // ms we are willing to guess past the newest snapshot
const TELEPORT = 6; // m between snapshots that counts as a jump cut, not motion
const BUFFER = 12; // snapshots kept per player
const RUN_SPEED = 8.4; // matches the local player's run speed
const STALE_AFTER = 400; // ms past the newest snapshot after which walk/run/jump play as idle
const SEND_GAP = 90; // ms between states a sender normally sends (main.js), the starting guess
const BURST_SPACING = 0.75; // fraction of the usual gap kept between snapshots that arrive bunched up
const BURST_SPACING_LONG = 0.5; // the same once the stamps run far ahead of real time
const CLOCK_RESET = 1500; // ms an offset sample may jump before we assume the sender's clock restarted
const CLOCK_RELAX = 0.02; // how fast the offset creeps up after a lucky fast packet (drift, route change)
const ANIMS = new Set(["idle", "walk", "run", "jump", "sit"]);
const MOVING = new Set(["walk", "run", "jump"]);

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/*
 * Name tags, game style (needs a camera: update(dt, camera) or setCamera):
 * about the same size on screen at any distance, a little smaller far off,
 * fading out from TAG_FADE_FROM and gone past TAG_HIDE_AT metres; walls hide
 * them (the sprite is depth-tested, see makeNameTag). They sit TAG_GAP above
 * the top of the head and follow the rigged avatar's head bone, so they
 * dip when the player sits and rise with a jump.
 */
const TAG_SCREEN = 0.03; // pill height as a fraction of the screen height
const TAG_MIN_H = 0.24; // sprite height clamp, metres (the pill is NAME_TAG_PILL of it)
const TAG_MAX_H = 1.6;
const TAG_FADE_FROM = 30;
const TAG_HIDE_AT = 40;
const TAG_GAP = 0.1; // between the head top and the sprite's bottom edge
const PROC_HEAD_TOP = 1.98; // the procedural body's head top (with bodyY 0)

const smoothstep = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function headBoneOf(ch) {
  const name = ch.modelSpec?.bones?.head;
  return (name && ch.rig?.model?.getObjectByName(name)) || null;
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function disposeObject(root) {
  const textures = new Set();
  const materials = new Set();
  root.traverse((o) => {
    if (o.geometry && typeof o.geometry.dispose === "function") o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const mat of mats) materials.add(mat);
  });
  for (const mat of materials) {
    for (const k of Object.keys(mat)) {
      const v = mat[k];
      if (v && v.isTexture) textures.add(v);
    }
    if (typeof mat.dispose === "function") mat.dispose();
  }
  for (const t of textures) t.dispose();
}

/**
 * Keeps a character in the world for every other visitor in the room and
 * plays their motion back from a small buffer of timestamped network states
 * (time-based interpolation, rendered ~140ms in the past).
 */
export function createRemotePlayers(scene) {
  const players = new Map();

  function place(p) {
    p.character.group.position.set(p.x, p.y, p.z);
    p.character.group.rotation.y = p.ry;
  }

  function snapTo(p, x, y, z, ry) {
    p.x = x;
    p.y = y;
    p.z = z;
    p.ry = ry;
    p.tx = x;
    p.ty = y;
    p.tz = z;
    p.ryTarget = ry;
    place(p);
  }

  function applySitting(p) {
    const sitting = p.anim === "sit";
    if (sitting !== p.sitting) {
      p.sitting = sitting;
      p.character.setSitting?.(sitting);
    }
  }

  function upsert(id, info) {
    if (players.has(id)) {
      const p = players.get(id);
      if (info?.look) p.character.setLook(info.look);
      if (info?.name) {
        p.name = info.name;
        if (info.color !== undefined) p.color = toCss(info.color);
        p.character.setName(info.name, p.color);
      }
      return p;
    }
    const css = toCss(info?.color);
    const character = createCharacter(info?.look || {}, {
      name: info?.name || "Visitor",
      tagColor: css,
    });
    scene.add(character.group);
    const p = {
      id,
      character,
      name: info?.name || "Visitor",
      color: css,
      x: 0,
      y: 0,
      z: 0,
      ry: 0,
      ryTarget: 0,
      tx: 0,
      ty: 0,
      tz: 0,
      speed: 0,
      anim: "idle",
      sitting: false,
      snaps: [],
      gap: SEND_GAP, // smoothed time between arrivals while the stream is steady
      lastArrival: 0,
      clock: null, // arrival - sender time, tracking the fastest delivery seen
      lastTs: null,
      hasPosition: false,
      actionUntil: 0,
    };
    players.set(id, p);

    const hasPos = info && info.x !== undefined && info.z !== undefined;
    if (hasPos) {
      const x = num(info.x);
      const z = num(info.z);
      const y = num(info.y);
      const ry = num(info.ry);
      snapTo(p, x, y, z, ry);
      p.snaps.push({ t: now(), x, y, z, ry, anim: String(info.anim || "idle") });
      p.anim = String(info.anim || "idle");
      p.hasPosition = true;
      applySitting(p);
    } else {
      // nothing to show yet: hide until the first state arrives instead of
      // sliding in from the origin
      character.group.visible = false;
    }
    return p;
  }

  /**
   * Local time a snapshot stands for. With the sender's clock (`ts`) it is
   * sender time + offset, where the offset follows the quickest delivery seen
   * (so a packet held up in the network keeps its true place in the stream).
   * Without it (older clients) it is the arrival time.
   */
  function stamp(p, s, arrival) {
    const ts = Number(s.ts);
    if (!(s.ts != null && Number.isFinite(ts))) {
      p.clock = null;
      p.lastTs = null;
      return { t: arrival, timed: false };
    }
    const d = arrival - ts;
    // first sample, the sender reloaded (its clock restarted) or out of order
    if (p.clock === null || Math.abs(d - p.clock) > CLOCK_RESET || (p.lastTs !== null && ts < p.lastTs)) {
      p.clock = d;
    } else if (d < p.clock) {
      p.clock = d;
    } else {
      p.clock += (d - p.clock) * CLOCK_RELAX;
    }
    p.lastTs = ts;
    return { t: Math.min(arrival, ts + p.clock), timed: true };
  }

  /**
   * Snapshots are stamped by stamp() above. Two things keep arrival-stamped
   * ones honest when the network hiccups:
   *  - snapshots that arrive bunched up (a stalled TCP stream releasing
   *    several at once, cross-instance relays) are spread out to most of the
   *    usual send gap, so playback catches up gently instead of sprinting;
   *  - when one arrives after we already ran past the end of the buffer
   *    (extrapolating / holding), the path is pinned to what is on screen
   *    now. Re-sampling the old segment would put the avatar behind the
   *    point it was extrapolated to: a visible slide backwards.
   */
  function setState(id, s) {
    const p = players.get(id) || upsert(id, {});
    const arrival = now();
    const { t: stamped, timed } = stamp(p, s, arrival);
    const snap = {
      t: stamped,
      x: num(s.x),
      y: num(s.y),
      z: num(s.z),
      ry: num(s.ry),
      anim: String(s.anim || "idle"),
    };
    if (p.lastArrival) {
      const g = arrival - p.lastArrival;
      if (g >= 40 && g <= 250) p.gap += (g - p.gap) * 0.2;
    }
    p.lastArrival = arrival;

    let last = p.snaps[p.snaps.length - 1];
    if (!p.hasPosition || (last && Math.hypot(snap.x - last.x, snap.z - last.z) > TELEPORT)) {
      // first sighting or teleport: snap, do not interpolate from far away
      p.snaps.length = 0;
      snapTo(p, snap.x, snap.y, snap.z, snap.ry);
      p.hasPosition = true;
      p.character.group.visible = true;
    } else if (last) {
      const renderT = arrival - INTERP_DELAY;
      if (renderT > last.t) {
        const here = sample(p, renderT);
        const bridge = { t: renderT, x: here.x, y: here.y, z: here.z, ry: here.ry, anim: last.anim };
        // a late state can hold a position we already extrapolated past: keep
        // its sideways correction, drop the step back along the motion
        const prev = p.snaps[p.snaps.length - 2];
        let consumed = false;
        if (prev && MOVING.has(last.anim) && MOVING.has(snap.anim)) {
          const dx = last.x - prev.x;
          const dz = last.z - prev.z;
          const len = Math.hypot(dx, dz);
          if (len > 1e-4) {
            const back = ((bridge.x - snap.x) * dx + (bridge.z - snap.z) * dz) / len;
            if (back > 0) {
              snap.x += (dx / len) * back;
              snap.z += (dz / len) * back;
              consumed = true;
            }
          }
        }
        p.snaps.push(bridge);
        last = bridge;
        // nothing new to walk towards: do not hold on it for the whole delay
        if (consumed) snap.t = bridge.t;
      }
      if (timed) {
        // the sender's clock already gives the true spacing: only keep order
        if (snap.t <= last.t) snap.t = last.t + 1;
      } else {
        // never closer than most of the usual gap (see above); after a long
        // stall the backlog is big, so allow a quicker catch-up
        let minT = last.t + p.gap * BURST_SPACING;
        if (minT - arrival > 2 * INTERP_DELAY) minT = last.t + p.gap * BURST_SPACING_LONG;
        if (snap.t < minT) snap.t = minT;
      }
    }
    p.snaps.push(snap);
    if (p.snaps.length > BUFFER) p.snaps.splice(0, p.snaps.length - BUFFER);
    p.tx = snap.x;
    p.ty = snap.y;
    p.tz = snap.z;
    p.ryTarget = snap.ry;
    p.anim = snap.anim;
    applySitting(p);
  }

  function remove(id) {
    const p = players.get(id);
    if (!p) return;
    const ch = p.character;
    scene.remove(ch.group);
    try {
      ch.setHeld?.(null);
      // The rigged glTF body (models.js) is a SkeletonUtils clone: its
      // geometry belongs to the cached model and is shared with every other
      // avatar of that body type, the local player included. Detach it and
      // free only what this instance owns (its cloned materials, the mixer),
      // so the character's own dispose never reaches the shared buffers.
      const rig = ch.rig;
      if (rig?.model?.parent) {
        rig.model.parent.remove(rig.model);
        rig.dispose?.();
      }
      if (typeof ch.dispose === "function") ch.dispose();
      else disposeObject(ch.group);
    } catch {
      /* best effort */
    }
    players.delete(id);
  }

  function action(id, name, duration = 1.2) {
    const p = players.get(id);
    if (!p) return;
    p.character.playAction(name, duration);
  }

  function setHeld(id, object3d) {
    const p = players.get(id);
    if (!p) return;
    p.character.setHeld(object3d);
  }

  function setLook(id, l) {
    const p = players.get(id);
    if (!p) return;
    p.character.setLook(l);
  }

  /** Position at render time from the snapshot buffer. */
  function sample(p, renderT) {
    const s = p.snaps;
    if (!s.length) return null;
    if (s.length === 1 || renderT <= s[0].t) {
      const a = s[0];
      return { x: a.x, y: a.y, z: a.z, ry: a.ry, v: 0 };
    }
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1];
      const b = s[i];
      if (renderT >= a.t && renderT <= b.t) {
        const span = Math.max(1, b.t - a.t);
        const k = (renderT - a.t) / span;
        const v = Math.hypot(b.x - a.x, b.z - a.z) / (span / 1000);
        return {
          x: a.x + (b.x - a.x) * k,
          y: a.y + (b.y - a.y) * k,
          z: a.z + (b.z - a.z) * k,
          ry: angleLerp(a.ry, b.ry, k),
          v,
        };
      }
    }
    // past the newest snapshot: extrapolate briefly, then hold
    const a = s[s.length - 2];
    const b = s[s.length - 1];
    const span = Math.max(1, b.t - a.t);
    const over = Math.min(renderT - b.t, MAX_EXTRAPOLATE);
    const k = b.anim === "idle" || b.anim === "sit" ? 0 : over / span;
    const v = Math.hypot(b.x - a.x, b.z - a.z) / (span / 1000);
    return {
      x: b.x + (b.x - a.x) * k,
      y: Math.max(0, b.y + (b.y - a.y) * k),
      z: b.z + (b.z - a.z) * k,
      ry: b.ry,
      v: renderT - b.t > MAX_EXTRAPOLATE + 200 ? 0 : v,
    };
  }

  let cameraRef = null;
  const camPos = new THREE.Vector3();
  const headPos = new THREE.Vector3();

  /** Height of the top of the head above the character's feet (group origin). */
  function headTop(p) {
    const ch = p.character;
    const spec = ch.modelSpec;
    if (ch.rig && spec) {
      if (!p.tagRig || p.tagRig.rig !== ch.rig) p.tagRig = { rig: ch.rig, bone: headBoneOf(ch), offset: null };
      const t = p.tagRig;
      const height = Number(spec.height) || 1.8;
      if (!t.bone) return height;
      t.bone.getWorldPosition(headPos);
      const boneY = headPos.y - ch.group.position.y;
      // learn how far the head top is above the head bone the first time the
      // avatar stands on the floor (head bones sit at different places in
      // the Rocketbox and Quaternius skeletons)
      if (t.offset === null && !p.sitting && p.anim !== "sit" && Math.abs(ch.group.position.y) < 0.02 && boneY > height * 0.6) {
        t.offset = clamp(height - boneY, -0.2, 0.45);
      }
      return t.offset === null ? (p.sitting ? height - 0.5 : height) : boneY + t.offset;
    }
    // procedural body: character.update keeps the old tag at 2.28 + bodyY
    return PROC_HEAD_TOP + (ch.tag.position.y - 2.28);
  }

  /** Anchor, size and fade one remote player's tag for this camera. */
  function updateTag(p, camera) {
    const tag = p.character.tag;
    if (!tag) return;
    if (!p.character.group.visible) return;
    const y = headTop(p) + TAG_GAP;
    tag.center.set(0.5, 0);
    tag.position.set(0, y, 0);
    camPos.setFromMatrixPosition(camera.matrixWorld);
    const d = Math.hypot(camPos.x - p.x, camPos.y - (p.y + y), camPos.z - p.z);
    if (d >= TAG_HIDE_AT) {
      tag.visible = false;
      return;
    }
    tag.visible = true;
    tag.material.opacity = 1 - smoothstep(TAG_FADE_FROM, TAG_HIDE_AT, d);
    // world height that keeps the pill at TAG_SCREEN of the view's height
    const fov = camera.isPerspectiveCamera ? THREE.MathUtils.degToRad(camera.fov) : 0.96;
    const perMetre = (2 * Math.tan(fov / 2) * TAG_SCREEN) / NAME_TAG_PILL;
    // a touch smaller with distance, so far tags read as far
    const h = clamp(d * perMetre * (1 - 0.3 * smoothstep(6, TAG_HIDE_AT, d)), TAG_MIN_H, TAG_MAX_H);
    tag.scale.set(h * NAME_TAG_ASPECT, h, 1);
  }

  /**
   * Advance every remote player. With a camera (passed here or once through
   * setCamera) their name tags are sized, faded and anchored game-style;
   * without one they keep the old fixed world-size tag.
   */
  function update(dt, camera = cameraRef) {
    const renderT = now() - INTERP_DELAY;
    for (const p of players.values()) {
      const smp = p.hasPosition ? sample(p, renderT) : null;
      const newest = p.snaps[p.snaps.length - 1];
      const stale = !!newest && renderT - newest.t > STALE_AFTER;
      // a jump that stopped arriving mid-air comes back down
      if (smp && stale && p.anim === "jump") smp.y = 0;
      if (smp) {
        // a light damp on top of the interpolation hides network jitter
        // without adding noticeable lag
        p.x = damp(p.x, smp.x, 25, dt);
        p.y = damp(p.y, smp.y, 25, dt);
        p.z = damp(p.z, smp.z, 25, dt);
        p.ry = angleLerp(p.ry, smp.ry, 1 - Math.exp(-20 * dt));
      }

      let anim = ANIMS.has(p.anim) ? p.anim : "idle";
      let targetSpeed = smp ? clamp(smp.v / RUN_SPEED, 0, 1) : 0;
      if (stale && MOVING.has(anim)) {
        // the sender went quiet mid-stride (tab hidden, connection stalled):
        // the avatar is already holding still, so stop the walk cycle too
        // until a new state arrives
        anim = "idle";
      }
      if (anim === "idle" || anim === "sit") targetSpeed = 0;
      else if (anim === "run") targetSpeed = Math.max(targetSpeed, 0.85);
      else if (anim === "walk") targetSpeed = clamp(Math.max(targetSpeed, 0.35), 0, 0.75);
      p.speed = damp(p.speed, targetSpeed, 10, dt);

      place(p);
      p.character.update(dt, { speed: clamp(p.speed, 0, 1), anim });
      if (camera) updateTag(p, camera);
    }
  }

  function setCamera(camera) {
    cameraRef = camera || null;
  }

  return {
    players,
    upsert,
    setState,
    remove,
    action,
    setHeld,
    setLook,
    update,
    setCamera,
    get list() {
      return Array.from(players.values());
    },
  };
}
