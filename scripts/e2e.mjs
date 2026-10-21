/**
 * End-to-end browser suite for the Dinosaur Museum.
 *
 *   npm run e2e                  # starts its own server (PORT 3214 or a free one)
 *   E2E_URL=http://host:port/ npm run e2e   # test an already running server
 *   E2E_ONLY=join,solo npm run e2e          # run a subset of scenarios
 *   E2E_OUT=/some/dir npm run e2e           # where screenshots go
 *   E2E_TIMEOUT / E2E_SCENARIO_TIMEOUT / E2E_CMD_TIMEOUT (ms)
 *       hard limits for the whole run (30 min), each scenario (8 min) and
 *       each DevTools command (2 min). Swiftshader is slow on a busy machine.
 *
 * Every check prints ✓ (pass), ✗ (fail) or – SKIP (feature not present yet).
 * Exit code is non-zero when any check failed. Chrome and the server are
 * always killed on the way out.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { launchBrowser, sleep, OUT_DIR, ensureDir } from "./lib/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ONLY = (process.env.E2E_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const GLOBAL_TIMEOUT = Number(process.env.E2E_TIMEOUT || 30 * 60 * 1000);
const SCENARIO_TIMEOUT = Number(process.env.E2E_SCENARIO_TIMEOUT || 8 * 60 * 1000);

/* ------------------------------------------------------------------ */
/* reporting                                                            */
/* ------------------------------------------------------------------ */
const results = { pass: 0, fail: 0, skip: 0, failures: [], skips: [] };
let currentScenario = "";

