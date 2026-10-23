/**
 * Real loading progress, plus a small frame-time governor.
 *
 * createLoading() counts every file three.js fetches (it wraps
 * THREE.DefaultLoadingManager, which every GLTFLoader / TextureLoader /
 * RGBELoader here uses) together with hand-registered tasks for the work
 * that is not a single file (props, live models, the gelateria, the crowd),
 * and drives the existing #loading / #loadingBar / #loadingText card with it.
 *
 * While the join screen is up the card sits inside the join card as a slim
 * strip (it never covers or blocks the buttons). Once the visitor is in, it
 * moves back into the HUD and stays until the last asset is in and a couple
 * of frames have been drawn. It never shows again after that, even though
 * the live models keep streaming in lazily as you walk around.
 *
 *   const loading = createLoading();
 *   const done = loading.add("props", "exhibits"); … done();
 *   loading.track(crowd.ready, "crowd", "cafe");
 *   loading.ready.then(() => …);
 *
 * watchPerformance({ onDrop }) samples frame times and suggests the next
 * lower quality after sustained slow frames (> 24 ms for 3 s by default).
 */

import * as THREE from "three";

/** Loading phases, in the order they are shown. */
export const PHASES = [
  { id: "halls", label: "Building the halls" },
  { id: "exhibits", label: "Hanging the exhibits" },
  { id: "dinosaurs", label: "Waking the dinosaurs" },
  { id: "cafe", label: "Opening the café" },
];
const PHASE_IDS = PHASES.map((p) => p.id);
/** ms each in-flight phase stays on screen before the next one gets a turn */
const PHASE_DWELL = 2200;

/** Quality ladder, best first (matches lookdev's tiers). */
export const QUALITY_LEVELS = ["ultra", "high", "medium", "low"];

