/**
 * Audio guide: a spoken narrator built on the Web Speech API (no audio files)
 * with a subtitle box that shows the sentence being spoken.
 *
 *   const narrator = createNarrator({ audio, settings });
 *   narrator.speak("Welcome to the museum.", { onEnd })
 *   narrator.speakExhibit(exhibitById("trex"))      // 20–40 s exhibit talk
 *   narrator.hallIntro("triassic")                  // once per visit per hall
 *   narrator.tick(roomAt(x, z)?.id, { quiet })      // per frame: intros on entry
 *   narrator.stop()
 *   narrator.speaking / narrator.current / narrator.available
 *
 * How it plays
 * - Text is split into sentences and each one is its own utterance. Chrome
 *   silently drops long utterances (~15 s), and one sentence at a time is what
 *   the subtitle box shows anyway. Boundary events, where the voice sends
 *   them, dim the words not yet said.
 * - Voice: the most natural en-GB voice, then en-US, then any English one
 *   (network "Google UK English" / "Natural" / "Premium" voices score high,
 *   macOS novelty voices are never picked). Rate 0.95.
 * - The museum ambience is ducked (audio.duck) while the guide talks and
 *   restored afterwards, unless something else (a video) had ducked it first.
 * - No speechSynthesis, the game sound muted, or an engine that never starts
 *   talking (headless Linux has no voices): the same script plays as timed
 *   subtitles only, so a Listen button always does something. Automatic hall
 *   intros are skipped in that case: silent captions popping up on their own
 *   would only be noise.
 * - settings (optional, settings.js): "subtitles" hides the caption box while
 *   the voice is audible, "narration" turns the automatic hall intros off.
 *
 * Also exported: exhibitScript(ex), exhibitLines(ex), HALL_INTROS, pickVoice().
 */

const RATE = 0.95;
const WORDS_PER_SEC = 2.5 * RATE; // a calm guide voice at rate 0.95
const READ_CPS = 15; // subtitle-only reading speed (characters per second)
const START_TIMEOUT = 2500; // ms for the engine to start a sentence before we give up on it
const INTRO_DWELL = 1200; // ms inside a hall before its intro starts (doorway jitter)
const INTRO_WINDOW = 30000; // a pending intro is dropped if it could not start in time
const STORE_INTROS = "dino-museum:guide-intros:v1"; // sessionStorage: intros heard this visit

/* ------------------------------------------------------------------ */
/* hall intros                                                          */
/* ------------------------------------------------------------------ */

/** Room id (world.js ROOMS) → 2–3 sentence welcome, spoken once per visit. */
export const HALL_INTROS = {
  lobby:
    "Welcome to the museum. Overhead flies Quetzalcoatlus, one of the largest flying animals that ever lived, and nearby are Archaeopteryx and Rhamphorhynchus. Follow the signs to the halls, and press E at any exhibit to read more.",
  rotunda:
    "This is the Grand Gallery. Spinosaurus, a sail-backed hunter that spent much of its life in and around water, stands here alongside Velociraptor and its feathered cousins. Some animals in this gallery, like Dimetrodon and Doedicurus, are not dinosaurs at all, so see if you can spot them.",
  triassic:
    "Welcome to the Triassic Hall. The Triassic period ran from about 252 to 201 million years ago, and this is where the dinosaur story begins. Early dinosaurs like Eoraptor and Herrerasaurus were small to mid-sized animals in a world ruled by other reptiles.",
  jurassic:
    "This is the Jurassic Hall, covering about 201 to 145 million years ago. It was the age of giant long-necked sauropods like Brachiosaurus and Diplodocus, hunted by predators such as Allosaurus. Look out too for the plated Stegosaurus.",
  cretaceous:
    "Welcome to the Cretaceous Hall, the last chapter of the age of dinosaurs, from about 145 to 66 million years ago. Here stand Tyrannosaurus rex, horned dinosaurs like Triceratops, and duck-billed and armoured plant-eaters. The period ended with an asteroid impact that wiped out every dinosaur except the birds.",
  predator:
    "This is Predator Bay, home to some of the largest meat-eating dinosaurs ever found. Giganotosaurus, Carcharodontosaurus and Mapusaurus belong to a family whose name means shark-toothed lizards, and some rivalled Tyrannosaurus rex in length.",
  marine:
    "Welcome to the Marine Reptile Hall. While dinosaurs ruled the land, other reptiles ruled the seas: dolphin-shaped ichthyosaurs, long-necked plesiosaurs and huge mosasaurs. None of the animals in this hall are dinosaurs.",
  theater:
    "This is the Screening Theatre. Take a seat, then press E to choose a fight for the big screen. Some match-ups are backed by fossil evidence, and others are pure what-ifs.",
  court:
    "You've found the Ice Cream Court at the end of the tour. Pick a gelato at the counter, and thank you for visiting the museum.",
};