function pass(name, detail = "") {
  results.pass++;
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail = "") {
  results.fail++;
  results.failures.push(`[${currentScenario}] ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
}
function skip(name, reason) {
  results.skip++;
  results.skips.push(`[${currentScenario}] ${name} — ${reason}`);
  console.log(`  – SKIP ${name} — ${reason}`);
}
function check(name, ok, detail = "") {
  if (ok) pass(name, detail);
  else fail(name, detail);
  return ok;
}
function info(text) {
  console.log(`    · ${text}`);
}
const short = (list, n = 4) =>
  list.slice(0, n).map((s) => String(s).slice(0, 220)).join(" | ") +
  (list.length > n ? ` (+${list.length - n} more)` : "");

/* ------------------------------------------------------------------ */
/* server                                                               */
/* ------------------------------------------------------------------ */
let serverProc = null;
let browser = null;

function portFree(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}
function anyFreePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startServer() {
  const preferred = Number(process.env.E2E_PORT || 3214);
  const port = (await portFree(preferred)) ? preferred : await anyFreePort();
  serverProc = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  serverProc.stdout.on("data", (d) => (log += d));
  serverProc.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (serverProc.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return `${base}/`;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error(`server never answered /health:\n${log}`);
}

function cleanup() {
  try {
    browser?.kill();
  } catch {
    /* ignore */
  }
  if (serverProc && serverProc.exitCode === null) {
    try {
      process.kill(serverProc.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    cleanup();
    process.exit(130);
  });
}

/* ------------------------------------------------------------------ */
/* in-page helpers (installed into every page after load)               */
/* ------------------------------------------------------------------ */
const PAGE_HELPERS = `(() => {
  if (window.__e2e) return true;
  const visible = (el) => {
    if (!el) return false;
    if (el.classList && el.classList.contains("hidden")) return false;
    let n = el;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      if (n.classList && n.classList.contains("hidden")) return false;
      n = n.parentElement;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (el) => el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "");
  /* big fixed/absolute elements that cover most of the viewport = overlays */
  const overlays = () => {
    const out = [];
    for (const el of document.body.querySelectorAll("*")) {
      if (el.id === "scene" || el.tagName === "CANVAS" || el.id === "hud") continue;
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "absolute") continue;
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < innerWidth * innerHeight * 0.3) continue;
      out.push(describe(el));
    }
    return out;
  };
  const nearest = () => {
    const m = window.__museum;
    const p = m && m.player && m.player.state;
    if (!p) return null;
    let best = null, bestD = Infinity;
    for (const it of m.world.interactables || []) {
      const d = Math.hypot(it.x - p.x, it.z - p.z);
      if (d < (it.radius || 0) && d < bestD) { bestD = d; best = it; }
    }
    return best;
  };
  const raf = (n = 2) => new Promise((r) => { let k = n; const step = () => (--k <= 0 ? r(true) : requestAnimationFrame(step)); requestAnimationFrame(step); setTimeout(() => r(false), n * 4000); });
  window.__e2e = { visible, describe, overlays, nearest, raf, isVisible: (sel) => visible(document.querySelector(sel)) };
  return true;
})()`;

async function installHelpers(page) {
  await page.waitFor("document.readyState === 'complete' || document.readyState === 'interactive'", 15000);
  await page.evaluate(PAGE_HELPERS);
}

async function openMuseum(url, opts = {}) {
  const page = await browser.newPage(url, opts);
  await installHelpers(page);
  const booted = await page.waitFor("!!window.__museum", 30000, 250);
  return { page, booted: !!booted };
}

/** Join through the real form. Returns true when the HUD and avatar are up. */
async function joinGame(page, { name = "Tester", room = "", solo = false, timeout = 30000 } = {}) {
  await page.evaluate(`(() => {
    const n = document.getElementById('nameInput'); if (n) n.value = ${JSON.stringify(name)};
    const r = document.getElementById('roomInput'); if (r) r.value = ${JSON.stringify(room)};
    return true;
  })()`);
  const btn = solo ? "#soloBtn" : "#enterBtn";
  if (!(await page.exists(btn))) return false;
  await page.click(btn);
  return !!(await page.waitFor(
    "!!(window.__museum && window.__museum.player && window.__e2e.isVisible('#hud'))",
    timeout,
    250
  ));
}

async function closeEverything(page) {
  for (let i = 0; i < 3; i++) {
    const open = await page.tryEval(
      `["#modal", "#exhibitCard", "#iceCream"].some((s) => window.__e2e.isVisible(s)) || (window.__museum.S && document.activeElement && document.activeElement.id === "chatInput")`,
      false
    );
    if (!open) return;
    await page.press("Escape");
    await sleep(150);
  }
  await page.tryEval(`(() => { document.querySelectorAll('#modal,#exhibitCard,#iceCream').forEach((e) => e.classList.add('hidden')); return true; })()`);
}

/* ------------------------------------------------------------------ */
/* scenarios                                                            */
/* ------------------------------------------------------------------ */
const ctx = { url: "", pageA: null, pageB: null };

async function scenarioJoin() {
  const { page, booted } = await openMuseum(ctx.url, { width: 1280, height: 800, label: "join" });
  if (!check("client boots (window.__museum)", booted)) return;
  await sleep(1500);
  const mark0 = page.problems();
  check("join screen: no console errors / failed requests", mark0.length === 0, short(mark0));
  await page.screenshot("a-join-1280.png");

  // swatches
  const sw = await page.evaluate(`(() => {
    const boxes = [...document.querySelectorAll('#join .swatches')];
    const rows = boxes.map((box) => {
      const kids = [...box.children];
      const bad = kids.filter((b) => {
        if ((b.textContent || '').trim()) return false;
        const cs = getComputedStyle(b);
        const transparent = /rgba\\(0, 0, 0, 0\\)|transparent/.test(cs.backgroundColor) && cs.backgroundImage === 'none';
        return transparent;
      });
      return { id: box.id || '?', count: kids.length, transparent: bad.length, colourless: kids.filter((b) => !(b.textContent||'').trim()).length };
    });
    return rows;
  })()`);
  if (!sw.length) skip("customiser swatches", "no .swatches containers in #join");
  else {
    for (const r of sw) {
      if (!r.count) fail(`swatches #${r.id} render`, "container is empty");
      else check(`swatches #${r.id} have colours`, r.transparent === 0, `${r.transparent}/${r.count} swatches have a transparent background`);
    }
  }
  const objText = await page.evaluate(`(document.getElementById('join')?.innerText || '').includes('[object Object]') || [...document.querySelectorAll('#join [title], #join [aria-label]')].some((e) => /\\[object Object\\]/.test(e.title + e.getAttribute('aria-label')))`);
  check('no "[object Object]" in #join', !objText);

  // preview region
  const previewBox = await page.evaluate(`(() => {
    const el = document.querySelector('#lookPreview') || document.querySelector('#join .lookPreview canvas, #join canvas');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.max(1, Math.min(r.width, innerWidth)), height: Math.max(1, Math.min(r.height, innerHeight)) };
  })()`);
  /* capture the preview once it stops changing (the 3D preview renders slowly under swiftshader) */
  const snap = async () => {
    if (!previewBox) return null;
    let prev = await page.capture(previewBox);
    for (let i = 0; i < 12; i++) {
      await sleep(400);
      const cur = await page.capture(previewBox);
      if (cur === prev) return cur;
      prev = cur;
    }
    return prev;
  };

  // gender buttons
  /* swatch rows are re-rendered on every pick, so (re)tag the button right before each click */
  const tagGender = (which) =>
    page.evaluate(`(() => {
      const re = ${which === "male" ? "/^(?!fe).*\\bmale\\b/i" : "/female/i"};
      const b = [...document.querySelectorAll('#join button')].find((x) => re.test((x.textContent || '').trim()));
      if (!b) return null;
      b.dataset.e2eGender = ${JSON.stringify(which)};
      return '[data-e2e-gender="${which}"]';
    })()`);
  const gender = { male: await tagGender("male"), female: await tagGender("female") };
  const clickGender = async (which) => {
    const sel = await tagGender(which);
    return sel ? page.click(sel) : false;
  };
  if (!gender.male || !gender.female) skip("male/female buttons", "no buttons labelled Male/Female in #join");
  else if (!previewBox) skip("male/female change the preview", "no preview canvas");
  else {
    await clickGender("male");
    await sleep(700);
    const a = await snap();
    await clickGender("female");
    await sleep(700);
    const b = await snap();
    check("female button changes the preview", a !== b);
    await clickGender("male");
    await sleep(700);
    const c = await snap();
    check("male button changes the preview back", c !== b);
  }

  // random
  const randomSel = (await page.exists("#randomLook"))
    ? "#randomLook"
    : await page.evaluate(`(() => { const b = [...document.querySelectorAll('#join button')].find((x) => /random/i.test(x.textContent)); if (!b) return null; b.dataset.e2eRandom = '1'; return '[data-e2e-random="1"]'; })()`);
  if (!randomSel) skip("random look button", "not found");
  else if (!previewBox) skip("random look button", "no preview canvas");
  else {
    const before = await snap();
    let changed = false;
    for (let i = 0; i < 4 && !changed; i++) {
      await page.click(randomSel);
      await sleep(600);
      changed = (await snap()) !== before;
    }
    check("random button changes the preview", changed);
  }

  // layout
  for (const [w, h] of [
    [1280, 800],
    [390, 844],
  ]) {
    await page.setViewport(w, h);
    await sleep(600);
    const off = await page.evaluate(`(() => {
      const card = document.querySelector('#join .card');
      if (!card) return null;
      const bad = [];
      for (const el of [card, ...card.querySelectorAll('*')]) {
        if (!window.__e2e.visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.left < -1 || r.right > innerWidth + 1) bad.push(window.__e2e.describe(el) + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
      }
      return { bad, scrollW: document.documentElement.scrollWidth, w: innerWidth };
    })()`);
    if (!off) {
      skip(`join card fits ${w}x${h}`, "no #join .card");
      continue;
    }
    check(
      `join card fits horizontally at ${w}x${h}`,
      off.bad.length === 0 && off.scrollW <= off.w + 1,
      off.bad.length ? short(off.bad) : off.scrollW > off.w + 1 ? `page scrollWidth ${off.scrollW} > ${off.w}` : ""
    );
    await page.screenshot(`a-join-${w}x${h}.png`);
  }
  const late = page.problems().slice(mark0.length);
  check("join screen interactions: no console errors", late.length === 0, short(late));
  await page.close();
}

