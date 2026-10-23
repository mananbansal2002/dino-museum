/**
 * GLSL for the Extinction Room's projection (see extinction.js): one shader
 * for all four walls (a continuous panorama around the room, addressed by
 * metres along the perimeter) and one for the floor. Both share a single
 * uniform set driven by the show's timeline; everything is procedural apart
 * from a small canvas atlas of silhouettes and a canvas of titles.
 */

export function shaderChunks(K) {
  const f = (v) => Number(v).toFixed(3);
  const COMMON = /* glsl */ `
const float P = PERIM;
const float H0 = ${f(K.H0)};
const float PH = ${f(K.PH)};
const float SIMP = ${f(K.S_IMP)};
float h11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 h22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float vnoise1(float x){ float i = floor(x), f = fract(x); return mix(h11(i), h11(i + 1.0), f * f * (3.0 - 2.0 * f)); }
float fbm(vec2 p){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < OCT; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.3; a *= 0.5; }
  return s / (1.0 - pow(0.5, float(OCT)));
}
float fbm1(float x){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < OCT; i++) { s += a * vnoise1(x); x = x * 2.03 + 17.1; a *= 0.5; }
  return s / (1.0 - pow(0.5, float(OCT)));
}
// flame colour by temperature (HDR, but kept below a blown-out white)
vec3 fireRamp(float t){
  t = clamp(t, 0.0, 1.4);
  vec3 c = vec3(0.42, 0.045, 0.006) * smoothstep(0.0, 0.35, t);
  c = mix(c, vec3(1.15, 0.32, 0.045), smoothstep(0.3, 0.75, t));
  c = mix(c, vec3(1.9, 1.0, 0.3), smoothstep(0.85, 1.3, t));
  return c;
}
// soft round particles on a jittered grid; vel > 0 falls, vel < 0 rises
float particles(vec2 p, float scale, float vel, float t, float sway, float size, float density){
  vec2 q = p * scale;
  q.y += t * vel * scale;
  q.x += sin(q.y * 0.6 + t * 0.7) * sway;
  vec2 id = floor(q);
  vec2 f = fract(q) - 0.5;
  vec2 o = (h22(id) - 0.5) * 0.6;
  float pres = step(1.0 - density, h21(id + 7.1));
  float d = length((f - o) * vec2(1.0, 1.35));
  return pres * smoothstep(size, 0.0, d) * (0.45 + 0.55 * h21(id + 3.3));
}
float fireAge(float pd, float front){ return (front - pd) / ${f(K.FIRE_SPEED)}; }
float fireStrength(float age){ return smoothstep(0.0, 1.2, age) * exp(-max(0.0, age - 5.0) / 4.5); }
float periDist(float s){ float d = abs(s - SIMP); return min(d, P - d); }
`;

  const WALL_VERT = /* glsl */ `
attribute float aS;
varying float vS;
varying float vY;
void main(){
  vS = aS;
  vY = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

  const WALL_FRAG = /* glsl */ `
uniform float uClock, uFade, uExp, uFlash, uFireF, uFireOn, uLife, uAsh, uEmbers, uSmoke, uEjecta;
uniform float uDawn, uFern, uTitle, uEpi, uSun, uCloud, uScorched, uShockW, uShockA;
uniform vec3 uSkyTop, uSkyHor, uLand, uHaze;
uniform vec4 uStreak;
uniform vec2 uStreakDir;
uniform vec2 uPlume;
uniform vec2 uMammal;
uniform sampler2D uAtlas;
uniform sampler2D uText;
varying float vS;
varying float vY;
${COMMON}

// one cell of the 4 x 3 silhouette atlas; uv (0,0) = bottom left of the cell
float sprite(float cell, vec2 uv){
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  uv = clamp(uv, 0.006, 0.994);
  float col = mod(cell, 4.0);
  float row = floor(cell / 4.0);
  return texture2D(uAtlas, vec2((col + uv.x) * 0.25, 1.0 - (row + 1.0) / 3.0 + uv.y / 3.0)).r;
}
// burn state of something standing at perimeter position s
// (once the fire has been all the way round, uScorched keeps everything burnt)
float burntAt(float s){ return max(uScorched, uFireOn * smoothstep(0.3, 3.0, fireAge(periDist(s), uFireF))); }

// silhouettes strolling along a lane (cells of cellW metres, a few occupied);
// a sprite may spill into the next cell, so the previous cell is checked too
float herd(float s, float y, float cellW, float speed, float feet, float size, float seed, float prob, float typeA, float typeB){
  float x = s + uClock * speed + seed * 31.0;
  float a = 0.0;
  for (int k = 0; k < 2; k++) {
    float id = floor(x / cellW) - float(k);
    if (h11(id * 1.7 + seed) >= prob) continue;
    float sc = size * (0.75 + 0.45 * h11(id * 5.3 + seed));
    float x0 = id * cellW + h11(id * 3.1 + seed) * cellW * 0.6;
    float bob = sin(uClock * 2.4 + id * 1.3) * 0.01 * sc;
    vec2 uv = vec2((x - x0) / sc, (y - feet - bob) / sc);
    float type = h11(id * 7.7 + seed) < 0.5 ? typeA : typeB;
    // the animals die as the fire reaches them
    float alive = 1.0 - burntAt(x0 + sc * 0.5 - uClock * speed - seed * 31.0);
    a = max(a, sprite(type, uv) * alive);
  }
  return a;
}
// a row of trees (types 7, 8, 9), burnt ones turn into snags (11);
// returns (coverage, rim light)
vec2 trees(float s, float y, float cellW, float size, float var, float feet, float feetVar, float seed, float prob, float openNearImpact, float lightDir){
  float x = s + seed * 13.0;
  vec2 res = vec2(0.0);
  for (int k = 0; k < 2; k++) {
    float id = floor(x / cellW) - float(k);
    float sc = size + var * h11(id * 1.9 + seed);
    float x0 = id * cellW + h11(id * 5.1 + seed) * cellW * 0.5;
    float centre = x0 + sc * 0.5 - seed * 13.0;
    float open = mix(1.0, smoothstep(5.0, 13.0, periDist(centre)), openNearImpact);
    if (h11(id * 3.7 + seed) >= prob * open) continue;
    float base = feet + feetVar * h11(id * 2.6 + seed);
    float hT = h11(id * 8.3 + seed);
    float type = burntAt(centre) > 0.5 ? 11.0 : hT < 0.45 ? 7.0 : hT < 0.8 ? 8.0 : 9.0;
    float mirror = step(0.5, h11(id * 9.1 + seed));
    // each tree a little narrower or taller than the drawing, for variety
    float narrow = 0.72 + 0.28 * h11(id * 4.4 + seed);
    vec2 uv = vec2(0.5 + ((x - x0) / sc - 0.5) / narrow, (y - base) / sc);
    vec2 uvL = vec2(0.5 + ((x + lightDir * 0.06 - x0) / sc - 0.5) / narrow, (y + 0.05 - base) / sc);
    if (mirror > 0.5) { uv.x = 1.0 - uv.x; uvL.x = 1.0 - uvL.x; }
    float a = smoothstep(0.06, 0.7, sprite(type, uv));
    if (a > res.x) {
#ifdef RIM
      res = vec2(a, a * (1.0 - smoothstep(0.06, 0.7, sprite(type, uvL))));
#else
      res = vec2(a, 0.0);
#endif
    }
  }
  return res;
}

void main(){
  float s = vS;
  if (s > P * 0.5) s -= P;
  float y = vY;
  float age = fireAge(periDist(s), uFireF);
  float fstr = uFireOn * fireStrength(age);
  float burnt = max(uScorched, uFireOn * smoothstep(0.5, 6.0, age));
  float elev = clamp((y - H0) / (PH - H0), 0.0, 1.0);
  float lightDir = s < 26.0 ? 1.0 : -1.0; // towards the low sun on the west wall

  /* ---------------- sky ---------------- */
  vec3 col = mix(uSkyHor, uSkyTop, pow(elev, 0.55));
  vec2 sp = vec2(s - 26.0, y - (H0 + 1.15));
  float sd = length(sp);
  col += uSun * (vec3(2.0, 1.5, 0.85) * smoothstep(0.32, 0.28, sd) + vec3(1.0, 0.6, 0.3) * exp(-sd * 0.45) * 0.45);
  // drifting cumulus, lit from the horizon side
  vec2 cq = vec2(s * 0.07 + uClock * 0.012, y * 0.42);
  float cn = fbm(cq + vec2(fbm(cq * 1.7 + 3.1) * 0.6, 0.0));
  float band = smoothstep(0.06, 0.32, elev) * smoothstep(1.05, 0.55, elev);
  float cd = smoothstep(0.5, 0.78, cn) * band;
  float cl = clamp((cn - fbm(cq + vec2(0.05 * lightDir, -0.09))) * 5.0 + 0.45, 0.0, 1.0);
  vec3 cloudCol = mix(uSkyTop * 0.5 + uSkyHor * 0.1, uSkyHor * 1.15, cl);
  col = mix(col, cloudCol, cd * 0.85);

  // the bolide: a white-hot head and an ionised trail
  if (uStreak.z > 0.0) {
    vec2 hp = vec2(s, y) - uStreak.xy;
    float along = dot(hp, uStreakDir);
    float perp = length(hp - along * uStreakDir);
    float tw = 0.02 + max(0.0, along) * 0.012;
    float ahead = max(along, 0.0); // (exp of a negative distance would overflow)
    float trail = step(0.0, along) * exp(-ahead / uStreak.w) * exp(-perp * perp / (tw * tw));
    float glowT = step(0.0, along) * exp(-ahead / (uStreak.w * 1.5)) * exp(-perp / (0.22 + ahead * 0.06));
    float r2 = dot(hp, hp);
    col += uStreak.z * (vec3(2.4, 2.2, 2.0) * trail * 1.6 + vec3(1.4, 0.8, 0.4) * glowT * 0.35
                        + vec3(5.0, 5.0, 5.4) / (1.0 + r2 * 700.0) + vec3(1.0, 0.85, 0.7) * exp(-sqrt(r2) * 1.5) * 0.22);
  }

  // impact plume: a hot glowing base and a dark, rising column of smoke
  if (uPlume.y > 0.0) {
    vec2 pp = vec2(s - SIMP, y - H0 + 0.1);
    float R = 0.4 + uPlume.x * 0.4;
    float rise = pp.y / max(R * 1.6, 0.1);
    float width = R * (0.55 + 0.45 * smoothstep(0.2, 1.0, rise));
    float turb = fbm(pp * vec2(0.9, 0.6) + vec2(0.0, -uClock * 0.3));
    float m = smoothstep(width + 0.3, width - 0.6, abs(pp.x) + (turb - 0.5) * 1.5) * smoothstep(R * 1.7, R * 1.2, pp.y + (turb - 0.5));
    float heat = clamp(1.2 - rise * 1.1 + (turb - 0.5) * 0.6, 0.0, 1.3) * smoothstep(14.0, 0.0, uPlume.x);
    vec3 smokeC = mix(vec3(0.06, 0.03, 0.02), uSkyHor * 0.5, 0.3) * (0.6 + 0.6 * turb);
    vec3 pc = smokeC + fireRamp(heat) * (0.5 + 0.6 * turb);
    col = mix(col, pc, m * uPlume.y);
    col += vec3(1.5, 0.55, 0.15) * exp(-length(pp * vec2(0.25, 0.6)) * 0.6) * uPlume.y * 0.35 * smoothstep(16.0, 0.0, uPlume.x);
  }

  // smoke from the firestorm, underlit by it
  if (uSmoke > 0.0) {
    vec2 mq = vec2(s * 0.08, y * 0.15 - uClock * 0.05);
    float mn = fbm(mq + fbm(mq * 2.1 + uClock * 0.02));
    float smoke = uSmoke * smoothstep(0.3, 0.72, mn + elev * 0.25);
    vec3 smokeCol = vec3(0.03, 0.02, 0.016) + uSkyHor * 0.45 * (1.0 - elev) * (0.4 + 0.6 * mn);
    col = mix(col, smokeCol, smoke);
  }

  // ejecta re-entering: glowing streaks falling all around the sky
  if (uEjecta > 0.0 && y > H0) {
    vec2 q = vec2(s * 0.95 + y * 0.3, y - s * 0.3 + uClock * 9.0);
    vec2 cid = floor(q / vec2(1.6, 7.0));
    vec2 f = q - cid * vec2(1.6, 7.0);
    float on = step(0.6, h21(cid));
    float x0 = 0.3 + h21(cid + 1.3) * 1.0;
    float len = 0.8 + h21(cid + 2.7) * 2.2;
    float streak = exp(-abs(f.x - x0) * 24.0) * smoothstep(len, 0.0, f.y) * smoothstep(0.0, 0.12, f.y);
    col += vec3(2.6, 1.1, 0.35) * streak * on * uEjecta * (0.3 + elev);
  }

  /* ---------------- far range and hills ---------------- */
  {
    float m1 = H0 + 0.08 + 1.55 * pow(fbm1(s * 0.03 + 7.0), 2.3);
    float m1b = H0 + 0.08 + 1.55 * pow(fbm1((s + 0.25 * lightDir) * 0.03 + 7.0), 2.3);
    float ma = smoothstep(m1 + 0.012, m1 - 0.012, y);
    float lit = clamp(0.5 + (m1b - m1) * 9.0, 0.0, 1.0);
    float snowish = smoothstep(m1 - 0.25, m1, y) * 0.25;
    vec3 mCol = mix(uHaze * 0.72, mix(uSkyHor, uHaze, 0.35) * 1.05, lit * 0.8 + snowish);
    mCol = mix(mCol, mix(uSkyHor, uHaze, 0.6), smoothstep(m1 - 0.2, H0, y) * 0.5); // haze at the foot
    col = mix(col, mCol, ma);
    float m2 = H0 + 0.04 + 0.45 * fbm1(s * 0.11 + 3.0);
    float m2a = smoothstep(m2 + 0.01, m2 - 0.01, y);
    vec3 hCol = mix(uSkyHor * 0.45, uHaze * 0.42 + uLand * vec3(0.05, 0.07, 0.03), 0.7);
    hCol = mix(hCol, uSkyHor * 0.18 + vec3(0.015, 0.008, 0.0), burnt);
    col = mix(col, hCol, m2a);
  }

  /* ---------------- ground ---------------- */
  if (y < H0) {
    float k = (H0 - y) / H0;
    float D = 1.0 / (k + 0.035);
    float detail = clamp(2.5 / D, 0.0, 1.0);
    float g = mix(0.5, fbm(vec2(s * D * 0.08, D * 0.9)), detail);
    float g2 = mix(0.5, vnoise(vec2(s * D * 0.6, D * 5.0)), detail * detail);
    float patches = mix(1.0, 0.6 + 0.7 * fbm(vec2(s * 0.035 + uClock * 0.006, D * 0.08)), uCloud);
    vec3 near = uLand * mix(vec3(0.05, 0.075, 0.025), vec3(0.16, 0.14, 0.06), g) * (0.75 + 0.5 * g2) * patches;
    vec3 far = mix(uHaze * 0.5, uLand * vec3(0.12, 0.13, 0.07), 0.45);
    vec3 ground = mix(far, near, smoothstep(0.0, 0.5, k));
    // a lake mirroring the sky in the middle distance
    float lake = smoothstep(0.55, 0.6, fbm1(s * 0.05 + 11.0)) * step(0.025, k) * step(k, 0.11 + 0.06 * vnoise1(s * 0.4));
    float rip = 0.85 + 0.15 * sin(D * 9.0 + vnoise(vec2(s * 3.0, D)) * 6.0 + uClock * 0.6);
    ground = mix(ground, mix(uSkyHor, uSkyTop, 0.25) * 0.62 * rip, lake * (1.0 - burnt));
    // scorched, a few embers smouldering in it
    ground = mix(ground, vec3(0.014, 0.011, 0.009) + uLand * 0.02, burnt * 0.92);
    float ember = smoothstep(0.86, 0.95, vnoise(vec2(s * D * 0.9, D * 6.0) + uClock * 0.05)) * (0.6 + 0.4 * sin(uClock * 3.0 + s * 7.0));
    ground += vec3(0.8, 0.16, 0.02) * ember * burnt * uEmbers * smoothstep(0.1, 0.8, k) * 0.18;
    col = ground;
  }

  /* ---------------- life ---------------- */
  vec3 farTint = mix(uLand * 0.06, uHaze * 0.7, 0.6);
  // distant forest along the horizon: a ragged canopy band with crowns above it
  {
    float top = H0 + 0.06 + 0.2 * fbm1(s * 0.9 + 4.0) + 0.06 * vnoise1(s * 7.0) + 0.03 * vnoise1(s * 23.0);
    float band = smoothstep(top + 0.02, top - 0.02, y) * step(H0 - 0.2, y);
    vec3 bandCol = mix(uLand * 0.05, uHaze * 0.62, 0.62);
    bandCol = mix(bandCol, uSkyHor * 0.12, burntAt(s) * 0.7);
    col = mix(col, bandCol, band * (1.0 - burntAt(s) * 0.6));
  }
  vec2 tr = trees(s, y, 0.8, 0.6, 0.6, H0 - 0.08, 0.08, 3.0, 0.9, 0.0, lightDir);
  col = mix(col, mix(uLand * 0.04, uHaze * 0.55, 0.55) + tr.y * uSkyHor * 0.08, tr.x);
  // far herds (triceratops, hadrosaurs)
  float a = herd(s, y, 3.2, 0.12, H0 - 0.05, 0.2, 1.0, 0.5, 1.0, 0.0);
  col = mix(col, farTint, a * uLife);
  // a hadrosaur herd in the middle distance, some grazing
  a = herd(s, y, 2.9, 0.3, H0 - 0.32, 0.5, 5.0, 0.42, 0.0, 4.0);
  col = mix(col, mix(uLand * 0.03, uHaze * 0.45, 0.35), a * uLife);
  // a tyrannosaur prowling the west side
  a = herd(s, y, P, 0.16, H0 - 0.62, 1.05, 2.0, 2.0, 2.0, 2.0);
  col = mix(col, uLand * 0.025 + uHaze * 0.12, a * uLife);
  // Quetzalcoatlus gliding high up, wings flexing
  if (y > H0 + 1.0) {
    float x = s + uClock * 1.15 + 9.0;
    float pid = floor(x / 9.0);
    float on = step(h11(pid * 2.3), 0.55);
    float py = 4.4 + 1.6 * h11(pid * 4.1) + sin(uClock * 0.4 + pid) * 0.15;
    float sc = 1.0 + 0.5 * h11(pid * 6.1);
    float flap = 0.72 + 0.28 * sin(uClock * 1.7 + pid * 2.0);
    vec2 uv = vec2((x - pid * 9.0 - 2.0) / sc, ((y - py) / sc) / flap + 0.5);
    a = sprite(3.0, uv) * on;
    col = mix(col, mix(uSkyTop * 0.25, uHaze * 0.4, 0.4), a * uLife);
  }

  /* ---------------- tall trees close by, framing the walls ---------------- */
  {
    // undergrowth: cycads and ferns in the middle distance and at the foot of the walls
    float sh = herd(s, y, 1.8, 0.0, H0 - 0.95, 0.55, 8.0, 0.55, 10.0, 6.0) * (1.0 - burnt);
    col = mix(col, uLand * vec3(0.03, 0.045, 0.02) + uHaze * 0.12, sh);
    sh = herd(s, y, 3.1, 0.0, -0.06, 1.5, 11.0, 0.6, 10.0, 6.0) * (1.0 - burnt);
    col = mix(col, uLand * vec3(0.012, 0.02, 0.008) + uHaze * 0.02, sh);
    tr = trees(s, y, 4.6, 4.4, 2.6, 0.0, 0.5, 0.0, 0.55, 1.0, lightDir);
    vec3 tc = uLand * 0.014 + uHaze * 0.035;
    tc += tr.y * (uSkyHor * 0.14 + vec3(1.2, 0.4, 0.08) * fstr * 0.5);
    tc += fireRamp(0.55) * burnt * uEmbers * smoothstep(0.86, 0.95, vnoise(vec2(s * 9.0, y * 7.0))) * 0.5;
    col = mix(col, tc, tr.x);
  }

  /* ---------------- the firestorm ---------------- */
  if (fstr > 0.005) {
    vec2 fq = vec2(s * 0.55, y * 0.42 - uClock * 1.15);
    float n1 = fbm(fq + vec2(0.0, fbm(fq * 1.9 + uClock * 0.25) * 0.9));
    float Hf = 1.0 + 3.6 * fstr * (0.55 + 0.45 * vnoise1(s * 0.35 + uClock * 0.3));
    float temp = clamp((n1 * 1.2 - 0.12 - y / Hf) * 1.9, 0.0, 1.25) * fstr;
    // licks of flame in front, with dark smoke curling between the tongues
    float soot = smoothstep(0.0, 0.25, n1 - y / (Hf * 1.6)) * (1.0 - smoothstep(0.05, 0.4, temp)) * fstr;
    col = mix(col, vec3(0.03, 0.015, 0.01), soot * 0.6);
    col = col * (1.0 - smoothstep(0.05, 0.5, temp)) + fireRamp(temp);
    col += vec3(0.7, 0.2, 0.03) * fstr * exp(-max(0.0, y - Hf) * 0.45) * 0.25;
  }
  if (uEmbers > 0.0) {
    float e = particles(vec2(s, y), 2.4, -0.9, uClock, 0.5, 0.06, 0.3) + particles(vec2(s + 3.0, y), 4.5, -0.6, uClock, 0.7, 0.05, 0.25) * 0.7;
    col += vec3(2.4, 0.8, 0.18) * e * uEmbers * (0.6 + 0.4 * sin(uClock * 9.0 + s * 3.0)) * (0.25 + fstr);
  }

  /* ---------------- the blast: a wall of dust racing round the room ---------------- */
  if (uShockA > 0.0) {
    float dd = uShockW - periDist(s);
    float Hd = 0.6 + 2.8 * exp(-max(dd, 0.0) / 14.0);
    float bill = fbm(vec2(s * 0.5 - uClock * 2.0, y * 0.7 - uClock * 0.6));
    float dust = smoothstep(Hd, Hd * 0.35, y + (bill - 0.5) * 1.4) * smoothstep(-0.4, 0.6, dd) * exp(-max(dd, 0.0) / 26.0);
    vec3 dustCol = vec3(0.3, 0.22, 0.15) * (uLand * 1.6 + 0.04) * (0.6 + 0.8 * bill) + vec3(0.5, 0.16, 0.03) * fstr;
    col = mix(col, dustCol, dust * 0.9 * uShockA);
    float lead = exp(-pow(dd / 0.5, 2.0)) * smoothstep(Hd + 0.4, 0.0, y);
    col += vec3(0.8, 0.55, 0.32) * lead * uShockA * (0.5 + bill);
  }

  /* ---------------- after: ash, first light, survivors ---------------- */
  if (uDawn > 0.0) {
    col += uDawn * vec3(1.0, 0.55, 0.3) * exp(-abs(y - H0 - 0.12) * 2.4) * exp(-abs(s + 9.0) * 0.06) * 0.5;
  }
  if (uFern > 0.0) {
    // ferns uncoil along the foot of the walls: the "fern spike" after the impact
    float x = s + 0.9;
    float fid = floor(x / 2.4);
    float on = step(h11(fid * 4.3), 0.7);
    float grow = clamp(uFern * 1.6 - h11(fid * 2.1) * 0.6, 0.0, 1.0);
    float sc = (0.9 + 0.6 * h11(fid * 1.1)) * max(grow, 0.001);
    vec2 uv = vec2((x - fid * 2.4 - 0.4) / sc, (y + 0.03) / sc);
    float fm = sprite(6.0, uv) * on;
    vec3 fc = vec3(0.01, 0.025, 0.01) + uDawn * vec3(0.03, 0.065, 0.022) * (0.5 + 0.7 * clamp(uv.y, 0.0, 1.0));
    col = mix(col, fc, fm);
  }
  if (uMammal.y > 0.0) {
    vec2 uv = vec2((s - uMammal.x) / 0.55, (y - 0.06) / 0.55);
    col = mix(col, vec3(0.018, 0.014, 0.012) + uDawn * vec3(0.05, 0.04, 0.03), sprite(5.0, uv) * uMammal.y);
  }
  if (uAsh > 0.0) {
    float f = particles(vec2(s, y), 0.9, 0.34, uClock, 0.9, 0.22, 0.55)
            + particles(vec2(s + 7.0, y), 1.8, 0.26, uClock, 1.1, 0.18, 0.5) * 0.8
            + particles(vec2(s - 3.0, y), 3.4, 0.18, uClock, 1.3, 0.14, 0.45) * 0.6;
    // flakes catch whatever light there is: a little lighter than the murk behind them
    vec3 ashCol = vec3(0.075, 0.071, 0.068) + uLand * 0.55 + vec3(0.5, 0.16, 0.04) * fstr;
    col = mix(col, ashCol, clamp(f, 0.0, 1.0) * uAsh * 0.75);
    // a pall of drifting ash in the air
    float pall = fbm(vec2(s * 0.12 + uClock * 0.05, y * 0.25 + uClock * 0.08));
    col = mix(col, vec3(0.05, 0.047, 0.045) * (uLand * 4.0 + 0.2), uAsh * smoothstep(0.35, 0.8, pall) * 0.45);
  }

  /* ---------------- titles ---------------- */
  if (uTitle + uEpi > 0.0) {
    vec2 tu = vec2((s + 6.0) / 12.0, (y - 4.5) / 1.5); // centred on the bench's view
    if (tu.x > 0.0 && tu.x < 1.0 && tu.y > 0.0 && tu.y < 1.0) {
      // red = the letters, green = a soft dark halo behind them
      vec3 t1 = texture2D(uText, vec2(tu.x, 0.5 + tu.y * 0.5)).rgb * uTitle;
      vec3 t2 = texture2D(uText, vec2(tu.x, tu.y * 0.5)).rgb * uEpi;
      vec3 t = t1 + t2;
      col *= 1.0 - clamp(t.g, 0.0, 1.0) * 0.55;
      col = mix(col, vec3(1.2, 1.15, 1.06), clamp(t.r, 0.0, 1.0) * 0.92);
    }
  }

  col = mix(col, vec3(6.5, 6.3, 6.0), uFlash);
  gl_FragColor = vec4(max(col, 0.0) * uFade * uExp, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

  const FLOOR_VERT = /* glsl */ `
varying vec2 vXZ;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vXZ = w.xz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

  const FLOOR_FRAG = /* glsl */ `
uniform float uClock, uFade, uExp, uFlash, uFireF, uFireOn, uAsh, uEmbers, uAshCover;
uniform float uDawn, uFern, uCloud, uShockR, uShockA, uScorched;
uniform vec3 uLand, uSkyHor;
uniform vec4 uBox; // x0, x1, z0, z1 of the projected floor
varying vec2 vXZ;
${COMMON}

void main(){
  vec2 p = vXZ;
  float X0 = uBox.x, X1 = uBox.y, Z0 = uBox.z, Z1 = uBox.w;
  float W = X1 - X0, D = Z1 - Z0;
  float cx = (X0 + X1) * 0.5;

  // the blast front rolls in from beyond the south wall
  vec2 rv = p - vec2(cx, Z1 + ${f(K.SHOCK_BACK)});
  float r = length(rv);
  vec2 rn = rv / max(r, 1e-3);
  float behind = uShockR - r;
  float ripple = behind > 0.0 ? sin(behind * 2.4) * exp(-behind * 0.3) : 0.0;
  vec2 tp = p + rn * ripple * 0.45 * uShockA;

  // forest floor: soil, fern and horsetail patches, moving cloud shadows
  float g = fbm(tp * 0.32);
  float leaf = vnoise(tp * 6.5) * 0.6 + vnoise(tp * 15.0) * 0.4;
  vec3 soil = mix(vec3(0.085, 0.062, 0.042), vec3(0.15, 0.11, 0.07), fbm(tp * 1.6 + 5.0));
  // leaf litter and needles: fine, contrasty detail you see at your feet
  float litter = fbm(tp * 3.5 + 11.0);
  soil *= 0.8 + 0.4 * litter;
  float peb = particles(tp, 3.0, 0.0, 0.0, 0.0, 0.12, 0.18);
  soil = mix(soil, vec3(0.17, 0.15, 0.12), peb * 0.35);
  vec3 veg = mix(vec3(0.035, 0.055, 0.022), vec3(0.08, 0.11, 0.04), leaf);
  float vegM = smoothstep(0.42, 0.7, g + (leaf - 0.5) * 0.15) * 0.8;
  vec3 col = mix(soil, veg, vegM);
  float shade = smoothstep(0.35, 0.7, fbm(tp * 0.05 + uClock * vec2(0.012, 0.007)));
  // sun flecks through the canopy
  float fleck = smoothstep(0.62, 0.8, fbm(tp * 0.9 + uClock * vec2(0.03, 0.01)));
  col *= uLand * 0.55 * mix(1.0, (0.55 + 0.45 * shade) * (0.85 + 0.4 * fleck), uCloud);

  // light spilling from the walls (nearest wall's perimeter coordinate)
  float dW = p.x - X0, dE = X1 - p.x, dN = p.y - Z0, dS = Z1 - p.y;
  float wd = min(min(dW, dE), min(dN, dS));
  float sN = wd == dS ? cx - p.x : wd == dW ? W * 0.5 + dS : wd == dN ? W * 0.5 + D + dW : W * 1.5 + D + dN;
  if (sN > P * 0.5) sN -= P;
  float wallFire = uFireOn * fireStrength(fireAge(periDist(sN), uFireF));
  col += uSkyHor * exp(-wd * 0.3) * 0.05;
  col += vec3(1.3, 0.38, 0.08) * wallFire * exp(-wd * 0.26) * 0.5;

  // the fire crosses the floor too: char, glowing fissures, flickering hot patches
  float fd = length(p - vec2(cx, Z1 + 2.0));
  float fage = fireAge(fd, uFireF);
  float fa = uFireOn * smoothstep(0.0, 1.5, fage);
  float fs = uFireOn * fireStrength(fage);
  float charred = max(uScorched, fa * smoothstep(0.0, 3.0, fage));
  col = mix(col, vec3(0.013, 0.01, 0.008) + uLand * 0.015, charred * 0.92);
  if (fa > 0.001) {
    vec2 w = tp * 1.1 + vec2(fbm(tp * 0.5), fbm(tp * 0.5 + 4.0)) * 1.4;
    float ridge = 1.0 - abs(fbm(w) * 2.0 - 1.0);
    float fiss = smoothstep(0.95, 0.995, ridge);
    float hot = smoothstep(0.58, 0.88, fbm(tp * 1.2 + vec2(uClock * 0.3, -uClock * 0.15)));
    float grain = 0.6 + 0.8 * vnoise(tp * 18.0 + uClock * 0.5);
    col += fireRamp((hot * 0.75 + fiss * 0.4) * grain) * fs * (0.08 + hot * 0.6);
    float sparks = particles(tp + vec2(0.0, uClock * 0.2), 4.0, 0.0, uClock, 0.0, 0.08, 0.2) * (0.5 + 0.5 * sin(uClock * 11.0 + tp.x * 5.0));
    col += vec3(1.6, 0.5, 0.08) * sparks * fa * uEmbers * 0.5;
    col += vec3(0.7, 0.15, 0.02) * fiss * (0.4 + 0.6 * vnoise(tp * 1.5 + uClock * 0.2)) * fa * uEmbers * 0.14;
  }

  // the shockwave: a bright, dusty front with ripples behind it
  if (uShockA > 0.0) {
    float ring = exp(-pow((r - uShockR) / 0.3, 2.0));
    float trough = exp(-pow((r - uShockR + 0.9) / 0.6, 2.0));
    float wake = smoothstep(0.0, 2.5, behind) * exp(-max(0.0, behind) / 7.0);
    vec3 dust = vec3(0.3, 0.24, 0.17) * (0.5 + fbm(tp * 1.4 + rn * uClock * 0.8));
    col = mix(col, dust * (uLand * 0.8 + 0.08), wake * 0.5 * uShockA);
    col *= 1.0 - trough * 0.5 * uShockA;
    float broken = 0.4 + 0.6 * vnoise(vec2(atan(rv.y, rv.x) * 90.0, r * 0.7));
    col += vec3(0.6, 0.4, 0.22) * ring * uShockA * broken;
    col += vec3(0.4, 0.26, 0.15) * max(ripple, 0.0) * uShockA * 0.25 * step(0.0, behind);
  }

  // ash settles; flakes drift across
  if (uAshCover > 0.0) {
    float cover = clamp(uAshCover * 1.4 - (1.0 - fbm(tp * 0.8)) * 0.8, 0.0, 1.0);
    col = mix(col, vec3(0.2, 0.195, 0.19) * (uLand + 0.015), cover * 0.85);
  }
  if (uAsh > 0.0) {
    vec2 q = tp + vec2(uClock * 0.35, uClock * 0.12);
    float fl = particles(q, 1.4, 0.0, uClock, 0.0, 0.16, 0.45);
    col += vec3(0.5, 0.48, 0.46) * fl * uAsh * (uLand * 0.5 + 0.015);
  }

  // first light from the south-east, ferns unfurling through the ash
  if (uDawn > 0.0) {
    col += uDawn * vec3(0.5, 0.38, 0.3) * exp(-(dS * 0.12 + abs(p.x - (cx - 9.0)) * 0.05)) * 0.2;
  }
  if (uFern > 0.0) {
    // fern sporelings and moss greening the ash in patches: fine specks, no shapes
    float greenPatch = smoothstep(0.55, 0.75, fbm(p * 0.18 + 3.0) + uFern * 0.25 - 0.15);
    float sprout = particles(p, 6.0, 0.0, 0.0, 0.0, 0.2, 0.5) + particles(p + 1.7, 11.0, 0.0, 0.0, 0.0, 0.22, 0.45) * 0.8;
    float m = clamp(sprout, 0.0, 1.0) * greenPatch * uFern;
    col = mix(col, vec3(0.014, 0.03, 0.012) + uDawn * vec3(0.03, 0.06, 0.022), m);
  }

  col = mix(col, vec3(4.2, 4.1, 3.9), uFlash * 0.85);
  gl_FragColor = vec4(max(col, 0.0) * uFade * uExp, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

  // the ceiling: the zenith of the same sky, darker towards the middle so the
  // room stays a dark box, continuous with the top edge of the walls
  const CEIL_FRAG = /* glsl */ `
uniform float uClock, uFade, uExp, uFlash, uSmoke, uFireOn, uAsh, uCloud;
uniform vec3 uSkyTop, uSkyHor;
uniform vec4 uBox;
varying vec2 vXZ;
${COMMON}
void main(){
  vec2 p = vXZ;
  float wd = min(min(p.x - uBox.x, uBox.y - p.x), min(p.y - uBox.z, uBox.w - p.y));
  float edge = exp(-wd * 0.35);
  vec3 col = uSkyTop * mix(0.35, 1.0, edge);
  float cn = fbm(p * 0.06 + vec2(uClock * 0.01, 0.0));
  col = mix(col, uSkyTop * 0.6 + uSkyHor * 0.08, smoothstep(0.5, 0.8, cn) * 0.5 * edge);
  if (uSmoke > 0.0) {
    float mn = fbm(p * 0.08 + vec2(0.0, uClock * 0.03));
    col = mix(col, vec3(0.03, 0.02, 0.016) + uSkyHor * 0.08 * uFireOn, uSmoke * smoothstep(0.3, 0.75, mn + 0.25));
  }
  if (uAsh > 0.0) {
    float pall = fbm(p * 0.1 + uClock * 0.05);
    col = mix(col, vec3(0.05, 0.047, 0.045) * (uSkyTop * 4.0 + 0.2), uAsh * smoothstep(0.35, 0.8, pall) * 0.45);
  }
  col = mix(col, vec3(6.5, 6.3, 6.0), uFlash);
  gl_FragColor = vec4(max(col, 0.0) * uFade * uExp, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

  return { WALL_VERT, WALL_FRAG, FLOOR_VERT, FLOOR_FRAG, CEIL_FRAG };
}
