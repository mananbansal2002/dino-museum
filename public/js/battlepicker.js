import { SPECIES } from "./species.js";
import { pushKeyScope, isYouTubeId } from "./video.js";
import { speciesImageUrl, loadImageManifest, imageManifest, imageCredit } from "./speciesimages.js";

/**
 * Screening Theatre programme: a modal grid of fight cards.
 *
 *   const picker = createBattlePicker({
 *     battles,                      // BATTLES (each may carry videos: [{id,title,channel}])
 *     extra,                        // EXTRA_SCREENINGS: [{id,title,channel,matchup}]
 *     videosUrl,                    // default "/data/videos.json"; fetched once on first open()
 *                                   // and merged into battle.videos / extra (null to skip)
 *     onPlay3D(battleId),           // start the theatre screening ("▶ Screen in theatre")
 *     onPlayVideo(video, battle),   // battle is null for an extra screening
 *     onSearch(query, battle),      // optional: shown when a battle has no videos
 *     onClose(),
 *   });
 *   picker.open(); picker.close(); picker.isOpen();
 *
 * `battles` / `extra` are read on every open(), so videos merged in later show up.
 * Keyboard: arrows move between cards, Enter plays (theatre screening for battle cards),
 * Tab reaches each card's buttons, Esc closes. Styles live in /css/media.css.
 */

const KIND = {
  fossil: { label: "Fossil evidence", cls: "fossil", tip: "A fossil records this kind of encounter" },
  coexisted: { label: "Lived together", cls: "coexisted", tip: "They shared the same time and place" },
  whatif: { label: "What if?", cls: "whatif", tip: "These animals never actually met" },
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function fighterName(id) {
  return SPECIES[id]?.name || id || "?";
}

/* ------------------------------------------------------------------ */
/* video catalogue: /data/videos.json                                   */
/*   { battles: { <battleId>: [{id,title,channel}] }, extra: [{id,title,channel,matchup}] } */
/* ------------------------------------------------------------------ */
const catalogues = new Map();

/** Fetches a video catalogue once per URL; resolves to {} on any failure. */
export function fetchVideoCatalogue(url = "/data/videos.json") {
  if (!catalogues.has(url)) {
    catalogues.set(
      url,
      fetch(url)
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))
        .then((d) => (d && typeof d === "object" ? d : {}))
    );
  }
  return catalogues.get(url);
}

/** Adds catalogue clips to battle.videos and to the extra list, skipping duplicates and bad ids. */
export function mergeVideos(battles, extra, data = {}) {
  for (const b of battles || []) {
    const list = data.battles?.[b.id];
    if (!Array.isArray(list)) continue;
    if (!Array.isArray(b.videos)) b.videos = [];
    for (const v of list) {
      if (isYouTubeId(v?.id) && !b.videos.some((x) => x.id === v.id)) b.videos.push({ ...v });
    }
  }
  if (Array.isArray(extra)) {
    for (const v of data.extra || []) {
      if (isYouTubeId(v?.id) && !extra.some((x) => x.id === v.id)) extra.push({ ...v });
    }
  }
}

