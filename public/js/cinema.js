import * as THREE from "three";
import { SPECIES } from "./species.js";
import { makeCanvas, clamp } from "./util.js";
import { speciesImage, loadImageManifest, imageCredit } from "./speciesimages.js";

/**
 * "Image screenings": the battles are told with the two fighters' real
 * images (photos / paleoart from /images/species) drawn onto a canvas that is
 * painted on the theatre screen. Ken Burns pans and zooms, close-ups that
 * alternate with a split-screen "VS" composition, captions from
 * battle.lines, and impact flashes + shake on hit beats.
 *
 * Every client runs the same timeline locally, so the screening looks the
 * same for everybody in the room (the shake jitter is the only randomness).
 *
 * The choreography comes from battle.beats ([time, action, who]); see
 * exhibits.js. Battles without beats get a generic routine.
 */

const W = 1024;
const H = 512;
const RENDER_FPS = 30;
const FADE = 0.55; // crossfade between shots (s)
const LABEL_Y = 122; // fighter name tags sit under the title band, clear of captions
const HIT_ACTIONS = { charge: [0.9], clash: [0.45, 1.35], tail: [0.55], down: [0.05] };

const MOOD_TINT = {
  sunset: "rgba(255,140,60,0.16)",
  dusk: "rgba(70,90,170,0.18)",
  night: "rgba(20,40,90,0.3)",
  dawn: "rgba(255,230,190,0.12)",
  swamp: "rgba(80,110,50,0.18)",
  volcanic: "rgba(200,60,30,0.2)",
  desert: "rgba(240,170,90,0.16)",
  river: "rgba(60,140,140,0.14)",
  marsh: "rgba(90,120,80,0.16)",
  plains: "rgba(160,200,120,0.1)",
  underwater: "rgba(20,110,170,0.28)",
  sky: "rgba(150,200,255,0.14)",
};

