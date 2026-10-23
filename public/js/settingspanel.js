/**
 * Settings panel: a dark-glass modal with four tabs (Graphics, Audio,
 * Controls, Accessibility) bound to the settings store (settings.js).
 *
 *   import { openSettings } from "./settingspanel.js";
 *   const panel = openSettings({ getStats: () => lookdev.stats() });
 *   panel.isOpen(); panel.close(); panel.open("audio");
 *
 * Every control writes straight to the store, so the change is live and
 * saved at once; whoever subscribed (main.js) applies it. The panel also
 * follows the store, so a reset or another tab updates what is on screen.
 *
 * While open the panel owns the keyboard: Esc (or the hotkey, O by default)
 * closes it, Tab stays inside the dialog, and other keys never reach the
 * game, so WASD / E / V do nothing behind it. Pointer lock is released on
 * open and focus returns to where it was on close.
 *
 * The Graphics tab shows a live FPS readout (frame time + a short history
 * graph), plus the renderer tier when `getStats` is given (lookdev.stats()).
 */

import { getSettings, rangeOf, QUALITY_LEVELS } from "./settings.js";

const TABS = [
  { id: "graphics", label: "Graphics" },
  { id: "audio", label: "Audio" },
  { id: "controls", label: "Controls" },
  { id: "access", label: "Accessibility" },
];

const QUALITY_INFO = {
  auto: { label: "Auto", desc: "Picks a level for this device and steps down if frames get slow." },
  low: { label: "Low", desc: "No post-processing or soft shadows. Best for phones and older laptops." },
  medium: { label: "Medium", desc: "Shadows and light bloom, without the heavier screen effects." },
  high: { label: "High", desc: "Full lighting, ambient occlusion and reflections." },
};

const KEYS = [
  ["W A S D", "Move"],
  ["Shift", "Run"],
  ["Space", "Jump"],
  ["Mouse", "Look around"],
  ["E", "Interact"],
  ["V", "Roar"],
  ["B", "Wave"],
  ["F", "Dig / eat ice cream"],
  ["G", "Group photo"],
  ["C", "Switch camera"],
  ["M", "Minimap size"],
  ["T", "Chat"],
  ["L", "Sound on / off"],
  ["O", "Settings"],
  ["Wheel", "Zoom"],
  ["Esc", "Free mouse / close"],
];

const CSS_HREF = "/css/settings.css";
const HISTORY = 90; // frame-time samples in the graph

let uid = 0;

/* ------------------------------------------------------------------ */
/* tiny DOM helpers                                                      */
/* ------------------------------------------------------------------ */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function ensureStylesheet() {
  if (typeof document === "undefined") return;
  const has = [...document.querySelectorAll('link[rel="stylesheet"]')].some((l) =>
    (l.getAttribute("href") || "").endsWith("settings.css")
  );
  if (has) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = CSS_HREF;
  document.head.appendChild(link);
}

function focusables(root) {
  return [
    ...root.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ),
  ].filter((n) => !n.closest("[hidden]") && n.offsetParent !== null);
}

/* ------------------------------------------------------------------ */
/* panel                                                                 */
/* ------------------------------------------------------------------ */
/**
 * @param {{
 *   settings?: ReturnType<typeof getSettings>,
 *   getStats?: () => ({ tier?: string, pixelRatio?: number, gpu?: string } | null),
 *   onOpen?: () => void,
 *   onClose?: () => void,
 *   onTestSound?: (kind: "master"|"music"|"sfx") => void,
 *   hotkey?: string | null,
 *   container?: HTMLElement,
 * }} [opts]
 */
