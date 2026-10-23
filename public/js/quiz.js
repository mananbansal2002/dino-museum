/**
 * Hall quizzes: a lit kiosk beside the way out of every exhibit hall and a
 * three-question multiple-choice quiz about the animals in that hall.
 *
 *   initQuiz({ toast, onComplete, onOpen, onClose })   once, from main.js
 *   buildQuizKiosks(group, world)  the kiosks; returns { group, kiosks,
 *                                  interactables, obstacles, update(t), dispose() }
 *   openQuiz(hallId)               the quiz modal (hallId: triassic, jurassic,
 *                                  cretaceous, marine, predator, rotunda)
 *   isQuizOpen() / closeQuiz()
 *   buildQuestions(hallId, opts)   the questions alone (no DOM), for tests
 *
 * Every question comes from species.js and nothing else: the era, the diet,
 * the length (or weight) and one of the facts of an animal mounted in that
 * hall (EXHIBIT_PANELS). Wrong answers are the same field of other animals,
 * chosen so that they can never also be right: a different era, a diet with
 * no overlap, a size range well clear of the real one, an animal of another
 * body plan.
 *
 * The kiosks only ever stand in the six exhibit halls, never by the doorway
 * to the Exit Passage, and nothing here names the secret rooms.
 */
import * as THREE from "three";
import { SPECIES } from "./species.js";
import {
  ROOMS,
  OPEN,
  CELL,
  EXHIBIT_PANELS,
  OBSTACLES,
  PROP_OBSTACLES,
  DISPLAYS,
  ERA_WINDOWS,
  HALL_LABEL,
  g2w,
  g2z,
  w2g,
  w2gz,
  roomAt,
  passable,
} from "./world.js";
import { makeCanvas } from "./util.js";

/** The quiz halls, in tour order, and the doorway (neighbouring room) each kiosk prefers. */
export const QUIZ_HALLS = ["triassic", "jurassic", "cretaceous", "predator", "marine", "rotunda"];
const PREFERRED_DOOR = {
  triassic: ["wcorridor", "predator", "wc2"],
  jurassic: ["ecorridor", "ec2"],
  cretaceous: ["predator", "wc2", "cwcorridor"],
  predator: ["rotunda", "triassic", "cretaceous"],
  marine: ["ec2", "necorridor"],
  rotunda: ["scorridor", "wcorridor", "ecorridor", "ncorridor", "predator"],
};
const ALIAS = { gallery: "rotunda", "grand-gallery": "rotunda", grandgallery: "rotunda", predatorbay: "predator" };
const QUESTIONS_PER_QUIZ = 3;
const STORE_KEY = "museum.quiz.v1";
const FONT = "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

const ROOM = Object.fromEntries(ROOMS.map((r) => [r.id, r]));
const hex = (n) => `#${(n ?? 0xffc857).toString(16).padStart(6, "0")}`;
const hallName = (id) => HALL_LABEL[id] || ROOM[id]?.name || id;
const normHall = (id) => {
  const k = String(id || "").toLowerCase().replace(/\s+/g, "");
  return ALIAS[k] || k;
};

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/* ------------------------------------------------------------------ */
/* hall catalogue                                                       */
/* ------------------------------------------------------------------ */

/** Species mounted in a hall (where the panel physically stands, not species.hall). */
export function hallSpecies(hallId) {
  const hall = normHall(hallId);
  return EXHIBIT_PANELS.filter((p) => p.room === hall && SPECIES[p.id]?.info).map((p) => SPECIES[p.id]);
}

