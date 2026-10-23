import * as THREE from "three";
import {
  ROOMS,
  EXHIBIT_HALLS,
  PLACEMENTS,
  OBSTACLES,
  PROP_OBSTACLES,
  DISPLAYS,
  CELL,
  GRID_W,
  GRID_H,
  g2w,
  g2z,
  w2g,
  w2gz,
  isSolid,
  passable,
  roomAt,
} from "./world.js";
import { SPECIES } from "./species.js";

/**
 * Museum wayfinding: "You Are Here" map totems at the main junctions and an
 * introduction panel on the wall at every way into an exhibit hall.
 *
 *   const way = buildWayfinding(world.group, world, { scene, quality });
 *   world.interactables.push(...way.interactables);   // type "totem" / "intro"
 *   way.update(dt);                                    // pulses the red dots
 *
 * Totems are free-standing, double-sided and backlit. Each face carries the
 * floor plan drawn heading-up (the way the reader is facing is "up" on the
 * map, as real museum maps do), a red "you are here" dot, the hall names and
 * a legend with each hall's dates. Their footprints go into world.js's
 * OBSTACLES (ids "way:…"), which resolveCollision and the crowd read live.
 *
 * Intro panels hang flat on a wall (no collider) beside the doorway, facing
 * the visitors on their way in: on the wall next to the door when there is
 * one, else on a side wall of the corridor or link leading up to it, else
 * just inside the hall. They are placed in the middle of a wall bay so they
 * sit between lookdev's pilasters, above its dado rail, and every spot is
 * checked against plinths, displays, furniture and whatever already hangs
 * on that wall. Secret rooms (exit passage, ice cream court) never appear.
 *
 * Every mesh is tagged userData.surface = "skip": they carry their own
 * materials, so lookdev leaves them alone whenever it runs.
 */

const FONT = "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
const TAU = Math.PI * 2;

/** Main junctions: x, z and ry = the way the front face looks (sin ry, cos ry). */
export const TOTEMS = [
  // seen from the spawn point, to the left of the way on to the Grand Gallery
  { id: "atrium", room: "lobby", x: -7, z: 34, ry: 0 },
  // just inside the Grand Gallery, ahead-left of visitors arriving from the atrium
  { id: "gallery", room: "rotunda", x: -10, z: 12.5, ry: 0 },
  // between the Screening Theatre and the Grand Gallery
  { id: "north", room: "ncorridor", x: -8, z: -39, ry: 0 },
  // the long links out to the Triassic and Jurassic halls: faces along the corridor
  { id: "west", room: "wcorridor", x: -39, z: 2.6, ry: Math.PI / 2 },
  { id: "east", room: "ecorridor", x: 41, z: 2.6, ry: -Math.PI / 2 },
];

/** Two-line hall introductions (fact-checked against species.js). */
const INTRO = {
  triassic:
    "The first dinosaurs were small, fast two-legged hunters and omnivores. By the end of the Triassic their long-necked cousins were the biggest plant-eaters on land.",
  jurassic:
    "As the supercontinent Pangaea split apart, long-necked sauropods grew into the largest animals ever to walk the Earth, hunted by Allosaurus and Torvosaurus.",
  cretaceous:
    "Flowering plants spread, and plant-eaters grew horns, crests, domes and armour. It ended 66 million years ago, when an asteroid wiped out every dinosaur except the birds.",
  predator:
    "The biggest meat-eaters of the Cretaceous. Giganotosaurus, Carcharodontosaurus and Mapusaurus rivalled T. rex in length, with blade-like teeth built for slicing.",
  marine:
    "None of these animals are dinosaurs. Ichthyosaurs, plesiosaurs and mosasaurs were reptiles that returned to the sea: they breathed air and gave birth to live young.",
  rotunda:
    "Highlights from 295 million years of life on land, at sea and in the air, from Dimetrodon, older than any dinosaur, to Doedicurus, an Ice Age giant armadillo relative.",
};

/** ICS chart colours (public reference values), oldest first; ages in Ma. */
const PERIODS = [
  { name: "Permian", from: 298.9, to: 251.9, color: "#f04028" },
  { name: "Triassic", from: 251.9, to: 201.4, color: "#812b92" },
  { name: "Jurassic", from: 201.4, to: 145, color: "#34b2c9" },
  { name: "Cretaceous", from: 145, to: 66, color: "#7fc64e" },
  { name: "Paleogene", from: 66, to: 23.03, color: "#fd9a52" },
  { name: "Neogene", from: 23.03, to: 2.58, color: "#ffe619" },
  { name: "Quaternary", from: 2.58, to: 0, color: "#f9f97f" },
];
const TIMELINE_START = 300;

const ROOM = Object.fromEntries(ROOMS.map((r) => [r.id, r]));
const shownRoom = (room) => !!room && !room.secret;
const isPassage = (room) => /corridor|link|^wc2$|^ec2$|xpassage/i.test(`${room.id} ${room.name}`);
const roomOfCell = (c, r) => (isSolid(c, r) ? null : roomAt(g2w(c), g2z(r)));
const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;

/* ------------------------------------------------------------------ */
/* hall facts from the catalogue                                        */
/* ------------------------------------------------------------------ */

/**
 * "c. 227–209 million years ago" -> [227, 209]; "c. 0.8 million – 11,000
 * years ago" -> [0.8, 0.011]. A number with no unit takes the unit of the
 * next one ("155–145 million"); the last one with no unit is plain years.
 */
export function periodMa(text) {
  const s = String(text || "").replace(/(\d),(\d{3})/g, "$1$2");
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)\s*(million|thousand)?/g)].map((m) => ({ v: parseFloat(m[1]), unit: m[2] || null }));
  if (!nums.length) return null;
  for (let i = nums.length - 1; i >= 0; i--) {
    if (nums[i].unit) continue;
    nums[i].unit = i < nums.length - 1 ? nums[i + 1].unit : /million/.test(s.slice(s.lastIndexOf(String(nums[i].v)))) ? "million" : "years";
  }
  const ma = nums.map(({ v, unit }) => (unit === "million" ? v : unit === "thousand" ? v / 1000 : v / 1e6));
  return [Math.max(...ma), Math.min(...ma)];
}

function fmtMa(v) {
  return v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
}

