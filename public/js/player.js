import * as THREE from "three";
import { createCharacter } from "./character.js";
import { clamp, damp, angleLerp } from "./util.js";
import { resolveCollision, buildWallData, roomAt, w2g } from "./world.js";

/* ------------------------------------------------------------------ */
/* tuning                                                               */
/* ------------------------------------------------------------------ */
const WALK = 4.8; // m/s
const RUN = 8.4; // m/s (Shift)
const ACCEL = 11; // ground acceleration (exponential rate)
const DECEL = 13; // ground deceleration when no input
const AIR_CONTROL = 0.35; // fraction of ground accel while airborne
const TURN_RATE = 12; // body yaw catch-up rate
const GRAVITY_UP = 22; // gravity while rising with jump held
const GRAVITY_DOWN = 36; // gravity while falling (snappier landings)
const GRAVITY_CUT = 48; // gravity while rising after jump was released (short hop)
const JUMP = 7.6; // initial jump velocity
const COYOTE = 0.12; // s after leaving the ground when a jump still counts
const JUMP_BUFFER = 0.15; // s a jump press is remembered before landing
const RADIUS = 0.52;
const EYE = 1.62;
const PHYS_STEP = 1 / 90; // fixed physics sub-step
const MAX_FRAME = 0.25; // never simulate more than this per frame
const CAM_MIN = 1.8;
const CAM_MAX = 9;
const CAM_DEFAULT = 4.6;
const CAM_MARGIN = 0.04; // extra air between the near plane and a wall face
const CAM_STEP_MIN = 0.2; // shortest raymarch step of the third-person probe
const FP_NUDGE = 0.25; // first-person eye sits this far in front of the body centre
const LINTEL_DROP = 1.3; // doorway lintels hang this far below the lower room's ceiling (world.js)
const SIT_HOLD_STAND = 0.4; // s a move key held through sitting down must stay held to stand up
const PITCH_MIN = -1.15;
const PITCH_MAX = 0.75;
const MOUSE_SENS = 0.0024;
const MOVE_CODES = ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

/* ------------------------------------------------------------------ */
/* wall helpers                                                         */
/* ------------------------------------------------------------------ */
/**
 * resolveCollision only knows about solid grid cells. A few wall slabs sit
 * between two walkable cells of different rooms (e.g. Jurassic Hall / Ice
 * Cream Court); collect those so neither the player nor the camera can pass
 * through them.
 */
let innerWalls = null;
// Half the thickness of the drawn wall slabs. Grid collision stops at the
// cell edge, but a slab is centred on that edge, so its visible face is this
// much closer. Read from buildWallData below; 0.2 matches world.js.
let wallHalf = 0.2;
function getInnerWalls() {
  if (innerWalls) return innerWalls;
  innerWalls = [];
  try {
    let thinnest = Infinity;
    for (const w of buildWallData()) {
      thinnest = Math.min(thinnest, w.sx, w.sz);
      const e = 0.5;
      const vertical = w.sx < w.sz; // wall runs along z
      const a = vertical ? roomAt(w.x - e, w.z) : roomAt(w.x, w.z - e);
      const b = vertical ? roomAt(w.x + e, w.z) : roomAt(w.x, w.z + e);
      if (a && b) {
        innerWalls.push({
          minX: w.x - w.sx / 2,
          maxX: w.x + w.sx / 2,
          minZ: w.z - w.sz / 2,
          maxZ: w.z + w.sz / 2,
        });
      }
    }
    if (Number.isFinite(thinnest)) wallHalf = thinnest / 2;
  } catch {
    /* world data unavailable: fall back to grid collision only */
  }
  return innerWalls;
}

function pushOutOfBox(x, z, radius, b) {
  const cx = Math.max(b.minX, Math.min(x, b.maxX));
  const cz = Math.max(b.minZ, Math.min(z, b.maxZ));
  let dx = x - cx;
  let dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= radius * radius) return null;
  if (d2 < 1e-10) {
    // centre is inside the slab: leave through the nearest face
    const l = x - b.minX;
    const r = b.maxX - x;
    const t = z - b.minZ;
    const bt = b.maxZ - z;
    const m = Math.min(l, r, t, bt);
    if (m === l) return [b.minX - radius, z];
    if (m === r) return [b.maxX + radius, z];
    if (m === t) return [x, b.minZ - radius];
    return [x, b.maxZ + radius];
  }
  const d = Math.sqrt(d2);
  const push = radius - d;
  return [x + (dx / d) * push, z + (dz / d) * push];
}

