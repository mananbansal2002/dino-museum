/**
 * Touch action dock: thumb-sized round buttons for the keyboard actions on
 * phones and tablets. Shown only when `(pointer: coarse)` matches.
 *
 *   const dock = createTouchDock({ onAction: (key) => ... });
 *   dock.setUseLabel("Examine T. rex"); // big contextual E button, null hides it
 *   dock.setEatAvailable(true, "Eat");   // F button ("Eat" or "Dig"), false hides it
 *
 * `onAction` gets the keyboard letter of the action: "E" use, "V" roar,
 * "B" wave, "F" eat / dig, "G" photo, "T" chat, "M" map. The dock itself
 * sends no keys; pass `pressKey` as `onAction` to replay the tap through the
 * game's own keydown handler (same guards as the keyboard), or run the action
 * directly.
 *
 * Layout (css/touchdock.css) keeps clear of player.js: the joystick takes any
 * canvas touch on the left half, Jump sits at right 22px in the row just above
 * the bottom edge, and the HUD chat column sits on the left above
 * --touch-safe-bottom, leaving a 110px strip on the right for the dock.
 * The big Use button takes the slot left of Jump that player.js's own use
 * button would have used, so main.js routes the prompt label here instead.
 */

const svg = (body) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  // a roaring T. rex head (filled, so it reads at thumb size)
  roar: svg(
    '<path fill="currentColor" stroke="none" fill-rule="evenodd" d="M1.5 9.5C1.5 5.8 4.2 3.5 8 3.5L17.5 3.8' +
      "C20.4 4 22.5 5.4 22.5 7.6L22 8.6L20 8.9L19.3 10L18.4 9.1L17.5 10.3L16.6 9.4L15.7 10.6L14.8 9.8L12.3 10.6" +
      "L14.2 12.6L15 14L15.9 13.1L16.8 14.4L17.7 13.6L18.6 14.8L19.5 14.1L20.3 15C21.2 15.6 20.6 17.3 19 17.3" +
      'L11 17.7L9.8 21.5L3.8 21.5C2.6 17.5 1.5 13.5 1.5 9.5ZM8.4 5.8A1.15 1.15 0 1 0 8.4 8.1A1.15 1.15 0 1 0 8.4 5.8Z"/>'
  ),
  wave: svg(
    '<path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/>' +
      '<path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2"/>' +
      '<path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8"/>' +
      '<path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'
  ),
  eat: svg(
    '<path d="m7 11 4.08 10.35a1 1 0 0 0 1.84 0L17 11"/>' +
      '<path d="M17 7A5 5 0 0 0 7 7"/>' +
      '<path d="M17 7a2 2 0 0 1 0 4H7a2 2 0 0 1 0-4"/>'
  ),
  dig: svg(
    '<path d="M2 22v-5l5-5 5 5-5 5z"/>' +
      '<path d="M9.5 14.5 16 8"/>' +
      '<path d="m17 2 5 5-.5.5a3.53 3.53 0 0 1-5 0a3.53 3.53 0 0 1 0-5L17 2"/>'
  ),
  photo: svg(
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>' +
      '<circle cx="12" cy="13" r="3"/>'
  ),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  map: svg(
    '<path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z"/>' + '<path d="M9 3v15"/>' + '<path d="M15 6v15"/>'
  ),
  // contextual icons for the Use button, picked by the prompt's first word
  examine: svg('<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'),
  sit: svg(
    '<path d="M19 9V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v3"/>' +
      '<path d="M3 16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-4 0v1.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5V11a2 2 0 0 0-4 0z"/>' +
      '<path d="M5 18v2"/><path d="M19 18v2"/>'
  ),
  look: svg(
    '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'
  ),
  play: svg('<path d="M7 4v16l13-8z"/>'),
  ask: svg(
    '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/>' +
      '<path d="M12 17h.01"/>'
  ),
  bone: svg(
    '<path d="M17 10c.7-.7 1.69 0 2.5 0a2.5 2.5 0 1 0 0-5 .5.5 0 0 1-.5-.5 2.5 2.5 0 1 0-5 0c0 .81.7 1.8 0 2.5l-7 7c-.7.7-1.69 0-2.5 0a2.5 2.5 0 0 0 0 5c.28 0 .5.22.5.5a2.5 2.5 0 1 0 5 0c0-.81-.7-1.8 0-2.5Z"/>'
  ),
  leave: svg(
    '<path d="M13 4h3a2 2 0 0 1 2 2v14"/><path d="M2 20h3"/><path d="M13 20h9"/>' +
      '<path d="M10 12v.01"/><path d="M13 4.56v16.157a.5.5 0 0 1-.684.465L5 18V5.44a1 1 0 0 1 .684-.949l6-1.999A1 1 0 0 1 13 3.44z"/>'
  ),
  read: svg(
    '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'
  ),
  use: svg(
    '<path d="M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1"/>' +
      '<path d="M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10"/>' +
      '<path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>'
  ),
};

