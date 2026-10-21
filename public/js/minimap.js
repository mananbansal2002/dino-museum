import { ROOMS, PLACEMENTS, CELL, GRID_W, GRID_H, g2w, g2z, isSolid } from "./world.js";

/**
 * Top-down minimap. The static floor plan is rendered once into an offscreen
 * canvas; every frame we blit it and draw the visitors on top.
 */
export function createMinimap(canvas, { exhibits = [] } = {}) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);

  const worldW = GRID_W * CELL;
  const worldH = GRID_H * CELL;
  const base = document.createElement("canvas");
  base.width = canvas.width * dpr;
  base.height = canvas.height * dpr;
  const bctx = base.getContext("2d");
  bctx.scale(dpr, dpr);

  const scale = Math.min(canvas.width / worldW, canvas.height / worldH);
  const offX = (canvas.width - worldW * scale) / 2;
  const offY = (canvas.height - worldH * scale) / 2;

  const toX = (wx) => offX + (wx + worldW / 2) * scale;
  const toY = (wz) => offY + (wz + worldH / 2) * scale;

  function drawStatic() {
    bctx.clearRect(0, 0, canvas.width, canvas.height);
    bctx.fillStyle = "rgba(6,10,14,0.9)";
    bctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const room of ROOMS) {
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
      if (x1 - x0 > 46 && z1 - z0 > 22) {
        bctx.fillStyle = hexA(accent, 0.85);
        bctx.font = "600 9px Inter, system-ui, sans-serif";
        bctx.textAlign = "center";
        bctx.fillText(room.name.toUpperCase(), (x0 + x1) / 2, (z0 + z1) / 2);
      }
    }

    // walls
    bctx.strokeStyle = "rgba(190,215,235,0.5)";
    bctx.lineWidth = 1.4;
    for (let r = 0; r < GRID_H; r++) {
      for (let c = 0; c < GRID_W; c++) {
        if (isSolid(c, r)) continue;
        const x0 = toX(g2w(c) - CELL / 2);
        const z0 = toY(g2z(r) - CELL / 2);
        const w = CELL * scale;
        if (isSolid(c - 1, r)) {
          bctx.beginPath();
          bctx.moveTo(x0 + 0.5, z0);
          bctx.lineTo(x0 + 0.5, z0 + w);
          bctx.stroke();
        }
        if (isSolid(c + 1, r)) {
          bctx.beginPath();
          bctx.moveTo(x0 + w - 0.5, z0);
          bctx.lineTo(x0 + w - 0.5, z0 + w);
          bctx.stroke();
        }
        if (isSolid(c, r - 1)) {
          bctx.beginPath();
          bctx.moveTo(x0, z0 + 0.5);
          bctx.lineTo(x0 + w, z0 + 0.5);
          bctx.stroke();
        }
        if (isSolid(c, r + 1)) {
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
      bctx.beginPath();
      bctx.arc(toX(p.x), toY(p.z), 1.9, 0, Math.PI * 2);
      bctx.fill();
    }
    for (const e of exhibits) {
      bctx.fillStyle = "rgba(126,224,129,0.95)";
      bctx.beginPath();
      bctx.arc(toX(e.x), toY(e.z), 2.4, 0, Math.PI * 2);
      bctx.fill();
    }
  }

  drawStatic();

  function draw({ local, remotes = [] }) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(base, 0, 0, canvas.width, canvas.height);

    for (const r of remotes) {
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
      const x = toX(local.x);
      const y = toY(local.z);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-local.ry);
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
      ctx.rotate(-local.ry);
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

  return { draw, redraw: drawStatic };
}

function hexA(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