async function scenarioSolo() {
  const blockedUrls = ["*/socket.io/?*", "*/api/socket/*"];
  const { page, booted } = await openMuseum(ctx.url, {
    width: 1024,
    height: 640,
    label: "solo",
    blockedUrls,
  });
  if (!check("client boots with socket.io blocked", booted)) return;
  if (!(await page.exists("#soloBtn"))) {
    skip("explore alone", "no #soloBtn");
    return;
  }
  const t0 = Date.now();
  const ok = await joinGame(page, { name: "Solo", solo: true, timeout: 20000 });
  const status = await page.tryEval(`document.getElementById('joinStatus')?.textContent || ''`, "");
  check(
    "explore alone works without a server",
    ok,
    ok ? `${((Date.now() - t0) / 1000).toFixed(1)} s` : `HUD never showed; join status: "${status}"`
  );
  info(`${page.blocked.length} socket request(s) blocked, ${page.websockets.length} websocket(s) opened`);
  if (ok) {
    check("solo: player exists", !!(await page.tryEval("!!window.__museum.player")));
    await sleep(800);
    await page.screenshot("b-solo.png");
  }
  const errs = page.problems().filter((e) => !/socket\.io|websocket|api\/socket|ERR_BLOCKED/i.test(e));
  check("solo: no console errors (socket noise ignored)", errs.length === 0, short(errs));
  await page.close();
}

