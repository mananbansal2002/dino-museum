/**
 * Hall themes: what makes each gallery read as its own room. lookdev.js
 * builds the shared architecture (wainscot, mouldings, pilasters, ceilings)
 * and asks this module, per hall, for
 *
 *   - the dado finish: oak panelling, painted panelling, veined limestone
 *     (the classical spaces) or bedded sandstone (the Triassic Hall's
 *     rock-layer band),
 *   - ashlar coursing on the stone halls, a fern-and-cycad frieze under the
 *     Jurassic cornice, fabric acoustic panels in the theatre,
 *   - framed period murals (Charles R. Knight's Field Museum paintings,
 *     public domain, see /images/murals/CREDITS.json) hung above the dado
 *     in the era halls. Their pictures stream in like the exhibit photos:
 *     only when the visitor is in the hall or next to it,
 *   - Petrified Forest photomurals (Chinle Formation, CC BY) in the Triassic Hall,
 *   - a brass title (hall name and era dates) over each hall's feature wall,
 *     from a 20 kB subset of Optimer Bold (/fonts/),
 *   - a slow water-caustic light drifting over the Marine Hall's ceiling
 *     and floor, and a per-hall tint for the roaming ceiling lights.
 *
 * Everything is batched: one instanced mesh or merged geometry per
 * material, and textures are at most 1024 px. Rooms marked `secret` are
 * never themed.
 *
 *   const themes = createHallThemes({ WORLD, lib, keep, pbr, tex, patchWorldUV, maxAniso });
 *   themes.dado(roomId)            // { kind, mat, trim } for the wainscot pass
 *   themes.pilasterHidden(x, z, s, alongX)
 *   themes.build(fx, wallFaces)    // murals, frieze, caustics (after the architecture)
 *   themes.update(dt, camera)      // every frame (no allocations)
 */
import * as THREE from "three";
import { FontLoader } from "three/addons/loaders/FontLoader.js";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const TITLE_FONT = "/fonts/optimer-bold-titles.typeface.json";
const TITLE_SIZE = 1.25; // em size of a title (caps are ~0.75 of it)

const MURAL_DIR = "/images/murals/";
/** Canvas band of every mural (m above the floor); its frame sits around it. */
const MURAL_Y0 = 3.7;
const MURAL_H = 5.0;
const FRAME_W = 0.22;

/**
 * side: the wall it hangs on (N = the wall at the hall's north edge, facing
 * +z, ...); at: its centre along that wall (x for N/S, z for E/W).
 * aspect = width / height of the image.
 */
export const MURALS = [
  // Triassic: Knight's Karoo scene, and the Chinle badlands of Petrified
  // Forest (Arizona) where much of the hall's fauna was dug up
  { room: "triassic", file: "triassic.jpg", side: "E", at: 27, aspect: 1024 / 771 },
  { room: "triassic", file: "triassic2.jpg", side: "W", at: -5.5, aspect: 1024 / 380 },
  { room: "triassic", file: "triassic3.jpg", side: "W", at: 29.5, aspect: 1024 / 413 },
  { room: "triassic", file: "triassic4.jpg", side: "S", at: -69, aspect: 1024 / 456 },
  { room: "jurassic", file: "jurassic.jpg", side: "S", at: 60.5, aspect: 1024 / 356 },
  { room: "jurassic", file: "jurassic2.jpg", side: "N", at: 75, aspect: 1024 / 785 },
  { room: "jurassic", file: "jurassic3.jpg", side: "W", at: 27, aspect: 1024 / 804 },
  { room: "jurassic", file: "jurassic5.jpg", side: "W", at: -9, aspect: 1024 / 685 },
  { room: "cretaceous", file: "cretaceous.jpg", side: "N", at: -79.5, aspect: 1024 / 352 },
  { room: "cretaceous", file: "cretaceous2.jpg", side: "N", at: -47.5, aspect: 1024 / 342 },
  { room: "cretaceous", file: "cretaceous3.jpg", side: "W", at: -63, aspect: 1024 / 695 },
  { room: "cretaceous", file: "cretaceous4.jpg", side: "E", at: -51, aspect: 1024 / 711 },
  { room: "cretaceous", file: "cretaceous5.jpg", side: "S", at: -60, aspect: 1024 / 712 },
  { room: "marine", file: "marine.jpg", side: "N", at: 48, aspect: 1024 / 349 },
  { room: "marine", file: "marine2.jpg", side: "N", at: 72, aspect: 1024 / 351 },
  { room: "marine", file: "marine3.jpg", side: "W", at: -51, aspect: 1024 / 717 },
  { room: "marine", file: "marine5.jpg", side: "S", at: 75, aspect: 738 / 1024 },
];

/**
 * Hall titles: brass letters on the wall facing the way most visitors come
 * in (in the era halls: over the era window). at = centre along that wall,
 * y = baseline of the title line.
 */
