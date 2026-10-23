/**
 * Player settings: one small persisted store that every system reads from.
 *
 *   const settings = getSettings();          // shared instance
 *   settings.get("fov")                      // 55
 *   settings.set("fov", 70)                  // validated, saved, broadcast
 *   settings.patch({ invertY: true, sfxVolume: 0.5 })
 *   const off = settings.onChange((key, value, all) => …)
 *   settings.watch("quality", (q) => lookdev.setQuality(q))  // now + on change
 *   settings.reset()                         // back to DEFAULTS
 *
 * Every value is validated on the way in (enums, clamped ranges, booleans),
 * so a hand-edited or stale localStorage entry can never put the game into a
 * bad state. Storage is best effort: private windows and blocked site data
 * just keep the settings in memory for the session. Another tab changing the
 * settings updates this one too (the `storage` event).
 *
 * Side effect owned here: <html data-reduced-motion> mirrors `reducedMotion`
 * so CSS (settings.css) can calm every UI animation without any JS wiring.
 */

const STORE_KEY = "dino-museum:settings:v1";
// audio.js persists its own master volume; seed from it so the two agree
const AUDIO_VOLUME_KEY = "dino-museum:audio:volume";

export const QUALITY_LEVELS = ["auto", "low", "medium", "high"];
export const FOV_MIN = 50;
export const FOV_MAX = 80;
export const SENS_MIN = 0.25;
export const SENS_MAX = 3;

/** key → { type, default, … } — the single source of truth for validation. */
const SCHEMA = {
  quality: { type: "enum", values: QUALITY_LEVELS, def: () => "auto" },
  masterVolume: { type: "num", min: 0, max: 1, step: 0.01, def: () => seedMasterVolume() },
  musicVolume: { type: "num", min: 0, max: 1, step: 0.01, def: () => 0.8 },
  sfxVolume: { type: "num", min: 0, max: 1, step: 0.01, def: () => 1 },
  mouseSensitivity: { type: "num", min: SENS_MIN, max: SENS_MAX, step: 0.05, def: () => 1 },
  invertY: { type: "bool", def: () => false },
  fov: { type: "num", min: FOV_MIN, max: FOV_MAX, step: 1, def: () => 55 },
  reducedMotion: { type: "bool", def: () => prefersReducedMotion() },
  subtitles: { type: "bool", def: () => true },
  narration: { type: "bool", def: () => true },
};

export const SETTING_KEYS = Object.keys(SCHEMA);

/** Fresh defaults (evaluated now: media queries and the audio key may change). */
export function defaultSettings() {
  const out = {};
  for (const k of SETTING_KEYS) out[k] = SCHEMA[k].def();
  return out;
}

/** Coerce `value` into a legal value for `key`; `undefined` when unusable. */
export function sanitize(key, value) {
  const s = SCHEMA[key];
  if (!s) return undefined;
  if (s.type === "enum") {
    const v = String(value ?? "").toLowerCase();
    if (v === "med") return "medium";
    return s.values.includes(v) ? v : undefined;
  }
  if (s.type === "bool") {
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true" || value === "on") return true;
    if (value === 0 || value === "0" || value === "false" || value === "off") return false;
    return undefined;
  }
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(n)) return undefined;
  const c = Math.min(s.max, Math.max(s.min, n));
  // snap to the step so 0.30000000004 never reaches storage or the UI
  const snapped = Math.round(c / s.step) * s.step;
  return +snapped.toFixed(4);
}

