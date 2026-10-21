import * as THREE from "three";
import { createCharacter } from "./character.js";
import { angleLerp, damp } from "./util.js";

function toCss(color) {
  if (typeof color === "number") return `#${color.toString(16).padStart(6, "0")}`;
  return color || "#ffffff";
}

/**
 * Keeps a character in the world for every other visitor in the room and
 * interpolates their motion towards the last received network state.
 */
export function createRemotePlayers(scene) {
  const players = new Map();

  function upsert(id, info) {
    if (players.has(id)) {
      const p = players.get(id);
      if (info?.look) p.character.setLook(info.look);
      if (info?.name) p.character.setName(info.name, info.color);
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
      target: new THREE.Vector3(),
      speed: 0,
      anim: "idle",
      actionUntil: 0,
    };
    players.set(id, p);
    return p;
  }

  function setState(id, s) {
    const p = players.get(id) || upsert(id, {});
    p.tx = Number(s.x) || 0;
    p.ty = Number(s.y) || 0;
    p.tz = Number(s.z) || 0;
    p.ryTarget = Number(s.ry) || 0;
    p.anim = String(s.anim || "idle");
  }

  function remove(id) {
    const p = players.get(id);
    if (!p) return;
    scene.remove(p.character.group);
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

  function update(dt) {
    for (const p of players.values()) {
      const dist = Math.hypot(p.tx - p.x, p.tz - p.z);
      const moving = dist > 0.35;
      const targetSpeed = moving ? (p.anim === "run" ? 1 : 0.55) : 0;
      p.speed = damp(p.speed, targetSpeed, 8, dt);
      p.x = damp(p.x, p.tx, 11, dt);
      p.y = damp(p.y, p.ty, 11, dt);
      p.z = damp(p.z, p.tz, 11, dt);
      p.ry = angleLerp(p.ry, p.ryTarget, Math.min(1, dt * 12));
      p.character.group.position.set(p.x, p.y, p.z);
      p.character.group.rotation.y = p.ry;
      p.character.update(dt, { speed: p.speed });
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