export const TITLES = [
  { room: "triassic", side: "W", at: 12, y: 7.15, text: "TRIASSIC", sub: "252 - 201 MILLION YEARS AGO" },
  { room: "jurassic", side: "S", at: 76, y: 7.15, text: "JURASSIC", sub: "201 - 145 MILLION YEARS AGO" },
  { room: "cretaceous", side: "N", at: -64, y: 7.15, text: "CRETACEOUS", sub: "145 - 66 MILLION YEARS AGO" },
  { room: "marine", side: "E", at: -70, y: 7.15, text: "MARINE REPTILES", sub: "MESOZOIC SEAS, 252 - 66 MILLION YEARS AGO" },
  { room: "rotunda", side: "N", at: 0, y: 10.6, text: "GRAND GALLERY", sub: "THE AGE OF DINOSAURS", size: 1.7 },
  { room: "predator", side: "W", at: -30, y: 6.2, text: "PREDATOR BAY", sub: "HUNTERS OF THE MESOZOIC" },
];

/**
 * dado: "wood" (the house oak) | "olive" (darker oak) | "painted" (painted
 * panelling, `tint`) | "limestone" | "strata"; ashlar: coursed stone up to
 * `top` m; frieze / acoustic / caustics as described above; light: tint of
 * the roaming ceiling lights while in the hall.
 */
export const HALL_THEMES = {
  triassic: { dado: "strata", light: 0xffdcb6 },
  jurassic: { dado: "olive", frieze: true, light: 0xfbe6c4 },
  cretaceous: { dado: "wood", light: 0xffdcbc },
  marine: { dado: "painted", tint: 0x4b5d63, caustics: true, light: 0xc9dcec },
  rotunda: { dado: "limestone", ashlar: { top: 5.2 } },
  lobby: { dado: "limestone", ashlar: { top: 4.6 } },
  porch: { dado: "limestone", ashlar: { top: 8.2 } },
  theater: { acoustic: true },
};

/* ------------------------------------------------------------------ */
/* procedural textures (drawn once, ≤ 512 px)                           */
/* ------------------------------------------------------------------ */
function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Bedded sandstone and mudstone in Chinle / Karoo colours: beds of uneven
 * thickness with soft contacts, fine laminae and a little grain. The canvas
 * spans one dado height (1.2 m) and tiles sideways.
 */