async function scenarioMultiplayer() {
  const room = "E2E" + Math.random().toString(36).slice(2, 6).toUpperCase();
  const A = await openMuseum(ctx.url, { width: 480, height: 300, label: "A" });
  const B = await openMuseum(ctx.url, { width: 480, height: 300, label: "B" });
  if (!check("both clients boot", A.booted && B.booted)) return;
  ctx.pageA = A.page;
  ctx.pageB = B.page;
  const a = A.page;
  const b = B.page;
  const joinedA = await joinGame(a, { name: "Alice", room });
  const joinedB = await joinGame(b, { name: "Bob", room });
  if (!check(`both join room ${room}`, joinedA && joinedB, `A=${joinedA} B=${joinedB}`)) return;
  const rooms = [await a.tryEval("window.__museum.S.room"), await b.tryEval("window.__museum.S.room")];
  check("both are in the same room", rooms[0] && rooms[0] === rooms[1], rooms.join(" / "));

  const t0 = Date.now();
  const seeExpr = "window.__museum.remote && window.__museum.remote.list.length >= 1";
  let seeA = await a.waitFor(seeExpr, 5000);
  let seeB = await b.waitFor(seeExpr, Math.max(500, 5000 - (Date.now() - t0)));
  const took = (Date.now() - t0) / 1000;
  if (!(seeA && seeB)) {
    seeA = seeA || (await a.waitFor(seeExpr, 10000));
    seeB = seeB || (await b.waitFor(seeExpr, 10000));
    fail("each sees the other within 5 s", seeA && seeB ? `only after ${((Date.now() - t0) / 1000).toFixed(1)} s` : `A sees B: ${!!seeA}, B sees A: ${!!seeB}`);
  } else pass("each sees the other within 5 s", `${took.toFixed(1)} s`);
  if (!(seeA && seeB)) return;

  const idA = await a.evaluate("window.__museum.S.myId");
  const idB = await b.evaluate("window.__museum.S.myId");
  const colA = await b.tryEval(`(() => { const r = window.__museum.remote.list.find((p) => p.id === ${JSON.stringify(idA)}); return r ? String(r.color) : null; })()`);
  const colB = await a.tryEval(`(() => { const r = window.__museum.remote.list.find((p) => p.id === ${JSON.stringify(idB)}); return r ? String(r.color) : null; })()`);
  check("visitors get distinct colours", colA && colB && colA.toLowerCase() !== colB.toLowerCase(), `A=${colA} B=${colB}`);

  // walking
  const posOfA = `(() => { const r = window.__museum.remote.list.find((p) => p.id === ${JSON.stringify(idA)}); return r ? { x: r.x, z: r.z } : null; })()`;
  await a.bringToFront();
  await sleep(500);
  const localBefore = await a.evaluate("({ x: window.__museum.player.state.x, z: window.__museum.player.state.z })");
  const remoteBefore = await b.evaluate(posOfA);
  await a.holdKey("KeyW", 1500);
  await sleep(400);
  const localAfter = await a.evaluate("({ x: window.__museum.player.state.x, z: window.__museum.player.state.z })");
  const localMoved = Math.hypot(localAfter.x - localBefore.x, localAfter.z - localBefore.z);
  let remoteMoved = 0;
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const p = await b.tryEval(posOfA);
    if (p && remoteBefore) remoteMoved = Math.hypot(p.x - remoteBefore.x, p.z - remoteBefore.z);
    if (remoteMoved > 1 || (localMoved < 1 && remoteMoved > localMoved * 0.8)) break;
    await sleep(250);
  }
  info(`A walked ${localMoved.toFixed(2)} m locally, B saw ${remoteMoved.toFixed(2)} m`);
  if (localMoved < 1) {
    fail("holding W for 1.5 s moves the avatar > 1 m", `only ${localMoved.toFixed(2)} m (slow renderer?)`);
    check("B sees A's movement", remoteMoved > localMoved * 0.8 && remoteMoved > 0.05, `${remoteMoved.toFixed(2)} m`);
  } else {
    check("walking on A moves A on B by > 1 m", remoteMoved > 1, `${remoteMoved.toFixed(2)} m`);
  }

  // chat
  const msg = `hello-e2e-${Math.random().toString(36).slice(2, 7)}`;
  if (!(await a.exists("#chatInput"))) skip("chat", "no #chatInput");
  else {
    await a.press("KeyT");
    const focused = await a.waitFor("document.activeElement && document.activeElement.id === 'chatInput'", 2000);
    check("T opens the chat input", !!focused);
    await a.type(focused ? null : "#chatInput", msg);
    await a.press("Enter");
    const seen = await b.waitFor(`(document.getElementById('chatLog')?.textContent || '').includes(${JSON.stringify(msg)})`, 5000);
    check("chat from A shows in B's #chatLog", !!seen);
  }

  // roar
  const m = a.mark();
  await a.press("KeyV");
  await sleep(800);
  const sawRoar = await b.waitFor(`(() => { const r = window.__museum.remote.list.find((p) => p.id === ${JSON.stringify(idA)}); return r && /roar/.test(JSON.stringify({ a: r.anim, b: r.action, c: r.character && r.character.action })); })()`, 2000);
  info(`B ${sawRoar ? "saw" : "did not observably see"} A's roar`);
  const errs = a.problems(m);
  check("roar (V) raises no errors", errs.length === 0, short(errs));
  await a.screenshot("c-multiplayer-A.png");
  await b.screenshot("c-multiplayer-B.png");

  const problemsB = b.problems();
  check("page B: no console errors", problemsB.length === 0, short(problemsB));
  /* B is no longer needed; closing it roughly halves the swiftshader load */
  await b.close();
  ctx.pageB = null;
}

/* teleport the local player close to an interactable so that it is the nearest one */
async function teleportTo(page, it) {
  const offsets = [[0, 0]];
  for (const r of [0.6, 1.2, 2, 3]) for (let k = 0; k < 8; k++) offsets.push([Math.cos((k * Math.PI) / 4) * r, Math.sin((k * Math.PI) / 4) * r]);
  for (const [dx, dz] of offsets) {
    const got = await page.evaluate(`(async () => {
      const p = window.__museum.player.state;
      p.x = ${it.x + dx}; p.z = ${it.z + dz}; p.y = 0; if ('vy' in p) p.vy = 0;
      await window.__e2e.raf(3);
      const n = window.__e2e.nearest();
      return n ? n.id + '|' + n.type : null;
    })()`);
    if (got && got.split("|")[0] === String(it.id)) return true;
  }
  return false;
}

