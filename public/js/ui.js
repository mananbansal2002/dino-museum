import * as THREE from "three";
import {
  BODY_TYPES,
  SKIN_TONES,
  SHIRT_COLORS,
  PANTS_COLORS,
  HAIR_STYLES,
  HAIR_COLORS,
  ACCESSORIES,
  DEFAULT_HAIR,
  DEFAULT_LOOK,
  randomLook,
  normalizeLook,
} from "./character.js";

export const FLAVOURS = [
  { id: "strawberry", name: "Strawberry", color: 0xff9aa2 },
  { id: "mintchoco", name: "Mint Choco", color: 0x9ad9c0 },
  { id: "dinodust", name: "Dino Dust", color: 0x8d6e63 },
  { id: "volcano", name: "Volcano Chilli", color: 0xff5a1f },
  { id: "blueberry", name: "Blueberry", color: 0x7d8cff },
  { id: "caramel", name: "Salted Caramel", color: 0xd79a4d },
  { id: "matcha", name: "Matcha", color: 0xa8d08d },
  { id: "vanilla", name: "Extinction Vanilla", color: 0xf5e6c8 },
];

export const TOPPINGS = [
  { id: "sprinkles", name: "Sprinkles", color: 0xff6b9d },
  { id: "chocolate", name: "Choco sauce", color: 0x4a2c17 },
  { id: "cherry", name: "Cherry", color: 0xd7263d },
];

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* little 2D paper-doll preview for the character customiser          */
/* ------------------------------------------------------------------ */
function shade(hex, f) {
  const n = parseInt(String(hex).slice(1), 16) || 0;
  const ch = (v) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `rgb(${r},${g},${b})`;
}

