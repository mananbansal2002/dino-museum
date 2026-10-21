import * as THREE from "three";

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export const randInt = (a, b) => Math.floor(rand(a, b + 1));
export const choice = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const TAU = Math.PI * 2;

export function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * t;
}

export function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Canvas texture for world-space signs / placards. */
export function makeTextTexture(
  text,
  {
    width = 1024,
    height = 256,
    fontSize = 64,
    font = null,
    color = "#fff5e6",
    bg = "transparent",
    align = "center",
    sub = null,
    subSize = 34,
    letterSpacing = "1px",
  } = {}
) {
  if (!font) {
    font = `600 ${fontSize}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  }
  const c = makeCanvas(width, height);
  const ctx = c.getContext("2d");
  if (bg && bg !== "transparent") {
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.letterSpacing = letterSpacing;
  const x = align === "center" ? width / 2 : align === "right" ? width - 24 : 24;
  ctx.fillText(text, x, sub ? height * 0.38 : height * 0.5);
  if (sub) {
    ctx.font = `400 ${subSize}px Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
    ctx.globalAlpha = 0.8;
    ctx.fillText(sub, x, height * 0.72);
    ctx.globalAlpha = 1;
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Wall placard: dark plate with a title + subtitle. */
export function makePlacard(title, sub, { w = 2.6, h = 0.65, accent = "#ffb347" } = {}) {
  const c = makeCanvas(1024, 256);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#0d1418";
  ctx.fillRect(0, 0, 1024, 256);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, 1024, 10);
  ctx.fillStyle = "#fff6e6";
  ctx.font = "700 62px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillText(title, 40, 110);
  ctx.fillStyle = accent;
  ctx.font = "500 34px Inter, system-ui, sans-serif";
  ctx.fillText(sub, 40, 180);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true })
  );
  mesh.userData.tex = tex;
  return mesh;
}

/** Floating name tag sprite. */
export function makeNameTag(text, color = "#ffffff") {
  const c = makeCanvas(512, 128);
  const ctx = c.getContext("2d");
  ctx.font = "700 56px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(4,10,14,0.85)";
  ctx.strokeText(text, 256, 64);
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.6, 0.4, 1);
  sprite.renderOrder = 999;
  return sprite;
}

/** Emoji / icon bubble above a player (roar, photo...). */
export function makeBubble(text, color = "#ffd166") {
  const c = makeCanvas(256, 256);
  const ctx = c.getContext("2d");
  ctx.beginPath();
  ctx.arc(128, 128, 96, 0, TAU);
  ctx.fillStyle = "rgba(8,14,20,0.72)";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.font = "700 92px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(0.9, 0.9, 1);
  sprite.renderOrder = 1000;
  return sprite;
}

/** Ground shadow blob under characters. */
export function makeBlobShadow(radius = 0.6, opacity = 0.35) {
  const c = makeCanvas(128, 128);
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, "rgba(0,0,0,0.75)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(radius * 2, radius * 2), mat);
  m.rotation.x = -Math.PI / 2;
  return m;
}

export function catmull(points, closed = false, tension = 0.5) {
  return new THREE.CatmullRomCurve3(
    points.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    closed,
    "catmullrom",
    tension
  );
}

/** Sweep a circle of varying radius along a curve (used for dinosaur bodies). */
export function sweep(curve, radiusFn, tubular = 40, radial = 12) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const frames = curve.computeFrenetFrames(tubular, false);
  const P = new THREE.Vector3();
  const N = new THREE.Vector3();

  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular;
    curve.getPointAt(t, P);
    const r = radiusFn(t);
    const normal = frames.normals[i];
    const binormal = frames.binormals[i];
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * TAU;
      const sin = Math.sin(v);
      const cos = -Math.cos(v);
      N.set(normal.x * cos + binormal.x * sin, normal.y * cos + binormal.y * sin, normal.z * cos + binormal.z * sin);
      positions.push(P.x + N.x * r, P.y + N.y * r, P.z + N.z * r);
      const nx = N.x, ny = N.y, nz = N.z;
      normals.push(nx, ny, nz);
      uvs.push(t, j / radial);
    }
  }
  for (let i = 1; i <= tubular; i++) {
    for (let j = 1; j <= radial; j++) {
      const a = (radial + 1) * (i - 1) + (j - 1);
      const b = (radial + 1) * i + (j - 1);
      const c = (radial + 1) * i + j;
      const d = (radial + 1) * (i - 1) + j;
      indices.push(a, b, d, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setIndex(indices);
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

/** Bone-like cylinder between two points. */
export function boneBetween(a, b, radius, material, radialSeg = 8) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const geo = new THREE.CylinderGeometry(radius * 0.8, radius, len, radialSeg, 1);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

export function pickColor(rng = Math.random) {
  const hue = Math.floor(rng() * 360);
  return new THREE.Color().setHSL(hue / 360, 0.65, 0.55).getHex();
}
