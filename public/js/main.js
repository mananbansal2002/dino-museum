import * as THREE from "three";
import { buildWorld, roomNameAt, roomAt, COURT, SCREEN } from "./world.js";
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
import { upgradeCharacter, preloadModels } from "./models.js";
import { SIT_SEAT_OFFSET, createCharacter } from "./character.js";
import { createEraView } from "./eraview.js";
import { createVideoPlayer, mediaOverlayOpen } from "./video.js";

preloadModels(["male", "female"]);

/* ------------------------------------------------------------------ */
/* renderer + scene                                                     */
/* ------------------------------------------------------------------ */
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
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
  55,
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
const eraView = createEraView({ renderer });
const videoPlayer = createVideoPlayer();

/* ------------------------------------------------------------------ */
/* the ice cream vendor behind the counter                              */
/* ------------------------------------------------------------------ */
const vendor = (() => {
  const character = createCharacter(
    {
      body: "female",
      skin: "#c98c5f",
      shirt: "#f4ead5",
      pants: "#3f6fb5",
      hair: "bun",
      hairColor: "#2b1d12",
      accessory: "cap",
    },
    { name: "Scoops 🍦", tagColor: "#ff8fab" }
  );
  // the counter runs along x at COURT.stallZ; customers queue on the -z side
  character.group.position.set(COURT.stallX, 0, COURT.stallZ + 0.75);
  character.group.rotation.y = Math.PI;
  scene.add(character.group);
  upgradeCharacter(character);
  let greeted = false;
  return {
    character,
    update(dt, player) {
      character.update(dt, { speed: 0, anim: "idle" });
      if (!player) return;
      const d = Math.hypot(player.x - COURT.stallX, player.z - COURT.stallZ);
      if (d < 9 && !greeted) {
        greeted = true;
        character.playAction("wave", 1.6);
      } else if (d > 14) {
        greeted = false;
      }
    },
    celebrate() {
      character.playAction("cheer", 1.4);
    },
  };
})();

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
    // the film plays for the whole room, but only the audience hears and sees the hits
    if (!S.watchingBattle) return;
    audio.roar(0.9, { zone: "theatre" });
    fx.burst("dust", SCREEN.x, 1.5, SCREEN.z + 3, 22);
  },
  onEnd: () => {
    const watched = S.watchingBattle;
    watchBattle(false);
    if (!watched) return;
    ui.toast("The screening has finished 🦖", "good");
    audio.chime(523.25, { zone: "theatre" });
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
  puzzleSolved: false,
  watchingBattle: false,
  lastFlash: 0,
  lastRateToast: 0,
};

// held ice creams, keyed by remote id (or ME): the order (for the roster) and
// the prop in the hand (so it can be disposed when replaced or dropped)
const ME = "me";
const held = new Map();

/* ------------------------------------------------------------------ */
/* UI                                                                   */
/* ------------------------------------------------------------------ */
const ui = createUI({
  onJoin: (opts) => startGame(opts),
  onChat: (text) => {
    if (S.solo) {
      // no server to echo it back: solo chat is a note to yourself
      ui.chat({ name: S.name, text });
    } else if (!S.net?.emit("chat", text)) {
      ui.chat({ system: true, text: "Not connected — message not sent" });
    }
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
    vendor.celebrate();
    ui.toast(`${flavourName(payload.flavour)} — enjoy! 🍦`, "good");
    fx.burst("confetti", S.player.state.x, S.player.state.y + 1.6, S.player.state.z, 26);
  },
  onStopBattle: () => stopBattle(),
  onExhibitVideos: (ex) => {
    // verified clips when the exhibit has them, otherwise a YouTube search
    if (!(ex.videos?.length && videoPlayer.open(ex.videos[0], ex.videos))) {
      videoPlayer.openSearch(`${ex.title} dinosaur`, ex.title);
    }
  },
  onLookChange: () => {
    if (S.player) S.player.setLook(ui.look);
  },
  // a tap on the prompt (or the touch "use" button) does what E does
  onPromptTap: () => useAction(),
  onToggleSound: () => toggleSound(),
});

function toggleSound() {
  audio.ensure();
  audio.setMuted(!audio.muted);
  ui.setSound(audio.muted);
  ui.toast(audio.muted ? "Sound off 🔇" : "Sound on 🔊");
}

