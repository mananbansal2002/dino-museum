import { createCharacter } from "./character.js";
import { angleLerp, clamp, damp } from "./util.js";

function toCss(color) {
  if (typeof color === "number") return `#${color.toString(16).padStart(6, "0")}`;
  return color || "#ffffff";
}

const INTERP_DELAY = 140; // ms behind the newest snapshot (updates arrive every ~90ms)
const MAX_EXTRAPOLATE = 120; // ms we are willing to guess past the newest snapshot
const TELEPORT = 6; // m between snapshots that counts as a jump cut, not motion
const BUFFER = 12; // snapshots kept per player
const RUN_SPEED = 8.4; // matches the local player's run speed
const ANIMS = new Set(["idle", "walk", "run", "jump", "sit"]);

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

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

  function setState(id, s) {
    const p = players.get(id) || upsert(id, {});
    const snap = {
      t: now(),
      x: num(s.x),
      y: num(s.y),
      z: num(s.z),
      ry: num(s.ry),
      anim: String(s.anim || "idle"),
    };
    const last = p.snaps[p.snaps.length - 1];
    // states relayed in bursts (cross-instance polling) must not collapse
    // onto one timestamp, or the interpolation would jump
    if (last && snap.t < last.t + 30) snap.t = last.t + 30;
    if (!p.hasPosition || (last && Math.hypot(snap.x - last.x, snap.z - last.z) > TELEPORT)) {
      // first sighting or teleport: snap, do not interpolate from far away
      p.snaps.length = 0;
      snapTo(p, snap.x, snap.y, snap.z, snap.ry);
      p.hasPosition = true;
      p.character.group.visible = true;
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
    scene.remove(p.character.group);
    try {
      p.character.setHeld?.(null);
      if (typeof p.character.dispose === "function") p.character.dispose();
      disposeObject(p.character.group);
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

  function update(dt) {
    const renderT = now() - INTERP_DELAY;
    for (const p of players.values()) {
      const smp = p.hasPosition ? sample(p, renderT) : null;
      if (smp) {
        // a light damp on top of the interpolation hides network jitter
        // without adding noticeable lag
        p.x = damp(p.x, smp.x, 25, dt);
        p.y = damp(p.y, smp.y, 25, dt);
        p.z = damp(p.z, smp.z, 25, dt);
        p.ry = angleLerp(p.ry, smp.ry, 1 - Math.exp(-20 * dt));
      }

      let targetSpeed = smp ? clamp(smp.v / RUN_SPEED, 0, 1) : 0;
      if (p.anim === "idle" || p.anim === "sit") targetSpeed = 0;
      else if (p.anim === "run") targetSpeed = Math.max(targetSpeed, 0.85);
      else if (p.anim === "walk") targetSpeed = clamp(Math.max(targetSpeed, 0.35), 0, 0.75);
      p.speed = damp(p.speed, targetSpeed, 10, dt);

      place(p);
      const anim = ANIMS.has(p.anim) ? p.anim : "idle";
      p.character.update(dt, { speed: clamp(p.speed, 0, 1), anim });
    }
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
    get list() {
      return Array.from(players.values());
    },
  };
}
