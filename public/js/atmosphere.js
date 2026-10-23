import { roomAt as worldRoomAt, ROOMS } from "./world.js";
import { clamp } from "./util.js";

/**
 * A living building: the museum's public-address system and the hum of a
 * building in use.
 *
 *   const atmosphere = createAtmosphere({ audio, narrator, ui, getState });
 *   atmosphere.update(dt); // every frame
 *
 * PA: every 3–6 minutes (the first one sooner) a three-note chime sounds, a
 * caption card slides in on top of the toast stack and, when a narrator is passed,
 * the announcement is read out. Announcements are picked from a shuffled bag
 * (never the same one twice in a row) and skip the ones that make no sense
 * where you stand. One that falls due while a video, screening, era window
 * or narration plays waits until it has been quiet for a few seconds; one
 * already sounding is cut short when such a thing starts.
 *
 * Secret rooms (world.js ROOMS with secret: true: the tour's surprise ending)
 * are never named before the visitor has walked into them: an announcement
 * whose text mentions one is held back until then, the stock ones and
 * announce(text) alike. A room counts as found once the local player has
 * stood in it, or when getState().revealed(id) says so (minimap.isRevealed).
 *
 * Occupancy: who else is in your room (other players, plus the background
 * visitors when passed). When audio has setOccupancy(n) it is told; until
 * then a quiet procedural murmur here swells with the people around you
 * (nothing at all in an empty room) under the recorded crowd bed.
 *
 * getState() → {
 *   x, z        local player (null / missing before joining: nothing runs)
 *   busy        a video / screening / narration / full-screen view is on
 *   remotes     [{x, z}] other players
 *   npcs        [{x, z}] background visitors (crowd.npcs), optional
 *   muted       sound off: captions only (audio.muted is used when missing)
 *   reduced     reduced settings: no speech, no slide-in, fewer announcements
 *   speech      false: chime + caption, never a voice
 *   pa          false turns announcements off (murmur stays)
 *   revealed    (roomId) => bool: that secret room is no longer a secret
 * }
 * Every field is optional. audio.ducked set by someone else also counts as
 * busy, so videos / era views hold the PA even when `busy` is not wired.
 *
 * narrator (optional): narrator.js's createNarrator() — speak(text, { id,
 * label, onEnd }), speaking, current, available, stop() — reads the
 * announcement in its own subtitle box (our card steps aside while it talks),
 * and its exhibit talks / hall intros hold the PA. Any { say | speak(text) →
 * Promise?, speaking?, cancel?() } works too: createSpeechNarrator() below
 * wraps the browser's speech synthesis in that shape.
 *
 * Returns { update(dt), announce(text, opts), say(id), reveal(id), occupancy, next,
 *   announcing, setEnabled(on), enabled, stats(), dispose() }.
 */

/** The museum's stock announcements. when(ctx) skips one that does not fit. */
export const ANNOUNCEMENTS = [
  {
    id: "screening",
    text: "The next screening in the Screening Theatre begins in 5 minutes. Please make your way to the theatre.",
    when: (c) => c.room !== "theater",
  },
  {
    // a secret until the visitor has found it (see secretNamed): only then a reminder
    id: "icecream",
    text: "The Ice Cream Court is open until closing. Treat yourself to a scoop before you head home!",
    when: (c) => c.seen("court") && c.room !== "court" && c.room !== "xpassage",
  },
  {
    id: "touch",
    text: "Please do not touch the exhibits. Thank you for helping us protect the collection.",
  },
  {
    id: "group",
    text: "Visitors who have become separated from their group, please meet in the Grand Gallery.",
  },
  {
    id: "photo",
    text: "Photography is welcome throughout the museum. Please do not use flash near the exhibits.",
  },
  {
    id: "marine",
    text: "The Marine Reptile Hall is open. Come and meet the giants of the ancient seas.",
    when: (c) => c.room !== "marine",
  },
  {
    id: "rest",
    text: "Benches are available in the Grand Gallery and the halls for visitors who would like a rest.",
  },
  {
    id: "predator",
    text: "Visitors in Predator Bay are reminded to stay behind the barriers. Our tyrannosaurs are not feeding today.",
    when: (c) => c.room === "predator" || c.room === "rotunda",
  },
];