function flavourName(id) {
  return FLAVOURS.find((f) => f.id === id)?.name || "Ice cream";
}

/**
 * Put an ice cream in someone's hand. `animate` is false when restoring one a
 * player was already holding (late join / reconnect) rather than a new order.
 */
function applyIceCream(id, payload, { animate = true } = {}) {
  const mine = id === S.myId;
  if (mine ? !S.player : !remote.players.has(id)) return;
  // never trust the relay: makeIceCream builds one mesh per scoop / topping
  const n = Math.round(Number(payload.scoops));
  const order = {
    flavour: FLAVOURS.find((f) => f.id === payload.flavour) || FLAVOURS[0],
    scoops: Number.isFinite(n) ? Math.min(3, Math.max(1, n)) : 1,
    style: payload.style === "cup" ? "cup" : "cone",
    toppings: Array.isArray(payload.toppings)
      ? payload.toppings.filter((t) => typeof t === "string").slice(0, 8)
      : [],
  };
  const prop = makeIceCream(order);
  if (mine) {
    S.player.character.setHeld(prop);
    if (animate) S.player.playAction("eat", 2.4);
  } else {
    remote.setHeld(id, prop);
    if (animate) remote.action(id, "eat", 2.4);
  }
  // setHeld only detaches the previous prop: free its GPU buffers here
  const key = mine ? ME : id;
  const prev = held.get(key);
  held.set(key, { payload, prop });
  if (prev) disposeObject(prev.prop);
}

/** Re-attach a held prop after a character swaps to its rigged model. */
function reattachHeld(id) {
  const h = held.get(id === S.myId ? ME : id);
  if (!h) return;
  if (id === S.myId) S.player?.character.setHeld(h.prop);
  else remote.setHeld(id, h.prop);
}

/** A remote player arrived (join, rejoin roster, late-join roster). */
function addRemote(p) {
  remote.upsert(p.id, p);
  remote.setState(p.id, p);
  if (p.iceCream && typeof p.iceCream === "object") applyIceCream(p.id, p.iceCream, { animate: false });
}

function removeRemote(id) {
  remote.remove(id);
  const h = held.get(id);
  held.delete(id);
  if (h) disposeObject(h.prop);
}

function disposeObject(root) {
  root.traverse((o) => {
    o.geometry?.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) m.dispose();
  });
}

