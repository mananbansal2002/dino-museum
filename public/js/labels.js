/**
 * Real-museum specimen labels.
 *
 *   renderLabelHtml(ex)            HTML block for the exhibit card: Latin
 *                                  binomial + authority, "say it", what the
 *                                  name means, the first find, a famous
 *                                  specimen and a "Not a dinosaur!" badge.
 *   bindLabelCard(root)            wires the card block's "say it" button
 *                                  (Web Speech; hidden when there is no voice).
 *   buildPlinthLabels(group, world) engraved brass label plaques on waist-high
 *                                  lecterns in front of every exhibit panel.
 *
 * Everything reads the optional info fields in species.js (latin, author,
 * say, meaning, discovered, specimen, note, notDinosaur, notDinoNote); a
 * missing field simply drops out.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { SPECIES } from "./species.js";
import { EXHIBIT_PANELS, OBSTACLES, PROP_OBSTACLES, DISPLAYS, PANEL_DEPTH, roomAt } from "./world.js";

/* ------------------------------------------------------------------ */
/* shared text helpers                                                  */
/* ------------------------------------------------------------------ */

function speciesOf(ex) {
  if (!ex) return null;
  if (ex.info && ex.id) return ex; // a SPECIES entry
  return SPECIES[ex.id] || SPECIES[ex.dino] || SPECIES[ex.exhibitId] || null;
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/** "1902 by Barnum Brown" (either half may be missing). */
function foundLine(d) {
  if (!d) return "";
  return [d.year != null ? String(d.year) : "", d.by ? `by ${d.by}` : ""].filter(Boolean).join(" ");
}

/** The speech-friendly form of a respelling: "tie-RAN-oh-SORE-us" -> "tie ran oh sore us". */
function spoken(say) {
  return String(say || "").replace(/-/g, " ").toLowerCase();
}

/* ------------------------------------------------------------------ */
/* exhibit card block                                                   */
/* ------------------------------------------------------------------ */

const SPEAKER_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M3 9v6h4l5 4V5L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>';

/**
 * The specimen-label block for an exhibit card. `ex` is an exhibit record
 * (exhibits.js) or a SPECIES entry. Returns "" when the species has no label
 * fields at all.
 */
export function renderLabelHtml(ex) {
  const spec = speciesOf(ex);
  const info = spec?.info;
  if (!info || !(info.latin || info.say || info.meaning || info.discovered || info.notDinosaur)) return "";
  const rows = [];
  if (info.meaning) rows.push(["Name means", `&ldquo;${escapeHtml(info.meaning)}&rdquo;`]);
  const d = info.discovered;
  if (d && (d.year != null || d.by || d.where)) {
    const first = foundLine(d);
    rows.push([
      "First found",
      [first ? escapeHtml(first) : "", d.where ? `<span class="specLabel-where">${escapeHtml(d.where)}</span>` : ""]
        .filter(Boolean)
        .join("<br />"),
    ]);
  }
  if (info.specimen) rows.push(["Specimen", escapeHtml(info.specimen)]);
  if (info.note) rows.push(["Note", escapeHtml(info.note)]);

  const badge = info.notDinosaur
    ? `<span class="specBadge specBadge--not">Not a dinosaur!</span>`
    : `<span class="specBadge specBadge--dino">Dinosaur</span>`;

  return `
    <section class="specLabel${info.notDinosaur ? " specLabel--not" : ""}" aria-label="Specimen label">
      <div class="specLabel-head">
        <div class="specLabel-name">
          ${info.latin ? `<i class="specLabel-latin label-latin">${escapeHtml(info.latin)}</i>` : ""}
          ${info.author ? `<span class="specLabel-author">${escapeHtml(info.author)}</span>` : ""}
        </div>
        ${badge}
      </div>
      ${
        info.say
          ? `<div class="specLabel-say">
              <span class="specLabel-k">Say it</span>
              <span class="specLabel-sayText">${escapeHtml(info.say)}</span>
              <button type="button" class="specLabel-speak" data-say="${escapeHtml(spoken(info.say))}" aria-label="Hear how to say ${escapeHtml(spec.name)}" hidden>${SPEAKER_SVG}</button>
            </div>`
          : ""
      }
      ${info.notDinosaur && info.notDinoNote ? `<p class="specLabel-notNote">${escapeHtml(info.notDinoNote)}</p>` : ""}
      ${
        rows.length
          ? `<dl class="specLabel-rows">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`
          : ""
      }
    </section>`;
}

/**
 * Wire the "say it" button(s) inside `root` (the exhibit card body). The
 * button stays hidden unless the browser has a speech voice; voices often
 * arrive a moment after load, so it re-checks on voiceschanged.
 */
export function bindLabelCard(root) {
  if (!root) return;
  const buttons = [...root.querySelectorAll(".specLabel-speak")];
  if (!buttons.length) return;
  const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") return;
  const reveal = () => {
    const ok = synth.getVoices().length > 0;
    for (const b of buttons) b.hidden = !ok;
    return ok;
  };
  if (!reveal()) synth.addEventListener?.("voiceschanged", reveal, { once: true });
  for (const b of buttons) {
    b.onclick = (e) => {
      e.stopPropagation();
      synth.cancel();
      const u = new SpeechSynthesisUtterance(b.dataset.say || "");
      u.rate = 0.8;
      u.lang = "en-GB";
      synth.speak(u);
    };
  }
}

/* ------------------------------------------------------------------ */
/* plinth label plaques                                                 */
/* ------------------------------------------------------------------ */

const PLATE_W = 0.6; // metres
const PLATE_H = 0.32;
const PLATE_Y = 1.0; // centre height of the plaque
// the plaque's face leans back 30 degrees off vertical, toward the reader's eye
const TILT = THREE.MathUtils.degToRad(30);
// atlas: 4 canvases of 2048 px, 3 x 5 slots of 680 x 362 (the plaque's 1.875:1)
const ATLAS = 2048;
const COLS = 3;
const ROWS = 5;
const SLOT_W = 680;
const SLOT_H = 362;
const PER_ATLAS = COLS * ROWS;
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif';
const SANS = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const STAND_R = 0.26; // collider radius of a lectern
const ENGRAVE = "#24180c";

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Brushed brass, drawn once and stamped into every slot. */
function brassTile() {
  const c = makeCanvas(SLOT_W, SLOT_H);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, SLOT_W, SLOT_H);
  g.addColorStop(0, "#d9bd7c");
  g.addColorStop(0.45, "#c7a35e");
  g.addColorStop(0.7, "#d6b874");
  g.addColorStop(1, "#b58f4c");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SLOT_W, SLOT_H);
  // brushing: fine horizontal streaks (seeded so every load looks the same)
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 900; i++) {
    const y = rnd() * SLOT_H;
    ctx.fillStyle = rnd() < 0.5 ? "rgba(255,240,200,0.10)" : "rgba(90,60,20,0.08)";
    ctx.fillRect(rnd() * SLOT_W - 80, y, 60 + rnd() * 260, 1);
  }
  // bevelled edge
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(255,242,205,0.55)";
  ctx.beginPath();
  ctx.moveTo(3, SLOT_H - 3);
  ctx.lineTo(3, 3);
  ctx.lineTo(SLOT_W - 3, 3);
  ctx.stroke();
  ctx.strokeStyle = "rgba(70,45,15,0.55)";
  ctx.beginPath();
  ctx.moveTo(SLOT_W - 3, 3);
  ctx.lineTo(SLOT_W - 3, SLOT_H - 3);
  ctx.lineTo(3, SLOT_H - 3);
  ctx.stroke();
  return c;
}

