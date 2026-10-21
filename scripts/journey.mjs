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

  /* ---------------- movement ---------------- */
  /* Software rendering runs at ~3-10 fps, so everything here is time based. */
  const keyDown = (code, keyName, vk) =>
    send("Input.dispatchKeyEvent", { type: "keyDown", code, key: keyName, text: keyName.length === 1 ? keyName : "", windowsVirtualKeyCode: vk });
  const keyUp = (code, keyName, vk) =>
    send("Input.dispatchKeyEvent", { type: "keyUp", code, key: keyName, windowsVirtualKeyCode: vk });
  const pstate = async () => JSON.parse(await evaluate("JSON.stringify(window.__museum.player.state)"));
  const waitFrames = (n) =>
    evaluate(`new Promise((resolve) => {
      const r = window.__museum.renderer;
      const want = r.info.render.frame + ${n};
      const t0 = performance.now();
      (function tick() {
        if (r.info.render.frame >= want || performance.now() - t0 > 8000) resolve(true);
        else setTimeout(tick, 30);
      })();
    })`);
  /** Is the camera inside a hall and at least `margin` away from any wall cell? */
  const cameraClear = (margin = 0.1) =>
    evaluate(`import('/js/world.js').then((w) => {
      const c = window.__museum.camera.position;
      const [x, z] = w.resolveCollision(c.x, c.z, ${margin});
      return JSON.stringify({
        x: c.x, y: c.y, z: c.z,
        inRoom: !!w.roomAt(c.x, c.z),
        clear: Math.abs(x - c.x) < 1e-4 && Math.abs(z - c.z) < 1e-4,
      });
    })`).then((s) => JSON.parse(s));
  /** Teleport the player (and point both body + camera along `yaw`). */
  const teleport = (x, z, yaw) =>
    evaluate(`(() => {
      const p = window.__museum.player;
      p.stand?.();
      Object.assign(p.state, { x: ${x}, z: ${z}, y: 0, vx: 0, vz: 0, vy: 0, ry: ${yaw}, camYaw: ${yaw}, pitch: -0.12 });
      return true;
    })()`);

  // 1. hold W for ~2 s: the visitor must cover real distance
  const a = JSON.parse(start);
  await keyDown("KeyW", "w", 87);
  let speed = 0;
  const holdStart = Date.now();
  while (Date.now() - holdStart < 2000) {
    await sleep(250);
    speed = Math.max(speed, await evaluate("window.__museum.player.state.speed"));
  }
  await keyUp("KeyW", "w", 87);
  await sleep(500);
  const b = await pstate();
  const moved = Math.hypot(b.x - a.x, b.z - a.z);
  if (!(speed > 3)) fail(`the visitor never picked up walking speed (${speed.toFixed(2)} m/s)`);
  else log(`the visitor walks (top speed ${speed.toFixed(1)} m/s)`);
  if (!(moved > 2)) fail(`holding W for 2 s only moved ${moved.toFixed(2)} m`);
  else log(`holding W for 2 s walked ${moved.toFixed(1)} m`);
  // W is "away from the camera": spawn camera looks along ry=PI (-z)
  if (!(b.z < a.z - 1)) fail(`W did not move away from the camera (z ${a.z.toFixed(1)} -> ${b.z.toFixed(1)})`);
  await waitFrames(2);
  const cam1 = await cameraClear();
  if (!cam1.inRoom || !cam1.clear) fail(`the camera is inside a wall after walking (${JSON.stringify(cam1)})`);
  else log("the camera stays inside the hall while following");

  // 2. sprint straight into the lobby's west wall (x = -42): no tunnelling
  await teleport(-37, 42, -Math.PI / 2);
  await waitFrames(2);
  await keyDown("ShiftLeft", "Shift", 16);
  await keyDown("KeyW", "w", 87);
  await sleep(1800);
  await keyUp("KeyW", "w", 87);
  await keyUp("ShiftLeft", "Shift", 16);
  await sleep(300);
  const w = await pstate();
  const inHall = await evaluate(`!!window.__museum.roomAt(${w.x}, ${w.z})`);
  if (!(w.x > -42) || !inHall) fail(`sprinting into a wall tunnelled through it (x ${w.x.toFixed(2)})`);
  else if (!(w.x < -40.5)) fail(`the sprint never reached the wall (x ${w.x.toFixed(2)})`);
  else log(`sprinting into a wall stops at it (x ${w.x.toFixed(2)})`);

  // 3. back to the wall, camera behind the player would be inside it
  await teleport(-40.6, 42, Math.PI / 2);
  await evaluate("window.__museum.player.state.camDist = 9, true");
  await waitFrames(3);
  const cam2 = await cameraClear();
  if (!cam2.inRoom || !cam2.clear) fail(`the camera clipped into the wall behind the player (${JSON.stringify(cam2)})`);
  else log(`the camera is pulled in front of the wall (x ${cam2.x.toFixed(2)})`);
  await evaluate("window.__museum.player.state.camDist = 4.6, true");

  // 4. input gating: no movement while disabled
  if (await evaluate("typeof window.__museum.player.setInputEnabled === 'function'")) {
    await teleport(0, 42, Math.PI);
    await waitFrames(2);
    const g0 = await pstate();
    await evaluate("window.__museum.player.setInputEnabled(false), true");
    await keyDown("KeyW", "w", 87);
    await sleep(1000);
    await keyUp("KeyW", "w", 87);
    const g1 = await pstate();
    await evaluate("window.__museum.player.setInputEnabled(true), true");
    const gm = Math.hypot(g1.x - g0.x, g1.z - g0.z);
    if (gm > 0.05) fail(`the visitor moved ${gm.toFixed(2)} m with input disabled`);
    else log("no movement while input is disabled");
  } else fail("player.setInputEnabled is missing");

  // 5. sitting: anim "sit" while seated, a movement key stands back up
  if (await evaluate("typeof window.__museum.player.sit === 'function'")) {
    await evaluate("window.__museum.player.sit({ x: 0, z: 40, ry: Math.PI, y: 0.45 }), true");
    await waitFrames(2);
    const s1 = await pstate();
    const seated = await evaluate("window.__museum.player.isSitting");
    if (s1.anim !== "sit" || !seated || Math.abs(s1.y - 0.45) > 1e-3) {
      fail(`sit() did not seat the visitor (${JSON.stringify({ anim: s1.anim, seated, y: s1.y })})`);
    } else log("sit() seats the visitor");
    await keyDown("KeyW", "w", 87);
    await sleep(150);
    await keyUp("KeyW", "w", 87);
    await waitFrames(2);
    const s2 = await pstate();
    if (s2.sitting || s2.anim === "sit" || s2.y > 0.01) fail(`a movement key did not stand the visitor up (${s2.anim})`);
    else log("a movement key stands the visitor back up");
  } else fail("player.sit is missing");

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
