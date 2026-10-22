/**
 * Gelateria: a realistic ice cream counter for the Ice Cream Court and the
 * hand-held gelato players carry around.
 *
 *   import { buildGelateria, makeGelato, flavourSwatchUrl } from "./gelato.js";
 *   const gelateria = buildGelateria({ scene, world, COURT, renderer });   // after props.js
 *   const prop = makeGelato(order);   // drop-in for ui.js makeIceCream(order)
 *   img.src = flavourSwatchUrl("matcha");
 *
 * buildGelateria hides the primitive kiosk world.js builds (box counter,
 * striped awning, flat tub discs, sign, flavour board) and puts up a gelato
 * bar in its place: a curved-glass display freezer with eight heaped pans of
 * gelato, a back bar with cone stand, dipper well, cup dispenser and topping
 * jars, a lit menu board on a tiled wall, a canopy with the shop sign and a
 * trio of pendant lamps (Poly Haven, CC0; see /models/gelato/CREDITS.json).
 * Everything procedural is merged into one mesh per material, so the whole
 * bar costs ~40 draw calls, and it is hidden when the camera is far away.
 *
 * makeGelato keeps makeIceCream's contract: order = { flavour: { id, color },
 * scoops 1-3, style "cone" | "cup", toppings ["sprinkles", "chocolate",
 * "cherry"] }, same size, same pose in the hand. Geometries, materials and
 * textures are shared between every gelato and their dispose() is a no-op, so
 * the callers' disposeObject() on an old prop cannot break the next one.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as W from "./world.js";

/* ------------------------------------------------------------------ */
/* flavours (mirrors ui.js FLAVOURS; ids are the contract)               */
/* ------------------------------------------------------------------ */
export const GELATO_FLAVOURS = [
  { id: "strawberry", name: "Strawberry", color: 0xff9aa2 },
  { id: "mintchoco", name: "Mint Choco", color: 0x9ad9c0 },
  { id: "dinodust", name: "Dino Dust", color: 0x8d6e63 },
  { id: "volcano", name: "Volcano Chilli", color: 0xff5a1f },
  { id: "blueberry", name: "Blueberry", color: 0x7d8cff },
  { id: "caramel", name: "Salted Caramel", color: 0xd79a4d },
  { id: "matcha", name: "Matcha", color: 0xa8d08d },
  { id: "vanilla", name: "Extinction Vanilla", color: 0xf5e6c8 },
];
const INFO = {
  strawberry: { desc: "Sicilian strawberries", price: "3.50" },
  mintchoco: { desc: "Fresh mint · dark chocolate", price: "3.50" },
  dinodust: { desc: "Cocoa cookie crumble", price: "3.80" },
  volcano: { desc: "Blood orange · red chilli", price: "3.80" },
  blueberry: { desc: "Wild blueberry ripple", price: "3.50" },
  caramel: { desc: "Burnt sugar · sea salt", price: "3.80" },
  matcha: { desc: "Stone-ground Uji matcha", price: "3.80" },
  vanilla: { desc: "Madagascar vanilla bean", price: "3.50" },
};
/** Darker / truer tones for the gelato itself (the UI colours are pastel swatches). */
const TONE = {
  strawberry: 0xf28a96,
  mintchoco: 0xa8dcc4,
  dinodust: 0x7a5646,
  volcano: 0xf0602a,
  blueberry: 0x8a87d8,
  caramel: 0xd39550,
  matcha: 0x9cbd78,
  vanilla: 0xf3e3c2,
};

const BASE = "/models/gelato/";
const MODELS = {
  lamp: "hanging_industrial_lamp/hanging_industrial_lamp.gltf",
  register: "CashRegister_01/CashRegister_01.gltf",
  stool: "bar_chair_round_01/bar_chair_round_01.gltf",
};

/* ------------------------------------------------------------------ */
/* small helpers                                                        */
/* ------------------------------------------------------------------ */
const NOOP = () => {};
/** Shared resource: callers may "dispose" props holding it; ignore that. */
function shared(o) {
  o.dispose = NOOP;
  if (o.userData) o.userData.gelatoShared = true;
  return o;
}
const cache = new Map();
function cached(key, make) {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
}
function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const hexCss = (hex) => "#" + hex.toString(16).padStart(6, "0");
function shadeHex(hex, f) {
  const c = new THREE.Color(hex);
  if (f >= 0) c.lerp(new THREE.Color(1, 1, 1), f);
  else c.multiplyScalar(1 + f);
  return c;
}
const strSeed = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
function canvasTex(c, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  t.anisotropy = aniso;
  return shared(t);
}

/* value noise (optionally periodic) */
function hash2(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, y, s, px = 0, py = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const wx = (a) => (px ? ((a % px) + px) % px : a);
  const wy = (a) => (py ? ((a % py) + py) % py : a);
  const a = hash2(wx(xi), wy(yi), s);
  const b = hash2(wx(xi + 1), wy(yi), s);
  const c = hash2(wx(xi), wy(yi + 1), s);
  const d = hash2(wx(xi + 1), wy(yi + 1), s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, s, oct = 4, px = 0, py = 0) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f, s + i * 17, px * f, py * f);
    amp *= 0.5;
    f *= 2;
  }
  return sum;
}

/** Height field (Float32Array, w*h, wraps) -> tangent-space normal map. */
function normalTex(hf, w, h, strength, opts) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  const at = (x, y) => hf[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx;
      let ny = dy;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const i = (y * w + x) * 4;
      img.data[i] = (nx * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvasTex(c, { srgb: false, ...opts });
}
function greyTex(hf, w, h, map, opts) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, map(hf[i]) * 255));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasTex(c, { srgb: false, ...opts });
}
function canvasHeight(c) {
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const hf = new Float32Array(c.width * c.height);
  for (let i = 0; i < hf.length; i++) hf[i] = d[i * 4] / 255;
  return hf;
}

/* ------------------------------------------------------------------ */
/* procedural textures                                                  */
/* ------------------------------------------------------------------ */

/** Creamy, spatula-swirled surface of gelato heaped in a pan. */
function gelatoSurfaceMaps() {
  return cached("tex:gelatoSurface", () => {
    const N = 512;
    const c = makeCanvas(N, N);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#808080";
    ctx.fillRect(0, 0, N, N);
    const r = rng(7);
    ctx.lineCap = "round";
    ctx.filter = "blur(2.5px)";
    for (let k = 0; k < 110; k++) {
      const x0 = r() * N;
      const y0 = r() * N;
      const ang = r() * Math.PI * 2;
      const len = 60 + r() * 220;
      const bend = (r() - 0.5) * 2.4;
      const w = 5 + r() * 20;
      const pts = [];
      for (let i = 0; i <= 12; i++) {
        const t = i / 12;
        const a = ang + bend * t;
        pts.push([x0 + Math.cos(a) * len * t, y0 + Math.sin(a) * len * t]);
      }
      const path = (off) => {
        ctx.beginPath();
        pts.forEach(([x, y], i) => {
          const nx = -Math.sin(ang) * off;
          const ny = Math.cos(ang) * off;
          if (i) ctx.lineTo(x + nx, y + ny);
          else ctx.moveTo(x + nx, y + ny);
        });
      };
      // a fold: a lit crest with its shadowed underside right beside it
      path(0);
      ctx.strokeStyle = `rgba(255,255,255,${0.12 + r() * 0.18})`;
      ctx.lineWidth = w;
      ctx.stroke();
      path(w * 0.55);
      ctx.strokeStyle = `rgba(0,0,0,${0.1 + r() * 0.16})`;
      ctx.lineWidth = w * 0.45;
      ctx.stroke();
    }
    ctx.filter = "none";
    const hf = canvasHeight(c);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) hf[y * N + x] += (fbm(x / 9, y / 9, 3, 3, N / 9, N / 9) - 0.5) * 0.08;
    }
    return {
      normal: normalTex(hf, N, N, 3.2),
      rough: greyTex(hf, N, N, (v) => 0.62 - (v - 0.5) * 0.5),
    };
  });
}

/** Rolled "scooped" striations wrapping round a ball of gelato (u around, v pole to pole). */
function scoopNormalMap() {
  return cached("tex:scoopNormal", () => {
    const Wd = 512;
    const H = 256;
    const hf = new Float32Array(Wd * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < Wd; x++) {
        const u = x / Wd;
        const v = y / H;
        const warp = fbm(u * 8, v * 4, 11, 3, 8, 0) * 2.4;
        const ridge = Math.sin(Math.PI * 2 * (v * 26 + warp)) * 0.5 + 0.5;
        const torn = fbm(u * 24, v * 12, 5, 3, 24, 0);
        hf[y * Wd + x] = ridge * 0.55 * (0.6 + torn * 0.8) + fbm(u * 64, v * 32, 2, 2, 64, 0) * 0.25;
      }
    }
    return normalTex(hf, Wd, H, 2.2, { repeat: [2, 1] });
  });
}

