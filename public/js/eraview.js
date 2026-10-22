/**
 * Era viewer: a full-screen, immersive 360° "window into deep time".
 *
 * Each era is a six-face cube-map skybox (public/images/eras/<era>/{px,nx,py,ny,pz,nz}.jpg,
 * built from CC0 Poly Haven panoramas, see public/images/eras/CREDITS.json). The viewer owns
 * its own THREE.Scene + PerspectiveCamera and a DOM overlay (title, facts, close button).
 *
 *   const eraView = createEraView({ renderer });
 *   eraView.open("jurassic", { title, subtitle, facts: [] });
 *   // in the frame loop:
 *   if (eraView.isOpen()) { eraView.update(dt); eraView.render(); } else { renderer.render(scene, camera); }
 *
 * Input while open: drag (mouse / touch) to look around, wheel or pinch to zoom, arrow keys to
 * pan, Esc or the close button to leave. It gently auto-rotates when left alone.
 *
 * The viewer is modal: while open it swallows every keydown (capture phase on window), so game
 * hotkeys, chat and jump never fire underneath it. render() draws nothing until the panorama has
 * decoded, so the last museum frame stays on the canvas while a dark curtain fades in over it;
 * the curtain then fades out to reveal the era (a dip-to-black instead of a hard cut).
 */

import * as THREE from "three";

const FACES = ["px.jpg", "nx.jpg", "py.jpg", "ny.jpg", "pz.jpg", "nz.jpg"];

/* Built-in era metadata (used as defaults; anything passed to open() wins).
 * `startU` is the horizontal position (0..1, left->right) in the source equirect panorama
 * the camera initially faces. `mote` tunes the drifting particles. */
export const ERAS = {
  triassic: {
    title: "The Triassic",
    subtitle: "252 – 201 million years ago · Pangaea",
    facts: [
      "All continents were joined into one supercontinent, Pangaea, with vast dry interiors.",
      "The first dinosaurs, like Eoraptor and Herrerasaurus, appeared about 230 million years ago.",
      "Hot, arid and seasonal: there was no ice at either pole.",
    ],
    startU: 0.47,
    mote: { color: 0xf0c890, count: 260, size: 0.09, drift: [0.35, 0.02, 0.1], opacity: 0.55 },
  },
  jurassic: {
    title: "The Jurassic",
    subtitle: "201 – 145 million years ago · Age of giants",
    facts: [
      "Pangaea split apart and the climate turned warm and humid.",
      "Ferns, cycads and conifers formed dense forests; there were no flowering plants yet.",
      "Giant sauropods like Brachiosaurus and Diplodocus roamed river valleys.",
    ],
    startU: 0.75, // the stream (cube faces are rotated so the stone footpath sits behind you)
    mote: { color: 0xd8f0a0, count: 320, size: 0.06, drift: [0.05, 0.06, 0.03], opacity: 0.6 },
  },
  cretaceous: {
    title: "The Cretaceous",
    subtitle: "145 – 66 million years ago · The last dinosaurs",
    facts: [
      "Flowering plants spread across open woodlands and floodplains.",
      "Tyrannosaurus rex and Triceratops lived at the very end of the period.",
      "It ended with an asteroid impact and massive volcanism, wiping out the non-avian dinosaurs.",
    ],
    startU: 0.6,
    mote: { color: 0xffb070, count: 220, size: 0.07, drift: [0.12, 0.09, 0.05], opacity: 0.5 },
  },
  marine: {
    title: "Mesozoic Seas",
    subtitle: "Warm, shallow oceans · Marine reptiles",
    facts: [
      "Sea levels were far higher than today; shallow seas covered parts of the continents.",
      "Ichthyosaurs, plesiosaurs and mosasaurs ruled the oceans — none of them were dinosaurs.",
      "Mosasaurs could grow longer than a city bus.",
    ],
    startU: 0.3,
    mote: { color: 0xffffff, count: 240, size: 0.05, drift: [0.4, 0.03, 0.15], opacity: 0.45 },
  },
  iceage: {
    title: "The Ice Age",
    subtitle: "2.6 million – 11,700 years ago · Pleistocene",
    facts: [
      "Ice sheets advanced and retreated many times across the northern continents.",
      "Mammoths, woolly rhinos and the armoured glyptodont Doedicurus lived alongside early humans.",
      "Dinosaurs had been gone for over 60 million years by then — only their bird descendants remained.",
    ],
    startU: 0.55,
    mote: { color: 0xffffff, count: 700, size: 0.07, drift: [0.15, -0.55, 0.05], opacity: 0.85 },
  },
};

