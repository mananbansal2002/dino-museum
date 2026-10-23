import * as THREE from "three";
import { ROOMS, BENCHES, g2w, g2z, CELL, roomAt, roomNeighbours, passable } from "./world.js";
import { shaderChunks } from "./extinction-shaders.js";

/**
 * The Extinction Room: an immersive projection gallery off the south end of
 * the Triassic Hall. Every wall and the floor are projection surfaces drawn
 * by two shared ShaderMaterials (no images, no video: everything is
 * procedural, see extinction-shaders.js), telling the last day of the Late
 * Cretaceous in one 84 s loop:
 *
 *    0- 18 s  calm Hell Creek landscape at golden hour (herds, pterosaurs)
 *   18- 31 s  a bright point in the sky grows into a bolide streak
 *   31     s  impact: whiteout flash, a glowing plume rises on the horizon
 *   33- 50 s  ejecta re-entering, a firestorm sweeps around all four walls
 *   45- 50 s  the blast front ripples across the floor (and shakes the camera)
 *   50- 66 s  falling ash and darkness
 *   66- 84 s  a cold first light, ferns return, a small mammal: the survivors
 *
 * Timing is local to each visitor: walking in starts the show, staying loops
 * it, leaving for a while and coming back starts it again. Nothing is built
 * until a visitor is in (or next to) the room, and nothing is updated while
 * they are elsewhere. Sound comes from audio.layer()/audio.impact() (gated by
 * the "ambience" sound channel, master volume and mute); the camera shake is
 * skipped under reduced motion.
 *
 *   const show = createExtinctionRoom({ scene, camera, renderer, audio, quality });
 *   show.update(dt, playerState)        // every frame (cheap when far away)
 *   show.seek(t) / show.time / show.inside / show.dispose()
 */

const ROOM_ID = "extinction";
const T_TOTAL = 84;
const T_ENTER = 3; // a fresh visit starts on the calm landscape, already faded in
const RESTART_AFTER = 6; // seconds away before re-entering restarts the show
const INSET = 0.32; // projection surfaces stand this far in front of the walls (clear of the pilasters)
const PH = 7.2; // projection height (a black ceiling closes the room above)
const H0 = 2.45; // horizon height on the walls
const S_IMP = 3; // where the impact happens, metres along the perimeter (south wall)
const FIRE_SPEED = 4.4; // m/s the firestorm runs around the walls
const T_IMPACT = 31;
const SHOCK_START = 45.5;
const SHOCK_SPEED = 7;
const SHOCK_R0 = 36;
const SHOCK_BACK = 40; // the blast front's centre lies this far beyond the south wall

/* ------------------------------------------------------------------ */
/* colour keyframes: [t, sky top, sky horizon, land light, haze]        */
/* ------------------------------------------------------------------ */
const KEYS = [
  [0, [0.13, 0.26, 0.5], [1.0, 0.7, 0.45], [0.95, 0.82, 0.62], [0.5, 0.58, 0.7]],
  [18, [0.13, 0.26, 0.5], [1.0, 0.7, 0.45], [0.95, 0.82, 0.62], [0.5, 0.58, 0.7]],
  [30.6, [0.17, 0.3, 0.56], [1.15, 0.88, 0.7], [1.1, 0.96, 0.82], [0.6, 0.64, 0.72]],
  [31.4, [0.3, 0.1, 0.04], [1.3, 0.55, 0.18], [1.1, 0.6, 0.3], [0.7, 0.35, 0.15]],
  [36, [0.09, 0.028, 0.014], [0.6, 0.18, 0.045], [0.6, 0.28, 0.1], [0.38, 0.14, 0.05]],
  [44, [0.05, 0.018, 0.01], [0.38, 0.1, 0.025], [0.4, 0.18, 0.07], [0.24, 0.08, 0.03]],
  [52, [0.022, 0.016, 0.013], [0.11, 0.055, 0.028], [0.1, 0.06, 0.035], [0.08, 0.045, 0.03]],
  [58, [0.012, 0.011, 0.011], [0.03, 0.027, 0.025], [0.03, 0.027, 0.025], [0.028, 0.025, 0.024]],
  [66, [0.01, 0.01, 0.012], [0.028, 0.027, 0.028], [0.028, 0.027, 0.028], [0.027, 0.026, 0.028]],
  [77, [0.018, 0.028, 0.05], [0.22, 0.2, 0.23], [0.15, 0.15, 0.17], [0.13, 0.14, 0.18]],
  [84, [0.018, 0.028, 0.05], [0.22, 0.2, 0.23], [0.15, 0.15, 0.17], [0.13, 0.14, 0.18]],
].map(([t, ...c]) => ({ t, c: c.map((v) => new THREE.Vector3(...v)) }));

const sm = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* ------------------------------------------------------------------ */
/* canvases: silhouette atlas + titles                                  */
/* ------------------------------------------------------------------ */

/** Closed Catmull-Rom curve through [x, y] points (cell-local, 256 px). */
function smooth(ctx, pts, ox, oy) {
  const n = pts.length;
  const P = (i) => pts[(i + n) % n];
  ctx.moveTo(ox + pts[0][0], oy + pts[0][1]);
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1);
    const p1 = P(i);
    const p2 = P(i + 1);
    const p3 = P(i + 2);
    ctx.bezierCurveTo(
      ox + p1[0] + (p2[0] - p0[0]) / 6,
      oy + p1[1] + (p2[1] - p0[1]) / 6,
      ox + p2[0] - (p3[0] - p1[0]) / 6,
      oy + p2[1] - (p3[1] - p1[1]) / 6,
      ox + p2[0],
      oy + p2[1]
    );
  }
  ctx.closePath();
}

