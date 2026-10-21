/**
 * End-to-end smoke test.
 *
 * Boots the real museum server, connects visitors and checks that joining,
 * the roster, movement, chat, actions, looks, validation, rate limits,
 * re-joining, room cleanup and the browser transport (public/js/net.js,
 * including path fallback and automatic re-join) all work over the wire.
 *
 *   node scripts/smoke.mjs
 */

import { createMuseumServer } from "../src/museum-server.js";
import { io as ioClient } from "socket.io-client";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join as joinPath } from "node:path";

const root = joinPath(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const log = (msg) => console.log(`  ${msg}`);
const fail = (msg) => problems.push(msg);
const check = (ok, good, bad) => (ok ? log(good) : fail(bad));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitFor(socket, event, timeout = 4000, filter = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeout);
    function onEvent(payload) {
      if (!filter(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }
    socket.on(event, onEvent);
  });
}

/** Collect every `event` received during `ms`. */
async function collect(socket, event, ms) {
  const got = [];
  const on = (p) => got.push(p);
  socket.on(event, on);
  await sleep(ms);
  socket.off(event, on);
  return got;
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

const join = (socket, opts) => new Promise((resolve) => socket.emit("join", opts, resolve));

const { server, io: serverIo } = createMuseumServer({ staticDir: joinPath(root, "public") });

await new Promise((resolve) => server.listen(0, resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}`;
const health = () => fetch(`${url}/health`).then((r) => r.json());
const open = [];

try {
  /* ---- static site ---- */
  const h0 = await health();
  check(h0.ok, `health endpoint ok (rooms=${h0.rooms})`, "the health endpoint did not report ok");

  const page = await fetch(`${url}/`).then((r) => r.text());
  check(page.includes("Dinosaur Museum"), "index.html is served", "index.html was not served");

  const appJs = await fetch(`${url}/js/main.js`);
  check(appJs.ok, "client javascript is served", "the client bundle was not served");

  const three = await fetch(`${url}/vendor/three/three.module.js`);
  check(three.ok, "three.js is served", "the vendored three.js build is missing");

  /* ---- two visitors in one room ---- */
  const alice = await connect(url);
  const bob = await connect(url);
  open.push(alice, bob);

  const aliceLook = {
    body: "female",
    skin: "#E6B48F",
    shirt: "#2ec4b6",
    hair: "h2",
    hairColor: "red", // invalid colour, dropped
    accessory: "a1",
    evil: "<script>", // unknown key, dropped
  };
  const aliceJoin = await join(alice, { name: "  Alice \n ", color: 0xffc857, look: aliceLook, room: "smoke" });
  check(
    aliceJoin.room === "SMOKE",
    "room codes are normalised",
    `unexpected room in ack: ${aliceJoin.room}`
  );
  check(
    /^#[0-9a-f]{6}$/.test(aliceJoin.color),
    `join ack carries a colour (${aliceJoin.color})`,
    `join ack colour is not #rrggbb: ${aliceJoin.color}`
  );
  const meInRoster = aliceJoin.players.find((p) => p.id === aliceJoin.id);
  check(
    meInRoster &&
      meInRoster.name === "Alice" &&
      JSON.stringify(meInRoster.look) ===
        JSON.stringify({ skin: "#e6b48f", shirt: "#2ec4b6", hair: "h2", accessory: "a1", body: "female" }),
    "name trimmed and look sanitised on join",
    `look/name not sanitised: ${JSON.stringify(meInRoster)}`
  );

  // Alice moves before Bob arrives: Bob's roster must place her correctly.
  alice.emit("state", { x: 12, y: 0, z: -7, ry: 1, anim: "walk" });
  await sleep(80);

  const joinedPromise = waitFor(alice, "playerJoined");
  const bobJoin = await join(bob, { name: "Bob", color: 0xffc857, look: { body: "male" }, room: "SMOKE" });

  check(
    aliceJoin.room === bobJoin.room,
    `both visitors joined room ${aliceJoin.room}`,
    `the two visitors ended up in different rooms (${aliceJoin.room} / ${bobJoin.room})`
  );
  if (aliceJoin.id === bobJoin.id) fail("the two visitors share a socket id");
  check(
    bobJoin.color !== aliceJoin.color,
    `players get distinct colours (${aliceJoin.color} / ${bobJoin.color})`,
    "both players got the same colour"
  );
  const aliceSeen = bobJoin.players.find((p) => p.id === aliceJoin.id);
  check(
    aliceSeen && aliceSeen.x === 12 && aliceSeen.z === -7 && aliceSeen.anim === "walk" && aliceSeen.color === aliceJoin.color,
    "roster includes last position and colour of existing players",
    `roster entry for Alice is wrong: ${JSON.stringify(aliceSeen)}`
  );

  const joined = await joinedPromise;
  check(
    joined.name === "Bob" && joined.color === bobJoin.color,
    "playerJoined is broadcast with colour",
    `unexpected playerJoined payload: ${JSON.stringify(joined)}`
  );

  /* ---- more colours stay unique ---- */
  const extra = [];
  for (let i = 0; i < 4; i++) extra.push(await connect(url));
  open.push(...extra);
  const colours = new Set([aliceJoin.color, bobJoin.color]);
  for (const [i, s] of extra.entries()) colours.add((await join(s, { name: `Extra${i}`, room: "SMOKE" })).color);
  check(colours.size === 6, "six players get six distinct colours", `colours collided: ${[...colours]}`);
  for (const s of extra) s.disconnect();
  await sleep(100);

  /* ---- movement ---- */
  let moved = waitFor(bob, "state");
  alice.emit("state", { x: 1, y: 0, z: 2, ry: 0.5, anim: "walk" });
  let state = await moved;
  check(
    state.x === 1 && state.z === 2 && state.anim === "walk" && state.id === aliceJoin.id,
    "movement state is relayed",
    `the movement state was relayed incorrectly: ${JSON.stringify(state)}`
  );

  /* invalid state: non-finite dropped, out-of-bounds clamped, bad anim -> idle */
  const bad = collect(bob, "state", 300);
  alice.emit("state", { x: NaN, y: 0, z: 0, ry: 0, anim: "walk" });
  alice.emit("state", { x: "Infinity", y: 0, z: 0, ry: 0 });
  alice.emit("state", null);
  const badGot = await bad;
  check(badGot.length === 0, "non-finite state is rejected", `non-finite state relayed: ${JSON.stringify(badGot)}`);

  moved = waitFor(bob, "state");
  alice.emit("state", { x: 5000, y: -3, z: -5000, ry: 0, anim: "moonwalk" });
  state = await moved;
  check(
    state.x === 100 && state.y === 0 && state.z === -95 && state.anim === "idle",
    "out-of-bounds state is clamped and anim whitelisted",
    `state not clamped: ${JSON.stringify(state)}`
  );

  /* ---- chat (echoed to sender too) ---- */
  const chatted = waitFor(bob, "chat");
  const echoed = waitFor(alice, "chat");
  alice.emit("chat", "hello from Alice");
  const [chat, echo] = await Promise.all([chatted, echoed]);
  check(
    chat.text === "hello from Alice" && chat.name === "Alice",
    "chat is relayed",
    `the chat message was relayed incorrectly: ${JSON.stringify(chat)}`
  );
  check(echo.text === "hello from Alice", "chat is echoed to the sender", "chat was not echoed to the sender");

  /* ---- actions (relayed, not echoed, whitelisted) ---- */
  const selfActions = collect(alice, "action", 400);
  const actioned = waitFor(bob, "action");
  alice.emit("action", { type: "iceCream", payload: { flavour: "Dino Dust" } });
  const action = await actioned;
  check(
    action.type === "iceCream" && action.payload?.flavour === "Dino Dust",
    "actions are relayed",
    `the action was relayed incorrectly: ${JSON.stringify(action)}`
  );
  const rejected = collect(bob, "action", 300);
  alice.emit("action", { type: "explode", payload: {} });
  alice.emit("action", { type: "photo", payload: { junk: "x".repeat(2000) } });
  check((await selfActions).length === 0, "actions are not echoed to the sender", "the sender got its own action back");
  check((await rejected).length === 0, "unknown / oversized actions are dropped", "an invalid action was relayed");

  /* ---- look updates ---- */
  const looked = waitFor(bob, "look");
  alice.emit("look", { body: "robot", shirt: "#ABCDEF", hair: "x".repeat(40), accessory: "a5" });
  const look = await looked;
  check(
    look.id === aliceJoin.id && JSON.stringify(look.look) === JSON.stringify({ shirt: "#abcdef", accessory: "a5" }),
    "look event is sanitised and relayed",
    `look relayed incorrectly: ${JSON.stringify(look)}`
  );

  /* ---- rate limits ---- */
  await sleep(5100); // let the earlier chat fall out of the window
  const burst = collect(bob, "chat", 500);
  const limitedNotice = waitFor(alice, "rateLimited", 1000);
  for (let i = 0; i < 8; i++) alice.emit("chat", `spam ${i}`);
  const burstGot = (await burst).filter((c) => c.text.startsWith("spam"));
  const notice = await limitedNotice.catch(() => null);
  check(
    burstGot.length === 5 && notice?.type === "chat",
    "chat is rate limited (5 per 5 s)",
    `chat rate limit not applied: ${burstGot.length} relayed, notice=${JSON.stringify(notice)}`
  );

  await sleep(1100);
  const stateBurst = collect(bob, "state", 600);
  for (let i = 0; i < 60; i++) alice.emit("state", { x: i, y: 0, z: 0, ry: 0, anim: "run" });
  const sb = (await stateBurst).length;
  check(sb <= 30 && sb > 0, `state is rate limited (${sb}/60 relayed)`, `state rate limit not applied (${sb}/60)`);

  /* ---- re-join on the same socket moves rooms ---- */
  const leftOld = waitFor(bob, "playerLeft");
  const aliceAgain = await join(alice, { name: "Alice", room: "OTHER" });
  const leftMsg = await leftOld;
  check(
    aliceAgain.room === "OTHER" && leftMsg.id === aliceJoin.id,
    "re-joining leaves the previous room",
    `rejoin failed: room=${aliceAgain.room} left=${JSON.stringify(leftMsg)}`
  );
  const strayChat = collect(bob, "chat", 300);
  alice.emit("chat", "am I still in SMOKE?");
  check((await strayChat).length === 0, "re-joined socket no longer receives/sends in the old room", "old room still got messages");
  const hRooms = await health();
  check(hRooms.rooms === 2, `two rooms live after rejoin (rooms=${hRooms.rooms})`, `expected 2 rooms, got ${hRooms.rooms}`);

  /* ---- leaving + empty room cleanup ---- */
  const left = waitFor(alice, "playerLeft", 1500).catch(() => null);
  bob.disconnect();
  await sleep(150);
  check((await health()).rooms === 1, "empty room is deleted", "empty room was not deleted");
  const gone = await left;
  check(gone === null, "players in other rooms are not told about leaves", "playerLeft leaked across rooms");
  alice.disconnect();
  await sleep(150);
  const hEnd = await health();
  check(hEnd.rooms === 0, "all rooms are deleted once everyone leaves", `rooms leaked: ${hEnd.rooms}`);

  /* ---- browser transport: path fallback, join before connect, auto rejoin ---- */
  let calls = 0;
  globalThis.io = (opts) => {
    calls++;
    // First attempt goes to a path that does not exist (like /socket.io on
    // Vercel); the Vercel path is served by our local /socket.io.
    const path = opts.path === "/socket.io" ? "/nope.io" : "/socket.io";
    return ioClient(url, { ...opts, path });
  };
  const { createNet } = await import(pathToFileURL(joinPath(root, "public/js/net.js")).href);
  const statuses = [];
  let rejoinAck = null;
  const watcher = await connect(url);
  open.push(watcher);
  await join(watcher, { name: "Watcher", room: "NETJS" });
  const net = createNet({
    onStatus: (s) => statuses.push(s),
    onRejoined: (ack) => (rejoinAck = ack),
  });
  const first = await net.join({ name: "Netty", room: "NETJS", look: { body: "male" } });
  check(
    first.room === "NETJS" && calls >= 2,
    "net.js join survives a failed first path",
    `net.js join failed (room=${first.room}, attempts=${calls})`
  );

  const rejoined = waitFor(watcher, "playerJoined", 8000, (p) => p.name === "Netty");
  serverIo.sockets.sockets.get(first.id)?.disconnect(true); // unexpected drop
  const back = await rejoined.catch(() => null);
  for (let i = 0; i < 40 && !rejoinAck; i++) await sleep(50);
  check(
    back && rejoinAck && rejoinAck.room === "NETJS" && rejoinAck.id !== first.id && net.id === rejoinAck.id,
    "net.js reconnects and re-joins the same room automatically",
    `auto rejoin failed: ack=${JSON.stringify(rejoinAck)}`
  );
  check(
    statuses.includes("reconnecting") && statuses[statuses.length - 1] === "online",
    "net.js reports reconnecting -> online",
    `unexpected status sequence: ${statuses.join(",")}`
  );
  net.close();
  watcher.disconnect();
} catch (err) {
  fail(`the smoke test crashed: ${err.stack || err.message}`);
} finally {
  for (const s of open) s.disconnect();
  serverIo.close();
  server.close();
}

console.log("");
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} problem(s) found`);
  process.exit(1);
}
console.log("✓ the museum server works end to end");
process.exit(0);
