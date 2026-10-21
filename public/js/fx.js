import * as THREE from "three";
import { makeCanvas, rand } from "./util.js";

/**
 * A single pooled particle system used for dust, sparkles, water splashes
 * and the confetti burst when you finish your ice cream.
 */
export function createFX(scene, max = 700) {
  const positions = new Float32Array(max * 3);
  const colors = new Float32Array(max * 3);
  const sizes = new Float32Array(max);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

  const sprite = makeCanvas(64, 64);
  const sctx = sprite.getContext("2d");
  const g = sctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.45, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  sctx.fillStyle = g;
  sctx.fillRect(0, 0, 64, 64);
  const spriteTex = new THREE.CanvasTexture(sprite);

  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: spriteTex } },
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (300.0 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      varying vec3 vColor;
      void main() {
        vec4 t = texture2D(map, gl_PointCoord);
        if (t.a < 0.02) discard;
        gl_FragColor = vec4(vColor, t.a);
      }
    `,
    transparent: true,
    depthWrite: false,
    vertexColors: true,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  const particles = [];
  for (let i = 0; i < max; i++) {
    particles.push({
      alive: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0,
      maxLife: 1,
      size: 1,
      r: 1,
      g: 1,
      b: 1,
      gravity: -6,
      drag: 0.98,
    });
  }

  function spawn(opts) {
    const p = particles.find((q) => !q.alive);
    if (!p) return;
    p.alive = true;
    p.x = opts.x;
    p.y = opts.y;
    p.z = opts.z;
    p.vx = opts.vx ?? 0;
    p.vy = opts.vy ?? 0;
    p.vz = opts.vz ?? 0;
    p.life = 0;
    p.maxLife = opts.life ?? 1;
    p.size = opts.size ?? 1;
    p.gravity = opts.gravity ?? -6;
    p.drag = opts.drag ?? 0.985;
    const c = new THREE.Color(opts.color ?? 0xffffff);
    p.r = c.r;
    p.g = c.g;
    p.b = c.b;
  }

  function burst(kind, x, y, z, count = 18) {
    for (let i = 0; i < count; i++) {
      if (kind === "dust") {
        spawn({
          x: x + rand(-0.5, 0.5),
          y: y + rand(0, 0.4),
          z: z + rand(-0.5, 0.5),
          vx: rand(-1.6, 1.6),
          vy: rand(0.4, 2.2),
          vz: rand(-1.6, 1.6),
          life: rand(0.6, 1.3),
          size: rand(2, 5),
          color: 0xcbb69a,
          gravity: -3.2,
        });
      } else if (kind === "sparkle") {
        spawn({
          x: x + rand(-1.2, 1.2),
          y: y + rand(-0.6, 1.2),
          z: z + rand(-1.2, 1.2),
          vx: rand(-0.8, 0.8),
          vy: rand(0.6, 2.4),
          vz: rand(-0.8, 0.8),
          life: rand(0.7, 1.6),
          size: rand(1.6, 3.4),
          color: 0xffe08a,
          gravity: -1.2,
        });
      } else if (kind === "splash") {
        spawn({
          x: x + rand(-1.4, 1.4),
          y,
          z: z + rand(-1.4, 1.4),
          vx: rand(-2.4, 2.4),
          vy: rand(2.5, 5.5),
          vz: rand(-2.4, 2.4),
          life: rand(0.5, 1),
          size: rand(1.6, 3),
          color: 0x8ed6ff,
          gravity: -12,
        });
      } else {
        spawn({
          x: x + rand(-0.6, 0.6),
          y: y + rand(0, 0.8),
          z: z + rand(-0.6, 0.6),
          vx: rand(-3.4, 3.4),
          vy: rand(3, 7),
          vz: rand(-3.4, 3.4),
          life: rand(1.4, 2.6),
          size: rand(2, 4),
          color: new THREE.Color().setHSL(Math.random(), 0.85, 0.6).getHex(),
          gravity: -6,
        });
      }
    }
  }

  function update(dt) {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p.alive) {
        positions[i * 3 + 1] = -9999;
        sizes[i] = 0;
        continue;
      }
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.alive = false;
        continue;
      }
      p.vy += p.gravity * dt;
      p.vx *= p.drag;
      p.vz *= p.drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.05) {
        p.y = 0.05;
        p.vy *= -0.32;
        p.vx *= 0.7;
        p.vz *= 0.7;
      }
      const fade = 1 - p.life / p.maxLife;
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      colors[i * 3] = p.r;
      colors[i * 3 + 1] = p.g;
      colors[i * 3 + 2] = p.b;
      sizes[i] = p.size * fade;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.attributes.size.needsUpdate = true;
  }

  return { burst, spawn, update, points };
}
