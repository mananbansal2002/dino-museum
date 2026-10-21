/**
 * Tiny Chrome DevTools Protocol toolkit shared by the browser tests.
 *
 * No dependencies: it launches the system Chrome headless (swiftshader WebGL),
 * talks CDP over the built-in WebSocket and exposes a small page API:
 *
 *   const browser = await launchBrowser();
 *   const page = await browser.newPage(url, { width: 1280, height: 800 });
 *   await page.waitFor("!!window.__museum");
 *   await page.press("KeyE");
 *   await page.screenshot("join.png");
 *   page.problems();   // console errors, exceptions, failed requests
 *   await browser.close();
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export const OUT_DIR =
  process.env.E2E_OUT ||
  "/private/tmp/claude-502/-Users-mananbansal-Desktop/93829f19-6399-4b12-a590-db4839bd6e62/scratchpad/e2e-out";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** mkdir -p, never throws for an existing directory. */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve a screenshot name against OUT_DIR and make sure its folder exists. */
export function outPath(name) {
  const full = isAbsolute(name) ? name : join(OUT_DIR, name);
  ensureDir(dirname(full));
  return full;
}

/* ------------------------------------------------------------------ */
/* keyboard                                                             */
/* ------------------------------------------------------------------ */
const SPECIAL_KEYS = {
  Enter: { key: "Enter", vk: 13, text: "\r" },
  Escape: { key: "Escape", vk: 27 },
  Space: { key: " ", vk: 32, text: " " },
  Tab: { key: "Tab", vk: 9 },
  Backspace: { key: "Backspace", vk: 8 },
  ShiftLeft: { key: "Shift", vk: 16, location: 1 },
  ShiftRight: { key: "Shift", vk: 16, location: 2 },
  ArrowUp: { key: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", vk: 39 },
};

/** Map a KeyboardEvent.code to the fields Input.dispatchKeyEvent needs. */
export function keyInfo(code) {
  if (SPECIAL_KEYS[code]) return { code, ...SPECIAL_KEYS[code] };
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return { code, key: m[1].toLowerCase(), vk: m[1].charCodeAt(0), text: m[1].toLowerCase() };
  m = /^Digit([0-9])$/.exec(code);
  if (m) return { code, key: m[1], vk: m[1].charCodeAt(0), text: m[1] };
  m = /^F([0-9]{1,2})$/.exec(code);
  if (m) return { code, key: code, vk: 111 + Number(m[1]) };
  return { code, key: code, vk: 0 };
}

/* ------------------------------------------------------------------ */
/* network noise filter                                                 */
/* ------------------------------------------------------------------ */
/** Requests we never treat as failures: favicons, data URLs and remote hosts. */
export function isIgnoredUrl(url = "") {
  if (!url) return true;
  if (/^(data|blob|about|chrome|devtools|chrome-extension):/i.test(url)) return true;
  if (/favicon/i.test(url)) return true;
  if (/youtube\.com|youtu\.be|ytimg\.com|googlevideo\.com|doubleclick|google/i.test(url)) return true;
  try {
    const u = new URL(url);
    if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(u.hostname)) return true;
  } catch {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* low level CDP connection                                             */
/* ------------------------------------------------------------------ */
class Connection {
  constructor(wsUrl, { commandTimeout = Number(process.env.E2E_CMD_TIMEOUT || 120000) } = {}) {
    this.wsUrl = wsUrl;
    this.commandTimeout = commandTimeout;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = () => reject(new Error(`could not open devtools socket ${this.wsUrl}`));
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer, method } = this.pending.get(msg.id);
        clearTimeout(timer);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else resolve(msg.result || {});
        return;
      }
      if (msg.method) for (const fn of this.listeners) fn(msg);
    };
    this.ws.onclose = () => {
      this.closed = true;
      for (const { reject, timer, method } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${method}: devtools socket closed`));
      }
      this.pending.clear();
    };
    return this;
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(method, params = {}, timeout = this.commandTimeout) {
    if (this.closed) return Promise.reject(new Error(`${method}: devtools socket closed`));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: timed out after ${timeout} ms`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* page                                                                 */
/* ------------------------------------------------------------------ */
class Page {
  constructor(browser, conn, targetId, label) {
    this.browser = browser;
    this.conn = conn;
    this.targetId = targetId;
    this.label = label;
    this.consoleErrors = [];
    this.exceptions = [];
    this.networkFailures = [];
    this.blocked = [];
    this.websockets = [];
    this.requests = new Map();
    this.width = 1280;
    this.height = 800;
    conn.on((msg) => this._onEvent(msg));
  }

  _onEvent({ method, params }) {
    switch (method) {
      case "Runtime.exceptionThrown": {
        const d = params.exceptionDetails || {};
        this.exceptions.push(d.exception?.description || d.text || "unknown exception");
        break;
      }
      case "Runtime.consoleAPICalled": {
        if (params.type !== "error" && params.type !== "assert") break;
        const text = (params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type || ""))
          .join(" ");
        this.consoleErrors.push(text);
        break;
      }
      case "Log.entryAdded": {
        const e = params.entry || {};
        if (e.level !== "error") break;
        // network failures are tracked (and filtered) through the Network domain
        if (e.source === "network") break;
        if (e.url && isIgnoredUrl(e.url)) break;
        this.consoleErrors.push(`${e.source}: ${e.text}${e.url ? ` (${e.url})` : ""}`);
        break;
      }
      case "Network.webSocketCreated":
        this.websockets.push(params.url || "");
        break;
      case "Network.requestWillBeSent":
        this.requests.set(params.requestId, params.request?.url || "");
        break;
      case "Network.responseReceived": {
        const r = params.response || {};
        if (r.status >= 400 && !isIgnoredUrl(r.url)) {
          this.networkFailures.push(`HTTP ${r.status} ${r.url}`);
        }
        break;
      }
      case "Network.loadingFailed": {
        const url = this.requests.get(params.requestId) || "";
        if (params.blockedReason) {
          this.blocked.push(url);
          break;
        }
        if (params.canceled) break;
        if (isIgnoredUrl(url)) break;
        this.networkFailures.push(`${params.errorText || "failed"} ${url}`);
        break;
      }
      default:
        break;
    }
  }

  /** Snapshot of all problems seen so far (optionally only those after a mark). */
  problems(mark) {
    const all = [
      ...this.exceptions.map((t) => `exception: ${t}`),
      ...this.consoleErrors.map((t) => `console: ${t}`),
      ...this.networkFailures.map((t) => `network: ${t}`),
    ];
    return mark ? all.slice(mark.count) : all;
  }

  /** A position in the problem list; pass it to problems() to see only new ones. */
  mark() {
    return { count: this.problems().length };
  }

  send(method, params, timeout) {
    return this.conn.send(method, params, timeout);
  }

  async init({ width = 1280, height = 800, blockedUrls } = {}) {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Log.enable");
    await this.send("Network.enable");
    if (blockedUrls?.length) await this.send("Network.setBlockedURLs", { urls: blockedUrls });
    await this.setViewport(width, height);
  }

  async setViewport(width, height) {
    this.width = width;
    this.height = height;
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    if (width < 600) {
      await this.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    }
  }

  async goto(url, { timeout = 30000 } = {}) {
    const loaded = new Promise((resolve) => {
      const off = this.conn.on((m) => {
        if (m.method === "Page.loadEventFired") {
          off();
          resolve(true);
        }
      });
      setTimeout(() => {
        off();
        resolve(false);
      }, timeout);
    });
    await this.send("Page.navigate", { url });
    return loaded;
  }

  async bringToFront() {
    await this.send("Page.bringToFront").catch(() => {});
  }

  /** Evaluate an expression in the page and return its JSON value. Throws on page exceptions. */
  async evaluate(expression, awaitPromise = true) {
    const res = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (res.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description || d.text || "evaluation failed");
    }
    return res.result?.value;
  }

  /** Like evaluate, but returns `fallback` instead of throwing. */
  async tryEval(expression, fallback = undefined) {
    try {
      return await this.evaluate(expression);
    } catch {
      return fallback;
    }
  }

  /** Poll a predicate expression until it is truthy. Returns the value or null on timeout. */
  async waitFor(predicateExpr, timeout = 10000, interval = 150) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = await this.tryEval(predicateExpr, null);
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(interval);
    }
  }

  /** Wait for `n` animation frames inside the page. */
  async frames(n = 2) {
    await this.tryEval(
      `new Promise((r) => { let k = ${n}; const step = () => (--k <= 0 ? r(true) : requestAnimationFrame(step)); requestAnimationFrame(step); setTimeout(() => r(false), ${n * 4000}); })`
    );
  }

  async exists(selector) {
    return !!(await this.tryEval(`!!document.querySelector(${JSON.stringify(selector)})`, false));
  }

  /** Real mouse click on the centre of the first element matching selector. */
  async click(selector) {
    const box = await this.tryEval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) return false;
    if (box.w < 1 || box.h < 1 || box.x < 0 || box.y < 0 || box.x > this.width || box.y > this.height) {
      return !!(await this.tryEval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el && el.click(); return !!el; })()`));
    }
    return this.clickAt(box.x, box.y);
  }

  async clickAt(x, y) {
    const base = { x, y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    return true;
  }

  /** Focus an element (if a selector is given) and insert text as if typed. */
  async type(selector, text) {
    if (selector) {
      const ok = await this.tryEval(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); return true; })()`,
        false
      );
      if (!ok) return false;
    }
    await this.send("Input.insertText", { text });
    return true;
  }

  async keyDown(code) {
    const k = keyInfo(code);
    await this.send("Input.dispatchKeyEvent", {
      type: k.text ? "keyDown" : "rawKeyDown",
      code: k.code,
      key: k.key,
      text: k.text,
      unmodifiedText: k.text,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
      location: k.location || 0,
    });
  }

  async keyUp(code) {
    const k = keyInfo(code);
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      code: k.code,
      key: k.key,
      windowsVirtualKeyCode: k.vk,
      nativeVirtualKeyCode: k.vk,
      location: k.location || 0,
    });
  }

  /** Tap a key (KeyboardEvent.code, e.g. "KeyE", "Enter", "Escape"). */
  async press(code, holdMs = 60) {
    await this.keyDown(code);
    await sleep(holdMs);
    await this.keyUp(code);
  }

  /** Hold a key down for `ms` milliseconds. */
  async holdKey(code, ms) {
    await this.keyDown(code);
    try {
      await sleep(ms);
    } finally {
      await this.keyUp(code);
    }
  }

  /** PNG screenshot; relative paths land in OUT_DIR. Optional clip {x,y,width,height}. */
  async screenshot(name, clip) {
    const params = { format: "png", captureBeyondViewport: false };
    if (clip) params.clip = { ...clip, scale: 1 };
    const pic = await this.send("Page.captureScreenshot", params, 60000);
    const file = outPath(name);
    writeFileSync(file, Buffer.from(pic.data, "base64"));
    return file;
  }

  /** Base64 PNG of a page region (for visual diffs). */
  async capture(clip) {
    const pic = await this.send(
      "Page.captureScreenshot",
      { format: "png", clip: { ...clip, scale: 1 } },
      60000
    );
    return pic.data;
  }

  async close() {
    try {
      await this.browser.browserConn.send("Target.closeTarget", { targetId: this.targetId }, 5000);
    } catch {
      /* ignore */
    }
    this.conn.close();
  }
}