function shape(ctx, cell, parts) {
  const ox = (cell % 4) * 256;
  const oy = Math.floor(cell / 4) * 256;
  ctx.beginPath();
  for (const pts of parts) smooth(ctx, pts, ox, oy);
  ctx.fill("nonzero");
}

/** A clump of pinnate fronds rising from (bx, by): [[angle, length], ...]. */
function fronds(g, bx, by, list, L0, pinna, rachis) {
  for (const [ang, len] of list) {
    const L = L0 * len;
    const tx = bx + Math.sin(ang) * L;
    const ty = by - Math.cos(ang) * L * 0.95;
    const cxp = bx + Math.sin(ang) * L * 0.25;
    const cyp = by - L * 0.75;
    g.lineWidth = rachis;
    g.beginPath();
    g.moveTo(bx, by);
    g.quadraticCurveTo(cxp, cyp, tx, ty);
    g.stroke();
    for (let i = 2; i < 18; i++) {
      const t = i / 18;
      const x = (1 - t) * (1 - t) * bx + 2 * (1 - t) * t * cxp + t * t * tx;
      const y = (1 - t) * (1 - t) * by + 2 * (1 - t) * t * cyp + t * t * ty;
      const dx = 2 * (1 - t) * (cxp - bx) + 2 * t * (tx - cxp);
      const dy = 2 * (1 - t) * (cyp - by) + 2 * t * (ty - cyp);
      const dl = Math.hypot(dx, dy) || 1;
      const nx = -dy / dl;
      const ny = dx / dl;
      const lw = pinna * Math.sin(Math.PI * Math.min(1, t * 1.1)) + 4;
      g.lineWidth = 3;
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + nx * lw * side + (dx / dl) * 7, y + ny * lw * side + (dy / dl) * 7);
        g.stroke();
      }
    }
  }
}

/**
 * 4 x 3 cells of 256 px, white on black (the red channel is coverage):
 *  0 Edmontosaurus  1 Triceratops  2 Tyrannosaurus  3 Quetzalcoatlus
 *  4 Edmontosaurus grazing  5 small mammal  6 ferns  7 Metasequoia-like conifer
 *  8 Araucaria-like conifer  9 fan palm  10 cycad  11 burnt snag
 */
