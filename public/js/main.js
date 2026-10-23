import * as THREE from "three";
import { buildWorld, roomNameAt, roomAt, COURT, SCREEN, WAYFINDING } from "./world.js";
import { createPlayer } from "./player.js";
import { createRemotePlayers } from "./remote.js";
import { createMinimap } from "./minimap.js";
import { createCinema } from "./cinema.js";
import { createAudio } from "./audio.js";
import { createFX } from "./fx.js";
import { createUI, makeIceCream, FLAVOURS } from "./ui.js";
import { createNet } from "./net.js";
import { exhibitById, battleById, BATTLES, FACTS, EXHIBITS, EXTRA_SCREENINGS } from "./exhibits.js";
import { makeBubble } from "./util.js";
import { upgradeCharacter, preloadModels } from "./models.js";
import { SIT_SEAT_OFFSET, createCharacter } from "./character.js";
import { createEraView } from "./eraview.js";
import { createVideoPlayer, mediaOverlayOpen } from "./video.js";
import { applyLookdev } from "./lookdev.js";
import { placeLiveModels } from "./livemodels.js";
import { createBattlePicker, fetchVideoCatalogue } from "./battlepicker.js";
import { createScreenEmbed } from "./screen-embed.js";
import { createCrowd } from "./crowd.js";
import { buildGelateria } from "./gelato.js";
import { SPECIES } from "./species.js";
import { buildPlinthLabels } from "./labels.js";
import { buildWayfinding } from "./wayfinding.js";
import { buildScaleTapes } from "./scaletape.js";
import { createNarrator } from "./narrator.js";
import { getSettings, bindSettings } from "./settings.js";
import { openSettings, settingsOpen } from "./settingspanel.js";
import { createLoading, watchPerformance } from "./loading.js";
import { createAtmosphere } from "./atmosphere.js";
import { initQuiz, buildQuizKiosks, openQuiz, isQuizOpen, closeQuiz } from "./quiz.js";
import { createBigMap, teleportPlayer } from "./bigmap.js";
import { createTouchDock, pressKey } from "./touchdock.js";

preloadModels(["male", "female"]);

/* ------------------------------------------------------------------ */
/* renderer + scene                                                     */
/* ------------------------------------------------------------------ */
const canvas = document.getElementById("scene");
// alpha: the in-world YouTube embed shows through a transparent hole in the
// theatre screen (scene.background keeps every other pixel opaque)
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setClearColor(0x000000, 0);
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

// the visitor's saved preferences (quality, volumes, look, FOV, accessibility)
const settings = getSettings();

const camera = new THREE.PerspectiveCamera(
  settings.get("fov"),
  window.innerWidth / window.innerHeight,
  0.1,
  420
);
camera.position.set(0, 6, 20);

// real loading progress (the café label stays neutral until the court is found;
// `minimap` is declared further down and only asked from a later paint)
const loading = createLoading({ isRevealed: (id) => minimap.isRevealed(id) });

const world = buildWorld(scene);
// hall quiz kiosks go in first, so everything placed later keeps clear of them
const quizKiosks = buildQuizKiosks(world.group, world);
world.interactables.push(...quizKiosks.interactables);

/* ------------------------------------------------------------------ */
/* quality                                                              */
/* ------------------------------------------------------------------ */
const TIERS = ["low", "medium", "high", "ultra"];
const MOBILE =
  /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || !!window.matchMedia?.("(pointer: coarse)").matches;

/**
 * The starting tier. ?quality=low|medium|high|ultra (or ?lookdev=) picks one
 * and turns adaptation off; otherwise ("auto") it is guessed from the GPU,
 * then checked by a 2 s frame-time probe and adapted while you play:
 *   software rasteriser -> low; phone / tablet, integrated GPU, or a high-DPR
 *   screen without a strong GPU -> medium; strong GPU -> high. Ultra (GTAO)
 *   is never picked automatically.
 */
function pickQuality() {
  let asked = null;
  try {
    const p = new URLSearchParams(location.search);
    asked = (p.get("quality") || p.get("lookdev") || "").toLowerCase();
  } catch {
    /* ignore */
  }
  if (TIERS.includes(asked)) return { tier: asked, auto: false, gpu: "chosen" };
  // a tier picked in settings sticks (and turns adaptation off)
  const saved = settings.get("quality");
  if (saved !== "auto" && TIERS.includes(saved)) return { tier: saved, auto: false, gpu: "settings" };
  let gpu = "";
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    gpu = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    /* unknown */
  }
  if (/swiftshader|llvmpipe|software|softpipe/i.test(gpu)) return { tier: "low", auto: true, gpu };
  const strong = /nvidia|geforce|quadro|rtx|radeon\s*(rx|pro|r9|vii)|apple m\d+\s*(pro|max|ultra)/i.test(gpu);
  const integrated =
    /intel|iris|uhd|hd graphics|mali|adreno|powervr|apple gpu|radeon(\(tm\))? graphics|vega \d+ graphics/i.test(gpu) ||
    /apple m\d+(?!\s*(pro|max|ultra))/i.test(gpu);
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 8;
  const highDpr = (window.devicePixelRatio || 1) >= 1.75;
  const weak = MOBILE || integrated || cores <= 4 || memory <= 4 || (highDpr && !strong);
  return { tier: weak ? "medium" : "high", auto: true, gpu };
}
const QPICK = pickQuality();
/** Tier for props / live models / crowd ("ultra" only changes post-processing). */
let QUALITY = MOBILE ? "low" : QPICK.tier === "ultra" ? "high" : QPICK.tier;
const lookdev = applyLookdev({ renderer, scene, camera, quality: QPICK.tier, adaptive: QPICK.auto });
/** Visitors in the background crowd per tier. */
const CROWD_COUNT = { low: 3, medium: 6, high: 12 };