/** Everything on show anywhere in the museum, the distractor pool. */
const ON_SHOW = (() => {
  const seen = new Set();
  const out = [];
  for (const p of EXHIBIT_PANELS) {
    const s = SPECIES[p.id];
    if (!s?.info || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
})();

/* ------------------------------------------------------------------ */
/* field parsing                                                        */
/* ------------------------------------------------------------------ */

/** "c. 227–209 million years ago" -> 218 (Ma); "c. 0.8 million – 11,000 years ago" -> 0.8. */
function periodMa(text) {
  const m = /(\d+(?:\.\d+)?)(?:\s*[–-]\s*(\d+(?:\.\d+)?))?\s*million/.exec(String(text || ""));
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = m[2] ? parseFloat(m[2]) : a;
  return (a + b) / 2;
}

/** Mean age of every era named in the catalogue, so eras can be ordered and "near" ones picked. */
const ERA_AGE = (() => {
  const acc = new Map();
  for (const s of Object.values(SPECIES)) {
    const era = s.info?.era;
    const ma = periodMa(s.info?.period);
    if (!era || ma == null) continue;
    const a = acc.get(era) || { sum: 0, n: 0 };
    a.sum += ma;
    a.n++;
    acc.set(era, a);
  }
  return new Map([...acc].map(([era, a]) => [era, a.sum / a.n]));
})();

/**
 * Diet words -> categories. A fish-eater or a "marine predator" is also a
 * meat-eater, so a Piscivore is never offered as the wrong answer for a
 * Carnivore. Two diets are distinct only when their categories do not overlap.
 */
function dietKeys(diet) {
  const s = String(diet || "").toLowerCase();
  const k = new Set();
  if (/herbivore/.test(s)) k.add("H");
  if (/omnivore/.test(s)) k.add("O");
  if (/carnivore/.test(s)) k.add("C");
  if (/piscivore/.test(s)) (k.add("P"), k.add("C"));
  if (/predator/.test(s)) (k.add("C"), k.add("P"));
  return k;
}
const disjoint = (a, b) => [...a].every((x) => !b.has(x));

/** Numbers in a size string -> [lo, hi] in base units (m or kg); null when unusable. */
function sizeRange(text, kind) {
  const s = String(text || "");
  if (kind === "length" && /wingspan/i.test(s)) return null;
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
  if (!nums.length) return null;
  const k = kind === "weight" && /tonne/i.test(s) ? 1000 : 1;
  return [Math.min(...nums) * k, Math.max(...nums) * k];
}
const SIZE_GAP = 1.5; // a wrong size is at least 1.5x off the real range
const clearOf = (a, b) => a[1] * SIZE_GAP < b[0] || a[0] > b[1] * SIZE_GAP;
const midLog = (r) => Math.log((r[0] + r[1]) / 2);

/* ------------------------------------------------------------------ */
/* question builders                                                    */
/* ------------------------------------------------------------------ */

function shuffle(list, rng) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function notDino(s) {
  return s.info.notDinosaur && s.info.notDinoNote ? ` ${s.info.notDinoNote}` : "";
}

/** "When did X live?" — the three eras nearest in time, oldest first. */
function eraQuestion(s, rng) {
  const era = s.info.era;
  const age = ERA_AGE.get(era);
  if (!era || age == null) return null;
  const others = [...ERA_AGE.keys()].filter((e) => e !== era);
  if (others.length < 3) return null;
  // nearest in time are the plausible ones; break ties randomly
  const pool = shuffle(others, rng).sort((a, b) => Math.abs(ERA_AGE.get(a) - age) - Math.abs(ERA_AGE.get(b) - age));
  const options = [era, ...pool.slice(0, 3)].sort((a, b) => ERA_AGE.get(b) - ERA_AGE.get(a));
  return {
    kind: "era",
    speciesId: s.id,
    prompt: `When did <b>${escapeHtml(s.name)}</b> live?`,
    options,
    answer: options.indexOf(era),
    explain: `${s.name} lived in the ${era}${s.info.period ? `, ${s.info.period}` : ""}.${notDino(s)}`,
  };
}

/** "What did X eat?" — diets with no category in common with the real one. */
function dietQuestion(s, rng) {
  const diet = s.info.diet;
  const keys = dietKeys(diet);
  if (!diet || !keys.size) return null;
  // wrong answers are the plain one-word diets ("Herbivore", "Omnivore"...),
  // one per category set, so no two of them say nearly the same thing
  const groups = new Map();
  for (const o of ON_SHOW) {
    const d = o.info.diet;
    const k = dietKeys(d);
    if (!d || !/^[A-Za-z]+$/.test(d) || !k.size || !disjoint(k, keys)) continue;
    const id = [...k].sort().join("");
    if (!groups.has(id) || d.length < groups.get(id).length) groups.set(id, d);
  }
  const wrong = shuffle([...groups.values()], rng).slice(0, 3);
  if (wrong.length < 2) return null;
  const options = shuffle([diet, ...wrong], rng);
  return {
    kind: "diet",
    speciesId: s.id,
    prompt: `What did <b>${escapeHtml(s.name)}</b> eat?`,
    options,
    answer: options.indexOf(diet),
    explain: `${s.name}: ${diet}.${notDino(s)}`,
  };
}

/** "How long (heavy) was X?" — other animals' sizes well clear of the real one, smallest first. */
function sizeQuestion(s, rng) {
  // length first; weight for the flyers, whose "length" is a wingspan
  for (const kind of ["length", "weight"]) {
    const text = s.info[kind];
    const range = sizeRange(text, kind);
    if (!range) continue;
    const seen = new Set([text]);
    const cands = [];
    for (const o of shuffle(ON_SHOW, rng)) {
      const t = o.info[kind];
      if (!t || seen.has(t)) continue;
      const r = sizeRange(t, kind);
      if (!r || !clearOf(r, range)) continue;
      seen.add(t);
      cands.push({ t, r });
    }
    cands.sort((a, b) => Math.abs(midLog(a.r) - midLog(range)) - Math.abs(midLog(b.r) - midLog(range)));
    const picked = [];
    for (const c of cands) {
      if (picked.length === 3) break;
      // the wrong answers must not overlap each other either
      if (picked.every((p) => clearOf(p.r, c.r) || clearOf(c.r, p.r))) picked.push(c);
    }
    if (picked.length < 3) continue;
    const all = [{ t: text, r: range }, ...picked].sort((a, b) => a.r[0] - b.r[0]);
    const options = all.map((o) => o.t);
    return {
      kind: "size",
      speciesId: s.id,
      prompt:
        kind === "length"
          ? `About how long was <b>${escapeHtml(s.name)}</b>?`
          : `About how much did <b>${escapeHtml(s.name)}</b> weigh?`,
      options,
      answer: options.indexOf(text),
      explain: `${s.name}: ${s.info.length} long, ${s.info.weight}.`,
    };
  }
  return null;
}

/** Ways a fact may name its own animal: "Tyrannosaurus rex", "Tyrannosaurus", "T. rex". */
function namePatterns(s) {
  const words = new Set([s.name]);
  const genus = String(s.info.latin || s.name).split(/\s+/)[0];
  if (genus) words.add(genus);
  const parts = s.name.split(/\s+/);
  if (parts.length > 1) words.add(`${parts[0][0]}. ${parts.slice(1).join(" ")}`);
  return [...words].sort((a, b) => b.length - a.length).map((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));
}
const mentions = (text, s) => namePatterns(s).some((re) => (re.lastIndex = 0, re.test(text)));

/**
 * "Which animal is this about?" — one of X's facts with its name blanked.
 * The other options eat something else entirely, or are built differently
 * (another body plan and head), so the fact cannot fit them as well; an
 * animal the fact itself names is never offered. Hall-mates go first.
 */
function factQuestion(s, rng, hallList) {
  const facts = (s.info.facts || []).filter((f) => !/ice cream|gelato|exit passage|\bcourt\b/i.test(f));
  if (!facts.length) return null;
  const fact = facts[Math.floor(rng() * facts.length)];
  let shown = fact;
  for (const re of namePatterns(s)) shown = shown.replace(re, "___");
  const blank = shown !== fact;
  const keys = dietKeys(s.info.diet);
  const unlike = (o) =>
    o.id !== s.id &&
    !mentions(fact, o) &&
    (disjoint(dietKeys(o.info.diet), keys) || (o.plan !== s.plan && o.headType !== s.headType));
  const near = shuffle(hallList.filter(unlike), rng);
  const far = shuffle(ON_SHOW.filter((o) => unlike(o) && !hallList.includes(o)), rng);
  const wrong = [...near, ...far].slice(0, 3);
  if (wrong.length < 3) return null;
  const options = shuffle([s, ...wrong], rng).map((o) => o.name);
  return {
    kind: "fact",
    speciesId: s.id,
    prompt: blank ? "Which animal fills the blank?" : "Which animal is this about?",
    quote: shown,
    options,
    answer: options.indexOf(s.name),
    explain: `That's ${s.name}: ${fact}`,
  };
}

const BUILDERS = { era: eraQuestion, diet: dietQuestion, size: sizeQuestion, fact: factQuestion };

/**
 * Three questions about a hall: three different kinds (era, diet, size,
 * fact), each about a different animal when the hall has enough of them.
 * opts.rng: a () => [0,1) for repeatable tests. opts.count: how many.
 */
export function buildQuestions(hallId, opts = {}) {
  const rng = opts.rng || Math.random;
  const count = opts.count || QUESTIONS_PER_QUIZ;
  const list = hallSpecies(hallId);
  if (!list.length) return [];
  const out = [];
  const used = new Set();
  const kinds = shuffle(Object.keys(BUILDERS), rng);
  // first pass one kind per question; then any kind, if a hall runs short
  for (const pass of [0, 1]) {
    for (const kind of pass ? shuffle(Object.keys(BUILDERS), rng) : kinds) {
      if (out.length >= count) break;
      if (!pass && out.some((q) => q.kind === kind)) continue;
      const subjects = [...shuffle(list.filter((s) => !used.has(s.id)), rng), ...shuffle(list.filter((s) => used.has(s.id)), rng)];
      for (const s of subjects) {
        const q = BUILDERS[kind](s, rng, list);
        if (!q || q.answer < 0) continue;
        if (out.some((o) => o.kind === q.kind && o.speciesId === q.speciesId)) continue;
        used.add(s.id);
        out.push(q);
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* best scores (per browser, a convenience only)                        */
/* ------------------------------------------------------------------ */

function loadBest() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}
function saveBest(best) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(best));
  } catch {
    /* private window: the score just isn't remembered */
  }
}
const best = loadBest();
export const quizBest = (hallId) => best[normHall(hallId)] || 0;

/* ------------------------------------------------------------------ */
/* kiosks                                                               */
/* ------------------------------------------------------------------ */

/** Doorways of a hall: { to, x, z, nx, nz, tx, tz, half } with n pointing into the hall. */
function hallDoors(hallId) {
  const doors = new Map();
  for (const key of OPEN) {
    const m = /^([vh]):(\d+),(\d+)$/.exec(key);
    if (!m) continue;
    const c = +m[2];
    const r = +m[3];
    const [ac, ar, bc, br] = m[1] === "v" ? [c, r, c, r + 1] : [c, r, c + 1, r];
    const a = roomAt(g2w(ac), g2z(ar));
    const b = roomAt(g2w(bc), g2z(br));
    if (!a || !b || a.id === b.id) continue;
    let inSide;
    let other;
    if (a.id === hallId) [inSide, other] = [-1, b];
    else if (b.id === hallId) [inSide, other] = [1, a];
    else continue;
    const v = m[1] === "v";
    const x = v ? g2w(c) : g2w(c) + CELL / 2;
    const z = v ? g2z(r) + CELL / 2 : g2z(r);
    const id = `${other.id}:${m[1]}`;
    if (!doors.has(id)) doors.set(id, { to: other.id, secret: !!other.secret, v, inSide, cells: [] });
    doors.get(id).cells.push([x, z]);
  }
  return [...doors.values()].map((d) => {
    const xs = d.cells.map((p) => p[0]);
    const zs = d.cells.map((p) => p[1]);
    const x = (Math.min(...xs) + Math.max(...xs)) / 2;
    const z = (Math.min(...zs) + Math.max(...zs)) / 2;
    // the hall is on the inSide of the boundary: +1 = the far (+x / +z) cell
    const nx = d.v ? 0 : d.inSide;
    const nz = d.v ? d.inSide : 0;
    return { to: d.to, secret: d.secret, x, z, nx, nz, tx: d.v ? 1 : 0, tz: d.v ? 0 : 1, half: (d.cells.length * CELL) / 2 };
  });
}

const KIOSK_W = 1.1;
const KIOSK_D = 0.7;
const WALL_GAP = 0.25; // from the wall slab's face to the kiosk's back
const POINT_AHEAD = 1.5; // the interaction point, in front of the screen
const POINT_RADIUS = 2.3;

function kioskBox(x, z, nx) {
  const hx = (nx ? KIOSK_D : KIOSK_W) / 2;
  const hz = (nx ? KIOSK_W : KIOSK_D) / 2;
  return { minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz };
}

/** Is there a wall (not a doorway, not open floor) right behind the point, looking along -n? */
function wallBehind(x, z, nx, nz) {
  const c = w2g(x);
  const r = w2gz(z);
  const bc = w2g(x - nx * 1.2);
  const br = w2gz(z - nz * 1.2);
  if (bc === c && br === r) return false;
  return !passable(c, r, bc, br);
}

/** A free spot for the hall's kiosk: against the wall beside its preferred doorway. */
function kioskSpot(hallId, blockers, points, doorsAll) {
  const doors = hallDoors(hallId).filter((d) => !d.secret);
  const pref = PREFERRED_DOOR[hallId] || [];
  doors.sort((a, b) => (pref.indexOf(a.to) + 1 || 99) - (pref.indexOf(b.to) + 1 || 99));
  for (const d of doors) {
    for (let k = 0; k < 8; k++) {
      for (const side of [1, -1]) {
        const along = side * (d.half + 1.9 + k * 1.1);
        const back = 0.2 + WALL_GAP + KIOSK_D / 2;
        const x = d.x + d.tx * along + d.nx * back;
        const z = d.z + d.tz * along + d.nz * back;
        const room = roomAt(x, z);
        if (!room || room.id !== hallId) continue;
        const px = x + d.nx * POINT_AHEAD;
        const pz = z + d.nz * POINT_AHEAD;
        if (roomAt(px, pz)?.id !== hallId || roomAt(x + d.nx * 3, z + d.nz * 3)?.id !== hallId) continue;
        // the whole back must be on wall: not straddling another doorway or a corner
        const ends = [-1, 1].map((e) => [x + d.tx * e * (KIOSK_W / 2 + 0.3), z + d.tz * e * (KIOSK_W / 2 + 0.3)]);
        if (!ends.every(([ex, ez]) => roomAt(ex, ez)?.id === hallId && wallBehind(ex, ez, d.nx, d.nz))) continue;
        const box = kioskBox(x, z, d.nx);
        const hit = (o, m) => box.minX < o.maxX + m && box.maxX > o.minX - m && box.minZ < o.maxZ + m && box.maxZ > o.minZ - m;
        if (blockers.some((o) => hit(o, 1.0))) continue;
        // the visitor's spot in front has to be clear too
        if (blockers.some((o) => px > o.minX - 0.7 && px < o.maxX + 0.7 && pz > o.minZ - 0.7 && pz < o.maxZ + 0.7)) continue;
        if (points.some((p) => Math.hypot(p.x - px, p.z - pz) < 2.6 || Math.hypot(p.x - x, p.z - z) < 1.6)) continue;
        if (ERA_WINDOWS.some((w) => Math.hypot(w.x - x, w.z - z) < 4.6)) continue;
        // keep clear of every doorway, not only this one
        if (doorsAll.some((o) => nearDoor(o, x, z))) continue;
        return { x, z, ry: Math.atan2(d.nx, d.nz), nx: d.nx, nz: d.nz, door: d.to, px, pz };
      }
    }
  }
  return null;
}

/** Within 1.4 m of a doorway's opening (measured along its wall) and 2 m of its line. */
function nearDoor(d, x, z) {
  const along = Math.abs((x - d.x) * d.tx + (z - d.z) * d.tz);
  const off = Math.abs((x - d.x) * d.nx + (z - d.z) * d.nz);
  return along < d.half + 1.4 && off < 2;
}

/* ---------- textures ---------- */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStars(ctx, cx, cy, size, filled, total, accent) {
  for (let i = 0; i < total; i++) {
    const x = cx + (i - (total - 1) / 2) * size * 1.25;
    ctx.save();
    ctx.translate(x, cy);
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const rr = k % 2 ? size * 0.22 : size * 0.5;
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    ctx.closePath();
    if (i < filled) {
      ctx.fillStyle = accent;
      ctx.fill();
    } else {
      ctx.lineWidth = size * 0.07;
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** The sloped touch screen: hall name, "3 questions", the best score. */
function drawScreen(canvas, hallId, score) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const accent = hex(ROOM[hallId]?.accent);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#14202c");
  bg.addColorStop(1, "#0a1118");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, W, 10);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = `600 30px ${FONT}`;
  ctx.fillText("HALL QUIZ", W / 2, 58);
  ctx.fillStyle = "#f6efe2";
  let size = 58;
  const name = hallName(hallId);
  do ctx.font = `800 ${size}px ${FONT}`;
  while (ctx.measureText(name).width > W - 60 && (size -= 2) > 30);
  ctx.fillText(name, W / 2, 122);
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = `500 30px ${FONT}`;
  ctx.fillText(`${QUESTIONS_PER_QUIZ} questions about the animals here`, W / 2, 182);
  drawStars(ctx, W / 2, 238, 48, score, QUESTIONS_PER_QUIZ, accent);
  // the call to action, as a key cap (clear of the lit rim along the bottom edge)
  roundRect(ctx, W / 2 - 150, 274, 300, 50, 25);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.fillStyle = "#121212";
  ctx.font = `800 27px ${FONT}`;
  ctx.fillText(score ? "Press E to play again" : "Press E to play", W / 2, 300);
}

/** The backlit header panel: a big question mark over QUIZ. */
function drawHeader(canvas, hallId) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  const accent = hex(ROOM[hallId]?.accent);
  const bg = ctx.createRadialGradient(W / 2, H * 0.42, 10, W / 2, H * 0.42, W * 0.75);
  bg.addColorStop(0, "#273648");
  bg.addColorStop(1, "#0d141c");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 10;
  roundRect(ctx, 14, 14, W - 28, H - 28, 26);
  ctx.stroke();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = accent;
  ctx.shadowBlur = 40;
  ctx.fillStyle = accent;
  ctx.font = `900 ${Math.round(H * 0.5)}px ${FONT}`;
  ctx.fillText("?", W / 2, H * 0.4);
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#f6efe2";
  ctx.font = `800 ${Math.round(H * 0.12)}px ${FONT}`;
  ctx.fillText("QUIZ", W / 2, H * 0.8);
}

function glowTexture() {
  const c = makeCanvas(128, 128);
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, "rgba(255,255,255,0.85)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const kioskRegistry = new Map(); // hallId -> { canvas, tex }

function refreshKiosk(hallId) {
  const k = kioskRegistry.get(hallId);
  if (!k) return;
  drawScreen(k.canvas, hallId, quizBest(hallId));
  k.tex.needsUpdate = true;
}

/**
 * A lit quiz kiosk in every exhibit hall, against the wall beside the
 * doorway visitors leave by. Each one is a dark console with a sloped
 * screen, a backlit "?" header and a glowing accent strip in the hall's
 * colour; a collider goes into PROP_OBSTACLES (opts.collide = false to skip).
 *
 * @param {THREE.Object3D} group  parent (world.group or the scene)
 * @param {object} world          buildWorld()'s result (interactables, displays)
 * @returns {{ group, kiosks, interactables, obstacles, skipped, update(t), dispose() }}
 */
export function buildQuizKiosks(group, world = {}, opts = {}) {
  const root = new THREE.Group();
  root.name = "quiz-kiosks";
  group.add(root);

  const displays = world.displays || DISPLAYS;
  const blockers = [...OBSTACLES, ...PROP_OBSTACLES, ...displays.filter((d) => d.bounds).map((d) => d.bounds)];
  const points = [...(world.interactables || [])];
  const doorsAll = QUIZ_HALLS.flatMap(hallDoors);

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x56616d, roughness: 0.55, metalness: 0.1, emissive: 0x0d1217 });
  const glowTex = glowTexture();
  const disposables = [bodyMat, glowTex];
  const kiosks = [];
  const interactables = [];
  const obstacles = [];
  const skipped = [];
  const pulsing = [];

  for (const hallId of opts.halls || QUIZ_HALLS) {
    const spot = kioskSpot(hallId, blockers, points, doorsAll);
    if (!spot) {
      skipped.push(hallId);
      continue;
    }
    const accentN = ROOM[hallId]?.accent ?? 0xffc857;
    const accent = new THREE.Color(accentN);
    const g = new THREE.Group();
    g.name = `quiz-kiosk-${hallId}`;
    g.position.set(spot.x, 0, spot.z);
    g.rotation.y = spot.ry;

    const add = (geo, mat, x, y, z, surface, rx = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.x = rx;
      m.userData.surface = surface;
      g.add(m);
      disposables.push(geo);
      return m;
    };

    // console body and the stele behind it
    // the housing keeps its own satin material ("skip"): lookdev's black metal reads as a hole
    const body = add(new THREE.BoxGeometry(KIOSK_W, 0.9, KIOSK_D * 0.8), bodyMat, 0, 0.45, -KIOSK_D * 0.1, "skip"); // below the sloped screen
    body.castShadow = true;
    body.receiveShadow = true;
    const stele = add(new THREE.BoxGeometry(KIOSK_W, 1.55, 0.14), bodyMat, 0, 1.75, -KIOSK_D / 2 + 0.07, "skip");
    stele.castShadow = true;

    // sloped screen bezel + screen (top of the console, tilted towards the visitor)
    // tilt > 0 turns the top face up and towards the visitor (+z)
    const tilt = 0.62;
    const bezel = add(new THREE.BoxGeometry(KIOSK_W, 0.06, 0.62), bodyMat, 0, 1.08, 0.0, "skip", tilt);
    bezel.castShadow = true;
    const screenCanvas = makeCanvas(640, 360);
    drawScreen(screenCanvas, hallId, quizBest(hallId));
    const screenTex = new THREE.CanvasTexture(screenCanvas);
    screenTex.colorSpace = THREE.SRGBColorSpace;
    screenTex.anisotropy = 4;
    const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false });
    disposables.push(screenTex, screenMat);
    const screen = add(new THREE.PlaneGeometry(0.98, 0.55), screenMat, 0, 1.08, 0, "skip", tilt - Math.PI / 2);
    // lift it just off the bezel along its normal
    screen.translateZ(0.034);
    kioskRegistry.set(hallId, { canvas: screenCanvas, tex: screenTex });

    // backlit header
    const headCanvas = makeCanvas(384, 384);
    drawHeader(headCanvas, hallId);
    const headTex = new THREE.CanvasTexture(headCanvas);
    headTex.colorSpace = THREE.SRGBColorSpace;
    const headMat = new THREE.MeshBasicMaterial({ map: headTex, toneMapped: false });
    headMat.color.setScalar(0.95);
    disposables.push(headTex, headMat);
    add(new THREE.PlaneGeometry(0.92, 0.92), headMat, 0, 2.02, -KIOSK_D / 2 + 0.145, "skip");

    // accent light strips: down both edges of the stele and round the plinth foot
    const stripMat = new THREE.MeshBasicMaterial({ color: accent, toneMapped: false });
    disposables.push(stripMat);
    for (const sx of [-1, 1]) add(new THREE.BoxGeometry(0.03, 1.5, 0.03), stripMat, sx * (KIOSK_W / 2 - 0.02), 1.75, -KIOSK_D / 2 + 0.15, "skip");
    add(new THREE.BoxGeometry(KIOSK_W + 0.02, 0.035, KIOSK_D * 0.8 + 0.02), stripMat, 0, 0.03, -KIOSK_D * 0.1, "skip");
    // a lit cap on the stele and a rim along the front edge of the screen
    add(new THREE.BoxGeometry(KIOSK_W + 0.04, 0.05, 0.2), stripMat, 0, 2.55, -KIOSK_D / 2 + 0.07, "skip");
    const rim = add(new THREE.BoxGeometry(KIOSK_W, 0.025, 0.025), stripMat, 0, 1.08, 0, "skip", tilt);
    rim.translateZ(0.318);
    rim.translateY(0.02);

    // a soft pool of light on the floor in front
    const glowMat = new THREE.MeshBasicMaterial({
      map: glowTex,
      color: accent,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    disposables.push(glowMat);
    const glow = add(new THREE.PlaneGeometry(2.6, 2.2), glowMat, 0, 0.015, 0.9, "skip", -Math.PI / 2);
    glow.renderOrder = 1;
    pulsing.push({ glowMat, stripMat, base: accent.clone(), phase: kiosks.length * 1.3 });

    root.add(g);
    const box = { id: `quiz:${hallId}`, ...kioskBox(spot.x, spot.z, spot.nx) };
    obstacles.push(box);
    blockers.push(box);
    const it = {
      id: `quiz:${hallId}`,
      type: "quiz",
      hall: hallId,
      x: spot.px,
      z: spot.pz,
      radius: POINT_RADIUS,
      label: "Take the hall quiz",
      key: "E",
    };
    interactables.push(it);
    points.push(it);
    kiosks.push({ hall: hallId, x: spot.x, z: spot.z, ry: spot.ry, door: spot.door, group: g });
  }
  if (opts.collide !== false) PROP_OBSTACLES.push(...obstacles);

  const tmp = new THREE.Color();
  return {
    group: root,
    kiosks,
    interactables,
    obstacles,
    skipped,
    /** Gentle breathing of the glow; t in seconds. Optional. */
    update(t) {
      for (const p of pulsing) {
        const s = 0.5 + 0.5 * Math.sin(t * 1.6 + p.phase);
        p.glowMat.opacity = 0.24 + 0.14 * s;
        p.stripMat.color.copy(tmp.copy(p.base).multiplyScalar(0.8 + 0.35 * s));
      }
    },
    dispose() {
      for (const o of obstacles) {
        const i = PROP_OBSTACLES.indexOf(o);
        if (i >= 0) PROP_OBSTACLES.splice(i, 1);
      }
      for (const k of kiosks) kioskRegistry.delete(k.hall);
      root.removeFromParent();
      disposables.forEach((d) => d.dispose?.());
    },
  };
}

/* ------------------------------------------------------------------ */
/* the quiz modal                                                       */
/* ------------------------------------------------------------------ */

const cfg = { toast: null, onComplete: null, onOpen: null, onClose: null };

/** Hooks from main.js: toast(text, kind), onComplete(result), onOpen(hallId), onClose(). */
export function initQuiz(options = {}) {
  Object.assign(cfg, options);
}

function toast(text, kind = "") {
  if (cfg.toast) return cfg.toast(text, kind);
  const box = document.getElementById("toasts");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = text;
  box.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .4s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 400);
  }, 2600);
}

