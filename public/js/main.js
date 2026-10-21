import * as THREE from "three";
import { buildWorld, roomNameAt, roomAt } from "./world.js";
import { createPlayer } from "./player.js";
import { createRemotePlayers } from "./remote.js";
import { createMinimap } from "./minimap.js";
import { createCinema } from "./cinema.js";
import { createAudio } from "./audio.js";
import { createFX } from "./fx.js";
import { createUI, makeIceCream, FLAVOURS } from "./ui.js";
import { createNet } from "./net.js";
import { exhibitById, battleById, BATTLES, FACTS, EXHIBITS } from "./exhibits.js";
import { makeBubble } from "./util.js";

/* ------------------------------------------------------------------ */
/* renderer + scene                                                     */
/* ------------------------------------------------------------------ */
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
  preserveDrawingBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1016);
scene.fog = new THREE.Fog(0x0b1016, 120, 320);

const camera = new THREE.PerspectiveCamera(
  70,
  window.innerWidth / window.innerHeight,
  0.1,
  420
);
camera.position.set(0, 6, 20);

const world = buildWorld(scene);
const fx = createFX(scene);
const audio = createAudio();
const remote = createRemotePlayers(scene);
const minimap = createMinimap(document.getElementById("minimap"));

const cinema = createCinema({
  renderer,
  screenMat: world.screenMat,
  battles: BATTLES,
  onLine: (battle, idx) => {
    if (idx < 0) return;
    ui.setBattleCaption(battle.lines[idx][1]);
  },
  onProgress: (p) => ui.setBattleProgress(p),
  onHit: () => {
    audio.roar(0.9);
    fx.burst("dust", 0, 1.5, 0, 22);
  },
  onEnd: () => {
    ui.hideBattle();
    ui.toast("The screening has finished 🦖", "good");
    audio.chime();
  },
});

/* ------------------------------------------------------------------ */
/* state                                                                */
/* ------------------------------------------------------------------ */
const S = {
  joined: false,
  myId: null,
  room: null,
  player: null,
  look: null,
  name: "Visitor",
  color: "#ffc857",
  visited: new Set(),
  fossils: 0,
  scoops: 0,
  score: 0,
  digCooldown: 0,
  net: null,
  lastSend: 0,
  bubbles: [],
};

/* ------------------------------------------------------------------ */
/* UI                                                                   */
/* ------------------------------------------------------------------ */
const ui = createUI({
  onJoin: (opts) => startGame(opts),
  onChat: (text) => {
    S.net?.emit("chat", text);
  },
  onOrder: (order) => {
    const payload = {
      flavour: order.flavour.id,
      scoops: order.scoops,
      style: order.style,
      toppings: order.toppings || [],
    };
    S.net?.emit("action", { type: "iceCream", payload });
    applyIceCream(S.myId, payload);
    S.scoops++;
    ui.setCounters({ scoops: S.scoops });
    audio.slurp();
    ui.toast(`${flavourName(payload.flavour)} — enjoy! 🍦`, "good");
    fx.burst("confetti", S.player.state.x, S.player.state.y + 1.6, S.player.state.z, 26);
  },
  onStopBattle: () => {
    cinema.stop();
    ui.hideBattle();
  },
  onLookChange: () => {
    if (S.player) S.player.setLook(ui.look);
  },
});

function flavourName(id) {
  return FLAVOURS.find((f) => f.id === id)?.name || "Ice cream";
}

function applyIceCream(id, payload) {
  const order = {
    flavour: FLAVOURS.find((f) => f.id === payload.flavour) || FLAVOURS[0],
    scoops: payload.scoops || 1,
    style: payload.style || "cone",
    toppings: payload.toppings || [],
  };
  const prop = makeIceCream(order);
  if (id === S.myId) {
    S.player?.character.setHeld(prop);
    S.player?.playAction("eat", 2.4);
  } else {
    remote.setHeld(id, prop);
    remote.action(id, "eat", 2.4);
  }
}