/* ------------------------------------------------------------------ */
/* staged boot: the heavy dressing loads after the first frames         */
/* ------------------------------------------------------------------ */
// Nothing below blocks the join screen: live exhibits, props and the crowd
// are created one at a time in idle time once the first frames are drawn
// (and the frame-time probe has settled the tier). The Ice Cream Court's bar
// and vendor are only built when a visitor nears the Jurassic Hall exit.
let live = null;
let crowd = null;
let gelateria = null;
let vendor = null;
let extinction = null; // the Extinction Room's projection show (extinction.js)
let dioramas = null; // living diorama windows in the era halls (diorama.js)
let resolveProps;
const propsReady = new Promise((r) => (resolveProps = r));

const whenIdle = (fn, timeout = 1200) =>
  new Promise((resolve, reject) => {
    const run = () => {
      try {
        resolve(fn());
      } catch (err) {
        reject(err);
      }
    };
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(run, { timeout });
    else setTimeout(run, 30);
  });

/**
 * Keep a freshly added group out of the picture until its shaders are
 * compiled (in parallel) and warmed, so it pops in on a later frame instead
 * of freezing the one it first appears in. Layers, not .visible: the
 * compiler skips invisible objects but not other layers.
 */
async function stageIn(root) {
  if (!root) return;
  const masks = [];
  root.traverse((o) => {
    masks.push(o, o.layers.mask);
    o.layers.disableAll();
  });
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => lookdev.compileAsync?.())
        .then(() => warmPrograms(root)),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  } catch {
    /* draw it anyway */
  } finally {
    for (let i = 0; i < masks.length; i += 2) masks[i].layers.mask = masks[i + 1];
  }
}

// the loading screen waits for each staged step (registered now, closed as each lands)
const endLive = loading.add("live models", "dinosaurs");
const endProps = loading.add("props", "exhibits");
const endCrowd = loading.add("crowd", "cafe");

async function bootAmbient() {
  // life-size and scale models: plinths now, the models stream in by distance
  await whenIdle(() => {
    live = placeLiveModels({ scene, world, camera, quality: QUALITY });
    window.__museum.live = live;
    return stageIn(scene.getObjectByName("live-models"));
  })
    .catch((err) => console.warn("live exhibits: could not place them", err))
    .finally(endLive);
  // best-effort: a prop that fails to load leaves the primitive in its place
  await whenIdle(() => import("./props.js"))
    .then((m) => m.placeProps({ scene, world, renderer, quality: QUALITY }))
    .then((props) => {
      window.__museum.props = props;
      return stageIn(scene.getObjectByName("props"));
    })
    .catch((err) => console.warn("props: could not dress the halls", err))
    .finally(endProps);
  resolveProps();
  // background visitors (local only, never networked, no name tags)
  await whenIdle(() => {
    crowd = createCrowd({ scene, world, camera, count: CROWD_COUNT[QUALITY] ?? 6, quality: QUALITY });
    window.__museum.crowd = crowd;
    return crowd.ready?.then(() => stageIn(crowd.root));
  })
    .catch((err) => console.warn("crowd: could not create it", err))
    .finally(endCrowd);
  // the immersive projection room: builds itself once a visitor is close
  await whenIdle(() => import("./extinction.js"))
    .then((m) => {
      extinction = m.createExtinctionRoom({ scene, camera, renderer, audio, quality: QUALITY, reducedMotion: () => !!settings.get("reducedMotion") });
      window.__museum.extinction = extinction;
    })
    .catch((err) => console.warn("extinction room: could not create it", err));
  // diorama cases in the era halls; each scene behind the glass loads on approach
  await whenIdle(() => import("./diorama.js"))
    .then((m) => {
      dioramas = m.createDioramas({ scene, renderer, camera, quality: () => lookdev.quality });
      window.__museum.dioramas = dioramas;
      return stageIn(dioramas.root);
    })
    .catch((err) => console.warn("dioramas: could not build them", err));
}