/** Engraved text: dark fill with a bright lip under it (light from above). */
function engrave(ctx, text, x, y, font, maxW, color = ENGRAVE) {
  ctx.font = font;
  let size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)[1]);
  while (ctx.measureText(text).width > maxW && size > 10) {
    size -= 1;
    ctx.font = font.replace(/\d+(?:\.\d+)?px/, `${size}px`);
  }
  ctx.fillStyle = "rgba(255,245,215,0.55)";
  ctx.fillText(text, x, y + 1.5);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** Wrap `text` to at most `lines` lines of maxW (ellipsis on the last). */
function wrap(ctx, text, maxW, lines) {
  const words = String(text).split(/\s+/);
  const out = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width <= maxW || !cur) cur = next;
    else {
      out.push(cur);
      cur = w;
      if (out.length === lines) break;
    }
  }
  if (out.length < lines && cur) out.push(cur);
  if (out.length === lines && words.join(" ") !== out.join(" ")) {
    let last = out[lines - 1];
    while (last && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    out[lines - 1] = `${last.replace(/[\s,.;:]+$/, "")}…`;
  }
  return out;
}

/** Draw one plaque into the slot whose top-left is (ox, oy). */
function drawPlaque(ctx, tile, spec, ox, oy) {
  const info = spec.info || {};
  ctx.save();
  ctx.translate(ox, oy);
  ctx.drawImage(tile, 0, 0);
  const L = 34;
  const W = SLOT_W - L * 2;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // kicker: era and date
  const kicker = [info.era?.toUpperCase(), info.period].filter(Boolean).join("  ·  ");
  engrave(ctx, kicker, L, 48, `600 17px ${SANS}`, W);

  // common name, then the binomial and its authority
  const name = spec.name || "";
  engrave(ctx, name, L, 104, `700 50px ${SERIF}`, W);
  let y = 104;
  if (info.latin && info.latin !== name) {
    y += 40;
    engrave(ctx, info.latin, L, y, `italic 400 30px ${SERIF}`, W * 0.66);
    if (info.author) {
      ctx.font = `italic 400 30px ${SERIF}`;
      const lw = Math.min(ctx.measureText(info.latin).width, W * 0.66);
      engrave(ctx, info.author, L + lw + 12, y, `400 21px ${SERIF}`, W - lw - 12);
    }
  } else if (info.author) {
    y += 34;
    engrave(ctx, info.author, L, y, `400 22px ${SERIF}`, W);
  }

  // rule
  y += 20;
  ctx.fillStyle = "rgba(255,245,215,0.5)";
  ctx.fillRect(L, y + 1.5, W, 2);
  ctx.fillStyle = "rgba(36,24,12,0.75)";
  ctx.fillRect(L, y, W, 2);

  // meaning / say it, then the first find
  const lines = [];
  if (info.meaning) lines.push(`“${info.meaning}”`);
  if (info.say) lines.push(`Say it: ${info.say}`);
  const d = info.discovered;
  const found = foundLine(d);
  if (found || d?.where) lines.push(`First found ${[found, d?.where].filter(Boolean).join(", ")}`);
  ctx.font = `400 23px ${SERIF}`;
  y += 34;
  const bottom = SLOT_H - 62;
  for (const raw of lines) {
    for (const l of wrap(ctx, raw, W, 2)) {
      if (y > bottom) break;
      engrave(ctx, l, L, y, `400 23px ${SERIF}`, W);
      y += 29;
    }
  }

  // enamel inlay along the foot: green "Dinosaur" or amber "Not a dinosaur!"
  const not = !!info.notDinosaur;
  const bh = 38;
  const by = SLOT_H - bh - 14;
  ctx.fillStyle = not ? "#b8641a" : "#2f6b47";
  ctx.fillRect(L, by, W, bh);
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(L, by, W, 2);
  ctx.fillStyle = "#fff8e8";
  ctx.font = `700 19px ${SANS}`;
  const tag = not ? "NOT A DINOSAUR!" : "DINOSAUR";
  ctx.fillText(tag, L + 14, by + 26);
  if (not && info.notDinoNote) {
    const tw = ctx.measureText(tag).width;
    const note = info.notDinoNote.replace(/:.*$/, "");
    ctx.font = `500 17px ${SANS}`;
    let t = note;
    while (t && ctx.measureText(t).width > W - tw - 50) t = t.slice(0, -1);
    ctx.fillText(t === note ? t : `${t.trim()}…`, L + tw + 30, by + 26);
  }
  ctx.restore();
}