const STYLE_ID = "eraview-style";
const CSS = `
.eraview{position:fixed;inset:0;z-index:2147483000;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#f3f1ea;opacity:0;transition:opacity .45s ease}
.eraview.ev-show{opacity:1}
.eraview:focus{outline:none}
.eraview.ev-drag{cursor:grabbing}
.eraview .ev-curtain{position:absolute;inset:0;pointer-events:none;background:#07080a;transition:opacity .8s ease}
.eraview.ev-ready .ev-curtain{opacity:0}
.eraview .ev-vignette{position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(ellipse at center,rgba(0,0,0,0) 55%,rgba(0,0,0,.45) 100%)}
.eraview .ev-glass{background:rgba(14,16,20,.52);border:1px solid rgba(255,255,255,.14);border-radius:14px;
  -webkit-backdrop-filter:blur(14px) saturate(1.2);backdrop-filter:blur(14px) saturate(1.2);
  box-shadow:0 10px 40px rgba(0,0,0,.35)}
.eraview .ev-panel{position:absolute;left:24px;top:24px;max-width:min(380px,calc(100vw - 48px));padding:18px 20px 16px;cursor:auto}
.eraview .ev-kicker{font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.7;margin:0 0 6px}
.eraview .ev-title{font-size:26px;line-height:1.15;font-weight:700;margin:0}
.eraview .ev-sub{font-size:13px;opacity:.8;margin:6px 0 0}
.eraview .ev-facts{margin:14px 0 0;padding:0;list-style:none;font-size:14px;line-height:1.45}
.eraview .ev-facts li{position:relative;padding-left:16px;margin:0 0 8px}
.eraview .ev-facts li::before{content:"";position:absolute;left:0;top:.6em;width:6px;height:6px;border-radius:50%;background:#e8c27a}
.eraview .ev-close{position:absolute;right:24px;top:24px;width:44px;height:44px;border-radius:50%;cursor:pointer;
  display:flex;align-items:center;justify-content:center;color:#fff;font-size:22px;line-height:1;padding:0}
.eraview .ev-close:hover{background:rgba(40,44,52,.7)}
.eraview .ev-close:focus-visible{outline:2px solid #e8c27a;outline-offset:2px}
.eraview .ev-hint{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);padding:8px 14px;font-size:12px;
  white-space:nowrap;opacity:.85;pointer-events:none;transition:opacity .6s ease}
.eraview .ev-hint.ev-fade{opacity:0}
.eraview .ev-loading{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:10px 16px;font-size:13px;pointer-events:none}
.eraview .ev-loading[hidden]{display:none}
@media (max-width:600px){
  .eraview .ev-panel{left:12px;right:12px;top:auto;bottom:64px;max-width:none;padding:14px 16px 10px}
  .eraview .ev-title{font-size:21px}
  .eraview .ev-facts{font-size:13px}
  .eraview .ev-close{right:12px;top:12px}
  .eraview .ev-hint{bottom:14px;font-size:11px}
}
@media (prefers-reduced-motion:reduce){
  .eraview,.eraview .ev-curtain{transition:none}
}`;

/* must match the .eraview opacity transition: the panorama is revealed only once the curtain is opaque */
const FADE_IN_MS = 450;
/* zero the drag fling if the pointer was held still this long before release */
const FLING_STALE_MS = 80;

/* keydown e.key -> look/zoom action. Matched on e.key so it follows the keyboard layout, but held
 * keys are tracked by e.code: Shift+'=' is '+' on keydown yet '=' on keyup if Shift is let go first. */
const KEY_ACTIONS = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  "+": "in",
  "=": "in",
  "-": "out",
  _: "out",
};
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph"]);