// the Jurassic Hall's exit doorway: the court is built when a visitor nears it
const EXIT_SIGN = WAYFINDING.find((w) => w.dest === "court") || { x: COURT.exitX, z: COURT.exitZ };
const COURT_ROOMS = new Set(["xpassage", "court"]);
const COURT_REACH = 16;
let courtTimer = 0;
function nearCourt(x, z) {
  const id = roomAt(x, z)?.id;
  return COURT_ROOMS.has(id) || (id === "jurassic" && Math.hypot(x - EXIT_SIGN.x, z - EXIT_SIGN.z) < COURT_REACH);
}
function updateCourt(dt) {
  if (vendor) return;
  courtTimer -= dt;
  if (courtTimer > 0) return;
  courtTimer = 0.5;
  let near = S.player ? nearCourt(S.player.state.x, S.player.state.z) : false;
  // a friend holding the door open counts too (their ice cream should not pop in)
  for (let i = 0; !near && i < remote.list.length; i++) near = nearCourt(remote.list[i].x, remote.list[i].z);
  if (near) openCourt();
}
/** Build the gelato bar and its vendor (once). */
function openCourt() {
  if (vendor) return;
  vendor = createVendor();
  propsReady
    .then(() => {
      // the gelato bar replaces the primitive kiosk once the halls are dressed
      gelateria = buildGelateria({ scene, world, COURT, renderer, quality: QUALITY });
      window.__museum.gelateria = gelateria;
    })
    .catch((err) => console.warn("gelato: could not build the bar", err));
}

/**
 * The 2 s frame-time probe (auto only): if the first tier cannot hold its
 * frame rate here, step down before the heavy dressing is even loaded.
 */
function probeFrames() {
  return new Promise((resolve) => {
    if (!QPICK.auto) return resolve();
    const times = [];
    let last = 0;
    let skip = 15; // shader compiles and first uploads
    const t0 = performance.now();
    const tick = (now) => {
      if (last && skip-- <= 0) times.push(now - last);
      last = now;
      if (now - t0 < 2600 && document.visibilityState === "visible") requestAnimationFrame(tick);
      else done();
    };
    const done = () => {
      if (times.length >= 10) {
        times.sort((a, b) => a - b);
        const median = times[times.length >> 1];
        const tier = lookdev.quality;
        let next = tier;
        if (tier === "high" && median > 26) next = median > 45 ? "low" : "medium";
        else if (tier === "medium" && median > 45) next = "low";
        if (next !== tier) {
          console.info(`[quality] ${tier} -> ${next} (median frame ${median.toFixed(1)} ms)`);
          lookdev.setQuality(next);
          if (!MOBILE) QUALITY = next;
        }
        S.probe = { median: +median.toFixed(1), from: tier, to: next };
      }
      resolve();
    };
    requestAnimationFrame(tick);
  });
}

// Hall dressing that has to see the props: brass plinth labels, wayfinding
// totems + hall intro panels, then the life-size floor tapes (which route
// around everything before them). Each one is its own task, so a slow device
// keeps drawing frames and answering the server between them, and each is
// isolated, so one failing never takes the others down.
let wayfinding = null;
let scaleTapes = null;
const nextTask = () => new Promise((r) => setTimeout(r, 0));
function dressStep(label, build) {
  try {
    build();
  } catch (err) {
    console.warn(`${label}: could not be placed`, err);
  }
  return nextTask();
}
const endDressing = loading.add("hall dressing", "exhibits");
propsReady
  .then(nextTask)
  .then(() =>
    dressStep("labels", () => {
      window.__museum.labels = buildPlinthLabels(world.group, world);
      lookdev.refresh(); // the stands get the gallery's wood trim
    })
  )
  .then(() =>
    dressStep("wayfinding", () => {
      wayfinding = buildWayfinding(world.group, world, { scene, renderer, quality: QUALITY });
      world.interactables.push(...wayfinding.interactables);
      window.__museum.wayfinding = wayfinding;
    })
  )
  .then(() =>
    dressStep("scale tapes", () => {
      scaleTapes = buildScaleTapes(scene, world, SPECIES, { scene });
      window.__museum.scaleTapes = scaleTapes;
    })
  )
  .finally(endDressing);


/** Floor finish under a point, for footstep sounds (matches lookdev's floors). */
const FLOOR_SURFACE = {
  lobby: "marble",
  rotunda: "marble",
  porch: "stone",
  theater: "carpet",
  triassic: "parquet",
  jurassic: "parquet",
  cretaceous: "parquet",
  marine: "parquet",
  predator: "parquet",
};
function surfaceAt(x, z) {
  return FLOOR_SURFACE[roomAt(x, z)?.id] || "stone";
}