const INTERACTION_TYPES = ["exhibit", "icecream", "battle", "seat", "era", "guide", "timeline", "photo", "dig", "puzzle", "exit"];

async function scenarioInteractions() {
  let page = ctx.pageA;
  if (!page) {
    const A = await openMuseum(ctx.url, { width: 1024, height: 640, label: "interact" });
    if (!A.booted || !(await joinGame(A.page, { name: "Explorer", room: "E2EINT" }))) {
      fail("could not join for interaction tests");
      return;
    }
    page = ctx.pageA = A.page;
  }
  await page.setViewport(800, 500);
  await page.bringToFront();
  await closeEverything(page);

  const list = await page.evaluate(`(window.__museum.world.interactables || []).map((it) => ({ id: String(it.id), type: it.type, x: it.x, z: it.z, radius: it.radius }))`);
  const types = [...new Set(list.map((i) => i.type))];
  info(`${list.length} interactables, types: ${types.join(", ")}`);
  const untyped = list.filter((i) => !i.type);
  if (untyped.length) fail("every interactable has a type", short(untyped.map((u) => u.id)));
  const unknown = types.filter((t) => t && !INTERACTION_TYPES.includes(t) && t !== "holo");
  if (unknown.length) info(`types not covered by this suite: ${unknown.join(", ")}`);

  for (const type of INTERACTION_TYPES) {
    const it = list.find((i) => i.type === type && Number.isFinite(i.x) && Number.isFinite(i.z));
    if (!it) {
      skip(`interact: ${type}`, "no interactable of this type");
      continue;
    }
    await closeEverything(page);
    const before = await page.evaluate("window.__e2e.overlays()");
    const reached = await teleportTo(page, it);
    if (!reached) {
      fail(`interact: ${type}: reach ${it.id}`, "another interactable is always nearer (overlapping radii)");
      continue;
    }
    const prompt = await page.waitFor("window.__e2e.isVisible('#prompt')", 3000);
    check(`interact: ${type}: prompt shows`, !!prompt, prompt ? `"${await page.tryEval("document.getElementById('prompt').textContent.trim()")}"` : "");
    const m = page.mark();
    const fossils0 = await page.tryEval("window.__museum.S.fossils", 0);
    await page.press("KeyE");
    await sleep(500);

    let opened = false;
    let closeSel = null;
    switch (type) {
      case "exhibit": {
        opened = !!(await page.waitFor("window.__e2e.isVisible('#exhibitCard')", 3000));
        check("exhibit: E opens #exhibitCard", opened);
        closeSel = "#exhibitCard";
        if (opened) {
          await exhibitExtras(page);
        }
        break;
      }
      case "icecream":
        opened = !!(await page.waitFor("window.__e2e.isVisible('#iceCream')", 3000));
        check("icecream: E opens #iceCream", opened);
        closeSel = "#iceCream";
        break;
      case "guide":
      case "timeline":
      case "puzzle":
      case "exit":
      case "photo":
        opened = !!(await page.waitFor("window.__e2e.isVisible('#modal')", 3000));
        check(`${type}: E opens #modal`, opened);
        closeSel = "#modal";
        break;
      case "dig": {
        const f = await page.waitFor(`window.__museum.S.fossils > ${fossils0}`, 2000);
        check("dig: E digs up a fossil (S.fossils++)", !!f);
        break;
      }
      case "seat": {
        const sat = await page.waitFor("window.__museum.player.isSitting === true || window.__museum.player.state.isSitting === true || window.__museum.player.state.sitting === true", 3000);
        const anim = await page.tryEval("window.__museum.player.state.anim");
        check("seat: E sits down", !!sat && anim === "sit", `isSitting=${!!sat} anim=${anim}`);
        await page.screenshot(`d-${type}.png`);
        await page.holdKey("KeyW", 400);
        await sleep(400);
        const stood = await page.tryEval("!(window.__museum.player.isSitting || window.__museum.player.state.isSitting || window.__museum.player.state.sitting)", false);
        check("seat: W stands up", stood);
        break;
      }
      case "battle": {
        const which = await page.waitFor(`(() => {
          if (window.__e2e.isVisible('#battleOverlay')) return '#battleOverlay';
          const el = [...document.querySelectorAll('[id*="attle"], [class*="attle"]')].find((e) => /pick|select|choose|menu|list/i.test(e.id + ' ' + e.className) && window.__e2e.visible(e));
          return el ? window.__e2e.describe(el) : null;
        })()`, 3000);
        opened = !!which;
        check("battle: E opens a battle picker or #battleOverlay", opened, which || "");
        closeSel = which;
        break;
      }
      case "era": {
        const after = await page.waitFor(`(() => { const before = ${JSON.stringify(before)}; const now = window.__e2e.overlays().filter((o) => !before.includes(o)); return now.length ? now : null; })()`, 3000);
        opened = !!after;
        check("era: E opens a full-screen overlay", opened, after ? after.join(",") : "");
        closeSel = after ? after[0] : null;
        break;
      }
      default:
        break;
    }
    if (type !== "seat") await page.screenshot(`d-${type}.png`);

    if (opened && closeSel) {
      await page.press("Escape");
      let closed = await page.waitFor(`!window.__e2e.isVisible(${JSON.stringify(closeSel)})`, 2000);
      if (!closed && type === "exhibit") {
        // an inner overlay (video etc.) may have eaten the first Escape
        await page.press("Escape");
        closed = await page.waitFor(`!window.__e2e.isVisible(${JSON.stringify(closeSel)})`, 2000);
      }
      check(`${type}: Escape closes ${closeSel}`, !!closed);
      if (!closed) {
        if (type === "battle") await page.click("#stopBattle");
        await closeEverything(page);
      }
    }
    if (type === "battle") {
      await page.tryEval("(() => { window.__museum.cinema && window.__museum.cinema.stop && window.__museum.cinema.stop(); document.getElementById('battleOverlay')?.classList.add('hidden'); return true; })()");
    }
    const errs = page.problems(m);
    check(`${type}: no console errors`, errs.length === 0, short(errs));
  }
}