let root = null;
let state = null;
let pendingToast = null;
const LETTERS = ["A", "B", "C", "D"];

function ensureDom() {
  if (root) return root;
  root = document.createElement("div");
  root.id = "quizOverlay";
  root.className = "quiz-overlay hidden";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-labelledby", "quizTitle");
  root.innerHTML = `<div class="quiz-card" tabindex="-1"></div>`;
  root.addEventListener("click", (e) => {
    if (e.target === root) closeQuiz();
  });
  document.body.appendChild(root);
  return root;
}

export const isQuizOpen = () => !!root && !root.classList.contains("hidden");

/** Open the quiz of a hall. Returns false when the hall has no quiz. */
export function openQuiz(hallId, opts = {}) {
  const hall = normHall(hallId);
  const questions = buildQuestions(hall, opts);
  if (!questions.length) return false;
  ensureDom();
  state = { hall, questions, i: 0, picked: null, correct: 0 };
  pendingToast = null;
  root.style.setProperty("--quiz-accent", hex(ROOM[hall]?.accent));
  if (document.pointerLockElement) document.exitPointerLock?.();
  root.classList.remove("hidden");
  window.addEventListener("keydown", onKey, true);
  render();
  cfg.onOpen?.(hall);
  return true;
}

export function closeQuiz() {
  if (!isQuizOpen()) return;
  root.classList.add("hidden");
  window.removeEventListener("keydown", onKey, true);
  state = null;
  if (pendingToast) toast(...pendingToast);
  pendingToast = null;
  cfg.onClose?.();
}