/** Per-flavour albedo: the gelato tone, subtle variation, ripples and inclusions. */
function flavourAlbedo(id, color) {
  const base = TONE[id] ?? color ?? 0xf2d0c0;
  return cached(`tex:albedo:${id}:${base}`, () => {
    const N = 256;
    const c = makeCanvas(N, N);
    const ctx = c.getContext("2d");
    const col = new THREE.Color(base);
    const img = ctx.createImageData(N, N);
    const s = strSeed(id) % 1000;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const n = fbm(x / 26, y / 26, s, 4, N / 26, N / 26) - 0.5;
        const f = 1 + n * 0.16;
        const i = (y * N + x) * 4;
        // the colour space conversion is done by three (sRGB map): stay in sRGB here
        img.data[i] = Math.min(255, col.r * 255 * f);
        img.data[i + 1] = Math.min(255, col.g * 255 * f);
        img.data[i + 2] = Math.min(255, col.b * 255 * f);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const r = rng(s + 3);
    const streaks = (css, n, wMin, wMax, alpha) => {
      ctx.save();
      ctx.filter = "blur(1.5px)";
      ctx.lineCap = "round";
      for (let k = 0; k < n; k++) {
        ctx.strokeStyle = css;
        ctx.globalAlpha = alpha * (0.5 + r() * 0.5);
        ctx.lineWidth = wMin + r() * (wMax - wMin);
        ctx.beginPath();
        let x = r() * N;
        let y = r() * N;
        let a = r() * Math.PI * 2;
        ctx.moveTo(x, y);
        for (let i = 0; i < 8; i++) {
          a += (r() - 0.5) * 1.2;
          x += Math.cos(a) * 14;
          y += Math.sin(a) * 14;
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.restore();
    };
    const flecks = (css, n, sMin, sMax) => {
      ctx.fillStyle = css;
      for (let k = 0; k < n; k++) {
        const x = r() * N;
        const y = r() * N;
        const sz = sMin + r() * (sMax - sMin);
        ctx.beginPath();
        const m = 4 + Math.floor(r() * 3);
        for (let i = 0; i < m; i++) {
          const a = (i / m) * Math.PI * 2 + r() * 0.6;
          const rr = sz * (0.6 + r() * 0.5);
          if (i) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
          else ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
      }
    };
    switch (id) {
      case "strawberry":
        streaks("#c8324a", 26, 3, 9, 0.45);
        flecks("#8f1d2c", 40, 2, 5);
        flecks("#5a1418", 90, 0.6, 1.1);
        break;
      case "mintchoco":
        flecks("#2a170f", 70, 2, 5.5);
        flecks("#4a2a18", 50, 1, 2.5);
        break;
      case "dinodust":
        flecks("#2b1a12", 80, 2, 6);
        flecks("#efe4d2", 40, 1, 3);
        streaks("#4a2c1e", 14, 3, 7, 0.4);
        break;
      case "volcano":
        streaks("#b8230e", 30, 3, 8, 0.5);
        streaks("#3a1a10", 8, 2, 4, 0.35);
        flecks("#8a1206", 70, 0.8, 2.2);
        break;
      case "blueberry":
        streaks("#3e2c86", 30, 4, 11, 0.55);
        flecks("#2a1f55", 50, 1, 3);
        break;
      case "caramel":
        streaks("#8a4a14", 26, 4, 10, 0.55);
        streaks("#f3d6a4", 12, 2, 5, 0.4);
        break;
      case "matcha":
        flecks("#6e8c45", 260, 0.4, 1.0);
        streaks("#86a65a", 12, 4, 9, 0.25);
        break;
      case "vanilla":
        flecks("#21160d", 260, 0.35, 0.9);
        streaks("#e8d2a6", 12, 4, 9, 0.35);
        break;
      default:
        break;
    }
    return canvasTex(c, { repeat: [1, 1] });
  });
}

/** Toasted waffle cone: raised diamond grid. */
function waffleMaps() {
  return cached("tex:waffle", () => {
    const N = 256;
    const hf = new Float32Array(N * N);
    const c = makeCanvas(N, N);
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(N, N);
    const K = 6; // diamonds per tile
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = x / N;
        const v = y / N;
        const a = (u + v) * K;
        const b = (u - v) * K;
        const da = Math.abs(a - Math.round(a));
        const db = Math.abs(b - Math.round(b));
        const ridge = Math.max(smooth(0.16, 0.05, da), smooth(0.16, 0.05, db));
        const n = fbm(u * 12, v * 12, 9, 3, 12, 12);
        hf[y * N + x] = ridge * 0.8 + n * 0.25;
        const toast = 0.78 + n * 0.35 + ridge * -0.18;
        const i = (y * N + x) * 4;
        img.data[i] = Math.min(255, 222 * toast);
        img.data[i + 1] = Math.min(255, 158 * toast);
        img.data[i + 2] = Math.min(255, 84 * toast);
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return {
      map: canvasTex(c, { repeat: [4, 3] }),
      normal: normalTex(hf, N, N, 4, { repeat: [4, 3] }),
    };
  });
}

function brandFont(px, italic = true) {
  return `${italic ? "italic " : ""}700 ${px}px Georgia, "Times New Roman", serif`;
}
function capsFont(px, weight = 700) {
  return `${weight} ${px}px "Helvetica Neue", Inter, Arial, sans-serif`;
}
function spaced(ctx, text, x, y, spacing) {
  // canvas letterSpacing is not everywhere yet: lay the letters out by hand
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
  let cx = x - total / 2;
  const align = ctx.textAlign;
  ctx.textAlign = "left";
  [...text].forEach((ch, i) => {
    ctx.fillText(ch, cx, y);
    cx += widths[i] + spacing;
  });
  ctx.textAlign = align;
}

/** A tiny dino footprint (three toes), used on the cup print and the sign. */
function footprint(ctx, x, y, s, rot = 0) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.beginPath();
  ctx.ellipse(0, s * 0.35, s * 0.32, s * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const a of [-0.55, 0, 0.55]) {
    ctx.save();
    ctx.rotate(a);
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.38, s * 0.13, s * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** Paper cup print (wraps twice round the cup). */
function cupPrintTex() {
  return cached("tex:cupPrint", () => {
    const Wd = 1024;
    const H = 256;
    const c = makeCanvas(Wd, H);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#f7f1e6";
    ctx.fillRect(0, 0, Wd, H);
    // pink wave band
    ctx.fillStyle = "#f29bab";
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let x = 0; x <= Wd; x += 8) ctx.lineTo(x, H * 0.62 + Math.sin((x / Wd) * Math.PI * 8) * 10);
    ctx.lineTo(Wd, H);
    ctx.fill();
    ctx.fillStyle = "#1f4a3d";
    ctx.fillRect(0, 0, Wd, 16);
    ctx.fillRect(0, H - 10, Wd, 10);
    ctx.fillStyle = "#c9a45a";
    ctx.fillRect(0, 16, Wd, 4);
    for (let k = 0; k < 2; k++) {
      const cx = Wd * (0.25 + k * 0.5);
      ctx.fillStyle = "#1f4a3d";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = brandFont(54);
      ctx.fillText("Prehistoric Scoop", cx, H * 0.36);
      ctx.font = capsFont(20);
      spaced(ctx, "GELATERIA", cx, H * 0.52, 8);
      ctx.fillStyle = "#ffffff";
      footprint(ctx, cx - 150, H * 0.82, 16, -0.3);
      footprint(ctx, cx - 60, H * 0.86, 16, 0.2);
      footprint(ctx, cx + 30, H * 0.82, 16, -0.2);
      footprint(ctx, cx + 120, H * 0.86, 16, 0.25);
    }
    return canvasTex(c);
  });
}

/** Paper sleeve round the cone. */
function sleeveTex() {
  return cached("tex:sleeve", () => {
    const Wd = 1024;
    const H = 256;
    const c = makeCanvas(Wd, H);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#1f4a3d";
    ctx.fillRect(0, 0, Wd, H);
    ctx.fillStyle = "#c9a45a";
    ctx.fillRect(0, 10, Wd, 6);
    ctx.fillRect(0, H - 16, Wd, 6);
    for (let k = 0; k < 3; k++) {
      const cx = Wd * ((k + 0.5) / 3);
      ctx.fillStyle = "#f7efe0";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = brandFont(58);
      ctx.fillText("Prehistoric Scoop", cx, H * 0.45);
      ctx.fillStyle = "#f29bab";
      ctx.font = capsFont(22);
      spaced(ctx, "GELATERIA", cx, H * 0.72, 9);
    }
    return canvasTex(c);
  });
}

/* ------------------------------------------------------------------ */
/* the hand-held gelato                                                  */
/* ------------------------------------------------------------------ */
const SCOOP_R = 0.135;
const SCOOP_RY = 0.122;
const CONE_TIP = -0.11;
const CONE_RIM = 0.305;
const CONE_R = 0.128;
const coneRadiusAt = (y) => 0.004 + (CONE_R - 0.004) * ((y - CONE_TIP) / (CONE_RIM - CONE_TIP));

/** Smooth blobby deformation + rolled ridges + frilly lip, in unit-sphere space. */
function scoopShape(seed) {
  return cached(`shape:${seed}`, () => {
    const r = rng(seed * 977 + 13);
    const waves = [];
    for (let i = 0; i < 7; i++) {
      const d = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
      waves.push({ d, f: 2 + r() * 4, p: r() * 6.28, a: 0.012 + r() * 0.012 });
    }
    const axis = new THREE.Vector3(r() - 0.5, (r() - 0.5) * 0.4, r() - 0.5).normalize();
    const lipPhase = r() * 6.28;
    const lipY = -0.3 - r() * 0.08;
    const point = (dir, out = new THREE.Vector3()) => {
      let n = 0;
      for (const w of waves) n += Math.sin(dir.dot(w.d) * w.f + w.p) * w.a;
      const t = dir.dot(axis);
      const phi = Math.atan2(dir.z, dir.x);
      let rad = 1 + n;
      // rolled striations from dragging the scoop
      rad += 0.022 * Math.sin(t * 26 + n * 40) * (1 - t * t) * smooth(-0.6, -0.1, dir.y);
      // the curled lip where the scoop let go
      const L = smooth(lipY + 0.12, lipY - 0.06, dir.y) * smooth(lipY - 0.32, lipY - 0.12, dir.y);
      const ruffle = 0.5 + 0.5 * Math.sin(phi * 9 + lipPhase + n * 30);
      rad += L * (0.05 + 0.08 * ruffle);
      out.copy(dir).multiplyScalar(rad);
      // tucked in below the lip (sits in the cone / cup)
      const below = smooth(lipY - 0.12, lipY - 0.45, dir.y);
      out.x *= 1 - below * 0.2;
      out.z *= 1 - below * 0.2;
      if (out.y < lipY - 0.1) out.y = lipY - 0.1 + (out.y - (lipY - 0.1)) * 0.5;
      return out;
    };
    return { point, lipY };
  });
}

/** Average normals of coincident vertices (sphere seams / poles). */
function weldNormals(geo) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const map = new Map();
  const key = (i) => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = key(i);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(i);
  }
  const n = new THREE.Vector3();
  for (const list of map.values()) {
    if (list.length < 2) continue;
    n.set(0, 0, 0);
    for (const i of list) n.x += nor.getX(i), n.y += nor.getY(i), n.z += nor.getZ(i);
    n.normalize();
    for (const i of list) nor.setXYZ(i, n.x, n.y, n.z);
  }
  nor.needsUpdate = true;
}

function scoopGeometry(seed) {
  return cached(`geo:scoop:${seed}`, () => {
    const g = new THREE.SphereGeometry(1, 56, 40);
    const pos = g.attributes.position;
    const shape = scoopShape(seed);
    const d = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      d.fromBufferAttribute(pos, i).normalize();
      shape.point(d, p);
      pos.setXYZ(i, p.x * SCOOP_R, p.y * SCOOP_RY, p.z * SCOOP_R);
    }
    g.computeVertexNormals();
    weldNormals(g);
    return shared(g);
  });
}
/** A point on scoop `seed`'s surface in the scoop's local space (+ outward offset). */
function scoopSurface(seed, dir, off = 0) {
  const p = scoopShape(seed).point(dir.clone().normalize());
  const len = p.length();
  p.multiplyScalar((len + off / SCOOP_R) / len);
  return new THREE.Vector3(p.x * SCOOP_R, p.y * SCOOP_RY, p.z * SCOOP_R);
}

function flavourMaterial(flavour, { display = false } = {}) {
  const id = flavour?.id || "custom";
  const color = flavour?.color ?? 0xff9aa2;
  return cached(`mat:gelato:${id}:${color}:${display ? 1 : 0}`, () => {
    const known = id in TONE;
    const map = flavourAlbedo(id, known ? undefined : color);
    const surf = gelatoSurfaceMaps();
    const m = new THREE.MeshStandardMaterial({
      map,
      normalMap: display ? surf.normal : scoopNormalMap(),
      roughnessMap: display ? surf.rough : null,
      roughness: display ? 1 : 0.5,
      metalness: 0,
    });
    m.normalScale.set(display ? 0.9 : 0.7, display ? 0.9 : 0.7);
    if (display) {
      // the case's LED strip lifts the gelato a little
      m.emissive = new THREE.Color(0xffffff);
      m.emissiveMap = map;
      m.emissiveIntensity = 0.1;
    }
    m.name = `gelato-${id}`;
    return shared(m);
  });
}