/* ------------------------------------------------------------------ */
/* networking                                                           */
/* ------------------------------------------------------------------ */
function connect(payload) {
  return new Promise((resolve, reject) => {
    S.net = createNet({
      onStatus: (status, detail) => {
        if (S.joined) {
          if (status === "reconnecting" || status === "offline") {
            if (!S.offlineToastShown) ui.toast("Connection lost — reconnecting…");
            S.offlineToastShown = true;
          }
          return;
        }
        if (status === "connecting") ui.showStatus("Connecting to the museum…");
        if (status === "reconnecting") ui.showStatus("Reconnecting…");
        if (status === "error") ui.showStatus(`Connection problem: ${detail || ""}`);
        if (status === "online") ui.showStatus("Connected! Loading the museum…");
      },
      onRejoined: (res) => {
        S.myId = res.id;
        S.room = res.room;
        if (res.color) S.color = res.color;
        const ids = new Set((res.players || []).map((p) => p.id));
        for (const r of remote.list) if (!ids.has(r.id)) remote.remove(r.id);
        for (const p of res.players || []) {
          if (p.id === S.myId) continue;
          remote.upsert(p.id, p);
          remote.setState(p.id, p);
        }
        ui.setRoom(res.room);
        S.offlineToastShown = false;
        ui.chat({ system: true, text: "Reconnected to the museum ✅" });
      },
      look: (l) => remote.upsert(l.id, { look: l.look }),
      rateLimited: (r) => {
        if (r?.type === "chat") ui.toast("Slow down a little 🙂");
      },
      playerJoined: (p) => {
        remote.upsert(p.id, p);
        remote.setState(p.id, p);
        ui.chat({ system: true, text: `${p.name} joined the museum 🦖` });
        ui.toast(`${p.name} arrived`);
      },
      playerLeft: (p) => {
        remote.remove(p.id);
        ui.chat({ system: true, text: `${p.name || "A visitor"} left` });
      },
      state: (s) => remote.setState(s.id, s),
      chat: (c) => {
        ui.chat({ name: c.name, text: c.text });
      },
      action: (a) => {
        if (a.id === S.myId) return;
        if (a.type === "wave") {
          remote.action(a.id, "wave", 1.2);
          bubble(remote.players.get(a.id), "👋", remote.players.get(a.id)?.color);
        } else if (a.type === "battle") {
          const id = a.payload?.id;
          if (!(cinema.playing && S.currentBattleId === id)) startBattle(id);
        } else if (a.type === "iceCream") {
          applyIceCream(a.id, a.payload || {});
        } else if (a.type === "photo") {
          remote.action(a.id, "photo", 1.4);
          flashPhoto();
        } else if (a.type === "roar") {
          remote.action(a.id, "roar", 1.4);
          bubble(remote.players.get(a.id), "🦖", "#ffc857");
        } else if (a.type === "dig") {
          ui.chat({ system: true, text: `${a.name} dug up a fossil 🪨` });
        }
      },
    });

    S.net
      .join({
        name: payload.name,
        room: payload.room,
        look: payload.look,
        state: { x: world.spawn.x, y: 0, z: world.spawn.z, ry: world.spawn.ry },
      })
      .then(resolve)
      .catch(reject);
  });
}