/** While open the quiz owns the keyboard: 1-4 / A-D answer, Enter goes on, Esc closes. */
function onKey(e) {
  if (!isQuizOpen()) return;
  e.stopPropagation();
  if (e.repeat) return;
  const q = state.questions[state.i];
  const done = state.i >= state.questions.length;
  if (e.code === "Escape") {
    e.preventDefault();
    closeQuiz();
    return;
  }
  if (!done && state.picked == null) {
    let n = -1;
    const m = /^(?:Digit|Numpad)([1-4])$/.exec(e.code);
    if (m) n = +m[1] - 1;
    else if (/^Key[A-D]$/.test(e.code)) n = e.code.charCodeAt(3) - 65;
    if (n >= 0 && n < q.options.length) {
      e.preventDefault();
      pick(n);
    }
    return;
  }
  if (e.code === "Enter" || e.code === "Space" || e.code === "NumpadEnter") {
    // a focused button already handles Enter/Space by itself
    if (document.activeElement?.closest?.(".quiz-card button")) return;
    e.preventDefault();
    if (done) closeQuiz();
    else next();
  }
}

function pick(n) {
  if (!state || state.picked != null) return;
  const q = state.questions[state.i];
  state.picked = n;
  if (n === q.answer) state.correct++;
  render();
}