/** Full collision: solid cells + inner wall slabs. Two passes settle corners. */
export function collide(x, z, radius) {
  const walls = getInnerWalls();
  for (let pass = 0; pass < 2; pass++) {
    [x, z] = resolveCollision(x, z, radius);
    for (const b of walls) {
      if (x < b.minX - radius || x > b.maxX + radius || z < b.minZ - radius || z > b.maxZ + radius) continue;
      const p = pushOutOfBox(x, z, radius, b);
      if (p) [x, z] = p;
    }
  }
  return [x, z];
}

function isBlocked(x, z, radius) {
  const [cx, cz] = collide(x, z, radius);
  return Math.abs(cx - x) > 1e-4 || Math.abs(cz - z) > 1e-4;
}

/**
 * Yes/no overlap test for camera probes: one resolveCollision pass (corner
 * settling only matters when the result is used as a position) plus a plain
 * overlap check against the inner slabs.
 */
function probeBlocked(x, z, radius) {
  const [cx, cz] = resolveCollision(x, z, radius);
  if (Math.abs(cx - x) > 1e-4 || Math.abs(cz - z) > 1e-4) return true;
  for (const b of getInnerWalls()) {
    const dx = x - Math.max(b.minX, Math.min(x, b.maxX));
    const dz = z - Math.max(b.minZ, Math.min(z, b.maxZ));
    if (dx * dx + dz * dz < radius * radius) return true;
  }
  return false;
}

/**
 * How far the camera centre has to stay from collision geometry so the near
 * plane never reaches a wall face: the slab's half thickness (grid collision
 * stops at the cell edge, the face is in front of it) plus the distance from
 * the eye to the near plane's corners, plus a little margin.
 */
function cameraClearance(camera) {
  getInnerWalls(); // makes sure wallHalf has been read
  const near = camera?.near ?? 0.1;
  const tanY = Math.tan(((camera?.fov ?? 55) * Math.PI) / 360);
  const aspect = camera?.aspect || 1;
  return wallHalf + near * Math.hypot(1, tanY, tanY * aspect) + CAM_MARGIN;
}