const fx = createFX(scene);
const audio = createAudio();
// quality, field of view and the volumes follow the settings store live
const boundSettings = bindSettings({ settings, lookdev, camera, audio });
const remote = createRemotePlayers(scene);
const minimap = createMinimap(document.getElementById("minimap"));
// the audio guide; secret rooms stay silent until the minimap reveals them
const narrator = createNarrator({
  audio,
  settings,
  stopHint: "N",
  isRevealed: (id) => minimap.isRevealed(id),
});
// the full-screen museum map, with fast travel to halls already visited
const bigMap = createBigMap({
  getLocal: () => S.player?.state || null,
  getPlayers: () => remote.list.map((r) => ({ x: r.x, z: r.z, color: r.color, name: r.name })),
  // secret rooms appear on the big map as soon as the minimap reveals them
  isRevealed: (id) => minimap.isRevealed(id),
  onTravel: (roomId, point) => {
    if (!S.player) return;
    teleportPlayer(S.player, point);
    const name = roomNameAt(point.x, point.z);
    ui.setHall(name);
    ui.toast(`Travelled to ${name}`);
  },
});
const eraView = createEraView({ renderer });
const videoPlayer = createVideoPlayer();
const screenEmbed = createScreenEmbed({ renderer, camera, screenMesh: world.screen });

// verified clips per species / battle (in-site only: no routing out to YouTube)
let catalogue = {};
fetchVideoCatalogue().then((data) => {
  catalogue = data;
});

const picker = createBattlePicker({
  battles: BATTLES,
  extra: EXTRA_SCREENINGS,
  onPlay3D: (id) => {
    stopEmbed();
    S.net?.emit("action", { type: "battle", payload: { id } });
    startBattle(id);
  },
  onPlayVideo: (video, battle) => {
    if (inTheatre()) {
      // on the big screen, for you: the shared 3D screening makes way
      picker.close();
      cinema.stop();
      watchBattle(false);
      narrator.stop();
      if (!screenEmbed.play(video.id, { title: video.title })) return;
      audio.duck(true);
      ui.toast(`🎬 ${video.title}${video.channel ? ` · ${video.channel}` : ""} — Esc to stop`);
    } else {
      narrator.stop();
      videoPlayer.open(video, battle?.videos || null);
    }
  },
});

/** Stop the YouTube clip on the theatre screen (if one is playing). */
function stopEmbed() {
  if (!screenEmbed.playing) return false;
  screenEmbed.stop();
  audio.duck(false);
  return true;
}

/* ------------------------------------------------------------------ */
/* the ice cream vendor behind the counter                              */
/* ------------------------------------------------------------------ */
// built by openCourt() when a visitor nears the court (it loads a rigged model)
function createVendor() {
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
}

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
    vendor?.celebrate();
    ui.toast(`${flavourName(payload.flavour)} — enjoy! Press F to eat it 🍦`, "good");
    fx.burst("confetti", S.player.state.x, S.player.state.y + 1.6, S.player.state.z, 26);
  },
  onStopBattle: () => stopBattle(),
  hasExhibitVideos: (ex) => (catalogue.species?.[ex.id] || []).length > 0,
  onExhibitVideos: (ex) => {
    // verified clips from /data/videos.json, played in the site
    const list = catalogue.species?.[ex.id] || [];
    if (list.length) narrator.stop();
    if (!(list.length && videoPlayer.open(list[0], list))) ui.toast("No videos for this one yet");
  },
  onLookChange: () => {
    if (S.player) S.player.setLook(ui.look);
  },
  // a tap on the prompt (or the touch "use" button) does what E does
  onPromptTap: () => useAction(),
  onToggleSound: () => toggleSound(),
  // the exhibit card's 🎧 Listen chip: start (or stop) the audio guide talk
  onListen: (ex) => toggleGuide(ex),
  onSettings: () => showSettings(),
});

/* ------------------------------------------------------------------ */
/* feature systems that need the UI                                     */
/* ------------------------------------------------------------------ */
initQuiz({
  toast: (text, kind) => ui.toast(text, kind),
  onComplete: (r) => {
    if (!r.firstPerfect) return;
    S.score += 15;
    S.net?.emit("action", { type: "score", payload: 15 });
    audio.chime();
  },
});

// PA announcements and the crowd murmur (secret rooms are never named before they are found)
const atmosphere = createAtmosphere({
  audio,
  narrator,
  ui,
  getState: () => ({
    x: S.joined && S.player ? S.player.state.x : null,
    z: S.joined && S.player ? S.player.state.z : null,
    busy:
      cinema.playing || screenEmbed.playing || videoPlayer.isOpen() || eraView.isOpen() || mediaOverlayOpen(),
    remotes: remote.list,
    npcs: crowd?.npcs || [],
    reduced: !!settings.get("reducedMotion") || QUALITY === "low",
    speech: settings.get("narration") !== false,
    pa: settings.get("announcements") !== false,
    revealed: (id) => minimap.isRevealed(id),
  }),
});

// on "auto" quality, sustained slow frames step the graphics down a level
const LOOKDEV_PINNED = new URLSearchParams(location.search).has("lookdev");
const perf = watchPerformance({
  level: lookdev.quality,
  onDrop: ({ to, fps }) => {
    if (LOOKDEV_PINNED || settings.get("quality") !== "auto") return false;
    lookdev.setQuality(to, { manual: false });
    ui.toast(`Running at ${fps} fps, switched graphics to ${to}`);
  },
});
// lookdev adapts the tier to the frame time itself (QPICK.auto), so this second
// governor stays off; it is kept only for its level bookkeeping
perf.stop();
settings.watch("quality", () => perf.setLevel(lookdev.quality));

