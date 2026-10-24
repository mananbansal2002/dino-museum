import { ROOMS, PLACEMENTS, CELL, GRID_W, GRID_H, g2w, g2z, isSolid, roomAt } from "./world.js";

/**
 * Top-down minimap. The static floor plan is rendered once into an offscreen
 * canvas; every frame we blit it and draw the visitors on top.
 *
 * All drawing is done in "map units": the canvas's width/height attributes
 * as written in the page (260 x 240). The backing store is sized to the
 * canvas's on-screen size times devicePixelRatio, so the map stays sharp on
 * HiDPI screens and when it is enlarged (the .big class), and one transform
 * maps map units onto it.
 */
export function createMinimap(canvas, { exhibits = [], revealAll = false } = {}) {
  const ctx = canvas.getContext("2d");

  // "secret" rooms (exit passage + ice cream court) stay off the map until a
  // visitor walks into them — the court is the surprise at the end of the tour
  const revealed = new Set(revealAll ? ROOMS.map((r) => r.id) : ROOMS.filter((r) => !r.secret).map((r) => r.id));
  const shown = (room) => !!room && revealed.has(room.id);
  const cellShown = (c, r) => !isSolid(c, r) && shown(roomAt(g2w(c), g2z(r)));

  // map units (fixed) vs backing-store pixels (follow the on-screen size)
  const W = canvas.width;
  const H = canvas.height;
  let px = 1; // backing-store pixels per map unit

  const worldW = GRID_W * CELL;
  const worldH = GRID_H * CELL;
  const base = document.createElement("canvas");
  const bctx = base.getContext("2d");

  const scale = Math.min(W / worldW, H / worldH);
  const offX = (W - worldW * scale) / 2;
  const offY = (H - worldH * scale) / 2;

  const toX = (wx) => offX + (wx + worldW / 2) * scale;
  const toY = (wz) => offY + (wz + worldH / 2) * scale;

  /**
   * Match the backing store to the on-screen size. Returns true when it
   * changed (the static layer then has to be redrawn).
   */
  function fit() {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    // a hidden canvas (display: none) measures 0: keep drawing at map size
    const cssW = canvas.clientWidth || W;
    const next = Math.max(0.5, (cssW * dpr) / W);
    const bw = Math.round(W * next);
    const bh = Math.round(H * next);
    if (canvas.width === bw && canvas.height === bh && base.width === bw) return false;
    px = next;
    canvas.width = bw;
    canvas.height = bh;
    base.width = bw;
    base.height = bh;
    return true;
  }

  /**
   * Room label: shrink the 9px type to fit the room, else wrap it onto up to
   * three lines, else try the short name (no "Hall"/"Room"), else, in a tall
   * narrow room, run it up the room sideways. Never wider than the room, so
   * it never runs over a wall or off the canvas.
   */
  function fitLines(text, maxW, maxH) {
    const words = text.split(" ");
    for (const size of [9, 8, 7, 6, 5]) {
      bctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
      const lines = [];
      for (const word of words) {
        const last = lines.length ? `${lines[lines.length - 1]} ${word}` : word;
        if (lines.length && bctx.measureText(last).width <= maxW) lines[lines.length - 1] = last;
        else lines.push(word);
      }
      const lineH = size + 1;
      if (lines.length > 3 || lines.length * lineH > maxH) continue;
      if (lines.some((l) => bctx.measureText(l).width > maxW)) continue;
      return { lines, lineH };
    }
    return null;
  }

  function drawLabel(text, x0, x1, z0, z1) {
    const w = x1 - x0 - 4;
    const h = z1 - z0 - 4;
    const cx = (x0 + x1) / 2;
    const cy = (z0 + z1) / 2;
    const short = text.replace(/\s+(HALL|ROOM)$/, "");
    const names = short !== text ? [text, short] : [text];
    for (const name of names) {
      const fit = fitLines(name, w, h);
      if (!fit) continue;
      const top = cy - ((fit.lines.length - 1) * fit.lineH) / 2;
      fit.lines.forEach((l, i) => bctx.fillText(l, cx, top + i * fit.lineH));
      return;
    }
    if (h <= w) return;
    for (const name of names) {
      const fit = fitLines(name, h, w);
      if (!fit) continue;
      bctx.save();
      bctx.translate(cx, cy);
      bctx.rotate(-Math.PI / 2);
      const top = -((fit.lines.length - 1) * fit.lineH) / 2;
      fit.lines.forEach((l, i) => bctx.fillText(l, 0, top + i * fit.lineH));
      bctx.restore();
      return;
    }
  }

  function drawStatic() {
    bctx.setTransform(px, 0, 0, px, 0, 0);
    bctx.clearRect(0, 0, W, H);
    bctx.fillStyle = "rgba(6,10,14,0.9)";
    bctx.fillRect(0, 0, W, H);

    for (const room of ROOMS) {
      if (!shown(room)) continue;
      const x0 = toX(g2w(room.cols[0]) - CELL / 2);
      const x1 = toX(g2w(room.cols[1]) + CELL / 2);
      const z0 = toY(g2z(room.rows[0]) - CELL / 2);
      const z1 = toY(g2z(room.rows[1]) + CELL / 2);
      const accent = `#${room.accent.toString(16).padStart(6, "0")}`;
      bctx.fillStyle = hexA(accent, 0.16);
      bctx.fillRect(x0, z0, x1 - x0, z1 - z0);
      bctx.strokeStyle = hexA(accent, 0.55);
      bctx.lineWidth = 1;
      bctx.strokeRect(x0 + 0.5, z0 + 0.5, x1 - x0 - 1, z1 - z0 - 1);
      if (x1 - x0 > 12 && z1 - z0 > 12) {
        bctx.fillStyle = hexA(accent, 0.85);
        bctx.textAlign = "center";
        bctx.textBaseline = "middle";
        drawLabel(room.name.toUpperCase(), x0, x1, z0, z1);
      }
    }

    // walls
    bctx.strokeStyle = "rgba(190,215,235,0.5)";
    bctx.lineWidth = 1.4;
    for (let r = 0; r < GRID_H; r++) {
      for (let c = 0; c < GRID_W; c++) {
        if (!cellShown(c, r)) continue;
        const x0 = toX(g2w(c) - CELL / 2);
        const z0 = toY(g2z(r) - CELL / 2);
        const w = CELL * scale;
        if (!cellShown(c - 1, r)) {
          bctx.beginPath();
          bctx.moveTo(x0 + 0.5, z0);
          bctx.lineTo(x0 + 0.5, z0 + w);
          bctx.stroke();
        }
        if (!cellShown(c + 1, r)) {
          bctx.beginPath();
          bctx.moveTo(x0 + w - 0.5, z0);
          bctx.lineTo(x0 + w - 0.5, z0 + w);
          bctx.stroke();
        }
        if (!cellShown(c, r - 1)) {
          bctx.beginPath();
          bctx.moveTo(x0, z0 + 0.5);
          bctx.lineTo(x0 + w, z0 + 0.5);
          bctx.stroke();
        }
        if (!cellShown(c, r + 1)) {
          bctx.beginPath();
          bctx.moveTo(x0, z0 + w - 0.5);
          bctx.lineTo(x0 + w, z0 + w - 0.5);
          bctx.stroke();
        }
      }
    }

    // exhibits
    bctx.fillStyle = "rgba(255,200,87,0.9)";
    for (const p of PLACEMENTS) {
      if (!shown(roomAt(p.x, p.z))) continue;
      bctx.beginPath();
      bctx.arc(toX(p.x), toY(p.z), 1.9, 0, Math.PI * 2);
      bctx.fill();
    }
    for (const e of exhibits) {
      if (!shown(roomAt(e.x, e.z))) continue;
      bctx.fillStyle = "rgba(126,224,129,0.95)";
      bctx.beginPath();
      bctx.arc(toX(e.x), toY(e.z), 2.4, 0, Math.PI * 2);
      bctx.fill();
    }
  }

  fit();
  drawStatic();

  // follow the on-screen size (HiDPI, the M key's big map, phone layouts)
  let sizeDirty = false;
  let lastDpr = globalThis.devicePixelRatio;
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      sizeDirty = true;
    }).observe(canvas);
  }

  function draw({ local, remotes = [] }) {
    // (a window dragged to a screen with another pixel ratio resizes nothing)
    if (sizeDirty || typeof ResizeObserver !== "function" || globalThis.devicePixelRatio !== lastDpr) {
      sizeDirty = false;
      lastDpr = globalThis.devicePixelRatio;
      if (fit()) drawStatic();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(px, 0, 0, px, 0, 0);

    for (const r of remotes) {
      // a friend inside a room you have not found yet stays off the map:
      // their dot would give the secret room away
      if (!shown(roomAt(r.x, r.z))) continue;
      const x = toX(r.x);
      const y = toY(r.z);
      ctx.fillStyle = r.color || "#8ecae6";
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (local) {
      const here = roomAt(local.x, local.z);
      if (here && !revealed.has(here.id)) reveal(here.id);
      const x = toX(local.x);
      const y = toY(local.z);
      // the player faces world (sin ry, cos ry); the map draws world +x to
      // the right and +z down, and the arrow is drawn pointing up (0, -1):
      // turning it by PI - ry lands its tip on (sin ry, cos ry)
      const heading = Math.PI - local.ry;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(heading);
      ctx.fillStyle = "#ffc857";
      ctx.beginPath();
      ctx.moveTo(0, -6);
      ctx.lineTo(4.6, 5);
      ctx.lineTo(0, 2.4);
      ctx.lineTo(-4.6, 5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();

      // view cone
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(heading);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 30);
      grad.addColorStop(0, "rgba(255,200,87,0.35)");
      grad.addColorStop(1, "rgba(255,200,87,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 30, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /** Reveal a secret room on the map. Returns true when it was hidden. */
  function reveal(id) {
    if (revealed.has(id)) return false;
    revealed.add(id);
    drawStatic();
    return true;
  }

  return { draw, redraw: drawStatic, reveal, isRevealed: (id) => revealed.has(id) };
}

function hexA(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