export function createCinema({ renderer, screenMat, battles, onLine, onProgress, onEnd, onHit }) {
  void renderer; // kept for API compatibility; the screening is a 2D canvas now

  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  // remember what the screen looked like before any screening
  const idle = { map: screenMat.map, color: screenMat.color.getHex() };

  let current = null;
  let time = 0;
  let lineIndex = -1;
  let beatIndex = -1;
  let hitTimes = [];
  let hitIndex = 0;
  let shake = 0;
  let flash = 0;
  let punch = 0;
  let renderAcc = 0;
  let needsRender = false;
  let shot = null;
  let prevShot = null;
  let fighters = [];
  let shotSeq = 0;
  let caption = "";

  loadImageManifest();

  /* ---------------------------------------------------------------- data */
  function resolve(battleOrId) {
    if (battleOrId && typeof battleOrId === "object") return battleOrId;
    return battles.find((b) => b.id === battleOrId) || null;
  }

  function beatsFor(battle) {
    if (Array.isArray(battle.beats) && battle.beats.length) return battle.beats;
    const T = battle.duration || 26;
    return [
      [0, "intro"], [T * 0.14, "approach"], [T * 0.3, "roar", "a"], [T * 0.4, "charge", "b"],
      [T * 0.46, "clash"], [T * 0.62, "circle"], [T * 0.75, "clash"], [T * 0.86, "standoff"],
    ];
  }

  function computeHits(beats) {
    const out = [];
    for (const [t, action] of beats) for (const off of HIT_ACTIONS[action] || []) out.push(t + off);
    return out.sort((x, y) => x - y);
  }

  function makeFighter(id, side) {
    const spec = SPECIES[id];
    return {
      id,
      side,
      name: spec?.name || id,
      color: hex(spec?.color ?? 0x556677),
      accent: hex(spec?.accent ?? spec?.color ?? 0x334455),
      rec: speciesImage(id),
      dim: 0, // 0..1 knocked down / buried
      gone: 0, // 0..1 fled out of frame
      dimTarget: 0,
      goneTarget: 0,
    };
  }

  // deterministic per-battle randomness so every client frames the same shots
  function seeded(n) {
    const x = Math.sin((hashStr(current?.id || "") + n * 97.13) * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  }

  function kenBurns(n, strong = false) {
    const r = (k) => seeded(n * 7 + k);
    const zIn = r(1) > 0.35;
    const z0 = 1.04 + r(2) * 0.08;
    const z1 = z0 + (strong ? 0.28 : 0.14) * (zIn ? 1 : -0.6);
    return {
      z0,
      z1,
      px0: r(3) * 2 - 1,
      px1: r(4) * 2 - 1,
      py0: r(5) * 1.2 - 0.6,
      py1: r(6) * 1.2 - 0.6,
    };
  }

  function setShot(type, who, t0, opts = {}) {
    prevShot = shot;
    shotSeq++;
    shot = { type, who, start: t0, kb: kenBurns(shotSeq, opts.strong), kb2: kenBurns(shotSeq + 50), ...opts };
    if (opts.pan) {
      shot.kb.px0 = -1;
      shot.kb.px1 = 1;
    }
  }

  /* ------------------------------------------------------------- beats */
  const idx = (tag) => (tag === "b" ? 1 : 0);
  const whoList = (tag) => (tag === "both" ? [0, 1] : [idx(tag)]);

  function applyBeat(beat) {
    const [t0, action, tag] = beat;
    switch (action) {
      case "intro":
        setShot("split", null, t0, { push: 0, slow: true });
        break;
      case "approach":
        setShot("split", null, t0, { push: 0.35 });
        break;
      case "circle":
        setShot("alternate", null, t0, { period: 2.4 });
        break;
      case "roar":
        setShot("close", idx(tag), t0, { strong: true, roar: true });
        break;
      case "charge":
        setShot("close", idx(tag), t0, { strong: true, rush: true });
        break;
      case "clash":
        setShot("split", null, t0, { push: 1, jagged: true });
        break;
      case "tail":
        setShot("close", idx(tag), t0, { pan: true });
        break;
      case "retreat":
        setShot("split", null, t0, { push: 0.1, favour: 1 - idx(tag) });
        break;
      case "standoff":
        setShot("split", null, t0, { push: 0.2 });
        break;
      case "flee":
        for (const i of whoList(tag)) fighters[i].goneTarget = 1;
        setShot("split", null, t0, { push: 0.1 });
        break;
      case "down":
        for (const i of whoList(tag)) fighters[i].dimTarget = 1;
        setShot("split", null, t0, { push: 1, jagged: true, slow: true });
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------ drawing */
  // draw the image to cover (x,y,w,h); zoom >= 1, pan in -1..1 within the slack
  function drawCover(f, x, y, w, h, zoom, px, py) {
    const img = f.rec.img;
    if (f.rec.status === "ok" && img.naturalWidth) {
      const iw = img.naturalWidth;
      const ih = img.naturalHeight;
      const scale = Math.max(w / iw, h / ih) * zoom;
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = x + (w - dw) / 2 + ((dw - w) / 2) * clamp(px, -1, 1);
      const dy = y + (h - dh) / 2 + ((dh - h) / 2) * clamp(py, -1, 1);
      ctx.drawImage(img, dx, dy, dw, dh);
    } else {
      // no image (yet): a moving gradient in the species colours; the name
      // tag drawn on top of every shot says who it is
      const cx = x + w / 2 + px * w * 0.25;
      const cy = y + h / 2 + py * h * 0.25;
      const g = ctx.createRadialGradient(cx, cy, 10, cx, cy, Math.max(w, h) * 0.75 * zoom);
      g.addColorStop(0, f.color);
      g.addColorStop(1, f.accent);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(x, y, w, h);
    }
  }

  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  function kb(k, t) {
    const e = ease(clamp(t, 0, 1));
    return {
      z: k.z0 + (k.z1 - k.z0) * e,
      px: k.px0 + (k.px1 - k.px0) * e,
      py: k.py0 + (k.py1 - k.py0) * e,
    };
  }

  function drawPanel(f, x, y, w, h, k, t, extraZoom = 0) {
    const p = kb(k, t);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    drawCover(f, x, y, w, h, Math.max(1, p.z + extraZoom), p.px, p.py);
    if (f.dim > 0.01) {
      ctx.fillStyle = `rgba(20,14,8,${f.dim * 0.62})`;
      ctx.fillRect(x, y, w, h);
    }
    ctx.restore();
  }

  function label(text, x, y, align = "left") {
    ctx.save();
    ctx.font = "800 22px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(text).width;
    const bx = align === "right" ? x - tw - 24 : x;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundRect(bx, y - 17, tw + 24, 34, 17);
    ctx.fill();
    ctx.fillStyle = "#fff3d6";
    ctx.textAlign = "left";
    ctx.fillText(text, bx + 12, y + 1);
    ctx.restore();
  }

  function vsBadge(cx, cy, s = 1) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.arc(0, 0, 44, 0, Math.PI * 2);
    ctx.fillStyle = "#1b1206";
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#ffc857";
    ctx.stroke();
    ctx.fillStyle = "#ffd166";
    ctx.font = "900 40px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("VS", 0, 2);
    ctx.restore();
  }

  // the dividing line between the two halves (straight slant or lightning bolt)
  function dividerPath(mid, slant, jag) {
    const pts = [[mid + slant, 0]];
    if (jag) {
      const steps = 6;
      for (let i = 1; i < steps; i++) {
        pts.push([mid + slant - (2 * slant * i) / steps + (i % 2 ? 26 : -26), (H * i) / steps]);
      }
    }
    pts.push([mid - slant, H]);
    return pts;
  }

  function clipSide(pts, edgeX) {
    ctx.beginPath();
    ctx.moveTo(edgeX, 0);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(edgeX, H);
    ctx.closePath();
    ctx.clip();
  }

  function drawSplit(s, t) {
    const [fa, fb] = fighters;
    const drive = (s.push ?? 0) * ease(clamp(t / 1.2, 0, 1));
    const fav = s.favour;
    let mid = W / 2 + (fav === 0 ? 90 : fav === 1 ? -90 : 0) * ease(clamp(t / 1.5, 0, 1));
    // a fled fighter's half shrinks away
    mid = mid - fa.gone * (mid + 80) + fb.gone * (W + 80 - mid);
    const slant = 70;
    const pts = dividerPath(mid, slant, !!s.jagged);
    const extra = drive * 0.08 + punch * 0.08;
    const local = t / (s.slow ? 9 : 5);

    if (fa.gone < 0.999) {
      ctx.save();
      clipSide(pts, 0);
      drawPanel(fa, -drive * 30, 0, mid + slant + 40, H, s.kb, local, extra);
      ctx.restore();
    }
    if (fb.gone < 0.999) {
      ctx.save();
      clipSide(pts, W);
      const bx = mid - slant - 40 + drive * 30;
      drawPanel(fb, bx, 0, W - bx, H, s.kb2, local, extra);
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = "rgba(255,200,87,0.9)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.restore();

    if (fa.gone < 0.6) label(fa.name, 22, LABEL_Y);
    if (fb.gone < 0.6) label(fb.name, W - 22, LABEL_Y, "right");
    if (fa.gone < 0.5 && fb.gone < 0.5) vsBadge(mid, H / 2 - 10, 1 + punch * 0.25 + (s.jagged ? 0.1 : 0));
  }

  function drawClose(s, t) {
    const f = fighters[s.who ?? 0];
    drawPanel(f, 0, 0, W, H, s.kb, t / (s.rush ? 1.6 : 3.2), punch * 0.1);
    if (s.roar) {
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(120,10,0,0.45)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    if (s.rush) {
      // speed streaks
      ctx.save();
      ctx.globalAlpha = 0.22 * clamp(1 - t / 1.6, 0, 1);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 3;
      for (let i = 0; i < 14; i++) {
        const y = seeded(shotSeq * 31 + i) * H;
        const x = seeded(shotSeq * 17 + i) * W * 0.6 + t * 300;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + 160 + i * 8, y);
        ctx.stroke();
      }
      ctx.restore();
    }
    label(f.name, 22, LABEL_Y);
  }

  function drawAlternate(s, t) {
    const period = s.period || 2.4;
    const n = Math.floor(t / period);
    const local = t - n * period;
    const who = n % 2;
    const f = fighters[who];
    drawPanel(f, 0, 0, W, H, kenBurns(shotSeq * 13 + n), local / period);
    if (n > 0 && local < FADE) {
      ctx.save();
      ctx.globalAlpha = 1 - local / FADE;
      drawPanel(fighters[1 - who], 0, 0, W, H, kenBurns(shotSeq * 13 + n - 1), 1);
      ctx.restore();
    }
    label(f.name, 22, LABEL_Y);
  }

  function drawShot(s) {
    if (!s) return;
    const t = time - s.start;
    if (s.type === "split") drawSplit(s, t);
    else if (s.type === "close") drawClose(s, t);
    else if (s.type === "alternate") drawAlternate(s, t);
  }

  function drawFrame() {
    const battle = current;
    const total = battle.duration || 26;
    ctx.save();
    ctx.fillStyle = "#06080b";
    ctx.fillRect(0, 0, W, H);
    if (shake > 0) ctx.translate((Math.random() - 0.5) * shake * 22, (Math.random() - 0.5) * shake * 14);
    drawShot(shot);
    if (prevShot && time - shot.start < FADE) {
      ctx.save();
      ctx.globalAlpha = 1 - (time - shot.start) / FADE;
      drawShot(prevShot);
      ctx.restore();
    }
    ctx.restore();

    // mood grade + vignette
    ctx.fillStyle = MOOD_TINT[battle.mood] || "rgba(0,0,0,0)";
    ctx.fillRect(0, 0, W, H);
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.7);
    v.addColorStop(0, "rgba(0,0,0,0)");
    v.addColorStop(1, "rgba(0,0,0,0.55)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);

    if (flash > 0.01) {
      ctx.fillStyle = `rgba(255,244,220,${flash * 0.85})`;
      ctx.fillRect(0, 0, W, H);
    }

    // title card at the start and the end
    const ta = Math.max(clamp((6 - time) / 0.6, 0, 1), clamp((time - (total - 3.5)) / 0.6, 0, 1));
    if (ta > 0) drawTitle(battle, ta);
    if (caption) drawCaption(caption);

    // progress
    const p = clamp(time / total, 0, 1);
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.fillRect(0, H - 5, W, 5);
    ctx.fillStyle = "#ffc857";
    ctx.fillRect(0, H - 5, W * p, 5);

    // image credits (tiny)
    const seen = new Set();
    const credits = [];
    for (const f of fighters) {
      if (seen.has(f.id) || f.rec.status !== "ok") continue;
      seen.add(f.id);
      const c = imageCredit(f.id);
      if (c) credits.push(c);
    }
    if (credits.length) {
      ctx.save();
      ctx.font = "500 11px Inter, system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText(`Images: ${credits.join("  |  ")}`, W - 10, H - 8, W - 20);
      ctx.restore();
    }
  }

  function drawTitle(battle, a) {
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 0, W, 92);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffd166";
    ctx.font = "800 38px Inter, system-ui, sans-serif";
    ctx.fillText(battle.title, W / 2, 36, W - 60);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "500 21px Inter, system-ui, sans-serif";
    const sub = battle.subtitle || "";
    ctx.fillText(battle.kind === "whatif" && !/what if/i.test(sub) ? `What if? · ${sub}` : sub, W / 2, 72, W - 60);
    ctx.restore();
  }

  function drawCaption(text) {
    ctx.save();
    ctx.font = "700 27px Inter, system-ui, sans-serif";
    const lines = wrap(text, W - 120).slice(0, 2);
    const bh = lines.length > 1 ? 88 : 56;
    const y0 = H - 22 - bh;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    roundRect(40, y0, W - 80, bh, 14);
    ctx.fill();
    ctx.fillStyle = "#ffe9b0";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y0 + (lines.length > 1 ? 25 + i * 38 : bh / 2), W - 100));
    ctx.restore();
  }

  function wrap(text, max) {
    const out = [];
    let line = "";
    for (const word of String(text).split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > max && line) {
        out.push(line);
        line = word;
      } else line = test;
    }
    if (line) out.push(line);
    return out;
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------------------------------------------------------- API */
  function play(battleOrId) {
    const battle = resolve(battleOrId);
    if (!battle) {
      console.warn(`cinema: unknown battle "${battleOrId}"`);
      return null;
    }
    if (!SPECIES[battle.a] || !SPECIES[battle.b]) {
      console.warn(`cinema: battle ${battle.id} has an unknown fighter (${battle.a} / ${battle.b})`);
      return null;
    }
    current = battle;
    fighters = [makeFighter(battle.a, -1), makeFighter(battle.b, 1)];
    time = 0;
    lineIndex = -1;
    shake = flash = punch = 0;
    hitTimes = computeHits(beatsFor(battle));
    hitIndex = 0;
    renderAcc = 0;
    needsRender = true;
    shot = prevShot = null;
    shotSeq = 0;
    caption = "";
    // repaint as soon as a late image arrives
    for (const f of fighters) f.rec.promise?.then(() => (needsRender = true));
    applyBeat(beatsFor(battle)[0] || [0, "intro"]);
    prevShot = null;
    beatIndex = 0;
    screenMat.map = tex;
    screenMat.color.setHex(0xffffff);
    screenMat.needsUpdate = true;
    onLine?.(battle, -1);
    return battle;
  }

  function resetScreen() {
    if (screenMat.map !== tex) return; // someone else (e.g. the YouTube embed) owns the screen
    screenMat.map = idle.map;
    screenMat.color.setHex(idle.color);
    screenMat.needsUpdate = true;
  }

  function stop() {
    current = null;
    fighters = [];
    resetScreen();
  }

  function update(rawDt) {
    if (!current) return;
    const dt = Math.min(rawDt || 0, 0.1);
    time += dt;
    renderAcc += dt;
    const battle = current;
    const total = battle.duration || 26;
    onProgress?.(clamp(time / total, 0, 1));

    let li = -1;
    for (let i = 0; i < battle.lines.length; i++) if (time >= battle.lines[i][0]) li = i;
    if (li !== lineIndex) {
      lineIndex = li;
      if (li >= 0) {
        caption = battle.lines[li][1];
        onLine?.(battle, li);
      }
    }

    const beats = beatsFor(battle);
    let bi = -1;
    for (let i = 0; i < beats.length; i++) if (time >= beats[i][0]) bi = i;
    while (beatIndex < bi) {
      beatIndex++;
      applyBeat(beats[beatIndex]);
    }

    while (hitIndex < hitTimes.length && time >= hitTimes[hitIndex]) {
      const h = hitTimes[hitIndex++];
      shake = flash = punch = 1;
      onHit?.(battle, h);
    }
    shake = Math.max(0, shake - dt * 2.6);
    flash = Math.max(0, flash - dt * 4.5);
    punch = Math.max(0, punch - dt * 3);
    for (const f of fighters) {
      f.dim += (f.dimTarget - f.dim) * Math.min(1, dt * 1.5);
      f.gone += (f.goneTarget - f.gone) * Math.min(1, dt * 1.1);
    }

    if (time >= total) {
      const finished = current;
      current = null;
      fighters = [];
      resetScreen();
      onEnd?.(finished);
    }
  }

  function render() {
    if (!current) return;
    // the screen is a small part of the view: 30 fps is plenty
    if (!needsRender && renderAcc < 1 / RENDER_FPS) return;
    renderAcc = needsRender ? 0 : renderAcc % (1 / RENDER_FPS);
    needsRender = false;
    drawFrame();
    tex.needsUpdate = true;
  }

  return {
    play,
    stop,
    update,
    render,
    /** true while a screening is running */
    get playing() {
      return !!current;
    },
    /** the battle record being screened, or null */
    get current() {
      return current;
    },
    /** @deprecated alias of `current` */
    get battle() {
      return current;
    },
    /** seconds into the current screening */
    get time() {
      return current ? time : 0;
    },
    /** 0..1 progress of the current screening */
    get progress() {
      return current ? clamp(time / (current.duration || 26), 0, 1) : 0;
    },
    /** type of the current shot ("split" | "close" | "alternate"), for tests */
    get shot() {
      return shot ? shot.type : null;
    },
    battles,
    canvas,
    texture: tex,
  };
}

function hex(n) {
  return `#${(n >>> 0).toString(16).padStart(6, "0").slice(-6)}`;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h % 1000);
}