// reduced motion: a class for the CSS (settings.js also sets data-reduced-motion)
// and no head bob for the player
settings.watch("reducedMotion", (on) => {
  document.documentElement.classList.toggle("reduced-motion", !!on);
  S.player?.setReducedMotion?.(on);
});

/** The settings panel (O key or the ⚙ chip in the HUD). */
function showSettings() {
  return openSettings({
    settings,
    getStats: () => lookdev.stats(),
    onTestSound: (kind) => (kind === "music" ? audio.chime(392) : audio.chime()),
  });
}

/** The audio guide for an exhibit: the same exhibit again stops it. */
function toggleGuide(ex) {
  if (!ex) return;
  if (narrator.speaking && narrator.current === ex.id) narrator.stop();
  else narrator.speakExhibit(ex);
}

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
  // a fresh order replaces the one being eaten
  if (mine) S.eating = null;
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

/** How long it takes to finish an ice cream, bite by bite. */
const EAT_SECONDS = 5;
const EAT_BITES = 5;

/** Start eating the ice cream in your hand (F). */
function eatIceCream() {
  if (!held.has(ME) || S.eating) return;
  S.eating = { t: 0, bite: 0 };
  ui.toast("Mmm… 🍦");
}

/** Advance eating: a bite every second, the scoops shrink, then it is gone. */
function updateEating(dt) {
  const e = S.eating;
  const h = held.get(ME);
  if (!e || !h) {
    S.eating = null;
    return;
  }
  e.t += dt;
  const bite = Math.min(EAT_BITES, Math.floor((e.t / EAT_SECONDS) * EAT_BITES) + 1);
  if (bite !== e.bite) {
    e.bite = bite;
    S.player.playAction("eat", EAT_SECONDS / EAT_BITES);
    audio.slurp();
  }
  // what is left of it, never quite zero until the last bite
  const left = Math.max(0.15, 1 - e.t / EAT_SECONDS);
  h.prop.scale.setScalar(left);
  if (e.t >= EAT_SECONDS) {
    S.eating = null;
    dropIceCream(S.myId);
    S.net?.emit("action", { type: "iceCreamDone", payload: {} });
    ui.toast("All gone — that was delicious! 😋", "good");
  }
}

