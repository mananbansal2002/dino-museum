/**
 * YouTube video overlay.
 *
 *   const player = createVideoPlayer({ onClose });
 *   player.open({ id, title, channel });                 // one clip
 *   player.open(videos[0], videos);                      // with a playlist to switch between
 *   player.openSearch("Spinosaurus vs T. rex", "Spinosaurus vs T. rex");
 *   player.close(); player.isOpen();
 *
 * Uses the privacy-enhanced youtube-nocookie.com embed. The iframe is removed
 * on close so audio stops immediately. Styles live in /css/media.css.
 */

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/* ------------------------------------------------------------------ */
/* shared keyboard scope for the media overlays                         */
/* ------------------------------------------------------------------ */
// Overlays push a handler while open. Only the top-most one sees keys and
// nothing reaches the game (WASD / E / Space) while any overlay is open.
const keyScopes = [];
let keyListening = false;

function onKeyCapture(e) {
  if (!keyScopes.length) return;
  e.stopPropagation();
  if (e.type === "keydown") keyScopes[keyScopes.length - 1](e);
}

/** Push a keydown handler; returns a function that pops it. */
export function pushKeyScope(handler) {
  if (!keyListening) {
    window.addEventListener("keydown", onKeyCapture, true);
    window.addEventListener("keyup", onKeyCapture, true);
    keyListening = true;
  }
  keyScopes.push(handler);
  return () => {
    const i = keyScopes.lastIndexOf(handler);
    if (i >= 0) keyScopes.splice(i, 1);
  };
}

/** True while any media overlay (picker or player) is open. */
export function mediaOverlayOpen() {
  return keyScopes.length > 0;
}

export function isYouTubeId(id) {
  return typeof id === "string" && YT_ID.test(id);
}

export function youtubeSearchUrl(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(String(query || ""))}`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

export function createVideoPlayer({ onClose } = {}) {
  const root = el("div", "media-overlay vp-overlay hidden");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Video player");

  const box = el("div", "media-card vp-card");
  const head = el("div", "vp-head");
  const titles = el("div", "vp-titles");
  const titleEl = el("h2", "vp-title");
  const channelEl = el("div", "vp-channel");
  titles.append(titleEl, channelEl);
  const closeBtn = el("button", "media-close", "✕");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close video");
  head.append(titles, closeBtn);

  const frameWrap = el("div", "vp-frame");
  const searchPanel = el("div", "vp-search hidden");
  const footer = el("div", "vp-foot");
  const extLink = el("a", "vp-ext", "Open on YouTube ↗");
  extLink.target = "_blank";
  extLink.rel = "noopener noreferrer";
  footer.append(extLink);
  const list = el("div", "vp-list hidden");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "More videos");

  box.append(head, frameWrap, searchPanel, list, footer);
  root.append(box);

  let mounted = false;
  let open = false;
  let popKeys = null;
  let playlist = [];
  let currentId = null;
  let lastFocus = null;

  function mount() {
    if (mounted) return;
    document.body.appendChild(root);
    mounted = true;
  }

  function clearFrame() {
    frameWrap.replaceChildren();
    currentId = null;
  }

  function show() {
    mount();
    if (!open) {
      lastFocus = document.activeElement;
      open = true;
      popKeys = pushKeyScope(onKey);
      try {
        document.exitPointerLock?.();
      } catch {
        /* ignore */
      }
    }
    root.classList.remove("hidden");
  }

  function setCaption(title, channel) {
    titleEl.textContent = title || "Video";
    channelEl.textContent = channel ? `▶ ${channel}` : "";
    channelEl.classList.toggle("hidden", !channel);
  }

  function load(video) {
    if (!video || !isYouTubeId(video.id)) return false;
    clearFrame();
    const iframe = document.createElement("iframe");
    iframe.src = `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
    iframe.title = video.title || "YouTube video";
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.setAttribute("frameborder", "0");
    frameWrap.appendChild(iframe);
    currentId = video.id;
    setCaption(video.title, video.channel);
    extLink.href = `https://www.youtube.com/watch?v=${video.id}`;
    footer.classList.remove("hidden");
    for (const b of list.querySelectorAll(".vp-item")) {
      const on = b.dataset.id === video.id;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    }
    return true;
  }

  function renderList() {
    list.replaceChildren();
    const valid = playlist.filter((v) => isYouTubeId(v?.id));
    list.classList.toggle("hidden", valid.length < 2);
    if (valid.length < 2) return;
    valid.forEach((v, i) => {
      const b = el("button", "vp-item");
      b.type = "button";
      b.dataset.id = v.id;
      b.setAttribute("role", "option");
      const num = el("span", "vp-num", String(i + 1));
      const txt = el("span", "vp-item-text");
      txt.append(el("b", null, v.title || `Video ${i + 1}`));
      if (v.channel) txt.append(el("small", null, v.channel));
      b.append(num, txt);
      b.onclick = () => load(v);
      list.appendChild(b);
    });
  }

  /**
   * Play one video. Pass `videos` to show a list the visitor can switch
   * between (the first argument is the one that starts playing).
   */
  function openVideo(video, videos = null) {
    if (!video || !isYouTubeId(video.id)) {
      console.warn("video: not a YouTube id", video?.id);
      return false;
    }
    playlist = Array.isArray(videos) && videos.length ? videos : [video];
    searchPanel.classList.add("hidden");
    frameWrap.classList.remove("hidden");
    renderList();
    show();
    load(video);
    closeBtn.focus();
    return true;
  }

  /** No verified clip: offer a YouTube search in a new tab. */
  function openSearch(query, title) {
    clearFrame();
    playlist = [];
    renderList();
    frameWrap.classList.add("hidden");
    footer.classList.add("hidden");
    setCaption(title || query, "");
    searchPanel.replaceChildren();
    searchPanel.append(
      el("div", "vp-search-icon", "🔎"),
      el("p", null, "We don't have a verified clip for this one yet. Search YouTube for it instead:"),
      el("p", "vp-query", `“${query}”`)
    );
    const a = el("a", "media-btn primary", "Search on YouTube ↗");
    a.href = youtubeSearchUrl(query);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    searchPanel.append(a);
    searchPanel.classList.remove("hidden");
    show();
    a.focus();
    return true;
  }

  function close() {
    if (!open) return;
    open = false;
    clearFrame();
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

  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !list.classList.contains("hidden")) {
      const items = [...list.querySelectorAll(".vp-item")];
      if (!items.length) return;
      e.preventDefault();
      let i = items.indexOf(document.activeElement);
      if (i < 0) i = items.findIndex((b) => b.dataset.id === currentId);
      i = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[i].focus();
    }
  }

  closeBtn.onclick = close;
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });

  return {
    open: openVideo,
    openSearch,
    close,
    isOpen: () => open,
    get current() {
      return currentId;
    },
    element: root,
  };
}