function coneGeometry() {
  return cached("geo:cone", () => {
    const pts = [];
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const y = CONE_TIP + ((CONE_RIM - 0.03 - CONE_TIP) * i) / steps;
      pts.push(new THREE.Vector2(Math.max(0.002, coneRadiusAt(y)), y));
    }
    // the rolled rim band
    pts.push(new THREE.Vector2(CONE_R + 0.004, CONE_RIM - 0.026));
    pts.push(new THREE.Vector2(CONE_R + 0.008, CONE_RIM - 0.012));
    pts.push(new THREE.Vector2(CONE_R + 0.006, CONE_RIM));
    pts.push(new THREE.Vector2(CONE_R - 0.004, CONE_RIM + 0.004));
    pts.push(new THREE.Vector2(CONE_R - 0.012, CONE_RIM - 0.01));
    const g = new THREE.LatheGeometry(pts, 48);
    return shared(g);
  });
}
function sleeveGeometry() {
  return cached("geo:sleeve", () => {
    const pts = [];
    const y0 = -0.045;
    const y1 = 0.14;
    for (let i = 0; i <= 6; i++) {
      const y = y0 + ((y1 - y0) * i) / 6;
      pts.push(new THREE.Vector2(coneRadiusAt(y) + 0.004, y));
    }
    const g = new THREE.LatheGeometry(pts, 48);
    return shared(g);
  });
}
function cupGeometries() {
  return cached("geo:cup", () => {
    const outer = [
      new THREE.Vector2(0.0, -0.012),
      new THREE.Vector2(0.094, -0.012),
      new THREE.Vector2(0.1, -0.004),
      new THREE.Vector2(0.142, 0.262),
      new THREE.Vector2(0.149, 0.268),
      new THREE.Vector2(0.149, 0.278),
      new THREE.Vector2(0.141, 0.281),
    ];
    const inner = [new THREE.Vector2(0.137, 0.27), new THREE.Vector2(0.097, 0.006), new THREE.Vector2(0.0, 0.006)];
    const o = new THREE.LatheGeometry(outer, 48);
    const i = new THREE.LatheGeometry(inner, 48);
    // the print runs from the base (v=0) to the rim (v=1) on the outside wall only
    const uv = o.attributes.uv;
    for (let k = 0; k < uv.count; k++) {
      const p = Math.round(uv.getY(k) * (outer.length - 1));
      uv.setY(k, p <= 2 ? 0.0 : p === 3 ? 0.97 : 0.99);
    }
    return { outer: shared(o), inner: shared(i) };
  });
}
function dripGeometry() {
  return cached("geo:drip", () => {
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10; // 0 = bottom bulb, 1 = top
      const r = 0.0085 * (t < 0.3 ? Math.sin((t / 0.3) * Math.PI * 0.5 + 0.2) : 1 - (t - 0.3) * 0.5);
      pts.push(new THREE.Vector2(Math.max(0.0005, r), -0.042 + t * 0.05));
    }
    pts[0].x = 0.0005;
    return shared(new THREE.LatheGeometry(pts, 12));
  });
}

function sauceGeometry(seed) {
  return cached(`geo:sauce:${seed}`, () => {
    const r = rng(seed * 31 + 7);
    const drips = [];
    for (let i = 0; i < 7; i++) drips.push({ phi: r() * Math.PI * 2, w: 0.12 + r() * 0.14, len: 0.18 + r() * 0.3 });
    const thetaMax = (phi) => {
      let t = 0.33 * Math.PI + Math.sin(phi * 5 + seed) * 0.03;
      for (const d of drips) {
        let dp = Math.abs(phi - d.phi);
        dp = Math.min(dp, Math.PI * 2 - dp);
        if (dp < d.w) t += d.len * Math.cos((dp / d.w) * Math.PI * 0.5) ** 2;
      }
      return t;
    };
    const N = 64;
    const M = 18;
    const pos = [];
    const uv = [];
    const idx = [];
    const dir = new THREE.Vector3();
    for (let i = 0; i <= N; i++) {
      const phi = (i / N) * Math.PI * 2;
      const tm = thetaMax(phi);
      for (let j = 0; j <= M; j++) {
        const th = (j / M) * tm;
        dir.set(Math.sin(th) * Math.cos(phi), Math.cos(th), Math.sin(th) * Math.sin(phi));
        // thick at the top, thinning to the drip tips
        const p = scoopSurface(seed, dir, 0.0045 * (1 - (j / M) * 0.5));
        pos.push(p.x, p.y, p.z);
        uv.push(i / N, j / M);
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < M; j++) {
        const a = i * (M + 1) + j;
        const b = (i + 1) * (M + 1) + j;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    weldNormals(g);
    return shared(g);
  });
}

function heldMaterials() {
  return cached("mat:held", () => {
    const w = waffleMaps();
    const waffle = new THREE.MeshStandardMaterial({ map: w.map, normalMap: w.normal, roughness: 0.78, side: THREE.DoubleSide });
    waffle.normalScale.set(1.2, 1.2);
    const sleeve = new THREE.MeshStandardMaterial({ map: sleeveTex(), roughness: 0.62, side: THREE.DoubleSide });
    const cup = new THREE.MeshStandardMaterial({ map: cupPrintTex(), roughness: 0.55, side: THREE.DoubleSide });
    const cupInner = new THREE.MeshStandardMaterial({ color: 0xf6f0e4, roughness: 0.7, side: THREE.DoubleSide });
    const sauce = new THREE.MeshPhysicalMaterial({ color: 0x3a1c0e, roughness: 0.22, clearcoat: 0.8, clearcoatRoughness: 0.15, side: THREE.DoubleSide });
    const cherry = new THREE.MeshPhysicalMaterial({ color: 0xa3001c, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08 });
    const stem = new THREE.MeshStandardMaterial({ color: 0x6b6a2a, roughness: 0.7 });
    const sprinkle = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45 });
    const spoon = new THREE.MeshPhysicalMaterial({ color: 0xf07c98, roughness: 0.3, clearcoat: 0.6 });
    const all = { waffle, sleeve, cup, cupInner, sauce, cherry, stem, sprinkle, spoon };
    for (const m of Object.values(all)) shared(m);
    return all;
  });
}
function cherryGeometries() {
  return cached("geo:cherry", () => {
    const body = new THREE.SphereGeometry(0.034, 28, 20);
    const pos = body.attributes.position;
    const d = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      d.fromBufferAttribute(pos, i);
      const ny = d.y / 0.034;
      let s = 1;
      if (ny > 0.7) s -= (ny - 0.7) * 0.45; // dimple round the stem
      d.multiplyScalar(s);
      d.y *= 0.92;
      d.x *= 1.03;
      pos.setXYZ(i, d.x, d.y, d.z);
    }
    body.computeVertexNormals();
    weldNormals(body);
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.022, 0),
      new THREE.Vector3(0.004, 0.05, 0.002),
      new THREE.Vector3(0.016, 0.082, 0.004),
      new THREE.Vector3(0.03, 0.1, 0.006),
    ]);
    const stem = new THREE.TubeGeometry(curve, 16, 0.0026, 6, false);
    return { body: shared(body), stem: shared(stem) };
  });
}
function spoonGeometry() {
  return cached("geo:spoon", () => {
    const blade = new THREE.SphereGeometry(1, 16, 10);
    blade.scale(0.017, 0.004, 0.026);
    blade.translate(0, 0, 0.012);
    const handle = new THREE.BoxGeometry(0.011, 0.003, 0.1);
    handle.translate(0, 0, -0.06);
    const g = mergeGeometries([blade.toNonIndexed(), handle.toNonIndexed()]);
    g.computeVertexNormals();
    return shared(g);
  });
}
const SPRINKLE_COLORS = [0xff5c8a, 0xffd23f, 0x6ad5ff, 0x8be36b, 0xffffff, 0xff8a3d, 0xb07cff];

/**
 * A realistic hand-held gelato. Same contract, size and pose as ui.js
 * makeIceCream(order); returns a THREE.Group.
 */
export function makeGelato(order = {}) {
  const g = new THREE.Group();
  g.name = "gelato";
  g.userData.gelato = true;
  const flavour = order.flavour || GELATO_FLAVOURS[0];
  const scoops = Math.min(3, Math.max(1, Math.round(Number(order.scoops)) || 1));
  const style = order.style === "cup" ? "cup" : "cone";
  const toppings = Array.isArray(order.toppings) ? order.toppings : [];
  const M = heldMaterials();
  const scoopMat = flavourMaterial(flavour);
  const seedBase = strSeed(flavour.id || "x") % 7;

  const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    if (s !== 1) m.scale.setScalar(s);
    m.castShadow = true;
    g.add(m);
    return m;
  };

  // vessel
  let y0;
  if (style === "cone") {
    add(coneGeometry(), M.waffle);
    add(sleeveGeometry(), M.sleeve);
    y0 = 0.36;
  } else {
    const cg = cupGeometries();
    add(cg.outer, M.cup);
    add(cg.inner, M.cupInner);
    y0 = 0.33;
  }

  // scoops, each a little turned so the ridges do not line up
  const seeds = [];
  for (let i = 0; i < scoops; i++) {
    const seed = (seedBase + i) % 3;
    seeds.push(seed);
    add(scoopGeometry(seed), scoopMat, (i === 1 ? 0.008 : i === 2 ? -0.006 : 0), y0 + i * 0.2, 0, 0, i * 2.1 + seedBase, 0);
  }
  const topSeed = seeds[seeds.length - 1];
  const top = g.children[g.children.length - 1];
  const toLocal = (p) => p.clone().applyEuler(top.rotation).add(top.position);

  // drips from the bottom scoop's lip
  {
    const bottom = g.children.find((c) => c.geometry === scoopGeometry(seeds[0]));
    const shape = scoopShape(seeds[0]);
    const r = rng(seedBase * 19 + 5);
    const n = style === "cone" ? 3 : 2;
    for (let k = 0; k < n; k++) {
      const phi = r() * Math.PI * 2;
      const dy = shape.lipY - 0.12;
      const dir = new THREE.Vector3(Math.cos(phi) * Math.sqrt(1 - dy * dy), dy, Math.sin(phi) * Math.sqrt(1 - dy * dy));
      const p = scoopSurface(seeds[0], dir, -0.002).applyEuler(bottom.rotation).add(bottom.position);
      const d = add(dripGeometry(), scoopMat, p.x, p.y, p.z, 0, 0, 0, 0.8 + r() * 0.6);
      // lean with the cone wall
      const out = new THREE.Vector3(p.x, 0, p.z).normalize();
      d.rotation.set(out.z * 0.35, 0, -out.x * 0.35);
    }
  }

  const choc = toppings.includes("chocolate");
  if (choc) {
    const s = add(sauceGeometry(topSeed), M.sauce);
    s.position.copy(top.position);
    s.rotation.copy(top.rotation);
  }

  if (toppings.includes("sprinkles")) {
    const geo = cached("geo:sprinkle", () => shared(new THREE.CapsuleGeometry(0.0032, 0.014, 2, 6)));
    const count = 70;
    const inst = new THREE.InstancedMesh(geo, M.sprinkle, count);
    inst.castShadow = false;
    const r = rng(seedBase * 7 + scoops);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      // golden-angle spiral over the upper cap
      const t = (i + 0.5) / count;
      const cy = 1 - t * 0.85;
      const rr = Math.sqrt(1 - cy * cy);
      const a = i * 2.39996 + r() * 0.3;
      const dir = new THREE.Vector3(Math.cos(a) * rr, cy, Math.sin(a) * rr);
      const p = toLocal(scoopSurface(topSeed, dir, choc ? 0.007 : 0.0025));
      const n = dir.clone().applyEuler(top.rotation).normalize();
      const tan = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).cross(n).normalize();
      q.setFromUnitVectors(up, tan);
      m4.compose(p, q, new THREE.Vector3(1, 0.8 + r() * 0.5, 1));
      inst.setMatrixAt(i, m4);
      inst.setColorAt(i, col.setHex(SPRINKLE_COLORS[Math.floor(r() * SPRINKLE_COLORS.length)]));
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    // computeBoundingSphere needs the instances; keep it from culling wrongly
    inst.frustumCulled = false;
    g.add(inst);
  }

  if (toppings.includes("cherry")) {
    const cg = cherryGeometries();
    const p = toLocal(scoopSurface(topSeed, new THREE.Vector3(0.05, 1, 0.02), choc ? 0.006 : 0));
    add(cg.body, M.cherry, p.x, p.y + 0.026, p.z, 0.12, 0.4, -0.1);
    add(cg.stem, M.stem, p.x, p.y + 0.026, p.z, 0.12, 0.4, -0.1);
  }

  if (style === "cup") {
    // a tasting-spoon paddle pushed into the top scoop
    const p = toLocal(scoopSurface(topSeed, new THREE.Vector3(0.6, 0.55, 0.3), -0.02));
    add(spoonGeometry(), M.spoon, p.x, p.y, p.z, -0.9, 2.2, 0.3);
  }

  // same pose in the hand as makeIceCream
  g.rotation.x = -0.35;
  g.position.set(0, -0.05, 0.06);
  return g;
}