/* ------------------------------------------------------------------ */
/* game flow                                                           */
/* ------------------------------------------------------------------ */
async function startGame(opts) {
  if (S.joined || S.joining) return;
  S.joining = true;
  ui.showStatus(opts.solo ? "Opening the doors…" : "Connecting to the museum…");
  try {
    // Solo visits never touch the network, so they work without a server.
    const res = opts.solo
      ? { id: "solo", room: "SOLO", players: [], color: S.color }
      : await connect(opts);
    S.solo = !!opts.solo;
    S.joined = true;
    S.myId = res.id;
    S.room = res.room;
    S.look = opts.look;
    S.name = opts.name || "Visitor";
    if (res.color) S.color = res.color;

    S.player = createPlayer({
      scene,
      camera,
      look: opts.look,
      name: S.name,
      color: S.color,
    });
    S.player.state.x = world.spawn.x;
    S.player.state.z = world.spawn.z;
    S.player.state.ry = world.spawn.ry;

    ui.setRoom(res.room);
    ui.setHall(roomNameAt(world.spawn.x, world.spawn.z));
    ui.setCounters({ discovered: 0, total: EXHIBITS.length });
    for (const p of res.players || []) {
      if (p.id === S.myId) continue;
      remote.upsert(p.id, p);
      remote.setState(p.id, p);
    }
    ui.setPlayers(res.players || [], S.myId);
    ui.enterGame();
    ui.chat({
      system: true,
      text: `You are in room ${res.room}. Share the code so friends can join!`,
    });
    audio.ensure();
    audio.ambient(true);
    const lock = document.body.requestPointerLock?.();
    if (lock && typeof lock.catch === "function") lock.catch(() => {});
    if (!S.solo) history.replaceState(null, "", `?room=${res.room}`);
  } catch (err) {
    console.error("Could not join the museum:", err);
    ui.showStatus(
      `Could not join: ${err.message}. Check your connection, or choose "Explore alone".`
    );
    S.net?.close();
    S.net = null;
  } finally {
    S.joining = false;
  }
}

// invite links look like /?room=ABCD
{
  const invited = new URLSearchParams(location.search).get("room");
  const input = document.getElementById("roomInput");
  if (invited && input && !input.value) {
    input.value = invited.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  }
}

/* ------------------------------------------------------------------ */
/* interactions                                                         */
/* ------------------------------------------------------------------ */
function nearestInteractable() {
  if (!S.player) return null;
  const p = S.player.state;
  let best = null;
  let bestD = Infinity;
  for (const it of world.interactables) {
    const d = Math.hypot(it.x - p.x, it.z - p.z);
    if (d < it.radius && d < bestD) {
      bestD = d;
      best = it;
    }
  }
  return best;
}

function startBattle(battleId) {
  const battle = battleById(battleId) || BATTLES[Math.floor(Math.random() * BATTLES.length)];
  S.currentBattleId = battle.id;
  cinema.play(battle.id);
  ui.showBattle(battle);
  ui.setBattleProgress(0);
  audio.roar(1);
}

function interact(it) {
  if (!it) return;
  switch (it.type) {
    case "exhibit": {
      const ex = exhibitById(it.exhibitId);
      if (!ex) return;
      if (!S.visited.has(ex.id)) {
        S.visited.add(ex.id);
        ui.setCounters({ discovered: S.visited.size });
        ui.toast(`Discovered ${ex.title} 🦴`, "good");
        audio.chime();
        fx.burst("sparkle", it.x, 2.2, it.z, 22);
      }
      S.score += 10;
      S.net?.emit("action", { type: "score", payload: 10 });
      ui.showExhibit(ex);
      break;
    }
    case "battle": {
      const battle = BATTLES[Math.floor(Math.random() * BATTLES.length)];
      S.net?.emit("action", { type: "battle", payload: { id: battle.id } });
      startBattle(battle.id);
      break;
    }
    case "guide": {
      const fact = FACTS[Math.floor(Math.random() * FACTS.length)];
      ui.modal(`
        <h2>🎟️ Museum Guide</h2>
        <p class="quote">Welcome to the Dinosaur Museum! You have found ${S.visited.size} of
        ${EXHIBITS.length} skeletons so far. There is also a screening theatre with comfy seats, a dig site — and a little surprise
        waiting at the very end of the tour.
        <span class="who">— Guide</span></p>
        <p class="lead" style="margin-top:16px">Did you know?</p>
        <p class="quote">${fact}</p>
        <div class="row actions"><button class="primary" id="guideClose">Thanks!</button></div>
      `);
      document.getElementById("guideClose").onclick = () => ui.closeModal();
      break;
    }
    case "timeline": {
      ui.modal(`
        <h2>🕰️ Deep Time Timeline</h2>
        <p class="quote">
          <b>Triassic</b> 252–201 Ma — the first dinosaurs. Eoraptor, Herrerasaurus, Plateosaurus.<br>
          <b>Jurassic</b> 201–145 Ma — giants roam. Brachiosaurus, Stegosaurus, Allosaurus.<br>
          <b>Cretaceous</b> 145–66 Ma — flowers, feathers and T. rex.<br>
          <b>Today</b> — birds are the only dinosaurs left. Some even visit this museum.
          <span class="who">— Hall panel</span>
        </p>
        <div class="row actions"><button class="primary" id="tlClose">Close</button></div>
      `);
      document.getElementById("tlClose").onclick = () => ui.closeModal();
      break;
    }
    case "photo": {
      S.net?.emit("action", { type: "photo", payload: {} });
      takePhoto();
      break;
    }
    case "dig": {
      dig();
      break;
    }
    case "puzzle": {
      openPuzzle();
      break;
    }
    case "icecream": {
      ui.openIce();
      break;
    }
    case "exit": {
      showExit();
      break;
    }
    case "holo": {
      roar(it.exhibitId);
      break;
    }
    default:
      break;
  }
}