/** Which phase a fetched file belongs to, from its URL. */
function phaseOfUrl(url) {
  const u = String(url || "");
  if (/\/models\/real\//.test(u)) return "dinosaurs";
  if (/\/models\/gelato\/|\/models\/humans\/|\/textures\/wood\//.test(u)) return "cafe";
  if (/\/models\/props\/|\/images\//.test(u)) return "exhibits";
  // embedded glTF textures arrive as blob:/data: URLs: they belong to
  // whichever model is unpacking them
  if (/^(blob|data):/.test(u)) return null;
  return "halls";
}

const STYLE_ID = "loading-style";
const CSS = `
#loading.ld-join{position:static;transform:none;left:auto;top:auto;width:auto;margin:14px 0 0;
  padding:12px 14px 12px;background:rgba(255,255,255,0.04);box-shadow:none;animation:none;z-index:auto;
  pointer-events:none;gap:2px 12px}
#loading.ld-join .spin{width:20px;height:20px;border-width:2px}
#loading.ld-join .ltitle{font-size:13px}
#loading.ld-join #loadingText{font-size:12px}
#loading.ld-join .lbar{margin-top:8px;height:3px}
#loading.ld-done .spin{animation:none;border-color:rgba(124,220,160,0.9)}
#loading.ld-fade{opacity:0;transition:opacity 0.45s ease}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

/**
 * Track real loading progress and show it on the #loading card.
 *
 * @param {object} [opts]
 * @param {THREE.LoadingManager} [opts.manager] defaults to THREE.DefaultLoadingManager
 * @param {number} [opts.timeout] ms after which loading counts as done regardless
 * @param {number} [opts.stallMs] give up sooner when nothing has finished for this long
 * @param {number} [opts.settleMs] quiet time with nothing pending before it is done
 *   (loads chain: a manifest fetch is followed by the models it lists)
 * @param {(info:{timedOut:boolean, ms:number, files:number, failed:string[]}) => void} [opts.onDone]
 * @returns the loading tracker (see the returned object below)
 */
export function createLoading({
  manager = THREE.DefaultLoadingManager,
  timeout = 60000,
  stallMs = 15000,
  settleMs = 600,
  onDone,
} = {}) {
  const box = document.getElementById("loading");
  const bar = document.getElementById("loadingBar");
  const text = document.getElementById("loadingText");
  const title = box?.querySelector(".ltitle") || null;
  const home = box ? { parent: box.parentNode, next: box.nextSibling } : null;
  if (box) injectStyle();

  const t0 = performance.now();
  // per phase: files/tasks started and finished
  const counts = Object.fromEntries(PHASE_IDS.map((id) => [id, { started: 0, ended: 0 }]));
  const fileOpen = new Map(); // url -> [phase, …] (a url can be in flight twice)
  const tasks = new Map(); // label -> { phase, done }
  const failed = [];
  let filesStarted = 0;
  let filesEnded = 0;
  let lastEnd = t0; // when the last file or task finished
  let lastPhase = "halls";
  let shownFrac = 0;
  let finished = false;
  let mode = null; // "join" | "hud" | null (not mounted)
  let hidden = false;
  let settleTimer = 0;
  let phaseTimer = 0;
  let raf = 0;
  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));

  /* ---------------- hook the loading manager ---------------- */
  // wrap (not replace) itemStart/itemEnd/itemError so every loader is seen
  // per URL, and chain any onProgress/onLoad someone else set
  const orig = {
    itemStart: manager.itemStart,
    itemEnd: manager.itemEnd,
    itemError: manager.itemError,
    onProgress: manager.onProgress,
    onLoad: manager.onLoad,
  };
  manager.itemStart = function (url) {
    if (!finished) {
      const phase = phaseOfUrl(url) || lastPhase;
      lastPhase = phase;
      const list = fileOpen.get(url) || [];
      list.push(phase);
      fileOpen.set(url, list);
      counts[phase].started++;
      filesStarted++;
      changed();
    }
    return orig.itemStart.call(this, url);
  };
  manager.itemEnd = function (url) {
    const list = fileOpen.get(url);
    if (!finished && list && list.length) {
      const phase = list.shift();
      if (!list.length) fileOpen.delete(url);
      counts[phase].ended++;
      filesEnded++;
      lastEnd = performance.now();
    }
    return orig.itemEnd.call(this, url);
  };
  manager.itemError = function (url) {
    // a missing file still counts as done (itemEnd follows); the primitive stays
    if (!finished) failed.push(String(url));
    return orig.itemError.call(this, url);
  };
  manager.onProgress = function (url, loaded, total) {
    changed();
    orig.onProgress?.call(this, url, loaded, total);
  };
  manager.onLoad = function () {
    changed();
    orig.onLoad?.call(this);
  };

  /* ---------------- manual tasks ---------------- */
  /**
   * Register a piece of work that is not a single file. Returns its done()
   * (idempotent); `done(label)` on the tracker does the same.
   */
  function add(label, phase = "halls") {
    const ph = PHASE_IDS.includes(phase) ? phase : "halls";
    let key = String(label);
    for (let n = 2; tasks.has(key); n++) key = `${label}#${n}`;
    const task = { phase: ph, done: false };
    tasks.set(key, task);
    if (!finished) counts[ph].started++;
    changed();
    return () => finishTask(key);
  }
  function finishTask(key) {
    const task = tasks.get(key);
    if (!task || task.done) return;
    task.done = true;
    if (!finished) counts[task.phase].ended++;
    lastEnd = performance.now();
    changed();
  }
  /** Mark a task done by label (the first unfinished one with that label). */
  function done(label) {
    for (const [key, t] of tasks) {
      if (!t.done && (key === label || key.startsWith(`${label}#`))) return finishTask(key);
    }
  }
  /** Count a promise (or thenable) as a task; it is done when it settles either way. */
  function track(promise, label, phase) {
    const end = add(label, phase);
    Promise.resolve(promise).then(end, end);
    return promise;
  }

  /* ---------------- progress ---------------- */
  function pending() {
    let n = 0;
    for (const id of PHASE_IDS) n += counts[id].started - counts[id].ended;
    return n;
  }
  function fraction() {
    let s = 0;
    let e = 0;
    for (const id of PHASE_IDS) {
      s += counts[id].started;
      e += counts[id].ended;
    }
    return s ? e / s : 0;
  }
  /**
   * The phase to show: the earliest one with work outstanding, and when
   * several are loading at once (they do: props, dinosaurs and the café all
   * stream in parallel) take turns between them every PHASE_DWELL ms, in
   * show order, so the text follows what is really in flight.
   */
  let shownPhase = null;
  let shownSince = 0;
  function currentPhase() {
    const open = PHASE_IDS.filter((id) => counts[id].ended < counts[id].started);
    if (!open.length) return shownPhase || lastPhase;
    const now = performance.now();
    if (!open.includes(shownPhase)) {
      shownPhase = open[0];
      shownSince = now;
    } else if (open.length > 1 && now - shownSince > PHASE_DWELL) {
      shownPhase = open[(open.indexOf(shownPhase) + 1) % open.length];
      shownSince = now;
    }
    return shownPhase;
  }

  function changed() {
    if (finished) return;
    if (!raf) raf = requestAnimationFrame(paint);
    // keep the phase text moving even while nothing completes
    if (!phaseTimer) {
      phaseTimer = setInterval(() => {
        if (!finished && !raf) raf = requestAnimationFrame(paint);
      }, PHASE_DWELL / 2);
    }
    clearTimeout(settleTimer);
    if (pending() === 0) settleTimer = setTimeout(maybeFinish, settleMs);
  }
  function maybeFinish() {
    if (!finished && pending() === 0) finish(false);
  }
  // a slow connection that is still making progress keeps the card up (up to
  // `timeout`); one that has stalled (a request that never answers) does not
  const hardStop = setInterval(() => {
    const now = performance.now();
    if (now - t0 > timeout || now - lastEnd > stallMs) finish(true);
  }, 1000);
  // nothing registered at all (everything cached / no loaders): settle anyway
  changed();

  function paint() {
    raf = 0;
    if (!box) return;
    const f = finished ? 1 : Math.min(0.97, fraction());
    // the total grows as manifests reveal more files: never run the bar backwards
    shownFrac = Math.max(shownFrac, f);
    const pct = Math.round(shownFrac * 100);
    if (bar) bar.style.width = `${pct}%`;
    box.setAttribute("aria-valuemin", "0");
    box.setAttribute("aria-valuemax", "100");
    box.setAttribute("aria-valuenow", String(pct));
    if (finished) {
      if (title) title.textContent = "The museum is open";
      if (text) text.textContent = "Enjoy your visit!";
      box.setAttribute("aria-valuetext", "Loaded");
      return;
    }
    const ph = currentPhase();
    const c = counts[ph];
    const label = PHASES.find((p) => p.id === ph).label;
    if (title) title.textContent = `Building the museum… ${pct}%`;
    if (text) text.textContent = c.started > 1 ? `${label} · ${c.ended} of ${c.started}` : `${label}…`;
    box.setAttribute("aria-valuetext", `${label}, ${pct}%`);
  }

  function finish(timedOut) {
    if (finished) return;
    finished = true;
    clearTimeout(settleTimer);
    clearInterval(hardStop);
    clearInterval(phaseTimer);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    paint();
    box?.classList.add("ld-done");
    const info = { timedOut, ms: Math.round(performance.now() - t0), files: filesEnded, failed: failed.slice() };
    if (timedOut) {
      const open = [...[...tasks].filter(([, t]) => !t.done).map(([k]) => k), ...fileOpen.keys()];
      console.warn(`loading: gave up waiting after ${info.ms} ms (${pending()} still pending: ${open.slice(0, 6).join(", ")}${open.length > 6 ? ", …" : ""})`);
    }
    resolveReady(info);
    try {
      onDone?.(info);
    } catch (err) {
      console.warn("loading: onDone failed", err);
    }
    // on the join screen just fade the strip away; in the museum wait for a
    // couple of frames of the visitor's view to be drawn first
    if (mode === "join") setTimeout(hide, 900);
    else if (mode === "hud") requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(hide, 250)));
  }

  /* ---------------- where the card lives ---------------- */
  const joinEl = document.getElementById("join");
  const joinVisible = () => !!joinEl && !joinEl.classList.contains("hidden");

  /**
   * Show the card on the join screen ("join") or over the museum ("hud").
   * Does nothing once loading is finished (it never comes back).
   */
  function attach(where) {
    if (!box || finished || hidden || where === mode) return;
    if (where === "join") {
      const card = joinEl?.querySelector(".card");
      if (!card) return;
      const status = card.querySelector("#joinStatus");
      card.insertBefore(box, status || null);
      box.classList.add("ld-join");
    } else {
      if (home?.parent) home.parent.insertBefore(box, home.next && home.next.parentNode === home.parent ? home.next : null);
      box.classList.remove("ld-join");
    }
    mode = where;
    box.classList.remove("hidden", "ld-fade");
    paint();
  }

  /** Fade the card out and put it back where it came from. */
  function hide() {
    if (!box || hidden) return;
    hidden = true;
    box.classList.add("ld-fade");
    setTimeout(() => {
      box.classList.add("hidden");
      box.classList.remove("ld-join", "ld-fade");
      if (home?.parent && box.parentNode !== home.parent) {
        home.parent.insertBefore(box, home.next && home.next.parentNode === home.parent ? home.next : null);
      }
      mode = null;
    }, 460);
  }

  // follow the join screen: the strip moves into the HUD when the visitor enters
  let joinWatch = null;
  if (box && joinEl) {
    if (joinVisible()) attach("join");
    joinWatch = new MutationObserver(() => {
      if (!joinVisible() && mode === "join") attach("hud");
    });
    joinWatch.observe(joinEl, { attributes: true, attributeFilter: ["class"] });
  }

  /** Unhook from the manager (and stop following the join screen). */
  function dispose() {
    joinWatch?.disconnect();
    clearInterval(phaseTimer);
    clearTimeout(settleTimer);
    clearInterval(hardStop);
    if (raf) cancelAnimationFrame(raf);
    // only restore what is still ours (someone may have wrapped us in turn)
    for (const k of Object.keys(orig)) {
      if (manager[k] && manager[k].__loadingWrap) manager[k] = orig[k];
    }
  }
  for (const k of Object.keys(orig)) if (typeof manager[k] === "function") manager[k].__loadingWrap = true;

  return {
    add,
    done,
    track,
    attach,
    hide,
    dispose,
    /** resolves with { timedOut, ms, files, failed } when everything is in */
    ready,
    get finished() {
      return finished;
    },
    /** 0..1 as shown on the bar */
    get progress() {
      return finished ? 1 : shownFrac;
    },
    get phase() {
      return finished ? null : currentPhase();
    },
    get mode() {
      return mode;
    },
    /** per-phase counts and outstanding work, for tests and the console */
    stats() {
      return {
        finished,
        mode,
        progress: +(finished ? 1 : fraction()).toFixed(3),
        phase: finished ? null : currentPhase(),
        files: { started: filesStarted, ended: filesEnded, failed: failed.length },
        phases: JSON.parse(JSON.stringify(counts)),
        tasks: [...tasks].filter(([, t]) => !t.done).map(([k, t]) => `${k} (${t.phase})`),
        inFlight: [...fileOpen.keys()].slice(0, 12),
      };
    },
  };
}