/** Remove a finished ice cream from someone's hand. */
function dropIceCream(id) {
  const mine = id === S.myId;
  const key = mine ? ME : id;
  const h = held.get(key);
  if (!h) return;
  if (mine) S.player?.character.setHeld(null);
  else remote.setHeld(id, null);
  held.delete(key);
  disposeObject(h.prop);
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
        } else if (a.type === "iceCreamDone") {
          remote.action(a.id, "eat", 1.2);
          dropIceCream(a.id);
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
    // look sensitivity / invert Y, and no head bob with reduced motion
    boundSettings.attachPlayer(S.player);
    S.player.setReducedMotion?.(settings.get("reducedMotion"));
    // phone / tablet action buttons (no-op on mouse + keyboard)
    S.dock = createTouchDock({ onAction: pressKey });
    window.__museum.dock = S.dock;
    upgradeCharacter(S.player.character);
    // compile the avatar's shaders in parallel (the loading card is up)
    stageIn(S.player.character.group);
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
    collapseKeyHelpLater();
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
  // seated in the theatre, E chooses the fight; anywhere else it stands you up
  if (S.player.isSitting) {
    if (inTheatre()) picker.open();
    else S.player.stand();
  } else interact(nearestInteractable());
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
  // a shared screening takes the screen back from a personal YouTube clip
  stopEmbed();
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
    narrator.stop();
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
      S.cardExhibit = ex;
      ui.showExhibit(ex);
      break;
    }
    case "battle": {
      picker.open();
      break;
    }
    case "guide": {
      const fact = FACTS[Math.floor(Math.random() * FACTS.length)];
      ui.modal(`
        <h2>🎟️ Museum Guide</h2>
        <p class="quote">Welcome to the Dinosaur Museum! You have found ${S.visited.size} of
        ${EXHIBITS.length} exhibits so far. There is also a screening theatre with comfy seats, a dig site — and a little surprise
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
            ? "Enjoy the show 🍿 — press E to choose a fight, W to stand"
            : "Taking a rest… press W to stand up"
        );
      }
      break;
    }
    case "era": {
      ui.setPrompt(null);
      narrator.stop();
      eraView.open(it.era);
      document.body.classList.add("immersive");
      audio.duck(true);
      break;
    }
    case "totem":
    case "intro": {
      const d = wayfinding?.describe(it);
      if (!d) return;
      ui.modal(d.html);
      const close = document.querySelector("#modalBody #wayClose"); // wayfinding.js builds it
      if (close) close.onclick = () => ui.closeModal();
      break;
    }
    case "quiz": {
      ui.setPrompt(null);
      openQuiz(it.hall);
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
  audio.roar(1, { kind: "visitor" });
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
    if (e.code === "Escape") {
      ui.closeAll();
      closeQuiz();
    } else if (e.code === "KeyN" && ui.isCardOpen()) {
      // the audio guide also works with the exhibit card open: N stops
      // whatever is playing (the caption says so), else reads this card
      if (narrator.speaking) narrator.stop();
      else if (S.cardExhibit) narrator.speakExhibit(S.cardExhibit);
    }
    return;
  }
  switch (e.code) {
    case "Escape":
      if (stopEmbed()) break;
      if (ui.isBattleOpen()) stopBattle();
      break;
    case "KeyE":
      useAction();
      break;
    case "KeyV":
      roar();
      break;
    case "KeyB":
      S.player.playAction("wave", 1.2);
      bubble(S.player, "👋", S.color);
      S.net?.emit("action", { type: "wave", payload: {} });
      break;
    case "KeyF":
      if (nearestInteractable()?.type === "dig") dig();
      else if (held.has(ME)) eatIceCream();
      else ui.toast("Press F at the dig site to dig");
      break;
    case "KeyG":
      interact(nearestInteractable()?.type === "photo" ? nearestInteractable() : { type: "photo" });
      break;
    case "KeyC":
      ui.toast(S.player.toggleCamera() === 0 ? "Third person camera" : "First person camera");
      break;
    case "KeyM":
      // Shift+M keeps the old minimap size toggle; the map closes itself on M / Esc
      if (e.shiftKey) document.getElementById("minimap").classList.toggle("big");
      else bigMap.open();
      break;
    case "KeyL":
      toggleSound();
      break;
    case "KeyN": {
      if (narrator.speaking) {
        narrator.stop();
        break;
      }
      const it = nearestInteractable();
      const ex = it?.type === "exhibit" ? exhibitById(it.exhibitId) : null;
      if (ex) narrator.speakExhibit(ex);
      else ui.toast("Stand at an exhibit and press N for the audio guide 🎧");
      break;
    }
    case "KeyO":
      showSettings();
      break;
    default:
      break;
  }
});

function anyPanelOpen() {
  return (
    bigMap.isOpen() ||
    settingsOpen() ||
    isQuizOpen() ||
    ui.isModalOpen() ||
    ui.isCardOpen() ||
    ui.isIceOpen() ||
    eraView.isOpen() ||
    picker.isOpen() ||
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
  // sizes the renderer and the post-processing chain
  lookdev.resize(window.innerWidth, window.innerHeight);
  screenEmbed.resize();
});

/* ------------------------------------------------------------------ */
/* HUD                                                                  */
/* ------------------------------------------------------------------ */
// touch keyboards focus the chat box directly (no T key): mark it open so
// the movement keys typed into it don't also walk the avatar
document.getElementById("chatInput")?.addEventListener("focus", (e) => e.target.classList.add("open"));

let keysTouched = false;
document.getElementById("toggleKeys")?.addEventListener("click", (e) => {
  // runs after ui.js's own toggle
  keysTouched = true;
  const collapsed = document.getElementById("keyHelp")?.classList.contains("collapsed");
  e.currentTarget.setAttribute("aria-expanded", collapsed ? "false" : "true");
});

/** The controls panel tucks itself away after a while, unless the visitor chose. */
function collapseKeyHelpLater() {
  setTimeout(() => {
    const help = document.getElementById("keyHelp");
    const btn = document.getElementById("toggleKeys");
    if (keysTouched || !help || !btn || help.classList.contains("collapsed")) return;
    help.classList.add("collapsed");
    btn.textContent = "show";
    btn.setAttribute("aria-expanded", "false");
  }, 10000);
}

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

/** Ambient systems updated every frame; getters, as most are created late. */
const AMBIENT = [
  ["vendors", () => vendor],
  ["live exhibits", () => live],
  ["crowd", () => crowd],
  ["atmosphere", () => atmosphere],
  ["extinction room", () => extinction],
  ["dioramas", () => dioramas],
];
const MAP = { local: { x: 0, z: 0, ry: 0 }, remotes: [] };
let mapTick = false;
/** Behind the join screen (a blurred, nearly opaque card) a third of the frames is plenty. */
let joinFrame = 0;
let probing = true;

function animate() {
  requestAnimationFrame(animate);
  const throttled = !S.joined && !probing && !eraView.isOpen();
  lookdev.hold = throttled;
  if (throttled && ++joinFrame % 3 !== 0) return;
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
    bigMap.track(S.player.state.x, S.player.state.z);
    for (const r of remote.list) {
      if (!r.upgraded) {
        r.upgraded = true;
        // the rigged model has its own hand: move any ice cream across
        const id = r.id;
        Promise.resolve(upgradeCharacter(r.character)).then((ok) => ok && reattachHeld(id));
      }
    }
    remote.update(dt, camera);
    S.digCooldown = Math.max(0, S.digCooldown - dt);
    if (S.eating) updateEating(dt);

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
        audio.step(0.6, surfaceAt(st.x, st.z));
      }
    }
    if (st.onGround && !S.wasOnGround && vyBefore < -1.5) {
      audio.land(Math.min(1.6, Math.max(0.3, -vyBefore / 9)), surfaceAt(st.x, st.z));
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
    const useLabel = it && !S.inputBlocked ? it.label : null;
    S.player.setTouchAction(useLabel); // its button is hidden by touchdock.css when the dock is up
    if (S.dock) {
      S.dock.setUseLabel(useLabel);
      const canDig = it?.type === "dig";
      S.dock.setEatAvailable(!S.inputBlocked && (canDig || held.has(ME)), canDig ? "Dig" : "Eat");
      S.dock.setVisible(S.joined);
    }

    const hallName = roomNameAt(S.player.state.x, S.player.state.z);
    ui.setHall(hallName);
    audio.setZone(hallName);
    // hall intros, once per visit; held during a screening, a video, the era
    // view or while the visitor is busy with the quiz, the map or the settings
    const guideQuiet =
      inTheatre() || mediaOverlayOpen() || eraView.isOpen() || isQuizOpen() || bigMap.isOpen() || settingsOpen() || !!extinction?.inside;
    // the Extinction Room's show has its own sound and captions: a hall welcome
    // still running from the doorway stops as you walk in
    if (extinction?.inside && narrator.speaking && narrator.current.startsWith("hall:")) narrator.stop();
    narrator.tick(roomAt(S.player.state.x, S.player.state.z)?.id, { quiet: guideQuiet });
    // a talk over an open exhibit card or popup: it makes room for the subtitles
    const guideCard = narrator.speaking && (ui.isCardOpen() || ui.isModalOpen());
    if (guideCard !== S.guideCard) {
      S.guideCard = guideCard;
      document.body.classList.toggle("guide-card", guideCard);
    }
    // the card's Listen chip turns into Stop while its own talk is playing
    if (ui.isCardOpen()) ui.setListening(narrator.speaking && narrator.current === S.cardExhibit?.id);
    // standing on a life-size floor tape: say how far along the animal you are
    tapeHint(dt);
    // the screening overlay follows you in and out of the theatre
    const inside = inTheatre();
    watchBattle(cinema.playing && inside);
    // a YouTube clip on the big screen is only for the audience
    if (!inside && stopEmbed()) ui.toast("The clip stopped when you left the theatre");

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

  // Ambient life. Each system is isolated so one bad npc can never freeze the
  // whole museum (a throw here used to stop the frame before it was rendered).
  for (let i = 0; i < AMBIENT.length; i++) {
    const [name, get] = AMBIENT[i];
    const system = get();
    if (!system) continue; // not created yet (staged boot)
    try {
      system.update(dt, S.player?.state, remote.list);
    } catch (err) {
      if (!S.ambientErrors) S.ambientErrors = new Set();
      if (!S.ambientErrors.has(name)) {
        S.ambientErrors.add(name);
        console.error(`Ambient update failed (${name}); continuing without it:`, err);
      }
    }
  }
  // exhibit photos stream in and out around the visitor (or the camera
  // behind the join screen)
  if (S.player) world.photos.update(dt, S.player.state.x, S.player.state.z);
  else world.photos.update(dt, camera.position.x, camera.position.z);
  // exhibit lights come up as the local visitor walks up to them
  if (S.player && world.presence) world.presence.update(dt, S.player.state.x, S.player.state.z);
  if (S.joined) updateCourt(dt);

  // animated exhibits
  const lavaNow = performance.now();
  for (let i = 0; i < world.animated.length; i++) {
    const a = world.animated[i];
    if (a.type === "lava") {
      a.mesh.material.emissiveIntensity = a.base + Math.sin(lavaNow / 260) * 0.5 + Math.random() * 0.3;
    }
  }

  cinema.update(dt);
  cinema.render();
  fx.update(dt);
  wayfinding?.update(dt);
  quizKiosks.update?.(clock.elapsedTime);

  // minimap
  if (S.joined && S.player) {
    // 30 Hz is plenty for the minimap (a full 2D canvas redraw), and its
    // arguments are reused instead of rebuilt every frame
    mapTick = !mapTick;
    if (mapTick) {
      MAP.local.x = S.player.state.x;
      MAP.local.z = S.player.state.z;
      MAP.local.ry = S.player.state.ry;
      const list = remote.list;
      while (MAP.remotes.length < list.length) MAP.remotes.push({ x: 0, z: 0, color: "" });
      MAP.remotes.length = list.length;
      for (let i = 0; i < list.length; i++) {
        const m = MAP.remotes[i];
        m.x = list[i].x;
        m.z = list[i].z;
        m.color = list[i].color;
      }
      minimap.draw(MAP);
    }
    rosterTimer -= dt;
    if (rosterTimer <= 0) {
      rosterTimer = 0.35;
      ui.setPlayers(rosterList(), S.myId);
      // the scoops counter would give the secret ending away: it appears with the court
      const scoops = document.getElementById("statScoops")?.parentElement;
      if (scoops) scoops.classList.toggle("hidden", !minimap.isRevealed("court"));
    }
  }

  renderFrame(dt);
}

/**
 * The floor tapes: the first time the visitor steps onto one, a toast says
 * how far along the animal they are standing ("5 m along the T. rex").
 */
const TAPE_CHECK_S = 0.4;
let tapeTimer = 0;
let tapeOn = null;
const tapesHinted = new Set();
function tapeHint(dt) {
  tapeTimer -= dt;
  if (tapeTimer > 0 || !scaleTapes?.measureAt || !S.player) return;
  tapeTimer = TAPE_CHECK_S;
  let m = null;
  try {
    m = scaleTapes.measureAt(S.player.state.x, S.player.state.z);
  } catch {
    m = null;
  }
  const id = m?.id || null;
  if (id === tapeOn) return;
  tapeOn = id;
  if (!m || tapesHinted.has(id) || anyPanelOpen()) return;
  tapesHinted.add(id);
  const along = Math.max(0, Math.round(m.metres ?? 0));
  const total = Math.round(m.length || 0);
  ui.toast(
    m.wingspan
      ? `📏 You're ${along} m across ${m.name}'s ${total} m wingspan`
      : `📏 You're ${along} m along ${m.name}, ${total} m nose to tail`
  );
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
  if (screenEmbed.playing) {
    // post-processing may fill the alpha hole the clip shows through
    renderer.render(scene, camera);
    screenEmbed.render();
    return;
  }
  lookdev.render();
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

// Shaders compile in parallel (KHR_parallel_shader_compile) before the first
// frame, so the join screen stays responsive instead of freezing for a second
// on the first draw (after the HDRI, which those shaders depend on). Never
// waits more than 6 s.
/**
 * The first draw with a program also reads back its uniform / attribute
 * tables, which waits for the driver (~300 ms for this scene). Do that now,
 * a few programs per task, so no single task holds the page for long.
 */
const TEX_SLOTS = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap", "lightMap", "bumpMap"];
const warmedTextures = new WeakSet();
function warmPrograms(root = scene) {
  const list = (renderer.info.programs || []).slice();
  // ...and upload the textures the same way (the first frame used to upload
  // every caption, name card and floor map in one go)
  const textures = [];
  root.traverse((o) => {
    if (!o.material || !o.layers) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const k of TEX_SLOTS) {
        const t = m[k];
        if (t && t.isTexture && !t.isRenderTargetTexture && !warmedTextures.has(t) && t.image) {
          warmedTextures.add(t);
          textures.push(t);
        }
      }
    }
  });
  return new Promise((resolve) => {
    const step = () => {
      const t = performance.now();
      while ((list.length || textures.length) && performance.now() - t < 24) {
        try {
          if (list.length) {
            const p = list.pop();
            p.getUniforms();
            p.getAttributes();
          } else {
            renderer.initTexture(textures.pop());
          }
        } catch {
          /* a broken program / image shows up on draw as before */
        }
      }
      if (list.length || textures.length) setTimeout(step, 0);
      else resolve();
    };
    step();
  });
}
const compileStart = performance.now();
Promise.race([
  Promise.resolve(lookdev.envReady)
    .then(() => (lookdev.compileAsync ? lookdev.compileAsync() : renderer.compileAsync?.(scene, camera)))
    .then(() => warmPrograms())
    .then(() => "compiled")
    .catch(() => "failed"),
  new Promise((r) => setTimeout(() => r("timeout"), 6000)),
]).then((how) => {
  S.compile = { how, ms: Math.round(performance.now() - compileStart) };
  startLoop();
});