/* ------------------------------------------------------------------ */
/* browser                                                              */
/* ------------------------------------------------------------------ */
export async function launchBrowser({ width = 1280, height = 800 } = {}) {
  if (!existsSync(CHROME)) throw new Error(`no Chrome found at ${CHROME}`);
  ensureDir(OUT_DIR);
  const profile = mkdtempSync(join(tmpdir(), "dm-e2e-"));
  const port = 9300 + Math.floor(Math.random() * 600);
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--enable-unsafe-swiftshader",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--hide-scrollbars",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion",
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try {
      process.kill(proc.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  process.on("exit", kill);

  let version = null;
  for (let i = 0; i < 80 && !version; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) version = await res.json();
    } catch {
      /* not up yet */
    }
    if (!version) await sleep(250);
  }
  if (!version) {
    kill();
    throw new Error("Chrome devtools never came up");
  }

  const browserConn = await new Connection(version.webSocketDebuggerUrl).open();
  const pages = [];
  let counter = 0;

  const browser = {
    port,
    pid: proc.pid,
    browserConn,
    pages,
    /**
     * Open a new page in its own browser context (isolated storage/cookies).
     * opts: { width, height, blockedUrls: ["*pattern*"], label, isolated }
     */
    async newPage(url = "about:blank", opts = {}) {
      const { width: w = width, height: h = height, label = `page${++counter}`, isolated = true } = opts;
      let browserContextId;
      if (isolated) {
        ({ browserContextId } = await browserConn.send("Target.createBrowserContext", {
          disposeOnDetach: true,
        }));
      }
      const { targetId } = await browserConn.send("Target.createTarget", {
        url: "about:blank",
        width: w,
        height: h,
        newWindow: true,
        background: false,
        ...(browserContextId ? { browserContextId } : {}),
      });
      const conn = await new Connection(
        `ws://127.0.0.1:${port}/devtools/page/${targetId}`
      ).open();
      const page = new Page(browser, conn, targetId, label);
      await page.init({ width: w, height: h, blockedUrls: opts.blockedUrls });
      if (url && url !== "about:blank") await page.goto(url);
      pages.push(page);
      return page;
    },
    async close() {
      for (const p of pages) p.conn.close();
      try {
        await browserConn.send("Browser.close", {}, 3000);
      } catch {
        /* ignore */
      }
      browserConn.close();
      kill();
    },
    kill,
  };
  return browser;
}
