/**
 * Headless browser check.
 *
 * Opens the museum in headless Chrome over the DevTools protocol, collects
 * every console message and uncaught exception, waits for the first frame to
 * be painted and writes a screenshot so the render can be eyeballed.
 *
 *   node scripts/shot.mjs [url] [outfile]
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] || "http://127.0.0.1:3111/";
const out = process.argv[3] || "/tmp/opencode/shot.png";
const wait = Number(process.env.SHOT_WAIT || 6000);

if (!existsSync(CHROME)) {
  console.error("✗ no Chrome found at " + CHROME);
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "dm-chrome-"));
const port = 9300 + Math.floor(Math.random() * 400);
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
    "--window-size=1440,900",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" }
);

const cleanup = () => {
  try {
    chrome.kill("SIGKILL");
  } catch {
    /* ignore */
  }
};
process.on("exit", cleanup);

async function waitForDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("devtools never came up");
}

const messages = [];
const errors = [];

try {
  await waitForDevtools();
  const created = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
  }).then((r) => r.json());
  const ws = new WebSocket(created.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("could not open the devtools socket"));
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
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args || [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(" ");
      messages.push(`[${msg.params.type}] ${text}`);
      if (msg.params.type === "error") errors.push(text);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
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

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.navigate", { url });
  await new Promise((r) => setTimeout(r, wait));

  const info = await send("Runtime.evaluate", {
    expression: `JSON.stringify({
      title: document.title,
      canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height] : null; })(),
      loading: document.getElementById('loading')?.className || null,
      loadingText: document.getElementById('loadingText')?.textContent || null,
      joinVisible: !!document.getElementById('join'),
      gl: (() => { try { const c = document.createElement('canvas'); return c.getContext('webgl2') ? 'webgl2' : 'none'; } catch (e) { return 'error'; } })()
    })`,
    returnByValue: true,
  });
  console.log("  page:", info?.result?.value);

  /* if the client module did not run, ask the browser why */
  const probe = await send("Runtime.evaluate", {
    expression: `import('/js/main.js').then(() => 'module ok').catch((e) => 'module error: ' + (e && e.message ? e.message : String(e)))`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log("  module:", probe?.result?.value || probe?.exceptionDetails?.text);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (shot?.data) {
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    console.log(`  screenshot: ${out}`);
  }
  ws.close();
} catch (err) {
  errors.push(err.message);
} finally {
  cleanup();
}

if (messages.length) {
  console.log("\n  console:");
  for (const m of messages.slice(0, 40)) console.log("   ", m);
}
if (errors.length) {
  console.error("\n✗ the page reported errors:");
  for (const e of errors) console.error("   ", e);
  process.exit(1);
}
console.log("\n✓ the page loaded without errors");