/** "231–183 million years ago" / "295 million – 11,000 years ago". */
export function bandText([from, to]) {
  if (to < 1) {
    const years = Math.round((to * 1e6) / 1000) * 1000;
    return `${fmtMa(from)} million – ${years.toLocaleString("en-GB")} years ago`;
  }
  if (fmtMa(from) === fmtMa(to)) return `${fmtMa(from)} million years ago`;
  return `${fmtMa(from)}–${fmtMa(to)} million years ago`;
}

function eraSpan(oldest, youngest) {
  const clean = (e) => String(e || "").replace(/\s*\(.*\)\s*/, "").trim();
  const a = clean(oldest);
  const b = clean(youngest);
  if (!a || a === b) return a || b;
  const wa = a.split(" ");
  const wb = b.split(" ");
  if (wa.length === 2 && wb.length === 2 && wa[1] === wb[1]) return `${wa[0]} – ${wb[0]} ${wa[1]}`;
  return `${a} – ${b}`;
}

/** Per exhibit hall: name, accent, era span, Ma band and the animals in it. */
export const HALLS = (() => {
  const out = {};
  for (const id of EXHIBIT_HALLS) {
    const room = ROOM[id];
    if (!room) continue;
    const species = PLACEMENTS.filter((p) => roomAt(p.x, p.z)?.id === id)
      .map((p) => SPECIES[p.id])
      .filter(Boolean);
    const dated = species.map((s) => ({ s, b: periodMa(s.info?.period) })).filter((d) => d.b);
    let band = null;
    let oldest = null;
    let youngest = null;
    for (const { s, b } of dated) {
      if (!oldest || b[0] > band[0]) oldest = s.info.era;
      if (!youngest || b[1] < band[1]) youngest = s.info.era;
      band = band ? [Math.max(band[0], b[0]), Math.min(band[1], b[1])] : b.slice();
    }
    out[id] = {
      id,
      name: room.name,
      accent: hex(room.accent),
      era: eraSpan(oldest, youngest),
      band,
      bandText: band ? bandText(band) : "",
      intro: INTRO[id] || "",
      species: species.map((s) => s.name),
    };
  }
  return out;
})();

/* ------------------------------------------------------------------ */
/* canvas helpers                                                       */
/* ------------------------------------------------------------------ */

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function mix(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (p, s) => (p >> s) & 255;
  const v = (s) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * t);
  return `rgb(${v(16)},${v(8)},${v(0)})`;
}

function setSpacing(ctx, px) {
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${px}px`;
}

/** Largest size (down to min) at which text fits maxW. */
function fitFont(ctx, text, weight, size, maxW, min = 10) {
  let s = size;
  for (; s > min; s -= 1) {
    ctx.font = `${weight} ${s}px ${FONT}`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  ctx.font = `${weight} ${s}px ${FONT}`;
  return s;
}

/** Greedy word wrap; the last allowed line gets an ellipsis if text is left. */
function wrap(ctx, text, maxW, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (let i = 0; i < words.length; i++) {
    const test = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(test).width <= maxW || !line) {
      line = test;
      continue;
    }
    lines.push(line);
    line = words[i];
    if (lines.length === maxLines) {
      let last = lines[maxLines - 1];
      while (last && ctx.measureText(`${last}…`).width > maxW) last = last.replace(/\s*\S+$/, "");
      lines[maxLines - 1] = `${last}…`;
      return lines;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function texture(c, renderer) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer?.capabilities?.getMaxAnisotropy?.() || 4);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/* ------------------------------------------------------------------ */
/* the floor plan                                                       */
/* ------------------------------------------------------------------ */

const PLAN_BOUNDS = (() => {
  const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
  for (const r of ROOMS) {
    if (!shownRoom(r)) continue;
    b.x0 = Math.min(b.x0, g2w(r.cols[0]) - CELL / 2);
    b.x1 = Math.max(b.x1, g2w(r.cols[1]) + CELL / 2);
    b.z0 = Math.min(b.z0, g2z(r.rows[0]) - CELL / 2);
    b.z1 = Math.max(b.z1, g2z(r.rows[1]) + CELL / 2);
  }
  return b;
})();

/** world (x, z) -> canvas (px, py), turned by rot so the reader's "ahead" is up. */
function planTransform(rot, box) {
  const b = PLAN_BOUNDS;
  const cx = (b.x0 + b.x1) / 2;
  const cz = (b.z0 + b.z1) / 2;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const W = b.x1 - b.x0;
  const H = b.z1 - b.z0;
  const hw = (Math.abs(c) * W + Math.abs(s) * H) / 2;
  const hh = (Math.abs(s) * W + Math.abs(c) * H) / 2;
  const k = Math.min(box.w / (2 * hw), box.h / (2 * hh));
  const ox = box.x + box.w / 2;
  const oy = box.y + box.h / 2;
  const P = (x, z) => {
    const dx = x - cx;
    const dz = z - cz;
    return [ox + k * (dx * c - dz * s), oy + k * (dx * s + dz * c)];
  };
  P.k = k;
  P.rot = rot;
  return P;
}

/** Rooms that get a name on the plan (corridors and links stay unlabelled). */
const PLAN_LABEL = {
  theater: "Screening Theatre",
  lobby: "Entrance Atrium",
  porch: "Entrance",
};

function roomFill(room) {
  if (EXHIBIT_HALLS.includes(room.id)) return mix(hex(room.accent), "#ffffff", 0.5);
  if (room.id === "theater") return mix(hex(room.accent), "#ffffff", 0.62);
  if (room.id === "lobby") return "#ebe3d2";
  if (room.id === "porch") return "#dde2e6";
  return "#e4ddcf";
}

/**
 * The plan inside `box`: halls in their accent colours, walls as dark
 * lines (doorways stay open), upright hall names and the red dot.
 */
function drawPlan(ctx, box, rot, here, sf) {
  const P = planTransform(rot, box);
  const rect = (x0, z0, x1, z1) => {
    const a = P(x0, z0);
    const b = P(x1, z1);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
  };

  // rooms
  for (const room of ROOMS) {
    if (!shownRoom(room)) continue;
    const [x, y, w, h] = rect(
      g2w(room.cols[0]) - CELL / 2,
      g2z(room.rows[0]) - CELL / 2,
      g2w(room.cols[1]) + CELL / 2,
      g2z(room.rows[1]) + CELL / 2
    );
    ctx.fillStyle = roomFill(room);
    ctx.fillRect(x, y, w, h);
  }

  // walls: every cell edge you cannot walk through
  ctx.strokeStyle = "#3b3833";
  ctx.lineCap = "square";
  ctx.lineWidth = Math.max(2, P.k * 0.55);
  ctx.beginPath();
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const room = roomOfCell(c, r);
      if (!shownRoom(room)) continue;
      const x0 = g2w(c) - CELL / 2;
      const z0 = g2z(r) - CELL / 2;
      const edges = [
        [c - 1, r, x0, z0, x0, z0 + CELL],
        [c + 1, r, x0 + CELL, z0, x0 + CELL, z0 + CELL],
        [c, r - 1, x0, z0, x0 + CELL, z0],
        [c, r + 1, x0, z0 + CELL, x0 + CELL, z0 + CELL],
      ];
      for (const [nc, nr, ax, az, bx, bz] of edges) {
        const other = roomOfCell(nc, nr);
        // a doorway into a secret room is drawn as wall: it gives nothing away
        if (passable(c, r, nc, nr) && shownRoom(other)) continue;
        const a = P(ax, az);
        const b = P(bx, bz);
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
      }
    }
  }
  ctx.stroke();

  // exhibits: small dots, like the plinths on a printed plan
  ctx.fillStyle = "rgba(60,52,44,0.45)";
  for (const p of PLACEMENTS) {
    if (!shownRoom(roomAt(p.x, p.z))) continue;
    const [x, y] = P(p.x, p.z);
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.5, 2.2 * sf), 0, TAU);
    ctx.fill();
  }

  // names, always upright
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const room of ROOMS) {
    if (!shownRoom(room)) continue;
    const name = EXHIBIT_HALLS.includes(room.id) ? room.name : PLAN_LABEL[room.id];
    if (!name) continue;
    const [x, y, w, h] = rect(
      g2w(room.cols[0]) - CELL / 2,
      g2z(room.rows[0]) - CELL / 2,
      g2w(room.cols[1]) + CELL / 2,
      g2z(room.rows[1]) + CELL / 2
    );
    const here2 = room.id === roomAt(here.x, here.z)?.id;
    labelInRect(ctx, name, x, y, w, h, Math.round(19 * sf), here2 ? "#7a1418" : "#2b2621");
  }

  // you are here
  const [hx, hy] = P(here.x, here.z);
  const r = 10 * sf;
  // the way you are facing: a soft wedge pointing up the map
  const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * 5.5);
  g.addColorStop(0, "rgba(215,38,46,0.42)");
  g.addColorStop(1, "rgba(215,38,46,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(hx, hy);
  ctx.arc(hx, hy, r * 5.5, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(215,38,46,0.2)";
  ctx.beginPath();
  ctx.arc(hx, hy, r * 2.1, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(hx, hy, r + 3.5 * sf, 0, TAU);
  ctx.fill();
  ctx.fillStyle = "#d7262e";
  ctx.beginPath();
  ctx.arc(hx, hy, r, 0, TAU);
  ctx.fill();
  // the label goes on whichever side has room
  ctx.font = `800 ${Math.round(21 * sf)}px ${FONT}`;
  const text = "You are here";
  const tw = ctx.measureText(text).width;
  const right = hx + r * 2.2 + tw < box.x + box.w - 4;
  const lx = right ? hx + r * 2.2 : hx - r * 2.2 - tw;
  const ly = hy - r * 2.1 > box.y + 14 * sf ? hy - r * 1.8 : hy + r * 1.8;
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.lineWidth = 5 * sf;
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.strokeText(text, lx, ly);
  ctx.fillStyle = "#c01d25";
  ctx.fillText(text, lx, ly);

  // north arrow in the top-right corner of the plan
  const nx = box.x + box.w - 26 * sf;
  const ny = box.y + 30 * sf;
  const dir = [Math.sin(rot), -Math.cos(rot)]; // world -z after the turn
  ctx.save();
  ctx.translate(nx, ny);
  ctx.rotate(Math.atan2(dir[0], -dir[1]));
  ctx.fillStyle = "#2b2621";
  ctx.beginPath();
  ctx.moveTo(0, -16 * sf);
  ctx.lineTo(7 * sf, 8 * sf);
  ctx.lineTo(0, 3 * sf);
  ctx.lineTo(-7 * sf, 8 * sf);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = "#2b2621";
  ctx.font = `800 ${Math.round(15 * sf)}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText("N", nx + dir[0] * 28 * sf, ny + dir[1] * 28 * sf + 1);
  return [hx, hy];
}