/* ------------------------------------------------------------------ */
/* display tubs (shared by the gelateria and the swatches)              */
/* ------------------------------------------------------------------ */
const PAN_W = 0.56;
const PAN_D = 0.4;

function moundHeight(seed, w, d) {
  const r = rng(seed * 131 + 9);
  const s1 = r() * 6;
  const s2 = r() * 6;
  const s3 = r() * 6;
  const peak = 0.085 + r() * 0.03;
  const lean = (r() - 0.5) * 0.4;
  return (x, z) => {
    const u = x / (w / 2);
    const v = z / (d / 2);
    const dome = Math.pow(Math.max(0, 1 - u * u), 0.45) * Math.pow(Math.max(0, 1 - v * v), 0.45);
    const base = -0.012 + peak * dome * (1 - 0.18 * u * u + lean * u * 0.3);
    const waves =
      0.02 * dome * Math.sin(8.5 * u + 2.6 * Math.sin(3.1 * v + s1) + s2) +
      0.012 * dome * Math.sin(13 * v + 4 * u + s3) +
      0.006 * dome * Math.sin(23 * u - 9 * v + s1);
    return base + waves;
  };
}
function moundGeometry(seed) {
  return cached(`geo:mound:${seed}`, () => {
    const w = PAN_W - 0.02;
    const d = PAN_D - 0.02;
    const h = moundHeight(seed, w, d);
    const g = new THREE.PlaneGeometry(w, d, 64, 44);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, h(pos.getX(i), pos.getZ(i)));
    g.computeVertexNormals();
    return { geo: g, h };
  });
}

function boxGeo(w, h, d, x = 0, y = 0, z = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** Garnish for a pan: [{ geo, mat, matrix }] in tub space. */
function garnish(id, h) {
  const out = [];
  const mats = garnishMaterials();
  const put = (geo, mat, x, z, lift, rx = 0, ry = 0, rz = 0, s = 1) => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, h(x, z) + lift, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(s, s, s)
    );
    out.push({ geo, mat, matrix: m });
  };
  const G = garnishGeometries();
  const wafer = () => put(G.wafer, mats.wafer, -0.07, 0.04, 0.035, 0.35, 0.3, 0.25);
  const roll = (x, z, ry) => put(G.roll, mats.roll, x, z, 0.012, 0.0, ry, Math.PI / 2 - 0.25);
  switch (id) {
    case "strawberry":
      put(G.berryHalf, mats.strawberry, 0.06, -0.02, 0.008, 0.3, 0.5, 0.2);
      put(G.berryHalf, mats.strawberry, 0.11, 0.05, 0.004, -0.2, 2.1, 0.3);
      put(G.leaf, mats.leaf, 0.075, 0.0, 0.03, 0.4, 1.3, 0.1, 0.8);
      wafer();
      break;
    case "mintchoco":
      put(G.shard, mats.choc, 0.05, 0.0, 0.025, 0.6, 0.4, 0.8);
      put(G.shard, mats.choc, 0.09, 0.05, 0.02, -0.5, 1.6, 0.5, 0.8);
      put(G.leaf, mats.leaf, -0.02, -0.03, 0.012, 0.15, 0.8, 0.05);
      put(G.leaf, mats.leaf, 0.0, -0.01, 0.014, -0.15, 2.6, 0.08, 0.8);
      break;
    case "dinodust":
      put(G.cookie, mats.cookie, 0.04, 0.0, 0.02, 0.9, 0.4, 0.0);
      put(G.cookie, mats.cookie, -0.06, 0.03, 0.006, 0.2, 1.4, 0.1, 0.7);
      put(G.cookieBit, mats.cookie, 0.12, -0.04, 0.005, 0.5, 0.2, 0.7);
      put(G.cookieBit, mats.cookie, -0.12, -0.05, 0.004, 0.3, 1.2, 0.2);
      put(G.cookieBit, mats.cookie, 0.0, 0.08, 0.004, 0.1, 2.2, 0.4);
      break;
    case "volcano":
      put(G.chilli, mats.chilli, 0.02, 0.0, 0.012, 0.1, 0.5, 0.05);
      put(G.orange, mats.orange, -0.09, 0.03, 0.006, 1.2, 0.4, 0.2);
      break;
    case "blueberry":
      for (const [x, z] of [[0.03, 0.0], [0.055, 0.02], [0.04, 0.035], [0.015, 0.025], [0.07, -0.01], [0.035, 0.018]])
        put(G.berry, mats.blueberry, x, z, 0.012 + (x === 0.035 ? 0.014 : 0), 0, x * 40, 0);
      put(G.leaf, mats.leaf, 0.0, 0.0, 0.014, 0.2, 2.4, 0.1, 0.7);
      wafer();
      break;
    case "caramel":
      out.push({ geo: G.drizzle(h), mat: mats.caramel, matrix: new THREE.Matrix4() });
      roll(0.05, 0.0, 0.5);
      break;
    case "matcha":
      roll(0.03, 0.0, 0.3);
      roll(0.06, 0.03, 0.55);
      break;
    case "vanilla":
      put(G.pod, mats.pod, 0.0, 0.0, 0.006, 0.0, 0.5, 0.0);
      put(G.pod, mats.pod, 0.02, 0.02, 0.004, 0.0, 0.8, 0.0);
      wafer();
      break;
    default:
      wafer();
  }
  return out;
}
function garnishMaterials() {
  return cached("mat:garnish", () => {
    const w = waffleMaps();
    const fan = makeCanvas(128, 128);
    {
      const ctx = fan.getContext("2d");
      ctx.fillStyle = "#e9c486";
      ctx.fillRect(0, 0, 128, 128);
      ctx.strokeStyle = "#c99a55";
      ctx.lineWidth = 3;
      for (let i = 4; i < 128; i += 10) {
        ctx.beginPath();
        ctx.moveTo(i, 0);
        ctx.lineTo(i, 128);
        ctx.moveTo(0, i);
        ctx.lineTo(128, i);
        ctx.stroke();
      }
    }
    const rollC = makeCanvas(64, 128);
    {
      const ctx = rollC.getContext("2d");
      ctx.fillStyle = "#e3b36b";
      ctx.fillRect(0, 0, 64, 128);
      ctx.strokeStyle = "#5a2e14";
      ctx.lineWidth = 7;
      for (let i = -128; i < 192; i += 22) {
        ctx.beginPath();
        ctx.moveTo(0, i);
        ctx.lineTo(64, i + 40);
        ctx.stroke();
      }
    }
    const S = (o) => shared(new THREE.MeshStandardMaterial(o));
    const P = (o) => shared(new THREE.MeshPhysicalMaterial(o));
    return {
      wafer: S({ map: canvasTex(fan), normalMap: w.normal, roughness: 0.8 }),
      roll: S({ map: canvasTex(rollC), roughness: 0.6 }),
      strawberry: P({ color: 0xc8162c, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
      leaf: P({ color: 0x3f8a2e, roughness: 0.4, clearcoat: 0.3, side: THREE.DoubleSide }),
      choc: S({ color: 0x2a150b, roughness: 0.35 }),
      cookie: S({ color: 0x2e1c14, roughness: 0.85, normalMap: w.normal }),
      chilli: P({ color: 0xc0140a, roughness: 0.22, clearcoat: 0.8 }),
      orange: S({ color: 0xe8661e, roughness: 0.5 }),
      blueberry: S({ color: 0x2c2f5c, roughness: 0.62 }),
      caramel: P({ color: 0x9a4e12, roughness: 0.2, clearcoat: 0.8 }),
      pod: S({ color: 0x24160c, roughness: 0.5 }),
    };
  });
}
function garnishGeometries() {
  return cached("geo:garnish", () => {
    const berryHalf = new THREE.SphereGeometry(1, 16, 12, 0, Math.PI);
    berryHalf.scale(0.026, 0.034, 0.024);
    const leaf = new THREE.SphereGeometry(1, 12, 6);
    leaf.scale(0.03, 0.003, 0.014);
    const shard = new THREE.BoxGeometry(0.05, 0.004, 0.034);
    const cookie = new THREE.CylinderGeometry(0.028, 0.028, 0.009, 18);
    const cookieBit = new THREE.DodecahedronGeometry(0.012, 0);
    const chilliCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.07, 0.01, 0),
      new THREE.Vector3(-0.02, 0.0, 0.012),
      new THREE.Vector3(0.04, 0.004, 0.0),
      new THREE.Vector3(0.075, 0.02, -0.01),
    ]);
    const chilli = new THREE.TubeGeometry(chilliCurve, 20, 0.011, 10, false);
    {
      // taper towards the tip
      const pos = chilli.attributes.position;
      const pts = chilliCurve.getSpacedPoints(20);
      for (let i = 0; i < pos.count; i++) {
        const seg = Math.floor(i / 11);
        const t = seg / 20;
        const c = pts[Math.min(20, seg)];
        const k = t < 0.15 ? 0.8 + t : 1 - (t - 0.15) * 0.95;
        pos.setXYZ(i, c.x + (pos.getX(i) - c.x) * k, c.y + (pos.getY(i) - c.y) * k, c.z + (pos.getZ(i) - c.z) * k);
      }
      chilli.computeVertexNormals();
    }
    const orange = new THREE.CylinderGeometry(0.04, 0.04, 0.006, 20, 1, false, 0, Math.PI);
    const berry = new THREE.SphereGeometry(0.0135, 12, 9);
    const roll = new THREE.CylinderGeometry(0.008, 0.008, 0.13, 10);
    const podCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.08, 0.004, 0),
      new THREE.Vector3(0, 0.0, 0.01),
      new THREE.Vector3(0.08, 0.006, 0.0),
    ]);
    const pod = new THREE.TubeGeometry(podCurve, 16, 0.0045, 6, false);
    const wafer = new THREE.BoxGeometry(0.075, 0.1, 0.006);
    const drizzle = (h) => {
      const pts = [];
      for (let i = 0; i <= 60; i++) {
        const t = i / 60;
        const x = (t - 0.5) * (PAN_W - 0.1);
        const z = Math.sin(t * Math.PI * 7) * (PAN_D * 0.3);
        pts.push(new THREE.Vector3(x, h(x, z) + 0.004, z));
      }
      return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, 0.0055, 6, false);
    };
    return { berryHalf, leaf, shard, cookie, cookieBit, chilli, orange, berry, roll, pod, wafer, drizzle };
  });
}

function panRimGeometry() {
  return cached("geo:panrim", () => {
    const t = 0.018;
    const hgt = 0.014;
    const parts = [
      boxGeo(PAN_W, hgt, t, 0, hgt / 2 - 0.002, -PAN_D / 2 + t / 2),
      boxGeo(PAN_W, hgt, t, 0, hgt / 2 - 0.002, PAN_D / 2 - t / 2),
      boxGeo(t, hgt, PAN_D - 2 * t, -PAN_W / 2 + t / 2, hgt / 2 - 0.002, 0),
      boxGeo(t, hgt, PAN_D - 2 * t, PAN_W / 2 - t / 2, hgt / 2 - 0.002, 0),
    ];
    return mergeGeometries(parts.map((p) => p.toNonIndexed()));
  });
}

/** One pan of gelato in tub space: [{ geo, mat, matrix }]. */
function tubParts(flavour, seed, steel) {
  const mound = moundGeometry(seed);
  const I = new THREE.Matrix4();
  return [
    { geo: panRimGeometry(), mat: steel, matrix: I },
    { geo: mound.geo, mat: flavourMaterial(flavour, { display: true }), matrix: I },
    ...garnish(flavour.id, mound.h),
  ];
}

