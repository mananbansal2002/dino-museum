import * as THREE from "three";
import { createCharacter } from "./character.js";
import { clamp, damp, angleLerp } from "./util.js";
import { resolveCollision } from "./world.js";

const WALK = 5.2;
const RUN = 8.8;
const GRAVITY = 24;
const JUMP = 8.2;
const RADIUS = 0.52;
const EYE = 1.62;

export function createPlayer({ scene, camera, look, name, color }) {
  const character = createCharacter(look, { name, tagColor: color });
  scene.add(character.group);

  const state = {
    x: 0,
    y: 0,
    z: 0,
    ry: Math.PI,
    pitch: -0.06,
    vy: 0,
    onGround: true,
    speed: 0,
    anim: "idle",
    cameraMode: 0,
  };

  const keys = new Set();
  const wanted = { f: 0, r: 0 };
  let locked = false;
  let jumpQueued = false;

  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const camTarget = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();

  function onKeyDown(e) {
    const code = e.code;
    if (e.target && /input|textarea/i.test(e.target.tagName)) return;
    if (keys.has(code)) return;
    keys.add(code);
    if (code === "Space") {
      jumpQueued = true;
      e.preventDefault();
    }
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(code)) {
      e.preventDefault();
    }
  }
  function onKeyUp(e) {
    keys.delete(e.code);
  }
  function onMouseMove(e) {
    if (!locked) return;
    state.ry -= e.movementX * 0.0024;
    state.pitch = clamp(state.pitch - e.movementY * 0.0021, -1.15, 1.05);
  }
  function onLockChange() {
    locked = !!document.pointerLockElement;
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onLockChange);

  function requestLock(el) {
    if (!locked && el.requestPointerLock) {
      const p = el.requestPointerLock();
      if (p && typeof p.catch === "function") p.catch(() => {});
    }
  }

  function key(code) {
    return keys.has(code);
  }

  function moveAxis() {
    let f = 0;
    let r = 0;
    if (key("KeyW") || key("ArrowUp")) f += 1;
    if (key("KeyS") || key("ArrowDown")) f -= 1;
    if (key("KeyD") || key("ArrowRight")) r += 1;
    if (key("KeyA") || key("ArrowLeft")) r -= 1;
    wanted.f = f;
    wanted.r = r;
  }

  function update(dt) {
    moveAxis();

    const running = key("ShiftLeft") || key("ShiftRight");
    const speedCap = running ? RUN : WALK;

    forward.set(Math.sin(state.ry), 0, Math.cos(state.ry));
    right.set(Math.cos(state.ry), 0, -Math.sin(state.ry));

    const move = new THREE.Vector3()
      .addScaledVector(forward, wanted.f)
      .addScaledVector(right, wanted.r);
    const mag = move.length();
    if (mag > 0.001) move.multiplyScalar(1 / mag);

    const targetSpeed = mag > 0.001 ? speedCap : 0;
    state.speed = damp(state.speed, targetSpeed, 11, dt);

    if (mag > 0.001) {
      const desiredYaw = Math.atan2(move.x, move.z);
      state.ry = angleLerp(state.ry, desiredYaw, Math.min(1, dt * 14));
    }

    const step = state.speed * dt;
    let nx = state.x + move.x * step;
    let nz = state.z + move.z * step;
    [nx, nz] = resolveCollision(nx, nz, RADIUS);
    state.x = nx;
    state.z = nz;

    if (jumpQueued && state.onGround) {
      state.vy = JUMP;
      state.onGround = false;
    }
    jumpQueued = false;

    state.vy -= GRAVITY * dt;
    state.y += state.vy * dt;
    if (state.y <= 0) {
      state.y = 0;
      state.vy = 0;
      state.onGround = true;
    }

    state.anim = !state.onGround
      ? "jump"
      : state.speed > WALK * 0.92
        ? "run"
        : state.speed > 0.15
          ? "walk"
          : "idle";

    character.group.position.set(state.x, state.y, state.z);
    character.group.rotation.y = state.ry;
    character.update(dt, { speed: state.speed / RUN });

    updateCamera(dt);
  }

  function updateCamera(dt) {
    const cp = Math.cos(state.pitch);
    camDir.set(Math.sin(state.ry) * cp, Math.sin(state.pitch), Math.cos(state.ry) * cp);

    if (state.cameraMode === 1) {
      camPos.set(state.x, state.y + EYE, state.z).addScaledVector(camDir, 0.3);
      camera.position.lerp(camPos, Math.min(1, dt * 18));
      character.group.visible = false;
      camera.lookAt(
        camPos.x + camDir.x * 6,
        camPos.y + camDir.y * 6,
        camPos.z + camDir.z * 6
      );
      return;
    }

    character.group.visible = true;
    camTarget.set(state.x, state.y + 1.55, state.z);
    const dist = 4.6;
    camPos.copy(camTarget).addScaledVector(camDir, -dist);
    camPos.y += 0.65;
    // keep the camera out of walls
    const [cx, cz] = resolveCollision(camPos.x, camPos.z, 0.42);
    camPos.x = cx;
    camPos.z = cz;
    if (camPos.y < 0.6) camPos.y = 0.6;
    camera.position.lerp(camPos, Math.min(1, dt * 12));
    camera.lookAt(
      camTarget.x + camDir.x * 4,
      camTarget.y + camDir.y * 4,
      camTarget.z + camDir.z * 4
    );
  }

  return {
    character,
    state,
    keys,
    get locked() {
      return locked;
    },
    requestLock,
    update,
    setLook: (l) => character.setLook(l),
    setName: (n, c) => character.setName(n, c),
    playAction: (a, d) => character.playAction(a, d),
    toggleCamera() {
      state.cameraMode = state.cameraMode === 0 ? 1 : 0;
      return state.cameraMode;
    },
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("pointerlockchange", onLockChange);
    },
  };
}