/** Range metadata for a numeric key ({min, max, step}) — used by the panel. */
export function rangeOf(key) {
  const s = SCHEMA[key];
  return s && s.type === "num" ? { min: s.min, max: s.max, step: s.step } : null;
}

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */
function prefersReducedMotion() {
  try {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function storage() {
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

function seedMasterVolume() {
  try {
    const raw = storage()?.getItem(AUDIO_VOLUME_KEY);
    const v = raw == null ? NaN : parseFloat(raw);
    if (Number.isFinite(v)) return Math.min(1, Math.max(0, +v.toFixed(2)));
  } catch {
    /* ignore */
  }
  return 0.8;
}

function readStored(key) {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* store                                                                */
/* ------------------------------------------------------------------ */
/**
 * @param {{ storageKey?: string, persist?: boolean, applyDom?: boolean }} [opts]
 */
export function createSettings({ storageKey = STORE_KEY, persist = true, applyDom = true } = {}) {
  const values = defaultSettings();
  const listeners = new Set();

  // stored values win over defaults, one key at a time (unknown keys dropped)
  const stored = persist ? readStored(storageKey) : null;
  if (stored) {
    for (const k of SETTING_KEYS) {
      const v = sanitize(k, stored[k]);
      if (v !== undefined) values[k] = v;
    }
  }

  let saveTimer = 0;
  function save() {
    if (!persist) return;
    // sliders fire many inputs a second: coalesce into one write
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 120);
  }
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!persist) return;
    try {
      storage()?.setItem(storageKey, JSON.stringify(values));
    } catch {
      /* quota / blocked: keep the in-memory values */
    }
  }

  function applyDomState() {
    if (!applyDom || typeof document === "undefined") return;
    const root = document.documentElement;
    if (values.reducedMotion) root.setAttribute("data-reduced-motion", "");
    else root.removeAttribute("data-reduced-motion");
  }

  function emit(changed) {
    if (!changed.length) return;
    applyDomState();
    const snapshot = { ...values };
    for (const [k, v] of changed) {
      for (const fn of [...listeners]) {
        try {
          fn(k, v, snapshot);
        } catch (err) {
          console.warn("settings: listener failed for", k, err);
        }
      }
    }
  }

  /** Apply a partial object; returns the [key, value] pairs that changed. */
  function assign(obj) {
    const changed = [];
    for (const k of Object.keys(obj || {})) {
      if (!(k in SCHEMA)) continue;
      const v = sanitize(k, obj[k]);
      if (v === undefined || v === values[k]) continue;
      values[k] = v;
      changed.push([k, v]);
    }
    return changed;
  }

  function onStorage(e) {
    if (e.key !== storageKey || !e.newValue) return;
    try {
      const changed = assign(JSON.parse(e.newValue));
      emit(changed); // no save: the other tab already wrote it
    } catch {
      /* ignore malformed */
    }
  }
  if (persist && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  if (persist && typeof window !== "undefined") window.addEventListener("pagehide", flush);

  applyDomState();

  const api = {
    /** Current value of one key. */
    get(key) {
      return values[key];
    },
    /** Set one key; returns the value actually stored (after validation). */
    set(key, value) {
      const changed = assign({ [key]: value });
      if (changed.length) {
        save();
        emit(changed);
      }
      return values[key];
    },
    /** Set several keys at once (one save, one notification per changed key). */
    patch(obj) {
      const changed = assign(obj);
      if (changed.length) {
        save();
        emit(changed);
      }
      return changed.length;
    },
    /** Shallow copy of every value. */
    all() {
      return { ...values };
    },
    /** Back to defaults (keeps listeners). */
    reset() {
      return api.patch(defaultSettings());
    },
    /** fn(key, value, allValues) on every change; returns an unsubscribe fn. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** fn(value, key) now and whenever `key` (or any of an array of keys) changes. */
    watch(keys, fn) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        try {
          fn(values[k], k);
        } catch (err) {
          console.warn("settings: watcher failed for", k, err);
        }
      }
      return api.onChange((k, v) => {
        if (list.includes(k)) fn(v, k);
      });
    },
    /** Write any pending change to storage now. */
    flush,
    dispose() {
      flush();
      listeners.clear();
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener("pagehide", flush);
      }
    },
  };
  api.subscribe = api.onChange;
  return api;
}

let shared = null;
/** The app-wide store (created on first use). */
export function getSettings() {
  if (!shared) shared = createSettings();
  return shared;
}