function prefersReducedMotion() {
  try {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** soft round sprite for the drifting motes */
function makeMoteTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** camera yaw that faces horizontal position u (0..1) of the source equirect (three.js equirectUv) */
function yawForU(u) {
  const a = (u - 0.5) * Math.PI * 2;
  return Math.atan2(-Math.cos(a), -Math.sin(a));
}

export function createEraView({ renderer, basePath = "/images/eras/", onOpen, onClose } = {}) {
  if (!renderer) throw new Error("createEraView: renderer is required");

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0d10);
  const size = new THREE.Vector2();
  renderer.getSize(size);
  const camera = new THREE.PerspectiveCamera(72, size.x / Math.max(1, size.y), 0.1, 200);
  camera.rotation.order = "YXZ";

  /* drifting particles (dust / spores / ash / spray / snow) in a box around the camera */
  const MAX_MOTES = 800;
  const BOX = 24;
  const motePos = new Float32Array(MAX_MOTES * 3);
  const moteSeed = new Float32Array(MAX_MOTES);
  for (let i = 0; i < MAX_MOTES; i++) {
    motePos[i * 3] = (Math.random() - 0.5) * BOX;
    motePos[i * 3 + 1] = (Math.random() - 0.5) * BOX * 0.6;
    motePos[i * 3 + 2] = (Math.random() - 0.5) * BOX;
    moteSeed[i] = Math.random() * 1000;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute("position", new THREE.BufferAttribute(motePos, 3));
  const moteTex = makeMoteTexture();
  const moteMat = new THREE.PointsMaterial({
    size: 0.08,
    map: moteTex,
    transparent: true,
    depthWrite: false,
    opacity: 0.6,
    color: 0xffffff,
    sizeAttenuation: true,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  scene.add(motes);
  let mote = ERAS.jurassic.mote;

  /* state */
  let open_ = false;
  let eraId = null;
  let cubeTex = null;
  let loadToken = 0;
  let yaw = 0;
  let pitch = 0;
  let velYaw = 0;
  let velPitch = 0;
  let fov = 72;
  let targetFov = 72;
  let idle = 0;
  let time = 0;
  const held = new Map(); // e.code -> KEY_ACTIONS value
  const pointers = new Map();
  let pinchDist = 0;
  let lastMoveAt = 0;
  let ready = false; // panorama decoded and revealed: render() draws the era scene
  let openedAt = 0;
  let lockEl = null; // element that held pointer lock when the viewer opened

  /* DOM */
  let root = null;
  let closeBtn = null;
  let hintEl = null;
  let loadingEl = null;
  let lastFocus = null;

  function buildOverlay(info) {
    injectStyle();
    root = el("div", "eraview");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", info.title || "Era view");
    // the dialog itself takes focus (not the × button, where Space/Enter would close it)
    root.tabIndex = -1;
    root.appendChild(el("div", "ev-curtain"));
    root.appendChild(el("div", "ev-vignette"));

    const panel = el("div", "ev-panel ev-glass");
    panel.appendChild(el("p", "ev-kicker", "Window into deep time"));
    panel.appendChild(el("h2", "ev-title", info.title || ""));
    if (info.subtitle) panel.appendChild(el("p", "ev-sub", info.subtitle));
    if (info.facts && info.facts.length) {
      const ul = el("ul", "ev-facts");
      for (const f of info.facts) ul.appendChild(el("li", null, f));
      panel.appendChild(ul);
    }
    // the panel itself shouldn't start drags (lets people select/scroll text on mobile)
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    root.appendChild(panel);

    const close = el("button", "ev-close ev-glass", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close era view");
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      api.close();
    });
    root.appendChild(close);
    closeBtn = close;

    hintEl = el("div", "ev-hint ev-glass", "Drag to look around · Scroll to zoom · Esc to close");
    root.appendChild(hintEl);
    loadingEl = el("div", "ev-loading ev-glass", "Travelling back in time…");
    root.appendChild(loadingEl);

    root.addEventListener("pointerdown", onPointerDown);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerup", onPointerUp);
    root.addEventListener("pointercancel", onPointerUp);
    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("contextmenu", (e) => e.preventDefault());

    document.body.appendChild(root);
    requestAnimationFrame(() => root && root.classList.add("ev-show"));
    lastFocus = document.activeElement;
    root.focus({ preventScroll: true });
  }

  function removeOverlay() {
    if (!root) return;
    const r = root;
    root = null;
    closeBtn = null;
    hintEl = null;
    loadingEl = null;
    r.remove();
    if (lastFocus && typeof lastFocus.focus === "function") {
      try {
        lastFocus.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
    lastFocus = null;
  }

  /* input */
  function lookScale() {
    return (0.0042 * fov) / 72;
  }
  function onPointerDown(e) {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    root.classList.add("ev-drag");
    velYaw = velPitch = 0;
    idle = 0;
    if (pointers.size === 2) pinchDist = pinchDistance();
    fadeHint();
  }
  function onPointerMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    idle = 0;
    if (pointers.size >= 2) {
      const d = pinchDistance();
      if (pinchDist > 0 && d > 0) targetFov = clampFov(targetFov * (pinchDist / d));
      pinchDist = d;
      return;
    }
    const s = lookScale();
    yaw += dx * s;
    pitch += dy * s;
    velYaw = dx * s * 60;
    velPitch = dy * s * 60;
    lastMoveAt = performance.now();
    clampPitch();
  }
  function onPointerUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (!pointers.size) {
      if (root) root.classList.remove("ev-drag");
      // held still before letting go: stay where the user stopped instead of flinging
      if (performance.now() - lastMoveAt > FLING_STALE_MS) velYaw = velPitch = 0;
    }
  }
  function pinchDistance() {
    const pts = [...pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }
  function onWheel(e) {
    e.preventDefault();
    idle = 0;
    targetFov = clampFov(targetFov * Math.exp(e.deltaY * 0.0012));
    fadeHint();
  }
  function onKeyDown(e) {
    if (!open_) return;
    // modifier-only presses can't trigger anything; let them through so held-modifier state stays in sync
    if (MODIFIER_KEYS.has(e.key)) return;
    // modal: nothing reaches the game underneath (E would reopen the viewer, T would open an
    // unfocusable chat, G would photograph the panorama, V/B would broadcast to other players...)
    e.stopImmediatePropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      api.close();
      return;
    }
    if (e.key === "Tab") {
      // keep focus inside the dialog: the × button is its only control
      e.preventDefault();
      if (closeBtn) closeBtn.focus({ preventScroll: true });
      return;
    }
    // leave browser shortcuts (Ctrl/Cmd +/- page zoom, reload...) alone
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const action = KEY_ACTIONS[e.key];
    if (action) {
      e.preventDefault();
      held.set(e.code || e.key, action);
      idle = 0;
      return;
    }
    // Space/Enter only activate × once the user has deliberately tabbed to it
    if ((e.key === " " || e.key === "Enter") && e.target !== closeBtn) e.preventDefault();
  }
  function onKeyUp(e) {
    held.delete(e.code || e.key);
  }
  function holding(action) {
    for (const a of held.values()) if (a === action) return true;
    return false;
  }
  /* keyups are lost when the window loses focus mid-press: drop held keys so nothing sticks */
  function releaseKeys() {
    held.clear();
  }
  function onVisibility() {
    if (document.hidden) releaseKeys();
  }
  function onResize() {
    renderer.getSize(size);
    camera.aspect = size.x / Math.max(1, size.y);
    camera.updateProjectionMatrix();
  }
  function clampFov(f) {
    return Math.min(95, Math.max(28, f));
  }
  function clampPitch() {
    const lim = THREE.MathUtils.degToRad(85);
    pitch = Math.max(-lim, Math.min(lim, pitch));
  }
  let hintTimer = 0;
  function fadeHint() {
    if (hintEl && !hintTimer) {
      hintTimer = setTimeout(() => {
        hintEl && hintEl.classList.add("ev-fade");
      }, 2500);
    }
  }
  /* timers tied to one opening (cleared by open/close, so they can't act on a later overlay) */
  let revealTimer = 0;
  let hintDelayTimer = 0;
  function clearTimers() {
    clearTimeout(hintTimer);
    clearTimeout(revealTimer);
    clearTimeout(hintDelayTimer);
    hintTimer = revealTimer = hintDelayTimer = 0;
  }
  /* panorama decoded (or failed): once the curtain has fully faded in, start drawing the era and
   * fade the curtain out. Until then the canvas keeps the last museum frame. */
  function scheduleReveal(token) {
    const fadeIn = prefersReducedMotion() ? 0 : FADE_IN_MS;
    const wait = Math.max(0, fadeIn - (performance.now() - openedAt));
    revealTimer = setTimeout(() => {
      revealTimer = 0;
      if (token !== loadToken || !root) return;
      ready = true;
      root.classList.add("ev-ready");
      hintDelayTimer = setTimeout(() => {
        hintDelayTimer = 0;
        if (token === loadToken) fadeHint();
      }, 1500);
    }, wait);
  }

  /* pointer lock was dropped on open; take it back on close. requestPointerLock needs transient
   * user activation, which the × click / Enter give but Esc never does (browsers exclude it), so
   * after Esc the game's usual click-to-lock applies. */
  function restoreLock(target) {
    if (!target || !target.isConnected || !target.requestPointerLock || document.pointerLockElement) return;
    const ua = navigator.userActivation;
    if (ua && !ua.isActive) return;
    try {
      const p = target.requestPointerLock();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch {
      /* ignore: drag-to-look / click-to-lock still work */
    }
  }

  function disposeTexture() {
    if (cubeTex) {
      cubeTex.dispose();
      cubeTex = null;
    }
    scene.background = new THREE.Color(0x0b0d10);
  }

  function applyMote(m) {
    mote = m || ERAS.jurassic.mote;
    moteMat.color.set(mote.color);
    moteMat.size = mote.size;
    moteMat.opacity = mote.opacity;
    moteGeo.setDrawRange(0, Math.min(MAX_MOTES, mote.count));
  }

  const api = {
    /** era ids that have skyboxes */
    eras: Object.keys(ERAS),

    /**
     * Open the viewer on an era.
     * @param {string} id  one of api.eras (folder under basePath)
     * @param {{title?:string, subtitle?:string, facts?:string[], startU?:number}} [info]
     */
    open(id, info = {}) {
      const base = ERAS[id] || {};
      const merged = {
        title: info.title ?? base.title ?? id,
        subtitle: info.subtitle ?? base.subtitle ?? "",
        facts: info.facts ?? base.facts ?? [],
      };
      if (open_) {
        removeOverlay();
        disposeTexture();
      } else {
        lockEl = document.pointerLockElement || null;
      }
      open_ = true;
      eraId = id;

      if (document.pointerLockElement) {
        try {
          document.exitPointerLock();
        } catch {
          /* ignore */
        }
      }

      yaw = yawForU(info.startU ?? base.startU ?? 0.5);
      pitch = THREE.MathUtils.degToRad(-2);
      velYaw = velPitch = 0;
      fov = targetFov = 72;
      idle = 0;
      held.clear();
      pointers.clear();
      clearTimers();
      ready = false;
      openedAt = performance.now();
      applyMote(base.mote);
      onResize();
      buildOverlay(merged);

      const token = ++loadToken;
      const loader = new THREE.CubeTextureLoader().setPath(basePath.replace(/\/?$/, "/") + id + "/");
      const tex = loader.load(
        FACES,
        () => {
          if (token !== loadToken) {
            tex.dispose();
            return;
          }
          if (loadingEl) loadingEl.hidden = true;
          scheduleReveal(token);
        },
        undefined,
        () => {
          if (token !== loadToken) return;
          if (loadingEl) loadingEl.textContent = "Could not load this era's panorama.";
          scheduleReveal(token); // still lift the curtain: motes over the dark backdrop
        }
      );
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      cubeTex = tex;
      scene.background = tex;
      scene.backgroundIntensity = 1;
      scene.backgroundBlurriness = 0;

      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("keyup", onKeyUp, true);
      window.addEventListener("resize", onResize);
      window.addEventListener("blur", releaseKeys);
      document.addEventListener("visibilitychange", onVisibility);
      if (onOpen) onOpen(id);
    },

    close() {
      if (!open_) return;
      open_ = false;
      ready = false;
      loadToken++;
      const id = eraId;
      eraId = null;
      const relockEl = lockEl;
      lockEl = null;
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", releaseKeys);
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimers();
      held.clear();
      pointers.clear();
      removeOverlay();
      disposeTexture();
      if (onClose) onClose(id);
      // hadPointerLock: the player was in mouse-look when the viewer opened (re-locked here when the
      // close came from a user gesture that allows it; listeners can prompt "click to look" otherwise)
      window.dispatchEvent(new CustomEvent("eraview:close", { detail: { era: id, hadPointerLock: !!relockEl } }));
      restoreLock(relockEl);
    },

    isOpen() {
      return open_;
    },

    /** current era id (or null) */
    current() {
      return eraId;
    },

    update(dt) {
      if (!open_) return;
      dt = Math.min(0.1, Math.max(0, dt || 0));
      time += dt;
      idle += dt;

      // keyboard look / zoom
      const ks = 1.4 * dt * (fov / 72);
      if (held.size) {
        if (holding("left")) yaw += ks;
        if (holding("right")) yaw -= ks;
        if (holding("up")) pitch += ks;
        if (holding("down")) pitch -= ks;
        if (holding("in")) targetFov = clampFov(targetFov * (1 - dt));
        if (holding("out")) targetFov = clampFov(targetFov * (1 + dt));
      }

      // inertia after a drag
      if (!pointers.size) {
        yaw += velYaw * dt;
        pitch += velPitch * dt;
        const damp = Math.exp(-dt * 4);
        velYaw *= damp;
        velPitch *= damp;
      }
      // gentle auto-rotate after a few idle seconds, easing the horizon level
      if (idle > 3 && !pointers.size) {
        const k = Math.min(1, (idle - 3) / 2);
        yaw += 0.035 * dt * k;
        pitch += (THREE.MathUtils.degToRad(-2) - pitch) * Math.min(1, dt * 0.3) * k;
      }
      clampPitch();

      fov += (targetFov - fov) * Math.min(1, dt * 8);
      if (Math.abs(camera.fov - fov) > 1e-3) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      camera.rotation.set(pitch, yaw, 0);

      // motes: wind drift + a little wobble, wrapped inside a box around the camera
      const n = Math.min(MAX_MOTES, mote.count);
      const [wx, wy, wz] = mote.drift;
      const half = BOX / 2;
      const halfY = BOX * 0.3;
      for (let i = 0; i < n; i++) {
        const s = moteSeed[i];
        let x = motePos[i * 3] + (wx + Math.sin(time * 0.7 + s) * 0.08) * dt;
        let y = motePos[i * 3 + 1] + (wy + Math.cos(time * 0.9 + s * 1.3) * 0.05) * dt;
        let z = motePos[i * 3 + 2] + (wz + Math.sin(time * 0.5 + s * 0.7) * 0.08) * dt;
        if (x > half) x -= BOX;
        else if (x < -half) x += BOX;
        if (y > halfY) y -= halfY * 2;
        else if (y < -halfY) y += halfY * 2;
        if (z > half) z -= BOX;
        else if (z < -half) z += BOX;
        motePos[i * 3] = x;
        motePos[i * 3 + 1] = y;
        motePos[i * 3 + 2] = z;
      }
      moteGeo.attributes.position.needsUpdate = true;
    },

    render() {
      // nothing until the panorama is revealed: the canvas keeps its last (museum) frame under the
      // curtain instead of cutting to an empty black cube map
      if (!open_ || !ready) return;
      // show the photographic panorama as-is (the museum uses ACES, which would wash it out)
      const tm = renderer.toneMapping;
      const scissor = renderer.getScissorTest();
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.setScissorTest(false);
      renderer.setRenderTarget(null);
      renderer.getSize(size);
      renderer.setViewport(0, 0, size.x, size.y);
      renderer.render(scene, camera);
      renderer.toneMapping = tm;
      renderer.setScissorTest(scissor);
    },

    /** for debugging / tests */
    get camera() {
      return camera;
    },
    get scene() {
      return scene;
    },
    setView(yawRad, pitchRad, fovDeg) {
      if (yawRad != null) yaw = yawRad;
      if (pitchRad != null) pitch = pitchRad;
      if (fovDeg != null) fov = targetFov = clampFov(fovDeg);
      velYaw = velPitch = 0;
      idle = -1e9; // freeze auto-rotate
      camera.fov = fov;
      camera.updateProjectionMatrix();
      camera.rotation.set(pitch, yaw, 0);
    },

    dispose() {
      api.close();
      moteGeo.dispose();
      moteMat.dispose();
      moteTex.dispose();
    },
  };
  return api;
}
