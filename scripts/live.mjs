/**
 * Long-running live check.
 *
 * Opens the deployed museum in headless Chrome, joins a room and then samples
 * the connection, the game state and the render loop every couple of seconds.
 * It prints a timeline so intermittent stalls (dropped sockets, frozen loop,
 * failed re-joins) are visible.
 *
 *   node scripts/live.mjs [url] [seconds] [--crowd]
 *
 * --crowd additionally forces every visitor to re-path to the spot it is
 * already standing on, which is what used to make crowd.js throw "undefined
 * is not iterable" and freeze the render loop.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] || "https://dino-museum-ten.vercel.app/";
const duration = Number(process.argv[3] || 360) * 1000;
const crowdProbe = process.argv.includes("--crowd");
let exceptions = 0;

if (!existsSync(CHROME)) {
  console.error("✗ no Chrome found");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "dm-live-"));
const port = 9200 + Math.floor(Math.random() * 300);
const chrome = spawn(
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
    "--window-size=1024,640",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);
process.on("exit", () => {
  try {
    chrome.kill("SIGKILL");
  } catch {
    /* ignore */
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const log = (msg) => console.log(`${stamp()}s  ${msg}`);

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
    } catch {
      /* not up */
    }
    await sleep(250);
  }
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => (ws.onopen = res));

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
      return;
    }
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (m.params.type === "error" || /error|fail|lost|reconnect/i.test(text)) {
        log(`console[${m.params.type}] ${text}`);
      }
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      exceptions++;
      log(`EXCEPTION ${d.exception?.description || d.text}`);
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") {
      log(`net ${m.params.entry.text}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    return r?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url });

  for (let i = 0; i < 60; i++) {
    if (await ev("!!window.__museum")) break;
    await sleep(500);
  }
  log("page booted");

  await ev(`(() => {
    const n = document.getElementById('nameInput'); if (n) n.value = 'Watcher';
    const r = document.getElementById('roomInput'); if (r) r.value = 'LIVECHECK';
    document.getElementById('enterBtn')?.click();
    return 1;
  })()`);

  const probe = () => ev(`(() => {
    const m = window.__museum;
    if (!m) return JSON.stringify({ booted: false });
    const S = m.S;
    return JSON.stringify({
      joined: !!S.joined,
      net: S.net ? !!S.net.connected : null,
      sid: S.net ? S.net.id : null,
      x: S.player ? +S.player.state.x.toFixed(1) : null,
      z: S.player ? +S.player.state.z.toFixed(1) : null,
      remotes: m.remote ? m.remote.list.length : null,
      frame: m.renderer.info.render.frame,
      rooms: document.getElementById('roomCode')?.textContent || null,
    });
  })()`);

  if (crowdProbe) {
    for (let i = 0; i < 80; i++) {
      if (await ev("(window.__museum?.crowd?.npcs?.length || 0) > 0")) break;
      await sleep(500);
    }
    const wps = await ev(`(() => {
      const c = window.__museum?.crowd;
      const n = c?.npcs?.[0];
      return n ? c.nav.findPath(n.x, n.z, n.x, n.z).length : null;
    })()`);
    log(`crowd probe: findPath(self) -> ${wps} waypoints (empty is the trigger)`);
  }

  let prev = "";
  let lastBeat = 0;
  let lastFrame = 0;
  let frameStalls = 0;
  while (Date.now() - t0 < duration) {
    await sleep(2000);
    if (crowdProbe) {
      const forced = await ev(`(() => {
        const c = window.__museum?.crowd;
        if (!c || !c.npcs.length) return 0;
        let k = 0;
        for (const n of c.npcs) {
          // (a) path to the exact spot it already stands on: solvePath gets an
          //     empty waypoint list
          n.goal = { kind: "wander", x: n.x, z: n.z };
          c.requestPath(n);
          // (b) a waypoint index past the end of a path: the steer guard
          if (k % 2) { n.path = []; n.pathPending = false; n.wp = 0; }
          k++;
        }
        return k;
      })()`);
      if (!forced) log("crowd probe: no visitors to force");
    }
    const raw = await probe();
    const s = JSON.parse(raw);
    const { frame: _frame, ...rest } = s;
    const key = JSON.stringify(rest);
    if (key !== prev) {
      log(`state ${key}`);
      prev = key;
    }
    if (s.frame !== undefined) {
      if (s.frame === lastFrame && s.joined) {
        frameStalls++;
        log(`render loop frozen at frame ${s.frame} (x${frameStalls})`);
      } else {
        frameStalls = 0;
      }
      lastFrame = s.frame;
    }
    if (Date.now() - lastBeat > 60000) {
      lastBeat = Date.now();
      log(`heartbeat ${raw}`);
    }
  }
  const ambient = await ev("Array.from(window.__museum?.S?.ambientErrors || [])");
  if (ambient?.length) {
    log(`swallowed ambient failures: ${ambient.join(", ")}`);
    exceptions += ambient.length;
  }
  if (exceptions) {
    console.error(`✗ ${exceptions} page error(s) during the run`);
    process.exitCode = 1;
  } else {
    log("no page errors");
  }
  ws.close();
} catch (err) {
  log(`CRASH ${err.message}`);
  process.exit(1);
} finally {
  try {
    chrome.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}
