import * as THREE from "three";
import {
  SKIN_TONES,
  SHIRT_COLORS,
  PANTS_COLORS,
  HAIR_STYLES,
  ACCESSORIES,
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
function drawDoll(canvas, look) {
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(W / 2, H - 22, 46, 10, 0, 0, Math.PI * 2);
  ctx.fill();

  const cx = W / 2;
  ctx.fillStyle = look.shirt;
  roundRect(ctx, cx - 30, 118, 60, 74, 14);
  ctx.fill();
  ctx.fillStyle = look.pants;
  roundRect(ctx, cx - 26, 186, 22, 74, 8);
  ctx.fill();
  roundRect(ctx, cx + 4, 186, 22, 74, 8);
  ctx.fill();
  ctx.fillStyle = look.skin;
  ctx.beginPath();
  ctx.arc(cx, 96, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#2a2320";
  ctx.beginPath();
  ctx.arc(cx - 8, 92, 2.6, 0, Math.PI * 2);
  ctx.arc(cx + 8, 92, 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#2a2320";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, 102, 9, 0.15 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  // hair
  ctx.fillStyle = look.hairColor;
  const style = look.hairStyle || "short";
  if (style === "short") {
    ctx.beginPath();
    ctx.arc(cx, 92, 25, Math.PI * 1.05, Math.PI * 2.05);
    ctx.fill();
  } else if (style === "long") {
    ctx.beginPath();
    ctx.arc(cx, 92, 25, Math.PI * 1.05, Math.PI * 2.05);
    ctx.fill();
    roundRect(ctx, cx - 27, 88, 12, 60, 6);
    ctx.fill();
    roundRect(ctx, cx + 15, 88, 12, 60, 6);
    ctx.fill();
  } else if (style === "bun") {
    ctx.beginPath();
    ctx.arc(cx, 92, 25, Math.PI * 1.05, Math.PI * 2.05);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, 66, 11, 0, Math.PI * 2);
    ctx.fill();
  } else if (style === "mohawk") {
    ctx.beginPath();
    ctx.moveTo(cx - 4, 74);
    ctx.lineTo(cx, 44);
    ctx.lineTo(cx + 4, 74);
    ctx.closePath();
    ctx.fill();
  } else if (style === "bald") {
    /* nothing */
  } else if (style === "cap") {
    ctx.fillStyle = look.shirt;
    ctx.beginPath();
    ctx.arc(cx, 92, 26, Math.PI * 1.02, Math.PI * 2.02);
    ctx.fill();
    roundRect(ctx, cx - 30, 88, 34, 7, 3);
    ctx.fill();
  }

  // accessory
  const acc = look.accessory || "none";
  if (acc === "glasses") {
    ctx.strokeStyle = "#20242b";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx - 9, 92, 7, 0, Math.PI * 2);
    ctx.arc(cx + 9, 92, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 2, 92);
    ctx.lineTo(cx + 2, 92);
    ctx.stroke();
  } else if (acc === "backpack") {
    ctx.fillStyle = "#5a4632";
    roundRect(ctx, cx - 16, 126, 32, 44, 10);
    ctx.fill();
  } else if (acc === "cape") {
    ctx.fillStyle = "#c0392b";
    ctx.beginPath();
    ctx.moveTo(cx - 26, 122);
    ctx.lineTo(cx + 26, 122);
    ctx.lineTo(cx + 34, 210);
    ctx.lineTo(cx - 34, 210);
    ctx.closePath();
    ctx.fill();
  } else if (acc === "headphones") {
    ctx.strokeStyle = "#20242b";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.arc(cx, 88, 26, Math.PI * 1.1, Math.PI * 1.9);
    ctx.stroke();
    ctx.fillStyle = "#20242b";
    roundRect(ctx, cx - 32, 84, 10, 18, 4);
    ctx.fill();
    roundRect(ctx, cx + 22, 84, 10, 18, 4);
    ctx.fill();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* UI factory                                                           */
/* ------------------------------------------------------------------ */
export function createUI(callbacks = {}) {
  const look = normalizeLook({ ...DEFAULT_LOOK });
  const preview = $("lookPreview");

  function renderLook() {
    drawDoll(preview, look);
  }

  function swatchRow(containerId, colors, current, onPick, asText = false) {
    const box = $(containerId);
    if (!box) return;
    box.innerHTML = "";
    for (const c of colors) {
      const b = document.createElement("button");
      b.className = "sw" + (asText ? " txt" : "");
      if (asText) {
        b.textContent = c;
      } else {
        b.style.background = c;
      }
      if (c === current) b.classList.add("active");
      b.onclick = () => {
        onPick(c);
        for (const child of box.children) child.classList.remove("active");
        b.classList.add("active");
        renderLook();
        callbacks.onLookChange?.(look);
      };
      box.appendChild(b);
    }
  }

  function refreshSwatches() {
    swatchRow("swSkin", SKIN_TONES, look.skin, (v) => (look.skin = v));
    swatchRow("swShirt", SHIRT_COLORS, look.shirt, (v) => (look.shirt = v));
    swatchRow("swPants", PANTS_COLORS, look.pants, (v) => (look.pants = v));
    swatchRow("swHair", HAIR_STYLES, look.hairStyle, (v) => (look.hairStyle = v), true);
    swatchRow("swAcc", ACCESSORIES, look.accessory, (v) => (look.accessory = v), true);
  }

  refreshSwatches();
  renderLook();

  $("randomLook").onclick = () => {
    Object.assign(look, randomLook());
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