/* ------------------------------------------------------------------ */
/* materials for the counter                                            */
/* ------------------------------------------------------------------ */
function counterTextures() {
  return cached("tex:counter", () => {
    // marble
    const MW = 768;
    const MH = 384;
    const mc = makeCanvas(MW, MH);
    {
      const ctx = mc.getContext("2d");
      const img = ctx.createImageData(MW, MH);
      for (let y = 0; y < MH; y++) {
        for (let x = 0; x < MW; x++) {
          const u = x / MW;
          const v = y / MH;
          const turb = fbm(u * 6, v * 3, 21, 5, 6, 3);
          const vein = Math.abs(Math.sin((u * 3 + v * 1.4 + turb * 2.6) * Math.PI));
          const fine = Math.abs(Math.sin((u * 9 - v * 4 + turb * 4) * Math.PI));
          const dark = smooth(0.08, 0.0, vein) * 0.32 + smooth(0.05, 0.0, fine) * 0.14;
          const cloud = (fbm(u * 10, v * 5, 4, 3, 10, 5) - 0.5) * 0.05;
          const L = 0.93 + cloud - dark;
          const i = (y * MW + x) * 4;
          img.data[i] = 255 * L;
          img.data[i + 1] = 255 * (L - 0.005);
          img.data[i + 2] = 255 * (L - 0.012);
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    // fluted panel: 4 half-round flutes per tile
    const FW = 128;
    const FH = 8;
    const fh = new Float32Array(FW * FH);
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        const t = ((x / FW) * 4) % 1;
        fh[y * FW + x] = Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)) * 0.9;
      }
    }
    // glazed tiles: brick bond 4 x 8 per tile of 0.6 m
    const TN = 512;
    const tc = makeCanvas(TN, TN);
    const th = new Float32Array(TN * TN);
    {
      const ctx = tc.getContext("2d");
      const img = ctx.createImageData(TN, TN);
      const base = new THREE.Color(0xd7e6d8);
      const grout = new THREE.Color(0xc4beb2);
      for (let y = 0; y < TN; y++) {
        const row = Math.floor(y / 64);
        const off = row % 2 ? 64 : 0;
        for (let x = 0; x < TN; x++) {
          const xx = (x + off) % TN;
          const col = Math.floor(xx / 128);
          const lx = xx % 128;
          const ly = y % 64;
          const edge = Math.min(lx, 127 - lx, ly, 63 - ly);
          const g = edge < 2;
          const bevel = smooth(1.5, 7, edge);
          const tint = (hash2(col, row, 77) - 0.5) * 0.05;
          const wav = (fbm(x / 40, y / 40, 8, 2, TN / 40, TN / 40) - 0.5) * 0.04;
          const c = g ? grout : base;
          const L = g ? 1 : 1 + tint + wav * 0.5 - (1 - bevel) * 0.04;
          const i = (y * TN + x) * 4;
          img.data[i] = Math.min(255, c.r * 255 * L);
          img.data[i + 1] = Math.min(255, c.g * 255 * L);
          img.data[i + 2] = Math.min(255, c.b * 255 * L);
          img.data[i + 3] = 255;
          th[y * TN + x] = g ? 0 : bevel * 0.6 + wav;
        }
      }
      ctx.putImageData(img, 0, 0);
    }
    return {
      marble: canvasTex(mc, { repeat: [1, 1] }),
      fluteN: normalTex(fh, FW, FH, 3, { repeat: [25, 1] }),
      tiles: canvasTex(tc, { repeat: [11, 3.5] }),
      tilesN: normalTex(th, TN, TN, 2.2, { repeat: [11, 3.5] }),
    };
  });
}

function signTextures() {
  return cached("tex:sign", () => {
    const Wd = 2048;
    const H = 156;
    const c = makeCanvas(Wd, H);
    const e = makeCanvas(Wd, H);
    const ctx = c.getContext("2d");
    const ex = e.getContext("2d");
    ctx.fillStyle = "#17352b";
    ctx.fillRect(0, 0, Wd, H);
    ex.fillStyle = "#000";
    ex.fillRect(0, 0, Wd, H);
    for (const g of [ctx, ex]) {
      g.textAlign = "center";
      g.textBaseline = "middle";
    }
    const both = (fn) => {
      fn(ctx, "#e9c97c");
      fn(ex, "#ffffff");
    };
    both((g, col) => {
      g.fillStyle = col;
      g.font = brandFont(96);
      g.fillText("Prehistoric Scoop", Wd / 2 - 170, H / 2 + 4);
      g.font = brandFont(60, false);
      g.fillText("·", Wd / 2 + 330, H / 2);
      g.font = capsFont(44, 600);
      spaced(g, "GELATERIA", Wd / 2 + 560, H / 2 + 2, 14);
    });
    // brass pin-stripe border
    ctx.strokeStyle = "#c9a45a";
    ctx.lineWidth = 4;
    ctx.strokeRect(14, 14, Wd - 28, H - 28);
    // footprint marks at each end
    ctx.fillStyle = "#e9c97c";
    ex.fillStyle = "#7a6a40";
    for (const [x, r] of [[120, -0.4], [190, 0.3], [Wd - 190, -0.3], [Wd - 120, 0.4]]) {
      footprint(ctx, x, H / 2, 26, r);
      footprint(ex, x, H / 2, 26, r);
    }
    return { map: canvasTex(c), emissive: canvasTex(e) };
  });
}

function menuTexture(flavours) {
  const key = "tex:menu:" + flavours.map((f) => f.id).join(",");
  return cached(key, () => {
    const Wd = 1536;
    const H = 640;
    const c = makeCanvas(Wd, H);
    const ctx = c.getContext("2d");
    const grd = ctx.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, "#1b3b31");
    grd.addColorStop(1, "#132a23");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, Wd, H);
    ctx.strokeStyle = "#c9a45a";
    ctx.lineWidth = 3;
    ctx.strokeRect(18, 18, Wd - 36, H - 36);
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = "#c9a45a";
    ctx.font = capsFont(24, 600);
    spaced(ctx, "GELATO ARTIGIANALE · MADE HERE DAILY", Wd / 2, 60, 6);
    ctx.fillStyle = "#f6ecd8";
    ctx.font = brandFont(64);
    ctx.fillText("Today's Flavours", Wd / 2, 118);
    const colW = (Wd - 160) / 2;
    flavours.forEach((f, i) => {
      const col = i < Math.ceil(flavours.length / 2) ? 0 : 1;
      const row = col ? i - Math.ceil(flavours.length / 2) : i;
      const x0 = 80 + col * (colW + 0) + (col ? 30 : 0);
      const x1 = x0 + colW - 60;
      const y = 200 + row * 84;
      // colour dot
      ctx.fillStyle = hexCss(TONE[f.id] ?? f.color);
      ctx.beginPath();
      ctx.arc(x0 + 14, y, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.fillStyle = "#f6ecd8";
      ctx.font = capsFont(34, 700);
      ctx.fillText(f.name.toUpperCase(), x0 + 44, y - 10);
      ctx.fillStyle = "#b9c8bd";
      ctx.font = brandFont(22);
      ctx.fillText((INFO[f.id] || {}).desc || "House recipe", x0 + 44, y + 22);
      ctx.textAlign = "right";
      ctx.fillStyle = "#e9c97c";
      ctx.font = capsFont(30, 600);
      ctx.fillText((INFO[f.id] || {}).price || "3.50", x1, y - 8);
      // dotted leader
      const nameW = (() => {
        ctx.font = capsFont(34, 700);
        return ctx.measureText(f.name.toUpperCase()).width;
      })();
      ctx.fillStyle = "rgba(233,201,124,0.45)";
      for (let x = x0 + 60 + nameW; x < x1 - 80; x += 12) ctx.fillRect(x, y - 2, 3, 3);
    });
    ctx.textAlign = "center";
    ctx.fillStyle = "#f29bab";
    ctx.font = capsFont(26, 700);
    spaced(ctx, "1 SCOOP 3.50   ·   2 SCOOPS 5.50   ·   3 SCOOPS 7.00   ·   CONE OR CUP   ·   TOPPINGS +0.50", Wd / 2, H - 62, 2);
    return canvasTex(c);
  });
}

function cardAtlas(flavours) {
  const key = "tex:cards:" + flavours.map((f) => f.id).join(",");
  return cached(key, () => {
    const Wd = 1024;
    const H = 512;
    const c = makeCanvas(Wd, H);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, Wd, H);
    flavours.slice(0, 16).forEach((f, i) => {
      const x = (i % 4) * 256;
      const y = Math.floor(i / 4) * 128;
      ctx.fillStyle = "#fbf7ef";
      ctx.fillRect(x, y, 256, 128);
      ctx.fillStyle = hexCss(TONE[f.id] ?? f.color);
      ctx.fillRect(x, y + 104, 256, 24);
      ctx.fillStyle = "#1f4a3d";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let size = 40;
      ctx.font = brandFont(size);
      while (ctx.measureText(f.name).width > 232 && size > 20) ctx.font = brandFont(--size);
      ctx.fillText(f.name, x + 128, y + 44);
      ctx.font = capsFont(18, 600);
      ctx.fillStyle = "#8a7a5a";
      ctx.fillText((INFO[f.id] || {}).price || "3.50", x + 128, y + 84);
    });
    return canvasTex(c);
  });
}

function emblemTexture() {
  return cached("tex:emblem", () => {
    const N = 512;
    const c = makeCanvas(N, N);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#17352b";
    ctx.beginPath();
    ctx.arc(N / 2, N / 2, N / 2 - 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#e9c97c";
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(N / 2, N / 2, N / 2 - 30, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#e9c97c";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = brandFont(210);
    ctx.fillText("PS", N / 2, N / 2 - 20);
    ctx.font = capsFont(34, 700);
    spaced(ctx, "EST. 66 MYA", N / 2, N / 2 + 120, 6);
    ctx.fillStyle = "#f29bab";
    footprint(ctx, N / 2, N / 2 - 175, 22, 0);
    return canvasTex(c);
  });
}

function speckleTex(key, base, colors, n, sz) {
  return cached("tex:speckle:" + key, () => {
    const N = 128;
    const c = makeCanvas(N, N);
    const ctx = c.getContext("2d");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, N, N);
    const r = rng(strSeed(key));
    for (let i = 0; i < n; i++) {
      ctx.fillStyle = colors[Math.floor(r() * colors.length)];
      ctx.save();
      ctx.translate(r() * N, r() * N);
      ctx.rotate(r() * Math.PI);
      ctx.fillRect(-sz, -sz * 0.35, sz * 2, sz * 0.7);
      ctx.restore();
    }
    return canvasTex(c, { repeat: [2, 1] });
  });
}

let envTexture = null;
function envMap(renderer) {
  if (envTexture || !renderer) return envTexture;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    envTexture = pmrem.fromScene(room, 0.03).texture;
    room.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        o.material.dispose();
      }
    });
    pmrem.dispose();
  } catch {
    envTexture = null;
  }
  return envTexture;
}

