/**
 * End-to-end smoke test.
 *
 * Boots the real museum server, connects visitors and checks that joining,
 * the roster, movement, chat, actions, looks, validation, rate limits,
 * re-joining, resuming after a dropped connection, room cleanup, the
 * browser transport (public/js/net.js, including path fallback and
 * automatic re-join) and cross-instance sync (two servers sharing an
 * in-process mock of the Upstash REST API) all work over the wire.
 *
 *   node scripts/smoke.mjs
 */

import { createServer as createHttpServer } from "node:http";
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

  // a missing asset is a real 404, a page route still gets the app
  const missing = await Promise.all(
    ["/images/species/nope.jpg", "/models/nope", "/data/nope", "/textures/nope", "/vendor/nope", "/js/nope", "/css/nope.css", "/nope.glb"].map(
      async (p) => [p, (await fetch(`${url}${p}`, { headers: { accept: "text/html,*/*" } })).status]
    )
  );
  const wrong = missing.filter(([, s]) => s !== 404);
  check(!wrong.length, "missing assets are a 404", `missing assets are not a 404: ${wrong.map(([p, s]) => `${p} ${s}`).join(", ")}`);
  const spa = await fetch(`${url}/room/ABC123`, { headers: { accept: "text/html" } });
  check(spa.ok && (await spa.text()).includes("Dinosaur Museum"), "page routes fall back to the app", "a page route did not get index.html");

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
  alice.emit("action", { type: "iceCream", payload: { flavour: "dinodust", scoops: 2, style: "cup", toppings: ["cherry"] } });
  const action = await actioned;
  check(
    action.type === "iceCream" &&
      JSON.stringify(action.payload) ===
        JSON.stringify({ flavour: "dinodust", scoops: 2, style: "cup", toppings: ["cherry"] }),
    "actions are relayed",
    `the action was relayed incorrectly: ${JSON.stringify(action)}`
  );
  const rejected = collect(bob, "action", 300);
  alice.emit("action", { type: "explode", payload: {} });
  alice.emit("action", { type: "photo", payload: { junk: "x".repeat(2000) } });
  alice.emit("action", { type: "iceCream", payload: { flavour: "x", scoops: 1 } });
  alice.emit("action", { type: "battle", payload: { id: "no-such-battle" } });
  check((await selfActions).length === 0, "actions are not echoed to the sender", "the sender got its own action back");
  check(
    (await rejected).length === 0,
    "unknown / oversized / invalid actions are dropped",
    "an invalid action was relayed"
  );

  /* hostile ice cream: clamped so receivers never build 1e9 scoops */
  const clamped = waitFor(bob, "action");
  alice.emit("action", { type: "iceCream", payload: { flavour: "volcano", scoops: 1e9, toppings: 5, style: "evil" } });
  const iceGot = await clamped;
  check(
    JSON.stringify(iceGot.payload) === JSON.stringify({ flavour: "volcano", scoops: 3, style: "cone", toppings: [] }),
    "ice cream orders are whitelisted and clamped",
    `ice cream payload not sanitised: ${JSON.stringify(iceGot.payload)}`
  );
  const [bobIce] = await join(bob, { name: "Bob", room: "SMOKE" }).then((a) => [
    a.players.find((p) => p.id === aliceJoin.id)?.iceCream,
  ]);
  check(bobIce?.scoops === 3, "the stored ice cream is the sanitised one", `stored ice cream: ${JSON.stringify(bobIce)}`);

  /* battles: known ids only, and one per room per cooldown */
  const { BATTLES } = await import(pathToFileURL(joinPath(root, "public/js/exhibits.js")).href);
  const battleRelayed = waitFor(bob, "action", 1000, (a) => a.type === "battle");
  alice.emit("action", { type: "battle", payload: { id: BATTLES[0].id, extra: "x" } });
  const battle = await battleRelayed.catch(() => null);
  check(
    battle && JSON.stringify(battle.payload) === JSON.stringify({ id: BATTLES[0].id }),
    "a known battle id is relayed",
    `battle relay wrong: ${JSON.stringify(battle)}`
  );
  const battleSpam = collect(bob, "action", 300);
  const battleNotice = waitFor(alice, "rateLimited", 1000, (r) => r.type === "battle").catch(() => null);
  alice.emit("action", { type: "battle", payload: { id: BATTLES[1 % BATTLES.length].id } });
  const spamGot = (await battleSpam).filter((a) => a.type === "battle");
  check(
    spamGot.length === 0 && (await battleNotice),
    "battles have a per-room cooldown",
    `a second battle got through the cooldown (${spamGot.length})`
  );

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

  /* ---- resume: a reconnect with the same token takes over the old player ---- */
  const token = "smoke-resume-token-0001";
  const ghost = await connect(url);
  open.push(ghost);
  const ghostJoin = await join(ghost, { name: "Ghosty", room: "SMOKE", resume: token });
  ghost.emit("action", { type: "score", payload: 7 });
  await sleep(80);
  const noLeave = collect(bob, "playerLeft", 400);
  const noJoin = collect(bob, "playerJoined", 400);
  const swapped = waitFor(bob, "playerRejoined", 2000).catch(() => null);
  const ghostKicked = waitFor(ghost, "disconnect", 2000).catch(() => null);
  const fresh = await connect(url);
  open.push(fresh);
  const freshJoin = await join(fresh, {
    name: "Ghosty",
    room: "SMOKE",
    resume: token,
    prevId: ghostJoin.id,
    state: { x: 9, y: 0, z: 9, ry: 0 },
  });
  const swap = await swapped;
  check(
    freshJoin.resumed && freshJoin.color === ghostJoin.color && freshJoin.score === 7,
    "a resumed join keeps colour and score",
    `resume ack wrong: ${JSON.stringify({ ...freshJoin, players: undefined })}`
  );
  check(
    swap && swap.oldId === ghostJoin.id && swap.id === freshJoin.id && swap.x === 9,
    "others get playerRejoined (old id -> new id)",
    `playerRejoined wrong: ${JSON.stringify(swap)}`
  );
  check(
    (await noLeave).length === 0 && (await noJoin).length === 0,
    "a resume does not announce left + joined",
    "a resume still sent playerLeft / playerJoined"
  );
  check(
    (await ghostKicked) && !freshJoin.players.some((p) => p.id === ghostJoin.id),
    "the stale socket is dropped and is not in the roster",
    "the old socket stayed in the room"
  );
  const wrongToken = await connect(url);
  open.push(wrongToken);
  const wrongJoin = await join(wrongToken, { name: "Imposter", room: "SMOKE", resume: "x".repeat(24), prevId: freshJoin.id });
  check(
    !wrongJoin.resumed && wrongJoin.players.some((p) => p.id === freshJoin.id),
    "a different token cannot take over a player",
    "a player was taken over with the wrong token"
  );
  const freshLeft = waitFor(bob, "playerLeft", 1000, (p) => p.id === freshJoin.id).catch(() => null);
  fresh.disconnect();
  wrongToken.disconnect();
  check(await freshLeft, "an explicit disconnect still leaves at once", "playerLeft was not sent on disconnect");

  /* ---- re-join on the same socket moves rooms ---- */
  // filter by id: the imposter's leave above can still be in flight
  const leftOld = waitFor(bob, "playerLeft", undefined, (p) => p.id === aliceJoin.id);
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

  // A dropped transport (Wi-Fi blip): net.js re-joins with its resume token
  // at the last position it sent, and the others see one rejoin, not a leave.
  check(net.emit("state", { x: 4, y: 0, z: -3, ry: 0, anim: "idle" }) === true, "net.emit reports a sent event", "net.emit did not return true");
  const before = rejoinAck;
  rejoinAck = null;
  const blipLeft = collect(watcher, "playerLeft", 2500);
  const blipSwap = waitFor(watcher, "playerRejoined", 8000).catch(() => null);
  net.socket.io.engine.close();
  await sleep(20);
  check(net.emit("chat", "lost?") === false, "net.emit reports a dropped event while offline", "net.emit claimed to send while offline");
  const blip = await blipSwap;
  for (let i = 0; i < 40 && !rejoinAck; i++) await sleep(50);
  check(
    blip && blip.oldId === before.id && blip.x === 4 && blip.z === -3 && rejoinAck?.resumed && rejoinAck.color === before.color,
    "net.js resumes its player after a dropped connection",
    `resume after blip failed: ${JSON.stringify(blip)} ack=${JSON.stringify(rejoinAck && { ...rejoinAck, players: undefined })}`
  );
  check((await blipLeft).length === 0, "a resumed reconnect sends no playerLeft", "playerLeft was sent for a resumed player");
  net.close();
  watcher.disconnect();
} catch (err) {
  fail(`the smoke test crashed: ${err.stack || err.message}`);
} finally {
  for (const s of open) s.disconnect();
  serverIo.close();
  server.close();
}

