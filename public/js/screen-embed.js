import * as THREE from "three";
// namespace import: resolved through the importmap's "three/addons/" entry
// (public/vendor/three/addons/), which scripts/check.mjs does not model
import * as CSS3D from "three/addons/renderers/CSS3DRenderer.js";
import { isYouTubeId } from "./video.js";

const { CSS3DRenderer, CSS3DObject } = CSS3D;

/**
 * Plays a YouTube clip "on" the theatre screen in the 3D world.
 *
 * A CSS3DRenderer layer sits *behind* the (transparent) WebGL canvas. An
 * iframe CSS3DObject is placed exactly on the screen mesh, and while a clip
 * plays the screen mesh writes alpha 0 so the iframe shows through that hole.
 * Anything drawn in front of the screen (visitors, seats, walls) still writes
 * opaque pixels and occludes the video correctly.
 *
 * Requirements on the WebGL renderer:
 *   new THREE.WebGLRenderer({ canvas, alpha: true, ... }) and
 *   renderer.setClearColor(0x000000, 0)  (scene.background may stay set: it
 *   is opaque everywhere except where the screen punches its hole).
 *   The #scene canvas must be above the CSS layer (z-index) and the page
 *   background must not be painted by the canvas itself.
 *
 *   const embed = createScreenEmbed({ renderer, camera, screenMesh: world.screen });
 *   embed.play(videoId, { title }); embed.stop(); embed.render(); embed.resize();
 *   embed.playing; embed.videoId
 */
export function createScreenEmbed({ renderer, camera, screenMesh, container = document.body, pxPerUnit = 40 }) {
  const cssRenderer = new CSS3DRenderer();
  const dom = cssRenderer.domElement;
  dom.className = "screen-embed-layer";
  Object.assign(dom.style, {
    position: "fixed",
    inset: "0",
    zIndex: "0",
    pointerEvents: "none",
    background: "#000",
  });
  dom.style.display = "none";
  // keep the CSS layer underneath the WebGL canvas
  const canvas = renderer.domElement;
  if (canvas.parentNode === container) container.insertBefore(dom, canvas);
  else container.prepend(dom);

  const cssScene = new THREE.Scene();

  // screen size in world units, from the mesh geometry
  screenMesh.geometry.computeBoundingBox();
  const bb = screenMesh.geometry.boundingBox;
  const sw = bb.max.x - bb.min.x;
  const sh = bb.max.y - bb.min.y;
  const pw = Math.round(sw * pxPerUnit);
  const ph = Math.round(sh * pxPerUnit);

  const holder = document.createElement("div");
  Object.assign(holder.style, {
    width: `${pw}px`,
    height: `${ph}px`,
    background: "#000",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  });
  const obj = new CSS3DObject(holder);
  cssScene.add(obj);

  const mat = screenMesh.material;
  let saved = null;
  let videoId = null;
  let iframe = null;
  const tmpScale = new THREE.Vector3();

  function syncTransform() {
    screenMesh.updateWorldMatrix(true, false);
    screenMesh.matrixWorld.decompose(obj.position, obj.quaternion, tmpScale);
    obj.scale.set((tmpScale.x * sw) / pw, (tmpScale.y * sh) / ph, 1);
    // the plane's centre may be offset in its own geometry
    const c = new THREE.Vector3((bb.max.x + bb.min.x) / 2, (bb.max.y + bb.min.y) / 2, 0).applyMatrix4(screenMesh.matrixWorld);
    obj.position.copy(c);
  }

  function punchHole() {
    if (saved) return;
    saved = {
      map: mat.map,
      color: mat.color.getHex(),
      opacity: mat.opacity,
      transparent: mat.transparent,
      blending: mat.blending,
      fog: mat.fog,
      toneMapped: mat.toneMapped,
    };
    mat.map = null;
    mat.color.setHex(0x000000);
    mat.opacity = 0;
    mat.transparent = false;
    mat.blending = THREE.NoBlending;
    mat.fog = false;
    mat.toneMapped = false;
    mat.needsUpdate = true;
  }

  function restore() {
    if (!saved) return;
    Object.assign(mat, {
      map: saved.map,
      opacity: saved.opacity,
      transparent: saved.transparent,
      blending: saved.blending,
      fog: saved.fog,
      toneMapped: saved.toneMapped,
    });
    mat.color.setHex(saved.color);
    mat.needsUpdate = true;
    saved = null;
  }

  function play(id, { title = "YouTube video", start = 0 } = {}) {
    if (!isYouTubeId(id)) {
      console.warn("screen-embed: not a YouTube id", id);
      return false;
    }
    stop();
    // 16:9 video letterboxed inside the screen's aspect
    const ar = 16 / 9;
    const fw = Math.min(pw, Math.round(ph * ar));
    const fh = Math.min(ph, Math.round(fw / ar));
    iframe = document.createElement("iframe");
    const qs = `autoplay=1&rel=0&modestbranding=1&playsinline=1&controls=0${start ? `&start=${Math.floor(start)}` : ""}`;
    iframe.src = `https://www.youtube-nocookie.com/embed/${id}?${qs}`;
    iframe.title = title;
    iframe.allow = "autoplay; encrypted-media; picture-in-picture";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    Object.assign(iframe.style, { width: `${fw}px`, height: `${fh}px`, border: "0" });
    holder.appendChild(iframe);
    videoId = id;
    punchHole();
    dom.style.display = "";
    resize();
    return true;
  }

  function stop() {
    if (iframe) {
      iframe.remove(); // removing the iframe stops the audio
      iframe = null;
    }
    videoId = null;
    dom.style.display = "none";
    restore();
  }

  function resize(w = window.innerWidth, h = window.innerHeight) {
    cssRenderer.setSize(w, h);
  }

  function render() {
    if (!videoId) return;
    syncTransform();
    cssRenderer.render(cssScene, camera);
  }

  resize();

  return {
    play,
    stop,
    render,
    resize,
    get playing() {
      return !!videoId;
    },
    get videoId() {
      return videoId;
    },
    domElement: dom,
  };
}