/** Shrink to fit, else wrap onto two or three lines, else skip (minimap rules). */
function labelInRect(ctx, text, x, y, w, h, size, color) {
  const maxW = w - 8;
  const maxH = h - 6;
  const words = text.split(" ");
  ctx.fillStyle = color;
  for (let s = size; s >= Math.max(10, size * 0.6); s -= 1) {
    ctx.font = `700 ${s}px ${FONT}`;
    const lines = [];
    for (const word of words) {
      const joined = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
      if (lines.length && ctx.measureText(joined).width <= maxW) lines[lines.length - 1] = joined;
      else lines.push(word);
    }
    const lh = s * 1.12;
    if (lines.length > 3 || lines.length * lh > maxH) continue;
    if (lines.some((l) => ctx.measureText(l).width > maxW)) continue;
    const top = y + h / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((l, i) => ctx.fillText(l, x + w / 2, top + i * lh));
    return true;
  }
  return false;
}

/** Halls in the legend, in tour order (the Grand Gallery spans them all). */
const LEGEND = ["triassic", "jurassic", "cretaceous", "predator", "marine", "rotunda"]
  .map((id) => HALLS[id])
  .filter((h) => h && h.band);

/**
 * One face of a totem (W x H px; the face is 0.9 x 1.654 m): a dark header
 * with the room you are in, the plan, the legend and a footer. Returns the
 * canvas and where the red dot ended up (0..1 of the face).
 */