function startLoop() {
  animate();
  // after the first frames: check the tier, then dress the halls in idle time
  requestAnimationFrame(() =>
  probeFrames()
    .catch(() => {})
    .then(() => {
      probing = false;
      return bootAmbient();
    })
  );
}

// tapping the minimap opens the full museum map (touch and mouse)
document.getElementById("minimap")?.addEventListener("click", () => {
  if (S.joined && !anyPanelOpen()) bigMap.open();
});

// expose a tiny debug handle (used by the console and by the browser tests)
window.__museum = {
  crowd: null,
  live: null,
  gelateria: null,
  get vendor() {
    return vendor;
  },
  openCourt,
  get quality() {
    return { tier: lookdev.quality, systems: QUALITY, auto: QPICK.auto, gpu: QPICK.gpu, probe: S.probe || null };
  },
  scene,
  renderer,
  camera,
  S,
  world,
  cinema,
  remote,
  roomAt,
  get net() {
    return S.net;
  },
  lookdev,
  picker,
  screenEmbed,
  videoPlayer,
  props: null,
  gelateria: null,
  labels: null,
  wayfinding: null,
  scaleTapes: null,
  quiz: quizKiosks,
  narrator,
  settings,
  bigMap,
  atmosphere,
  loading,
  perf,
  dock: null,
  get player() {
    return S.player;
  },
};