function next() {
  if (!state) return;
  state.i++;
  state.picked = null;
  if (state.i >= state.questions.length) finish();
  render();
}

function finish() {
  const { hall, correct, questions } = state;
  const total = questions.length;
  const prev = best[hall] || 0;
  const firstPerfect = correct === total && prev < total;
  if (correct > prev) {
    best[hall] = correct;
    saveBest(best);
    refreshKiosk(hall);
  }
  // the toast waits for the modal to close: the overlay would cover it
  const name = hallName(hall);
  if (correct === total) pendingToast = [`${name} quiz: ${correct}/${total} — perfect! 🏆`, "good"];
  else if (correct) pendingToast = [`${name} quiz: ${correct}/${total} 🦴`, "good"];
  else pendingToast = [`${name} quiz: 0/${total} — have another look around!`, ""];
  const result = { hall, correct, total, best: Math.max(prev, correct), improved: correct > prev, firstPerfect };
  cfg.onComplete?.(result);
  window.dispatchEvent(new CustomEvent("museum:quiz", { detail: result }));
}

function dots() {
  return state.questions
    .map((q, i) => {
      let cls = "";
      if (i < state.i || (i === state.i && state.picked != null)) {
        const right = i < state.i ? q.result : state.picked === q.answer;
        cls = right ? "ok" : "bad";
      } else if (i === state.i) cls = "now";
      return `<span class="quiz-dot ${cls}"></span>`;
    })
    .join("");
}