function strataTexture() {
  const W = 512;
  const H = 512;
  const c = canvas(W, H);
  const ctx = c.getContext("2d");
  const rand = rng(1871);
  // close values: weathered red-brown mudstone, buff and grey-violet sandstone
  const palette = ["#8f6a52", "#a5835f", "#83604f", "#9c8a76", "#8a6e60", "#ab8f6b", "#927460"];
  let y = 0;
  let k = 0;
  while (y < H) {
    const t = 22 + rand() * 64;
    const col = palette[(k * 3 + Math.floor(rand() * 2)) % palette.length];
    ctx.fillStyle = col;
    ctx.fillRect(0, y, W, t + 2);
    // laminae, some of them cross-bedded (inclined sets inside the bed)
    const cross = rand() < 0.4;
    const n = Math.floor(t / 6);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, y, W, t);
    ctx.clip();
    for (let i = 0; i < n * (cross ? 3 : 1); i++) {
      ctx.strokeStyle = `rgba(${rand() < 0.5 ? "50,30,20" : "250,236,214"},${0.035 + rand() * 0.045})`;
      ctx.lineWidth = 1 + rand();
      ctx.beginPath();
      if (cross) {
        // tileable: sets repeat every W / 2
        const x0 = ((i * 23) % (W / 2)) * 2 - W / 2;
        ctx.moveTo(x0, y + t);
        ctx.quadraticCurveTo(x0 + 70, y + t * 0.4, x0 + 220, y);
      } else {
        const ly = y + ((i + 0.5) / n) * t;
        ctx.moveTo(0, ly);
        for (let x = 0; x <= W; x += 32) ctx.lineTo(x, ly + Math.sin((x / W) * Math.PI * 4 + i) * 1.4);
      }
      ctx.stroke();
    }
    ctx.restore();
    // bedding contact: a soft recessed seam
    const g = ctx.createLinearGradient(0, y - 4, 0, y + 5);
    g.addColorStop(0, "rgba(30,18,12,0)");
    g.addColorStop(0.5, "rgba(30,18,12,0.22)");
    g.addColorStop(1, "rgba(30,18,12,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, y - 4, W, 9);
    y += t;
    k++;
  }
  // weathering: broad soft stains (wrapped sideways so the tile repeats)
  for (let i = 0; i < 26; i++) {
    const x = rand() * W;
    const yy = rand() * H;
    const r = 30 + rand() * 90;
    const dark = rand() < 0.55;
    for (const ox of [-W, 0, W]) {
      const g = ctx.createRadialGradient(x + ox, yy, 0, x + ox, yy, r);
      g.addColorStop(0, dark ? "rgba(40,26,18,0.09)" : "rgba(255,240,220,0.07)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x + ox - r, yy - r, r * 2, r * 2);
    }
  }
  // stone grain: tileable value noise at three scales, plus speckle
  const lattice = (cells) => {
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = rand() - 0.5;
    return (x, y) => {
      const fx = (x / W) * cells;
      const fy = (y / H) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const at = (i, j) => g[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
  };
  const n1 = lattice(64);
  const n2 = lattice(16);
  const n3 = lattice(128);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const px = (i / 4) % W;
    const py = Math.floor(i / 4 / W);
    // grains are stretched along the bedding
    const n = (rand() - 0.5) * 18 + n3(px, py * 2.2) * 30 + n1(px, py * 1.6) * 34 + n2(px, py) * 26;
    d[i] += n;
    d[i + 1] += n * 0.95;
    d[i + 2] += n * 0.9;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Draws one fern frond along a curved rachis. */
function frond(ctx, x, y, len, ang, curl, lean) {
  const steps = 18;
  let px = x;
  let py = y;
  let a = ang;
  const seg = len / steps;
  ctx.beginPath();
  ctx.moveTo(px, py);
  const pts = [];
  for (let i = 0; i < steps; i++) {
    a += curl;
    px += Math.cos(a) * seg;
    py += Math.sin(a) * seg;
    ctx.lineTo(px, py);
    pts.push([px, py, a, i / steps]);
  }
  ctx.stroke();
  for (const [qx, qy, qa, t] of pts) {
    const l = len * 0.2 * (1 - t) * (0.6 + 0.4 * Math.sin(t * Math.PI));
    for (const side of [-1, 1]) {
      const pa = qa + side * (1.05 + lean * side);
      ctx.beginPath();
      ctx.ellipse(qx + Math.cos(pa) * l * 0.5, qy + Math.sin(pa) * l * 0.5, l * 0.5, l * 0.17, pa, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * Tone-on-tone frieze tile: a cycad crown between arching tree-fern fronds,
 * in the manner of the cast-plaster friezes of 1900s natural-history halls.
 * Drawn light on the panel colour with a cast shadow so it reads as relief.
 */
function fernFriezeTexture(ground, relief) {
  const W = 512;
  const H = 128;
  const c = canvas(W, H);
  const ctx = c.getContext("2d");
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, W, H);
  const draw = (color, dx, dy) => {
    ctx.save();
    ctx.translate(dx, dy);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    // a running scroll: long fern fronds arching alternately up and down
    // from a wavy stem, each ending in a curled fiddlehead (drawn at
    // x - W, x and x + W so the tile repeats seamlessly)
    for (const ox of [-W, 0, W]) {
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      for (let x = 0; x <= W; x += 8) {
        const y = H / 2 + Math.sin((x / W) * Math.PI * 4) * 16;
        if (x === 0) ctx.moveTo(ox + x, y);
        else ctx.lineTo(ox + x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 2.4;
      for (let k = 0; k < 4; k++) {
        const x = ox + (k + 0.25) * (W / 4);
        const up = k % 2 === 0;
        const y = H / 2 + Math.sin((((k + 0.25) * (W / 4)) / W) * Math.PI * 4) * 16;
        // frond: rachis bending forward, pinnae shortening to the tip
        frond(ctx, x, y, 128, up ? -0.9 : 0.9, up ? 0.055 : -0.055, 0.15);
        // fiddlehead: a small spiral sprouting the other way
        ctx.beginPath();
        let a = up ? 2.3 : -2.3;
        let r = 15;
        let px = x - 6;
        let py = y + (up ? 6 : -6);
        ctx.moveTo(px, py);
        for (let i = 0; i < 26; i++) {
          a += up ? 0.32 : -0.32;
          r *= 0.93;
          px += Math.cos(a) * r * 0.34;
          py += Math.sin(a) * r * 0.34;
          ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  };
  draw("rgba(20,26,18,0.5)", 2, 2.5); // cast shadow
  draw(relief, 0, 0);
  // fillet lines above and below the band
  ctx.fillStyle = "rgba(255,250,235,0.35)";
  ctx.fillRect(0, 3, W, 2);
  ctx.fillRect(0, H - 6, W, 2);
  ctx.fillStyle = "rgba(10,14,10,0.35)";
  ctx.fillRect(0, 5, W, 1);
  ctx.fillRect(0, H - 4, W, 1);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * Tileable water caustics (256 px): the bright network along the edges of
 * Worley cells, softened, as a sunlit sea throws on a pool floor.
 */
function causticTexture() {
  const N = 256;
  const c = canvas(N, N);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(N, N);
  const rand = rng(4242);
  const G = 6; // feature points on a G x G grid, wrapped
  const pts = [];
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) pts.push([(i + 0.15 + rand() * 0.7) / G, (j + 0.15 + rand() * 0.7) / G]);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      // warp a little so cell edges wobble like refracted light
      const wu = u + 0.018 * Math.sin(v * Math.PI * 2 * 3 + 1.3);
      const wv = v + 0.018 * Math.sin(u * Math.PI * 2 * 2 + 0.4);
      let f1 = 9;
      let f2 = 9;
      for (const [px, py] of pts) {
        let dx = Math.abs(wu - px);
        let dy = Math.abs(wv - py);
        dx = Math.min(dx, 1 - dx);
        dy = Math.min(dy, 1 - dy);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) {
          f2 = f1;
          f1 = d;
        } else if (d < f2) f2 = d;
      }
      const e = (f2 - f1) * G; // 0 on an edge
      // a thin bright filament with a faint glow around it
      // dappled: brighter and dimmer patches, as under a moving surface
      const dap = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(u * Math.PI * 4 + 0.7) * Math.cos(v * Math.PI * 2 + 1.9));
      const b = dap * (Math.pow(Math.max(0, 1 - e * 7), 4) * 0.9 + Math.pow(Math.max(0, 1 - e * 2.5), 3) * 0.1);
      const o = (y * N + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.round(b * 255);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // soften (wrapped, so the tile still repeats)
  const soft = canvas(N, N);
  const sctx = soft.getContext("2d");
  sctx.filter = "blur(1.2px)";
  for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) sctx.drawImage(c, ox, oy);
  const t = new THREE.CanvasTexture(soft);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* ------------------------------------------------------------------ */
/* the themes                                                           */
/* ------------------------------------------------------------------ */
export function createHallThemes({ WORLD, lib, keep, pbr, tex, patchWorldUV, maxAniso = 4 }) {
  const ROOMS = Array.isArray(WORLD.ROOMS) ? WORLD.ROOMS : [];
  const byId = new Map(ROOMS.map((r) => [r.id, r]));
  const theme = (id) => {
    const r = byId.get(id);
    return r && !r.secret ? HALL_THEMES[id] || null : null;
  };
  const C = WORLD.CELL;
  const bounds = (r) => ({
    x0: WORLD.g2w(r.cols[0]) - C / 2,
    x1: WORLD.g2w(r.cols[1]) + C / 2,
    z0: WORLD.g2z(r.rows[0]) - C / 2,
    z1: WORLD.g2z(r.rows[1]) + C / 2,
  });

  /* ---------------- dado materials ---------------- */
  const mats = {};
  mats.olive = keep(patchWorldUV(pbr("wood", { color: 0x8a7f62, roughness: 0.55, envMapIntensity: 0.8 }), 1.6, { macro: 0.05 }), "wood");
  mats.limestone = keep(
    patchWorldUV(pbr("stone_floor", { color: 0xe2d6bf, roughness: 0.62, envMapIntensity: 0.45 }, { normalScale: 0.4 }), 2.6, {
      macro: 0.06,
      gain: 1.05,
    }),
    "wall"
  );
  mats.limestoneTrim = keep(
    patchWorldUV(pbr("stone_floor", { color: 0xcdbd9f, roughness: 0.55, envMapIntensity: 0.5 }, { normalScale: 0.3 }), 2.6, { macro: 0.05 }),
    "wall"
  );
  const strataMap = strataTexture();
  strataMap.anisotropy = maxAniso;
  mats.strata = keep(
    patchWorldUV(
      new THREE.MeshStandardMaterial({
        map: strataMap,
        normalMap: tex("plinth", "nor"),
        roughness: 0.92,
        envMapIntensity: 0.3,
      }),
      1.2,
      { macro: 0.08, baseDarken: 0.1, gain: 1.25 }
    ),
    "wall"
  );
  mats.strata.normalScale.set(0.9, 0.9);
  mats.strataTrim = keep(
    patchWorldUV(pbr("plinth", { color: 0xa88a70, roughness: 0.8, envMapIntensity: 0.4 }), 2.5, { macro: 0.08 }),
    "plinth"
  );
  const painted = new Map();
  function paintedPanel(tint) {
    if (painted.has(tint)) return painted.get(tint);
    const m = keep(
      patchWorldUV(pbr("plaster", { color: tint, roughness: 0.6, envMapIntensity: 0.6 }, { normalScale: 0.2 }), 3.2, { macro: 0.03, gain: 1.6 }),
      "wood"
    );
    painted.set(tint, m);
    return m;
  }
  mats.acoustic = keep(
    patchWorldUV(pbr("plaster", { color: 0x6a5659, roughness: 1, envMapIntensity: 0.1 }, { rough: false, normalScale: 0.6 }), 0.9, {
      macro: 0.04,
      gain: 1.4,
    }),
    "fabric"
  );
  mats.acousticFrame = keep(new THREE.MeshStandardMaterial({ color: 0x241d1c, roughness: 0.75, metalness: 0, envMapIntensity: 0.3 }), "wood");

  /** { kind, mat, trim, fields } for the wainscot of a room (null = the house default). */
  function dado(roomId) {
    const t = theme(roomId);
    if (!t || !t.dado || t.dado === "wood") return null;
    if (t.dado === "olive") return { kind: "wood", mat: mats.olive, trim: mats.olive, fields: true };
    if (t.dado === "painted") {
      const m = paintedPanel(t.tint || 0x666666);
      return { kind: "wood", mat: m, trim: m, fields: true };
    }
    if (t.dado === "limestone") return { kind: "stone", mat: mats.limestone, trim: mats.limestoneTrim, fields: false };
    if (t.dado === "strata") return { kind: "stone", mat: mats.strata, trim: mats.strataTrim, fields: false };
    return null;
  }

  /* ---------------- murals: placement ---------------- */
  const murals = [];
  for (const m of MURALS) {
    const r = byId.get(m.room);
    if (!r || r.secret) continue;
    const b = bounds(r);
    const alongX = m.side === "N" || m.side === "S";
    const s = m.side === "N" || m.side === "W" ? 1 : -1; // into the room
    const face = m.side === "N" ? b.z0 : m.side === "S" ? b.z1 : m.side === "W" ? b.x0 : b.x1;
    const mh = m.h || MURAL_H;
    const w = mh * m.aspect;
    murals.push({
      ...m,
      alongX,
      s,
      face: face + s * 0.2, // the slab is 0.4 thick
      w,
      h: mh,
      y0: m.y0 ?? MURAL_Y0,
      a0: m.at - w / 2,
      a1: m.at + w / 2,
      mesh: null,
      mat: null,
      state: "none", // none | loading | ready
      tex: null,
    });
  }

  /** Is the pilaster at (x, z) on this face behind a mural (it would cut through the frame)? */
  /* ---------------- titles: placement ---------------- */
  const titles = [];
  for (const t of TITLES) {
    const r = byId.get(t.room);
    if (!r || r.secret) continue;
    const b = bounds(r);
    const alongX = t.side === "N" || t.side === "S";
    const s = t.side === "N" || t.side === "W" ? 1 : -1;
    const face = (t.side === "N" ? b.z0 : t.side === "S" ? b.z1 : t.side === "W" ? b.x0 : b.x1) + s * 0.2;
    const size = t.size || TITLE_SIZE;
    // Optimer caps average ~0.78 em wide plus tracking: a safe estimate for
    // clearing the pilasters before the font has loaded
    const half = Math.max(t.text.length * size * 0.86, t.sub.length * size * 0.3 * 0.86) / 2;
    titles.push({ ...t, alongX, s, face, size, a0: t.at - half, a1: t.at + half });
  }

  function pilasterHidden(x, z, s, alongX) {
    for (const m of titles) {
      if (m.alongX !== alongX || m.s !== s) continue;
      if (Math.abs((alongX ? z : x) - m.face) > 0.5) continue;
      const a = alongX ? x : z;
      if (a > m.a0 - 0.6 && a < m.a1 + 0.6) return true;
    }
    for (const m of murals) {
      if (m.alongX !== alongX || m.s !== s) continue;
      const across = alongX ? z : x;
      if (Math.abs(across - m.face) > 0.5) continue;
      const a = alongX ? x : z;
      if (a > m.a0 - FRAME_W - 0.7 && a < m.a1 + FRAME_W + 0.7) return true;
    }
    return false;
  }

  /* ---------------- build ---------------- */
  const animated = [];
  function quad(geos, alongX, s, face, a, along, y, h, out, u0, u1, v0, v1) {
    const g = new THREE.PlaneGeometry(along, h);
    const uv = g.attributes.uv;
    // PlaneGeometry uv: (0,1) (1,1) (0,0) (1,0)
    uv.setXY(0, u0, v1);
    uv.setXY(1, u1, v1);
    uv.setXY(2, u0, v0);
    uv.setXY(3, u1, v0);
    // the plane faces +z; turn it to face into the room
    const ry = alongX ? (s > 0 ? 0 : Math.PI) : s > 0 ? Math.PI / 2 : -Math.PI / 2;
    g.rotateY(ry);
    g.translate(alongX ? a : face + s * out, y, alongX ? face + s * out : a);
    geos.push(g);
  }

  function merged(geos, mat, name) {
    if (!geos.length) return null;
    const g = mergeAll(geos);
    const m = new THREE.Mesh(g, mat);
    m.name = name;
    m.userData.lkDone = true;
    m.receiveShadow = true;
    return m;
  }

  /**
   * fx: the lookdev group; faces: every wall face the architecture pass
   * visited: { room, alongX, s, fx0, fz0, x, z, L, h }; batch(mat, name): a
   * box batch.
   */
  function build(fx, faces, batch) {
    // murals: canvas + frame + a brass picture light over each
    const frame = batch(lib.wood, "halls-mural-frames");
    const fillet = batch(lib.brass, "halls-mural-fillets");
    for (const m of murals) {
      m.mat = new THREE.MeshStandardMaterial({
        color: 0x5d564b,
        roughness: 0.86,
        metalness: 0,
        envMapIntensity: 0.15,
        emissive: 0x000000,
        emissiveIntensity: 0.4,
      });
      m.mat.userData.lkEnv = 0.15;
      const geos = [];
      quad(geos, m.alongX, m.s, m.face, m.at, m.w, m.y0 + m.h / 2, m.h, 0.07, 0, 1, 0, 1);
      m.mesh = new THREE.Mesh(geos[0], m.mat);
      m.mesh.name = `halls-mural-${m.file}`;
      m.mesh.userData.lkDone = true;
      fx.add(m.mesh);
      const put = (b, a, y, out, along, h, depth) => {
        const cx = m.alongX ? a : m.face + m.s * out;
        const cz = m.alongX ? m.face + m.s * out : a;
        b.add(cx, y, cz, m.alongX ? along : depth, h, m.alongX ? depth : along);
      };
      const y0 = m.y0;
      const y1 = m.y0 + m.h;
      const fw = FRAME_W;
      // moulded frame: a deep outer member and a gilt fillet at the sight edge
      put(frame, m.at, y0 - fw / 2, 0.08, m.w + fw * 2, fw, 0.16);
      put(frame, m.at, y1 + fw / 2, 0.08, m.w + fw * 2, fw, 0.16);
      put(frame, m.a0 - fw / 2, (y0 + y1) / 2, 0.08, fw, m.h, 0.16);
      put(frame, m.a1 + fw / 2, (y0 + y1) / 2, 0.08, fw, m.h, 0.16);
      put(fillet, m.at, y0 + 0.02, 0.1, m.w + 0.02, 0.04, 0.05);
      put(fillet, m.at, y1 - 0.02, 0.1, m.w + 0.02, 0.04, 0.05);
      put(fillet, m.a0 + 0.02, (y0 + y1) / 2, 0.1, 0.04, m.h, 0.05);
      put(fillet, m.a1 - 0.02, (y0 + y1) / 2, 0.1, 0.04, m.h, 0.05);
    }

    // per-face details
    const frieze = new Map(); // room -> quads
    const joints = new Map(); // room -> box batch
    const course = batch(mats.limestoneTrim, "halls-string-course");
    const stoneJoints = batch(keep(new THREE.MeshStandardMaterial({ color: 0x6d5444, roughness: 1, envMapIntensity: 0.1 }), "wall"), "halls-strata-joints");
    const limeJoints = batch(keep(new THREE.MeshStandardMaterial({ color: 0x9c8e76, roughness: 1, envMapIntensity: 0.1 }), "wall"), "halls-lime-joints");
    const acoustic = batch(mats.acoustic, "halls-acoustic");
    const acousticFrame = batch(mats.acousticFrame, "halls-acoustic-frame");
    const FRIEZE_H = 0.5;
    for (const f of faces) {
      const t = theme(f.room.id);
      if (!t) continue;
      const put = (b, a, y, out, along, height, depth) => {
        const cx = f.alongX ? f.fx0 + a : f.fx0 + f.s * out;
        const cz = f.alongX ? f.fz0 + f.s * out : f.fz0 + a;
        b.add(cx, y, cz, f.alongX ? along : depth, height, f.alongX ? depth : along);
      };
      const mid = f.alongX ? f.x : f.z;
      const face = f.alongX ? f.fz0 : f.fx0;
      if (t.frieze) {
        // a band under the cornice, running in world space so tiles meet across slabs
        const y0 = f.h - 1.0; // between the mural frames and the cornice
        const tile = FRIEZE_H * 4; // the tile is 4:1
        const a0 = mid - f.L / 2;
        const a1 = mid + f.L / 2;
        if (!frieze.has(f.room.id)) frieze.set(f.room.id, []);
        // the plane's +u runs along world +x / +z on some walls and against it on others
        const flip = (f.alongX && f.s < 0) || (!f.alongX && f.s > 0);
        const u0 = flip ? -a1 / tile : a0 / tile;
        const u1 = flip ? -a0 / tile : a1 / tile;
        quad(frieze.get(f.room.id), f.alongX, f.s, face, mid, f.L, y0 + FRIEZE_H / 2, FRIEZE_H, 0.012, u0, u1, 0, 1);
      }
      if (t.dado === "strata" || t.dado === "limestone") {
        // the stone dado is laid in blocks: head joints on a 1.5 m module
        const jb = t.dado === "strata" ? stoneJoints : limeJoints;
        const a0 = mid - f.L / 2;
        const a1 = mid + f.L / 2;
        for (let a = Math.ceil(a0 / 1.5) * 1.5; a < a1 - 0.05; a += 1.5) {
          if (a < a0 + 0.05) continue;
          put(jb, a - mid, 0.6, 0.046, 0.014, 0.84, 0.006);
        }
      }
      if (t.ashlar) {
        if (!joints.has(f.room.id)) {
          const paint = new THREE.Color(f.paint).multiplyScalar(0.74);
          const jm = keep(new THREE.MeshStandardMaterial({ color: paint, roughness: 1, envMapIntensity: 0.2 }), "wall");
          joints.set(f.room.id, batch(jm, `halls-ashlar-${f.room.id}`));
        }
        const jb = joints.get(f.room.id);
        const top = Math.min(t.ashlar.top, f.h - 0.8);
        const COURSE = 0.6;
        const BLOCK = 1.5;
        const start = 1.25;
        let row = 0;
        for (let y = start + COURSE; y < top - 0.2; y += COURSE, row++) {
          put(jb, 0, y, 0.004, f.L, 0.025, 0.012);
        }
        // staggered head joints, placed in world space so they line up across slabs
        const a0 = mid - f.L / 2;
        const a1 = mid + f.L / 2;
        row = 0;
        for (let y = start; y < top - 0.25; y += COURSE, row++) {
          const h = Math.min(COURSE, top - y);
          const off = row % 2 ? BLOCK / 2 : 0;
          for (let a = Math.ceil((a0 - off) / BLOCK) * BLOCK + off; a < a1 - 0.05; a += BLOCK) {
            if (a < a0 + 0.05) continue;
            put(jb, a - mid, y + h / 2, 0.004, 0.025, h, 0.012);
          }
        }
        // a projecting string course caps the coursed stone
        if (top < f.h - 1) {
          put(course, 0, top + 0.08, 0.06, f.L + 0.02, 0.16, 0.12);
          put(course, 0, top - 0.02, 0.03, f.L + 0.02, 0.05, 0.06);
        }
      }
      if (t.acoustic) {
        // fabric-wrapped absorber panels in slim black frames, two tiers,
        // on the side and back walls (the screen wall keeps its drapes)
        const screenWall = f.alongX && f.s > 0 && Math.abs(f.fz0 - (WORLD.SCREEN ? WORLD.SCREEN.z - 0.9 + 0.2 : -9e9)) < 1.5;
        if (screenWall) continue;
        const n = Math.max(1, Math.round(f.L / 1.5));
        const pw = f.L / n;
        const tiers = [
          [0.55, 4.6],
          [4.75, f.h - 1.6],
        ];
        for (let i = 0; i < n; i++) {
          const a = -f.L / 2 + pw * (i + 0.5);
          for (const [y0, y1] of tiers) {
            put(acousticFrame, a, (y0 + y1) / 2, 0.035, pw - 0.04, y1 - y0, 0.07);
            put(acoustic, a, (y0 + y1) / 2, 0.075, pw - 0.12, y1 - y0 - 0.08, 0.03);
          }
        }
        put(acousticFrame, 0, 0.28, 0.04, f.L, 0.56, 0.08); // skirting
      }
    }
    for (const [id, geos] of frieze) {
      const r = byId.get(id);
      const p = new THREE.Color(r ? paintOf(id, r) : 0x56705a);
      const ground = `#${p.clone().multiplyScalar(0.92).getHexString()}`;
      const relief = `#${p.clone().lerp(new THREE.Color(0xe8e2cc), 0.3).getHexString()}`;
      const map = fernFriezeTexture(ground, relief);
      map.anisotropy = maxAniso;
      const mat = keep(new THREE.MeshStandardMaterial({ map, roughness: 0.85, envMapIntensity: 0.35 }), "wall");
      const mesh = merged(geos, mat, `halls-frieze-${id}`);
      if (mesh) fx.add(mesh);
    }
    buildTitles(fx);
    for (const b of [frame, fillet, course, acoustic, acousticFrame, stoneJoints, limeJoints, ...joints.values()]) {
      const mesh = b.build();
      if (mesh) fx.add(mesh);
    }

    // marine caustics: two drifting layers on the ceiling, one on the floor
    for (const r of ROOMS) {
      const t = theme(r.id);
      if (!t || !t.caustics) continue;
      const bb = bounds(r);
      const W = bb.x1 - bb.x0;
      const D = bb.z1 - bb.z0;
      const base = causticTexture();
      const layers = [
        { y: r.h - 0.02, up: false, rep: 4.6, color: 0x6fb6d8, opacity: 0.1, vx: 0.022, vz: 0.013 },
        { y: r.h - 0.025, up: false, rep: 2.4, color: 0x4f97c0, opacity: 0.075, vx: -0.016, vz: 0.019 },
        { y: 0.018, up: true, rep: 3.6, color: 0x5aa6cc, opacity: 0.045, vx: 0.006, vz: -0.009 },
      ];
      for (const l of layers) {
        const map = base.clone();
        map.repeat.set(W / l.rep, D / l.rep);
        const mat = new THREE.MeshBasicMaterial({
          map,
          color: l.color,
          transparent: true,
          opacity: l.opacity,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(W, D), mat);
        mesh.rotation.x = l.up ? -Math.PI / 2 : Math.PI / 2;
        mesh.position.set((bb.x0 + bb.x1) / 2, l.y, (bb.z0 + bb.z1) / 2);
        mesh.userData.lkDone = true;
        mesh.renderOrder = 8;
        fx.add(mesh);
        animated.push({ map, vx: l.vx, vz: l.vz });
      }
    }
  }

  /**
   * Brass letters standing off the wall, every title in one merged mesh.
   * The font (a 20 kB subset) is fetched once; until it arrives the walls
   * are simply bare.
   */
  const letterMat = keep(
    new THREE.MeshStandardMaterial({ color: 0xc9a262, metalness: 0.7, roughness: 0.3, envMapIntensity: 1.1, emissive: 0x24180a }),
    "metal"
  );
  function buildTitles(fx) {
    if (!titles.length || typeof fetch !== "function") return;
    new FontLoader().load(
      TITLE_FONT,
      (font) => {
        const geos = [];
        const add = (text, size, depth, y, t) => {
          const g = new TextGeometry(text, {
            font,
            size,
            height: depth,
            curveSegments: 5,
            bevelEnabled: true,
            bevelThickness: depth * 0.25,
            bevelSize: size * 0.012,
            bevelSegments: 1,
          });
          g.computeBoundingBox();
          const bb = g.boundingBox;
          g.translate(-(bb.min.x + bb.max.x) / 2, 0, 0);
          const ry = t.alongX ? (t.s > 0 ? 0 : Math.PI) : t.s > 0 ? Math.PI / 2 : -Math.PI / 2;
          g.rotateY(ry);
          const out = 0.04; // stand-off pins
          g.translate(t.alongX ? t.at : t.face + t.s * out, y, t.alongX ? t.face + t.s * out : t.at);
          geos.push(g.index ? g.toNonIndexed() : g);
        };
        for (const t of titles) {
          add(t.text, t.size, 0.07, t.y, t);
          add(t.sub, t.size * 0.27, 0.035, t.y - t.size * 0.62, t);
        }
        const merged = mergeGeometries(geos, false);
        for (const g of geos) g.dispose();
        if (!merged) return;
        const mesh = new THREE.Mesh(merged, letterMat);
        mesh.name = "halls-titles";
        mesh.userData.lkDone = true;
        mesh.castShadow = false;
        fx.add(mesh);
      },
      undefined,
      () => {
        /* no titles: the walls stay bare */
      }
    );
  }

  let paintOf = (id, r) => r.wall;
  function setPaint(fn) {
    paintOf = fn;
  }

  /* ---------------- per-hall light tint ---------------- */
  const tints = new Map();
  for (const [id, t] of Object.entries(HALL_THEMES)) if (t.light && !(byId.get(id) || {}).secret) tints.set(id, new THREE.Color(t.light));
  /** Colour of a roaming ceiling light in this room (null = the house warm white). */
  const lightTint = (roomId) => tints.get(roomId) || null;

  /* ---------------- mural streaming ---------------- */
  const bitmaps =
    typeof createImageBitmap === "function" && typeof THREE.ImageBitmapLoader === "function"
      ? new THREE.ImageBitmapLoader().setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" })
      : null;
  const texLoader = new THREE.TextureLoader();
  const wanted = new Set();
  let lastRoom;
  let timer = 0;
  function show(m, t) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAniso;
    t.needsUpdate = true;
    m.tex = t;
    m.mat.map = t;
    m.mat.emissiveMap = t;
    m.mat.color.set(0xffffff);
    m.mat.emissive.set(0xffffff);
    m.mat.needsUpdate = true;
    m.state = "ready";
  }
  function load(m) {
    m.state = "loading";
    const url = MURAL_DIR + m.file;
    const done = (t) => {
      if (m.state !== "loading") {
        t.dispose();
        t.image?.close?.();
        return;
      }
      show(m, t);
    };
    const fail = () => {
      if (m.state === "loading") m.state = "failed"; // the canvas stays a plain ground
    };
    if (bitmaps) {
      bitmaps.load(
        url,
        (bmp) => {
          const t = new THREE.Texture(bmp);
          t.flipY = false;
          done(t);
        },
        undefined,
        fail
      );
    } else texLoader.load(url, done, undefined, fail);
  }
  function unload(m) {
    if (m.state === "loading") {
      m.state = "none";
      return;
    }
    if (m.state !== "ready") return;
    m.mat.map = null;
    m.mat.emissiveMap = null;
    m.mat.color.set(0x5d564b);
    m.mat.emissive.set(0x000000);
    m.mat.needsUpdate = true;
    m.tex.dispose();
    m.tex.image?.close?.();
    m.tex = null;
    m.state = "none";
  }
  function update(dt, camera) {
    for (let i = 0; i < animated.length; i++) {
      const a = animated[i];
      a.map.offset.x = (a.map.offset.x + a.vx * dt) % 1;
      a.map.offset.y = (a.map.offset.y + a.vz * dt) % 1;
    }
    timer -= dt;
    if (timer > 0 || !murals.length) return;
    timer = 0.5;
    const p = camera.position;
    const room = WORLD.roomAt ? WORLD.roomAt(p.x, p.z) : null;
    const id = room ? room.id : null;
    if (id !== lastRoom) {
      // the hall you are in, the ones a doorway away, and halls beyond a corridor
      lastRoom = id;
      wanted.clear();
      if (id) {
        wanted.add(id);
        const near = WORLD.roomNeighbours ? WORLD.roomNeighbours(id) : [];
        for (const n of near) {
          wanted.add(n);
          const nr = byId.get(n);
          if (nr && nr.h <= 6 && WORLD.roomNeighbours) for (const m of WORLD.roomNeighbours(n)) wanted.add(m);
        }
      }
    }
    for (const m of murals) {
      const want = wanted.has(m.room);
      if (want && m.state === "none") load(m);
      else if (!want && (m.state === "ready" || m.state === "loading")) {
        const d = Math.hypot((m.alongX ? m.at : m.face) - p.x, (m.alongX ? m.face : m.at) - p.z);
        if (d > 90) unload(m);
      }
    }
  }

  return {
    dado,
    pilasterHidden,
    build,
    update,
    lightTint,
    setPaint,
    murals,
    /** Load every mural now (screenshots / tests). */
    loadAll() {
      for (const m of murals) if (m.state === "none") load(m);
    },
    stats: () => ({ murals: murals.length, ready: murals.filter((m) => m.state === "ready").length }),
  };
}

/** Merge non-indexed-compatible plane geometries (all indexed, same attributes). */
function mergeAll(geos) {
  let vCount = 0;
  let iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let v = 0;
  let i = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, v * 3);
    nor.set(g.attributes.normal.array, v * 3);
    uv.set(g.attributes.uv.array, v * 2);
    const gi = g.index.array;
    for (let k = 0; k < gi.length; k++) idx[i + k] = gi[k] + v;
    v += g.attributes.position.count;
    i += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}