async function exhibitExtras(page) {
  // hero image
  const hero = await page.waitFor(`(() => {
    const img = document.querySelector('#exhibitCard .exHero img, #exhibitCard img.exHero');
    if (!img) return { state: 'absent' };
    if (!img.complete) return null;
    return { state: img.naturalWidth > 0 ? 'loaded' : 'broken', src: img.currentSrc || img.src };
  })()`, 8000);
  if (!hero) fail("exhibit: hero image loads", "image never finished loading");
  else if (hero.state === "absent") skip("exhibit: hero image", "no .exHero image in the card (or removed after an error)");
  else check("exhibit: hero image loads (naturalWidth > 0)", hero.state === "loaded", hero.src);

  // videos button
  if (!(await page.exists("#exhibitVideos"))) {
    skip("exhibit: videos", "no #exhibitVideos button");
    return;
  }
  const before = await page.evaluate("window.__e2e.overlays()");
  await page.click("#exhibitVideos");
  const opened = await page.waitFor(`(() => { const before = ${JSON.stringify(before)}; const now = window.__e2e.overlays().filter((o) => !before.includes(o)); return now.length ? now : (document.querySelector('#exhibitCard iframe, #exhibitCard video') ? ['inline video'] : null); })()`, 4000);
  check("exhibit: #exhibitVideos opens a video overlay", !!opened, opened ? opened.join(",") : "");
  await page.screenshot("d-exhibit-videos.png");
  if (opened) {
    await page.press("Escape");
    await sleep(400);
  }
}

async function scenarioIceCream() {
  const page = ctx.pageA;
  if (!page) {
    skip("ice cream order", "no joined page (multiplayer scenario failed)");
    return;
  }
  await closeEverything(page);
  const it = await page.evaluate(`(() => { const i = (window.__museum.world.interactables || []).find((x) => x.type === 'icecream'); return i ? { id: String(i.id), x: i.x, z: i.z } : null; })()`);
  if (!it) {
    skip("ice cream order", "no icecream interactable");
    return;
  }
  const m = page.mark();
  if (!(await teleportTo(page, it))) {
    fail("ice cream: reach the stall");
    return;
  }
  await page.press("KeyE");
  if (!check("ice cream: menu opens", !!(await page.waitFor("window.__e2e.isVisible('#iceCream')", 3000)))) return;

  const picked = await page.evaluate(`(() => {
    const root = document.getElementById('iceCream');
    const flav = root.querySelectorAll('#flavourList button');
    if (flav[1]) flav[1].click();
    const tops = [...root.querySelectorAll('[data-topping], .topping, .toppings button, button')].filter((b) => !b.closest('#flavourList')).filter((b) => b.dataset.topping || /topping|sprinkle|choc|sauce|cherry|nut|fudge/i.test((b.className || '') + ' ' + b.textContent));
    const clicked = [];
    for (const b of tops.slice(0, 2)) { b.click(); clicked.push(b.textContent.trim()); }
    return clicked;
  })()`);
  if (picked.length) pass("ice cream: toppings available", picked.join(", "));
  else skip("ice cream: toppings", "no topping controls found");
  await sleep(300);
  const scoops0 = await page.evaluate("window.__museum.S.scoops");
  /* the avatar may be procedural (handAnchor) or a GLB rig with its own hand group: count nodes */
  await page.evaluate("(() => { let n = 0; window.__museum.player.character.group.traverse(() => n++); window.__e2eNodes = n; return n; })()");
  if (!(await page.exists("#orderBtn"))) {
    fail("ice cream: #orderBtn exists");
    return;
  }
  await page.click("#orderBtn");
  const inc = await page.waitFor(`window.__museum.S.scoops === ${scoops0 + 1}`, 3000);
  check("ice cream: S.scoops increments", !!inc, `before ${scoops0}`);
  const held = await page.waitFor(`(() => {
    const c = window.__museum.player.character;
    if (!c) return false;
    if (c.handAnchor && c.handAnchor.children.length) return 'handAnchor';
    let found = null;
    c.group.traverse((o) => { if (!found && /held|ice|cone|prop/i.test(o.name || '')) found = o.name; });
    if (found) return found;
    let n = 0; c.group.traverse(() => n++);
    return n > window.__e2eNodes ? '+' + (n - window.__e2eNodes) + ' nodes on the avatar' : false;
  })()`, 2000);
  check("ice cream: player holds the prop", !!held, held || "");
  check("ice cream: menu closes after ordering", !(await page.tryEval("window.__e2e.isVisible('#iceCream')", true)));
  await sleep(500);
  await page.screenshot("e-icecream.png");
  const errs = page.problems(m);
  check("ice cream: no console errors", errs.length === 0, short(errs));
}

