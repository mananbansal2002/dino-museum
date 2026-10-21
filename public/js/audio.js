/**
 * Procedural sound bank — no audio files, everything is synthesised with the
 * Web Audio API so the museum stays a single static deploy.
 *
 * Signal graph
 *
 *   sfx ──────────────┐
 *   ambBus → ambDuck ─┼→ master → compressor → destination
 *   revIn → convolver → revOut ┘
 *
 * Every gain change is ramped (no clicks), noise comes from a few looped
 * buffers generated once, and ambience beds are only alive while audible.
 *
 * Public API (backwards compatible):
 *   ensure(), ambient(on), roar(intensity), chime(freq?), slurp(), step(vol),
 *   click(freq), setMuted(bool), muted
 * New:
 *   setZone(name)          zone key or a hall name ("Jurassic Hall" etc.)
 *   setMasterVolume(0..1)  persisted
 *   duck(on)               lowers ambience (e.g. while a video plays)
 *   zone, volume, ducked   getters
 * Also exported: zoneForHall(hallName), ZONES.
 */

export const ZONES = [
  "atrium",
  "gallery",
  "triassic",
  "jurassic",
  "cretaceous",
  "marine",
  "theatre",
  "icecream",
  "plaza",
];

/** Map a hall name (or a zone key) to an ambience zone. */
export function zoneForHall(name) {
  const s = String(name || "").toLowerCase();
  if (ZONES.includes(s)) return s;
  if (s.includes("triassic")) return "triassic";
  if (s.includes("jurassic")) return "jurassic";
  if (s.includes("cretaceous")) return "cretaceous";
  if (s.includes("marine") || s.includes("ocean") || s.includes("sea")) return "marine";
  if (s.includes("theatre") || s.includes("theater") || s.includes("screening")) return "theatre";
  if (s.includes("ice cream") || s.includes("icecream")) return "icecream";
  if (s.includes("plaza") || s.includes("outside")) return "plaza";
  if (s.includes("atrium") || s.includes("entrance")) return "atrium";
  return "gallery"; // Grand Gallery, Exit Passage, anything unknown
}

const STORE_MUTED = "dino-museum:audio:muted";
const STORE_VOLUME = "dino-museum:audio:volume";

function load(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    /* storage blocked — ignore */
  }
}

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Per-zone level of the shared room tone underneath the zone bed. */
const ROOM_LEVEL = {
  atrium: 1,
  gallery: 1,
  triassic: 0.6,
  jurassic: 0.5,
  cretaceous: 0.6,
  marine: 0.35,
  theatre: 0.45,
  icecream: 0.6,
  plaza: 0.25,
};