// hall names (world.js HALL_LABEL / roomNameAt) → room id, so either works
const HALL_NAMES = {
  "entrance atrium": "lobby",
  "grand gallery": "rotunda",
  "triassic hall": "triassic",
  "jurassic hall": "jurassic",
  "cretaceous hall": "cretaceous",
  "predator bay": "predator",
  "marine reptile hall": "marine",
  "screening theatre": "theater",
  "ice cream court": "court",
};

function roomKey(roomOrName) {
  const s = String(roomOrName || "").trim();
  if (!s) return "";
  if (HALL_INTROS[s]) return s;
  return HALL_NAMES[s.toLowerCase()] || s;
}

/* ------------------------------------------------------------------ */
/* exhibit scripts                                                      */
/* ------------------------------------------------------------------ */

/**
 * "Say it" respellings, used when the species has no `pronounce` of its own.
 * Shown in the subtitles; the voice says the name itself (speech engines read
 * capitalised syllables like "SORE" letter by letter).
 */
const PRONOUNCE = {
  eoraptor: "EE-oh-RAP-tor",
  herrerasaurus: "heh-RARE-uh-SORE-us",
  riojasaurus: "ree-OH-hah-SORE-us",
  coelo: "SEE-loh-FY-sis",
  plateosaurus: "PLAT-ee-oh-SORE-us",
  massospondylus: "MASS-oh-SPON-dih-lus",
  brachio: "BRAK-ee-oh-SORE-us",
  diplod: "dih-PLOD-oh-kus",
  apo: "uh-PAT-oh-SORE-us",
  camarasaurus: "KAM-uh-ruh-SORE-us",
  barosaurus: "BAR-oh-SORE-us",
  stego: "STEG-oh-SORE-us",
  kentrosaurus: "KEN-troh-SORE-us",
  wuerho: "WER-hoh-SORE-us",
  allo: "AL-oh-SORE-us",
  torvo: "TOR-voh-SORE-us",
  dilo: "dy-LOF-oh-SORE-us",
  baryonyx: "BARE-ee-ON-ix",
  archaeopteryx: "ar-kee-OP-ter-ix",
  rhampho: "RAM-foh-RINK-us",
  trex: "tie-RAN-oh-SORE-us REX",
  trike: "try-SERR-uh-tops",
  styraco: "sty-RAK-oh-SORE-us",
  centro: "SEN-troh-SORE-us",
  proto: "PROH-toh-SERR-uh-tops",
  edmont: "ed-MON-toh-SORE-us",
  para: "PARR-uh-sore-OL-oh-fus",
  ankylo: "an-KY-loh-SORE-us",
  doed: "DEE-dih-KYOO-rus",
  nodo: "NOH-doh-SORE-us",
  pachy: "PAK-ee-SEF-uh-loh-SORE-us",
  stygi: "STIJ-ih-MOL-ok",
  spino: "SPY-noh-SORE-us",
  carchar: "kar-KARE-oh-DON-toh-SORE-us",
  giganoto: "JIG-uh-NOT-oh-SORE-us",
  mapu: "MAH-poo-SORE-us",
  acro: "AK-roh-KAN-thoh-SORE-us",
  raptor: "veh-LOSS-ih-RAP-tor",
  utahraptor: "YOO-tah-RAP-tor",
  deinonychus: "dy-NON-ih-kus",
  oviraptor: "OH-vih-RAP-tor",
  iguanodon: "ig-WAH-noh-don",
  quetzal: "KET-sul-koh-AT-lus",
  ptero: "teh-RAN-oh-don",
  mosa: "MOH-zuh-SORE-us",
  plesio: "PLEE-zee-oh-SORE-us",
  elasmo: "eh-LAZ-moh-SORE-us",
  ichthyo: "IK-thee-oh-SORE-us",
  krono: "KROH-noh-SORE-us",
  liopleurodon: "LY-oh-PLOOR-oh-don",
  archelon: "AR-keh-lon",
  deino: "DY-noh-SOO-kus",
  dimetrodon: "dy-MET-roh-don",
};

