import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { createCharacter } from "./character.js";
import { upgradeCharacter } from "./models.js";

/**
 * The customiser's 3D preview: the visitor exactly as they will look in the
 * museum (the rigged avatar, recoloured, with the procedural hair style and
 * accessories models.js mounts on it), idling and slowly turning. Drag to turn
 * it by hand.
 *
 * Draws into the given canvas with its own small WebGL renderer, lit by a
 * RoomEnvironment so it needs nothing from the main scene. Returns null when
 * WebGL is unavailable, before touching the canvas, so the caller can still
 * draw its 2D doll there.
 */

/** turntable speed (rad/s) and how long a drag holds it still afterwards (s) */
const SPIN = 0.45;
const DRAG_HOLD = 2.5;

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function createAvatarPreview(canvas) {
  if (!canvas || !webglAvailable()) return null;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return null;
  }
  // the canvas' width / height attributes already carry the hi-dpi factor (2× its CSS box)
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.setClearColor(0x000000, 0); // the CSS gradient shows through
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envMap = pmrem.fromScene(room, 0.04).texture;
  room.dispose();
  pmrem.dispose();
  scene.environment = envMap;
  // a warm key from the front left, a cool rim from behind
  const key = new THREE.DirectionalLight(0xfff1e0, 1.6);
  key.position.set(1.5, 3, 2.5);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fc4ff, 1.2);
  rim.position.set(-1.5, 2.2, -2.5);
  scene.add(rim);

  // full height with a little headroom, looking slightly down
  const camera = new THREE.PerspectiveCamera(26, canvas.width / canvas.height, 0.1, 20);
  camera.position.set(0, 1.25, 4.6);
  camera.lookAt(0, 0.9, 0);

  const turntable = new THREE.Group();
  turntable.rotation.y = 0.35;
  scene.add(turntable);

  let character = null;
  let disposed = false;
  let raf = 0;
  let last = performance.now();
  let hold = 0;

  function build(l) {
    character = createCharacter(l, { name: "" });
    character.tag.visible = false;
    // the procedural stand-in stays hidden: the preview pops straight to the rigged model
    character.group.visible = false;
    turntable.add(character.group);
    const mine = character;
    upgradeCharacter(mine).finally(() => {
      if (mine === character) mine.group.visible = true;
    });
  }

  function setLook(l) {
    if (disposed || !l) return;
    const next = { ...l };
    if (!character) build(next);
    // a body swap is handled in setLook (models.js rebuilds with the other model)
    else character.setLook(next);
  }

  // drag to turn
  let dragX = null;
  const onDown = (e) => {
    dragX = e.clientX;
    hold = DRAG_HOLD;
    canvas.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (dragX === null) return;
    turntable.rotation.y += (e.clientX - dragX) * 0.012;
    dragX = e.clientX;
    hold = DRAG_HOLD;
  };
  const onUp = () => {
    dragX = null;
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.style.touchAction = "pan-y";
  canvas.style.cursor = "grab";

  function frame(now) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    // nothing to draw while the customiser is hidden (in game)
    if (!canvas.isConnected || !canvas.getClientRects().length) return;
    hold = Math.max(0, hold - dt);
    if (!hold) turntable.rotation.y += SPIN * dt;
    character?.update(dt, { speed: 0, anim: "idle" });
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  return {
    setLook,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      character?.dispose?.();
      character = null;
      envMap.dispose();
      renderer.dispose();
    },
  };
}