/* ------------------------------------------------------------------ */
/* player                                                               */
/* ------------------------------------------------------------------ */
export function createPlayer({ scene, camera, look, name, color, onTouchAction = null }) {
  const character = createCharacter(look, { name, tagColor: color });
  scene.add(character.group);

  const state = {
    x: 0,
    y: 0,
    z: 0,
    ry: Math.PI, // body yaw (sent over the network)
    camYaw: Math.PI, // camera yaw (mouse controlled)
    pitch: -0.12,
    vx: 0,
    vz: 0,
    vy: 0,
    onGround: true,
    speed: 0,
    anim: "idle",
    cameraMode: 0,
    camDist: CAM_DEFAULT,
    sitting: false,
  };

  const keys = new Set();
  let locked = false;
  let inputEnabled = true;
  let dragging = false;
  let jumpBuffer = 0;
  let coyote = 0;
  let jumpHeld = false;
  let lastNow = 0;
  let camDistNow = CAM_DEFAULT;
  let camReady = false;
  let sitHold = 0; // s a move / jump key has been held continuously while seated
  const probe = { valid: false, px: 0, py: 0, pz: 0, dx: 0, dy: 0, dz: 0, want: 0, r: 0, free: 0 };
  let lastRy = state.ry;
  let lastX = state.x;
  let lastZ = state.z;
  const touch = { mx: 0, mz: 0, active: false };
  // settings.js: look sensitivity / invert, and reduced motion (no head bob)
  let lookSens = 1;
  let lookInvert = false;
  let reducedMotion = false;
  let bobPhase = 0;
  let bobAmp = 0;

  const camTarget = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const pivot = new THREE.Vector3();

  /* ---------------- input ---------------- */
  function isTyping(e) {
    const t = e.target;
    return !!(t && (/input|textarea|select/i.test(t.tagName) || t.isContentEditable));
  }
  function onKeyDown(e) {
    if (!inputEnabled || isTyping(e)) return;
    const code = e.code;
    const isMove = MOVE_CODES.includes(code);
    if (isMove || code === "Space") e.preventDefault();
    if (state.sitting && (isMove || code === "Space")) {
      // a fresh press stands up at once; a key that was already down when we
      // sat (its auto-repeat lands here) is handled by the hold timer in update()
      if (!keys.has(code)) {
        keys.add(code);
        stand();
      }
      return;
    }
    if (keys.has(code)) return; // auto-repeat
    keys.add(code);
    if (code === "Space") {
      jumpBuffer = JUMP_BUFFER;
      jumpHeld = true;
    }
  }
  function onKeyUp(e) {
    keys.delete(e.code);
    if (e.code === "Space") jumpHeld = false;
  }
  function clearInput() {
    keys.clear();
    jumpBuffer = 0;
    jumpHeld = false;
    dragging = false;
    touch.mx = touch.mz = 0;
    touch.active = false;
    if (touchUi) touchUi.reset();
  }
  function applyLook(dx, dy) {
    state.camYaw -= dx * MOUSE_SENS * lookSens;
    state.pitch = clamp(state.pitch - dy * MOUSE_SENS * 0.875 * lookSens * (lookInvert ? -1 : 1), PITCH_MIN, PITCH_MAX);
  }
  function onMouseMove(e) {
    if (!inputEnabled) return;
    if (locked || dragging) applyLook(e.movementX || 0, e.movementY || 0);
  }
  function onMouseDown(e) {
    if (!inputEnabled || locked) return;
    if (!e.target || e.target.tagName !== "CANVAS") return;
    if (e.button === 0 || e.button === 2) dragging = true;
  }
  function onMouseUp() {
    dragging = false;
  }
  function onContextMenu(e) {
    if (e.target && e.target.tagName === "CANVAS") e.preventDefault();
  }
  function onWheel(e) {
    if (!inputEnabled) return;
    if (!locked && !(e.target && e.target.tagName === "CANVAS")) return;
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    state.camDist = clamp(state.camDist * Math.exp(delta * 0.0012), CAM_MIN, CAM_MAX);
  }
  function onLockChange() {
    locked = !!document.pointerLockElement;
    if (locked) dragging = false;
  }
  function onBlur() {
    clearInput();
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mouseup", onMouseUp);
  window.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("wheel", onWheel, { passive: true });
  window.addEventListener("blur", onBlur);
  document.addEventListener("pointerlockchange", onLockChange);

  function requestLock(el) {
    if (!inputEnabled) return;
    if (!locked && el && el.requestPointerLock) {
      try {
        const p = el.requestPointerLock();
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        /* pointer lock unsupported: drag-to-look still works */
      }
    }
  }

  function key(code) {
    return keys.has(code);
  }

  /* ---------------- touch (coarse pointers only) ---------------- */
  const touchUi = createTouchControls();

  function createTouchControls() {
    let coarse = false;
    try {
      coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
    } catch {
      coarse = false;
    }
    if (!coarse || typeof document === "undefined") return null;

    const root = document.createElement("div");
    root.className = "touch-controls";
    root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:5;";
    const base = document.createElement("div");
    base.style.cssText =
      "position:absolute;width:120px;height:120px;margin:-60px 0 0 -60px;border-radius:50%;" +
      "border:2px solid rgba(255,255,255,.35);background:rgba(0,0,0,.18);display:none;";
    const knob = document.createElement("div");
    knob.style.cssText =
      "position:absolute;left:50%;top:50%;width:52px;height:52px;margin:-26px 0 0 -26px;" +
      "border-radius:50%;background:rgba(255,255,255,.55);";
    base.appendChild(knob);
    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.textContent = "Jump";
    jumpBtn.setAttribute("aria-label", "Jump");
    jumpBtn.style.cssText =
      "position:absolute;right:22px;bottom:96px;width:72px;height:72px;border-radius:50%;" +
      "border:2px solid rgba(255,255,255,.45);background:rgba(0,0,0,.3);color:#fff;" +
      "font:600 14px system-ui,sans-serif;pointer-events:auto;touch-action:none;";
    // E on a keyboard: examine / order / sit / screen / open, shown only while
    // something is in reach (main.js sets its label from the prompt)
    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "touch-use";
    useBtn.style.cssText =
      "position:absolute;right:106px;min-width:72px;height:72px;padding:0 14px;" +
      "border-radius:36px;border:2px solid rgba(255,200,87,.75);background:rgba(255,200,87,.28);" +
      "color:#fff;font:700 14px system-ui,sans-serif;pointer-events:auto;touch-action:none;" +
      "display:none;max-width:40vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    // same row as Jump, just left of it (the stylesheet's `.touch-controls
    // button { bottom: ... !important }` is meant for Jump; this keeps the row
    // in line with it on every layout)
    useBtn.style.setProperty(
      "bottom",
      "calc(var(--touch-safe-bottom, 170px) - 74px + var(--safe-b, 0px))",
      "important"
    );
    root.appendChild(base);
    root.appendChild(jumpBtn);
    root.appendChild(useBtn);
    document.body.appendChild(root);

    let moveId = null;
    let lookId = null;
    let ox = 0;
    let oy = 0;
    let lx = 0;
    let ly = 0;
    const R = 55;

    function onStart(e) {
      if (!inputEnabled) return;
      for (const t of e.changedTouches) {
        if (!t.target || t.target.tagName !== "CANVAS") continue;
        if (t.clientX < window.innerWidth / 2 && moveId === null) {
          moveId = t.identifier;
          ox = t.clientX;
          oy = t.clientY;
          base.style.left = `${ox}px`;
          base.style.top = `${oy}px`;
          base.style.display = "block";
          knob.style.transform = "translate(0px,0px)";
        } else if (lookId === null) {
          lookId = t.identifier;
          lx = t.clientX;
          ly = t.clientY;
        }
      }
    }
    function onMove(e) {
      if (!inputEnabled) return;
      for (const t of e.changedTouches) {
        if (t.identifier === moveId) {
          let dx = t.clientX - ox;
          let dy = t.clientY - oy;
          const d = Math.hypot(dx, dy);
          if (d > R) {
            dx = (dx / d) * R;
            dy = (dy / d) * R;
          }
          knob.style.transform = `translate(${dx}px,${dy}px)`;
          touch.mx = dx / R;
          touch.mz = -dy / R;
          touch.active = Math.hypot(touch.mx, touch.mz) > 0.12;
          if (touch.active && state.sitting) stand();
          e.preventDefault();
        } else if (t.identifier === lookId) {
          applyLook((t.clientX - lx) * 1.6, (t.clientY - ly) * 1.6);
          lx = t.clientX;
          ly = t.clientY;
          e.preventDefault();
        }
      }
    }
    function onEnd(e) {
      for (const t of e.changedTouches) {
        if (t.identifier === moveId) {
          moveId = null;
          touch.mx = touch.mz = 0;
          touch.active = false;
          base.style.display = "none";
        } else if (t.identifier === lookId) {
          lookId = null;
        }
      }
    }
    function onJump(e) {
      e.preventDefault();
      if (!inputEnabled) return;
      if (state.sitting) {
        stand();
        return;
      }
      jumpBuffer = JUMP_BUFFER;
      jumpHeld = true;
    }
    function onJumpEnd() {
      jumpHeld = false;
    }
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    jumpBtn.addEventListener("touchstart", onJump, { passive: false });
    jumpBtn.addEventListener("touchend", onJumpEnd);
    function onUse(e) {
      e.preventDefault();
      if (!inputEnabled) return;
      onTouchAction?.();
    }
    useBtn.addEventListener("touchstart", onUse, { passive: false });
    let useLabel = null;

    return {
      reset() {
        moveId = null;
        lookId = null;
        base.style.display = "none";
      },
      setVisible(v) {
        root.style.display = v ? "block" : "none";
      },
      /** Label for the interact button, or null to hide it. */
      setAction(label) {
        const next = label || null;
        if (next === useLabel) return;
        useLabel = next;
        useBtn.style.display = next ? "block" : "none";
        if (next) {
          // the first word is the verb ("Examine T. rex" -> "Examine")
          useBtn.textContent = next.split(" ")[0];
          useBtn.setAttribute("aria-label", next);
        }
      },
      dispose() {
        document.removeEventListener("touchstart", onStart);
        document.removeEventListener("touchmove", onMove);
        document.removeEventListener("touchend", onEnd);
        document.removeEventListener("touchcancel", onEnd);
        root.remove();
      },
    };
  }

  /* ---------------- movement ---------------- */
  function inputAxis() {
    // f: forward (away from camera), r: strafe right
    let f = 0;
    let r = 0;
    if (inputEnabled) {
      if (key("KeyW") || key("ArrowUp")) f += 1;
      if (key("KeyS") || key("ArrowDown")) f -= 1;
      if (key("KeyD") || key("ArrowRight")) r += 1;
      if (key("KeyA") || key("ArrowLeft")) r -= 1;
      if (touch.active) {
        f += touch.mz;
        r += touch.mx;
      }
    }
    const mag = Math.hypot(f, r);
    if (mag > 1) {
      f /= mag;
      r /= mag;
    }
    return { f, r, mag: Math.min(1, mag) };
  }

  /** Moves by (dx, dz) in sub-steps no longer than half the radius: no tunnelling. */
  function moveWithCollision(dx, dz) {
    const dist = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(dist / (RADIUS * 0.5)));
    const sx = dx / steps;
    const sz = dz / steps;
    let x = state.x;
    let z = state.z;
    for (let i = 0; i < steps; i++) {
      [x, z] = collide(x + sx, z + sz, RADIUS);
    }
    return [x, z];
  }

  function physicsStep(h, axis, running) {
    // camera-relative wish direction (W = away from the camera)
    const sy = Math.sin(state.camYaw);
    const cy = Math.cos(state.camYaw);
    // forward = (sin, cos); screen-right = (-cos, sin)
    let wx = sy * axis.f - cy * axis.r;
    let wz = cy * axis.f + sy * axis.r;
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-4) {
      wx /= wl;
      wz /= wl;
    }
    const cap = (running ? RUN : WALK) * axis.mag;
    const tx = wx * cap;
    const tz = wz * cap;
    let rate = axis.mag > 0.01 ? ACCEL : DECEL;
    if (!state.onGround) rate *= AIR_CONTROL;
    state.vx = damp(state.vx, tx, rate, h);
    state.vz = damp(state.vz, tz, rate, h);
    if (Math.abs(state.vx) < 1e-3 && axis.mag < 0.01) state.vx = 0;
    if (Math.abs(state.vz) < 1e-3 && axis.mag < 0.01) state.vz = 0;

    // horizontal move + wall sliding
    const ix = state.vx * h;
    const iz = state.vz * h;
    const [nx, nz] = moveWithCollision(ix, iz);
    const ax = nx - state.x;
    const az = nz - state.z;
    // drop the velocity component that went into a wall (keeps the slide)
    if (h > 0 && (Math.abs(ax - ix) > 1e-5 || Math.abs(az - iz) > 1e-5)) {
      state.vx = ax / h;
      state.vz = az / h;
    }
    state.x = nx;
    state.z = nz;

    // jump: coyote time + buffering
    if (state.onGround) coyote = COYOTE;
    else coyote = Math.max(0, coyote - h);
    jumpBuffer = Math.max(0, jumpBuffer - h);
    if (jumpBuffer > 0 && coyote > 0) {
      state.vy = JUMP;
      state.onGround = false;
      coyote = 0;
      jumpBuffer = 0;
    }

    // gravity: floaty rise while held, snappy fall
    let g = GRAVITY_DOWN;
    if (state.vy > 0) g = jumpHeld ? GRAVITY_UP : GRAVITY_CUT;
    state.vy -= g * h;
    state.y += state.vy * h;
    if (state.y <= 0) {
      state.y = 0;
      state.vy = 0;
      state.onGround = true;
    } else {
      state.onGround = false;
    }
  }

  function syncExternalChanges() {
    // main.js may write state.ry / x / z directly (spawn, teleports)
    if (state.ry !== lastRy) {
      state.camYaw = state.ry;
    }
    if (Math.hypot(state.x - lastX, state.z - lastZ) > 3) {
      camReady = false;
      state.vx = state.vz = 0;
    }
  }

  function frameDt(dt) {
    // main.js clamps dt to 50ms, which makes movement crawl at low fps.
    // Use real elapsed time (bounded) so speed is frame-rate independent.
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    let real = lastNow ? (now - lastNow) / 1000 : dt;
    lastNow = now;
    if (!(real >= 0)) real = dt;
    return clamp(Math.max(dt || 0, real), 0, MAX_FRAME);
  }

  function update(dtIn) {
    const dt = frameDt(dtIn);
    syncExternalChanges();

    // "press W to stand": while seated, keys only stay in `keys` when they were
    // already held as we sat down (a fresh press stands up in onKeyDown).
    // Keep holding one and you get up, so the prompt works without having to
    // release the key first; letting go right after sitting keeps you seated.
    if (state.sitting && inputEnabled) {
      let held = false;
      for (const code of keys) if (code === "Space" || MOVE_CODES.includes(code)) held = true;
      sitHold = held ? sitHold + dt : 0;
      if (sitHold >= SIT_HOLD_STAND) stand();
    } else {
      sitHold = 0;
    }

    const axis = state.sitting ? { f: 0, r: 0, mag: 0 } : inputAxis();
    const running = inputEnabled && (key("ShiftLeft") || key("ShiftRight") || (touch.active && axis.mag > 0.95));

    if (!state.sitting) {
      const steps = Math.max(1, Math.ceil(dt / PHYS_STEP));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) physicsStep(h, axis, running);
    } else {
      state.vx = state.vz = state.vy = 0;
    }

    state.speed = state.sitting ? 0 : Math.hypot(state.vx, state.vz);

    // body yaw: first person faces the camera, third person turns toward motion
    if (!state.sitting) {
      if (state.cameraMode === 1) {
        state.ry = state.camYaw;
      } else if (state.speed > 0.3 && axis.mag > 0.01) {
        const desired = Math.atan2(state.vx, state.vz);
        state.ry = angleLerp(state.ry, desired, 1 - Math.exp(-TURN_RATE * dt));
      }
    }

    state.anim = state.sitting
      ? "sit"
      : !state.onGround
        ? "jump"
        : state.speed > WALK * 1.15
          ? "run"
          : state.speed > 0.2
            ? "walk"
            : "idle";

    character.group.position.set(state.x, state.y, state.z);
    character.group.rotation.y = state.ry;
    // speed is normalised 0..1 (1 = full run); anim is idle|walk|run|jump|sit
    character.update(dt, { speed: clamp(state.speed / RUN, 0, 1), anim: state.anim });

    updateCamera(dt);

    lastRy = state.ry;
    lastX = state.x;
    lastZ = state.z;
  }

  /* ---------------- camera ---------------- */
  /** Ray point at distance d behind the pivot (along -camDir), in xz. */
  function rayX(d) {
    return pivot.x - camDir.x * d;
  }
  function rayZ(d) {
    return pivot.z - camDir.z * d;
  }
  function rayY(d) {
    return pivot.y - camDir.y * d;
  }
  function rayBlocked(d, r) {
    const x = rayX(d);
    const z = rayZ(d);
    return !roomAt(x, z) || probeBlocked(x, z, r);
  }

  /**
   * Where the ray crosses from room `a` (at lo) into another room (at hi):
   * returns the crossing distance and how fast the ray moves away from that
   * doorway plane per metre along it.
   */
  function doorwayCrossing(lo, hi, a) {
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      if (roomAt(rayX(mid), rayZ(mid)) === a) lo = mid;
      else hi = mid;
    }
    // cell edges are axis aligned: a column change means an x = const plane
    const acrossX = w2g(rayX(lo)) !== w2g(rayX(hi));
    const perp = Math.max(0.05, Math.abs(acrossX ? camDir.x : camDir.z));
    return { d: (lo + hi) / 2, perp };
  }

  /**
   * Longest free distance (<= want) from the pivot along -camDir. The camera
   * centre keeps `cameraClearance` from walls and exhibits, so the near plane
   * never reaches a wall face, and stays on the player's side of a doorway
   * when the line of sight back to the player would pass through its lintel.
   *
   * Raymarches in steps of the clearance radius (a probe that wide cannot
   * step over a wall), then binary-searches the hit. The result is reused
   * while the pivot, direction and zoom stay put, so standing still costs
   * nothing.
   */
  function freeDistance(want) {
    const r = cameraClearance(camera);
    const same = (a, b) => Math.abs(a - b) < 1e-5;
    if (
      probe.valid &&
      probe.want === want &&
      probe.r === r &&
      same(probe.px, pivot.x) &&
      same(probe.py, pivot.y) &&
      same(probe.pz, pivot.z) &&
      same(probe.dx, camDir.x) &&
      same(probe.dy, camDir.y) &&
      same(probe.dz, camDir.z)
    ) {
      return probe.free;
    }

    const step = Math.max(CAM_STEP_MIN, r);
    let free = want;
    let prevD = 0;
    let prevRoom = roomAt(pivot.x, pivot.z);
    // look a clearance radius past the camera for doorways too: a lintel just
    // behind the camera would still cut through the near plane
    const reach = want + r;
    // samples: every step up to the camera distance itself, then `reach`
    const next = (d) => (d < want ? Math.min(d + step, want) : reach);
    for (let d = next(0); prevD < reach; d = next(d)) {
      const room = roomAt(rayX(d), rayZ(d));
      if (room && prevRoom && room !== prevRoom) {
        const c = doorwayCrossing(prevD, d, prevRoom);
        const span = wallHalf / c.perp; // lintel thickness along the ray
        const lintelBottom = Math.min(room.h, prevRoom.h) - LINTEL_DROP;
        const a = Math.max(0, Math.min(want, c.d - span));
        const b = Math.max(0, Math.min(want, c.d + span));
        if (Math.max(rayY(a), rayY(b)) + r > lintelBottom) free = Math.min(free, Math.max(0, c.d - r / c.perp));
      }
      if (d <= want && rayBlocked(d, r)) {
        let lo = prevD;
        let hi = d;
        for (let i = 0; i < 6; i++) {
          const mid = (lo + hi) / 2;
          if (rayBlocked(mid, r)) hi = mid;
          else lo = mid;
        }
        free = Math.min(free, lo);
      }
      if (free < want) break;
      prevD = d;
      prevRoom = room;
    }

    Object.assign(probe, {
      valid: true,
      px: pivot.x,
      py: pivot.y,
      pz: pivot.z,
      dx: camDir.x,
      dy: camDir.y,
      dz: camDir.z,
      want,
      r,
      free,
    });
    return free;
  }

  function updateCamera(dt) {
    const cp = Math.cos(state.pitch);
    camDir.set(Math.sin(state.camYaw) * cp, Math.sin(state.pitch), Math.cos(state.camYaw) * cp);

    if (state.cameraMode === 1) {
      character.group.visible = false;
      // a gentle head bob while walking on the ground (off with reduced motion)
      const walking = !reducedMotion && !state.sitting && state.onGround && state.speed > 0.4;
      bobAmp = damp(bobAmp, walking ? Math.min(1, state.speed / RUN) : 0, 8, dt);
      if (bobAmp > 0.001) bobPhase += dt * (6 + state.speed * 0.9);
      const bob = reducedMotion ? 0 : Math.sin(bobPhase * 2) * 0.035 * bobAmp;
      const eyeY = (state.sitting ? state.y + EYE * 0.72 : state.y + EYE) + bob;
      camPos.set(state.x, eyeY, state.z);
      // nudge forward a little, but only as far as keeps the near plane off
      // the wall face (the body radius alone leaves just ~0.3 m to the face)
      const r = cameraClearance(camera);
      const sx = Math.sin(state.camYaw);
      const sz = Math.cos(state.camYaw);
      let nudge = FP_NUDGE;
      if (probeBlocked(state.x + sx * nudge, state.z + sz * nudge, r)) {
        let lo = 0;
        let hi = nudge;
        for (let i = 0; i < 5; i++) {
          const mid = (lo + hi) / 2;
          if (probeBlocked(state.x + sx * mid, state.z + sz * mid, r)) hi = mid;
          else lo = mid;
        }
        nudge = lo;
      }
      camPos.x += sx * nudge;
      camPos.z += sz * nudge;
      camera.position.copy(camPos);
      camera.lookAt(camPos.x + camDir.x * 6, camPos.y + camDir.y * 6, camPos.z + camDir.z * 6);
      camReady = false;
      return;
    }

    character.group.visible = true;
    const headY = state.sitting ? state.y + 1.25 : state.y + 1.55;
    if (!camReady) {
      camTarget.set(state.x, headY, state.z);
      camDistNow = Math.min(state.camDist, camDistNow || state.camDist);
      camReady = true;
    } else {
      // smooth follow: tight horizontally, a little softer vertically (jumps)
      camTarget.x = damp(camTarget.x, state.x, 16, dt);
      camTarget.z = damp(camTarget.z, state.z, 16, dt);
      camTarget.y = damp(camTarget.y, headY, 9, dt);
      // never let the follow lag carry the pivot through a wall
      if (isBlocked(camTarget.x, camTarget.z, 0.05)) {
        camTarget.x = state.x;
        camTarget.z = state.z;
      }
    }
    pivot.copy(camTarget);
    pivot.y += 0.3;

    const free = freeDistance(state.camDist);
    // pull in instantly when blocked, ease back out when the way clears
    if (free < camDistNow) camDistNow = free;
    else camDistNow = damp(camDistNow, free, 5, dt);

    camPos.copy(pivot).addScaledVector(camDir, -camDistNow);
    // keep within floor / ceiling of the hall
    const room = roomAt(camPos.x, camPos.z) || roomAt(state.x, state.z);
    const ceiling = (room?.h ?? 10) - 0.3;
    camPos.y = clamp(camPos.y, 0.35, ceiling);

    // fade out the avatar when the camera is squeezed right up against it
    character.group.visible = camDistNow > 0.6;

    camera.position.copy(camPos);
    camera.lookAt(pivot.x + camDir.x * 4, pivot.y + camDir.y * 4, pivot.z + camDir.z * 4);
  }

  /* ---------------- sitting ---------------- */
  function sit(seat = {}) {
    const x = Number(seat.x);
    const z = Number(seat.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const ry = Number.isFinite(Number(seat.ry)) ? Number(seat.ry) : state.ry;
    state.x = x;
    state.z = z;
    state.y = Number.isFinite(Number(seat.y)) ? Number(seat.y) : 0;
    state.ry = ry;
    state.camYaw = ry;
    state.pitch = -0.12;
    state.vx = state.vz = state.vy = 0;
    state.onGround = true;
    state.speed = 0;
    state.sitting = true;
    state.anim = "sit";
    jumpBuffer = 0;
    sitHold = 0;
    camReady = false;
    lastX = state.x;
    lastZ = state.z;
    lastRy = state.ry;
    character.setSitting?.(true);
    character.group.position.set(state.x, state.y, state.z);
    character.group.rotation.y = state.ry;
    return true;
  }

  function stand() {
    if (!state.sitting) return false;
    state.sitting = false;
    character.setSitting?.(false);
    // step out slightly in front of the seat
    const tx = state.x + Math.sin(state.ry) * 0.75;
    const tz = state.z + Math.cos(state.ry) * 0.75;
    const [nx, nz] = moveWithCollision(tx - state.x, tz - state.z);
    state.x = nx;
    state.z = nz;
    state.y = 0;
    state.vy = 0;
    state.onGround = true;
    state.anim = "idle";
    lastX = state.x;
    lastZ = state.z;
    return true;
  }

  function setInputEnabled(v) {
    const next = !!v;
    if (next === inputEnabled) return;
    inputEnabled = next;
    if (!inputEnabled) {
      clearInput();
      if (locked && document.exitPointerLock) {
        try {
          document.exitPointerLock();
        } catch {
          /* ignore */
        }
      }
    }
    touchUi?.setVisible(inputEnabled);
  }

  return {
    character,
    state,
    keys,
    get locked() {
      return locked;
    },
    get inputEnabled() {
      return inputEnabled;
    },
    get isSitting() {
      return state.sitting;
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
    setInputEnabled,
    /** Settings: look sensitivity multiplier (1 = default) and inverted vertical look. */
    setLookSettings({ sensitivity = 1, invertY = false } = {}) {
      lookSens = Number.isFinite(+sensitivity) && +sensitivity > 0 ? +sensitivity : 1;
      lookInvert = !!invertY;
    },
    /** Settings: reduced motion turns the first-person head bob off. */
    setReducedMotion(on) {
      reducedMotion = !!on;
      if (reducedMotion) bobAmp = 0;
    },
    /** Touch devices: show the interact button for `label` (null hides it). */
    setTouchAction: (label) => touchUi?.setAction(label),
    sit,
    stand,
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("pointerlockchange", onLockChange);
      touchUi?.dispose();
    },
  };
}