export function createAudio() {
  let ctx = null;
  let master, comp, sfx, ambBus, ambDuck, ambRevSend, revIn, revOut;
  let noiseWhite, noisePink, noiseBrown, shaperCurve;
  let muted = load(STORE_MUTED, "0") === "1";
  let volume = clamp(parseFloat(load(STORE_VOLUME, "0.8")) || 0, 0, 1);
  if (!Number.isFinite(volume)) volume = 0.8;
  let ducked = false;
  let ambientOn = false;
  let zone = "atrium";
  let roomBed = null;
  let zoneBed = null;
  let activeRoars = 0;
  let lastStep = 0;
  let suspendTimer = 0;

  const MASTER_GAIN = 0.9;
  const masterTarget = () => (muted ? 0 : volume * MASTER_GAIN);

  /* ---------------------------------------------------------------- */
  /* setup                                                             */
  /* ---------------------------------------------------------------- */
  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try {
        ctx = new AC();
      } catch {
        return null;
      }
      build();
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", () => {
          if (!ctx) return;
          if (document.hidden) ctx.suspend().catch(() => {});
          else if (!muted) ctx.resume().catch(() => {});
        });
      }
    }
    if (ctx.state === "suspended" && !muted && !(typeof document !== "undefined" && document.hidden)) {
      ctx.resume().catch(() => {});
    }
    return ctx;
  }

  function build() {
    const c = ctx;
    comp = c.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.25;
    comp.connect(c.destination);

    master = c.createGain();
    master.gain.value = masterTarget();
    master.connect(comp);

    sfx = c.createGain();
    sfx.connect(master);

    ambBus = c.createGain();
    ambBus.gain.value = 0.7;
    ambDuck = c.createGain();
    ambDuck.gain.value = ducked ? 0.22 : 1;
    ambBus.connect(ambDuck);
    ambDuck.connect(master);

    revIn = c.createGain();
    const conv = c.createConvolver();
    conv.buffer = impulse(2.8);
    revOut = c.createGain();
    revOut.gain.value = 0.55;
    revIn.connect(conv);
    conv.connect(revOut);
    revOut.connect(master);

    ambRevSend = c.createGain();
    ambRevSend.gain.value = ducked ? 0.22 : 1;
    ambRevSend.connect(revIn);

    noiseWhite = makeNoise(2, "white");
    noisePink = makeNoise(4, "pink");
    noiseBrown = makeNoise(4, "brown");

    shaperCurve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      shaperCurve[i] = Math.tanh(2.6 * x) / Math.tanh(2.6);
    }

    if (muted) ctx.suspend().catch(() => {});
  }

  /** Stone-hall impulse response: stereo decaying noise, darker over time. */
  function impulse(seconds) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const p = i / len;
        const k = 0.75 - 0.65 * p; // one-pole coefficient: brighter early, darker tail
        lp += k * (Math.random() * 2 - 1 - lp);
        const early = i < rate * 0.08 && Math.random() < 0.004 ? 1.5 : 0;
        d[i] = (lp + early * (Math.random() - 0.5)) * Math.pow(1 - p, 3.2);
      }
    }
    return buf;
  }

  /** Seamlessly loopable noise buffer. */
  function makeNoise(seconds, color) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const fade = 2048;
    const raw = new Float32Array(len + fade);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
    for (let i = 0; i < raw.length; i++) {
      const w = Math.random() * 2 - 1;
      if (color === "pink") {
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      } else if (color === "brown") {
        br = (br + 0.02 * w) / 1.02;
        raw[i] = br * 3.5;
      } else {
        raw[i] = w;
      }
    }
    const buf = ctx.createBuffer(1, len, rate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      if (i < fade) {
        const k = i / fade;
        d[i] = raw[i] * k + raw[len + i] * (1 - k);
      } else d[i] = raw[i];
    }
    return buf;
  }

  /* ---------------------------------------------------------------- */
  /* helpers                                                           */
  /* ---------------------------------------------------------------- */
  const ready = () => ctx && ctx.state !== "closed";
  const playable = () => ready() && !muted;

  function rampTo(param, v, seconds) {
    const t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    param.linearRampToValueAtTime(v, t + Math.max(0.01, seconds));
  }

  function gainNode(v = 1) {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  }

  function filter(type, freq, q = 0.7) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  function noiseSrc(buffer, loop = false) {
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.loop = loop;
    return s;
  }

  /** Percussive envelope on a gain param: 0 → peak → ~0 → 0, click-free. */
  function perc(param, t, peak, attack, decay) {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + attack);
    param.exponentialRampToValueAtTime(Math.max(1e-4, peak * 1e-3), t + attack + decay);
    param.linearRampToValueAtTime(0, t + attack + decay + 0.02);
    return t + attack + decay + 0.04;
  }

  /** Output node routed dry to `dest` and wet into the reverb. */
  function voiceOut(dest, wet) {
    const g = ctx.createGain();
    g.connect(dest);
    if (wet > 0) {
      const s = gainNode(wet);
      g.connect(s);
      s.connect(dest === sfx ? revIn : ambRevSend);
    }
    return g;
  }

  /** Simple enveloped oscillator note. */
  function tone(dest, { type = "sine", freq, t, peak, attack = 0.005, decay = 0.5, glideTo }) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + attack + decay);
    const g = ctx.createGain();
    const end = perc(g.gain, t, peak, attack, decay);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(end);
    return o;
  }

  /* ---------------------------------------------------------------- */
  /* roar                                                              */
  /* ---------------------------------------------------------------- */
  function roarVoice(power, { distant = false, dest = sfx, level = 1 } = {}) {
    const c = ctx;
    const p = clamp(Number(power) || 1, 0.15, 1.6);
    const t = c.currentTime + 0.02;
    const dur = rand(1.3, 2.2) * (0.7 + 0.35 * p) * (distant ? 1.3 : 1);
    const f0 = rand(40, 66) * (distant ? 0.85 : 1);
    const atk = rand(0.12, 0.26);
    const peakT = t + dur * rand(0.2, 0.35);
    const end = t + dur;
    const lvl = 0.42 * p * level;

    // master envelope
    const env = c.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(lvl, t + atk);
    env.gain.linearRampToValueAtTime(lvl * rand(0.7, 0.9), t + dur * 0.55);
    env.gain.exponentialRampToValueAtTime(lvl * 0.002, end);
    env.gain.linearRampToValueAtTime(0, end + 0.05);
    const stopAt = end + 0.1;

    // routing
    if (distant) {
      const lp = filter("lowpass", rand(380, 600), 0.5);
      env.connect(lp);
      const dry = gainNode(0.25);
      lp.connect(dry);
      dry.connect(dest);
      lp.connect(dest === sfx ? revIn : ambRevSend);
    } else {
      env.connect(dest);
      const send = gainNode(0.35);
      env.connect(send);
      send.connect(revIn);
    }

    // growl source: detuned saws, pitch contour + wobble
    const oscs = [];
    const src = gainNode(0.5);
    const contour = (param, mul) => {
      param.setValueAtTime(f0 * 0.78 * mul, t);
      param.exponentialRampToValueAtTime(f0 * rand(1.08, 1.25) * mul, peakT);
      param.exponentialRampToValueAtTime(f0 * rand(0.55, 0.68) * mul, end);
    };
    [1, 1.006, 0.497].forEach((mul, i) => {
      const o = c.createOscillator();
      o.type = i === 2 ? "triangle" : "sawtooth";
      contour(o.frequency, mul);
      o.connect(src);
      oscs.push(o);
    });
    const wob = c.createOscillator();
    wob.frequency.value = rand(4.5, 8);
    const wobG = gainNode(f0 * 0.05);
    wob.connect(wobG);
    oscs.forEach((o) => wobG.connect(o.frequency));
    oscs.push(wob);

    // rasp: fast amplitude modulation
    const am = gainNode(0.6);
    const rasp = c.createOscillator();
    rasp.type = "sine";
    rasp.frequency.setValueAtTime(rand(18, 26), t);
    rasp.frequency.linearRampToValueAtTime(rand(26, 36), peakT);
    rasp.frequency.linearRampToValueAtTime(rand(14, 20), end);
    const raspDepth = gainNode(0.4);
    rasp.connect(raspDepth);
    raspDepth.connect(am.gain);
    oscs.push(rasp);

    const shaper = c.createWaveShaper();
    shaper.curve = shaperCurve;
    src.connect(shaper);
    shaper.connect(am);

    // formants (throat opening up and closing)
    const sweep = (param, a, b, z) => {
      param.setValueAtTime(a, t);
      param.exponentialRampToValueAtTime(b, peakT);
      param.exponentialRampToValueAtTime(z, end);
    };
    const f1 = filter("bandpass", 300, 4);
    sweep(f1.frequency, rand(220, 320), rand(520, 760), rand(240, 320));
    const f2 = filter("bandpass", 800, 6);
    sweep(f2.frequency, rand(650, 850), rand(1250, 1750), rand(650, 850));
    const body = filter("lowpass", rand(320, 420), 1.2);
    const g1 = gainNode(1.2), g2 = gainNode(0.55), gb = gainNode(0.7);
    am.connect(f1); f1.connect(g1); g1.connect(env);
    am.connect(f2); f2.connect(g2); g2.connect(env);
    am.connect(body); body.connect(gb); gb.connect(env);

    // breath noise
    const n = noiseSrc(noiseWhite, true);
    const nf = filter("bandpass", 900, 0.9);
    sweep(nf.frequency, rand(500, 800), rand(1500, 2400), rand(500, 700));
    const ng = gainNode(distant ? 0.18 : 0.3);
    n.connect(nf); nf.connect(ng); ng.connect(env);

    // sub weight
    const sub = c.createOscillator();
    sub.type = "sine";
    contour(sub.frequency, 0.5);
    const sg = gainNode(0.6);
    sub.connect(sg); sg.connect(env);
    oscs.push(sub);

    oscs.forEach((o) => { o.start(t); o.stop(stopAt); });
    n.start(t, rand(0, 1.5));
    n.stop(stopAt);

    activeRoars++;
    sub.onended = () => {
      activeRoars = Math.max(0, activeRoars - 1);
      env.disconnect();
    };
  }

  /* ---------------------------------------------------------------- */
  /* footsteps                                                         */
  /* ---------------------------------------------------------------- */
  function stepVoice(vol, dest = sfx, wet = 0.12, bright = 1) {
    const t = ctx.currentTime + 0.005;
    const v = clamp(Number(vol) || 1, 0, 2) * 0.11;
    const out = voiceOut(dest, wet);
    // heel scuff: short band-limited noise
    const n = noiseSrc(noiseWhite);
    const bp = filter("bandpass", rand(1600, 2600) * bright, rand(0.9, 1.4));
    const ng = ctx.createGain();
    const e1 = perc(ng.gain, t, v * 0.8, 0.002, rand(0.035, 0.06));
    n.connect(bp); bp.connect(ng); ng.connect(out);
    n.start(t, rand(0, 1.8));
    n.stop(e1);
    // soft thud on stone
    const o = tone(out, {
      freq: rand(110, 140),
      glideTo: rand(55, 70),
      t,
      peak: v * 0.9,
      attack: 0.003,
      decay: rand(0.06, 0.09),
    });
    o.onended = () => out.disconnect();
  }

  /* ---------------------------------------------------------------- */
  /* ambience beds                                                     */
  /* ---------------------------------------------------------------- */
  function makeBed(name, level = 1, wet = 0.35) {
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(ambBus);
    const send = gainNode(wet);
    out.connect(send);
    send.connect(ambRevSend);
    const bed = { name, out, level, sources: [], timers: new Set(), alive: true };
    return bed;
  }

  function bedStart(bed, node, offset) {
    bed.sources.push(node);
    if (offset !== undefined) node.start(ctx.currentTime, offset);
    else node.start();
    return node;
  }

  /** Looped noise through a filter into the bed. Returns the parts for modulation. */
  function bedNoise(bed, buffer, type, freq, q, gain) {
    const s = noiseSrc(buffer, true);
    const f = filter(type, freq, q);
    const g = gainNode(gain);
    s.connect(f); f.connect(g); g.connect(bed.out);
    bedStart(bed, s, rand(0, buffer.duration));
    return { src: s, filter: f, gain: g };
  }

  /** Slow LFO modulating an AudioParam around its current value. */
  function bedLfo(bed, param, rate, depth, type = "sine") {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = rate;
    const g = gainNode(depth);
    o.connect(g); g.connect(param);
    bedStart(bed, o);
    return o;
  }

  function bedOsc(bed, type, freq, gain) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = gainNode(gain);
    o.connect(g); g.connect(bed.out);
    bedStart(bed, o);
    return { osc: o, gain: g };
  }

  /** Run fn at random intervals while the bed lives and sound is running. */
  function every(bed, minS, maxS, fn, firstDelay) {
    const schedule = (delay) => {
      const id = setTimeout(() => {
        bed.timers.delete(id);
        if (!bed.alive) return;
        if (ctx.state === "running" && !muted) {
          try { fn(); } catch { /* never let ambience throw */ }
        }
        schedule(rand(minS, maxS));
      }, delay * 1000);
      bed.timers.add(id);
    };
    schedule(firstDelay ?? rand(minS, maxS));
  }

  function fadeIn(bed, seconds) {
    rampTo(bed.out.gain, bed.level, seconds);
  }

  function killBed(bed, seconds = 2.5) {
    if (!bed || !bed.alive) return;
    bed.alive = false;
    bed.timers.forEach((id) => clearTimeout(id));
    bed.timers.clear();
    rampTo(bed.out.gain, 0, seconds);
    const stopAt = ctx.currentTime + seconds + 0.1;
    bed.sources.forEach((s) => { try { s.stop(stopAt); } catch { /* already stopped */ } });
    setTimeout(() => {
      try { bed.out.disconnect(); } catch { /* ignore */ }
    }, (seconds + 0.5) * 1000);
  }

  /* ---- one-shot ambient events ---------------------------------- */

  function farFootsteps(bed) {
    const count = Math.floor(rand(3, 7));
    const gap = rand(0.42, 0.6);
    for (let i = 0; i < count; i++) {
      const id = setTimeout(() => {
        bed.timers.delete(id);
        if (bed.alive && ctx.state === "running") stepVoice(rand(0.25, 0.4), bed.out, 1.4, 0.6);
      }, i * gap * 1000);
      bed.timers.add(id);
    }
  }

  function bird(dest) {
    const t0 = ctx.currentTime + 0.02;
    const base = rand(2200, 4200);
    const chirps = Math.floor(rand(2, 6));
    const kind = Math.random();
    for (let i = 0; i < chirps; i++) {
      const t = t0 + i * rand(0.09, 0.16);
      const up = kind < 0.5;
      tone(dest, {
        freq: base * (up ? 0.8 : 1.25),
        glideTo: base * (up ? 1.3 : 0.75),
        t,
        peak: rand(0.012, 0.025),
        attack: 0.01,
        decay: rand(0.05, 0.1),
      });
    }
  }

  function cricket(dest) {
    const t0 = ctx.currentTime + 0.02;
    const o = ctx.createOscillator();
    o.frequency.value = rand(4200, 5200);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    const groups = Math.floor(rand(3, 7));
    const peak = rand(0.006, 0.012);
    let t = t0;
    for (let k = 0; k < groups; k++) {
      for (let p = 0; p < 3; p++) {
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(peak, t + 0.006);
        g.gain.linearRampToValueAtTime(0, t + 0.018);
        t += 0.028;
      }
      t += rand(0.18, 0.3);
    }
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t + 0.05);
  }

  function thunder(dest) {
    const t = ctx.currentTime + 0.02;
    const dur = rand(3.5, 6);
    const n = noiseSrc(noiseBrown, true);
    const lp = filter("lowpass", 260, 0.6);
    lp.frequency.setValueAtTime(rand(300, 420), t);
    lp.frequency.exponentialRampToValueAtTime(70, t + dur);
    const g = ctx.createGain();
    const lvl = rand(0.25, 0.45);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(lvl, t + rand(0.25, 0.6));
    g.gain.linearRampToValueAtTime(lvl * 0.6, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(lvl * 0.8, t + dur * 0.4); // second rumble
    g.gain.exponentialRampToValueAtTime(lvl * 0.002, t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.05);
    n.connect(lp); lp.connect(g); g.connect(dest);
    n.start(t, rand(0, 3));
    n.stop(t + dur + 0.1);
  }

  function bubbles(dest) {
    const count = Math.floor(rand(1, 5));
    const t0 = ctx.currentTime + 0.02;
    for (let i = 0; i < count; i++) {
      const f = rand(280, 900);
      tone(dest, {
        freq: f,
        glideTo: f * rand(1.6, 2.4),
        t: t0 + i * rand(0.05, 0.18),
        peak: rand(0.01, 0.025),
        attack: 0.004,
        decay: rand(0.03, 0.06),
      });
    }
  }

  function whaleMoan(dest) {
    const t = ctx.currentTime + 0.02;
    const dur = rand(2.5, 4);
    const f = rand(90, 140);
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * rand(1.4, 1.8), t + dur * 0.45);
    o.frequency.exponentialRampToValueAtTime(f * 0.7, t + dur);
    const lp = filter("lowpass", 500, 2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.03, t + dur * 0.3);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(lp); lp.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function musicBox(bed) {
    // Gentle C-major pentatonic loop, eighth notes.
    const mel = [0, 4, 7, 12, 9, 7, 4, null, 2, 4, 7, 9, 7, null, 4, 2,
      0, 4, 7, 12, 14, 12, 9, 7, 9, 7, 4, 2, 0, null, null, null];
    const bass = { 0: 0, 8: -3, 16: -7, 24: -5 };
    const stepDur = 0.27;
    const C5 = 523.25;
    let step = 0;
    let next = ctx.currentTime + 0.3;
    const note = (f, t, peak) => {
      tone(bed.out, { freq: f, t, peak, attack: 0.002, decay: 1.5 });
      tone(bed.out, { freq: f * 3, t, peak: peak * 0.12, attack: 0.002, decay: 0.25 });
    };
    const tick = () => {
      if (!bed.alive) return;
      if (ctx.state === "running" && !muted) {
        if (next < ctx.currentTime) next = ctx.currentTime + 0.05;
        while (next < ctx.currentTime + 0.5) {
          const n = mel[step];
          if (n !== null) note(C5 * Math.pow(2, n / 12), next, rand(0.028, 0.04));
          if (bass[step] !== undefined) note((C5 / 2) * Math.pow(2, bass[step] / 12), next, 0.022);
          step = (step + 1) % mel.length;
          next += stepDur;
        }
      }
      const id = setTimeout(() => { bed.timers.delete(id); tick(); }, 150);
      bed.timers.add(id);
    };
    tick();
  }

  /* ---- beds ----------------------------------------------------- */

  function buildRoom() {
    const bed = makeBed("room", ROOM_LEVEL[zone] ?? 1, 0.25);
    bedNoise(bed, noiseBrown, "lowpass", 160, 0.5, 0.35);
    const air = bedNoise(bed, noisePink, "bandpass", 520, 0.5, 0.035);
    bedLfo(bed, air.gain.gain, 0.05, 0.012);
    bedOsc(bed, "sine", 55, 0.01);
    bedOsc(bed, "sine", 110.3, 0.004);
    // distant echoes of other visitors
    every(bed, 14, 32, () => {
      if (["atrium", "gallery"].includes(zone)) farFootsteps(bed);
    }, rand(6, 14));
    // occasional far-off roar from another hall
    every(bed, 45, 110, () => {
      if (ducked || activeRoars > 1) return;
      if (["theatre", "icecream", "marine", "plaza"].includes(zone)) return;
      roarVoice(rand(0.35, 0.6), { distant: true, dest: bed.out, level: 0.5 });
    }, rand(25, 50));
    return bed;
  }

  function buildZone(name) {
    switch (name) {
      case "atrium": {
        const bed = makeBed(name, 1, 0.5);
        const air = bedNoise(bed, noisePink, "bandpass", 1300, 0.6, 0.02);
        bedLfo(bed, air.filter.frequency, 0.04, 300);
        return bed;
      }
      case "gallery": {
        const bed = makeBed(name, 1, 0.5);
        bedNoise(bed, noisePink, "lowpass", 700, 0.5, 0.03);
        return bed;
      }
      case "triassic": {
        const bed = makeBed(name, 1, 0.2);
        const w = bedNoise(bed, noisePink, "bandpass", 650, 0.8, 0.09);
        bedLfo(bed, w.filter.frequency, 0.07, 260);
        bedLfo(bed, w.gain.gain, 0.11, 0.045);
        const hiss = bedNoise(bed, noiseWhite, "highpass", 3500, 0.5, 0.006);
        bedLfo(bed, hiss.gain.gain, 0.09, 0.004);
        every(bed, 2.5, 7, () => cricket(bed.out), 2);
        return bed;
      }
      case "jurassic": {
        const bed = makeBed(name, 1, 0.3);
        bedNoise(bed, noiseBrown, "lowpass", 350, 0.5, 0.12); // humid air
        const leaves = bedNoise(bed, noisePink, "highpass", 2500, 0.5, 0.02);
        bedLfo(bed, leaves.gain.gain, 0.13, 0.012);
        // cicada drone: band-passed noise with fast tremolo
        const cic = bedNoise(bed, noiseWhite, "bandpass", 5600, 7, 0.05);
        const trem = gainNode(0.5); // 0..1 tremolo
        const swell = gainNode(0.5); // slow swell in and out
        cic.gain.disconnect();
        cic.gain.connect(trem);
        trem.connect(swell);
        swell.connect(bed.out);
        bedLfo(bed, trem.gain, 38, 0.5, "triangle");
        bedLfo(bed, swell.gain, 0.06, 0.45);
        every(bed, 1.5, 5, () => bird(bed.out), 1);
        every(bed, 4, 9, () => cricket(bed.out), 3);
        return bed;
      }
      case "cretaceous": {
        const bed = makeBed(name, 1, 0.35);
        const w = bedNoise(bed, noisePink, "bandpass", 380, 0.7, 0.13);
        bedLfo(bed, w.filter.frequency, 0.05, 180);
        bedLfo(bed, w.gain.gain, 0.08, 0.06);
        const gust = bedNoise(bed, noiseWhite, "bandpass", 1400, 1.5, 0.008);
        bedLfo(bed, gust.filter.frequency, 0.13, 500);
        every(bed, 18, 40, () => thunder(bed.out), rand(5, 12));
        return bed;
      }
      case "marine": {
        const bed = makeBed(name, 1, 0.6);
        const r = bedNoise(bed, noiseBrown, "lowpass", 280, 1.5, 0.4);
        bedLfo(bed, r.filter.frequency, 0.05, 120);
        bedLfo(bed, r.gain.gain, 0.07, 0.12);
        const wash = bedNoise(bed, noisePink, "bandpass", 450, 0.8, 0.03);
        bedLfo(bed, wash.gain.gain, 0.12, 0.025);
        const drone = bedOsc(bed, "sine", 41, 0.025);
        bedLfo(bed, drone.osc.frequency, 0.1, 1.5);
        every(bed, 0.8, 4, () => bubbles(bed.out), 1);
        every(bed, 25, 55, () => whaleMoan(bed.out), rand(8, 16));
        return bed;
      }
      case "theatre": {
        const bed = makeBed(name, 1, 0.1);
        bedOsc(bed, "sine", 60, 0.012);
        bedOsc(bed, "sine", 120, 0.004);
        bedNoise(bed, noisePink, "lowpass", 400, 0.5, 0.012);
        return bed;
      }
      case "icecream": {
        const bed = makeBed(name, 1, 0.45);
        bedNoise(bed, noisePink, "bandpass", 900, 0.5, 0.012);
        musicBox(bed);
        return bed;
      }
      case "plaza": {
        const bed = makeBed(name, 1, 0.15);
        const w = bedNoise(bed, noisePink, "bandpass", 800, 0.6, 0.05);
        bedLfo(bed, w.filter.frequency, 0.06, 300);
        bedLfo(bed, w.gain.gain, 0.09, 0.025);
        every(bed, 3, 9, () => bird(bed.out), 2);
        return bed;
      }
      default:
        return buildZone("gallery");
    }
  }

  function startAmbience() {
    if (!roomBed) {
      roomBed = buildRoom();
      fadeIn(roomBed, 3);
    }
    if (!zoneBed) {
      zoneBed = buildZone(zone);
      fadeIn(zoneBed, 3);
    }
  }

  function stopAmbience(seconds = 1.2) {
    killBed(roomBed, seconds);
    killBed(zoneBed, seconds);
    roomBed = null;
    zoneBed = null;
  }

  /* ---------------------------------------------------------------- */
  /* public API                                                        */
  /* ---------------------------------------------------------------- */
  return {
    ensure,
    get muted() {
      return muted;
    },
    get volume() {
      return volume;
    },
    get zone() {
      return zone;
    },
    get ducked() {
      return ducked;
    },

    setMuted(v) {
      muted = !!v;
      save(STORE_MUTED, muted ? "1" : "0");
      if (!ready()) return;
      clearTimeout(suspendTimer);
      if (muted) {
        rampTo(master.gain, 0, 0.25);
        suspendTimer = setTimeout(() => {
          if (muted && ctx) ctx.suspend().catch(() => {});
        }, 400);
      } else {
        const go = () => rampTo(master.gain, masterTarget(), 0.35);
        if (ctx.state === "suspended") ctx.resume().then(go, go);
        else go();
      }
    },

    setMasterVolume(v) {
      volume = clamp(Number(v) || 0, 0, 1);
      save(STORE_VOLUME, volume.toFixed(3));
      if (ready() && !muted) rampTo(master.gain, masterTarget(), 0.15);
    },

    /** Lower (on) or restore (off) the ambience, e.g. while a video plays. */
    duck(on = true) {
      ducked = !!on;
      if (!ready()) return;
      const v = ducked ? 0.22 : 1;
      rampTo(ambDuck.gain, v, ducked ? 0.6 : 1.5);
      rampTo(ambRevSend.gain, v, ducked ? 0.6 : 1.5);
    },

    /** Crossfade to the ambience bed of a hall ("Jurassic Hall") or zone ("jurassic"). */
    setZone(name) {
      const z = zoneForHall(name);
      if (z === zone && (zoneBed || !ambientOn)) return;
      zone = z;
      if (!ready() || !ambientOn) return;
      killBed(zoneBed, 2.5);
      zoneBed = buildZone(zone);
      fadeIn(zoneBed, 2.5);
      if (roomBed) {
        roomBed.level = ROOM_LEVEL[zone] ?? 1;
        rampTo(roomBed.out.gain, roomBed.level, 2.5);
      }
    },

    /** Museum ambience on/off (room tone + the current zone bed). */
    ambient(on = true) {
      const c = ensure();
      if (!c) return;
      ambientOn = !!on;
      if (ambientOn) startAmbience();
      else stopAmbience();
    },

    /** Layered dinosaur roar: growl + formant sweep + breath, different every time. */
    roar(power = 1) {
      const c = ensure();
      if (!c || !playable() || activeRoars >= 3) return;
      roarVoice(power);
    },

    /** Soft footstep on stone. */
    step(vol = 1) {
      const c = ensure();
      if (!c || !playable()) return;
      const now = c.currentTime;
      if (now - lastStep < 0.06) return;
      lastStep = now;
      stepVoice(vol);
    },

    /** Soft UI tick. */
    click(freq = 660) {
      const c = ensure();
      if (!c || !playable()) return;
      const f = clamp(Number(freq) || 660, 80, 6000);
      const t = c.currentTime + 0.005;
      const out = voiceOut(sfx, 0.08);
      tone(out, { freq: f, glideTo: f * 0.94, t, peak: 0.1, attack: 0.003, decay: 0.09 });
      const o = tone(out, { type: "triangle", freq: f * 2, t, peak: 0.03, attack: 0.002, decay: 0.035 });
      o.onended = () => setTimeout(() => out.disconnect(), 100);
    },

    /** Bell-like arpeggio for discoveries / rewards. */
    chime(base = 523.25) {
      const c = ensure();
      if (!c || !playable()) return;
      const f0 = clamp(Number(base) || 523.25, 80, 4000);
      const out = voiceOut(sfx, 0.45);
      const t0 = c.currentTime + 0.01;
      [1, 1.25, 1.5, 2].forEach((mul, i) => {
        const t = t0 + i * 0.075;
        const f = f0 * mul;
        const pk = 0.075 * (i === 3 ? 0.8 : 1);
        tone(out, { freq: f, t, peak: pk, attack: 0.004, decay: 1.6 });
        tone(out, { freq: f * 2.0, t, peak: pk * 0.25, attack: 0.003, decay: 0.7 });
        tone(out, { freq: f * 3.01, t, peak: pk * 0.1, attack: 0.002, decay: 0.3 });
      });
      setTimeout(() => out.disconnect(), 2500);
    },

    /** Ice-cream slurp: gurgly rising noise, a squeak and a little pop. */
    slurp() {
      const c = ensure();
      if (!c || !playable()) return;
      const t = c.currentTime + 0.01;
      const dur = rand(0.35, 0.5);
      const out = voiceOut(sfx, 0.1);

      const n = noiseSrc(noiseWhite);
      const bp = filter("bandpass", 500, rand(5, 8));
      bp.frequency.setValueAtTime(rand(400, 600), t);
      bp.frequency.exponentialRampToValueAtTime(rand(2200, 3000), t + dur);
      const am = c.createGain();
      am.gain.value = 0.5;
      const lfo = c.createOscillator();
      lfo.type = "square";
      lfo.frequency.value = rand(18, 26);
      const lg = gainNode(0.5);
      lfo.connect(lg); lg.connect(am.gain);
      const ng = c.createGain();
      ng.gain.setValueAtTime(0, t);
      ng.gain.linearRampToValueAtTime(0.35, t + 0.04);
      ng.gain.linearRampToValueAtTime(0.25, t + dur * 0.8);
      ng.gain.linearRampToValueAtTime(0, t + dur);
      n.connect(bp); bp.connect(am); am.connect(ng); ng.connect(out);
      n.start(t, rand(0, 1.4)); n.stop(t + dur + 0.05);
      lfo.start(t); lfo.stop(t + dur + 0.05);

      const sq = c.createOscillator();
      sq.frequency.setValueAtTime(rand(350, 420), t);
      sq.frequency.exponentialRampToValueAtTime(rand(800, 950), t + dur);
      const vib = c.createOscillator();
      vib.frequency.value = 13;
      const vg = gainNode(40);
      vib.connect(vg); vg.connect(sq.frequency);
      const sg = c.createGain();
      sg.gain.setValueAtTime(0, t);
      sg.gain.linearRampToValueAtTime(0.03, t + 0.08);
      sg.gain.linearRampToValueAtTime(0, t + dur);
      sq.connect(sg); sg.connect(out);
      sq.start(t); sq.stop(t + dur + 0.05);
      vib.start(t); vib.stop(t + dur + 0.05);

      tone(out, { freq: 1100, glideTo: 380, t: t + dur + 0.02, peak: 0.06, attack: 0.002, decay: 0.05 });
      setTimeout(() => out.disconnect(), (dur + 0.6) * 1000);
    },
  };
}