/* ---------- placement ---------- */

function hits(x, z, r, boxes) {
  return boxes.some((o) =>
    Number.isFinite(o.r)
      ? Math.hypot(x - o.x, z - o.z) < o.r + r
      : x > o.minX - r && x < o.maxX + r && z > o.minZ - r && z < o.maxZ + r
  );
}

/**
 * Where a panel's lectern stands: { x, z, ry } or null. With nothing in front
 * of the panel it stands just ahead of the plinth's centre; with a display
 * case in front it flanks the case's front corner (right side first), toed in
 * toward a visitor standing in front of the exhibit.
 */
function lecternSpot(panel, display, blockers, points, placed) {
  const ry = panel.face;
  const fx = Math.sin(ry);
  const fz = Math.cos(ry);
  const rx = Math.cos(ry);
  const rz = -Math.sin(ry);
  const front = display && Math.abs(Math.sin(display.ry - ry)) < 0.1 && Math.cos(display.ry - ry) > 0;
  const plinthHalf = PANEL_DEPTH / 2;
  const candidates = [];
  if (front) {
    const caseHalf = display.maxLength / 2;
    const caseFront = Math.hypot(display.x - panel.x, display.z - panel.z) + display.maxDepth / 2;
    const flank = caseHalf + 0.62;
    // beside the case, level with its front third
    candidates.push([caseFront - 0.45, flank, -0.35], [caseFront - 0.45, -flank, 0.35]);
    // ahead of the case's front corners
    candidates.push([caseFront + 0.55, caseHalf - 0.25, -0.2], [caseFront + 0.55, -(caseHalf - 0.25), 0.2]);
  } else {
    candidates.push([plinthHalf + 0.62, 0, 0], [plinthHalf + 0.62, panel.w / 2 - 0.3, 0], [plinthHalf + 0.62, -(panel.w / 2 - 0.3), 0]);
  }
  for (const [a, b, toe] of candidates) {
    const x = panel.x + fx * a + rx * b;
    const z = panel.z + fz * a + rz * b;
    const inside =
      roomAt(x, z) && roomAt(x + 0.8, z) && roomAt(x - 0.8, z) && roomAt(x, z + 0.8) && roomAt(x, z - 0.8);
    if (!inside) continue;
    if (hits(x, z, STAND_R + 0.15, blockers)) continue;
    if (points.some((p) => p.id !== panel.id && Math.hypot(p.x - x, p.z - z) < 1.0)) continue;
    if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < 1.2)) continue;
    // the exhibit's own interaction point: keep the stand off it
    const own = points.find((p) => p.id === panel.id);
    if (own && Math.hypot(own.x - x, own.z - z) < 0.75) continue;
    return { x, z, ry: ry + toe };
  }
  return null;
}