function counterMaterials(renderer) {
  const env = envMap(renderer);
  const T = counterTextures();
  const S = (o) => new THREE.MeshStandardMaterial(o);
  const steel = S({ color: 0xc9ccd0, metalness: 1, roughness: 0.28, envMap: env, envMapIntensity: 0.9 });
  const darkSteel = S({ color: 0x1d1e20, metalness: 0.7, roughness: 0.42, envMap: env, envMapIntensity: 0.6 });
  const brass = S({ color: 0xd2ad62, metalness: 1, roughness: 0.3, envMap: env, envMapIntensity: 1.0 });
  const marble = S({ map: T.marble, roughness: 0.16, envMap: env, envMapIntensity: 0.55 });
  const fluted = S({ color: 0xe8b8ae, roughness: 0.55, normalMap: T.fluteN });
  fluted.normalScale.set(1.4, 1.4);
  const paint = S({ color: 0xe1b2a8, roughness: 0.6 });
  const green = S({ color: 0x17352b, roughness: 0.55 });
  const tiles = S({ map: T.tiles, normalMap: T.tilesN, roughness: 0.18, envMap: env, envMapIntensity: 0.5 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xf4fbff,
    metalness: 0,
    roughness: 0.03,
    transparent: true,
    opacity: 0.2,
    envMap: env,
    envMapIntensity: 2.4,
    side: THREE.DoubleSide,
    depthWrite: false,
    ior: 1.5,
    specularIntensity: 1,
  });
  const acrylic = glass.clone();
  acrylic.opacity = 0.14;
  const led = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff1d8, emissiveIntensity: 3.2 });
  const water = new THREE.MeshPhysicalMaterial({
    color: 0x8fb8c8,
    roughness: 0.04,
    metalness: 0,
    transparent: true,
    opacity: 0.75,
    envMap: env,
    envMapIntensity: 1.6,
  });
  const wood = S({ color: 0xc89a6a, roughness: 0.55 });
  try {
    const L = new THREE.TextureLoader();
    const t = (k) => {
      const tx = L.load(`/textures/wood/${k}.jpg`);
      tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
      if (k === "diff") tx.colorSpace = THREE.SRGBColorSpace;
      return tx;
    };
    wood.map = t("diff");
    wood.normalMap = t("nor");
    wood.roughnessMap = t("rough");
    wood.color.set(0xe8d2b8);
    wood.roughness = 1;
  } catch {
    /* plain oak tone */
  }
  const sign = signTextures();
  const signMat = S({ map: sign.map, emissive: 0xffe2a8, emissiveMap: sign.emissive, emissiveIntensity: 1.6, roughness: 0.5 });
  const emblem = S({ map: emblemTexture(), emissive: 0xffffff, emissiveMap: emblemTexture(), emissiveIntensity: 0.35, roughness: 0.5 });
  const downlight = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff0d6, emissiveIntensity: 4 });
  const paper = S({ color: 0xf7f2ea, roughness: 0.8 });
  const rubber = S({ color: 0x111214, roughness: 0.8 });
  const handles = [0xf07c98, 0x2f8f74, 0xf2c14e].map((c) => S({ color: c, roughness: 0.4 }));
  return {
    steel, darkSteel, brass, marble, fluted, paint, green, tiles, glass, acrylic, led, water, wood, signMat, emblem,
    downlight, paper, rubber, handles,
  };
}

/* ------------------------------------------------------------------ */
/* the gelateria                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build the gelato bar at the court's stall and hide world.js's primitive kiosk.
 * Returns { group, ready, stats, dispose() }; `ready` resolves when the glTF
 * pendant lamps / cash register / stools are in.
 */