const PUZZLE_BONES = ["Tail", "Hips", "Back", "Ribs", "Neck", "Skull"];

function openPuzzle() {
  const order = [...PUZZLE_BONES].sort(() => Math.random() - 0.5);
  let next = 0;
  ui.modal(`
    <h2>🦴 Bone Assembly</h2>
    <p class="lead">Rebuild the Coelophysis! Click the bones in order — from the tail to
    the skull.</p>
    <div class="row puzzleBones" id="puzzleBones">
      ${order.map((b) => `<button class="chip" data-bone="${b}">${b}</button>`).join("")}
    </div>
    <p class="quote" id="puzzleProgress">Placed: —</p>
    <div class="row actions"><button class="ghost" id="puzzleClose">Close</button></div>
  `);
  document.getElementById("puzzleClose").onclick = () => ui.closeModal();
  const progress = document.getElementById("puzzleProgress");
  for (const btn of document.querySelectorAll("#puzzleBones button")) {
    btn.onclick = () => {
      if (btn.dataset.bone === PUZZLE_BONES[next]) {
        next++;
        btn.disabled = true;
        btn.classList.add("active");
        progress.textContent = `Placed: ${PUZZLE_BONES.slice(0, next).join(" → ")}`;
        audio.click(440 + next * 60);
        if (next === PUZZLE_BONES.length) {
          ui.closeModal();
          S.score += 25;
          S.net?.emit("action", { type: "score", payload: 25 });
          ui.toast("Skeleton assembled! +25 points 🏆", "good");
          audio.chime(660);
          const p = S.player.state;
          fx.burst("sparkle", p.x, 2, p.z, 30);
        }
      } else {
        next = 0;
        for (const b of document.querySelectorAll("#puzzleBones button")) {
          b.disabled = false;
          b.classList.remove("active");
        }
        progress.textContent = `Not quite — a ${btn.dataset.bone.toLowerCase()} doesn't go there. Start again from the tail.`;
        audio.click(180);
      }
    };
  }
}

function dig() {
  if (S.digCooldown > 0) {
    ui.toast("The sand is already disturbed here…");
    return;
  }
  S.digCooldown = 4;
  const p = S.player.state;
  fx.burst("dust", p.x, 0.3, p.z, 26);
  audio.step(1.4);
  const finds = [
    "a fossilised fern frond 🌿",
    "a partial ammonite shell 🐚",
    "a dinosaur tooth 🦷",
    "a coprolite (fossil poo!) 💩",
    "a perfectly preserved trilobite 🦐",
    "a mystery bone 🦴",
  ];
  const find = finds[Math.floor(Math.random() * finds.length)];
  S.fossils++;
  S.score += 5;
  ui.setCounters({ fossils: S.fossils });
  ui.toast(`You dug up ${find}`, "good");
  ui.chat({ system: true, text: `You dug up ${find}` });
  S.net?.emit("action", { type: "dig", payload: {} });
  S.net?.emit("action", { type: "score", payload: 5 });
}

