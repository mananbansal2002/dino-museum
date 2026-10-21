/**
 * End-to-end smoke test.
 *
 * Boots the real museum server, connects two visitors to the same room and
 * checks that joining, the roster, movement, chat, actions and leaving all
 * travel over the wire.
 *
 *   node scripts/smoke.mjs
 */

import { createMuseumServer } from "../src/museum-server.js";
import { io as ioClient } from "socket.io-client";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const log = (msg) => console.log(`  ${msg}`);
const fail = (msg) => problems.push(msg);

function waitFor(socket, event, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeout);
    function onEvent(payload) {
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }
    socket.on(event, onEvent);
  });
}

function connect(url) {
  const socket = ioClient(url, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("could not connect")), 5000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const { server } = createMuseumServer({ staticDir: join(root, "public") });

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}`;

try {
  /* ---- static site ---- */
  const health = await fetch(`${url}/health`).then((r) => r.json());
  if (!health.ok) fail("the health endpoint did not report ok");
  else log(`health endpoint ok (rooms=${health.rooms})`);

  const page = await fetch(`${url}/`).then((r) => r.text());
  if (!page.includes("Dinosaur Museum")) fail("index.html was not served");
  else log("index.html is served");

  const appJs = await fetch(`${url}/js/main.js`);
  if (!appJs.ok) fail("the client bundle was not served");
  else log("client javascript is served");

  const three = await fetch(`${url}/vendor/three/three.module.js`);
  if (!three.ok) fail("the vendored three.js build is missing");
  else log("three.js is served");

  /* ---- two visitors in one room ---- */
  const alice = await connect(url);
  const bob = await connect(url);

  const aliceJoin = await new Promise((resolve) =>
    alice.emit("join", { name: "Alice", color: 0xffc857, look: { hat: 1 }, room: "SMOKE" }, resolve)
  );

  /* Bob's arrival has to reach Alice */
  const joinedPromise = waitFor(alice, "playerJoined");

  const bobJoin = await new Promise((resolve) =>
    bob.emit("join", { name: "Bob", color: 0x4fc3f7, look: { hat: 2 }, room: "SMOKE" }, resolve)
  );

  if (!aliceJoin.room || aliceJoin.room !== bobJoin.room) {
    fail(`the two visitors ended up in different rooms (${aliceJoin.room} / ${bobJoin.room})`);
  } else {
    log(`both visitors joined room ${aliceJoin.room}`);
  }
  if (aliceJoin.id === bobJoin.id) fail("the two visitors share a socket id");
  if (!Array.isArray(aliceJoin.players) || aliceJoin.players.length < 1) {
    fail("the join reply did not contain a roster");
  }

  /* Bob's arrival has to reach Alice */
  const joined = await joinedPromise;
  if (joined.name !== "Bob") fail(`unexpected playerJoined payload: ${JSON.stringify(joined)}`);
  else log("playerJoined is broadcast");

  /* movement */
  const moved = waitFor(bob, "state");
  alice.emit("state", { x: 1, y: 0, z: 2, ry: 0.5, anim: "walk" });
  const state = await moved;
  if (state.x !== 1 || state.z !== 2 || state.anim !== "walk") {
    fail(`the movement state was relayed incorrectly: ${JSON.stringify(state)}`);
  } else {
    log("movement state is relayed");
  }

  /* chat */
  const chatted = waitFor(bob, "chat");
  alice.emit("chat", "hello from Alice");
  const chat = await chatted;
  if (chat.text !== "hello from Alice" || chat.name !== "Alice") {
    fail(`the chat message was relayed incorrectly: ${JSON.stringify(chat)}`);
  } else {
    log("chat is relayed");
  }

  /* actions (ice cream, score) */
  const actioned = waitFor(bob, "action");
  alice.emit("action", { type: "iceCream", payload: { flavour: "Dino Dust" } });
  const action = await actioned;
  if (action.type !== "iceCream") {
    fail(`the action was relayed incorrectly: ${JSON.stringify(action)}`);
  } else {
    log("actions are relayed");
  }

  /* leaving */
  const left = waitFor(alice, "playerLeft");
  bob.disconnect();
  const gone = await left;
  if (gone.id !== bobJoin.id) fail("playerLeft carried the wrong id");
  else log("playerLeft is broadcast");

  alice.disconnect();
} catch (err) {
  fail(`the smoke test crashed: ${err.message}`);
} finally {
  server.close();
}

console.log("");
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} problem(s) found`);
  process.exit(1);
}
console.log("✓ the museum server works end to end");