export function buildGelateria({ scene, world, COURT, renderer, flavours = GELATO_FLAVOURS, quality = "high", stools = true } = {}) {
  if (!scene) throw new Error("buildGelateria needs { scene }");
  if (scene.userData.__gelateria) return scene.userData.__gelateria;
  const court = COURT || W.COURT || { stallX: 78, stallZ: 75 };
  const X = court.stallX;
  const C = (W.PROPS && W.PROPS.counter) || { x: X, z: court.stallZ - 0.4, w: 6, d: 1.4 };
  const zF = C.z - C.d / 2; // customer face
  const zB = C.z + C.d / 2; // vendor side
  let wallZ = court.stallZ + 2.8;
  try {
    const room = W.roomAt?.(X, court.stallZ);
    const CELL = W.CELL ?? 6;
    if (room && typeof W.g2z === "function") wallZ = W.g2z(room.rows[1]) + CELL / 2 - 0.2;
  } catch {
    /* keep the default */
  }
  const HW = C.w / 2;
  const stats = { hidden: [], drawCalls: 0, triangles: 0, models: [] };

  const root = new THREE.Group();
  root.name = "gelateria";
  root.userData.surface = "skip"; // lookdev: hands off, these are finished materials
  root.position.set(X, 0, 0);
  scene.add(root);
  const mats = counterMaterials(renderer);

  /* ---------- buckets: one merged mesh per material ---------- */
  const buckets = new Map();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const T = (x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) => {
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    const sv = Array.isArray(s) ? new THREE.Vector3(...s) : new THREE.Vector3(s, s, s);
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), _q, sv);
  };
  function put(geo, mat, matrix) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    g.morphAttributes = {};
    g.clearGroups();
    g.applyMatrix4(matrix);
    if (!buckets.has(mat)) buckets.set(mat, []);
    buckets.get(mat).push(g);
  }
  const box = (w, h, d, mat, x, y, z, rx = 0, ry = 0, rz = 0) => put(new THREE.BoxGeometry(w, h, d), mat, T(x, y, z, rx, ry, rz));
  const cyl = (rt, rb, h, seg, mat, x, y, z, rx = 0, ry = 0, rz = 0, open = false) =>
    put(new THREE.CylinderGeometry(rt, rb, h, seg, 1, open), mat, T(x, y, z, rx, ry, rz));
  /** Rod between two points. */
  const rod = (a, b, r, mat, seg = 8) => {
    const d = new THREE.Vector3().subVectors(b, a);
    const g = new THREE.CylinderGeometry(r, r, d.length(), seg);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
    put(g, mat, new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)));
  };

  /* ================= display freezer ================= */
  const topY = 0.97; // slab top
  const caseX0 = -HW + 0.05;
  const caseX1 = HW - 1.05;
  const caseLen = caseX1 - caseX0;
  const caseMid = (caseX0 + caseX1) / 2;
  const R = 0.5; // front glass radius
  const zc = zF + 0.1 + R; // arc centre
  const glassTop = topY + R;

  // base cabinet
  box(C.w - 0.12, 0.1, C.d - 0.16, mats.darkSteel, 0, 0.05, C.z + 0.05);
  box(C.w, 0.82, C.d - 0.05, mats.paint, 0, 0.1 + 0.41, C.z + 0.025);
  put(new THREE.BoxGeometry(C.w, 0.78, 0.025), mats.fluted, T(0, 0.51, zF + 0.0125));
  box(C.w + 0.02, 0.026, 0.035, mats.brass, 0, 0.912, zF + 0.012);
  box(C.w + 0.02, 0.02, 0.035, mats.brass, 0, 0.12, zF + 0.012);
  box(C.w + 0.05, 0.05, C.d + 0.04, mats.marble, 0, topY - 0.025, C.z - 0.01);

  // tilted deck that holds the pans (front edge lower, facing the customers)
  const tilt = -0.12;
  const deckZ = zc - 0.05;
  const deckY = topY + 0.075;
  const deck = T(caseMid, deckY, deckZ, tilt);
  const deckLen = caseLen - 0.06;
  put(new THREE.BoxGeometry(deckLen, 0.1, PAN_D + 0.12), mats.steel, deck.clone().multiply(T(0, -0.05, 0)));
  // the case's interior floor in front of the deck and the vendor-side shelf behind it
  box(caseLen - 0.04, 0.012, 0.3, mats.steel, caseMid, topY + 0.006, zF + 0.25);
  box(caseLen - 0.04, 0.1, zB - (deckZ + 0.2) - 0.02, mats.steel, caseMid, topY + 0.05, (deckZ + 0.2 + zB - 0.02) / 2);
  const n = flavours.length;
  const pitch = deckLen / n;
  const tubs = [];
  flavours.forEach((f, i) => {
    const x = -deckLen / 2 + pitch * (i + 0.5);
    const local = T(x, 0, 0);
    const world = deck.clone().multiply(local);
    for (const p of tubParts(f, i % 5, mats.steel)) put(p.geo, p.mat, world.clone().multiply(p.matrix));
    tubs.push({ id: f.id, x: caseMid + x });
  });
  // flavour cards on picks along the front of the case, angled up to the customers
  {
    const atlas = new THREE.MeshStandardMaterial({ map: cardAtlas(flavours), roughness: 0.6 });
    flavours.forEach((f, i) => {
      const x = caseMid - deckLen / 2 + pitch * (i + 0.5);
      const g = new THREE.PlaneGeometry(0.17, 0.085);
      const uv = g.attributes.uv;
      const cx = (i % 4) / 4;
      const cy = 1 - (Math.floor(i / 4) + 1) / 4;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, cx + uv.getX(k) * 0.25, cy + uv.getY(k) * 0.25);
      put(g, atlas, T(x, topY + 0.085, zF + 0.2, 0.55, Math.PI, 0));
      rod(new THREE.Vector3(x, topY + 0.012, zF + 0.215), new THREE.Vector3(x, topY + 0.06, zF + 0.205), 0.003, mats.steel, 5);
    });
  }
  // curved front glass, glass top, end panels, frame
  {
    const g = new THREE.CylinderGeometry(R, R, caseLen - 0.03, 56, 1, true, Math.PI / 2, Math.PI / 2);
    g.rotateZ(Math.PI / 2);
    put(g, mats.glass, T(caseMid, topY, zc));
    // flat glass top running back to the vendor side
    box(caseLen - 0.03, 0.008, 0.62, mats.glass, caseMid, glassTop, zc + 0.3);
    // steel canopy strip under the top glass with the LED strip on its front edge
    box(caseLen - 0.02, 0.022, 0.2, mats.steel, caseMid, glassTop - 0.016, zc + 0.5);
    box(caseLen - 0.14, 0.006, 0.022, mats.led, caseMid, glassTop - 0.029, zc + 0.42);
    // frame: bottom channel, top rail, back rail
    box(caseLen, 0.03, 0.045, mats.steel, caseMid, topY + 0.015, zF + 0.1);
    put(new THREE.CylinderGeometry(0.012, 0.012, caseLen, 10).rotateZ(Math.PI / 2), mats.steel, T(caseMid, glassTop, zc));
    box(caseLen, 0.02, 0.025, mats.steel, caseMid, glassTop, zc + 0.6);
    // end panels: steel frame round a glass pane, following the profile
    const profile = (inset) => {
      const s = new THREE.Shape();
      const r = R - inset;
      const z0 = zF + 0.1 + inset;
      s.moveTo(z0 - zc, topY + inset);
      s.absarc(0, topY, r, Math.PI, Math.PI / 2, true);
      s.lineTo(0.6 - inset, topY + r);
      s.lineTo(0.6 - inset, topY + inset);
      s.lineTo(z0 - zc, topY + inset);
      return s;
    };
    const frame = profile(0);
    frame.holes.push(new THREE.Path(profile(0.035).getPoints(40)));
    const frameGeo = new THREE.ExtrudeGeometry(frame, { depth: 0.03, bevelEnabled: false, curveSegments: 40 });
    const paneGeo = new THREE.ExtrudeGeometry(profile(0.035), { depth: 0.008, bevelEnabled: false, curveSegments: 40 });
    // shape (sx, sy, sz) -> world (x = -sz + px, y = sy, z = sx + zc)
    for (const px of [caseX0, caseX1]) {
      const m = (d) => T(px + d / 2, 0, zc, 0, -Math.PI / 2, 0);
      put(frameGeo, mats.steel, m(0.03));
      put(paneGeo, mats.glass, m(0.008));
    }
  }

  // pay point on the right end: marble shelf, napkins, tip jar, spoons
  {
    const x0 = caseX1 + 0.5;
    // napkin dispenser (chrome box with a napkin poking out)
    box(0.13, 0.15, 0.1, mats.steel, x0 - 0.28, topY + 0.075, zF + 0.22);
    box(0.09, 0.03, 0.002, mats.paper, x0 - 0.28, topY + 0.1, zF + 0.169);
    // tip jar
    cyl(0.055, 0.05, 0.14, 18, mats.glass, x0 + 0.25, topY + 0.07, zF + 0.2, 0, 0, 0, true);
    box(0.06, 0.004, 0.06, mats.brass, x0 + 0.25, topY + 0.004, zF + 0.2);
    // tasting spoons in a little steel cup
    cyl(0.03, 0.026, 0.08, 14, mats.steel, x0, topY + 0.04, zF + 0.2);
    for (let k = 0; k < 7; k++) {
      const a = k * 0.9;
      rod(new THREE.Vector3(x0 + Math.cos(a) * 0.01, topY + 0.04, zF + 0.2 + Math.sin(a) * 0.01),
        new THREE.Vector3(x0 + Math.cos(a) * 0.03, topY + 0.13, zF + 0.2 + Math.sin(a) * 0.03), 0.004, mats.handles[0], 4);
    }
    // card reader
    box(0.08, 0.02, 0.15, mats.rubber, x0 - 0.3, topY + 0.01, C.z + 0.3, 0.25);
  }

  // dipper well with gelato spades standing in running water (vendor side, left)
  {
    const wx = caseX0 + 0.3;
    const wz = zB - 0.17;
    const wy = topY + 0.1;
    box(0.34, 0.1, 0.22, mats.steel, wx, wy + 0.05, wz);
    for (const [w, d, x, z] of [[0.34, 0.02, 0, -0.1], [0.34, 0.02, 0, 0.1], [0.02, 0.2, -0.16, 0], [0.02, 0.2, 0.16, 0]])
      box(w, 0.02, d, mats.steel, wx + x, wy + 0.105, wz + z);
    box(0.3, 0.004, 0.18, mats.water, wx, wy + 0.104, wz);
    // goose-neck tap
    const pts = [
      new THREE.Vector3(wx + 0.15, wy + 0.12, wz + 0.09),
      new THREE.Vector3(wx + 0.15, wy + 0.3, wz + 0.09),
      new THREE.Vector3(wx + 0.1, wy + 0.34, wz + 0.05),
      new THREE.Vector3(wx + 0.06, wy + 0.27, wz + 0.02),
    ];
    put(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.009, 8), mats.steel, new THREE.Matrix4());
    rod(new THREE.Vector3(wx + 0.06, wy + 0.27, wz + 0.02), new THREE.Vector3(wx + 0.06, wy + 0.115, wz + 0.02), 0.002, mats.water, 5);
    // three spades: flat blade in the water, coloured handle up
    for (let k = 0; k < 3; k++) {
      const x = wx - 0.09 + k * 0.07;
      const lean = -0.25 + k * 0.08;
      put(new THREE.BoxGeometry(0.055, 0.12, 0.004), mats.steel, T(x, wy + 0.12, wz - 0.02, lean, 0, 0.1 * (k - 1)));
      put(new THREE.CylinderGeometry(0.011, 0.009, 0.15, 10), mats.handles[k], T(x + 0.015 * (k - 1), wy + 0.25, wz - 0.05, lean, 0, 0.1 * (k - 1)));
    }
  }

  /* ================= back bar ================= */
  const bbD = 0.62;
  const bbZ = wallZ - bbD / 2;
  const bbTop = 0.96;
  box(C.w, 0.1, bbD - 0.06, mats.darkSteel, 0, 0.05, bbZ + 0.03);
  box(C.w, bbTop - 0.14, bbD, mats.wood, 0, 0.1 + (bbTop - 0.14) / 2, bbZ);
  box(C.w + 0.04, 0.04, bbD + 0.04, mats.marble, 0, bbTop - 0.02, bbZ - 0.01);
  for (let k = 0; k <= 6; k++) {
    const x = -HW + k * (C.w / 6);
    box(0.006, bbTop - 0.18, 0.004, mats.darkSteel, x, 0.1 + (bbTop - 0.14) / 2, bbZ - bbD / 2 - 0.001);
    if (k < 6) {
      const px = x + (k % 2 ? 0.08 : C.w / 6 - 0.08);
      cyl(0.008, 0.008, 0.2, 8, mats.brass, px, 0.68, bbZ - bbD / 2 - 0.03);
      box(0.012, 0.012, 0.03, mats.brass, px, 0.6, bbZ - bbD / 2 - 0.015);
      box(0.012, 0.012, 0.03, mats.brass, px, 0.76, bbZ - bbD / 2 - 0.015);
    }
  }

  // tiled back wall, framed by brass
  const wallTop = 3.08;
  {
    const g = new THREE.PlaneGeometry(C.w + 0.6, wallTop - bbTop);
    put(g, mats.tiles, T(0, (wallTop + bbTop) / 2, wallZ - 0.012, 0, Math.PI, 0));
    box(C.w + 0.62, 0.02, 0.02, mats.brass, 0, bbTop + 0.01, wallZ - 0.02);
  }

  // illuminated menu board (lightbox)
  {
    const mw = 3.1;
    const mh = 1.3;
    const mx = 0.25;
    const my = 2.12;
    box(mw + 0.1, mh + 0.1, 0.07, mats.darkSteel, mx, my, wallZ - 0.05);
    const face = new THREE.MeshBasicMaterial({ map: menuTexture(flavours), toneMapped: true });
    face.color.setScalar(0.95);
    put(new THREE.PlaneGeometry(mw, mh), face, T(mx, my, wallZ - 0.087, 0, Math.PI, 0));
    // round brand emblem to its left
    const emblemGeo = new THREE.CircleGeometry(0.42, 48);
    put(emblemGeo, mats.emblem, T(-2.35, 2.25, wallZ - 0.03, 0, Math.PI, 0));
    put(new THREE.TorusGeometry(0.43, 0.018, 8, 48), mats.brass, T(-2.35, 2.25, wallZ - 0.03));
  }

  // waffle cone stand: oak block, six stacks of nested cones (left of the back bar)
  {
    const sx = -2.35;
    const sz = bbZ - 0.05;
    box(0.5, 0.07, 0.3, mats.wood, sx, bbTop + 0.035, sz);
    const W2 = waffleMaps();
    const coneMat = new THREE.MeshStandardMaterial({ map: W2.map, normalMap: W2.normal, roughness: 0.78, side: THREE.DoubleSide });
    const cg = new THREE.ConeGeometry(0.035, 0.15, 18, 1, true);
    cg.rotateX(Math.PI);
    const rimG = new THREE.TorusGeometry(0.034, 0.004, 6, 18).rotateX(Math.PI / 2);
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        const x = sx - 0.15 + col * 0.15;
        const z = sz - 0.07 + row * 0.14;
        const count = 5 + ((row + col) % 3);
        for (let k = 0; k < count; k++) {
          const y = bbTop + 0.07 + 0.075 + k * 0.024;
          put(cg, coneMat, T(x, y, z, 0, k, 0));
          put(rimG, coneMat, T(x, y + 0.075, z));
        }
      }
    }
  }

  // topping jars
  {
    const jars = [
      { tex: speckleTex("sprinkles", "#f5e9e4", ["#ff5c8a", "#ffd23f", "#6ad5ff", "#8be36b", "#b07cff", "#ff8a3d"], 900, 2.2) },
      { tex: speckleTex("cherries", "#5a0612", ["#a3001c", "#7a0a18", "#c0192d"], 180, 7) },
      { tex: speckleTex("chips", "#3a2015", ["#24130b", "#4b2a1a", "#2e1810"], 400, 3.2) },
      { tex: speckleTex("pistachio", "#9db45a", ["#6e8a35", "#c9d68a", "#7d5a36"], 500, 2.6) },
    ];
    jars.forEach((j, k) => {
      const x = -1.55 + k * 0.17;
      const z = bbZ - 0.08;
      const fill = new THREE.MeshStandardMaterial({ map: j.tex, roughness: 0.6 });
      cyl(0.058, 0.058, 0.11, 18, fill, x, bbTop + 0.06, z);
      cyl(0.065, 0.065, 0.17, 20, mats.glass, x, bbTop + 0.085, z, 0, 0, 0, true);
      cyl(0.068, 0.068, 0.025, 20, mats.brass, x, bbTop + 0.18, z);
    });
  }

  // cup dispenser tubes, wall-mounted at the right, and stacks of cups
  {
    const cupG = cupGeometries();
    const cupMat = heldMaterials().cup;
    const sizes = [0.42, 0.52, 0.62];
    sizes.forEach((s, k) => {
      const x = 2.22 + k * 0.29;
      const z = wallZ - 0.12;
      const y0 = 1.25;
      cyl(0.11 * s * 1.25 + 0.012, 0.11 * s * 1.25 + 0.012, 0.62, 20, mats.acrylic, x, y0 + 0.31, z, 0, 0, 0, true);
      box(0.03, 0.6, 0.06, mats.steel, x, y0 + 0.3, wallZ - 0.03);
      for (let i = 0; i < 12; i++) put(cupG.outer, cupMat, T(x, y0 + 0.285 * s + 0.01 + i * 0.045, z, Math.PI, i, 0, s));
      cyl(0.11 * s * 1.25 + 0.02, 0.11 * s * 1.25 + 0.02, 0.025, 20, mats.steel, x, y0 + 0.62, z);
    });
    // upside-down cup stacks on the counter
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i < 8; i++) put(cupG.outer, cupMat, T(0.55 + k * 0.28, bbTop + 0.157 + i * 0.017, bbZ, Math.PI, i, 0, 0.55));
    }
  }

  /* ================= canopy and sign ================= */
  const canopyFront = zF - 0.35;
  const canopyY = 3.25;
  const canopyD = wallZ - canopyFront;
  {
    box(C.w + 0.8, 0.2, canopyD, mats.green, 0, canopyY, canopyFront + canopyD / 2);
    // oak slatted soffit
    for (let k = 0; k < 18; k++) {
      const z = canopyFront + 0.2 + k * ((canopyD - 0.35) / 17);
      box(C.w + 0.6, 0.03, 0.12, mats.wood, 0, canopyY - 0.115, z);
    }
    // fascia with the shop sign
    box(C.w + 0.84, 0.66, 0.09, mats.green, 0, canopyY + 0.06, canopyFront - 0.045);
    put(new THREE.PlaneGeometry(C.w + 0.6, (C.w + 0.6) * (156 / 2048)), mats.signMat, T(0, canopyY + 0.06, canopyFront - 0.092, 0, Math.PI, 0));
    box(C.w + 0.88, 0.022, 0.1, mats.brass, 0, canopyY + 0.4, canopyFront - 0.045);
    box(C.w + 0.88, 0.022, 0.1, mats.brass, 0, canopyY - 0.28, canopyFront - 0.045);
    // tie rods to the wall
    for (const sx of [-1, 1]) {
      const x = sx * (HW + 0.3);
      rod(new THREE.Vector3(x, canopyY + 0.1, canopyFront + 0.05), new THREE.Vector3(x, canopyY + 2.0, wallZ - 0.02), 0.014, mats.darkSteel);
      box(0.12, 0.2, 0.02, mats.darkSteel, x, canopyY + 2.0, wallZ - 0.01);
    }
    // recessed downlights over the vendor's side
    for (let k = 0; k < 4; k++) {
      const x = -2.25 + k * 1.5;
      const z = (zB + wallZ) / 2 + 0.2;
      put(new THREE.CircleGeometry(0.055, 20), mats.downlight, T(x, canopyY - 0.132, z, Math.PI / 2, 0, 0));
      put(new THREE.TorusGeometry(0.065, 0.01, 6, 20), mats.darkSteel, T(x, canopyY - 0.13, z, Math.PI / 2, 0, 0));
    }
  }

  /* ---------- flush buckets into merged meshes ---------- */
  const owned = { geos: [], mats: new Set() };
  const noShadow = new Set([mats.glass, mats.acrylic, mats.led, mats.water, mats.downlight, mats.signMat]);
  for (const [mat, list] of buckets) {
    const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!geo) continue;
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `gelateria-${mat.name || mat.type}`;
    mesh.castShadow = !noShadow.has(mat) && mat !== mats.green;
    mesh.receiveShadow = !mat.transparent;
    if (mat.transparent) mesh.renderOrder = 2;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    root.add(mesh);
    owned.geos.push(geo);
    if (!mat.userData?.gelatoShared) owned.mats.add(mat);
    stats.drawCalls++;
    stats.triangles += geo.attributes.position.count / 3;
  }
  for (const list of buckets.values()) for (const g of list) if (!owned.geos.includes(g)) g.dispose();

  /* ---------- hide world.js's primitive kiosk ---------- */
  const hidden = [];
  const worldGroup = world?.group || scene;
  {
    const IGNORE = new Set(["floor", "ceiling", "wall", "trim"]);
    const box3 = new THREE.Box3();
    const ctr = new THREE.Vector3();
    const size = new THREE.Vector3();
    const surfaceOf = (o) => {
      for (let p = o; p; p = p.parent) if (p.userData && p.userData.surface) return p.userData.surface;
      return null;
    };
    const minX = X - HW - 0.9;
    const maxX = X + HW + 2.6; // the old flavour board stood 1.4 m off the counter's east end
    const minZ = zF - 1.6;
    const maxZ = wallZ + 0.1;
    worldGroup.updateMatrixWorld(true);
    worldGroup.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || !o.visible) return;
      for (let p = o; p; p = p.parent) if (p === root) return;
      if (IGNORE.has(surfaceOf(o))) return;
      box3.setFromObject(o);
      if (box3.isEmpty()) return;
      box3.getCenter(ctr);
      box3.getSize(size);
      if (ctr.x < minX || ctr.x > maxX || ctr.z < minZ || ctr.z > maxZ || ctr.y > 4.6) return;
      if (size.x > C.w + 1.2 || size.z > 4 || size.y > 4.5) return;
      o.visible = false;
      hidden.push(o);
      stats.hidden.push(`${o.geometry?.type || "?"}@${ctr.x.toFixed(1)},${ctr.y.toFixed(1)},${ctr.z.toFixed(1)}`);
    });
  }

  /* ---------- colliders: nobody walks into the staff area ---------- */
  const colliders = [];
  const OB = Array.isArray(W.PROP_OBSTACLES) ? W.PROP_OBSTACLES : null;
  if (OB) {
    colliders.push({ id: "gelato:staff", minX: X - HW - 0.1, maxX: X + HW + 0.1, minZ: zB - 0.02, maxZ: wallZ });
  }

  /* ---------- glTF dressing ---------- */
  const loader = new GLTFLoader();
  const fixMaterials = (obj, { shadow = true } = {}) => {
    obj.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = shadow;
      o.receiveShadow = true;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      list.forEach((m, i) => {
        if (!m) return;
        if (m.transmission > 0) {
          // transmission costs a second scene pass: fake the glass instead
          const g = new THREE.MeshPhysicalMaterial({
            color: 0xfff6e8, roughness: 0.08, transparent: true, opacity: 0.35, envMap: envMap(renderer),
            envMapIntensity: 1.5, depthWrite: false, normalMap: m.normalMap || null,
          });
          if (Array.isArray(o.material)) o.material[i] = g;
          else o.material = g;
          m.dispose();
          return;
        }
        if (m.isMeshStandardMaterial && !m.envMap) {
          m.envMap = envMap(renderer);
          m.envMapIntensity = 0.7;
        }
      });
    });
  };
  const load = (name) =>
    loader.loadAsync(BASE + MODELS[name]).then(
      (g) => {
        stats.models.push(name);
        return g.scene;
      },
      (err) => {
        console.warn(`gelateria: ${name} did not load`, err);
        return null;
      }
    );
  const extra = new THREE.Group();
  extra.name = "gelateria-models";
  root.add(extra);
  const ready = Promise.all([load("lamp"), load("register"), stools ? load("stool") : null]).then(([lamp, register, stool]) => {
    if (disposed) return;
    if (lamp) {
      fixMaterials(lamp, { shadow: false });
      lamp.traverse((o) => {
        if (o.isMesh && o.material?.emissive && o.material.emissiveMap) o.material.emissiveIntensity = Math.max(o.material.emissiveIntensity, 6);
      });
      const s = 0.78;
      for (const x of [caseMid - caseLen / 3, caseMid, caseMid + caseLen / 3]) {
        const l = lamp.clone();
        l.scale.setScalar(s);
        l.position.set(x, canopyY - 0.1, zc + 0.08);
        extra.add(l);
      }
    }
    if (register) {
      fixMaterials(register);
      register.scale.setScalar(0.8);
      register.position.set(caseX1 + 0.55, topY, C.z + 0.25);
      extra.add(register);
    }
    if (stool) {
      fixMaterials(stool);
      // a stand-up ledge on the south wall, east of the bar, with three stools
      const lx0 = X + HW + 1.4;
      const lx1 = Math.min(lx0 + 3.6, (W.PLANTERS || []).reduce((m, [px, pz]) => (Math.abs(pz - wallZ) < 2 && px > lx0 ? Math.min(m, px - 1.1) : m), lx0 + 3.6));
      const len = lx1 - lx0;
      if (len > 1.8) {
        const ledge = new THREE.Group();
        const top = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 0.4), mats.wood);
        top.position.set((lx0 + lx1) / 2 - X, 1.05, wallZ - 0.2);
        top.castShadow = top.receiveShadow = true;
        ledge.add(top);
        for (const fx of [lx0 + 0.25, lx1 - 0.25]) {
          const br = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.3, 0.36), mats.darkSteel);
          br.position.set(fx - X, 0.88, wallZ - 0.19);
          ledge.add(br);
        }
        extra.add(ledge);
        const count = Math.max(2, Math.min(3, Math.floor(len / 1.1)));
        for (let k = 0; k < count; k++) {
          const sx = lx0 + (len * (k + 0.5)) / count;
          const st = stool.clone();
          st.scale.setScalar(1.05);
          st.position.set(sx - X, 0, wallZ - 0.72);
          st.rotation.y = Math.PI + (k - 1) * 0.12;
          extra.add(st);
          if (OB) colliders.push({ id: `gelato:stool-${k + 1}`, x: sx, z: wallZ - 0.72, r: 0.28, minX: sx - 0.28, maxX: sx + 0.28, minZ: wallZ - 1.0, maxZ: wallZ - 0.44 });
        }
        if (OB) {
          const c = { id: "gelato:ledge", minX: lx0, maxX: lx1, minZ: wallZ - 0.42, maxZ: wallZ };
          colliders.push(c);
          OB.push(c);
          for (const s of colliders) if (s.id.startsWith("gelato:stool") && !OB.includes(s)) OB.push(s);
        }
      }
    }
    if (renderer) renderer.shadowMap.needsUpdate = true;
  });
  if (OB) for (const c of colliders) OB.push(c);

  /* ---------- distance culling ---------- */
  const centre = new THREE.Vector3(X, 1.5, C.z + 1);
  const prevHook = scene.onBeforeRender;
  const hook = function (rend, sc, cam, ...rest) {
    if (typeof prevHook === "function") prevHook.call(this, rend, sc, cam, ...rest);
    if (cam) root.visible = cam.position.distanceToSquared(centre) < 48 * 48;
  };
  scene.onBeforeRender = hook;
  if (renderer) renderer.shadowMap.needsUpdate = true;

  let disposed = false;
  const api = {
    group: root,
    stats,
    ready,
    /** Tub positions (x in world space) for anything that wants to point at a flavour. */
    tubs: tubs.map((t) => ({ ...t, x: t.x + X, z: deckZ })),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (scene.onBeforeRender === hook) scene.onBeforeRender = prevHook;
      for (const o of hidden) o.visible = true;
      if (OB) {
        for (const c of colliders) {
          const i = OB.indexOf(c);
          if (i >= 0) OB.splice(i, 1);
        }
      }
      root.removeFromParent();
      for (const g of owned.geos) g.dispose();
      for (const m of owned.mats) m.dispose();
      extra.traverse((o) => o.isMesh && o.geometry?.dispose());
      delete scene.userData.__gelateria;
    },
  };
  scene.userData.__gelateria = api;
  return api;
}