function drawTotemFace(W, H, here, rot) {
  const c = canvas(W, H);
  const ctx = c.getContext("2d");
  const sf = W / 640;
  const room = roomAt(here.x, here.z);
  const accent = hex(room?.accent ?? 0xffd166);

  // body: warm paper under a soft backlight
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#f7f3ea");
  bg.addColorStop(1, "#ece6da");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // header
  const headH = Math.round(190 * sf);
  ctx.fillStyle = "#1e2125";
  ctx.fillRect(0, 0, W, headH);
  ctx.fillStyle = accent;
  ctx.fillRect(0, headH, W, Math.round(8 * sf));
  const pad = Math.round(40 * sf);
  ctx.fillStyle = "#d7262e";
  ctx.beginPath();
  ctx.arc(pad + 11 * sf, 64 * sf, 11 * sf, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3 * sf;
  ctx.stroke();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#f2ede4";
  ctx.font = `800 ${Math.round(28 * sf)}px ${FONT}`;
  setSpacing(ctx, 4 * sf);
  ctx.fillText("YOU ARE HERE", pad + 34 * sf, 65 * sf);
  setSpacing(ctx, 0);
  ctx.fillStyle = "#ffffff";
  fitFont(ctx, room?.name || "Museum", 800, Math.round(56 * sf), W - pad * 2);
  ctx.fillText(room?.name || "Museum", pad, 132 * sf);

  // the plan
  const mapTop = headH + Math.round(30 * sf);
  const mapBox = { x: pad - 8 * sf, y: mapTop, w: W - (pad - 8 * sf) * 2, h: Math.round(560 * sf) };
  ctx.fillStyle = "#fbf9f4";
  ctx.fillRect(mapBox.x, mapBox.y, mapBox.w, mapBox.h);
  const [dotX, dotY] = drawPlan(ctx, { x: mapBox.x + 12 * sf, y: mapBox.y + 12 * sf, w: mapBox.w - 24 * sf, h: mapBox.h - 24 * sf }, rot, here, sf);
  ctx.strokeStyle = "rgba(43,38,33,0.25)";
  ctx.lineWidth = 2 * sf;
  ctx.strokeRect(mapBox.x, mapBox.y, mapBox.w, mapBox.h);

  // legend: the halls and how long ago their animals lived
  let y = mapBox.y + mapBox.h + Math.round(42 * sf);
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#6b6257";
  ctx.font = `800 ${Math.round(17 * sf)}px ${FONT}`;
  setSpacing(ctx, 3 * sf);
  ctx.fillText("THE HALLS", pad, y);
  setSpacing(ctx, 0);
  y += Math.round(36 * sf);
  const rowH = Math.round(40 * sf);
  for (const hall of LEGEND) {
    ctx.fillStyle = mix(hall.accent, "#ffffff", 0.15);
    ctx.fillRect(pad, y - 12 * sf, 24 * sf, 24 * sf);
    ctx.fillStyle = "#2b2621";
    ctx.font = `700 ${Math.round(22 * sf)}px ${FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(hall.name, pad + 38 * sf, y);
    ctx.fillStyle = "#6b6257";
    ctx.font = `500 ${Math.round(20 * sf)}px ${FONT}`;
    ctx.textAlign = "right";
    const [a, b] = hall.band;
    ctx.fillText(b < 1 ? `${fmtMa(a)} Ma – Ice Age` : `${fmtMa(a)}–${fmtMa(b)} Ma`, W - pad, y);
    y += rowH;
  }
  // footer
  ctx.fillStyle = "#1e2125";
  const footH = Math.round(62 * sf);
  ctx.fillRect(0, H - footH, W, footH);
  ctx.fillStyle = "#c9c2b6";
  ctx.font = `500 ${Math.round(18 * sf)}px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("Ground floor · map turned the way you face", pad, H - footH / 2);
  ctx.textAlign = "right";
  ctx.fillText("Ma = million years ago", W - pad, H - footH / 2);
  return { canvas: c, dot: [dotX / W, dotY / H] };
}

/* ------------------------------------------------------------------ */
/* the hall introduction panel                                          */
/* ------------------------------------------------------------------ */

/** W x H px for a 2.4 x 1.5 m panel. */
function drawIntroPanel(W, H, hall) {
  const c = canvas(W, H);
  const ctx = c.getContext("2d");
  const sf = W / 1200;
  // dark, warm-lit from the picture light above
  ctx.fillStyle = "#181b1f";
  ctx.fillRect(0, 0, W, H);
  const lit = ctx.createRadialGradient(W / 2, -H * 0.35, H * 0.1, W / 2, -H * 0.35, H * 1.35);
  lit.addColorStop(0, "rgba(255,236,205,0.16)");
  lit.addColorStop(1, "rgba(255,236,205,0)");
  ctx.fillStyle = lit;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = hall.accent;
  ctx.fillRect(0, 0, Math.round(22 * sf), H);

  const x = Math.round(84 * sf);
  const maxW = W - x - Math.round(70 * sf);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  // era
  ctx.fillStyle = mix(hall.accent, "#ffffff", 0.25);
  ctx.font = `800 ${Math.round(28 * sf)}px ${FONT}`;
  setSpacing(ctx, 5 * sf);
  ctx.fillText(hall.era.toUpperCase(), x, Math.round(104 * sf));
  setSpacing(ctx, 0);
  // title
  ctx.fillStyle = "#ffffff";
  fitFont(ctx, hall.name, 800, Math.round(100 * sf), maxW);
  ctx.fillText(hall.name, x - 4 * sf, Math.round(208 * sf));
  // when
  ctx.fillStyle = "#ebe4d6";
  ctx.font = `500 ${Math.round(36 * sf)}px ${FONT}`;
  ctx.fillText(hall.bandText, x, Math.round(266 * sf));
  // introduction
  ctx.fillStyle = "#d6cfc1";
  ctx.font = `400 ${Math.round(33 * sf)}px ${FONT}`;
  const lines = wrap(ctx, hall.intro, maxW, 3);
  lines.forEach((l, i) => ctx.fillText(l, x, Math.round((338 + i * 47) * sf)));
  // who is in here
  const names = hall.species;
  let list = names.join(" · ");
  ctx.font = `500 ${Math.round(23 * sf)}px ${FONT}`;
  const label = "In this hall:  ";
  const lw = ctx.measureText(label).width;
  let shown = names.length;
  while (shown > 2 && ctx.measureText(list).width > maxW - lw) {
    shown -= 1;
    list = `${names.slice(0, shown).join(" · ")} and ${names.length - shown} more`;
  }
  const ly = Math.round((338 + lines.length * 47 + 30) * sf);
  ctx.fillStyle = "#9d9587";
  ctx.fillText(label, x, ly);
  ctx.fillStyle = "#c9c1b2";
  ctx.fillText(list, x + lw, ly);

  // deep time bar, 300 Ma -> today, with this hall's span bracketed
  const tx = x;
  const tw = maxW;
  const ty = Math.round(H - 150 * sf);
  const th = Math.round(26 * sf);
  const X = (ma) => tx + tw * (1 - Math.min(TIMELINE_START, ma) / TIMELINE_START);
  for (const p of PERIODS) {
    const a = X(Math.min(TIMELINE_START, p.from));
    const b = X(p.to);
    ctx.fillStyle = p.color;
    ctx.fillRect(a, ty, b - a, th);
  }
  if (hall.band) {
    const a = X(hall.band[0]);
    const b = Math.max(a + 6 * sf, X(hall.band[1]));
    ctx.fillStyle = "rgba(10,12,14,0.55)";
    ctx.fillRect(tx, ty, a - tx, th);
    ctx.fillRect(b, ty, tx + tw - b, th);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3 * sf;
    ctx.strokeRect(a, ty - 3 * sf, b - a, th + 6 * sf);
    // bracket label above
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 ${Math.round(21 * sf)}px ${FONT}`;
    const t = "THIS HALL";
    setSpacing(ctx, 3 * sf);
    const w = ctx.measureText(t).width;
    const mid = Math.min(tx + tw - w / 2, Math.max(tx + w / 2, (a + b) / 2));
    ctx.textAlign = "center";
    ctx.fillText(t, mid, ty - 14 * sf);
    setSpacing(ctx, 0);
  }
  // period names under the bar (the Cenozoic is too thin to split)
  ctx.textAlign = "center";
  ctx.font = `600 ${Math.round(20 * sf)}px ${FONT}`;
  ctx.fillStyle = "#b9b1a3";
  const named = [...PERIODS.slice(0, 4), { name: "Cenozoic", from: 66, to: 0 }];
  for (const p of named) ctx.fillText(p.name, (X(Math.min(TIMELINE_START, p.from)) + X(p.to)) / 2, ty + th + 32 * sf);
  ctx.font = `500 ${Math.round(17 * sf)}px ${FONT}`;
  ctx.fillStyle = "#8a8275";
  ctx.textAlign = "left";
  ctx.fillText("300 million years ago", tx, ty + th + 62 * sf);
  ctx.textAlign = "right";
  ctx.fillText("today", tx + tw, ty + th + 62 * sf);
  return c;
}

/* ------------------------------------------------------------------ */
/* placement                                                            */
/* ------------------------------------------------------------------ */

const boxHit = (a, b, m = 0) => a.minX < b.maxX + m && a.maxX > b.minX - m && a.minZ < b.maxZ + m && a.maxZ > b.minZ - m;

/** Bounding boxes of what already stands or hangs low in the scene. */
function sceneBoxes(roots, skip) {
  const out = [];
  const bb = new THREE.Box3();
  const m4 = new THREE.Matrix4();
  const IGNORE = new Set(["floor", "ceiling", "wall"]);
  const surfaceOf = (o) => {
    for (let n = o; n; n = n.parent) if (n.userData?.surface) return n.userData.surface;
    return null;
  };
  const visible = (o) => {
    for (let n = o; n; n = n.parent) if (!n.visible) return false;
    return true;
  };
  const push = (b, o) => {
    if (b.isEmpty() || b.min.y > 3.3 || b.max.y < 0.2) return;
    if (b.max.x - b.min.x > 24 || b.max.z - b.min.z > 24) return; // floors, whole-room batches
    out.push({ minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y, minZ: b.min.z, maxZ: b.max.z, name: o.name || o.parent?.name || "" });
  };
  for (const root of roots) {
    if (!root) continue;
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (o === skip || !o.isMesh || !o.geometry || o.isSkinnedMesh) return;
      for (let n = o; n; n = n.parent) if (n === skip) return;
      if (IGNORE.has(surfaceOf(o)) || !visible(o)) return;
      // lookdev's wainscot / mouldings / rails run along every wall: the
      // panel is mounted above the dado and between the pilasters instead
      if (/^lookdev-/.test(o.name)) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.every((m) => m && m.transparent && m.depthWrite === false)) return; // light pools, glows
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (o.isInstancedMesh) {
        if (o.count > 3000) return;
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, m4);
          push(bb.copy(o.geometry.boundingBox).applyMatrix4(m4).applyMatrix4(o.matrixWorld), o);
        }
        return;
      }
      push(bb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld), o);
    });
  }
  return out;
}

/** Doorways: { a, b (rooms), kind "h"|"v", line (x or z), lo, hi (span), cells } */
function doorways() {
  const map = new Map();
  for (let r = 0; r < GRID_H; r++) {
    for (let c = 0; c < GRID_W; c++) {
      const a = roomOfCell(c, r);
      if (!a) continue;
      for (const [nc, nr, kind] of [
        [c + 1, r, "h"],
        [c, r + 1, "v"],
      ]) {
        const b = roomOfCell(nc, nr);
        if (!b || b.id === a.id || !passable(c, r, nc, nr)) continue;
        const key = `${a.id}|${b.id}|${kind}`;
        if (!map.has(key)) map.set(key, { a, b, kind, cells: [] });
        map.get(key).cells.push([c, r]);
      }
    }
  }
  const out = [];
  for (const d of map.values()) {
    if (d.kind === "h") {
      const zs = d.cells.map(([, r]) => g2z(r));
      out.push({ ...d, line: g2w(d.cells[0][0]) + CELL / 2, lo: Math.min(...zs) - CELL / 2, hi: Math.max(...zs) + CELL / 2 });
    } else {
      const xs = d.cells.map(([c]) => g2w(c));
      out.push({ ...d, line: g2z(d.cells[0][1]) + CELL / 2, lo: Math.min(...xs) - CELL / 2, hi: Math.max(...xs) + CELL / 2 });
    }
  }
  return out;
}

/**
 * Wall bays of a room: one per cell edge that is a wall, with the face
 * centre (fx, fz), the inward normal (nx, nz) and ry for a plane that
 * looks along it.
 */
function wallBays(room) {
  const out = [];
  for (let c = room.cols[0]; c <= room.cols[1]; c++) {
    for (let r = room.rows[0]; r <= room.rows[1]; r++) {
      for (const [dc, dr] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (passable(c, r, c + dc, r + dr)) continue;
        const nx = -dc;
        const nz = -dr;
        const lx = g2w(c) + (dc * CELL) / 2; // the wall line
        const lz = g2z(r) + (dr * CELL) / 2;
        out.push({ room, c, r, nx, nz, lx, lz, ry: Math.atan2(nx, nz) });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* main entry                                                           */
/* ------------------------------------------------------------------ */

export function buildWayfinding(group, world, { scene = null, renderer = null, quality = "high" } = {}) {
  const low = quality === "low";
  const root = new THREE.Group();
  root.name = "wayfinding";
  root.userData.surface = "skip";
  (group || scene).add(root);

  const report = { totems: [], panels: [], moved: [], skipped: [] };
  const interactables = [];
  const obstacles = [];
  const pulses = [];
  const textures = [];
  let infoMaterial = null;
  let washMaterial = null;

  // what is already there: the world, props.js, live models, other dressing
  // (not the whole scene: visitors and avatars wander about and would make
  // the placement depend on where they happened to be standing)
  const sceneRoot = scene || (group && group.parent) || null;
  const roots = [world?.group || group, sceneRoot?.getObjectByName("props"), sceneRoot?.getObjectByName("live-models")];
  const blockers = sceneBoxes([...new Set(roots.filter(Boolean))], root);
  const floorBoxes = () => [
    ...OBSTACLES,
    ...PROP_OBSTACLES,
    ...(world?.displays || DISPLAYS || []).map((d) => d.bounds).filter(Boolean),
  ];
  const placedBoxes = [];
  const doors = doorways();

  /* ---------------- materials ---------------- */
  const mat = {
    body: new THREE.MeshStandardMaterial({ color: 0x26282c, roughness: 0.5, metalness: 0.45 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xa7acb2, roughness: 0.32, metalness: 0.9 }),
    base: new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.6, metalness: 0.5 }),
    frame: new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.55, metalness: 0.4 }),
    lampLight: new THREE.MeshBasicMaterial({ color: 0xfff1d6, toneMapped: false }),
  };
  const glowTex = (() => {
    const c = canvas(128, 128);
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,244,222,0.55)");
    g.addColorStop(0.5, "rgba(255,244,222,0.18)");
    g.addColorStop(1, "rgba(255,244,222,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    textures.push(t);
    return t;
  })();
  const glowMat = new THREE.MeshBasicMaterial({
    map: glowTex,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const dotMat = new THREE.MeshBasicMaterial({
    color: 0xff2a33,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });

  const tag = (o) => {
    o.userData.surface = "skip";
    return o;
  };

  /* ---------------- totems ---------------- */
  const FACE_W = 0.9;
  const FACE_H = 1.654;
  const TOTEM_W = 1.04;
  const TOTEM_D = 0.2;
  const TOTEM_H = 2.3;
  const PLATE = { w: 1.2, d: 0.46, h: 0.05 };
  const faceSize = low ? [384, 706] : [640, 1176];

  function totemBox(x, z, ry) {
    const alongX = Math.abs(Math.sin(ry)) < 0.5;
    const hx = (alongX ? PLATE.w : PLATE.d) / 2 + 0.04;
    const hz = (alongX ? PLATE.d : PLATE.w) / 2 + 0.04;
    return { minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz };
  }

  function totemClear(spot, x, z) {
    const box = totemBox(x, z, spot.ry);
    // whole footprint plus reading room in the same room
    for (const [px, pz] of [
      [box.minX - 1, box.minZ - 1],
      [box.maxX + 1, box.minZ - 1],
      [box.minX - 1, box.maxZ + 1],
      [box.maxX + 1, box.maxZ + 1],
    ]) {
      if (roomAt(px, pz)?.id !== spot.room) return false;
    }
    // walls: at least 1.2 m to any cell edge you cannot walk through
    for (let cz = w2gz(box.minZ - 1.2); cz <= w2gz(box.maxZ + 1.2); cz++) {
      for (let cx = w2g(box.minX - 1.2); cx <= w2g(box.maxX + 1.2); cx++) {
        if (isSolid(cx, cz)) {
          const cell = { minX: g2w(cx) - CELL / 2, maxX: g2w(cx) + CELL / 2, minZ: g2z(cz) - CELL / 2, maxZ: g2z(cz) + CELL / 2 };
          if (boxHit(box, cell, 1.2)) return false;
        }
      }
    }
    // keep doorways and the space in front of them free
    for (const d of doors) {
      const db =
        d.kind === "h"
          ? { minX: d.line - 2.5, maxX: d.line + 2.5, minZ: d.lo, maxZ: d.hi }
          : { minX: d.lo, maxX: d.hi, minZ: d.line - 2.5, maxZ: d.line + 2.5 };
      if (boxHit(box, db, 0.6)) return false;
    }
    if (floorBoxes().some((o) => boxHit(box, o, 1.4))) return false;
    if (blockers.some((o) => o.maxY > 0.2 && o.minY < 2.6 && boxHit(box, o, 1.2))) return false;
    if (placedBoxes.some((o) => boxHit(box, o, 2))) return false;
    // do not sit on top of someone else's E prompt
    for (const it of world?.interactables || []) {
      if (it.type === "exhibit") continue;
      if (Number.isFinite(it.x) && Math.hypot(it.x - x, it.z - z) < Math.min(3, (it.radius || 1) + 0.6)) return false;
    }
    return true;
  }

  function placeTotem(spot) {
    let x = spot.x;
    let z = spot.z;
    if (!totemClear(spot, x, z)) {
      const tries = [];
      for (let dx = -4; dx <= 4; dx += 0.25) for (let dz = -4; dz <= 4; dz += 0.25) tries.push([dx, dz, dx * dx + dz * dz]);
      tries.sort((a, b) => a[2] - b[2]);
      const hit = tries.find(([dx, dz]) => totemClear(spot, spot.x + dx, spot.z + dz));
      if (!hit) {
        report.skipped.push(`totem:${spot.id} (no clear floor near ${spot.x}, ${spot.z})`);
        return;
      }
      x = spot.x + hit[0];
      z = spot.z + hit[1];
      report.moved.push(`totem:${spot.id} -> ${x.toFixed(2)}, ${z.toFixed(2)}`);
    }

    const g = new THREE.Group();
    g.name = `way-totem-${spot.id}`;
    g.position.set(x, 0, z);
    g.rotation.y = spot.ry;
    tag(g);

    const plate = new THREE.Mesh(new THREE.BoxGeometry(PLATE.w, PLATE.h, PLATE.d), mat.base);
    plate.position.y = PLATE.h / 2;
    const body = new THREE.Mesh(new THREE.BoxGeometry(TOTEM_W, TOTEM_H - PLATE.h, TOTEM_D), mat.body);
    body.position.y = PLATE.h + (TOTEM_H - PLATE.h) / 2;
    const cap = new THREE.Mesh(new THREE.BoxGeometry(TOTEM_W + 0.03, 0.035, TOTEM_D + 0.03), mat.steel);
    cap.position.y = TOTEM_H + 0.0175;
    for (const m of [plate, body, cap]) {
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(tag(m));
    }
    for (const s of [-1, 1]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.025, TOTEM_H - PLATE.h, TOTEM_D + 0.01), mat.steel);
      edge.position.set(s * (TOTEM_W / 2 + 0.0125), body.position.y, 0);
      g.add(tag(edge));
    }

    // the two backlit faces, each with its own heading-up map
    const faceY = PLATE.h + 0.32 + FACE_H / 2;
    for (const side of [1, -1]) {
      const ry = spot.ry + (side > 0 ? 0 : Math.PI);
      const face = drawTotemFace(faceSize[0], faceSize[1], { x, z }, ry);
      const tex = texture(face.canvas, renderer);
      textures.push(tex);
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(FACE_W, FACE_H),
        new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(0.93, 0.93, 0.93) })
      );
      m.position.set(0, faceY, side * (TOTEM_D / 2 + 0.003));
      m.rotation.y = side > 0 ? 0 : Math.PI;
      g.add(tag(m));
      // a pulsing light behind the red dot
      const [u, v] = face.dot;
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.03, 20), dotMat.clone());
      const lx = (u - 0.5) * FACE_W;
      dot.position.set(side * lx, faceY + (0.5 - v) * FACE_H, side * (TOTEM_D / 2 + 0.006));
      dot.rotation.y = m.rotation.y;
      g.add(tag(dot));
      pulses.push(dot);
      // an "i" lightbox above the face
      const info = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.16), infoMat());
      info.position.set(0, TOTEM_H - 0.13, side * (TOTEM_D / 2 + 0.003));
      info.rotation.y = m.rotation.y;
      g.add(tag(info));
    }

    // a soft spill of light on the floor in front of both faces
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3.2), glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.012;
    glow.renderOrder = 1;
    g.add(tag(glow));

    root.add(g);
    const box = { id: `way:totem-${spot.id}`, ...totemBox(x, z, spot.ry) };
    OBSTACLES.push(box);
    obstacles.push(box);
    placedBoxes.push(box);
    const room = roomAt(x, z);
    interactables.push({
      id: `totem:${spot.id}`,
      type: "totem",
      totem: spot.id,
      room: room?.id,
      roomName: room?.name,
      x,
      z,
      radius: 2.3,
      label: "Read the museum map",
      key: "E",
    });
    report.totems.push({ id: spot.id, x, z, ry: spot.ry, room: room?.id });
  }

  function infoMat() {
    if (infoMaterial) return infoMaterial;
    const c = canvas(128, 128);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#1e2125";
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = "#f2ede4";
    ctx.beginPath();
    ctx.arc(64, 64, 52, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "#1e2125";
    ctx.font = `800 78px Georgia, "Times New Roman", serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("i", 64, 68);
    const t = texture(c, renderer);
    textures.push(t);
    infoMaterial = new THREE.MeshBasicMaterial({ map: t, toneMapped: false });
    return infoMaterial;
  }

  for (const spot of TOTEMS) placeTotem(spot);

  /* ---------------- hall intro panels ---------------- */
  const PANEL_W = 2.4;
  const PANEL_H = 1.5;
  const PANEL_BOTTOM = 1.34; // above lookdev's dado rail (1.26 m)
  const WALL_FACE = 0.2; // wall slabs are 0.4 thick
  const panelPx = low ? [840, 525] : [1200, 750];
  const hallMaterials = new Map();
  function hallMaterial(id) {
    if (!hallMaterials.has(id)) {
      const tex = texture(drawIntroPanel(panelPx[0], panelPx[1], HALLS[id]), renderer);
      textures.push(tex);
      hallMaterials.set(id, new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, color: new THREE.Color(0.95, 0.95, 0.95) }));
    }
    return hallMaterials.get(id);
  }

  /** Floor box of a panel on a bay, reaching `out` metres into the room. */
  function bayBox(bay, out, half = PANEL_W / 2) {
    const fx = bay.lx + bay.nx * WALL_FACE;
    const fz = bay.lz + bay.nz * WALL_FACE;
    const ax = bay.nz !== 0; // the wall runs along x
    const cx = ax ? g2w(bay.c) : fx;
    const cz = ax ? fz : g2z(bay.r);
    const ex = fx + bay.nx * out;
    const ez = fz + bay.nz * out;
    return ax
      ? { minX: cx - half, maxX: cx + half, minZ: Math.min(fz, ez), maxZ: Math.max(fz, ez) }
      : { minX: Math.min(fx, ex), maxX: Math.max(fx, ex), minZ: cz - half, maxZ: cz + half };
  }

  function bayClear(bay) {
    const slab = bayBox(bay, 0.75, PANEL_W / 2 + 0.25);
    for (const b of blockers) {
      if (b.maxY < PANEL_BOTTOM - 0.25 || b.minY > PANEL_BOTTOM + PANEL_H + 0.45) continue;
      if (boxHit(slab, b)) return false;
    }
    const floor = bayBox(bay, 1.8, PANEL_W / 2 + 0.2);
    if (floorBoxes().some((o) => boxHit(floor, o))) return false;
    if (placedBoxes.some((o) => boxHit(floor, o, 0.6))) return false;
    // not right next to a doorway's casing: the wall either side must be wall
    return true;
  }

  /**
   * Candidate bays for one doorway into `hall` from `outside`, best first:
   * (a) on the outside room's door wall beside the opening, facing the
   * visitors on their way in; (b) on a side wall of the corridor or link
   * leading up to it; (c) just inside the hall on its door wall.
   */
  function candidates(door, hall, outside) {
    const list = [];
    const into = door.kind === "h" ? Math.sign(g2w(hall.cols[0]) - door.line) : Math.sign(g2z(hall.rows[0]) - door.line);
    const along = (bay) => (door.kind === "h" ? g2z(bay.r) : g2w(bay.c));
    const across = (bay) => (door.kind === "h" ? g2w(bay.c) : g2z(bay.r));
    const gap = (bay) => {
      const a = along(bay);
      return a < door.lo ? door.lo - a : a > door.hi ? a - door.hi : -1;
    };
    // the doorway's own cells (its casings) are never used
    for (const bay of wallBays(outside)) {
      const normalAlong = door.kind === "h" ? bay.nx : bay.nz; // facing across the door line
      const dist = Math.abs(across(bay) - door.line);
      // (a) the door wall itself, facing away from the hall
      if (normalAlong === -into && Math.abs(dist - CELL / 2) < 0.01 && gap(bay) > 0) {
        list.push({ bay, score: gap(bay) });
      }
      // (b) side walls next to the opening: corridor and link walls
      if (normalAlong === 0 && isPassage(outside) && dist <= CELL * 1.5 + 0.01 && gap(bay) < 0) {
        list.push({ bay, score: 6 + dist });
      }
    }
    for (const bay of wallBays(hall)) {
      const normalAlong = door.kind === "h" ? bay.nx : bay.nz;
      const dist = Math.abs(across(bay) - door.line);
      if (normalAlong === into && Math.abs(dist - CELL / 2) < 0.01 && gap(bay) > 0) {
        list.push({ bay, score: 40 + gap(bay) });
      }
    }
    // never on a wall shared with a secret room's doorway, nor on a bay
    // whose far side is a doorway (the casing pokes into the panel)
    return list.sort((a, b) => a.score - b.score);
  }

  const usedBays = new Set();
  for (const door of doors) {
    for (const [hall, outside] of [
      [door.a, door.b],
      [door.b, door.a],
    ]) {
      if (!EXHIBIT_HALLS.includes(hall.id) || !HALLS[hall.id]) continue;
      if (outside.secret || hall.secret) continue;
      const pick = candidates(door, hall, outside).find(({ bay }) => {
        const k = `${bay.c},${bay.r},${bay.nx},${bay.nz}`;
        return !usedBays.has(k) && bayClear(bay);
      });
      if (!pick) {
        report.skipped.push(`intro:${hall.id} from ${outside.id} (no clear wall)`);
        continue;
      }
      const { bay } = pick;
      usedBays.add(`${bay.c},${bay.r},${bay.nx},${bay.nz}`);
      addPanel(hall.id, outside.id, bay);
    }
  }

  function addPanel(hallId, fromId, bay) {
    const g = new THREE.Group();
    g.name = `way-intro-${hallId}-${fromId}`;
    const ax = bay.nz !== 0;
    const fx = ax ? g2w(bay.c) : bay.lx + bay.nx * WALL_FACE;
    const fz = ax ? bay.lz + bay.nz * WALL_FACE : g2z(bay.r);
    g.position.set(fx, 0, fz);
    g.rotation.y = bay.ry;
    tag(g);

    const cy = PANEL_BOTTOM + PANEL_H / 2;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(PANEL_W + 0.06, PANEL_H + 0.06, 0.05), mat.frame);
    frame.position.set(0, cy, 0.025);
    g.add(tag(frame));
    const face = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W, PANEL_H), hallMaterial(hallId));
    face.position.set(0, cy, 0.052);
    g.add(tag(face));
    // picture light: two arms and a slim bar with a warm strip underneath
    const top = PANEL_BOTTOM + PANEL_H;
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.05, 0.07), mat.base);
    bar.position.set(0, top + 0.2, 0.36);
    g.add(tag(bar));
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.025), mat.lampLight);
    strip.rotation.x = Math.PI / 2;
    strip.position.set(0, top + 0.174, 0.36);
    g.add(tag(strip));
    for (const s of [-0.55, 0.55]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.36), mat.base);
      arm.position.set(s, top + 0.2, 0.18);
      g.add(tag(arm));
    }
    // the light the lamp throws on the panel and the wall below it
    const wash = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W + 0.9, PANEL_H + 0.7), washMat());
    wash.position.set(0, cy + 0.12, 0.056);
    wash.renderOrder = 2;
    g.add(tag(wash));
    root.add(g);

    const floor = bayBox(bay, 1.2);
    placedBoxes.push(floor);
    const nx = bay.nx;
    const nz = bay.nz;
    interactables.push({
      id: `intro:${hallId}:${fromId}`,
      type: "intro",
      hall: hallId,
      x: fx + nx * 1.6,
      z: fz + nz * 1.6,
      radius: 2.2,
      label: `Read about the ${HALLS[hallId].name}`,
      key: "E",
    });
    report.panels.push({ hall: hallId, from: fromId, x: +fx.toFixed(2), z: +fz.toFixed(2), ry: +bay.ry.toFixed(3) });
  }

  function washMat() {
    if (washMaterial) return washMaterial;
    const c = canvas(128, 128);
    const ctx = c.getContext("2d");
    const g = ctx.createRadialGradient(64, -30, 10, 64, -30, 150);
    g.addColorStop(0, "rgba(255,238,210,0.32)");
    g.addColorStop(0.55, "rgba(255,238,210,0.08)");
    g.addColorStop(1, "rgba(255,238,210,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    textures.push(t);
    washMaterial = new THREE.MeshBasicMaterial({
      map: t,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    return washMaterial;
  }

  if (report.moved.length || report.skipped.length) {
    console.info("[wayfinding]", { moved: report.moved, skipped: report.skipped });
  }

  /* ---------------- runtime ---------------- */
  let t = 0;
  function update(dt = 1 / 60) {
    t += dt;
    const k = 0.5 + 0.5 * Math.sin(t * 3.2);
    for (const d of pulses) {
      d.material.opacity = 0.25 + 0.55 * k;
      d.scale.setScalar(1 + 0.6 * k);
    }
  }

  /** Text for the E key: { title, html } for a ui.modal. */
  function describe(it) {
    if (it?.type === "intro") {
      const h = HALLS[it.hall];
      if (!h) return null;
      return {
        title: h.name,
        html: `
          <h2>${h.name}</h2>
          <p class="lead">${h.era} · ${h.bandText}</p>
          <p class="quote">${h.intro}<span class="who">In this hall: ${h.species.join(", ")}</span></p>
          <div class="row actions"><button class="primary" id="wayClose">Close</button></div>`,
      };
    }
    if (it?.type === "totem") {
      const rows = LEGEND.map((h) => `<b>${h.name}</b> · ${h.bandText}`).join("<br>");
      return {
        title: "Museum map",
        html: `
          <h2>🗺️ You are here: ${it.roomName || "the museum"}</h2>
          <p class="quote">${rows}</p>
          <div class="row actions"><button class="primary" id="wayClose">Close</button></div>`,
      };
    }
    return null;
  }

  function dispose() {
    for (const o of obstacles) {
      const i = OBSTACLES.indexOf(o);
      if (i >= 0) OBSTACLES.splice(i, 1);
    }
    root.parent?.remove(root);
    root.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
      }
    });
    textures.forEach((x) => x.dispose());
  }

  return { group: root, interactables, obstacles, halls: HALLS, report, update, describe, dispose };
}