const CHIME_LEAD = 1.7; // s from the chime to the voice
const HOLD_MIN = 4.5; // s a caption stays up at least
const HOLD_PER_CHAR = 0.065; // reading time per character
const HOLD_MAX = 11;
const QUIET_NEEDED = 8; // s of nothing playing before a held announcement goes
const OCC_EVERY = 0.5; // s between occupancy counts
const MURMUR_MAX = 0.045; // procedural murmur gain at a full room
const STYLE_ID = "atmosphere-style";

const rnd = (random, [a, b]) => a + random() * (b - a);
const PA_ID = "pa"; // the narrator run id of an announcement
const PA_LABEL = "Museum announcement";

/** The secret rooms, and the words that would give each away. */
const SECRETS = ROOMS.filter((r) => r.secret).map((r) => ({
  id: r.id,
  // "Ice Cream Court" also matches "ice-cream court"
  re: new RegExp(r.name.trim().split(/\s+/).join("[\\s-]+"), "i"),
}));

/** The first secret room `text` names that `seen(id)` has not unlocked, or null. */
export function secretNamed(text, seen = () => false) {
  const t = String(text || "");
  for (const s of SECRETS) if (!seen(s.id) && s.re.test(t)) return s.id;
  return null;
}

export function createAtmosphere({
  audio = null,
  narrator = null,
  ui = null,
  getState = () => ({}),
  roomAt = worldRoomAt,
  interval = [180, 360],
  firstDelay = [75, 160],
  messages = ANNOUNCEMENTS,
  murmur = true,
  random = Math.random,
} = {}) {
  let enabled = true;
  let wait = rnd(random, firstDelay); // s until the next announcement is due
  let quiet = 0; // s nothing has been playing
  let lastId = null;
  let bag = [];
  let current = null; // the announcement sounding now
  let weDucked = false;
  let occTimer = 0;
  let room = null;
  const occupancy = { players: 0, npcs: 0, total: 0, room: null, level: 0 };
  let lastOccSent = -1;
  const counters = { announced: 0, held: 0, cut: 0, chimes: 0, spoken: 0 };
  let murmurLayer = null;
  const seenSecret = new Set(); // secret rooms the local player has stood in

  /* ---------------------------------------------------------------- */
  /* state                                                             */
  /* ---------------------------------------------------------------- */
  function readState() {
    let s = null;
    try {
      s = getState() || {};
    } catch {
      s = {};
    }
    return s;
  }

  const isMuted = (s) => (s.muted !== undefined ? !!s.muted : !!audio?.muted);
  const narrating = () => !!(narrator && (narrator.speaking || narrator.busy));
  /** narrator.js's guide: has its own subtitle box and stop(). */
  const guideNarrator = () => !!narrator && typeof narrator.speakExhibit === "function";

  /** Has the visitor found secret room `id`? */
  function seen(id, s = null) {
    if (seenSecret.has(id)) return true;
    try {
      return !!(s || readState()).revealed?.(id);
    } catch {
      return false;
    }
  }

  /** Something else is playing: hold (or cut) the PA. */
  function isBusy(s) {
    if (s.busy) return true;
    if (audio?.ducked && !weDucked) return true;
    // the narrator reading anything other than our own announcement
    if (narrating() && !(current && current.speaking)) return true;
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* the caption card                                                  */
  /* ---------------------------------------------------------------- */
  function injectStyle() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = `
.pa-caption {
  position: relative;
  max-width: min(440px, calc(100vw - 32px));
  background: var(--glass-strong, rgba(12, 17, 24, 0.9));
  border: 1px solid rgba(255, 200, 87, 0.35);
  border-radius: 12px;
  padding: 9px 16px 10px 14px;
  box-shadow: var(--glass-shadow, 0 10px 30px rgba(0, 0, 0, 0.42)), inset 3px 0 0 var(--accent, #ffc857);
  -webkit-backdrop-filter: var(--glass-blur, blur(14px));
  backdrop-filter: var(--glass-blur, blur(14px));
  color: #eef2f6;
  pointer-events: none;
  animation: paIn 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
  transition: opacity 0.5s, transform 0.5s;
}
.pa-caption.out { opacity: 0; transform: translateY(-6px); }
.pa-caption.handoff { display: none; }
.pa-caption.still { animation: none; transition: opacity 0.5s; }
.pa-caption.still.out { transform: none; }
.pa-caption .pa-head {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent, #ffc857);
  margin-bottom: 3px;
}
.pa-caption .pa-head svg { width: 14px; height: 14px; flex: none; }
.pa-caption .pa-bars { display: inline-flex; gap: 2px; align-items: flex-end; height: 10px; margin-left: 2px; }
.pa-caption .pa-bars i { width: 2px; background: currentColor; border-radius: 1px; animation: paBar 0.9s ease-in-out infinite; }
.pa-caption .pa-bars i:nth-child(2) { animation-delay: 0.15s; }
.pa-caption .pa-bars i:nth-child(3) { animation-delay: 0.3s; }
.pa-caption.quiet .pa-bars, .pa-caption.still .pa-bars { display: none; }
.pa-caption .pa-text { font-size: 14px; font-weight: 600; line-height: 1.4; }
@keyframes paIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@keyframes paBar { 0%, 100% { height: 3px; } 50% { height: 10px; } }
@media (prefers-reduced-motion: reduce) {
  .pa-caption { animation: none; }
  .pa-caption .pa-bars { display: none; }
}
@media (max-width: 720px) {
  .pa-caption { padding: 7px 12px 8px 11px; }
  .pa-caption .pa-text { font-size: 13px; }
}`;
    document.head.appendChild(st);
  }

  const SPEAKER =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 10v4h4l5 4V6L7 10H3z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7"/><path d="M19 5.5a9 9 0 0 1 0 13"/></svg>';

  function showCaption(text, { reduced = false, quietSound = false } = {}) {
    if (typeof document === "undefined") return null;
    const host = document.getElementById("toasts");
    if (!host) {
      // no toast stack (a different page): the plain UI toast still informs
      ui?.toast?.(`Announcement: ${text}`);
      return null;
    }
    injectStyle();
    const el = document.createElement("div");
    el.className = "pa-caption" + (reduced ? " still" : "") + (quietSound ? " quiet" : "");
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.innerHTML =
      `<div class="pa-head">${SPEAKER}<span>Museum announcement</span>` +
      `<span class="pa-bars"><i></i><i></i><i></i></span></div><div class="pa-text"></div>`;
    el.querySelector(".pa-text").textContent = text;
    // announcements read first: above the transient toasts
    host.insertBefore(el, host.firstChild);
    return el;
  }

  function hideCaption(el, fast = false) {
    if (!el || !el.isConnected) return;
    el.classList.add("out");
    setTimeout(() => el.remove(), fast ? 250 : 550);
  }

  /* ---------------------------------------------------------------- */
  /* the chime: a three-note PA "ding-dong" through a small loudspeaker */
  /* ---------------------------------------------------------------- */
  function chime() {
    const ctx = audio?.ensure?.();
    if (!ctx || ctx.state !== "running") return false;
    const vol = clamp(Number(audio.volume ?? 0.8), 0, 1);
    if (vol <= 0) return false;
    const t0 = ctx.currentTime + 0.03;
    const out = ctx.createGain();
    out.gain.value = 0.55 * vol;
    // loudspeaker colour: no deep lows, a little horn honk
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 260;
    const peak = ctx.createBiquadFilter();
    peak.type = "peaking";
    peak.frequency.value = 1800;
    peak.gain.value = 4;
    peak.Q.value = 0.9;
    // the hall: a couple of soft echoes off far walls
    const dly = ctx.createDelay(1);
    dly.delayTime.value = 0.23;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const dlp = ctx.createBiquadFilter();
    dlp.type = "lowpass";
    dlp.frequency.value = 2400;
    out.connect(hp);
    hp.connect(peak);
    peak.connect(ctx.destination);
    peak.connect(dly);
    dly.connect(dlp);
    dlp.connect(fb);
    fb.connect(dly);
    dlp.connect(ctx.destination);

    // G5 – E5 – C5, each a struck bar with a little shimmer
    const notes = [783.99, 659.25, 523.25];
    notes.forEach((f, i) => {
      const t = t0 + i * 0.42;
      [
        [1, 0.16, 1.9],
        [2.01, 0.035, 0.7],
        [3.98, 0.012, 0.25],
      ].forEach(([mul, pk, dec]) => {
        const o = ctx.createOscillator();
        o.type = "sine";
        o.frequency.value = f * mul;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(pk, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dec);
        o.connect(g);
        g.connect(out);
        o.start(t);
        o.stop(t + dec + 0.05);
      });
    });
    setTimeout(() => {
      try {
        fb.gain.value = 0;
        out.disconnect();
        dlp.disconnect();
        peak.disconnect();
      } catch {
        /* already gone */
      }
    }, 4200);
    counters.chimes++;
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* announcements                                                     */
  /* ---------------------------------------------------------------- */
  function pick(ctx) {
    const fits = messages.filter((m) => (!m.when || m.when(ctx)) && !secretNamed(m.text, ctx.seen));
    if (!fits.length) return null;
    bag = bag.filter((id) => fits.some((m) => m.id === id));
    if (!bag.length) {
      bag = fits.map((m) => m.id);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      // a fresh bag never opens with the one just heard
      if (bag.length > 1 && bag[0] === lastId) bag.push(bag.shift());
    }
    const id = bag.shift();
    return fits.find((m) => m.id === id);
  }

  /**
   * Make an announcement now (if nothing is playing and the PA is on).
   * opts.force skips the busy check (e.g. "the screening is starting").
   * Returns true when it went out.
   */
  function announce(text, opts = {}) {
    const s = readState();
    if (!enabled || s.pa === false || !text) return false;
    // never, not even forced: a secret room named before it was found
    if (secretNamed(text, (id) => seen(id, s))) return false;
    if (!opts.force && isBusy(s)) return false;
    if (current) finish(true);

    const muted = isMuted(s);
    const reduced = !!s.reduced;
    const id = opts.id || null;
    const hold = clamp(HOLD_MIN + String(text).length * HOLD_PER_CHAR, HOLD_MIN, HOLD_MAX);
    const sound = !muted && chime();
    const a = {
      id,
      text,
      force: !!opts.force,
      el: showCaption(text, { reduced, quietSound: !sound }),
      left: hold + (sound ? CHIME_LEAD : 0),
      speaking: false,
      speakAt: sound && !reduced && s.speech !== false && narrator ? CHIME_LEAD : -1,
      spoken: null,
    };
    current = a;
    if (sound && audio?.duck && !audio.ducked) {
      audio.duck(true);
      weDucked = true;
    }
    lastId = id;
    counters.announced++;
    return true;
  }

  function speak(a) {
    a.speakAt = -1;
    if (guideNarrator()) {
      // subtitles-only (no voice, sound off): our card already is the caption
      if (narrator.available === false) return;
      let ok = false;
      try {
        ok = narrator.speak(a.text, {
          id: PA_ID,
          label: PA_LABEL,
          onEnd: (reason) => {
            a.speaking = false;
            // read to the end: the guide's box was the caption, we are done
            if (reason === "done") a.left = 0;
          },
        });
      } catch {
        ok = false;
      }
      if (!ok) return;
      a.speaking = true;
      a.guide = true;
      counters.spoken++;
      // the guide's subtitle box shows the words now: one caption, not two
      // (ours comes back if the guide stops before the reading time is up)
      a.el?.classList.add("handoff");
      return;
    }
    const fn = narrator?.say || narrator?.speak;
    if (!fn) return;
    let r;
    try {
      r = fn.call(narrator, a.text, { kind: PA_ID, id: PA_ID, label: PA_LABEL });
    } catch {
      return;
    }
    a.speaking = true;
    counters.spoken++;
    if (r && typeof r.then === "function") {
      a.spoken = r;
      r.then(
        () => {
          a.speaking = false;
        },
        () => {
          a.speaking = false;
        }
      );
    } else {
      // no promise: the narrator's own flag (or the caption time) decides
      a.speaking = !!(narrator.speaking ?? true);
      a.untilFlag = narrator.speaking !== undefined;
    }
  }

  /** End the current announcement; cut = something else took over. */
  function finish(cut = false) {
    const a = current;
    if (!a) return;
    current = null;
    if (cut) {
      counters.cut++;
      if (a.speaking) {
        // stop only our own announcement, never a talk that replaced it
        if (a.guide) {
          if (narrator.current === PA_ID) narrator.stop?.();
        } else narrator?.cancel?.();
      }
    }
    hideCaption(a.el, cut);
    if (weDucked) {
      weDucked = false;
      // a video that started meanwhile ducked too: leave it ducked
      if (!cut && audio?.ducked) audio.duck(false);
      else if (cut && audio?.ducked && !readState().busy) audio.duck(false);
    }
  }

  function tickCurrent(dt, s) {
    const a = current;
    if (!a) return;
    if (!a.force && (s.busy || (narrating() && !a.speaking && a.speakAt < 0))) {
      finish(true);
      return;
    }
    if (a.speakAt >= 0) {
      a.speakAt -= dt;
      if (a.speakAt <= 0) speak(a);
    }
    if (a.speaking && a.untilFlag) a.speaking = !!narrator?.speaking;
    if (a.guide && !a.speaking && a.left > 0) a.el?.classList.remove("handoff");
    a.left -= dt;
    // the caption stays for as long as the voice is still reading
    if (a.left <= 0 && !a.speaking) finish(false);
  }

  function tickSchedule(dt, s) {
    if (!enabled || s.pa === false || current) return;
    quiet = isBusy(s) ? 0 : quiet + dt;
    wait -= dt;
    if (wait > 0) return;
    if (quiet < QUIET_NEEDED) {
      if (wait > -dt) counters.held++;
      return;
    }
    const m = pick({ room, occupancy, seen: (id) => seen(id, s) });
    if (m) announce(m.text, { id: m.id });
    const scale = s.reduced ? 1.5 : 1;
    wait = rnd(random, interval) * scale;
  }

  /* ---------------------------------------------------------------- */
  /* occupancy + murmur                                                */
  /* ---------------------------------------------------------------- */
  function countOccupancy(s) {
    const here = roomAt(s.x, s.z);
    room = here?.id || null;
    if (here?.secret) seenSecret.add(here.id);
    let players = 0;
    let npcs = 0;
    if (room) {
      for (const r of s.remotes || []) if (r && roomAt(r.x, r.z)?.id === room) players++;
      for (const n of s.npcs || []) if (n && roomAt(n.x, n.z)?.id === room) npcs++;
    }
    // a real person counts for more than a background visitor
    const total = players + npcs;
    const cells = here ? (here.cols[1] - here.cols[0] + 1) * (here.rows[1] - here.rows[0] + 1) : 1;
    const crowding = (players * 1.5 + npcs) / Math.max(4, cells * 0.35);
    occupancy.players = players;
    occupancy.npcs = npcs;
    occupancy.total = total;
    occupancy.room = room;
    occupancy.level = total ? clamp(1 - Math.exp(-(total * 0.18 + crowding * 1.2)), 0, 1) : 0;

    if (typeof audio?.setOccupancy === "function") {
      if (total !== lastOccSent) {
        lastOccSent = total;
        try {
          audio.setOccupancy(total, { room, players, npcs, level: occupancy.level });
        } catch {
          /* audio's business */
        }
      }
    }
  }

  function murmurTarget(s) {
    if (!murmur || typeof audio?.setOccupancy === "function") return 0;
    if (isMuted(s) || s.busy) return 0;
    const vol = clamp(Number(audio?.volume ?? 0.8), 0, 1);
    const duck = audio?.ducked ? 0.3 : 1;
    // corridors carry less; the theatre hushes
    const roomMul = room === "theater" ? 0.35 : /corridor|link|wc2|ec2|passage/.test(room || "") ? 0.6 : 1;
    return MURMUR_MAX * occupancy.level * vol * duck * roomMul * (s.reduced ? 0.6 : 1);
  }

  function makeMurmur(ctx) {
    // pink-ish noise, shaped into a few unintelligible "voices"
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b0 = 0,
      b1 = 0,
      b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029591;
      b1 = 0.985 * b1 + w * 0.032534;
      b2 = 0.95 * b2 + w * 0.048056;
      d[i] = (b0 + b1 + b2 + w * 0.05) * 2.2;
    }
    const out = ctx.createGain();
    out.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 1700;
    out.connect(lp);
    lp.connect(ctx.destination);
    const voices = [];
    for (let i = 0; i < 4; i++) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 380 + random() * 700;
      bp.Q.value = 2.2 + random() * 1.5;
      const g = ctx.createGain();
      g.gain.value = 0.5;
      // syllables: a slow wobble on each voice's level
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 2.4 + random() * 2.6;
      const depth = ctx.createGain();
      depth.gain.value = 0.42;
      lfo.connect(depth);
      depth.connect(g.gain);
      src.connect(bp);
      bp.connect(g);
      g.connect(out);
      src.start(0, random() * 2.5);
      lfo.start();
      voices.push({ src, bp, lfo });
    }
    return { ctx, out, lp, voices, idle: 0, wander: 0 };
  }

  function stopMurmur() {
    if (!murmurLayer) return;
    const m = murmurLayer;
    murmurLayer = null;
    for (const v of m.voices) {
      try {
        v.src.stop();
        v.lfo.stop();
      } catch {
        /* never started */
      }
    }
    try {
      m.lp.disconnect();
    } catch {
      /* gone */
    }
  }

  function tickMurmur(dt, s) {
    const target = murmurTarget(s);
    const ctx = target > 0 ? audio?.ensure?.() : murmurLayer?.ctx;
    if (!murmurLayer) {
      if (target <= 0 || !ctx || ctx.state !== "running") return;
      murmurLayer = makeMurmur(ctx);
    }
    const m = murmurLayer;
    m.out.gain.setTargetAtTime(target, m.ctx.currentTime, 1.2);
    // voices drift so the babble never settles into a tone
    m.wander -= dt;
    if (m.wander <= 0) {
      m.wander = 0.8 + random() * 1.2;
      const v = m.voices[Math.floor(random() * m.voices.length)];
      v.bp.frequency.setTargetAtTime(380 + random() * 700, m.ctx.currentTime, 0.6);
      v.lfo.frequency.setTargetAtTime(2.4 + random() * 2.6, m.ctx.currentTime, 0.8);
    }
    // silent for a while: free the nodes
    m.idle = target > 0 ? 0 : m.idle + dt;
    if (m.idle > 4) stopMurmur();
  }

  /* ---------------------------------------------------------------- */
  /* frame                                                             */
  /* ---------------------------------------------------------------- */
  function update(dt) {
    dt = clamp(Number(dt) || 0, 0, 0.25);
    const s = readState();
    if (s.x == null || s.z == null) return; // not in the building yet
    occTimer -= dt;
    if (occTimer <= 0) {
      occTimer = OCC_EVERY;
      countOccupancy(s);
    }
    tickCurrent(dt, s);
    tickSchedule(dt, s);
    tickMurmur(dt, s);
  }

  return {
    update,
    announce,
    /** Play one of the stock announcements by id (ignores its `when`). */
    say(id, opts = {}) {
      const m = messages.find((x) => x.id === id);
      return m ? announce(m.text, { ...opts, id: m.id }) : false;
    },
    /** Mark a secret room as found (e.g. from the minimap's reveal). */
    reveal(id) {
      if (SECRETS.some((x) => x.id === id)) seenSecret.add(id);
    },
    /** { players, npcs, total, room, level 0..1 } in the local player's room. */
    get occupancy() {
      return { ...occupancy };
    },
    /** Seconds until the next announcement is due. */
    get next() {
      return Math.max(0, wait);
    },
    get announcing() {
      return current ? current.text : null;
    },
    get enabled() {
      return enabled;
    },
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) finish(true);
    },
    /** Debug / tests: counters plus the murmur level now. */
    stats() {
      return {
        ...counters,
        next: +Math.max(0, wait).toFixed(2),
        quiet: +quiet.toFixed(2),
        murmur: murmurLayer ? +murmurLayer.out.gain.value.toFixed(4) : 0,
        murmurHook: typeof audio?.setOccupancy === "function",
        secretsSeen: SECRETS.filter((x) => seen(x.id)).map((x) => x.id),
      };
    },
    dispose() {
      finish(true);
      stopMurmur();
    },
  };
}