function drawDoll(canvas, look) {
  const ctx = canvas.getContext("2d");
  const W = 200;
  const H = 280;
  const k = canvas.width / W;
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const female = look.body === "female";
  const cx = W / 2;
  const hy = 70; // head centre
  const hr = female ? 23 : 24;
  const shW = female ? 25 : 33; // half shoulder width
  const waistW = female ? 17 : 26;
  const hipW = female ? 30 : 26;
  const legW = female ? 12 : 15;
  const armW = female ? 10 : 13;
  const darkShirt = shade(look.shirt, -0.22);
  const darkPants = shade(look.pants, -0.25);
  const capeCol = shade(look.shirt, -0.45);
  const acc = look.accessory || "none";
  const style = look.hair || "short";

  // floor shadow
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.ellipse(cx, 262, 50, 9, 0, 0, Math.PI * 2);
  ctx.fill();

  /* ---- back layer ---- */
  if (acc === "cape") {
    ctx.fillStyle = capeCol;
    ctx.beginPath();
    ctx.moveTo(cx - shW + 2, 104);
    ctx.lineTo(cx + shW - 2, 104);
    ctx.quadraticCurveTo(cx + shW + 14, 180, cx + shW + 18, 232);
    ctx.lineTo(cx - shW - 18, 232);
    ctx.quadraticCurveTo(cx - shW - 14, 180, cx - shW + 2, 104);
    ctx.fill();
  }
  if (acc === "backpack") {
    ctx.fillStyle = shade(look.shirt, -0.5);
    roundRect(ctx, cx - shW - 4, 108, shW * 2 + 8, 58, 14);
    ctx.fill();
  }
  if (style === "long") {
    ctx.fillStyle = look.hairColor;
    roundRect(ctx, cx - hr - 4, hy - 8, hr * 2 + 8, 78, 18);
    ctx.fill();
  }

  /* ---- legs + shoes ---- */
  ctx.fillStyle = look.pants;
  const legTop = 164;
  const legBot = 246;
  roundRect(ctx, cx - legW - 3, legTop, legW, legBot - legTop, 7);
  ctx.fill();
  roundRect(ctx, cx + 3, legTop, legW, legBot - legTop, 7);
  ctx.fill();
  ctx.fillStyle = "#2a2d34";
  ctx.beginPath();
  ctx.ellipse(cx - legW / 2 - 4, 249, legW / 2 + 4, 6, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + legW / 2 + 4, 249, legW / 2 + 4, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e9e4da";
  ctx.fillRect(cx - legW - 8, 253, legW + 8, 3);
  ctx.fillRect(cx, 253, legW + 8, 3);

  /* ---- hips / skirt ---- */
  ctx.fillStyle = look.pants;
  if (female) {
    ctx.beginPath();
    ctx.moveTo(cx - waistW - 4, 148);
    ctx.lineTo(cx + waistW + 4, 148);
    ctx.quadraticCurveTo(cx + hipW + 4, 172, cx + hipW + 10, 204);
    ctx.lineTo(cx - hipW - 10, 204);
    ctx.quadraticCurveTo(cx - hipW - 4, 172, cx - waistW - 4, 148);
    ctx.fill();
    ctx.fillStyle = darkPants;
    ctx.fillRect(cx - hipW - 10, 200, (hipW + 10) * 2, 4);
  } else {
    roundRect(ctx, cx - hipW, 152, hipW * 2, 26, 8);
    ctx.fill();
  }

  /* ---- arms (behind torso edge) ---- */
  const armTop = 102;
  const armLen = 70;
  for (const s of [-1, 1]) {
    const ax = cx + s * (shW - armW / 2 + 3) - armW / 2 + s * (female ? 4 : 2);
    ctx.save();
    ctx.translate(ax + armW / 2, armTop);
    ctx.rotate(-s * (female ? 0.14 : 0.08));
    ctx.fillStyle = look.skin;
    roundRect(ctx, -armW / 2, 4, armW, armLen, armW / 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(0, armLen + 4, armW * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = look.shirt;
    roundRect(ctx, -armW / 2 - 2, 0, armW + 4, 30, armW / 2);
    ctx.fill();
    ctx.restore();
  }

  /* ---- torso ---- */
  ctx.fillStyle = look.shirt;
  ctx.beginPath();
  if (female) {
    ctx.moveTo(cx - shW, 108);
    ctx.quadraticCurveTo(cx - shW, 100, cx - 10, 99);
    ctx.lineTo(cx + 10, 99);
    ctx.quadraticCurveTo(cx + shW, 100, cx + shW, 108);
    ctx.quadraticCurveTo(cx + shW + 1, 124, cx + waistW, 138);
    ctx.quadraticCurveTo(cx + waistW - 1, 146, cx + waistW + 4, 152);
    ctx.lineTo(cx - waistW - 4, 152);
    ctx.quadraticCurveTo(cx - waistW + 1, 146, cx - waistW, 138);
    ctx.quadraticCurveTo(cx - shW - 1, 124, cx - shW, 108);
  } else {
    ctx.moveTo(cx - shW, 110);
    ctx.quadraticCurveTo(cx - shW, 98, cx - 12, 97);
    ctx.lineTo(cx + 12, 97);
    ctx.quadraticCurveTo(cx + shW, 98, cx + shW, 110);
    ctx.lineTo(cx + waistW, 156);
    ctx.lineTo(cx - waistW, 156);
  }
  ctx.closePath();
  ctx.fill();
  // belt (male) / waist seam (female)
  ctx.fillStyle = female ? darkShirt : "#3a2a1e";
  ctx.fillRect(cx - (female ? waistW + 3 : waistW), female ? 148 : 152, (female ? waistW + 3 : waistW) * 2, 4);
  if (!female) {
    ctx.fillStyle = "#d4b36a";
    ctx.fillRect(cx - 4, 151, 8, 6);
  }
  // collar
  ctx.fillStyle = darkShirt;
  ctx.beginPath();
  ctx.ellipse(cx, 98, 11, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  if (acc === "backpack") {
    ctx.fillStyle = "#3b3328";
    roundRect(ctx, cx - shW + 6, 98, 6, 50, 3);
    ctx.fill();
    roundRect(ctx, cx + shW - 12, 98, 6, 50, 3);
    ctx.fill();
  }
  if (acc === "cape") {
    ctx.fillStyle = "#ffd166";
    ctx.beginPath();
    ctx.arc(cx, 102, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---- neck + head ---- */
  ctx.fillStyle = shade(look.skin, -0.12);
  roundRect(ctx, cx - 7, hy + 16, 14, 16, 5);
  ctx.fill();
  ctx.fillStyle = look.skin;
  ctx.beginPath();
  ctx.ellipse(cx - hr + 1, hy + 2, 4.5, 7, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + hr - 1, hy + 2, 4.5, 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, hy, hr, hr * 1.06, 0, 0, Math.PI * 2);
  ctx.fill();

  // face
  const ink = "#1f1a18";
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.ellipse(cx - 8.5, hy + 1, female ? 4.4 : 4, female ? 5 : 4.5, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + 8.5, hy + 1, female ? 4.4 : 4, female ? 5 : 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(cx - 8.5, hy + 1.6, 2.4, 0, Math.PI * 2);
  ctx.arc(cx + 8.5, hy + 1.6, 2.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = look.hairColor;
  ctx.lineWidth = female ? 1.6 : 2.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - 13, hy - 7);
  ctx.lineTo(cx - 4.5, hy - (female ? 9 : 8));
  ctx.moveTo(cx + 13, hy - 7);
  ctx.lineTo(cx + 4.5, hy - (female ? 9 : 8));
  ctx.stroke();
  if (female) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx - 12.5, hy - 2);
    ctx.lineTo(cx - 15, hy - 4.5);
    ctx.moveTo(cx + 12.5, hy - 2);
    ctx.lineTo(cx + 15, hy - 4.5);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(255,138,128,0.35)";
  ctx.beginPath();
  ctx.ellipse(cx - 13, hy + 9, 4, 2.4, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + 13, hy + 9, 4, 2.4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = female ? "#b8505a" : "#7d3b3b";
  ctx.lineWidth = female ? 2.4 : 2;
  ctx.beginPath();
  ctx.arc(cx, hy + 9, 6.5, 0.18 * Math.PI, 0.82 * Math.PI);
  ctx.stroke();

  /* ---- hair ---- */
  ctx.fillStyle = look.hairColor;
  const crown = () => {
    ctx.beginPath();
    ctx.ellipse(cx, hy - 2, hr + 2, hr * 1.06 + 1, 0, Math.PI * 1.0, Math.PI * 2.0);
    ctx.closePath();
    ctx.fill();
  };
  if (style === "short") {
    crown();
    ctx.beginPath();
    ctx.ellipse(cx + 6, hy - 14, 13, 5.5, -0.35, 0, Math.PI * 2);
    ctx.fill();
  } else if (style === "long") {
    crown();
    roundRect(ctx, cx - hr - 4, hy - 6, 10, 62, 5);
    ctx.fill();
    roundRect(ctx, cx + hr - 6, hy - 6, 10, 62, 5);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(cx - 5, hy - 14, 16, 6, 0.3, 0, Math.PI * 2);
    ctx.fill();
  } else if (style === "bun") {
    crown();
    ctx.beginPath();
    ctx.arc(cx, hy - hr - 9, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ff8fab";
    ctx.fillRect(cx - 8, hy - hr - 1, 16, 3);
  } else if (style === "spiky") {
    crown();
    ctx.beginPath();
    const n = 6;
    ctx.moveTo(cx - hr - 1, hy - 8);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const a = Math.PI * (1 + t);
      const bx = cx + Math.cos(a) * (hr + 2);
      const by = hy - 4 + Math.sin(a) * (hr + 2);
      if (i > 0) ctx.lineTo(bx, by);
      if (i < n) {
        const a2 = Math.PI * (1 + (i + 0.5) / n);
        ctx.lineTo(cx + Math.cos(a2) * (hr + 13), hy - 4 + Math.sin(a2) * (hr + 13));
      }
    }
    ctx.closePath();
    ctx.fill();
  } else if (style === "buzz") {
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.ellipse(cx, hy - 3, hr + 0.5, hr * 1.04, 0, Math.PI * 1.08, Math.PI * 1.92);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  } else if (style === "mohawk") {
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.ellipse(cx, hy - 3, hr + 0.5, hr * 1.04, 0, Math.PI * 1.08, Math.PI * 1.92);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 6, hy - hr + 6);
    ctx.lineTo(cx - 4, hy - hr - 18);
    ctx.lineTo(cx, hy - hr - 12);
    ctx.lineTo(cx + 3, hy - hr - 22);
    ctx.lineTo(cx + 6, hy - hr + 6);
    ctx.closePath();
    ctx.fill();
  } else if (style === "curly") {
    for (let i = 0; i < 11; i++) {
      const a = Math.PI * (0.95 + (i / 10) * 1.1);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * (hr + 1), hy - 3 + Math.sin(a) * (hr + 1), 7.5 + (i % 3), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(cx - 7, hy - hr + 2, 8, 0, Math.PI * 2);
    ctx.arc(cx + 7, hy - hr + 2, 8, 0, Math.PI * 2);
    ctx.fill();
  } else if (style === "bald") {
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.beginPath();
    ctx.ellipse(cx - 8, hy - 15, 6, 3, -0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  /* ---- head accessories ---- */
  if (acc === "glasses") {
    ctx.strokeStyle = "#20242b";
    ctx.lineWidth = 2.2;
    ctx.fillStyle = "rgba(159,211,255,0.25)";
    ctx.beginPath();
    ctx.arc(cx - 8.5, hy + 1, 6.5, 0, Math.PI * 2);
    ctx.moveTo(cx + 15, hy + 1);
    ctx.arc(cx + 8.5, hy + 1, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 2, hy);
    ctx.lineTo(cx + 2, hy);
    ctx.moveTo(cx - 15, hy);
    ctx.lineTo(cx - hr, hy - 2);
    ctx.moveTo(cx + 15, hy);
    ctx.lineTo(cx + hr, hy - 2);
    ctx.stroke();
  } else if (acc === "cap") {
    ctx.fillStyle = look.shirt;
    ctx.beginPath();
    ctx.ellipse(cx, hy - 8, hr + 3, hr * 0.95, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = darkShirt;
    ctx.beginPath();
    ctx.ellipse(cx + 4, hy - 8, hr + 8, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffd166";
    ctx.beginPath();
    ctx.arc(cx, hy - 20, 4.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (acc === "headphones") {
    ctx.strokeStyle = "#22252b";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, hy - 1, hr + 5, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
    ctx.fillStyle = "#22252b";
    roundRect(ctx, cx - hr - 9, hy - 8, 10, 20, 4);
    ctx.fill();
    roundRect(ctx, cx + hr - 1, hy - 8, 10, 20, 4);
    ctx.fill();
    ctx.fillStyle = "#ff8fab";
    ctx.fillRect(cx - hr - 1, hy - 5, 2, 14);
    ctx.fillRect(cx + hr - 1, hy - 5, 2, 14);
  } else if (acc === "headlamp") {
    ctx.fillStyle = "#22252b";
    ctx.fillRect(cx - hr - 1, hy - 14, hr * 2 + 2, 5);
    ctx.fillStyle = "#ffb703";
    roundRect(ctx, cx - 7, hy - 19, 14, 11, 3);
    ctx.fill();
    const glow = ctx.createRadialGradient(cx, hy - 13.5, 1, cx, hy - 13.5, 16);
    glow.addColorStop(0, "rgba(255,246,194,0.95)");
    glow.addColorStop(1, "rgba(255,246,194,0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, hy - 13.5, 16, 0, Math.PI * 2);
    ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* UI factory                                                           */
/* ------------------------------------------------------------------ */
export function createUI(callbacks = {}) {
  const look = normalizeLook({ ...DEFAULT_LOOK });
  const preview = $("lookPreview");
  // until the visitor picks a hair style, switching body swaps the default hair
  let hairPicked = false;

  function renderLook() {
    drawDoll(preview, look);
  }

  /**
   * kind: "color" (items {id,name,hex}, value = hex),
   *       "text"  (items {id,name}, value = id),
   *       "body"  (BODY_TYPES, value = id, icon + name)
   */
  function swatchRow(containerId, items, current, onPick, kind = "color") {
    const box = $(containerId);
    if (!box) return;
    box.innerHTML = "";
    for (const item of items) {
      const value = kind === "color" ? item.hex : item.id;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sw" + (kind === "text" ? " txt" : kind === "body" ? " body" : "");
      b.title = item.name;
      b.setAttribute("aria-label", item.name);
      if (kind === "color") {
        b.style.background = item.hex;
      } else if (kind === "body") {
        const icon = document.createElement("span");
        icon.className = "ico";
        icon.textContent = item.icon;
        const label = document.createElement("span");
        label.textContent = item.name;
        b.append(icon, label);
      } else {
        b.textContent = item.name;
      }
      const active = String(value).toLowerCase() === String(current).toLowerCase();
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
      b.onclick = () => {
        onPick(value);
        refreshSwatches();
        renderLook();
        callbacks.onLookChange?.(look);
      };
      box.appendChild(b);
    }
  }

  function refreshSwatches() {
    swatchRow(
      "swBody",
      BODY_TYPES,
      look.body,
      (v) => {
        if (!hairPicked && look.hair === DEFAULT_HAIR[look.body]) look.hair = DEFAULT_HAIR[v];
        look.body = v;
      },
      "body"
    );
    swatchRow("swSkin", SKIN_TONES, look.skin, (v) => (look.skin = v));
    swatchRow("swShirt", SHIRT_COLORS, look.shirt, (v) => (look.shirt = v));
    swatchRow("swPants", PANTS_COLORS, look.pants, (v) => (look.pants = v));
    swatchRow(
      "swHair",
      HAIR_STYLES,
      look.hair,
      (v) => {
        hairPicked = true;
        look.hair = v;
      },
      "text"
    );
    swatchRow("swHairColor", HAIR_COLORS, look.hairColor, (v) => (look.hairColor = v));
    swatchRow("swAcc", ACCESSORIES, look.accessory, (v) => (look.accessory = v), "text");
  }

  refreshSwatches();
  renderLook();

  $("randomLook").onclick = () => {
    Object.assign(look, normalizeLook(randomLook()));
    hairPicked = false;
    refreshSwatches();
    renderLook();
    callbacks.onLookChange?.(look);
  };

  // ---------------- join ----------------
  function showStatus(text) {
    $("joinStatus").textContent = text || "";
  }

  $("enterBtn").onclick = () => {
    const name = $("nameInput").value.trim() || "Visitor";
    const room = $("roomInput").value.trim().toUpperCase();
    callbacks.onJoin?.({ name, room, look: { ...look } });
  };

  $("soloBtn").onclick = () => {
    const name = $("nameInput").value.trim() || "Visitor";
    callbacks.onJoin?.({ name, room: "", look: { ...look }, solo: true });
  };

  $("nameInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("enterBtn").click();
  });
  $("roomInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("enterBtn").click();
  });

  // ---------------- HUD ----------------
  const hud = $("hud");
  const chatLog = $("chatLog");
  const chatInput = $("chatInput");

  function enterGame() {
    $("join").classList.add("hidden");
    hud.classList.remove("hidden");
    $("loading").classList.add("hidden");
  }

  function setHall(name) {
    $("hallName").textContent = name;
  }
  function setRoom(code) {
    $("roomCode").textContent = code;
  }
  function setCounters({ discovered, total, fossils, scoops }) {
    if (discovered != null) {
      $("statDiscovered").textContent = discovered;
      $("statTotal").textContent = total;
    }
    if (fossils != null) $("statFossils").textContent = fossils;
    if (scoops != null) $("statScoops").textContent = scoops;
  }

  function setPrompt(text, key) {
    const el = $("prompt");
    if (!text) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    $("promptKey").textContent = key || "E";
    $("promptText").textContent = text;
  }

  function toast(text, kind = "") {
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = text;
    $("toasts").appendChild(el);
    setTimeout(() => {
      el.style.transition = "opacity .4s";
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 400);
    }, 2600);
  }

  function chat(entry) {
    const el = document.createElement("div");
    el.className = "m";
    if (entry.system) {
      el.classList.add("sys");
      el.textContent = entry.text;
    } else {
      el.innerHTML = `<b>${escapeHtml(entry.name)}:</b> ${escapeHtml(entry.text)}`;
    }
    chatLog.appendChild(el);
    while (chatLog.children.length > 60) chatLog.firstChild.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function setPlayers(list, myId) {
    const box = $("playerList");
    box.innerHTML = "";
    for (const p of list) {
      const row = document.createElement("div");
      row.className = "p" + (p.id === myId ? " me" : "");
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = p.color || "#ffc857";
      const name = document.createElement("span");
      name.textContent = p.name + (p.id === myId ? " (you)" : "");
      row.append(dot, name);
      if (p.iceCream) {
        const ic = document.createElement("span");
        ic.textContent = "🍦";
        row.appendChild(ic);
      }
      box.appendChild(row);
    }
  }

  $("copyRoom").onclick = async () => {
    const code = $("roomCode").textContent;
    const url = `${location.origin}/?room=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Invite link copied", "good");
    } catch {
      toast(url);
    }
  };

  $("toggleKeys").onclick = () => {
    const k = $("keyHelp");
    k.classList.toggle("collapsed");
    $("toggleKeys").textContent = k.classList.contains("collapsed") ? "show" : "hide";
  };

  function openChat() {
    chatInput.classList.add("open");
    chatInput.focus();
  }
  function closeChat() {
    chatInput.classList.remove("open");
    chatInput.value = "";
    chatInput.blur();
  }
  chatInput.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      const text = chatInput.value.trim();
      if (text) callbacks.onChat?.(text);
      closeChat();
    } else if (e.key === "Escape") {
      closeChat();
    }
  });
  chatInput.addEventListener("blur", () => chatInput.classList.remove("open"));

  // ---------------- exhibit card ----------------
  function showExhibit(ex) {
    const body = $("exhibitCardBody");
    const stats = ex.stats || {};
    const bar = (label, value) => `
      <div class="barRow">
        <span>${label}</span>
        <div class="barTrack"><i style="width:${Math.max(3, Math.min(100, value || 0))}%"></i></div>
        <b style="color:var(--text);text-align:right">${value || 0}</b>
      </div>`;
    body.innerHTML = `
      <div class="exTop">
        <div>
          <div class="exEra">${escapeHtml(ex.era || "")}</div>
          <h2 class="exTitle">${escapeHtml(ex.title)}</h2>
        </div>
        <button class="chip" id="closeExhibit">close ✕</button>
      </div>
      <p class="lead">${escapeHtml(ex.blurb || "")}</p>
      <div class="exGrid">
        <div class="stat"><span>Period</span><b>${escapeHtml(ex.period || "—")}</b></div>
        <div class="stat"><span>Habitat</span><b>${escapeHtml(ex.habitat || "—")}</b></div>
        <div class="stat"><span>Length</span><b>${escapeHtml(ex.length || "—")}</b></div>
        <div class="stat"><span>Weight</span><b>${escapeHtml(ex.weight || "—")}</b></div>
        <div class="stat"><span>Diet</span><b>${escapeHtml(ex.diet || "—")}</b></div>
        <div class="stat"><span>Top speed</span><b>${escapeHtml(ex.speed || "—")}</b></div>
      </div>
      <div class="bars">
        ${bar("Size", stats.size)}${bar("Speed", stats.speed)}${bar("Bite", stats.bite)}${bar("Brain", stats.brain)}
      </div>
      ${
        ex.facts?.length
          ? `<ul class="facts">${ex.facts.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>`
          : ""
      }
    `;
    $("closeExhibit").onclick = hideExhibit;
    $("exhibitCard").classList.remove("hidden");
  }
  function hideExhibit() {
    $("exhibitCard").classList.add("hidden");
  }
  $("exhibitCard").addEventListener("click", (e) => {
    if (e.target.id === "exhibitCard") hideExhibit();
  });

  // ---------------- ice cream ----------------
  let ice = { flavour: FLAVOURS[0], scoops: 1, style: "cone", toppings: [] };

  function renderIce() {
    const list = $("flavourList");
    list.innerHTML = "";
    for (const f of FLAVOURS) {
      const b = document.createElement("button");
      b.className = "flav" + (f.id === ice.flavour.id ? " active" : "");
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = `#${f.color.toString(16).padStart(6, "0")}`;
      const label = document.createElement("span");
      label.textContent = f.name;
      b.append(sw, label);
      b.onclick = () => {
        ice.flavour = f;
        renderIce();
      };
      list.appendChild(b);
    }

    const seg = $("scoopSeg");
    seg.innerHTML = "";
    for (const n of [1, 2, 3]) {
      const b = document.createElement("button");
      b.textContent = `${"🍨".repeat(n)} ${n}`;
      b.className = ice.scoops === n ? "active" : "";
      b.onclick = () => {
        ice.scoops = n;
        renderIce();
      };
      seg.appendChild(b);
    }

    const styleSeg = $("styleSeg");
    styleSeg.innerHTML = "";
    for (const [id, label] of [
      ["cone", "🥠 cone"],
      ["cup", "🥤 cup"],
    ]) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = ice.style === id ? "active" : "";
      b.onclick = () => {
        ice.style = id;
        renderIce();
      };
      styleSeg.appendChild(b);
    }
    const top = document.createElement("button");
    top.textContent = "🍫 toppings";
    top.onclick = () => {
      const cur = ice.toppings;
      const next = cur.includes("sprinkles")
        ? cur.filter((t) => t !== "sprinkles")
        : [...cur, "sprinkles"];
      ice.toppings = next;
      toast(next.length ? "Added sprinkles 🍓" : "Removed sprinkles");
    };
    styleSeg.appendChild(top);
  }
  renderIce();

  function openIce() {
    $("iceCream").classList.remove("hidden");
  }
  function closeIce() {
    $("iceCream").classList.add("hidden");
  }
  $("cancelIce").onclick = closeIce;
  $("orderBtn").onclick = () => {
    callbacks.onOrder?.(ice);
    closeIce();
  };

  // ---------------- battle ----------------
  function showBattle(battle) {
    $("battleOverlay").classList.remove("hidden");
    $("battleTitle").textContent = battle.title;
    $("battleSub").textContent = battle.subtitle;
    $("battleFacts").innerHTML = `<b>Museum notes</b>${(battle.facts || [])
      .map((f) => `<div>• ${escapeHtml(f)}</div>`)
      .join("")}`;
    $("battleCaption").textContent = "";
  }
  function setBattleCaption(text) {
    $("battleCaption").textContent = text || "";
  }
  function setBattleProgress(p) {
    $("battleBar").style.width = `${Math.round(p * 100)}%`;
  }
  function hideBattle() {
    $("battleOverlay").classList.add("hidden");
  }
  $("stopBattle").onclick = () => callbacks.onStopBattle?.();

  // ---------------- modal ----------------
  function modal(html) {
    $("modalBody").innerHTML = html;
    $("modal").classList.remove("hidden");
  }
  function closeModal() {
    $("modal").classList.add("hidden");
  }
  $("modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });

  return {
    look,
    enterGame,
    showStatus,
    setHall,
    setRoom,
    setCounters,
    setPrompt,
    toast,
    chat,
    setPlayers,
    openChat,
    closeChat,
    isChatOpen: () => chatInput.classList.contains("open"),
    showExhibit,
    hideExhibit,
    openIce,
    closeIce,
    iceOrder: () => ice,
    showBattle,
    hideBattle,
    setBattleCaption,
    setBattleProgress,
    modal,
    closeModal,
    isModalOpen: () => !$("modal").classList.contains("hidden"),
    isCardOpen: () => !$("exhibitCard").classList.contains("hidden"),
    isIceOpen: () => !$("iceCream").classList.contains("hidden"),
    closeAll: () => {
      hideExhibit();
      closeIce();
      closeModal();
    },
  };
}

function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

/* ------------------------------------------------------------------ */
/* ice cream prop shown in the player's hand                            */
/* ------------------------------------------------------------------ */
export function makeIceCream(order) {
  const g = new THREE.Group();
  const flavour = order.flavour;
  const color = flavour?.color ?? 0xff9aa2;

  const scoopMat = new THREE.MeshStandardMaterial({ color, roughness: 0.72 });
  for (let i = 0; i < order.scoops; i++) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), scoopMat);
    s.position.y = 0.34 + i * 0.2;
    s.castShadow = true;
    g.add(s);
  }

  if (order.style === "cone") {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.13, 0.42, 14),
      new THREE.MeshStandardMaterial({ color: 0xd9a05b, roughness: 0.9 })
    );
    cone.position.y = 0.1;
    cone.rotation.x = Math.PI;
    g.add(cone);
  } else {
    const cup = new THREE.Mesh(
      new THREE.CylinderGeometry(0.14, 0.1, 0.28, 14),
      new THREE.MeshStandardMaterial({ color: 0xf2f0e6, roughness: 0.7 })
    );
    cup.position.y = 0.13;
    g.add(cup);
  }

  if (order.toppings?.includes("sprinkles")) {
    const spr = new THREE.Mesh(
      new THREE.SphereGeometry(0.02, 6, 5),
      new THREE.MeshStandardMaterial({ color: 0xff6b9d, roughness: 0.6 })
    );
    spr.position.set(0.05, 0.44 + (order.scoops - 1) * 0.2, 0.04);
    g.add(spr);
  }

  g.rotation.x = -0.35;
  g.position.set(0, -0.05, 0.06);
  return g;
}
