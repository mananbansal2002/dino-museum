/**
 * Tiny synthesised sound bank — no audio files, everything is generated with
 * the Web Audio API so the museum stays a single static deploy.
 */
export function createAudio() {
  let ctx = null;
  let master = null;
  let ambientNodes = null;
  let muted = false;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.55;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function noise(dur = 1) {
    const c = ensure();
    if (!c) return null;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    src.buffer = buf;
    return src;
  }

  function env(node, { attack = 0.01, decay = 0.4, peak = 1 } = {}) {
    const c = ensure();
    const g = c.createGain();
    const t = c.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    node.connect(g);
    g.connect(master);
    return g;
  }

  return {
    ensure,
    get muted() {
      return muted;
    },
    setMuted(v) {
      muted = v;
      if (master) master.gain.value = v ? 0 : 0.55;
    },

    /** Deep prehistoric roar. */
    roar(power = 1) {
      const c = ensure();
      if (!c || muted) return;
      const t = c.currentTime;
      const osc = c.createOscillator();
      const osc2 = c.createOscillator();
      const filter = c.createBiquadFilter();
      const gain = c.createGain();
      osc.type = "sawtooth";
      osc2.type = "square";
      osc.frequency.setValueAtTime(78, t);
      osc.frequency.exponentialRampToValueAtTime(42, t + 1.1);
      osc2.frequency.setValueAtTime(39, t);
      osc2.frequency.exponentialRampToValueAtTime(24, t + 1.1);
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(1200, t);
      filter.frequency.exponentialRampToValueAtTime(260, t + 1.2);
      filter.Q.value = 6;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.5 * power, t + 0.09);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.35);
      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      osc.start(t);
      osc2.start(t);
      osc.stop(t + 1.4);
      osc2.stop(t + 1.4);

      const n = noise(1.2);
      const nf = c.createBiquadFilter();
      nf.type = "bandpass";
      nf.frequency.value = 420;
      const ng = c.createGain();
      ng.gain.setValueAtTime(0.0001, t);
      ng.gain.exponentialRampToValueAtTime(0.16 * power, t + 0.12);
      ng.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
      n.connect(nf);
      nf.connect(ng);
      ng.connect(master);
      n.start(t);
    },

    /** Footstep / tap. */
    step(soft = 1) {
      const c = ensure();
      if (!c || muted) return;
      const n = noise(0.09);
      const f = c.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 900 + Math.random() * 500;
      const g = c.createGain();
      const t = c.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09 * soft, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      n.connect(f);
      f.connect(g);
      g.connect(master);
      n.start(t);
    },

    /** UI click / pickup. */
    click(freq = 660) {
      const c = ensure();
      if (!c || muted) return;
      const t = c.currentTime;
      const o = c.createOscillator();
      o.type = "triangle";
      o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freq * 1.5, t + 0.09);
      env(o, { attack: 0.005, decay: 0.16, peak: 0.16 });
      o.start(t);
      o.stop(t + 0.2);
    },

    /** Chime for discoveries / rewards. */
    chime(base = 523.25) {
      const c = ensure();
      if (!c || muted) return;
      [1, 1.26, 1.5].forEach((mul, i) => {
        const t = c.currentTime + i * 0.08;
        const o = c.createOscillator();
        o.type = "sine";
        o.frequency.value = base * mul;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
        o.connect(g);
        g.connect(master);
        o.start(t);
        o.stop(t + 1);
      });
    },

    /** Ice cream slurp. */
    slurp() {
      const c = ensure();
      if (!c || muted) return;
      const t = c.currentTime;
      const o = c.createOscillator();
      o.type = "sine";
      o.frequency.setValueAtTime(320, t);
      o.frequency.linearRampToValueAtTime(680, t + 0.28);
      const lfo = c.createOscillator();
      lfo.frequency.value = 12;
      const lg = c.createGain();
      lg.gain.value = 70;
      lfo.connect(lg);
      lg.connect(o.frequency);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g);
      g.connect(master);
      o.start(t);
      lfo.start(t);
      o.stop(t + 0.55);
      lfo.stop(t + 0.55);
    },

    /** Low museum hum. */
    ambient(on = true) {
      const c = ensure();
      if (!c) return;
      if (on && !ambientNodes) {
        const o1 = c.createOscillator();
        const o2 = c.createOscillator();
        const g = c.createGain();
        const f = c.createBiquadFilter();
        o1.type = "sine";
        o2.type = "sine";
        o1.frequency.value = 58;
        o2.frequency.value = 87;
        f.type = "lowpass";
        f.frequency.value = 260;
        g.gain.value = 0.0001;
        o1.connect(f);
        o2.connect(f);
        f.connect(g);
        g.connect(master);
        o1.start();
        o2.start();
        g.gain.exponentialRampToValueAtTime(0.05, c.currentTime + 3);
        ambientNodes = { o1, o2, g };
      } else if (!on && ambientNodes) {
        const { o1, o2, g } = ambientNodes;
        g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.6);
        o1.stop(c.currentTime + 0.7);
        o2.stop(c.currentTime + 0.7);
        ambientNodes = null;
      }
    },
  };
}