/* ---- cross-instance sync (two servers + a mock Upstash REST API) ---- */

/** Minimal in-memory Upstash: the commands and Lua scripts sync.js uses. */
function createMockUpstash() {
  const kv = new Map();
  const hashes = new Map();
  const lists = new Map();
  const ops = [];
  const mock = { ops, hashes, hang: false };
  const hash = (k) => hashes.get(k) || (hashes.set(k, new Map()), hashes.get(k));
  function run([c, ...a]) {
    const op = String(c).toUpperCase();
    switch (op) {
      case "GET":
        return kv.get(a[0]) ?? null;
      case "DEL":
        return Number(hashes.delete(a[0]) || lists.delete(a[0]) || kv.delete(a[0]));
      case "EXPIRE":
        return 1;
      case "HSET":
        for (let i = 1; i < a.length; i += 2) hash(a[0]).set(String(a[i]), String(a[i + 1]));
        return 1;
      case "HDEL":
        return Number(hash(a[0]).delete(String(a[1])));
      case "HGETALL":
        return [...hash(a[0])].flat();
      case "EVAL": {
        const [script, , k1, k2, ...argv] = a;
        if (script.includes("RPUSH")) {
          const l = lists.get(k2) || [];
          lists.set(k2, l);
          let out = 0;
          for (const e of argv) {
            out = Number(kv.get(k1) || 0) + 1;
            kv.set(k1, String(out));
            l.push(`${out}|${e}`);
          }
          while (l.length > 200) l.shift();
          return out;
        }
        if (script.includes("LRANGE")) {
          const seq = Number(kv.get(k1) || 0);
          const known = Number(argv[0]);
          if (known < 0 || seq <= known) return [seq];
          const n = Math.min(200, seq - known);
          return [seq, (lists.get(k2) || []).slice(-n)];
        }
        if (script.includes("HDEL")) {
          // k1 = hash, k2 = field, argv[0] = expected value
          return hash(k1).get(k2) === argv[0] ? Number(hash(k1).delete(k2)) : 0;
        }
        throw new Error("unknown script");
      }
      default:
        throw new Error(`unsupported ${op}`);
    }
  }
  mock.server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (mock.hang) return; // never answer: a stalled Upstash request
      const args = JSON.parse(body);
      ops.push(args);
      let out;
      try {
        out = { result: run(args) };
      } catch (e) {
        out = { error: e.message };
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  return mock;
}

const upstash = createMockUpstash();
await new Promise((r) => upstash.server.listen(0, "127.0.0.1", r));
const syncOptions = {
  url: `http://127.0.0.1:${upstash.server.address().port}`,
  token: "smoke",
  pollMs: 100,
  idlePollMs: 200,
  flushMs: 30,
  timeoutMs: 400,
  staleMs: 1500,
  heartbeatMs: 300,
};
const A = createMuseumServer({ sync: syncOptions });
const B = createMuseumServer({ sync: syncOptions });
await Promise.all([A, B].map((x) => new Promise((r) => x.server.listen(0, r))));
const urlA = `http://127.0.0.1:${A.server.address().port}`;
const urlB = `http://127.0.0.1:${B.server.address().port}`;
const xOpen = [];
const published = (pred) =>
  upstash.ops.filter((o) => o[0] === "EVAL" && String(o[1]).includes("RPUSH")).flatMap((o) => o.slice(5).map((e) => JSON.parse(e))).filter(pred);

try {
  /* a solo player publishes no movement and polls cheaply */
  const xav = await connect(urlA);
  xOpen.push(xav);
  const xAck = await join(xav, { name: "Xavier", room: "XINST" });
  check(xAck.crossInstance === true, "cross-instance sync is enabled with Upstash credentials", "sync not enabled");
  for (let i = 0; i < 8; i++) {
    xav.emit("state", { x: 1, y: 0, z: 1, ry: 0, anim: "idle" });
    await sleep(40);
  }
  await sleep(100);
  check(
    published((e) => e.t === "state").length === 0,
    "states are not published while no other instance shares the room",
    `solo states were published: ${published((e) => e.t === "state").length}`
  );

  /* join race: Y on B right after X on A sees X once */
  const yan = await connect(urlB);
  xOpen.push(yan);
  const yJoins = [];
  yan.on("playerJoined", (p) => yJoins.push(p));
  const yAck = await join(yan, { name: "Yan", room: "XINST" });
  check(
    yAck.players.some((p) => p.id === xAck.id && p.x === 1),
    "a joiner on another instance gets the shared roster",
    `Y's roster: ${JSON.stringify(yAck.players.map((p) => p.name))}`
  );
  const xSeesY = await waitFor(xav, "playerJoined", 2000, (p) => p.id === yAck.id).catch(() => null);
  check(xSeesY, "the other instance announces the new player", "X never heard about Y");
  await sleep(300);
  check(
    !yJoins.some((p) => p.id === xAck.id),
    "a player already in the join roster is not announced again",
    "Y was told twice that X joined"
  );

  /* movement and actions flow across, sanitised and paced */
  const yStates = [];
  yan.on("state", (st) => st.id === xAck.id && yStates.push({ at: Date.now(), x: st.x }));
  for (let i = 0; i < 10; i++) {
    xav.emit("state", { x: 10 + i, y: 0, z: 0, ry: 0, anim: "walk" });
    await sleep(50);
  }
  await sleep(400);
  const gaps = yStates.slice(1).map((st, i) => st.at - yStates[i].at);
  check(
    yStates.length >= 3 && yStates.at(-1).x === 19 && Math.max(...gaps) < 120 && gaps.filter((g) => g < 8).length < gaps.length / 2,
    `cross-instance states are replayed at their own pace (${yStates.length} states)`,
    `cross-instance states burst or missing: ${JSON.stringify(gaps)}`
  );
  const yIce = waitFor(yan, "action", 2000, (a) => a.type === "iceCream");
  xav.emit("action", { type: "iceCream", payload: { flavour: "matcha", scoops: 99, toppings: "cherry" } });
  const crossIce = await yIce.catch(() => null);
  check(
    crossIce?.payload?.scoops === 3 && Array.isArray(crossIce.payload.toppings),
    "actions relayed across instances are sanitised",
    `cross-instance ice cream: ${JSON.stringify(crossIce)}`
  );

  /* a killed instance's player disappears once its roster entry goes stale */
  upstash.hashes.get("dm:players:XINST")?.set(
    "dead-instance-player",
    JSON.stringify({ id: "dead-instance-player", name: "Zombie", color: "#ffc857", x: 0, y: 0, z: 0, ry: 0, anim: "idle", seen: Date.now(), inst: "deadbeef" })
  );
  const zombieIn = await waitFor(yan, "playerJoined", 2000, (p) => p.name === "Zombie").catch(() => null);
  const zombieOut = await waitFor(yan, "playerLeft", 5000, (p) => p.id === "dead-instance-player").catch(() => null);
  check(
    zombieIn && zombieOut,
    "a player of a dead instance is dropped once its roster entry goes stale",
    `ghost not cleaned up (joined=${!!zombieIn}, left=${!!zombieOut})`
  );
  const late = await connect(urlB);
  xOpen.push(late);
  const lateAck = await join(late, { name: "Late", room: "XINST" });
  check(
    !lateAck.players.some((p) => p.name === "Zombie"),
    "late joiners never get stale roster entries",
    `late joiner saw: ${lateAck.players.map((p) => p.name)}`
  );

  /* a leave is not undone by a roster write still in flight */
  const yLeft = waitFor(xav, "playerLeft", 2000, (p) => p.id === lateAck.id).catch(() => null);
  late.emit("state", { x: 2, y: 0, z: 2, ry: 0, anim: "idle" });
  late.emit("look", { shirt: "#123456" });
  late.disconnect();
  check(await yLeft, "a leave crosses instances", "X never heard that Late left");
  await sleep(300);
  check(
    !upstash.hashes.get("dm:players:XINST")?.has(lateAck.id),
    "a player who left is not resurrected in the shared roster",
    "the shared roster still lists a player who left"
  );

  /* a stalled Upstash request cannot block a join */
  upstash.hang = true;
  const stuck = await connect(urlB);
  xOpen.push(stuck);
  const t0 = Date.now();
  const stuckAck = await Promise.race([join(stuck, { name: "Stuck", room: "HANG" }), sleep(4000).then(() => null)]);
  upstash.hang = false;
  check(
    stuckAck?.room === "HANG",
    `a join completes while Upstash hangs (${Date.now() - t0} ms)`,
    "a join hung behind a stalled Upstash request"
  );
} catch (err) {
  fail(`the cross-instance smoke test crashed: ${err.stack || err.message}`);
} finally {
  for (const s of xOpen) s.disconnect();
  for (const x of [A, B]) {
    x.io.close();
    x.server.close();
  }
  upstash.server.closeAllConnections?.();
  upstash.server.close();
}

console.log("");
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  console.error(`\n${problems.length} problem(s) found`);
  process.exit(1);
}
console.log("✓ the museum server works end to end");
process.exit(0);