const USE_ICON = {
  examine: "examine",
  sit: "sit",
  look: "look",
  start: "play",
  watch: "play",
  ask: "ask",
  take: "photo",
  dig: "dig",
  assemble: "bone",
  order: "eat",
  leave: "leave",
  read: "read",
};

// grid order (2 columns on tall screens, 3 on short landscape ones)
const BUTTONS = [
  { key: "V", id: "roar", label: "Roar" },
  { key: "B", id: "wave", label: "Wave" },
  { key: "F", id: "eat", label: "Eat" },
  { key: "G", id: "photo", label: "Photo" },
  { key: "T", id: "chat", label: "Chat" },
  { key: "M", id: "map", label: "Map" },
];

/**
 * Replay a dock tap as a keyboard press ("E" -> KeyE down + up on window), so
 * every keyboard guard (joined, chat open, panel open, era view) applies to it.
 * Runs synchronously inside the tap, so Chat's focus() still counts as a user
 * gesture on iOS.
 */
export function pressKey(key) {
  const code = `Key${String(key).toUpperCase()}`;
  const init = { code, key: String(key).toLowerCase(), bubbles: true, cancelable: true };
  window.dispatchEvent(new KeyboardEvent("keydown", init));
  // the key-up keeps player.js's held-key set clean
  window.dispatchEvent(new KeyboardEvent("keyup", init));
}

function isCoarse() {
  try {
    return !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
  } catch {
    return false;
  }
}

/**
 * @param {{ onAction?: (key: string) => void, force?: boolean, parent?: HTMLElement }} opts
 *   force: build the dock even without a coarse pointer (tests / debugging)
 */
export function createTouchDock({ onAction, force = false, parent } = {}) {
  const noop = {
    el: null,
    active: false,
    setUseLabel() {},
    setEatAvailable() {},
    setVisible() {},
    dispose() {},
  };
  if (typeof document === "undefined" || (!force && !isCoarse())) return noop;

  const root = document.createElement("div");
  root.className = "touch-dock";
  root.setAttribute("role", "toolbar");
  root.setAttribute("aria-label", "Actions");
  document.body.classList.add("has-touch-dock");

  const btns = {};
  const make = ({ key, id, label }, cls) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `td-btn ${cls}`;
    b.dataset.key = key;
    b.dataset.action = id;
    b.setAttribute("aria-label", `${label} (${key})`);
    b.innerHTML = `<span class="td-ico">${ICONS[id] || ICONS.use}</span><span class="td-lbl">${label}</span>`;
    btns[id] = b;
    return b;
  };

  const use = make({ key: "E", id: "use", label: "Use" }, "td-use");
  use.hidden = true;
  root.appendChild(use);

  const grid = document.createElement("div");
  grid.className = "td-grid";
  for (const def of BUTTONS) grid.appendChild(make(def, "td-small"));
  root.appendChild(grid);
  btns.eat.classList.add("td-off");
  btns.eat.setAttribute("aria-hidden", "true");
  btns.eat.tabIndex = -1;

  (parent || document.body).appendChild(root);

  const minimap = () => document.getElementById("minimap");
  const syncMap = () => {
    const big = !!minimap()?.classList.contains("big");
    btns.map.classList.toggle("td-on", big);
    btns.map.setAttribute("aria-pressed", String(big));
  };
  syncMap();

  // a quick press pulse; the tap fires on `click` so iOS still treats Chat's
  // focus() as a user gesture and opens the keyboard
  function onClick(e) {
    const b = e.target.closest?.(".td-btn");
    if (!b || !root.contains(b) || b.classList.contains("td-off")) return;
    e.preventDefault();
    b.classList.remove("td-pop");
    void b.offsetWidth;
    b.classList.add("td-pop");
    clearTimeout(b._popT);
    b._popT = setTimeout(() => b.classList.remove("td-pop"), 320);
    try {
      navigator.vibrate?.(8);
    } catch {
      /* not supported */
    }
    onAction?.(b.dataset.key);
    if (b === btns.map) requestAnimationFrame(syncMap);
  }
  // player.js only starts a joystick / look drag on canvas touches, so taps
  // here never steer; css `touch-action: manipulation` stops double-tap zoom
  const noMenu = (e) => e.preventDefault();
  root.addEventListener("click", onClick);
  root.addEventListener("contextmenu", noMenu);

  let useLabel = null;
  let eatOn = false;
  let eatLabel = "Eat";

  return {
    el: root,
    active: true,
    /** Label of the thing in reach ("Examine T. rex"), or null to hide Use. */
    setUseLabel(text) {
      const next = text || null;
      if (next === useLabel) return;
      useLabel = next;
      use.hidden = !next;
      if (!next) return;
      const verb = next.split(" ")[0];
      const icon = USE_ICON[verb.toLowerCase()] || "use";
      use.querySelector(".td-ico").innerHTML = ICONS[icon];
      use.querySelector(".td-lbl").textContent = verb;
      use.setAttribute("aria-label", `${next} (E)`);
      use.classList.remove("td-in");
      void use.offsetWidth;
      use.classList.add("td-in");
    },
    /**
     * Show the F button. `label` picks its look: "Eat" (cone) or "Dig" (shovel).
     */
    setEatAvailable(on, label = "Eat") {
      const want = !!on;
      const lbl = /dig/i.test(label) ? "Dig" : "Eat";
      if (want === eatOn && lbl === eatLabel) return;
      eatOn = want;
      const b = btns.eat;
      if (lbl !== eatLabel) {
        eatLabel = lbl;
        b.querySelector(".td-ico").innerHTML = ICONS[lbl === "Dig" ? "dig" : "eat"];
        b.querySelector(".td-lbl").textContent = lbl;
        b.setAttribute("aria-label", `${lbl} (F)`);
      }
      b.classList.toggle("td-off", !want);
      b.setAttribute("aria-hidden", String(!want));
      b.tabIndex = want ? 0 : -1;
    },
    /** Hide the whole dock (input blocked, panels open, before join). */
    setVisible(v) {
      root.hidden = !v;
      if (v) syncMap();
    },
    dispose() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("contextmenu", noMenu);
      root.remove();
      document.body.classList.remove("has-touch-dock");
    },
  };
}