export function createSettingsPanel({
  settings = getSettings(),
  getStats = null,
  onOpen = null,
  onClose = null,
  onTestSound = null,
  hotkey = "KeyO",
  container = document.body,
} = {}) {
  ensureStylesheet();
  const id = `set${++uid}`;
  let open = false;
  let tab = "graphics";
  let returnFocus = null;
  const binds = []; // (all) => void — refresh one control from the store

  /* ---------------- skeleton ---------------- */
  const root = el("div", "set-overlay");
  root.id = "settingsPanel";
  root.hidden = true;

  const card = el("div", "set-card");
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-labelledby", `${id}-title`);
  root.appendChild(card);

  const head = el("header", "set-head");
  const titles = el("div", "set-titles");
  titles.appendChild(el("div", "set-eyebrow", "Museum"));
  const h = el("h2", "set-title", "Settings");
  h.id = `${id}-title`;
  titles.appendChild(h);
  head.appendChild(titles);
  const closeBtn = el("button", "chip set-close", "close ✕");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close settings");
  head.appendChild(closeBtn);
  card.appendChild(head);

  const tablist = el("div", "set-tabs");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "Settings sections");
  card.appendChild(tablist);

  const body = el("div", "set-body");
  card.appendChild(body);

  const foot = el("footer", "set-foot");
  const resetBtn = el("button", "ghost set-reset", "Reset to defaults");
  resetBtn.type = "button";
  const hint = el("span", "set-hint", `Changes save automatically · Esc${hotkey === "KeyO" ? " or O" : ""} to close`);
  foot.appendChild(resetBtn);
  foot.appendChild(hint);
  card.appendChild(foot);

  const tabBtns = {};
  const panes = {};
  for (const t of TABS) {
    const b = el("button", "set-tab", t.label);
    b.type = "button";
    b.id = `${id}-tab-${t.id}`;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", `${id}-pane-${t.id}`);
    b.dataset.tab = t.id;
    b.addEventListener("click", () => setTab(t.id, true));
    tablist.appendChild(b);
    tabBtns[t.id] = b;

    const p = el("section", "set-pane");
    p.id = `${id}-pane-${t.id}`;
    p.setAttribute("role", "tabpanel");
    p.setAttribute("aria-labelledby", b.id);
    p.dataset.pane = t.id;
    body.appendChild(p);
    panes[t.id] = p;
  }

  /* ---------------- control builders ---------------- */
  function row(pane, label, desc) {
    const r = el("div", "set-row");
    const text = el("div", "set-text");
    const l = el("div", "set-label", label);
    l.id = `${id}-l${binds.length}-${Math.random().toString(36).slice(2, 6)}`;
    text.appendChild(l);
    if (desc) text.appendChild(el("div", "set-desc", desc));
    r.appendChild(text);
    const ctl = el("div", "set-ctl");
    r.appendChild(ctl);
    pane.appendChild(r);
    return { row: r, ctl, labelId: l.id, descEl: text.querySelector(".set-desc") };
  }

  function slider(pane, key, label, desc, fmt) {
    const { ctl, labelId } = row(pane, label, desc);
    const range = rangeOf(key);
    const input = el("input", "set-range");
    input.type = "range";
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.setAttribute("aria-labelledby", labelId);
    input.dataset.key = key;
    const out = el("output", "set-val");
    ctl.appendChild(input);
    ctl.appendChild(out);
    const paint = (v) => {
      input.value = String(v);
      out.textContent = fmt(v);
      input.setAttribute("aria-valuetext", fmt(v));
      input.style.setProperty("--fill", `${((v - range.min) / (range.max - range.min)) * 100}%`);
    };
    input.addEventListener("input", () => paint(settings.set(key, parseFloat(input.value))));
    binds.push((all) => paint(all[key]));
    return input;
  }

  function toggle(pane, key, label, desc) {
    const { ctl, labelId } = row(pane, label, desc);
    const b = el("button", "set-switch");
    b.type = "button";
    b.setAttribute("role", "switch");
    b.setAttribute("aria-labelledby", labelId);
    b.dataset.key = key;
    b.appendChild(el("span", "set-knob"));
    b.addEventListener("click", () => settings.set(key, !settings.get(key)));
    ctl.appendChild(b);
    binds.push((all) => b.setAttribute("aria-checked", all[key] ? "true" : "false"));
    return b;
  }

  /* ---------------- Graphics ---------------- */
  const g = panes.graphics;
  const meter = el("div", "set-meter");
  const meterNum = el("div", "set-fps");
  const fpsVal = el("b", null, "--");
  meterNum.appendChild(fpsVal);
  meterNum.appendChild(el("span", null, "FPS"));
  const meterInfo = el("div", "set-meter-info");
  const msLine = el("div", "set-ms", "measuring…");
  const tierLine = el("div", "set-tier", "");
  meterInfo.appendChild(msLine);
  meterInfo.appendChild(tierLine);
  const graph = el("canvas", "set-graph");
  graph.width = 180;
  graph.height = 44;
  graph.setAttribute("aria-hidden", "true");
  meter.appendChild(meterNum);
  meter.appendChild(meterInfo);
  meter.appendChild(graph);
  meter.setAttribute("role", "status");
  meter.setAttribute("aria-label", "Live frame rate");
  g.appendChild(meter);

  const q = row(g, "Graphics quality", QUALITY_INFO.auto.desc);
  const seg = el("div", "set-seg");
  seg.setAttribute("role", "radiogroup");
  seg.setAttribute("aria-labelledby", q.labelId);
  const segBtns = {};
  for (const level of QUALITY_LEVELS) {
    const b = el("button", "set-seg-btn", QUALITY_INFO[level].label);
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.value = level;
    b.addEventListener("click", () => settings.set("quality", level));
    seg.appendChild(b);
    segBtns[level] = b;
  }
  function stepQuality(d) {
    const i = QUALITY_LEVELS.indexOf(settings.get("quality"));
    const next = QUALITY_LEVELS[(i + d + QUALITY_LEVELS.length) % QUALITY_LEVELS.length];
    settings.set("quality", next);
    segBtns[next].focus();
  }
  q.row.classList.add("set-row-stack");
  q.ctl.appendChild(seg);
  binds.push((all) => {
    for (const level of QUALITY_LEVELS) {
      const on = all.quality === level;
      segBtns[level].setAttribute("aria-checked", on ? "true" : "false");
      segBtns[level].tabIndex = on ? 0 : -1;
    }
    if (q.descEl) q.descEl.textContent = QUALITY_INFO[all.quality].desc;
  });

  slider(g, "fov", "Field of view", "How wide the camera sees. Lower feels closer; higher shows more of the hall.", (v) => `${Math.round(v)}°`);

  /* ---------------- Audio ---------------- */
  const a = panes.audio;
  const pct = (v) => `${Math.round(v * 100)}%`;
  slider(a, "masterVolume", "Master volume", "Everything you hear in the museum.", pct);
  slider(a, "musicVolume", "Music & ambience", "Hall atmosphere, music boxes and room tone.", pct);
  slider(a, "sfxVolume", "Sound effects", "Roars, footsteps, chimes and clicks.", pct);
  if (onTestSound) {
    const t = row(a, "Test", "Play a short sound at the current volume.");
    const b = el("button", "chip set-test", "▶ play");
    b.type = "button";
    b.addEventListener("click", () => {
      try {
        onTestSound("sfx");
      } catch (err) {
        console.warn("settings: test sound failed", err);
      }
    });
    t.ctl.appendChild(b);
  }

  /* ---------------- Controls ---------------- */
  const c = panes.controls;
  slider(c, "mouseSensitivity", "Look sensitivity", "How far the camera turns for each mouse or touch movement.", (v) => `${v.toFixed(2)}×`);
  toggle(c, "invertY", "Invert vertical look", "Move the mouse up to look down, like a flight stick.");
  const keyWrap = el("div", "set-keys");
  keyWrap.appendChild(el("div", "set-subhead", "Keyboard"));
  const grid = el("dl", "set-keygrid");
  for (const [k, what] of KEYS) {
    const item = el("div", "set-key");
    const dt = el("dt");
    dt.appendChild(el("kbd", null, k));
    item.appendChild(dt);
    item.appendChild(el("dd", null, what));
    grid.appendChild(item);
  }
  keyWrap.appendChild(grid);
  c.appendChild(keyWrap);

  /* ---------------- Accessibility ---------------- */
  const x = panes.access;
  toggle(x, "reducedMotion", "Reduce motion", "Fewer particles, no screen shake and calmer menu animations.");
  toggle(x, "subtitles", "Subtitles", "Show captions for narration and videos when available.");
  toggle(x, "narration", "Audio narration", "Read exhibit introductions aloud when you arrive in a hall.");

  container.appendChild(root);

  /* ---------------- store <-> UI ---------------- */
  function sync() {
    const all = settings.all();
    for (const fn of binds) fn(all);
  }
  const unsub = settings.onChange(() => sync());
  sync();

  resetBtn.addEventListener("click", () => {
    settings.reset();
    resetBtn.textContent = "Defaults restored";
    clearTimeout(resetBtn._t);
    resetBtn._t = setTimeout(() => (resetBtn.textContent = "Reset to defaults"), 1400);
  });
  closeBtn.addEventListener("click", () => close());
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close(); // click on the dimmed backdrop
  });

  /* ---------------- tabs ---------------- */
  function setTab(next, focus = false) {
    if (!panes[next]) return;
    tab = next;
    for (const t of TABS) {
      const on = t.id === next;
      tabBtns[t.id].setAttribute("aria-selected", on ? "true" : "false");
      tabBtns[t.id].tabIndex = on ? 0 : -1;
      panes[t.id].hidden = !on;
    }
    if (focus) tabBtns[next].focus();
    if (open) syncMeterLoop();
  }
  setTab(tab);

  /* ---------------- FPS meter ---------------- */
  const samples = new Float32Array(HISTORY);
  let sampleCount = 0;
  let sampleHead = 0;
  let raf = 0;
  let last = 0;
  let windowStart = 0;
  let windowFrames = 0;
  const gctx = graph.getContext("2d");

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (last) {
      const dt = Math.min(250, now - last);
      samples[sampleHead] = dt;
      sampleHead = (sampleHead + 1) % HISTORY;
      sampleCount = Math.min(HISTORY, sampleCount + 1);
      windowFrames++;
    } else {
      windowStart = now;
    }
    last = now;
    const span = now - windowStart;
    if (span >= 400 && windowFrames > 0) {
      const fps = (windowFrames * 1000) / span;
      paintMeter(fps, span / windowFrames);
      windowStart = now;
      windowFrames = 0;
    }
  }

  function paintMeter(fps, ms) {
    fpsVal.textContent = fps < 10 ? fps.toFixed(1) : String(Math.round(fps));
    meter.dataset.level = fps >= 50 ? "good" : fps >= 28 ? "ok" : "bad";
    msLine.textContent = `${ms.toFixed(1)} ms per frame`;
    let stats = null;
    try {
      stats = getStats ? getStats() : null;
    } catch {
      stats = null;
    }
    const parts = [];
    if (stats?.tier) {
      const t = String(stats.tier);
      const name = t.charAt(0).toUpperCase() + t.slice(1);
      parts.push(settings.get("quality") === "auto" ? `Auto is running ${name}` : `Rendering ${name}`);
    }
    if (stats?.pixelRatio) parts.push(`${(+stats.pixelRatio).toFixed(2).replace(/\.?0+$/, "")}× resolution`);
    tierLine.textContent = parts.join(" · ");
    drawGraph();
  }

  function drawGraph() {
    if (!gctx) return;
    const w = graph.width;
    const hgt = graph.height;
    gctx.clearRect(0, 0, w, hgt);
    // 16.7 ms (60 fps) and 33.3 ms (30 fps) guides; the graph tops out at
    // 50 ms, or higher when frames are slower so the line stays readable
    let top = 50;
    for (let i = 0; i < sampleCount; i++) top = Math.max(top, samples[i] * 1.15);
    const y = (ms) => hgt - Math.min(1, ms / top) * (hgt - 2) - 1;
    gctx.strokeStyle = "rgba(255,255,255,0.12)";
    gctx.lineWidth = 1;
    for (const ms of [16.7, 33.3]) {
      gctx.beginPath();
      gctx.moveTo(0, Math.round(y(ms)) + 0.5);
      gctx.lineTo(w, Math.round(y(ms)) + 0.5);
      gctx.stroke();
    }
    if (sampleCount < 2) return;
    const step = w / (HISTORY - 1);
    const start = (sampleHead - sampleCount + HISTORY) % HISTORY;
    const offset = (HISTORY - sampleCount) * step;
    gctx.beginPath();
    for (let i = 0; i < sampleCount; i++) {
      const v = samples[(start + i) % HISTORY];
      const px = offset + i * step;
      if (i === 0) gctx.moveTo(px, y(v));
      else gctx.lineTo(px, y(v));
    }
    const level = meter.dataset.level;
    gctx.strokeStyle = level === "bad" ? "#ff8a7a" : level === "ok" ? "#ffc857" : "#7ee081";
    gctx.lineWidth = 1.6;
    gctx.lineJoin = "round";
    gctx.stroke();
  }

  function syncMeterLoop() {
    const want = open && tab === "graphics";
    if (want && !raf) {
      last = 0;
      windowFrames = 0;
      raf = requestAnimationFrame(frame);
    } else if (!want && raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  /* ---------------- keyboard ---------------- */
  function onKeyDown(e) {
    if (!open) return;
    if (e.code === "Escape" || (hotkey && e.code === hotkey && !isTextField(e.target))) {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
      return;
    }
    if (e.key === "Tab") {
      const list = focusables(card);
      if (list.length) {
        const first = list[0];
        const lastEl = list[list.length - 1];
        const inside = card.contains(document.activeElement);
        if (e.shiftKey && (document.activeElement === first || !inside)) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && (document.activeElement === lastEl || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    } else if (e.target?.getAttribute?.("role") === "tab" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const i = TABS.findIndex((t) => t.id === tab);
      const d = e.key === "ArrowLeft" ? -1 : 1;
      setTab(TABS[(i + d + TABS.length) % TABS.length].id, true);
    } else if (e.target?.closest?.(".set-seg") && e.key.startsWith("Arrow")) {
      // radiogroup: arrows move the selection (handled here, in the capture
      // phase, because the event never reaches the element below)
      e.preventDefault();
      stepQuality(e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1);
    }
    // nothing typed while the panel is up reaches the game (WASD, E, V…);
    // default actions (range arrows, button Space/Enter) still happen
    e.stopImmediatePropagation();
  }
  function isTextField(t) {
    return !!(t && (/textarea|select/i.test(t.tagName) || (t.tagName === "INPUT" && t.type === "text") || t.isContentEditable));
  }
  window.addEventListener("keydown", onKeyDown, true);

  /* ---------------- open / close ---------------- */
  function openPanel(which) {
    if (which && panes[which]) setTab(which);
    if (open) return api;
    open = true;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      if (document.pointerLockElement) document.exitPointerLock?.();
    } catch {
      /* ignore */
    }
    sync();
    root.hidden = false;
    root.classList.remove("set-leaving");
    syncMeterLoop();
    // focus the active tab so arrows switch sections at once
    requestAnimationFrame(() => tabBtns[tab].focus({ preventScroll: true }));
    try {
      onOpen?.();
    } catch (err) {
      console.warn("settings: onOpen failed", err);
    }
    window.dispatchEvent(new CustomEvent("settings:open"));
    return api;
  }

  function close() {
    if (!open) return;
    open = false;
    syncMeterLoop();
    settings.flush?.();
    root.hidden = true;
    if (returnFocus && document.contains(returnFocus)) {
      try {
        returnFocus.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    } else if (document.activeElement && root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    returnFocus = null;
    try {
      onClose?.();
    } catch (err) {
      console.warn("settings: onClose failed", err);
    }
    window.dispatchEvent(new CustomEvent("settings:close"));
  }

  const api = {
    el: root,
    open: openPanel,
    close,
    toggle(which) {
      if (open) close();
      else openPanel(which);
      return open;
    },
    isOpen: () => open,
    get tab() {
      return tab;
    },
    setTab: (t) => setTab(t),
    /** Last measured FPS shown in the readout (NaN until the first update). */
    get fps() {
      return parseFloat(fpsVal.textContent);
    },
    dispose() {
      close();
      unsub();
      window.removeEventListener("keydown", onKeyDown, true);
      root.remove();
    },
  };
  return api;
}

let shared = null;
/**
 * Open the app-wide settings panel (created on first call with `opts`).
 * Later calls reuse it; `opts.tab` picks the section to show.
 * @returns {{ open: Function, close: Function, isOpen: () => boolean, toggle: Function }}
 */
export function openSettings(opts = {}) {
  if (!shared || !document.contains(shared.el)) shared = createSettingsPanel(opts);
  shared.open(opts.tab);
  return shared;
}

/** The shared panel if it was ever created (for anyPanelOpen checks). */
export function settingsPanel() {
  return shared;
}

/** True while the shared settings panel is on screen. */
export function settingsOpen() {
  return !!shared?.isOpen();
}