function roar(exhibitId) {
  const p = S.player.state;
  S.player.playAction("roar", 1.4);
  audio.roar(1);
  bubble(S.player, "🦖", "#ffc857");
  S.net?.emit("action", { type: "roar", payload: {} });
  fx.burst("dust", p.x, 0.4, p.z, 14);

  // make the nearest skeleton roar back
  let best = null;
  let bestD = Infinity;
  for (const d of world.dinos) {
    const dist = Math.hypot(d.group.position.x - p.x, d.group.position.z - p.z);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  if (best && bestD < 22) {
    best.setAnim("roar");
    setTimeout(() => best.setAnim("idle"), 2200);
  }
}

function bubble(target, text, color) {
  if (!target) return;
  const sprite = makeBubble(text, color);
  const holder = target.character ? target.character.group : target.group;
  sprite.position.set(0, 2.5, 0);
  holder.add(sprite);
  setTimeout(() => {
    holder.remove(sprite);
    sprite.material.map?.dispose();
    sprite.material.dispose();
  }, 1600);
}

function takePhoto() {
  S.player?.playAction("photo", 1.2);
  audio.click(880);
  setTimeout(() => {
    try {
      const url = renderer.domElement.toDataURL("image/jpeg", 0.75);
      const others = remote.list.filter(
        (r) => Math.hypot(r.x - S.player.state.x, r.z - S.player.state.z) < 14
      );
      ui.modal(`
        <h2>📸 Group Photo</h2>
        <p class="lead">${others.length + 1} visitor${others.length ? "s" : ""} posing by the backdrop.
        The photo has been saved to the museum wall.</p>
        <img src="${url}" style="width:100%;border-radius:14px;border:1px solid var(--line);margin-top:8px" />
        <div class="row actions"><button class="primary" id="photoClose">Nice!</button></div>
      `);
      document.getElementById("photoClose").onclick = () => ui.closeModal();
    } catch {
      ui.toast("Photo taken! 📸", "good");
    }
  }, 260);
}

function flashPhoto() {
  const flash = document.createElement("div");
  flash.style.cssText =
    "position:fixed;inset:0;background:#fff;opacity:0.85;z-index:35;pointer-events:none;transition:opacity .5s";
  document.body.appendChild(flash);
  requestAnimationFrame(() => {
    flash.style.opacity = "0";
  });
  setTimeout(() => flash.remove(), 600);
}

function showExit() {
  ui.modal(`
    <h2>🚪 Leaving the museum</h2>
    <p class="lead">Thanks for visiting! Here is your museum passport.</p>
    <div class="exGrid">
      <div class="stat"><span>Dinosaurs discovered</span><b>${S.visited.size}</b></div>
      <div class="stat"><span>Fossils dug</span><b>${S.fossils}</b></div>
      <div class="stat"><span>Ice creams</span><b>${S.scoops}</b></div>
      <div class="stat"><span>Points</span><b>${S.score}</b></div>
    </div>
    <p class="quote">"Every fossil is a story that just needs a little more digging."
      <span class="who">— Museum guide</span></p>
    <div class="row actions">
      <button class="primary" id="stayBtn">Keep exploring</button>
      <button class="ghost" id="leaveBtn">Leave</button>
    </div>
  `);
  document.getElementById("stayBtn").onclick = () => ui.closeModal();
  document.getElementById("leaveBtn").onclick = () => {
    ui.closeModal();
    ui.toast("Safe travels, dinosaur friend! 🦖");
    S.net?.close();
    setTimeout(() => location.reload(), 900);
  };
}

/* ------------------------------------------------------------------ */
/* input                                                                */
/* ------------------------------------------------------------------ */
window.addEventListener("keydown", (e) => {
  if (!S.joined || !S.player) return;
  if (ui.isChatOpen()) return;
  if (e.code === "KeyT") {
    e.preventDefault();
    ui.openChat();
    return;
  }
  if (ui.isModalOpen() || ui.isCardOpen() || ui.isIceOpen()) {
    if (e.code === "Escape") ui.closeAll();
    return;
  }
  switch (e.code) {
    case "KeyE":
      interact(nearestInteractable());
      break;
    case "KeyV":
      roar();
      break;
    case "KeyB":
      S.player.playAction("wave", 1.2);
      bubble(S.player, "👋", S.color);
      S.net?.emit("action", { type: "wave", payload: {} });
      break;
    case "KeyF": {
      const it = nearestInteractable();
      if (it?.type === "dig") {
        dig();
      } else if (it?.type === "exhibit") {
        const ex = exhibitById(it.exhibitId);
        S.player.playAction("eat", 2.2);
        ui.toast(`You fed the ${ex?.title || "dinosaur"} a bone 🦴`, "good");
        audio.step(1.2);
      } else {
        ui.toast("Nothing to feed here.");
      }
      break;
    }
    case "KeyG":
      interact(nearestInteractable()?.type === "photo" ? nearestInteractable() : { type: "photo" });
      break;
    case "KeyC":
      ui.toast(S.player.toggleCamera() === 0 ? "Third person camera" : "First person camera");
      break;
    case "KeyM":
      document.getElementById("minimap").classList.toggle("big");
      break;
    case "KeyL":
      audio.setMuted(!audio.muted);
      ui.toast(audio.muted ? "Sound off 🔇" : "Sound on 🔊");
      break;
    default:
      break;
  }
});

function anyPanelOpen() {
  return ui.isModalOpen() || ui.isCardOpen() || ui.isIceOpen();
}

canvas.addEventListener("click", () => {
  if (!S.joined) return;
  if (ui.isModalOpen() || ui.isCardOpen() || ui.isIceOpen()) return;
  S.player?.requestLock(canvas);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ------------------------------------------------------------------ */
/* main loop                                                            */
/* ------------------------------------------------------------------ */
const clock = new THREE.Clock();
let stepTimer = 0;
let rosterTimer = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  if (S.joined && S.player) {
    S.player.setInputEnabled?.(!(ui.isChatOpen() || anyPanelOpen()));
    S.player.update(dt);
    remote.update(dt);
    S.digCooldown = Math.max(0, S.digCooldown - dt);

    // footsteps
    stepTimer += dt * S.player.state.speed;
    if (S.player.state.speed > 0.5 && stepTimer > 1.6) {
      stepTimer = 0;
      audio.step(0.6);
    }

    // interaction prompt
    const it = nearestInteractable();
    if (it) {
      ui.setPrompt(it.label, it.key);
    } else {
      ui.setPrompt(null);
    }

    ui.setHall(roomNameAt(S.player.state.x, S.player.state.z));

    // network state
    const now = performance.now();
    if (now - S.lastSend > 90) {
      S.lastSend = now;
      S.net?.emit("state", {
        x: S.player.state.x,
        y: S.player.state.y,
        z: S.player.state.z,
        ry: S.player.state.ry,
        anim: S.player.state.anim,
      });
    }
  }

  // animated exhibits
  for (const a of world.animated) {
    if (a.dino) a.dino.update(dt, { speed: a.speed || 0 });
    if (a.type === "lava") {
      a.mesh.material.emissiveIntensity =
        a.base + Math.sin(performance.now() / 260) * 0.5 + Math.random() * 0.3;
    }
  }

  cinema.update(dt);
  cinema.render();
  fx.update(dt);

  // minimap
  if (S.joined && S.player) {
    minimap.draw({
      local: { x: S.player.state.x, z: S.player.state.z, ry: S.player.state.ry },
      remotes: remote.list.map((r) => ({ x: r.x, z: r.z, color: r.color })),
    });
    rosterTimer -= dt;
    if (rosterTimer <= 0) {
      rosterTimer = 0.35;
      const roster = [
        { id: S.myId, name: S.name, color: S.color },
        ...remote.list.map((r) => ({ id: r.id, name: r.name, color: r.color })),
      ];
      ui.setPlayers(roster, S.myId);
    }
  }

  renderer.render(scene, camera);
}

animate();

// expose a tiny debug handle (used by the console and by the browser tests)
window.__museum = {
  scene,
  renderer,
  camera,
  S,
  world,
  cinema,
  remote,
  roomAt,
  get player() {
    return S.player;
  },
};
