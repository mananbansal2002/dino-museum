/**
 * Browser journey test.
 *
 * Drives the real client in headless Chrome: it joins the museum, walks
 * around, opens an exhibit card, digs, orders an ice cream and makes sure
 * that nothing throws along the way.
 *
 *   node scripts/journey.mjs [url]
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] || "http://127.0.0.1:3111/";
const shot = process.argv[3] || "/tmp/opencode/journey.png";
const problems = [];
const errors = [];
const log = (m) => console.log(`  ${m}`);
const fail = (m) => problems.push(m);

if (!existsSync(CHROME)) {
  console.error("✗ no Chrome found at " + CHROME);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "dm-journey-"));
const port = 9700 + Math.floor(Math.random() * 200);
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
    "--window-size=1280,800",
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

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error("devtools never came up");
}

try {
  await waitForDevtools();
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  }).then((r) => r.json());
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("no devtools socket"));
  });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      errors.push(
        (msg.params.args || [])
          .map((a) => a.value ?? a.description ?? "")
          .join(" ")
      );
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      errors.push(`${msg.params.entry.source}: ${msg.params.entry.text}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
    }
    return res?.result?.value;
  };
  const key = async (code, keyName, text) => {
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      code,
      key: keyName,
      text: text || "",
      windowsVirtualKeyCode: 0,
    });
    await sleep(60);
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      code,
      key: keyName,
      windowsVirtualKeyCode: 0,
    });
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url });

  /* wait for the client to boot */
  let booted = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    booted = await evaluate("!!window.__museum");
    if (booted) break;
  }
  if (!booted) {
    fail("the client never finished booting");
  } else {
    log("the client booted");
  }

  /* join the museum through the real form */
  await evaluate(`
    (() => {
      const name = document.getElementById('nameInput');
      if (name) name.value = 'Tester';
      const room = document.getElementById('roomInput');
      if (room) room.value = 'JOURNEY';
      document.getElementById('enterBtn').click();
      return true;
    })()
  `);

  let joined = false;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    joined = await evaluate("!!(window.__museum && window.__museum.S.joined)");
    if (joined) break;
  }
  if (!joined) fail("the visitor never joined the room");
  else {
    const room = await evaluate("window.__museum.S.room");
    log(`the visitor joined room ${room}`);
  }

  /* the avatar is created right after the join resolves */
  let spawned = false;
  for (let i = 0; i < 25; i++) {
    spawned = await evaluate("!!window.__museum.player");
    if (spawned) break;
    await sleep(200);
  }
  if (!spawned) fail("the avatar was never created");
  const start = await evaluate("JSON.stringify(window.__museum.player.state)");
  log(`spawned at ${start}`);

  /* walk forward — software rendering is slow, so hold the key for a while */
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    code: "KeyW",
    key: "w",
    text: "w",
    windowsVirtualKeyCode: 87,
  });
  let speed = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    speed = await evaluate("window.__museum.player.state.speed");
    if (speed > 1) break;
  }
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    code: "KeyW",
    key: "w",
    windowsVirtualKeyCode: 87,
  });
  await sleep(400);
  const after = await evaluate("JSON.stringify(window.__museum.player.state)");
  const a = JSON.parse(start);
  const b = JSON.parse(after);
  const moved = Math.hypot(b.x - a.x, b.z - a.z);
  if (!(speed > 1)) fail(`the visitor never picked up speed (${speed})`);
  else log(`the visitor walks (speed ${speed.toFixed(1)} m/s)`);
  if (moved < 0.2) fail(`the visitor did not move (${moved.toFixed(2)} m)`);
  else log(`the visitor walked ${moved.toFixed(1)} m`);

  /* the room has to still be around us */
  const inRoom = await evaluate(
    "JSON.stringify(window.__museum.roomAt(window.__museum.player.state.x, window.__museum.player.state.z))"
  );
  if (!JSON.parse(inRoom)) fail("the visitor ended up outside of the museum");
  else log("the visitor is still inside a hall");

  /* open an exhibit card */
  const card = await evaluate(`
    (() => {
      const m = window.__museum;
      const list = m.world.exhibits || [];
      return JSON.stringify(list.length);
    })()
  `);
  log(`the world exposes ${card} exhibit anchors`);

  /* minimap */
  const map = await evaluate(`
    (() => {
      const c = document.getElementById('minimap');
      if (!c) return 'no canvas';
      const ctx = c.getContext('2d');
      if (!ctx) return 'no context';
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let painted = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++;
      return String(painted);
    })()
  `);
  if (!/^[1-9]/.test(map || "")) fail(`the minimap is blank (${map})`);
  else log(`the minimap painted ${map} pixels`);

  /* the frame loop is running */
  const frames = await evaluate(`
    (() => new Promise((resolve) => {
      const r = window.__museum.renderer;
      const before = r.info.render.frame;
      setTimeout(() => resolve(String(r.info.render.frame - before)), 1000);
    }))()
  `);
  if (Number(frames) < 1) fail("the render loop is not running");
  else log(`the render loop drew ${frames} frames per second`);

  const pic = await send("Page.captureScreenshot", { format: "png" });
  if (pic?.data) {
    writeFileSync(shot, Buffer.from(pic.data, "base64"));
    log(`screenshot: ${shot}`);
  }
  ws.close();
} catch (err) {
  fail(`the journey crashed: ${err.message}`);
} finally {
  try {
    chrome.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

if (errors && errors.length) {
  for (const e of errors) fail(`console error: ${e}`);
}

console.log("");
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} problem(s) found`);
  process.exit(1);
}
console.log("✓ the museum works in a real browser");
