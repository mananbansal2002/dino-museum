/**
 * Species photos / paleoart served from /images/species/<id>.jpg with a
 * credits manifest at /images/species/manifest.json:
 *   { "<speciesId>": { file, credit, license, source } }
 * Everything here degrades gracefully when the images are missing.
 */

const BASE = "/images/species/";
let manifestPromise = null;
let manifest = null;
const images = new Map(); // id -> { img, status: "loading" | "ok" | "error", promise }

export function speciesImageUrl(id) {
  const file = manifest?.[id]?.file;
  return BASE + (file ? String(file).replace(/^.*\//, "") : `${id}.jpg`);
}

/** Loads (once) and returns the manifest, or {} if it is missing. */
export function loadImageManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(`${BASE}manifest.json`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then((m) => {
        manifest = m && typeof m === "object" ? m : {};
        return manifest;
      });
  }
  return manifestPromise;
}

/** The manifest if it has already loaded (synchronous), else null. */
export function imageManifest() {
  return manifest;
}

/** "Name — credit (license)" style string for a species, or "". */
export function imageCredit(id) {
  const e = manifest?.[id];
  if (!e) return "";
  return [e.credit, e.license].filter(Boolean).join(" · ");
}

/**
 * Returns a cached record { img, status } and starts loading if needed.
 * Failed loads are retried on the next call (the files may arrive later).
 */
export function speciesImage(id) {
  let rec = images.get(id);
  if (rec && rec.status !== "error") return rec;
  const img = new Image();
  img.decoding = "async";
  rec = { img, status: "loading", promise: null };
  rec.promise = new Promise((resolve) => {
    img.onload = () => {
      rec.status = img.naturalWidth > 0 ? "ok" : "error";
      resolve(rec);
    };
    img.onerror = () => {
      rec.status = "error";
      resolve(rec);
    };
  });
  images.set(id, rec);
  img.src = speciesImageUrl(id);
  return rec;
}