/**
 * Watch frame times and suggest a lower quality after sustained slow frames.
 *
 * Keeps an exponential moving average of the frame interval; when it stays
 * above `budgetMs` for `sustainMs` it calls onDrop({ from, to, avgMs, fps }).
 * Return false from onDrop to decline (the level then stays where it was).
 * With onRaise, a long stretch of headroom suggests the next level up again.
 * Samples are skipped while the tab is hidden and for the first `warmupMs`
 * (shaders compile and textures upload right after a change).
 *
 * It drives itself with requestAnimationFrame; pass { auto: false } and call
 * tick(ms) from the render loop instead if you prefer.
 *
 * @returns {{ tick(ms?:number):void, pause():void, resume():void, stop():void,
 *   setLevel(l:string):void, readonly level:string, readonly avgMs:number, readonly fps:number }}
 */
export function watchPerformance({
  onDrop,
  onRaise,
  level = "high",
  levels = QUALITY_LEVELS,
  budgetMs = 24,
  sustainMs = 3000,
  raiseBelowMs = 14,
  raiseAfterMs = 20000,
  cooldownMs = 5000,
  warmupMs = 3000,
  auto = true,
} = {}) {
  let idx = Math.max(0, levels.indexOf(level));
  let ema = 16.7;
  let overMs = 0;
  let underMs = 0;
  let quietUntil = performance.now() + warmupMs;
  let last = 0;
  let paused = false;
  let stopped = false;
  let raf = 0;

  function reset(now) {
    overMs = 0;
    underMs = 0;
    ema = 16.7;
    last = 0;
    quietUntil = Math.max(quietUntil, now + cooldownMs);
  }

  /** Feed one frame. With no argument the interval since the last call is used. */
  function tick(ms) {
    if (stopped || paused) return;
    const now = performance.now();
    if (ms == null) {
      ms = last ? now - last : 0;
      last = now;
    }
    // hidden tab / long hitch (alt-tab, a modal, GC): not a frame-time signal
    if (!(ms > 0) || ms > 250 || document.hidden) {
      overMs = 0;
      return;
    }
    if (now < quietUntil) return;
    ema += (ms - ema) * 0.08;
    if (ema > budgetMs) {
      overMs += ms;
      underMs = 0;
    } else {
      overMs = Math.max(0, overMs - ms * 0.5);
      underMs = ema < raiseBelowMs ? underMs + ms : 0;
    }
    if (overMs >= sustainMs && idx < levels.length - 1) {
      const info = { from: levels[idx], to: levels[idx + 1], avgMs: +ema.toFixed(1), fps: Math.round(1000 / ema) };
      let ok = true;
      try {
        ok = onDrop?.(info) !== false;
      } catch (err) {
        console.warn("watchPerformance: onDrop failed", err);
      }
      if (ok) idx++;
      reset(now);
    } else if (onRaise && underMs >= raiseAfterMs && idx > 0) {
      const info = { from: levels[idx], to: levels[idx - 1], avgMs: +ema.toFixed(1), fps: Math.round(1000 / ema) };
      let ok = true;
      try {
        ok = onRaise(info) !== false;
      } catch (err) {
        console.warn("watchPerformance: onRaise failed", err);
      }
      if (ok) idx--;
      reset(now);
    }
  }

  function loop() {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    tick();
  }
  if (auto) raf = requestAnimationFrame(loop);

  return {
    tick,
    pause() {
      paused = true;
      last = 0;
    },
    resume() {
      if (!paused) return;
      paused = false;
      last = 0;
      overMs = 0;
      quietUntil = Math.max(quietUntil, performance.now() + 1000);
    },
    stop() {
      stopped = true;
      cancelAnimationFrame(raf);
    },
    /** keep in step when the quality is changed elsewhere (a settings menu) */
    setLevel(l) {
      const i = levels.indexOf(l);
      if (i >= 0) idx = i;
      reset(performance.now());
    },
    get level() {
      return levels[idx];
    },
    get avgMs() {
      return +ema.toFixed(1);
    },
    get fps() {
      return Math.round(1000 / ema);
    },
  };
}