function render() {
  if (!state) return;
  const card = root.querySelector(".quiz-card");
  const total = state.questions.length;
  const head = `
    <div class="quiz-head">
      <div>
        <div class="quiz-kicker">Hall quiz</div>
        <h2 id="quizTitle">${escapeHtml(hallName(state.hall))}</h2>
      </div>
      <button class="quiz-x" type="button" aria-label="Close quiz">✕</button>
    </div>`;

  if (state.i >= total) {
    const c = state.correct;
    const line =
      c === total
        ? "Perfect score! You really know this hall."
        : c
          ? "Nicely done. Have another look at the panels and try again."
          : "Have a wander round the panels — the answers are all on them.";
    card.innerHTML = `${head}
      <div class="quiz-result">
        <div class="quiz-stars" aria-hidden="true">${Array.from({ length: total }, (_, i) => `<span class="${i < c ? "on" : ""}">★</span>`).join("")}</div>
        <div class="quiz-score">${c} <small>/ ${total}</small></div>
        <p>${line}</p>
        ${quizBest(state.hall) > c ? `<p class="quiz-best">Your best here: ${quizBest(state.hall)} / ${total}</p>` : ""}
      </div>
      <div class="quiz-actions">
        <button type="button" class="quiz-again">New questions</button>
        <button type="button" class="quiz-primary quiz-done">Done</button>
      </div>`;
    card.querySelector(".quiz-again").onclick = () => openQuiz(state.hall);
    card.querySelector(".quiz-done").onclick = () => closeQuiz();
    card.querySelector(".quiz-x").onclick = () => closeQuiz();
    card.querySelector(".quiz-done").focus({ preventScroll: true });
    return;
  }

  const q = state.questions[state.i];
  const answered = state.picked != null;
  if (answered) q.result = state.picked === q.answer;
  const opts = q.options
    .map((o, i) => {
      let cls = "";
      if (answered) {
        if (i === q.answer) cls = "right";
        else if (i === state.picked) cls = "wrong";
        else cls = "dim";
      }
      return `<li><button type="button" class="quiz-opt ${cls}" data-i="${i}" ${answered ? "disabled" : ""}>
        <span class="quiz-key">${LETTERS[i]}</span><span class="quiz-txt">${escapeHtml(o)}</span></button></li>`;
    })
    .join("");
  const feedback = answered
    ? `<div class="quiz-feedback ${q.result ? "ok" : "bad"}" role="status">
        <b>${q.result ? "Correct!" : "Not quite."}</b> ${escapeHtml(q.explain)}
      </div>`
    : `<div class="quiz-feedback hint" role="status">Choose an answer — or press 1 to ${q.options.length}.</div>`;

  card.innerHTML = `${head}
    <div class="quiz-progress"><span>Question ${state.i + 1} of ${total}</span><span class="quiz-dots">${dots()}</span></div>
    <p class="quiz-q">${q.prompt}</p>
    ${q.quote ? `<blockquote class="quiz-quote">“${escapeHtml(q.quote)}”</blockquote>` : ""}
    <ol class="quiz-opts">${opts}</ol>
    ${feedback}
    <div class="quiz-actions">
      ${answered ? `<button type="button" class="quiz-primary quiz-next">${state.i + 1 < total ? "Next question" : "See my score"}</button>` : ""}
    </div>`;
  card.querySelector(".quiz-x").onclick = () => closeQuiz();
  card.querySelectorAll(".quiz-opt").forEach((b) => (b.onclick = () => pick(+b.dataset.i)));
  const nextBtn = card.querySelector(".quiz-next");
  if (nextBtn) {
    nextBtn.onclick = () => next();
    nextBtn.focus({ preventScroll: true });
  } else card.focus({ preventScroll: true });
}