const MIN_WORDS = 50; // ~20 s at rate 0.95
const MAX_WORDS = 95; // ~40 s

/** Exhibit record (exhibits.js) or species entry (species.js) → one flat shape. */
function normalise(ex) {
  if (!ex) return null;
  const info = ex.info || {};
  return {
    id: ex.id || "",
    title: ex.title || ex.name || "",
    era: ex.era ?? info.era ?? "",
    period: ex.period ?? info.period ?? "",
    length: ex.length ?? info.length ?? "",
    weight: ex.weight ?? info.weight ?? "",
    diet: ex.diet ?? info.diet ?? "",
    blurb: ex.blurb ?? info.blurb ?? "",
    facts: ex.facts ?? info.facts ?? [],
    pronounce: ex.pronounce ?? info.pronounce ?? "",
  };
}

const words = (s) => (String(s).match(/\S+/g) || []).length;
const sentence = (s) => {
  const t = String(s || "").trim();
  if (!t) return "";
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

/** "~10–12 tonnes (est.)" → { text: "about 10 to 12 tonnes", est: true } */
function spokenAmount(raw) {
  let s = String(raw || "").trim();
  const est = /\(est\.?\)/i.test(s);
  s = s.replace(/\s*\(est\.?\)/i, "");
  s = s.replace(/^c\.\s*/i, "about ").replace(/~\s*/g, "about ");
  s = s.replace(/\s*[–—-]\s*/g, " to ");
  s = s.replace(/about (\S+) to about /, "about $1 to ");
  // units: only bare unit tokens after a number
  const one = /(^|\s)(?:about\s+)?1\s+(?:m|kg|t|tonnes?)$/i.test(s) && !/ to /.test(s);
  s = s
    .replace(/(\d)\s*m\b/g, one ? "$1 metre" : "$1 metres")
    .replace(/(\d)\s*kg\b/g, one ? "$1 kilogram" : "$1 kilograms")
    .replace(/(\d)\s*tonnes?\b/g, one ? "$1 tonne" : "$1 tonnes");
  return { text: s.replace(/\s+/g, " ").trim(), est };
}

function sizeSentence(length, weight) {
  const parts = [];
  if (length) {
    const wing = /wingspan/i.test(length);
    const { text } = spokenAmount(String(length).replace(/\s*wingspan/i, ""));
    parts.push(wing ? `had a wingspan of ${text}` : `measured ${text} long`);
  }
  if (weight) {
    const { text, est } = spokenAmount(weight);
    const w = est ? text.replace(/^about /, "") : text;
    parts.push(`weighed ${est ? "an estimated " : ""}${w}`);
  }
  if (!parts.length) return "";
  return `It ${parts.join(" and ")}.`;
}

const DIET_BASE = {
  carnivore: "a meat-eater",
  herbivore: "a plant-eater",
  omnivore: "an omnivore",
  piscivore: "a fish-eater",
  "piscivore/carnivore": "a hunter of fish and other animals",
  "marine predator": "a marine predator",
  insectivore: "an insect-eater",
};

const article = (s) => (/^[aeiou]/i.test(s) ? `an ${s}` : `a ${s}`);
function joinAnd(list) {
  const l = list.map((s) => s.trim()).filter(Boolean);
  if (l.length < 2) return l[0] || "";
  return `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`;
}

/** "Carnivore (small animals)" → "It was a meat-eater, feeding on small animals." */
function dietSentence(diet) {
  const m = String(diet || "").match(/^([^()]+?)\s*(?:\(([^)]*)\))?$/);
  if (!m) return "";
  const base = m[1].trim();
  const extra = (m[2] || "").trim();
  const head = DIET_BASE[base.toLowerCase()] || article(base.toLowerCase());
  let tail = "";
  if (extra) {
    if (/^perhaps\s+/i.test(extra)) tail = `, and perhaps ${article(extra.replace(/^perhaps\s+/i, "").toLowerCase())}`;
    else if (/predator|hunter|scavenger/i.test(extra) && !extra.includes(",")) tail = ` and ${article(extra.toLowerCase())}`;
    else tail = `, feeding on ${joinAnd(extra.toLowerCase().split(","))}`;
  }
  return `It was ${head}${tail}.`;
}