/**
 * Build the engraved label plaques: one lectern per exhibit panel, waist high
 * (plaque centre at 1.0 m), its 0.6 x 0.32 m brass plate leaning back 30
 * degrees, standing in front of the panel on clear floor (never inside an
 * exhibit plinth, display case, furniture or another module's collider).
 *
 * The plates are drawn into four 2048 px canvas atlases and merged into one
 * mesh per atlas; bases, posts and heads are one InstancedMesh each, so the
 * whole set costs seven draw calls. Stands are tagged surface "trim" (the
 * lookdev pass gives them the gallery's wood trim), plates "skip".
 *
 * @param {THREE.Object3D} group  parent (world.group or the scene)
 * @param {object} world          buildWorld()'s result (exhibits, displays, interactables)
 * @param {object} [opts]
 *   collide: push a small circle collider per stand into PROP_OBSTACLES (default true)
 *   only: [species ids] build just these
 * @returns {{ group, labels: {id, x, z, ry}[], skipped: string[], obstacles: object[], dispose() }}
 */
export function buildPlinthLabels(group, world = {}, opts = {}) {
  const root = new THREE.Group();
  root.name = "plinth-labels";
  root.userData.surface = "trim";
  group.add(root);

  const panels = EXHIBIT_PANELS.filter((p) => SPECIES[p.id] && (!opts.only || opts.only.includes(p.id)));
  const displays = world.displays || DISPLAYS;
  const blockers = [
    ...OBSTACLES,
    ...PROP_OBSTACLES,
    ...displays.filter((d) => d.bounds).map((d) => d.bounds),
  ];
  // where visitors stand to examine an exhibit
  const points = (world.interactables || [])
    .filter((i) => i.type === "exhibit")
    .map((i) => ({ id: i.exhibitId || i.id, x: i.x, z: i.z }));

  const labels = [];
  const skipped = [];
  for (const panel of panels) {
    const display = displays.find((d) => d.speciesId === panel.id);
    const spot = lecternSpot(panel, display, blockers, points, labels);
    if (!spot) {
      skipped.push(panel.id);
      continue;
    }
    labels.push({ id: panel.id, ...spot });
  }

  /* ---------- the stands ---------- */
  const n = labels.length;
  const standMat = new THREE.MeshStandardMaterial({ color: 0x3b2d22, roughness: 0.55, metalness: 0.1 });
  const unit = new THREE.BoxGeometry(1, 1, 1);
  const mk = (name) => {
    const m = new THREE.InstancedMesh(unit, standMat, Math.max(1, n));
    m.name = name;
    m.count = n;
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.surface = "trim";
    root.add(m);
    return m;
  };
  const bases = mk("label-bases");
  const posts = mk("label-posts");
  const heads = mk("label-heads");

  const base = new THREE.Matrix4();
  const local = new THREE.Matrix4();
  const tiltM = new THREE.Matrix4().makeRotationX(-TILT);
  const tmp = new THREE.Matrix4();
  const S = new THREE.Matrix4();
  // the head: a slab under the plate, its top face carrying the plate
  const headW = PLATE_W + 0.06;
  const headH = PLATE_H + 0.06;
  const headT = 0.045;
  // post rises to the head's lower edge
  const headLowY = PLATE_Y - (headH / 2) * Math.cos(TILT);
  const postTop = headLowY + 0.04;
  labels.forEach((l, i) => {
    base.makeRotationY(l.ry).setPosition(l.x, 0, l.z);
    bases.setMatrixAt(i, tmp.multiplyMatrices(base, local.makeScale(0.36, 0.035, 0.3).setPosition(0, 0.0175, -0.04)));
    posts.setMatrixAt(i, tmp.multiplyMatrices(base, local.makeScale(0.075, postTop, 0.075).setPosition(0, postTop / 2, -0.04)));
    // head centre sits just behind the plate along the tilted normal
    local.makeTranslation(0, PLATE_Y, 0).multiply(tiltM).multiply(new THREE.Matrix4().makeTranslation(0, 0, -headT / 2));
    S.makeScale(headW, headH, headT);
    heads.setMatrixAt(i, tmp.multiplyMatrices(base, local).multiply(S));
  });
  for (const m of [bases, posts, heads]) {
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }

  /* ---------- the plates: atlased canvases, one merged mesh per atlas ---------- */
  const tile = brassTile();
  const atlases = [];
  const plates = [];
  const plateMats = [];
  for (let a = 0; a * PER_ATLAS < n; a++) {
    const canvas = makeCanvas(ATLAS, ATLAS);
    const ctx = canvas.getContext("2d");
    const geos = [];
    for (let s = 0; s < PER_ATLAS && a * PER_ATLAS + s < n; s++) {
      const l = labels[a * PER_ATLAS + s];
      const ox = (s % COLS) * SLOT_W;
      const oy = Math.floor(s / COLS) * SLOT_H;
      drawPlaque(ctx, tile, SPECIES[l.id], ox, oy);
      const g = new THREE.PlaneGeometry(PLATE_W, PLATE_H);
      // remap UVs into the slot (canvas y runs down, texture v runs up)
      const uv = g.attributes.uv;
      const u0 = (ox + 1) / ATLAS;
      const u1 = (ox + SLOT_W - 1) / ATLAS;
      const v1 = 1 - (oy + 1) / ATLAS;
      const v0 = 1 - (oy + SLOT_H - 1) / ATLAS;
      for (let k = 0; k < uv.count; k++) {
        uv.setXY(k, uv.getX(k) ? u1 : u0, uv.getY(k) ? v1 : v0);
      }
      base.makeRotationY(l.ry).setPosition(l.x, 0, l.z);
      local.makeTranslation(0, PLATE_Y, 0).multiply(tiltM).multiply(new THREE.Matrix4().makeTranslation(0, 0, 0.002));
      g.applyMatrix4(tmp.multiplyMatrices(base, local));
      geos.push(g);
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.42, metalness: 0.35 });
    mat.userData.lkEnv = 0.9; // lookdev: a little more reflection than the default
    mat.envMapIntensity = 0.9;
    const merged = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = `label-plates-${a + 1}`;
    mesh.receiveShadow = true;
    mesh.userData.surface = "skip"; // keep the engraved texture
    root.add(mesh);
    atlases.push(canvas);
    plates.push(mesh);
    plateMats.push(mat);
  }

  /* ---------- colliders ---------- */
  const obstacles = labels.map((l) => {
    // the post sits 4 cm behind the stand's origin
    const x = l.x - Math.sin(l.ry) * 0.04;
    const z = l.z - Math.cos(l.ry) * 0.04;
    return { id: `label:${l.id}`, x, z, r: STAND_R, minX: x - STAND_R, maxX: x + STAND_R, minZ: z - STAND_R, maxZ: z + STAND_R };
  });
  if (opts.collide !== false) PROP_OBSTACLES.push(...obstacles);

  return {
    group: root,
    labels,
    skipped,
    obstacles,
    atlases,
    dispose() {
      for (const o of obstacles) {
        const i = PROP_OBSTACLES.indexOf(o);
        if (i >= 0) PROP_OBSTACLES.splice(i, 1);
      }
      root.removeFromParent();
      unit.dispose();
      standMat.dispose();
      plates.forEach((p) => p.geometry.dispose());
      plateMats.forEach((m) => {
        m.map?.dispose();
        m.dispose();
      });
    },
  };
}