function makeAtlas() {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 768;
  const g = c.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, 1024, 768);
  g.fillStyle = "#fff";
  g.strokeStyle = "#fff";
  g.lineCap = "round";
  g.lineJoin = "round";

  // 0: Edmontosaurus walking (head left); 4: grazing, head down
  const hadro = (headDrop) => [
    [
      [20, 150 + headDrop], [34, 136 + headDrop], [56, 132 + headDrop * 0.8], [76, 128 + headDrop * 0.4], [100, 118], [130, 104],
      [156, 98], [184, 104], [214, 114], [252, 130], [212, 128], [180, 136], [166, 150], [168, 176],
      [160, 206], [170, 244], [142, 246], [146, 210], [136, 178], [112, 168], [94, 166], [94, 206],
      [96, 244], [80, 246], [80, 206], [76, 168], [66, 160 + headDrop * 0.3], [50, 156 + headDrop], [30, 160 + headDrop],
    ],
  ];
  shape(g, 0, hadro(0));
  shape(g, 4, hadro(56));

  // 1: Triceratops
  shape(g, 1, [
    [
      [24, 196], [30, 178], [48, 166], [62, 146], [76, 112], [98, 102], [116, 120], [118, 148],
      [150, 140], [184, 138], [214, 150], [250, 176], [212, 178], [204, 200], [204, 244], [180, 246],
      [178, 206], [150, 210], [124, 208], [124, 244], [100, 246], [100, 206], [80, 204], [58, 210],
      [36, 210],
    ],
    [[60, 150], [70, 146], [14, 126]],
    [[30, 182], [40, 178], [26, 160]],
  ]);

  // 2: Tyrannosaurus striding
  shape(g, 2, [
    [
      [10, 96], [38, 82], [66, 84], [84, 98], [120, 102], [150, 98], [200, 108], [254, 122], [200, 124],
      [168, 130], [172, 152], [160, 196], [170, 232], [182, 246], [130, 246], [142, 232], [138, 198],
      [124, 162], [108, 152], [92, 142], [84, 144], [78, 156], [82, 158], [90, 148], [72, 128],
      [60, 120], [30, 120], [12, 108],
    ],
    [[150, 128], [178, 150], [196, 196], [216, 242], [230, 246], [196, 246], [178, 206], [146, 160]],
  ]);

  // 3: Quetzalcoatlus soaring (wings spread, long head and crest)
  shape(g, 3, [
    [
      [128, 116], [104, 108], [70, 104], [36, 114], [4, 130], [40, 128], [76, 128], [104, 136], [122, 146],
      [134, 146], [152, 136], [180, 128], [216, 128], [252, 130], [220, 114], [186, 104], [152, 108],
    ],
    [[124, 118], [116, 98], [106, 84], [78, 70], [108, 78], [122, 82], [132, 100], [134, 118]],
  ]);

  // 5: a small mammal (Didelphodon-like), head left
  shape(g, 5, [
    [
      [8, 222], [26, 208], [44, 200], [52, 190], [58, 198], [92, 192], [136, 196], [162, 206], [172, 220],
      [200, 226], [252, 238], [204, 234], [170, 230], [160, 238], [160, 248], [146, 248], [140, 238],
      [100, 240], [72, 238], [72, 248], [58, 248], [56, 236], [30, 232],
    ],
  ]);

  // 6: a clump of uncurling fern fronds
  fronds(g, 2 * 256 + 128, 256 + 252, [[-1.25, 0.95], [-0.8, 1.05], [-0.4, 1.0], [0.05, 1.08], [0.45, 1.0], [0.85, 0.95], [1.2, 0.85]], 200, 26, 4);

  // deterministic scatter for the trees
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const blob = (x, y, rx, ry) => {
    g.beginPath();
    g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    g.fill();
  };
  const trunk = (x0, y0, x1, y1, w0, w1) => {
    g.beginPath();
    g.moveTo(x0 - w0 / 2, y0);
    g.lineTo(x1 - w1 / 2, y1);
    g.lineTo(x1 + w1 / 2, y1);
    g.lineTo(x0 + w0 / 2, y0);
    g.fill();
  };

  // 7: a tall Metasequoia-like conifer: a ragged cone of drooping branch sprays
  {
    const ox = 3 * 256 + 128;
    const oy = 256;
    // a slightly crooked, tapering bole
    const lean = (y) => Math.sin(y * 0.018) * 4;
    for (let y = 6; y < 256; y += 6) trunk(ox + lean(y + 6), oy + y + 6, ox + lean(y), oy + y, 2 + 10 * (y / 256), 2 + 10 * ((y - 6) / 256));
    // branches in irregular clumps: the outline swells and pinches with height,
    // some whorls are missing, the two sides are not mirror images
    for (let y = 10; y < 206; y += 3) {
      const k = (y - 6) / 200;
      const swell = 0.7 + 0.3 * Math.sin(y * 0.09 + 1.3) + 0.15 * Math.sin(y * 0.23);
      for (const side of [-1, 1]) {
        if (rnd() < 0.18) continue;
        const L = 3 + 70 * Math.pow(k, 0.85) * swell * (0.5 + 0.7 * rnd()) * (side > 0 ? 1 : 0.85 + 0.3 * Math.sin(y * 0.05));
        const bx = ox + lean(y);
        const ex = bx + side * L;
        const ey = oy + y + L * (0.2 + 0.25 * rnd()) + rnd() * 5;
        g.lineWidth = 2 + 2.5 * k;
        g.beginPath();
        g.moveTo(bx, oy + y);
        g.quadraticCurveTo(bx + side * L * 0.5, oy + y - 3, ex, ey);
        g.stroke();
        for (let i = 0; i < 6; i++) {
          const t = 0.2 + rnd() * 0.8;
          blob(bx + side * L * t + (rnd() - 0.5) * 6, oy + y + L * 0.25 * t * t + 2 + (rnd() - 0.5) * 5, 3 + 7 * k * rnd(), 2 + 3.5 * rnd());
        }
      }
    }
  }

  // 8: an Araucaria-like conifer: tall bare bole, tiered crown of upturned limbs
  {
    const ox = 128;
    const oy = 512;
    trunk(ox, oy + 256, ox + 3, oy + 10, 11, 3);
    // a few dead stubs low on the bole
    g.lineWidth = 2;
    for (const [y, s, L] of [[150, -1, 14], [128, 1, 10], [176, 1, 8]]) {
      g.beginPath();
      g.moveTo(ox, oy + y);
      g.lineTo(ox + s * L, oy + y + 4);
      g.stroke();
    }
    // an open, flat-topped crown: sparse whorls of long limbs that sag and turn
    // up at the tips, uneven lengths, gaps between the tiers
    for (let y = 12; y < 112; y += 9 + rnd() * 9) {
      const k = (y - 6) / 106;
      for (const side of [-1, 1]) {
        if (rnd() < 0.15) continue;
        const L = 26 + 96 * Math.pow(k, 0.6) * (0.55 + 0.6 * rnd());
        const bx = ox + 3 * (1 - y / 256);
        const sag = 10 + 16 * rnd();
        const ex = bx + side * L;
        const ey = oy + y + sag * 0.4 - 8 * rnd();
        g.lineWidth = 2.5 + 2 * k;
        g.beginPath();
        g.moveTo(bx, oy + y);
        g.quadraticCurveTo(bx + side * L * 0.55, oy + y + sag, ex, ey);
        g.stroke();
        // tufted foliage along the outer two thirds, bushiest at the tip
        for (let i = 0; i < 9; i++) {
          const t = 0.35 + rnd() * 0.65;
          const yy = oy + y + sag * 2 * t * (1 - t) + (ey - oy - y) * t * t;
          blob(bx + side * L * t + (rnd() - 0.5) * 5, yy - 2 + (rnd() - 0.5) * 6, 3 + 6 * t * rnd() + 2, 2.5 + 3 * rnd());
        }
      }
    }
  }

  // 9: a fan palm (Sabalites), its trunk leaning a little
  {
    const ox = 256 + 128;
    const oy = 512;
    g.lineWidth = 9;
    g.beginPath();
    g.moveTo(ox + 14, oy + 256);
    g.quadraticCurveTo(ox + 12, oy + 160, ox - 6, oy + 84);
    g.stroke();
    const cx = ox - 6;
    const cy = oy + 80;
    for (let i = 0; i < 17; i++) {
      const a = -Math.PI + (i / 16) * Math.PI + (rnd() - 0.5) * 0.15;
      const droop = Math.abs(Math.cos(a)) * 0.55;
      const L = 62 + rnd() * 22;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * L, cy + Math.sin(a) * L * (1 - droop) + droop * L * 0.6);
      g.stroke();
      // the fan blade: a thin wedge of segments around the end of the stalk
      for (let j = -3; j <= 3; j++) {
        const b = a + j * 0.07;
        g.lineWidth = 2.2;
        g.beginPath();
        g.moveTo(cx + Math.cos(a) * L * 0.45, cy + Math.sin(a) * L * 0.45 * (1 - droop) + droop * L * 0.25);
        g.lineTo(cx + Math.cos(b) * L * 1.05, cy + Math.sin(b) * L * (1 - droop) + droop * L * 0.7 + 2);
        g.stroke();
      }
    }
    blob(cx, cy, 9, 7);
  }

  // 10: a cycad: stout trunk and a crown of stiff, feathery leaves
  {
    const ox = 2 * 256 + 128;
    const oy = 512;
    trunk(ox, oy + 256, ox, oy + 196, 30, 24);
    fronds(g, ox, oy + 198, [[-1.45, 0.55], [-1.05, 0.62], [-0.62, 0.7], [-0.2, 0.74], [0.2, 0.72], [0.62, 0.7], [1.05, 0.62], [1.45, 0.55]], 190, 16, 4);
  }

  // 11: a burnt snag: bare trunk, broken top, a few charred stubs
  {
    const ox = 3 * 256 + 128;
    const oy = 512;
    trunk(ox, oy + 256, ox - 3, oy + 34, 12, 4);
    g.lineWidth = 3;
    for (let i = 0; i < 9; i++) {
      const y = oy + 50 + i * 20 + rnd() * 8;
      const side = i % 2 ? 1 : -1;
      const L = 8 + rnd() * 26;
      g.beginPath();
      g.moveTo(ox, y);
      g.lineTo(ox + side * L, y + L * 0.5 * (rnd() - 0.2));
      g.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeTitles() {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, 1024, 256);
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.textBaseline = "middle";
  // red channel: the letters; green: a blurred halo the shader darkens behind them
  const line = (text, y, size, weight = 300, spaced = false) => {
    let px = size;
    const t = spaced ? text.split("").join(" ") : text;
    g.font = `${weight} ${px}px Georgia, "Times New Roman", serif`;
    while (g.measureText(t).width > 960 && px > 10) {
      px -= 1;
      g.font = `${weight} ${px}px Georgia, "Times New Roman", serif`;
    }
    g.save();
    g.globalCompositeOperation = "lighter";
    g.shadowColor = "rgba(0,255,0,1)";
    g.shadowBlur = 14;
    g.fillStyle = "rgba(0,200,0,1)";
    g.fillText(t, 512, y);
    g.restore();
    g.save();
    g.globalCompositeOperation = "lighter";
    g.fillStyle = "rgb(255,0,0)";
    g.fillText(t, 512, y);
    g.restore();
  };
  // top half: the opening title; bottom half: the epilogue
  line("HELL CREEK, NORTH AMERICA", 36, 28, 400, true);
  line("66 million years ago", 86, 58, 400);
  line("Three in four species vanished.", 162, 44, 400);
  line("The small survivors inherited the Earth.", 216, 44, 400);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/* ------------------------------------------------------------------ */
/* the room                                                             */
/* ------------------------------------------------------------------ */
export function createExtinctionRoom({ scene, camera, renderer, audio, quality = "medium", reducedMotion } = {}) {
  const room = ROOMS.find((r) => r.id === ROOM_ID);
  if (!room) {
    return {
      update() {},
      seek() {},
      dispose() {},
      get inside() {
        return false;
      },
    };
  }

  const X0 = g2w(room.cols[0]) - CELL / 2 + 0.2 + INSET;
  const X1 = g2w(room.cols[1]) + CELL / 2 - 0.2 - INSET;
  const Z0 = g2z(room.rows[0]) - CELL / 2 + 0.2 + INSET;
  const Z1 = g2z(room.rows[1]) + CELL / 2 - 0.2 - INSET;
  const W = X1 - X0;
  const D = Z1 - Z0;
  const CX = (X0 + X1) / 2;
  const CZ = (Z0 + Z1) / 2;
  const PERIM = 2 * (W + D);
  const near = new Set([ROOM_ID, ...roomNeighbours(ROOM_ID)]);
  // when the blast front reaches the middle of the room (the bench)
  const T_SHOCK = SHOCK_START + (SHOCK_BACK + Z1 - CZ - SHOCK_R0) / SHOCK_SPEED;

  // doorways in the north wall (the way in), so the projection skips them
  const doorsN = [];
  for (let c = room.cols[0]; c <= room.cols[1]; c++) {
    // (a little narrower than the opening, so the screen hides the door casings)
    if (passable(c, room.rows[0], c, room.rows[0] - 1)) doorsN.push([g2w(c) - CELL / 2 + 0.4, g2w(c) + CELL / 2 - 0.4]);
  }

  const defines = { OCT: quality === "low" ? 3 : quality === "high" ? 5 : 4, PERIM: PERIM.toFixed(3) };
  if (quality !== "low") defines.RIM = 1;
  const GLSL = shaderChunks({ H0, PH, S_IMP, FIRE_SPEED, SHOCK_BACK });

  let built = false;
  let group = null;
  const disposables = [];

  const U = {
    uClock: { value: 0 },
    uFade: { value: 1 },
    uExp: { value: 1 },
    uFlash: { value: 0 },
    uFireF: { value: -100 },
    uFireOn: { value: 0 },
    uLife: { value: 1 },
    uAsh: { value: 0 },
    uAshCover: { value: 0 },
    uEmbers: { value: 0 },
    uSmoke: { value: 0 },
    uEjecta: { value: 0 },
    uDawn: { value: 0 },
    uFern: { value: 0 },
    uTitle: { value: 0 },
    uEpi: { value: 0 },
    uSun: { value: 1 },
    uCloud: { value: 1 },
    uScorched: { value: 0 },
    uShockW: { value: -100 },
    uShockR: { value: 0 },
    uShockA: { value: 0 },
    uSkyTop: { value: new THREE.Vector3() },
    uSkyHor: { value: new THREE.Vector3() },
    uLand: { value: new THREE.Vector3() },
    uHaze: { value: new THREE.Vector3() },
    uStreak: { value: new THREE.Vector4() },
    uStreakDir: { value: new THREE.Vector2(-0.96, 0.26).normalize() },
    uPlume: { value: new THREE.Vector2() },
    uMammal: { value: new THREE.Vector2() },
    uBox: { value: new THREE.Vector4(X0, X1, Z0, Z1) },
    uAtlas: { value: null },
    uText: { value: null },
  };

  function build() {
    built = true;
    group = new THREE.Group();
    group.name = "extinction-room";
    group.userData.surface = "skip"; // lookdev leaves the projection alone

    U.uAtlas.value = makeAtlas();
    U.uText.value = makeTitles();
    disposables.push(U.uAtlas.value, U.uText.value);

    const wallMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: GLSL.WALL_VERT, fragmentShader: GLSL.WALL_FRAG, defines });
    const floorMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: GLSL.FLOOR_VERT, fragmentShader: GLSL.FLOOR_FRAG, defines });
    disposables.push(wallMat, floorMat);

    // all four walls in one geometry; aS = metres along the perimeter, 0 in
    // the middle of the south wall, growing to the right of a visitor facing it
    const pos = [];
    const sAttr = [];
    const idx = [];
    const quad = (ax, az, bx, bz, sa, sb, y0, y1) => {
      const i = pos.length / 3;
      pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
      sAttr.push(sa, sb, sb, sa);
      idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
    };
    // [a, b] minus the door gaps
    const segs = (a, b, gaps) => {
      let out = [[a, b]];
      for (const [g0, g1] of gaps) {
        out = out.flatMap(([u, v]) => (g1 <= u || g0 >= v ? [[u, v]] : [[u, g0], [g1, v]].filter(([p, q]) => q - p > 0.01)));
      }
      return out;
    };
    quad(X1, Z1, X0, Z1, CX - X1, CX - X0, 0, PH); // south (facing -z): s = CX - x
    quad(X0, Z1, X0, Z0, W / 2, W / 2 + D, 0, PH); // west (facing +x)
    for (const [u, v] of segs(X0, X1, doorsN)) quad(u, Z0, v, Z0, W / 2 + D + (u - X0), W / 2 + D + (v - X0), 0, PH); // north
    quad(X1, Z0, X1, Z1, W * 1.5 + D, W * 1.5 + 2 * D, 0, PH); // east (facing -x)
    const wallGeo = new THREE.BufferGeometry();
    wallGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    wallGeo.setAttribute("aS", new THREE.Float32BufferAttribute(sAttr, 1));
    wallGeo.setIndex(idx);
    wallGeo.computeBoundingSphere();
    group.add(new THREE.Mesh(wallGeo, wallMat));
    disposables.push(wallGeo);

    const floorGeo = new THREE.PlaneGeometry(W, D, 1, 1);
    floorGeo.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.set(CX, 0.012, CZ);
    group.add(floor);
    disposables.push(floorGeo);

    // the ceiling carries the zenith of the sky (dark, meeting the walls' top
    // colour), black reveals at the doorway and a dark soffit over it
    const black = new THREE.MeshBasicMaterial({ color: 0x050506, fog: false });
    const ceilMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: GLSL.FLOOR_VERT, fragmentShader: GLSL.CEIL_FRAG, defines });
    disposables.push(black, ceilMat);
    const ceilGeo = new THREE.PlaneGeometry(W + 0.02, D + 0.02);
    ceilGeo.rotateX(Math.PI / 2);
    const ceil = new THREE.Mesh(ceilGeo, ceilMat);
    ceil.position.set(CX, PH, CZ);
    group.add(ceil);
    disposables.push(ceilGeo);
    const soffit = Math.min(Math.min(room.h, 10) - 1.3, PH - 0.55);
    for (const [u, v] of doorsN) {
      for (const x of [u, v]) {
        const g = new THREE.PlaneGeometry(INSET + 0.25, PH);
        const m = new THREE.Mesh(g, black);
        m.rotation.y = x === u ? Math.PI / 2 : -Math.PI / 2;
        m.position.set(x, PH / 2, Z0 - INSET / 2 - 0.05);
        group.add(m);
        disposables.push(g);
      }
      const g = new THREE.PlaneGeometry(v - u, PH - soffit + 0.02);
      const m = new THREE.Mesh(g, black);
      m.position.set((u + v) / 2, (PH + soffit) / 2, Z0);
      group.add(m);
      disposables.push(g);
      const under = new THREE.PlaneGeometry(v - u, INSET + 0.25);
      under.rotateX(Math.PI / 2);
      const um = new THREE.Mesh(under, black);
      um.position.set((u + v) / 2, soffit, Z0 - INSET / 2 - 0.05);
      group.add(um);
      disposables.push(under);
      // a quiet way-out label on the soffit
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(2.6, 0.32),
        new THREE.MeshBasicMaterial({ map: exitLabel(), transparent: true, fog: false, toneMapped: false })
      );
      label.position.set((u + v) / 2, (PH + soffit) / 2, Z0 + 0.01);
      group.add(label);
      disposables.push(label.geometry, label.material, label.material.map);
    }

    // the long, low bench (two sittable halves from world.js): a dark leather
    // cushion in three button-tufted sections on a blackened steel frame,
    // lit by the room (whose light the eye adaptation dims), never glowing
    const leather = new THREE.MeshStandardMaterial({ color: 0x1d1a18, roughness: 0.48, metalness: 0.0 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x0e0f10, roughness: 0.4, metalness: 0.7 });
    disposables.push(leather, steel);
    const ours = BENCHES.filter((b) => b.custom && roomAt(b.x, b.z)?.id === ROOM_ID);
    if (ours.length) {
      const xs = ours.map((b) => b.x);
      const bx0 = Math.min(...xs) - 1.6;
      const bx1 = Math.max(...xs) + 1.6;
      const len = bx1 - bx0;
      const bench = new THREE.Group();
      bench.position.set((bx0 + bx1) / 2, 0, ours[0].z - 0.02);
      bench.rotation.y = ours[0].ry;
      const n = 3;
      const cushionGeo = new THREE.BoxGeometry(len / n - 0.03, 0.13, 0.86);
      const pipingGeo = new THREE.BoxGeometry(len / n - 0.05, 0.02, 0.88);
      const buttonGeo = new THREE.SphereGeometry(0.018, 8, 6);
      disposables.push(cushionGeo, pipingGeo, buttonGeo);
      for (let i = 0; i < n; i++) {
        const x = -len / 2 + (len / n) * (i + 0.5);
        const c = new THREE.Mesh(cushionGeo, leather);
        c.position.set(x, 0.475, 0);
        bench.add(c);
        const p = new THREE.Mesh(pipingGeo, steel);
        p.position.set(x, 0.405, 0);
        bench.add(p);
        for (let bxi = -2; bxi <= 2; bxi++) {
          for (const bzi of [-0.2, 0.2]) {
            const b = new THREE.Mesh(buttonGeo, steel);
            b.position.set(x + bxi * (len / n / 5.5), 0.54, bzi);
            b.scale.y = 0.4;
            bench.add(b);
          }
        }
      }
      const frameGeo = new THREE.BoxGeometry(len - 0.1, 0.06, 0.8);
      const legGeo = new THREE.BoxGeometry(0.06, 0.36, 0.72);
      disposables.push(frameGeo, legGeo);
      const frame = new THREE.Mesh(frameGeo, steel);
      frame.position.y = 0.38;
      bench.add(frame);
      for (const lx of [-len / 2 + 0.25, -len / 6, len / 6, len / 2 - 0.25]) {
        const leg = new THREE.Mesh(legGeo, steel);
        leg.position.set(lx, 0.18, 0);
        bench.add(leg);
      }
      group.add(bench);
    }

    group.visible = false;
    scene.add(group);
  }

  function exitLabel() {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "rgba(190,200,210,0.5)";
    g.font = '400 28px Georgia, "Times New Roman", serif';
    g.textAlign = "center";
    g.textBaseline = "middle";
    const name = [...roomNeighbours(ROOM_ID)].map((id) => ROOMS.find((r) => r.id === id)?.name).filter(Boolean)[0] || "Exit";
    g.fillText(name.toUpperCase().split("").join(" "), 256, 33);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /* ---------------- timeline -> uniforms ---------------- */
  const tmpA = new THREE.Vector3();
  function keyColors(t) {
    let i = 0;
    while (i < KEYS.length - 2 && KEYS[i + 1].t <= t) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const k = sm(a.t, b.t, t);
    U.uSkyTop.value.lerpVectors(a.c[0], b.c[0], k);
    U.uSkyHor.value.lerpVectors(a.c[1], b.c[1], k);
    U.uLand.value.lerpVectors(a.c[2], b.c[2], k);
    U.uHaze.value.lerpVectors(a.c[3], b.c[3], k);
  }

  const STREAK_A = [-13, 6.9];
  const STREAK_B = [S_IMP, H0 + 0.12];
  /** Overall brightness of the room (for the eye adaptation). */
  let showLum = 1;
  function applyTime(t, live) {
    keyColors(t);
    U.uFade.value = live ? sm(0, 3, t) * (1 - sm(82, 84, t)) : 1;
    U.uSun.value = 1 - sm(29, 31.2, t);
    U.uCloud.value = U.uSun.value;
    // the bolide: a faint star that brightens and accelerates
    if (t > 18 && t < T_IMPACT) {
      const p = (t - 18) / (T_IMPACT - 18);
      const e = Math.pow(p, 2.2);
      U.uStreak.value.set(
        STREAK_A[0] + (STREAK_B[0] - STREAK_A[0]) * e,
        STREAK_A[1] + (STREAK_B[1] - STREAK_A[1]) * e,
        sm(0, 0.2, p) * (0.3 + 0.7 * p * p),
        0.3 + 5 * p * p
      );
    } else U.uStreak.value.z = 0;
    const ti = t - T_IMPACT;
    U.uFlash.value = ti >= 0 ? Math.exp(-ti / 0.28) * 0.95 + 0.05 * Math.exp(-ti / 0.9) : sm(30, 31, t) * 0.015;
    U.uShockW.value = (t - SHOCK_START) * 14;
    U.uScorched.value = sm(45, 50, t);
    U.uPlume.value.set(Math.max(0, ti), sm(31, 31.4, t) * (1 - sm(46, 56, t)));
    U.uFireF.value = (t - 33) * FIRE_SPEED;
    U.uFireOn.value = sm(32.5, 33.5, t) * (1 - sm(60, 66, t));
    U.uEjecta.value = sm(31.5, 33, t) * (1 - sm(42, 48, t));
    U.uSmoke.value = sm(33, 40, t) * (1 - sm(62, 72, t));
    U.uEmbers.value = sm(34, 37, t) * (1 - sm(54, 64, t));
    U.uLife.value = 1 - sm(40, 46, t);
    U.uShockR.value = SHOCK_R0 + (t - SHOCK_START) * SHOCK_SPEED;
    U.uShockA.value = sm(SHOCK_START, SHOCK_START + 0.5, t) * (1 - sm(50, 52.5, t));
    U.uAsh.value = sm(48, 56, t) * (1 - sm(77, 84, t) * 0.8);
    U.uAshCover.value = sm(50, 64, t);
    U.uDawn.value = sm(66, 78, t);
    U.uFern.value = sm(69, 79, t);
    // a small mammal scurries in, pauses, sniffs and moves on
    const mp = sm(71.5, 75, t) * 0.6 + sm(77, 80.5, t) * 0.4;
    U.uMammal.value.set(S_IMP + 8 - 11 * mp, sm(71, 72, t) * (1 - sm(81, 82.5, t)));
    U.uTitle.value = live ? sm(4, 6, t) * (1 - sm(11.5, 13.5, t)) : 0;
    U.uEpi.value = sm(73, 75.5, t) * (1 - sm(80.5, 82.5, t));
    const L = U.uLand.value;
    const H = U.uSkyHor.value;
    tmpA.copy(L).add(H).multiplyScalar(0.5);
    showLum = (tmpA.x + tmpA.y + tmpA.z) / 3 + U.uFlash.value * 2 + U.uFireOn.value * 0.3 * (1 - sm(46, 56, t));
  }

  /* ---------------- sound ---------------- */
  const KINDS = ["rumble", "fire", "wind"];
  const layers = { rumble: null, fire: null, wind: null };
  const level = { rumble: 0, fire: 0, wind: 0 };
  let soundTimer = 0;
  let ducked = false;
  const soundOn = () => !!audio && audio.channelOn?.("ambience") !== false;
  function levels(t) {
    level.rumble =
      t < 18 || t > 66
        ? 0
        : t < T_IMPACT
          ? 0.08 + 0.45 * sm(18, T_IMPACT, t)
          : t < T_SHOCK
            ? 0.45 + 0.55 * Math.exp(-(t - T_IMPACT) / 3)
            : (0.4 + 0.5 * Math.exp(-(t - T_SHOCK) / 2.5)) * (1 - sm(56, 66, t));
    level.fire = t < 33 || t > 60 ? 0 : 0.75 * sm(33, 37, t) * (1 - 0.75 * sm(44, 54, t)) * (1 - sm(54, 60, t));
    level.wind = t < 50 || t > 84 ? 0 : 0.5 * sm(50, 57, t) * (1 - 0.6 * sm(70, 78, t)) * (1 - sm(81, 84, t));
  }
  function syncSound(t) {
    if (!soundOn()) return stopSound(0.6);
    if (!ducked && audio.duck && !audio.ducked) {
      audio.duck(true);
      ducked = true;
    }
    levels(t);
    for (const k of KINDS) {
      const v = level[k];
      if (v > 0.005) {
        if (!layers[k]) layers[k] = audio.layer?.(k, { level: v, attack: 0.8 }) || null;
        else layers[k].set(v, 0.3);
      } else if (layers[k]) {
        layers[k].stop(1.5);
        layers[k] = null;
      }
    }
  }
  function stopSound(fade = 1.5) {
    for (const k of KINDS) {
      if (layers[k]) layers[k].stop(fade);
      layers[k] = null;
    }
    if (ducked) {
      ducked = false;
      if (audio?.ducked) audio.duck(false);
    }
  }

  /* ---------------- eye adaptation ---------------- */
  // In the dark parts of the show the avatars (lit by the museum's global
  // lights) would glow; lowering the exposure dims everything lit, and the
  // projection divides it back out so the show itself is unchanged.
  let expBase = null;
  let expSet = 0;
  let adapt = 1;
  function adaptEyes(dt, on) {
    if (!renderer) return;
    const target = on ? Math.min(1, Math.max(0.3, 0.3 + showLum * 0.9)) : 1;
    adapt += (target - adapt) * Math.min(1, dt * (target < adapt ? 1.2 : 3));
    if (expBase === null) {
      if (!on) return;
      expBase = renderer.toneMappingExposure;
    } else if (Math.abs(renderer.toneMappingExposure - expSet) > 1e-5) {
      expBase = renderer.toneMappingExposure; // someone else changed it
    }
    if (!on && Math.abs(adapt - 1) < 0.01) {
      renderer.toneMappingExposure = expBase;
      expBase = null;
      adapt = 1;
      U.uExp.value = 1;
      return;
    }
    expSet = expBase * adapt;
    renderer.toneMappingExposure = expSet;
    U.uExp.value = 1 / adapt;
  }

  /* ---------------- camera shake ---------------- */
  const reduced = () => {
    try {
      if (typeof reducedMotion === "function" && reducedMotion()) return true;
      if (document.documentElement.hasAttribute("data-reduced-motion")) return true;
      return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  };
  function shake(t, c) {
    if (!camera || reduced()) return;
    const a1 = t >= T_IMPACT && t < T_IMPACT + 4 ? 0.07 * Math.exp(-(t - T_IMPACT) / 0.8) : 0;
    const a2 = t >= T_SHOCK && t < T_SHOCK + 3 ? 0.09 * Math.exp(-(t - T_SHOCK) / 0.6) : 0;
    const a3 = t > T_IMPACT && t < 50 ? 0.006 : 0;
    const a = a1 + a2 + a3;
    if (a <= 0) return;
    camera.position.x += a * (Math.sin(c * 37.1) + Math.sin(c * 23.3) * 0.5);
    camera.position.y += a * 0.6 * (Math.sin(c * 41.7 + 1.3) + Math.sin(c * 19.9) * 0.5);
    camera.position.z += a * (Math.sin(c * 31.3 + 2.1) + Math.sin(c * 27.7) * 0.5);
  }

  /* ---------------- per frame ---------------- */
  let showT = T_ENTER;
  let running = false;
  let away = Infinity;
  let clock = 0;
  let inside = false;
  let lastT = 0;
  let forced = null;

  function update(dt, player) {
    if (!player) return;
    const id = roomAt(player.x, player.z)?.id;
    const nearby = id !== undefined && near.has(id);
    inside = id === ROOM_ID;
    if (!nearby && !running && expBase === null) {
      if (group) group.visible = false;
      return;
    }
    if (!built && nearby) build();
    if (!group) return;
    group.visible = nearby;
    clock = (clock + dt) % 600;
    U.uClock.value = clock;

    if (inside) {
      if (!running || away > RESTART_AFTER) {
        showT = T_ENTER;
        lastT = showT;
        running = true;
      }
      away = 0;
    } else if (running) {
      away += dt;
      if (away > RESTART_AFTER) running = false;
    }
    if (forced !== null) {
      showT = forced;
      forced = null;
      lastT = showT;
      running = true;
    } else if (running) {
      showT += dt;
      if (showT >= T_TOTAL) {
        showT -= T_TOTAL;
        lastT = showT;
      }
    }
    // from the doorway, an idle room shows the calm landscape
    applyTime(running ? showT : 10, running);

    if (inside && running) {
      soundTimer -= dt;
      if (soundTimer <= 0) {
        soundTimer = 0.25;
        syncSound(showT);
      }
      if (soundOn()) {
        if (lastT < T_IMPACT && showT >= T_IMPACT) audio.impact?.(1.2);
        if (lastT < T_SHOCK - 0.2 && showT >= T_SHOCK - 0.2) audio.impact?.(0.7);
      }
      shake(showT, clock);
    } else if (ducked || layers.rumble || layers.fire || layers.wind) stopSound();
    lastT = showT;
    adaptEyes(dt, inside && running);

  }

  return {
    update,
    /** Jump the show to t seconds (debug / screenshots). */
    seek(t) {
      forced = Math.max(0, Math.min(T_TOTAL - 0.01, Number(t) || 0));
    },
    get time() {
      return showT;
    },
    get running() {
      return running;
    },
    get inside() {
      return inside;
    },
    get duration() {
      return T_TOTAL;
    },
    bounds: { x0: X0, x1: X1, z0: Z0, z1: Z1, cx: CX, cz: CZ },
    dispose() {
      stopSound(0.3);
      if (expBase !== null && renderer) renderer.toneMappingExposure = expBase;
      expBase = null;
      if (group) scene.remove(group);
      for (const d of disposables) d.dispose?.();
      disposables.length = 0;
      group = null;
      built = false;
    },
  };
}