async function scenarioLayout() {
  const page = ctx.pageA;
  if (!page) {
    skip("layout", "no joined page");
    return;
  }
  await closeEverything(page);
  await page.setViewport(1024, 640);
  const spawn = await page.evaluate("window.__museum.world.spawn && { x: window.__museum.world.spawn.x, z: window.__museum.world.spawn.z, ry: window.__museum.world.spawn.ry || 0 }");
  if (!spawn) {
    skip("layout", "world.spawn missing");
    return;
  }
  for (let k = 0; k < 4; k++) {
    await page.evaluate(`(async () => { const p = window.__museum.player.state; p.x = ${spawn.x}; p.z = ${spawn.z}; p.ry = ${spawn.ry + (k * Math.PI) / 2}; if ("camYaw" in p) p.camYaw = p.ry; p.pitch = -0.06; await window.__e2e.raf(8); return true; })()`);
    await sleep(300);
    const f = await page.screenshot(`f-spawn-view-${k * 90}.png`);
    info(`screenshot ${f}`);
  }
  const data = await page.tryEval(`(async () => {
    let mod;
    try { mod = await import('/js/world.js'); } catch (e) { return { error: String(e) }; }
    if (!Array.isArray(mod.ROOMS)) return { noRooms: true };
    const spawn = window.__museum.world.spawn;
    const room = (window.__museum.roomAt || mod.roomAt)(spawn.x, spawn.z);
    const court = mod.ROOMS.find((r) => r.id === 'court' || /ice ?cream/i.test(r.name || ''));
    if (!court || !room || !room.cols || !court.cols) return { spawnRoom: room && room.name, court: court && court.name, noGrid: true };
    const cells = (r) => { const out = []; for (let c = r.cols[0]; c <= r.cols[1]; c++) for (let w = r.rows[0]; w <= r.rows[1]; w++) out.push([c, w]); return out; };
    const courtSet = new Set(cells(court).map(([c, r]) => c + ',' + r));
    let touching = false;
    for (const [c, r] of cells(room)) for (const [dc, dr] of [[1,0],[-1,0],[0,1],[0,-1]]) if (courtSet.has((c+dc) + ',' + (r+dr))) touching = true;
    const icecream = (window.__museum.world.interactables || []).find((i) => i.type === 'icecream');
    const stallRoom = icecream ? (window.__museum.roomAt || mod.roomAt)(icecream.x, icecream.z) : null;
    return { spawnRoom: room.name, court: court.name, touching, stallRoom: stallRoom && stallRoom.name, dist: icecream ? Math.hypot(icecream.x - spawn.x, icecream.z - spawn.z) : null };
  })()`, null);
  if (!data || data.error || data.noRooms) {
    skip("ice cream court placement", data?.error || "world.js does not export ROOMS");
  } else if (data.noGrid) {
    skip("ice cream court placement", `spawn room ${data.spawnRoom}, court ${data.court} (no grid data)`);
  } else {
    info(`spawn room: ${data.spawnRoom}; ice cream stall in: ${data.stallRoom}; stall is ${data.dist?.toFixed(1)} m from spawn`);
    check("ice cream court is not adjacent to the spawn room", !data.touching, `${data.court} vs ${data.spawnRoom}`);
    check("ice cream stall stands inside the court", data.stallRoom === data.court, `stall in ${data.stallRoom}`);
  }
  const mini = await page.tryEval(`(() => {
    const c = document.getElementById('minimap');
    if (!c) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  })()`, null);
  if (mini === null) skip("minimap", "no 2d #minimap canvas");
  else check("minimap is painted", mini > 0, `${mini} px`);
}

async function scenarioPerf() {
  const page = ctx.pageA;
  if (!page) {
    skip("perf", "no joined page");
    return;
  }
  await closeEverything(page);
  await page.setViewport(1280, 800);
  await sleep(500);
  const r = await page.evaluate(`new Promise((resolve) => {
    let frames = 0; const t0 = performance.now();
    const step = () => { frames++; if (performance.now() - t0 < 5000) requestAnimationFrame(step); else done(); };
    const done = () => { const info = window.__museum.renderer.info; resolve({ fps: frames / ((performance.now() - t0) / 1000), tris: info.render.triangles, calls: info.render.calls, geos: info.memory.geometries, tex: info.memory.textures, progs: (info.programs || []).length }); };
    requestAnimationFrame(step);
  })`);
  check("perf: > 1 fps under swiftshader at 1280x800", r.fps > 1, `${r.fps.toFixed(1)} fps`);
  info(`last frame: ${r.tris} triangles, ${r.calls} draw calls; ${r.geos} geometries, ${r.tex} textures, ${r.progs} programs`);
}