/* ------------------------------------------------------------------ */
/* networking                                                           */
/* ------------------------------------------------------------------ */
function connect(payload) {
  return new Promise((resolve, reject) => {
    S.net = createNet({
      onStatus: (status, detail) => {
        // a deliberate close (Leave) is not a lost connection
        if (S.leaving || detail === "closed") return;
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
        if (res.color && res.color !== S.color) {
          S.color = res.color;
          S.player?.setName(S.name, S.color);
        }
        if (!res.resumed && typeof res.score === "number") {
          // the server lost our player (gone too long) and made a fresh one:
          // the others no longer see the ice cream in our hand, so resend it
          const mine = held.get(ME);
          if (mine) S.net?.emit("action", { type: "iceCream", payload: mine.payload });
        }
        const ids = new Set((res.players || []).map((p) => p.id));
        for (const r of remote.list) if (!ids.has(r.id)) removeRemote(r.id);
        for (const p of res.players || []) {
          if (p.id === S.myId) continue;
          addRemote(p);
        }
        ui.setRoom(res.room);
        S.offlineToastShown = false;
        ui.chat({ system: true, text: "Reconnected to the museum ✅" });
      },
      look: (l) => remote.upsert(l.id, { look: l.look }),
      rateLimited: (r) => {
        // dropped actions (battle, photo, ice cream…) deserve a hint too
        if (r?.type !== "chat" && r?.type !== "action") return;
        const now = performance.now();
        if (now - S.lastRateToast < 3000) return;
        S.lastRateToast = now;
        ui.toast("Slow down a little 🙂");
      },
      playerJoined: (p) => {
        addRemote(p);
        // a reconnect (net.js fallback without playerRejoined) is not news
        if (p.rejoined) return;
        ui.chat({ system: true, text: `${p.name} joined the museum 🦖` });
        ui.toast(`${p.name} arrived`);
      },
      playerLeft: (p) => {
        removeRemote(p.id);
        if (p.rejoined) return;
        ui.chat({ system: true, text: `${p.name || "A visitor"} left` });
      },
      // another visitor's connection blipped: same avatar, new id, no chat line
      playerRejoined: (p) => {
        if (p.oldId !== p.id) removeRemote(p.oldId);
        addRemote(p);
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
          // only people in the shot see the flash, and never more than one every few seconds
          const r = remote.players.get(a.id);
          const p = S.player?.state;
          if (r && p && Math.hypot(r.x - p.x, r.z - p.z) < PHOTO_RADIUS) flashPhoto();
        } else if (a.type === "roar") {
          remote.action(a.id, "roar", 1.4);
          const rp = remote.players.get(a.id);
          bubble(rp, "🦖", "#ffc857");
          const me = S.player?.state;
          if (rp && me) audio.roar(1, { distance: Math.hypot(rp.x - me.x, rp.z - me.z) });
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
  // still inside the Join click: the one moment browsers let audio start
  audio.ensure();
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
      onTouchAction: () => useAction(),
    });
    upgradeCharacter(S.player.character);
    // your own name tag would just float in the middle of the view
    S.player.character.tag.visible = false;
    S.player.state.x = world.spawn.x;
    S.player.state.z = world.spawn.z;
    S.player.state.ry = world.spawn.ry;

    ui.setRoom(res.room, { solo: S.solo });
    ui.setHall(roomNameAt(world.spawn.x, world.spawn.z));
    ui.setCounters({ discovered: 0, total: EXHIBITS.length });
    for (const p of res.players || []) {
      if (p.id === S.myId) continue;
      addRemote(p);
    }
    ui.setPlayers(rosterList(), S.myId);
    ui.enterGame();
    ui.chat({
      system: true,
      text: S.solo
        ? "You are exploring alone. Chat messages stay on your screen."
        : `You are in room ${res.room}. Share the code so friends can join!`,
    });
    audio.ensure();
    audio.ambient(true);
    ui.setSound(audio.muted);
    if (audio.muted) ui.toast("Sound is off — press L or tap 🔇 sound to turn it on");
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
  // the player faces world (sin ry, cos ry): between two panels in reach,
  // prefer the one in front over the one behind or beside
  const fx = Math.sin(p.ry);
  const fz = Math.cos(p.ry);
  let best = null;
  let bestScore = Infinity;
  for (const it of world.interactables) {
    const dx = it.x - p.x;
    const dz = it.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d >= it.radius) continue;
    const facing = d > 0.01 ? (dx * fx + dz * fz) / d : 1;
    const score = d * (1 - 0.3 * facing);
    if (score < bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best;
}

/** Touch button / tapped prompt: the E key without a keyboard. */
function useAction() {
  if (!S.joined || !S.player) return;
  if (ui.isChatOpen() || anyPanelOpen()) return;
  if (S.player.isSitting) S.player.stand();
  else interact(nearestInteractable());
}

function inTheatre() {
  const p = S.player?.state;
  return !!p && roomAt(p.x, p.z)?.id === "theater";
}

/**
 * Start a screening on the shared theatre screen. Everyone in the room gets
 * the film, but the overlay, captions and roar are only for the audience.
 */
function startBattle(battleId) {
  const battle = battleById(battleId) || BATTLES[Math.floor(Math.random() * BATTLES.length)];
  S.currentBattleId = battle.id;
  cinema.play(battle.id);
  S.watchingBattle = false;
  if (!cinema.playing) {
    ui.hideBattle();
    return;
  }
  if (inTheatre()) {
    watchBattle(true);
    audio.roar(1, { zone: "theatre" });
  } else {
    ui.hideBattle();
  }
}

/** Show or hide the screening overlay (walking in or out of the theatre). */
function watchBattle(on) {
  on = on && cinema.playing;
  if (on === S.watchingBattle) return;
  S.watchingBattle = on;
  if (on) {
    ui.showBattle(cinema.current);
    ui.setBattleProgress(cinema.progress);
  } else {
    ui.hideBattle();
  }
}

function stopBattle() {
  cinema.stop();
  watchBattle(false);
}

function interact(it) {
  if (!it) return;
  switch (it.type) {
    case "exhibit": {
      const ex = exhibitById(it.exhibitId);
      if (!ex) return;
      if (!S.visited.has(ex.id)) {
        // points are for discoveries, not for re-reading the same card
        S.visited.add(ex.id);
        S.score += 10;
        S.net?.emit("action", { type: "score", payload: 10 });
        ui.setCounters({ discovered: S.visited.size });
        ui.toast(`Discovered ${ex.title} 🦴`, "good");
        audio.chime();
        fx.burst("sparkle", it.x, 2.2, it.z, 22);
      }
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
    case "seat": {
      const seat = it.seat;
      // the character's seat contact sits SIT_SEAT_OFFSET above its root
      // remotes see the sit through the 'sit' anim in the state stream
      if (S.player.sit({ x: seat.x, z: seat.z, ry: seat.ry, y: Math.max(0, seat.y - SIT_SEAT_OFFSET) })) {
        ui.toast(
          it.area === "theatre"
            ? "Enjoy the show 🍿 — press E at the console to pick a fight, W to stand"
            : "Taking a rest… press W to stand up"
        );
      }
      break;
    }
    case "era": {
      ui.setPrompt(null);
      eraView.open(it.era);
      document.body.classList.add("immersive");
      audio.duck(true);
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
          // the bonus is paid once per visit; replays are just for fun
          if (!S.puzzleSolved) {
            S.puzzleSolved = true;
            S.score += 25;
            S.net?.emit("action", { type: "score", payload: 25 });
            ui.toast("Skeleton assembled! +25 points 🏆", "good");
          } else {
            ui.toast("Skeleton assembled again! 🏆", "good");
          }
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

function roar() {
  const p = S.player.state;
  S.player.playAction("roar", 1.4);
  audio.roar(1);
  bubble(S.player, "🦖", "#ffc857");
  S.net?.emit("action", { type: "roar", payload: {} });
  fx.burst("dust", p.x, 0.4, p.z, 14);
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

// visitors this close to the camera are "in the shot"
const PHOTO_RADIUS = 14;

function takePhoto() {
  if (eraView.isOpen()) return;
  S.player?.playAction("photo", 1.2);
  audio.click(880);
  setTimeout(() => {
    if (eraView.isOpen()) return;
    try {
      // no preserveDrawingBuffer: draw a frame and read it back in the same task
      renderFrame();
      const url = renderer.domElement.toDataURL("image/jpeg", 0.75);
      const others = remote.list.filter(
        (r) => Math.hypot(r.x - S.player.state.x, r.z - S.player.state.z) < PHOTO_RADIUS
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

// someone else's camera flash: a soft, rate-limited pulse (photosensitivity)
const PHOTO_FLASH_GAP_MS = 3000;

function flashPhoto() {
  const now = performance.now();
  if (now - S.lastFlash < PHOTO_FLASH_GAP_MS) return;
  S.lastFlash = now;
  const flash = document.createElement("div");
  flash.style.cssText =
    "position:fixed;inset:0;background:#fff;opacity:0.4;z-index:35;pointer-events:none;transition:opacity .5s";
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
    S.leaving = true;
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
  // a held key must not re-trigger sit/stand, battles, photos or roars
  if (e.repeat) return;
  // the era view owns the keyboard (and handles Esc itself); the HUD and chat
  // are hidden underneath it
  if (eraView.isOpen()) return;
  if (e.code === "KeyT") {
    e.preventDefault();
    ui.openChat();
    return;
  }
  if (anyPanelOpen()) {
    if (e.code === "Escape") ui.closeAll();
    return;
  }
  switch (e.code) {
    case "Escape":
      if (ui.isBattleOpen()) stopBattle();
      break;
    case "KeyE":
      if (S.player.isSitting) S.player.stand();
      else interact(nearestInteractable());
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
      toggleSound();
      break;
    default:
      break;
  }
});

function anyPanelOpen() {
  return (
    ui.isModalOpen() ||
    ui.isCardOpen() ||
    ui.isIceOpen() ||
    eraView.isOpen() ||
    mediaOverlayOpen()
  );
}

canvas.addEventListener("click", () => {
  if (!S.joined) return;
  if (anyPanelOpen()) return;
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
/** ms between repeats of an unchanged state (remote.js holds a still avatar). */
const STATE_KEEPALIVE_MS = 1500;

/**
 * Tab hidden / page leaving: requestAnimationFrame stops, so tell the others
 * we stopped now instead of leaving them extrapolating a walk.
 */
function sendIdleNow() {
  if (!S.joined || !S.player || !S.net) return;
  const st = S.player.state;
  const anim = st.sitting ? "sit" : "idle";
  S.net.emit("state", { x: st.x, y: st.onGround ? st.y : 0, z: st.z, ry: st.ry, anim, ts: performance.now() });
  S.lastStateKey = null;
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) sendIdleNow();
});
window.addEventListener("pagehide", sendIdleNow);
let rosterTimer = 0;

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, clock.getDelta());

  if (S.joined && S.player) {
    // only react to panels opening/closing so other callers can still gate input
    const blocked = ui.isChatOpen() || anyPanelOpen();
    if (blocked !== S.inputBlocked) {
      S.inputBlocked = blocked;
      S.player.setInputEnabled(!blocked);
    }
    const vyBefore = S.player.state.vy;
    S.player.update(dt);
    for (const r of remote.list) {
      if (!r.upgraded) {
        r.upgraded = true;
        // the rigged model has its own hand: move any ice cream across
        const id = r.id;
        Promise.resolve(upgradeCharacter(r.character)).then((ok) => ok && reattachHeld(id));
      }
    }
    remote.update(dt);
    S.digCooldown = Math.max(0, S.digCooldown - dt);

    // footsteps: by distance actually walked on the ground (not in the air,
    // not running into a wall), and a heavier one on landing
    const st = S.player.state;
    const moved = Math.hypot(st.x - S.stepX, st.z - S.stepZ);
    S.stepX = st.x;
    S.stepZ = st.z;
    if (st.onGround && !st.sitting && moved < 2) {
      stepTimer += moved;
      if (stepTimer > 1.6) {
        stepTimer = 0;
        audio.step(0.6);
      }
    }
    if (st.onGround && !S.wasOnGround && vyBefore < -1.5) {
      audio.land(Math.min(1.6, Math.max(0.3, -vyBefore / 9)));
      stepTimer = 0;
    }
    S.wasOnGround = st.onGround;

    // interaction prompt (and the touch "use" button)
    const it = S.player.isSitting ? null : nearestInteractable();
    if (it) {
      ui.setPrompt(it.label, it.key);
    } else {
      ui.setPrompt(null);
    }
    S.player.setTouchAction(it && !S.inputBlocked ? it.label : null);

    const hallName = roomNameAt(S.player.state.x, S.player.state.z);
    ui.setHall(hallName);
    audio.setZone(hallName);
    // the screening overlay follows you in and out of the theatre
    watchBattle(cinema.playing && inTheatre());

    // network state
    const now = performance.now();
    if (now - S.lastSend > 90) {
      const key = `${st.x.toFixed(3)},${st.y.toFixed(3)},${st.z.toFixed(3)},${st.ry.toFixed(3)},${st.anim}`;
      // standing still: an unchanged state only as a keepalive
      const moving = st.anim === "walk" || st.anim === "run" || st.anim === "jump";
      if (moving || key !== S.lastStateKey || now - S.lastSend > STATE_KEEPALIVE_MS) {
        S.lastSend = now;
        S.lastStateKey = key;
        S.net?.emit("state", { x: st.x, y: st.y, z: st.z, ry: st.ry, anim: st.anim, ts: now });
      }
    }
  }

  vendor.update(dt, S.player?.state);

  // animated exhibits
  for (const a of world.animated) {
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
      ui.setPlayers(rosterList(), S.myId);
    }
  }

  renderFrame(dt);
}

function rosterList() {
  return [
    { id: S.myId, name: S.name, color: S.color, iceCream: held.get(ME)?.payload || null },
    ...remote.list.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      iceCream: held.get(r.id)?.payload || null,
    })),
  ];
}

function renderFrame(dt = 0) {
  if (eraView.isOpen()) {
    eraView.update(dt);
    eraView.render();
    return;
  }
  renderer.render(scene, camera);
}

window.addEventListener("eraview:close", (e) => {
  document.body.classList.remove("immersive");
  audio.duck(false);
  if (e.detail?.hadPointerLock) {
    // eraview re-locks when the close was a click; Esc does not allow that
    setTimeout(() => {
      if (!document.pointerLockElement && !eraView.isOpen() && !anyPanelOpen()) {
        ui.toast("Click to look around 🖱️");
      }
    }, 300);
  }
});

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