/** "Late Cretaceous" + "c. 68–66 million years ago" → "It lived in the Late Cretaceous, about 68 to 66 million years ago." */
function eraSentence(era, period) {
  const e = String(era || "").replace(/\s*\(([^)]+)\)/, " $1").trim();
  const p = period ? spokenAmount(period).text : "";
  if (!e && !p) return "";
  if (!e) return `It lived ${p}.`;
  return `It lived in the ${e}${p ? `, ${p}` : ""}.`;
}

/**
 * The narration for one exhibit as lines: { text, caption? } where `text` is
 * what the voice says and `caption` (when different) what the subtitles show.
 * Name, say-it, era, size, diet, one fact; the card's blurb goes in when the
 * talk would otherwise be short, so every stop lands at about 20–40 s.
 */
export function exhibitLines(ex, { fact = 0 } = {}) {
  const e = normalise(ex);
  if (!e || !e.title) return [];
  const say = e.pronounce || PRONOUNCE[e.id] || "";
  const facts = Array.isArray(e.facts) ? e.facts.filter(Boolean) : [];
  const pick = facts.length ? facts[((fact % facts.length) + facts.length) % facts.length] : "";

  const head = [{ text: `This is ${e.title}.` }];
  if (say) head.push({ text: `Say it with me: ${e.title}.`, caption: `Say it: ${say}.` });
  const body = [eraSentence(e.era, e.period), sizeSentence(e.length, e.weight), dietSentence(e.diet)]
    .filter(Boolean)
    .map((text) => ({ text }));
  const tail = pick ? [{ text: "Did you know?" }, { text: sentence(pick) }] : [];

  let lines = [...head, ...body, ...tail];
  const count = (ls) => ls.reduce((n, l) => n + words(l.text), 0);
  // the blurb is the card's own summary: worth hearing when there is room
  const blurb = sentence(e.blurb);
  if (blurb && count(lines) + words(blurb) <= MAX_WORDS) {
    lines = [...head, ...splitSentences(blurb).map((text) => ({ text })), ...body, ...tail];
  }
  // still short (a sparse catalogue entry): a second fact, then a gentle close
  if (count(lines) < MIN_WORDS && facts.length > 1) {
    const second = sentence(facts[(facts.indexOf(pick) + 1) % facts.length]);
    if (count(lines) + words(second) <= MAX_WORDS) lines.push({ text: second });
  }
  if (count(lines) < MIN_WORDS) lines.push({ text: "Take a closer look before you move on to the next stop." });
  return lines;
}

/** The exhibit narration as one spoken string (see exhibitLines). */
export function exhibitScript(ex, opts) {
  return exhibitLines(ex, opts)
    .map((l) => l.text)
    .join(" ");
}