async function scenarioResponsive() {
  const page = ctx.pageA;
  if (!page) {
    skip("responsive", "no joined page");
    return;
  }
  await closeEverything(page);
  for (const [w, h] of [
    [390, 844],
    [1920, 1080],
  ]) {
    await page.setViewport(w, h);
    await sleep(1200);
    await page.frames(3);
    await page.screenshot(`h-hud-${w}x${h}.png`);
    const bad = await page.evaluate(`(() => {
      const els = [...document.querySelectorAll('#hud .panel, #topleft, #topright, #bottomleft, #bottomright, #minimap, #playerList, #chatLog')];
      const out = [];
      for (const el of els) {
        if (!window.__e2e.visible(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.push(window.__e2e.describe(el) + ' [' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',') + ']');
      }
      return [...new Set(out)];
    })()`);
    check(`HUD panels inside the viewport at ${w}x${h}`, bad.length === 0, short(bad));
    const overlap = await page.evaluate(`(() => {
      const ids = ['topleft', 'topright', 'bottomleft', 'bottomright'];
      const rs = ids.map((id) => { const e = document.getElementById(id); return e && window.__e2e.visible(e) ? [id, e.getBoundingClientRect()] : null; }).filter(Boolean);
      const out = [];
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
        const [a, ra] = rs[i], [b, rb] = rs[j];
        const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (x > 4 && y > 4) out.push(a + '/' + b);
      }
      return out;
    })()`);
    check(`HUD corner panels don't overlap at ${w}x${h}`, overlap.length === 0, overlap.join(", "));
  }
  await page.setViewport(1024, 640);
}

async function finalErrors() {
  const page = ctx.pageA;
  if (!page) return;
  const all = page.problems();
  check("page A: no console errors over the whole run", all.length === 0, short(all, 6));
}

/* ------------------------------------------------------------------ */
/* runner                                                               */
/* ------------------------------------------------------------------ */
const SCENARIOS = [
  ["join", "a. Join screen", scenarioJoin],
  ["solo", "b. Solo (socket.io blocked)", scenarioSolo],
  ["multiplayer", "c. Multiplayer", scenarioMultiplayer],
  ["interactions", "d. Interactions", scenarioInteractions],
  ["icecream", "e. Ice cream order", scenarioIceCream],
  ["layout", "f. Layout", scenarioLayout],
  ["perf", "g. Perf smoke", scenarioPerf],
  ["responsive", "h. Responsive HUD", scenarioResponsive],
  ["errors", "z. Whole-run console errors", finalErrors],
];

async function main() {
  ensureDir(OUT_DIR);
  const watchdog = setTimeout(() => {
    console.error(`\n✗ e2e suite exceeded ${GLOBAL_TIMEOUT / 1000} s — aborting`);
    console.error(`${results.pass} passed, ${results.fail} failed, ${results.skip} skipped before the abort`);
    for (const f of results.failures) console.error(`  ✗ ${f}`);
    cleanup();
    process.exit(2);
  }, GLOBAL_TIMEOUT);
  watchdog.unref();

  ctx.url = process.env.E2E_URL || (await startServer());
  console.log(`Dinosaur Museum e2e — ${ctx.url}`);
  console.log(`screenshots → ${OUT_DIR}\n`);
  browser = await launchBrowser({ width: 1280, height: 800 });

  for (const [key, title, fn] of SCENARIOS) {
    if (ONLY.length && !ONLY.includes(key) && key !== "errors") continue;
    currentScenario = key;
    console.log(`\n${title}`);
    const t0 = Date.now();
    let timer;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`scenario timed out after ${SCENARIO_TIMEOUT / 1000} s`)),
            SCENARIO_TIMEOUT
          );
        }),
      ]);
    } catch (err) {
      const msg = String(err?.message || err);
      if (/timed out after/.test(msg)) {
        fail("scenario aborted: page unresponsive", `${msg} (main thread blocked — machine overloaded or a real hang; see screenshots)`);
      } else {
        fail("scenario crashed", err?.stack?.split("\n").slice(0, 3).join(" ") || msg);
      }
    } finally {
      clearTimeout(timer);
    }
    info(`${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  console.log(`\n${results.pass} passed, ${results.fail} failed, ${results.skip} skipped`);
  if (results.failures.length) {
    console.log("\nFailures:");
    for (const f of results.failures) console.log(`  ✗ ${f}`);
  }
  try {
    await browser.close();
  } catch {
    /* ignore */
  }
  cleanup();
  process.exit(results.fail ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n✗ e2e runner crashed: ${err?.stack || err}`);
  cleanup();
  process.exit(1);
});