/**
 * Swipe a bottom sheet down to close it. Only drags when the sheet is
 * scrolled to the top (or the drag starts on its sticky header), so ordinary
 * scrolling inside the card still works. Returns a detach function.
 */
export function attachSheetSwipe(el, onClose) {
  if (!el) return () => {};
  let startY = 0;
  let dy = 0;
  let dragging = false;
  let tracking = false;
  let t0 = 0;
  const narrow = () => {
    try {
      return window.matchMedia("(max-width: 640px)").matches;
    } catch {
      return false;
    }
  };
  function start(e) {
    if (!narrow() || e.touches.length !== 1) return;
    const onHeader = !!e.target.closest?.(".exTop");
    if (!onHeader && el.scrollTop > 2) return;
    if (e.target.closest?.("button, a, input, iframe, video")) return;
    tracking = true;
    dragging = false;
    startY = e.touches[0].clientY;
    dy = 0;
    t0 = performance.now();
  }
  function move(e) {
    if (!tracking) return;
    dy = e.touches[0].clientY - startY;
    if (!dragging) {
      if (dy < -4) {
        tracking = false;
        return;
      }
      if (dy < 8) return;
      dragging = true;
      el.style.transition = "none";
      el.style.animation = "none";
    }
    e.preventDefault();
    el.style.transform = `translateY(${Math.max(0, dy)}px)`;
  }
  function end() {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    const fast = dy / Math.max(1, performance.now() - t0) > 0.6;
    const close = dy > Math.min(160, el.offsetHeight * 0.3) || (fast && dy > 40);
    el.style.transition = "transform .22s cubic-bezier(.2,.8,.2,1)";
    el.style.transform = close ? "translateY(100%)" : "";
    const done = () => {
      el.style.transition = "";
      el.style.animation = "";
      el.style.transform = "";
    };
    if (close) {
      setTimeout(() => {
        onClose?.();
        done();
      }, 200);
    } else {
      setTimeout(done, 240);
    }
  }
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchmove", move, { passive: false });
  el.addEventListener("touchend", end);
  el.addEventListener("touchcancel", end);
  return () => {
    el.removeEventListener("touchstart", start);
    el.removeEventListener("touchmove", move);
    el.removeEventListener("touchend", end);
    el.removeEventListener("touchcancel", end);
  };
}
