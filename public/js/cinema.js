import * as THREE from "three";
import { createDino } from "./dinos.js";
import { SPECIES } from "./species.js";
import { makeCanvas, clamp } from "./util.js";

const MOODS = {
  sunset: { sky: 0xd97a3c, ground: 0x6b4326, fog: 0xd97a3c, light: 0xffd9a0 },
  dusk: { sky: 0x3b4a7a, ground: 0x3a3a2a, fog: 0x3b4a7a, light: 0xcfd8ff },
  night: { sky: 0x0e1626, ground: 0x1a2230, fog: 0x0e1626, light: 0x9fc4ff },
  dawn: { sky: 0x9fc7d8, ground: 0x5d6b4a, fog: 0x9fc7d8, light: 0xfff3d6 },
  swamp: { sky: 0x4a5c3a, ground: 0x3d4526, fog: 0x4a5c3a, light: 0xd8e6b0 },
  volcanic: { sky: 0x53221a, ground: 0x2e1a16, fog: 0x53221a, light: 0xffb08a },
};

/**
 * Renders the battle screenings into an off-screen target that is painted on
 * the theatre screen. Every client renders the same timeline locally, so the
 * screening looks identical for everybody in the room.
 */
export function createCinema({ renderer, screenMat, battles, onLine, onProgress, onEnd, onHit }) {
  const W = 1024;
  const H = 512;

  const target = new THREE.WebGLRenderTarget(W, H, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
  });
  target.texture.colorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.5, 400);
  camera.position.set(0, 9, 52);
  scene.add(camera);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x223022, 1.1);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff0d0, 1.6);
  key.position.set(24, 40, 30);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x88bbff, 0.9);
  rim.position.set(-30, 18, -26);
  scene.add(rim);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(160, 48),
    new THREE.MeshStandardMaterial({ color: 0x6b4326, roughness: 1 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  scene.add(ground);

  const haze = new THREE.Mesh(
    new THREE.RingGeometry(60, 170, 48),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 })
  );
  haze.rotation.x = -Math.PI / 2;
  haze.position.y = 0.02;
  scene.add(haze);

  // screen furniture (title + caption) lives in front of the camera
  const titleCanvas = makeCanvas(1024, 96);
  const titleTex = new THREE.CanvasTexture(titleCanvas);
  titleTex.colorSpace = THREE.SRGBColorSpace;
  const titlePlane = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 2.4),
    new THREE.MeshBasicMaterial({ map: titleTex, transparent: true, depthTest: false })
  );
  titlePlane.position.set(0, 6.4, -8);
  camera.add(titlePlane);

  const capCanvas = makeCanvas(1024, 128);
  const capTex = new THREE.CanvasTexture(capCanvas);
  capTex.colorSpace = THREE.SRGBColorSpace;
  const capPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 3),
    new THREE.MeshBasicMaterial({ map: capTex, transparent: true, depthTest: false })
  );
  capPlane.position.set(0, -5.2, -8);
  camera.add(capPlane);

  let fighters = [];
  let current = null;
  let time = 0;
  let lineIndex = -1;
  let shake = 0;
  let lastHit = -1;

  function clearFighters() {
    for (const f of fighters) {
      scene.remove(f.dino.group);
      f.dino.dispose();
    }
    fighters = [];
  }

  function buildFighters(battle) {
    clearFighters();
    const a = SPECIES[battle.a];
    const b = SPECIES[battle.b];
    if (!a || !b) return;
    const da = createDino(a, { scale: 1 });
    const db = createDino(b, { scale: 1 });
    da.group.position.set(-20, 0, 0);
    db.group.position.set(20, 0, 0);
    da.group.rotation.y = Math.PI / 2;
    db.group.rotation.y = -Math.PI / 2;
    scene.add(da.group);
    scene.add(db.group);
    fighters = [
      { dino: da, base: new THREE.Vector3(-20, 0, 0), side: -1 },
      { dino: db, base: new THREE.Vector3(20, 0, 0), side: 1 },
    ];
  }

  function paintText(canvas, tex, text, sub, color = "#ffe9b0") {
    const ctx = canvas.getContext("2d");
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = color;
    ctx.font = "800 40px Inter, system-ui, sans-serif";
    ctx.fillText(text, w / 2, sub ? h * 0.36 : h * 0.5, w - 40);
    if (sub) {
      ctx.fillStyle = "rgba(255,255,255,0.82)";
      ctx.font = "500 28px Inter, system-ui, sans-serif";
      ctx.fillText(sub, w / 2, h * 0.72, w - 40);
    }
    tex.needsUpdate = true;
  }

  function hits(battle) {
    const re = /charg|lung|snap|bite|strik|slam|attack|swipe|thrust|clash|maul/i;
    return battle.lines.filter((l) => re.test(l[1])).map((l) => l[0]);
  }

  function play(battleId) {
    const battle = battles.find((b) => b.id === battleId) || battles[0];
    if (!battle) return null;
    current = battle;
    time = 0;
    lineIndex = -1;
    lastHit = -1;
    const mood = MOODS[battle.mood] || MOODS.dusk;
    scene.background = new THREE.Color(mood.sky);
    ground.material.color.setHex(mood.ground);
    scene.fog = new THREE.Fog(mood.fog, 90, 260);
    key.color.setHex(mood.light);
    buildFighters(battle);
    paintText(titleCanvas, titleTex, battle.title, battle.subtitle, "#ffd166");
    screenMat.map = target.texture;
    screenMat.color.setHex(0xffffff);
    screenMat.needsUpdate = true;
    onLine?.(battle, -1);
    return battle;
  }

  function stop() {
    current = null;
    clearFighters();
    screenMat.map = null;
    screenMat.color.setHex(0x11151b);
    screenMat.needsUpdate = true;
  }

  function update(dt) {
    if (!current) return;
    time += dt;

    const battle = current;
    const total = battle.duration || 26;
    onProgress?.(clamp(time / total, 0, 1));

    // narration lines
    let idx = -1;
    for (let i = 0; i < battle.lines.length; i++) {
      if (time >= battle.lines[i][0]) idx = i;
    }
    if (idx !== lineIndex) {
      lineIndex = idx;
      if (idx >= 0) {
        const [t, text] = battle.lines[idx];
        paintText(capCanvas, capTex, text, "");
        onLine?.(battle, idx);
      }
    }

    // hits
    const hs = hits(battle);
    for (const h of hs) {
      if (time >= h && lastHit < h) {
        lastHit = h;
        shake = 1;
        onHit?.(battle, h);
      }
    }
    shake = Math.max(0, shake - dt * 2.4);

    // camera move
    const p = clamp(time / total, 0, 1);
    const ang = -0.55 + p * 1.1;
    const dist = 52 - Math.sin(p * Math.PI) * 12;
    camera.position.set(Math.sin(ang) * dist, 9 + Math.sin(p * Math.PI) * 5, Math.cos(ang) * dist);
    camera.lookAt(0, 5.5, 0);
    if (shake > 0) {
      camera.position.x += (Math.random() - 0.5) * shake * 1.6;
      camera.position.y += (Math.random() - 0.5) * shake * 1.2;
    }

    // fighters
    const lunge = Math.max(0, Math.sin((time % 3.1) * 2)) * 3.2;
    for (const f of fighters) {
      const d = f.dino;
      const aggressive = hs.some((h) => Math.abs(time - h) < 1.6);
      d.group.position.x = f.base.x + f.side * (aggressive ? lunge * 3.4 : Math.sin(time * 0.5 + f.side) * 0.6);
      d.group.position.y = Math.abs(Math.sin(time * 1.6 + f.side)) * 0.25;
      d.group.rotation.y = f.side > 0 ? -Math.PI / 2 : Math.PI / 2;
      d.setAnim(aggressive ? "attack" : "idle");
      d.update(dt, { speed: aggressive ? 0.9 : 0.15 });
    }

    if (time >= total) {
      const finished = current;
      current = null;
      onEnd?.(finished);
    }
  }

  function render() {
    if (!current) return;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(prev);
  }

  return {
    play,
    stop,
    update,
    render,
    get playing() {
      return !!current;
    },
    get battle() {
      return current;
    },
    target,
  };
}