function hex(n) {
  return `#${(n >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
}

export function createBattlePicker({
  battles = [],
  extra = [],
  videosUrl = "/data/videos.json",
  onPlay3D,
  onPlay, // alias of onPlay3D
  onPlayVideo,
  onSearch,
  onClose,
} = {}) {
  const root = el("div", "media-overlay bp-overlay hidden");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "bpTitle");

  const card = el("div", "media-card bp-card");
  const head = el("div", "bp-head");
  const headText = el("div");
  const h = el("h2", null, "🎬 Tonight's screenings");
  h.id = "bpTitle";
  headText.append(h, el("p", "bp-lede", "Pick a match-up. Screen it in the theatre, or watch real footage and documentary clips on YouTube."));
  const closeBtn = el("button", "media-close", "✕");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  head.append(headText, closeBtn);
  const body = el("div", "bp-body");
  const hint = el("div", "bp-hint", "← → ↑ ↓ choose · Enter play · Esc close");
  card.append(head, body, hint);
  root.append(card);

  let mounted = false;
  let open = false;
  let popKeys = null;
  let lastFocus = null;
  let focusIndex = 0;

  const validVideos = (list) => (Array.isArray(list) ? list.filter((v) => isYouTubeId(v?.id)) : []);

  function battleCard(b) {
    const c = el("article", "bp-item");
    c.tabIndex = -1;
    c.dataset.battle = b.id;
    const kind = KIND[b.kind];
    const badges = el("div", "bp-badges");
    if (b.era) badges.append(el("span", "bp-badge era", b.era));
    if (kind) {
      const k = el("span", `bp-badge ${kind.cls}`, kind.label);
      k.title = kind.tip;
      badges.append(k);
    }
    const title = el("h3", "bp-item-title", b.title);
    const sub = el("div", "bp-item-sub", b.subtitle || "");
    const vs = el("div", "bp-art");
    vs.append(fighterArt(b.a, "a"), el("span", "bp-vs-mark", "VS"), fighterArt(b.b, "b"));
    const credit = el("div", "bp-credit");
    credit.dataset.a = b.a;
    credit.dataset.b = b.b;
    const actions = el("div", "bp-actions");
    const play = el("button", "media-btn primary bp-play", "▶ Screen in theatre");
    play.type = "button";
    play.onclick = () => choose3D(b);
    actions.append(play);
    const vids = validVideos(b.videos);
    if (vids.length) {
      const yt = el("button", "media-btn ghost bp-yt", `▶ Watch on YouTube (${vids.length})`);
      yt.type = "button";
      yt.onclick = () => chooseVideo(vids[0], b);
      actions.append(yt);
    } else if (onSearch) {
      const s = el("button", "media-btn ghost bp-yt", "🔎 Find on YouTube");
      s.type = "button";
      s.onclick = () => onSearch(`${b.title} dinosaur`, b);
      actions.append(s);
    }
    c.append(vs, badges, title, sub, credit, actions);
    c.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      focusCard(cards().indexOf(c));
    });
    c._primary = () => choose3D(b);
    return c;
  }

  function fighterArt(id, side) {
    const spec = SPECIES[id];
    const box = el("div", `bp-art-side ${side}`);
    const c1 = hex(spec?.color ?? 0x556677);
    const c2 = hex(spec?.accent ?? spec?.color ?? 0x334455);
    // the gradient shows through when the photo is missing
    box.style.backgroundImage = `url("${speciesImageUrl(id)}"), linear-gradient(135deg, ${c1}, ${c2})`;
    box.append(el("span", "bp-art-name", fighterName(id)));
    return box;
  }

  function fillCredits() {
    for (const n of body.querySelectorAll(".bp-credit")) {
      const ids = [...new Set([n.dataset.a, n.dataset.b])];
      const parts = ids.map((id) => imageCredit(id)).filter(Boolean);
      n.textContent = parts.length ? `Images: ${parts.join(" · ")}` : "";
    }
  }

  function extraCard(v) {
    const c = el("article", "bp-item bp-extra");
    c.tabIndex = -1;
    const badges = el("div", "bp-badges");
    badges.append(el("span", "bp-badge video", "YouTube"));
    const title = el("h3", "bp-item-title", v.matchup || v.title);
    const sub = el("div", "bp-item-sub", v.matchup ? v.title : "");
    const ch = el("div", "bp-channel", v.channel ? `▶ ${v.channel}` : "");
    const actions = el("div", "bp-actions");
    const yt = el("button", "media-btn primary bp-yt", "▶ Watch on YouTube");
    yt.type = "button";
    yt.onclick = () => chooseVideo(v, null);
    actions.append(yt);
    const art = el("div", "bp-art bp-art-video");
    art.style.backgroundImage = `url("https://i.ytimg.com/vi/${v.id}/hqdefault.jpg"), linear-gradient(135deg, #3a1d1d, #121a22)`;
    c.append(art, badges, title, sub, ch, actions);
    c._primary = () => chooseVideo(v, null);
    return c;
  }

  function render() {
    body.replaceChildren();
    const grid = el("div", "bp-grid");
    for (const b of battles) grid.append(battleCard(b));
    body.append(grid);
    const ex = validVideos(extra);
    if (ex.length) {
      body.append(el("h4", "bp-section", "More on YouTube"));
      const g2 = el("div", "bp-grid");
      for (const v of ex) g2.append(extraCard(v));
      body.append(g2);
    }
  }

  const cards = () => [...body.querySelectorAll(".bp-item")];

  function focusCard(i) {
    const list = cards();
    if (!list.length) return;
    focusIndex = Math.max(0, Math.min(list.length - 1, i));
    list.forEach((c, j) => {
      c.classList.toggle("focused", j === focusIndex);
      c.tabIndex = j === focusIndex ? 0 : -1;
    });
    const c = list[focusIndex];
    c.focus({ preventScroll: true });
    c.scrollIntoView({ block: "nearest" });
  }

  // geometric neighbour so up/down works whatever the column count is
  function neighbour(dir) {
    const list = cards();
    const cur = list[focusIndex];
    if (!cur) return 0;
    if (dir === "left") return focusIndex - 1;
    if (dir === "right") return focusIndex + 1;
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    let best = focusIndex;
    let bestScore = Infinity;
    list.forEach((c, j) => {
      if (j === focusIndex) return;
      const q = c.getBoundingClientRect();
      const dy = dir === "down" ? q.top - r.bottom : r.top - q.bottom;
      if (dy < -2) return;
      const score = dy * 4 + Math.abs(q.left + q.width / 2 - cx);
      if (score < bestScore) {
        bestScore = score;
        best = j;
      }
    });
    return best;
  }

  function choose3D(b) {
    close();
    (onPlay || onPlay3D)?.(b.id);
  }

  function chooseVideo(v, b) {
    onPlayVideo?.(v, b);
  }

  function onKey(e) {
    const k = e.key;
    if (k === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    const map = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
    if (map[k]) {
      e.preventDefault();
      focusCard(neighbour(map[k]));
      return;
    }
    if (k === "Enter" || k === " ") {
      const a = document.activeElement;
      if (a && a.tagName === "BUTTON" && root.contains(a)) return; // let the button click itself
      const c = cards()[focusIndex];
      if (c) {
        e.preventDefault();
        c._primary?.();
      }
    }
  }

  // merge the verified YouTube catalogue into the arrays we were given (once)
  let videosMerged = false;
  function loadVideos() {
    if (videosMerged || !videosUrl) return Promise.resolve();
    return fetchVideoCatalogue(videosUrl).then((data) => {
      videosMerged = true;
      mergeVideos(battles, extra, data);
    });
  }

  function openPicker() {
    if (!mounted) {
      document.body.appendChild(root);
      mounted = true;
    }
    render();
    const fresh = imageManifest() === null || !videosMerged;
    Promise.all([loadImageManifest(), loadVideos()]).then(() => {
      if (!open) return;
      // the manifest may name different files and the catalogue adds
      // YouTube buttons: rebuild once both are known
      if (fresh) {
        render();
        focusCard(focusIndex);
      }
      fillCredits();
    });
    root.classList.remove("hidden");
    if (!open) {
      open = true;
      lastFocus = document.activeElement;
      popKeys = pushKeyScope(onKey);
      try {
        document.exitPointerLock?.();
      } catch {
        /* ignore */
      }
    }
    focusCard(Math.min(focusIndex, cards().length - 1));
  }

  function close() {
    if (!open) return;
    open = false;
    root.classList.add("hidden");
    popKeys?.();
    popKeys = null;
    try {
      lastFocus?.focus?.();
    } catch {
      /* ignore */
    }
    onClose?.();
  }

  closeBtn.onclick = close;
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });

  return { open: openPicker, close, isOpen: () => open, element: root };
}