/* ------------------------------------------------------------------ */
/* order-panel swatches                                                  */
/* ------------------------------------------------------------------ */
const swatches = new Map();
let swatchKit = null;

/**
 * A small PNG data URL of one pan of `id` gelato (rendered once, offscreen,
 * then cached). Falls back to a flat 2D drawing without WebGL.
 */
export function flavourSwatchUrl(id, flavour = null, size = 128) {
  const f = flavour || GELATO_FLAVOURS.find((x) => x.id === id) || { id, name: id, color: 0xff9aa2 };
  const key = `${f.id}:${size}`;
  if (swatches.has(key)) return swatches.get(key);
  let url = null;
  try {
    if (!swatchKit) {
      const canvas = makeCanvas(size, size);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(size, size, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.0;
      const scene = new THREE.Scene();
      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      scene.environment = pmrem.fromScene(room, 0.03).texture;
      pmrem.dispose();
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(0.4, 1.2, 0.8);
      scene.add(key);
      const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 10);
      camera.position.set(0, 0.78, 0.86);
      camera.lookAt(0, 0.0, 0);
      const steel = new THREE.MeshStandardMaterial({ color: 0xc9ccd0, metalness: 1, roughness: 0.3 });
      swatchKit = { renderer, scene, camera, steel, canvas };
    }
    const { renderer, scene, camera, steel, canvas } = swatchKit;
    const group = new THREE.Group();
    const i = Math.max(0, GELATO_FLAVOURS.findIndex((x) => x.id === f.id));
    for (const p of tubParts(f, i % 5, steel)) {
      const m = new THREE.Mesh(p.geo, p.mat);
      m.applyMatrix4(p.matrix);
      group.add(m);
    }
    const tray = new THREE.Mesh(new THREE.BoxGeometry(PAN_W + 0.04, 0.02, PAN_D + 0.04), steel);
    tray.position.y = -0.012;
    group.add(tray);
    group.rotation.y = -0.35;
    scene.add(group);
    renderer.setClearColor(0x000000, 0);
    renderer.render(scene, camera);
    url = canvas.toDataURL("image/png");
    scene.remove(group);
    tray.geometry.dispose();
  } catch {
    url = null;
  }
  if (!url) {
    const c = makeCanvas(size, size);
    const ctx = c.getContext("2d");
    const base = TONE[f.id] ?? f.color;
    const g = ctx.createRadialGradient(size * 0.4, size * 0.35, size * 0.05, size / 2, size / 2, size * 0.5);
    g.addColorStop(0, `#${shadeHex(base, 0.35).getHexString()}`);
    g.addColorStop(1, `#${shadeHex(base, -0.25).getHexString()}`);
    ctx.fillStyle = "#b9bdc2";
    ctx.fillRect(size * 0.08, size * 0.2, size * 0.84, size * 0.6);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(size / 2, size / 2, size * 0.38, size * 0.24, 0, 0, Math.PI * 2);
    ctx.fill();
    url = c.toDataURL("image/png");
  }
  swatches.set(key, url);
  return url;
}

/** Free the offscreen swatch renderer (the data URLs stay cached). */
export function disposeSwatchRenderer() {
  if (!swatchKit) return;
  swatchKit.renderer.dispose();
  swatchKit.renderer.forceContextLoss?.();
  swatchKit = null;
}