/**
 * A narrator in createAtmosphere's shape on top of the browser's speech
 * synthesis: a calm English voice, slightly slow, like a PA reader.
 * Returns null where speech synthesis is unavailable.
 */
export function createSpeechNarrator({ rate = 0.94, pitch = 1, volume = 0.9, lang = "en" } = {}) {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") return null;
  let speaking = false;
  const pickVoice = () => {
    const voices = synth.getVoices() || [];
    const en = voices.filter((v) => (v.lang || "").toLowerCase().startsWith(lang));
    return (
      en.find((v) => /Daniel|Serena|Kate|Google UK English Female|Samantha/i.test(v.name)) || en.find((v) => v.localService) || en[0] || null
    );
  };
  return {
    get speaking() {
      return speaking;
    },
    say(text) {
      return new Promise((resolve) => {
        try {
          synth.cancel();
          const u = new SpeechSynthesisUtterance(String(text));
          const v = pickVoice();
          if (v) u.voice = v;
          u.rate = rate;
          u.pitch = pitch;
          u.volume = volume;
          const done = () => {
            speaking = false;
            resolve();
          };
          u.onend = done;
          u.onerror = done;
          speaking = true;
          synth.speak(u);
          // some engines never fire onend: give up after a generous read time
          setTimeout(done, 2500 + String(text).length * 90);
        } catch {
          speaking = false;
          resolve();
        }
      });
    },
    cancel() {
      speaking = false;
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
    },
  };
}