/** Split prose into sentences without breaking "T. rex" or "c. 231". */
function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+(?=["'‘“(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Estimated speaking time of a script in seconds (rate 0.95). */
export function estimateSeconds(textOrLines) {
  const t = Array.isArray(textOrLines) ? textOrLines.map((l) => l.text ?? l).join(" ") : String(textOrLines || "");
  return words(t) / WORDS_PER_SEC;
}

/* ------------------------------------------------------------------ */
/* voices                                                               */
/* ------------------------------------------------------------------ */

// macOS ships joke and Eloquence voices under en-US; none of them belongs in a museum
const NOVELTY =
  /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|pipe organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|princess|junior|ralph|fred|kathy|eddy|flo|grandma|grandpa|reed|rocko|sandy|shelley)\b/i;

function scoreVoice(v) {
  const lang = String(v.lang || "").replace("_", "-").toLowerCase();
  const name = String(v.name || "");
  if (!lang.startsWith("en")) return -Infinity;
  if (NOVELTY.test(name)) return -Infinity;
  let s = 0;
  if (lang === "en-gb") s += 40;
  else if (lang === "en-us") s += 30;
  else s += 10;
  if (/natural|neural|premium|enhanced|siri/i.test(name)) s += 30;
  if (/google uk english|google us english/i.test(name)) s += 22;
  if (/^(daniel|serena|kate|arthur|martha|oliver|stephanie|samantha|ava|allison|susan|tom|evan|zoe|nathan|libby|ryan|sonia|aria|jenny|guy)\b/i.test(name)) s += 12;
  if (/compact|espeak|robot/i.test(name)) s -= 25;
  if (v.default && lang.startsWith("en")) s += 2;
  return s;
}

/** Best English voice from a list (en-GB first, natural voices first), or null. */
export function pickVoice(voices) {
  let best = null;
  let bestScore = -Infinity;
  for (const v of voices || []) {
    const s = scoreVoice(v);
    if (s > bestScore) {
      best = v;
      bestScore = s;
    }
  }
  return bestScore > -Infinity ? best : null;
}

/* ------------------------------------------------------------------ */
/* storage                                                              */
/* ------------------------------------------------------------------ */

function loadHeard() {
  try {
    const raw = window.sessionStorage.getItem(STORE_INTROS);
    const list = JSON.parse(raw || "[]");
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch {
    return new Set();
  }
}
function saveHeard(set) {
  try {
    window.sessionStorage.setItem(STORE_INTROS, JSON.stringify([...set]));
  } catch {
    /* private window: remembered for this page only */
  }
}

/* ------------------------------------------------------------------ */
/* narrator                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {object} [opts]
 * @param {object} [opts.audio]     audio.js instance (duck, muted, volume)
 * @param {object} [opts.settings]  settings.js instance (get("subtitles"), get("narration"))
 * @param {HTMLElement} [opts.root] where the caption box goes (default document.body)
 * @param {string} [opts.stopHint]  key shown in the caption box, e.g. "N"
 */
export function createNarrator({ audio = null, settings = null, root = null, stopHint = "" } = {}) {
  const synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  const Utterance = typeof window !== "undefined" ? window.SpeechSynthesisUtterance : null;
  const hasEngine = !!(synth && Utterance);

  let voice = null;
  let engineBroken = false; // set when the engine never starts a sentence
  let run = null; // the script being played
  let gen = 0;
  const heard = loadHeard();

  // tick() state
  let lastRoom = "";
  let pending = null; // { room, since }

  function refreshVoice() {
    if (!hasEngine) return;
    try {
      voice = pickVoice(synth.getVoices()) || voice;
    } catch {
      /* some browsers throw before the list is ready */
    }
  }
  if (hasEngine) {
    refreshVoice();
    try {
      synth.addEventListener?.("voiceschanged", refreshVoice);
    } catch {
      /* old Safari: onvoiceschanged only */
      synth.onvoiceschanged = refreshVoice;
    }
  }

  // iOS only lets speech start from a user gesture: speak one empty utterance
  // on the first tap / key so later (game-loop) intros are allowed to play
  if (hasEngine && typeof window !== "undefined") {
    const prime = () => {
      window.removeEventListener("pointerdown", prime, true);
      window.removeEventListener("keydown", prime, true);
      if (run) return;
      try {
        const u = new Utterance(" ");
        u.volume = 0;
        synth.speak(u);
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pointerdown", prime, true);
    window.addEventListener("keydown", prime, true);
  }

  const setting = (key, fallback) => {
    try {
      const v = settings?.get?.(key);
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  };
  const voiceAllowed = () => hasEngine && !engineBroken && !audio?.muted && (audio?.volume ?? 1) > 0.001;

  /* ---------------- caption box ---------------- */
  let box = null;
  let labelEl = null;
  let textEl = null;
  let hideTimer = 0;

  function ensureBox() {
    if (box || typeof document === "undefined") return box;
    box = document.createElement("div");
    box.className = "guideCaption";
    box.id = "guideCaption";
    box.hidden = true;
    box.innerHTML = `
      <div class="gcHead">
        <span class="gcIcon" aria-hidden="true"></span>
        <span class="gcLabel"></span>
        ${stopHint ? `<span class="gcHint"><kbd>${escapeHtml(stopHint)}</kbd> stop</span>` : ""}
      </div>
      <p class="gcText"></p>`;
    labelEl = box.querySelector(".gcLabel");
    textEl = box.querySelector(".gcText");
    (root || document.body).appendChild(box);
    return box;
  }

  function showCaption(label, text, { spoken }) {
    const showIt = !spoken || setting("subtitles", true) !== false;
    if (!ensureBox()) return;
    clearTimeout(hideTimer);
    if (!showIt) {
      box.classList.remove("show");
      box.hidden = true;
      return;
    }
    // with a voice, screen readers already hear it; captions-only is announced
    box.setAttribute("role", spoken ? "presentation" : "status");
    box.setAttribute("aria-live", spoken ? "off" : "polite");
    labelEl.textContent = label || "Audio guide";
    // one span per word so boundary events can dim what is still to come
    textEl.textContent = "";
    textEl.classList.remove("tracking");
    let at = 0;
    for (const part of String(text).split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        textEl.appendChild(document.createTextNode(part));
      } else {
        const w = document.createElement("span");
        w.textContent = part;
        w.dataset.at = String(at);
        textEl.appendChild(w);
      }
      at += part.length;
    }
    box.hidden = false;
    // next frame so the fade-in runs from the hidden state
    requestAnimationFrame(() => box && box.classList.add("show"));
  }

  function markWord(charIndex) {
    if (!textEl) return;
    textEl.classList.add("tracking");
    for (const w of textEl.children) w.classList.toggle("said", Number(w.dataset.at) <= charIndex);
  }

  function hideCaption() {
    if (!box) return;
    box.classList.remove("show");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (box && !run) box.hidden = true;
    }, 260);
  }

  /* ---------------- playback ---------------- */
  function toLines(input) {
    if (Array.isArray(input)) {
      return input
        .map((l) => (typeof l === "string" ? { text: l } : l))
        .flatMap((l) => {
          // keep a line's own caption; long plain lines are split into sentences
          if (l.caption) return [{ text: l.text, caption: l.caption }];
          return splitSentences(l.text).map((text) => ({ text }));
        });
    }
    return splitSentences(input).map((text) => ({ text }));
  }

  function finish(r, reason) {
    if (!r || r.done) return;
    r.done = true;
    clearTimeout(r.timer);
    if (run === r) run = null;
    if (r.ducked && !run) audio?.duck?.(false);
    if (!run) hideCaption();
    try {
      r.onEnd?.(reason);
    } catch (err) {
      console.warn("narrator: onEnd failed", err);
    }
  }

  function next(r) {
    if (r.done || run !== r) return;
    clearTimeout(r.timer);
    r.i++;
    if (r.i >= r.lines.length) {
      finish(r, "done");
      return;
    }
    const line = r.lines[r.i];
    const caption = line.caption || line.text;
    if (voiceAllowed()) speakLine(r, line, caption);
    else captionLine(r, caption);
  }

  function captionLine(r, caption) {
    showCaption(r.label, caption, { spoken: false });
    const ms = Math.max(1600, (caption.length / READ_CPS) * 1000);
    r.timer = setTimeout(() => next(r), ms);
  }

  function speakLine(r, line, caption) {
    const u = new Utterance(line.text);
    u.rate = RATE;
    u.pitch = 1;
    u.volume = Math.max(0, Math.min(1, audio?.volume ?? 1));
    refreshVoice();
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    } else {
      u.lang = "en-GB";
    }
    let started = false;
    const id = gen;
    const alive = () => !r.done && run === r && id === gen && r.utt === u;
    u.onstart = () => {
      if (!alive()) return;
      started = true;
      clearTimeout(r.timer);
      // generous ceiling: some engines never fire onend (Chrome GC bug)
      const expect = (words(line.text) / WORDS_PER_SEC) * 1000;
      r.timer = setTimeout(() => {
        if (!alive()) return;
        r.utt = null;
        try {
          synth.cancel();
        } catch {
          /* ignore */
        }
        next(r);
      }, expect * 2 + 4000);
    };
    u.onboundary = (e) => {
      if (alive() && e.name !== "sentence" && !line.caption) markWord(e.charIndex ?? 0);
    };
    u.onend = () => {
      if (alive()) next(r);
    };
    u.onerror = (e) => {
      if (!alive()) return;
      if (e.error === "interrupted" || e.error === "canceled") return;
      // no voices, blocked autoplay, synthesis failure: subtitles carry on alone
      if (!started && e.error !== "not-allowed") engineBroken = true;
      r.utt = null;
      clearTimeout(r.timer);
      captionLine(r, caption);
    };
    r.utt = u; // a live reference keeps Chrome from collecting it mid-sentence
    showCaption(r.label, caption, { spoken: true });
    r.timer = setTimeout(() => {
      // the engine never started: treat speech as unavailable from now on
      if (!alive() || started) return;
      engineBroken = true;
      r.utt = null;
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
      captionLine(r, caption);
    }, START_TIMEOUT);
    try {
      synth.speak(u);
    } catch {
      engineBroken = true;
      clearTimeout(r.timer);
      captionLine(r, caption);
    }
  }

  /**
   * Speak `text` (a string, or lines { text, caption? }). Anything already
   * playing is cut off. Returns false when there was nothing to say.
   */
  function speak(text, { onEnd = null, id = "", label = "Audio guide" } = {}) {
    const lines = toLines(text);
    if (!lines.length) return false;
    const prev = run;
    stopRun("replaced");
    gen++;
    const r = { lines, i: -1, onEnd, id: String(id || ""), label, done: false, timer: 0, utt: null, ducked: false };
    run = r;
    // keep the duck we already hold (one talk replacing another): no pumping
    if (audio?.duck) {
      if (prev?.ducked) r.ducked = true;
      else if (!audio.ducked) {
        audio.duck(true);
        r.ducked = true;
      }
    }
    // Chrome drops a speak() issued in the same task as cancel()
    if (prev && voiceAllowed()) setTimeout(() => next(r), 60);
    else next(r);
    return true;
  }

  function stopRun(reason) {
    const r = run;
    if (!r) return false;
    r.utt = null;
    run = null;
    if (hasEngine) {
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
    }
    // a replacement inherits the duck; a real stop releases it
    if (reason === "replaced") {
      const keep = r.ducked;
      r.ducked = false;
      finish(r, reason);
      r.ducked = keep;
    } else {
      finish(r, reason);
    }
    return true;
  }

  /** Stop talking now (fires the current script's onEnd("stopped")). */
  function stop() {
    const was = stopRun("stopped");
    if (was) hideCaption();
    return was;
  }

  /** Talk for one exhibit (exhibits.js record or species entry). */
  function speakExhibit(ex, opts = {}) {
    const lines = exhibitLines(ex, opts);
    if (!lines.length) return false;
    return speak(lines, { ...opts, id: ex.id, label: `Audio guide · ${ex.title || ex.name}` });
  }

  /**
   * The welcome for a hall, once per visit. `roomId` is a world.js room id
   * ("triassic") or hall name ("Triassic Hall"). Never cuts into another talk,
   * never plays with the guide switched off ("narration" setting) or when only
   * silent subtitles could play, unless { force: true }.
   */
  function hallIntro(roomId, { force = false } = {}) {
    const key = roomKey(roomId);
    const text = HALL_INTROS[key];
    if (!text) return false;
    if (!force) {
      if (heard.has(key)) return false;
      if (run) return false;
      if (setting("narration", true) === false) return false;
      if (!voiceAllowed()) return false;
    }
    heard.add(key);
    saveHeard(heard);
    return speak(text, { id: `hall:${key}`, label: "Audio guide · Welcome" });
  }

  /**
   * Call every frame with the room the player is in. Starts that hall's intro
   * once they have been inside for a moment; waits (up to 30 s) while another
   * talk is playing or `quiet` is set (a screening, a video).
   */
  function tick(roomId, { quiet = false } = {}) {
    const key = roomKey(roomId);
    const now = performance.now();
    if (key !== lastRoom) {
      lastRoom = key;
      pending = HALL_INTROS[key] && !heard.has(key) ? { room: key, since: now } : null;
      return false;
    }
    if (!pending) return false;
    const age = now - pending.since;
    if (age > INTRO_WINDOW) {
      pending = null;
      return false;
    }
    if (age < INTRO_DWELL || quiet || run) return false;
    const room = pending.room;
    pending = null;
    return hallIntro(room);
  }

  return {
    speak,
    stop,
    speakExhibit,
    hallIntro,
    tick,
    /** Script line builders, exposed for a Listen button's duration hint. */
    exhibitScript,
    exhibitLines,
    get speaking() {
      return !!run;
    },
    /** id of what is playing ("trex", "hall:jurassic"), or "" */
    get current() {
      return run ? run.id : "";
    },
    /** true when a real voice can play (false: subtitles only) */
    get available() {
      return hasEngine && !engineBroken;
    },
    get voice() {
      return voice ? `${voice.name} (${voice.lang})` : "";
    },
    /** Rooms whose intro was heard this visit. */
    get heard() {
      return [...heard];
    },
    /** Forget the heard intros (e.g. a "replay intros" setting). */
    resetIntros() {
      heard.clear();
      saveHeard(heard);
      lastRoom = "";
      pending = null;
    },
  };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
