import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { getConfig } from './config.js';
import { Sound } from './audio.js';

// ============================================================================
// helpers
// ============================================================================

const CFG = getConfig();
const $ = (id) => document.getElementById(id);
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const randn = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const ease = {
  linear: (t) => t,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inCubic: (t) => t * t * t,
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outExpo: (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
};
const lin = (hex, k = 1) => { const c = new THREE.Color(hex); return [c.r * k, c.g * k, c.b * k]; };

function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

if (!webglAvailable()) {
  $('loader').classList.add('hidden');
  $('fallback').classList.remove('hidden');
  throw new Error('WebGL unavailable');
}

const IS_MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(innerWidth, innerHeight) < 600;
const DPR = Math.min(window.devicePixelRatio || 1, IS_MOBILE ? 1.5 : 2);
const TEXT_Y = 10;
const sound = new Sound();
let phase = 'intro';

// --- tiny tween / timeline engine (driven by the render loop) ---------------
const tweens = new Set();
const timers = new Set();
function animate(obj, to, dur, e = ease.inOutCubic) {
  for (const tw of tweens) if (tw.obj === obj) for (const k in to) delete tw.to[k];
  return new Promise((res) => {
    const from = {};
    for (const k in to) from[k] = obj[k];
    tweens.add({ obj, from, to: { ...to }, dur: Math.max(dur, 1e-4), t: 0, e, res });
  });
}
function sleep(s) { return new Promise((res) => timers.add({ t: s, res })); }
function updateTimeline(dt) {
  for (const tw of tweens) {
    tw.t += dt;
    const p = clamp01(tw.t / tw.dur);
    const v = tw.e(p);
    for (const k in tw.to) tw.obj[k] = tw.from[k] + (tw.to[k] - tw.from[k]) * v;
    if (p >= 1) { tweens.delete(tw); tw.res(); }
  }
  for (const tm of timers) { tm.t -= dt; if (tm.t <= 0) { timers.delete(tm); tm.res(); } }
}

// ============================================================================
// renderer / scene / post-processing
// ============================================================================

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !IS_MOBILE, powerPreference: 'high-performance' });
renderer.setPixelRatio(DPR);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color(0x0d0624);
scene.fog = new THREE.FogExp2(FOG_COLOR, 0.021);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 900);
scene.add(camera);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

const composer = new EffectComposer(renderer);
composer.setPixelRatio(DPR);
composer.setSize(innerWidth, innerHeight);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.9, 0.55, 1.75);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// shared uniform: converts a world-space size into pixels for gl_PointSize
const uPointScale = { value: 1 };
const uTime = { value: 0 };
function updatePointScale() {
  uPointScale.value = (innerHeight * DPR * 0.5) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
}

// ============================================================================
// sky: gradient nebula dome + twinkling stars
// ============================================================================

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(500, 48, 24),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { uTime, uHorizon: { value: FOG_COLOR.clone() } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime; uniform vec3 uHorizon; varying vec3 vDir;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec3 x) {
        vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; } return v; }
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 zenith = vec3(0.002, 0.0015, 0.008);
        vec3 col = mix(uHorizon, zenith, smoothstep(-0.05, 0.65, h));
        float n = fbm(d * 2.6 + vec3(0.0, 0.0, uTime * 0.006));
        float n2 = fbm(d * 5.0 - vec3(uTime * 0.004, 0.0, 0.0));
        float band = exp(-pow((d.y - 0.35 + 0.25 * d.x) * 2.6, 2.0));
        vec3 neb = mix(vec3(0.09, 0.012, 0.11), vec3(0.015, 0.03, 0.12), n2);
        col += neb * pow(n, 2.4) * (0.35 + band) * smoothstep(-0.1, 0.25, h) * 0.9;
        gl_FragColor = vec4(col, 1.0);
      }`,
  })
);
sky.renderOrder = -10;
scene.add(sky);

function makeStars(count) {
  const g = new THREE.BufferGeometry();
  const p = new Float32Array(count * 3), c = new Float32Array(count * 3), s = new Float32Array(count), ph = new Float32Array(count);
  const tints = [lin(0xffffff, 1.4), lin(0xcfe0ff, 1.4), lin(0xffe1c4, 1.4), lin(0xffc8ec, 1.3)];
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3(randn() * 2, rand(-0.12, 1), randn() * 2).normalize().multiplyScalar(rand(120, 260));
    p.set([v.x, v.y, v.z], i * 3);
    c.set(pick(tints), i * 3);
    s[i] = Math.pow(Math.random(), 3) * 1.6 + 0.35;
    ph[i] = Math.random() * 100;
  }
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('aColor', new THREE.BufferAttribute(c, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(s, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(ph, 1));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uTime, uScale: uPointScale },
    vertexShader: /* glsl */ `
      uniform float uTime, uScale; attribute vec3 aColor; attribute float aSize, aPhase; varying vec3 vC;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = 0.55 + 0.45 * sin(uTime * (0.8 + fract(aPhase) * 2.5) + aPhase);
        vC = aColor * tw;
        gl_PointSize = max(1.5, aSize * uScale / -mv.z);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC;
      void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC, a * a); }`,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}
const stars = makeStars(IS_MOBILE ? 2200 : 4500);
scene.add(stars);

// ============================================================================
// ground + lights
// ============================================================================

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(70, 72),
  new THREE.MeshStandardMaterial({ color: 0x150b2c, roughness: 0.42, metalness: 0.15, envMapIntensity: 0.25 })
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

function radialTexture(stops, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  stops.forEach(([o, col]) => g.addColorStop(o, col));
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const softDot = radialTexture([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']], 128);

const hemi = new THREE.HemisphereLight(0x8f7bff, 0x1a0b2a, 0.35);
scene.add(hemi);

const key = new THREE.SpotLight(0xffe2c8, 130, 60, 0.42, 0.85, 1.6);
key.position.set(5, 15, 9);
key.target.position.set(0, 1.6, 0);
key.castShadow = true;
key.shadow.mapSize.set(IS_MOBILE ? 1024 : 2048, IS_MOBILE ? 1024 : 2048);
key.shadow.bias = -0.0004;
key.shadow.radius = 6;
scene.add(key, key.target);

const rimPink = new THREE.PointLight(0xff4fa8, 28, 40, 1.6);
rimPink.position.set(-7, 5, -5);
const rimBlue = new THREE.PointLight(0x5fa8ff, 32, 40, 1.6);
rimBlue.position.set(7, 4, -6);
scene.add(rimPink, rimBlue);

const candleLight = new THREE.PointLight(0xff9c45, 0, 18, 1.5);
candleLight.position.set(0, 6.2, 0.6);
const candleGlow = { v: 0 };
scene.add(candleLight);

const fwLight = new THREE.PointLight(0xffffff, 0, 0, 1.2);
fwLight.position.set(0, 12, -6);
scene.add(fwLight);

const LIGHT_LEVELS = { hemi: 0.35, key: 130, rimPink: 28, rimBlue: 32 };

// ============================================================================
// the cake
// ============================================================================

function stripeTexture(colorA, colorB) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = colorA;
  x.fillRect(0, 0, 64, 256);
  x.fillStyle = colorB;
  for (let i = -4; i < 12; i++) {
    x.beginPath();
    x.moveTo(0, i * 32); x.lineTo(64, i * 32 - 40); x.lineTo(64, i * 32 - 24); x.lineTo(0, i * 32 + 16);
    x.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function flameTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const x = c.getContext('2d');
  x.filter = 'blur(5px)';
  const g = x.createRadialGradient(64, 178, 4, 64, 160, 110);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,236,170,0.95)');
  g.addColorStop(0.5, 'rgba(255,150,50,0.6)');
  g.addColorStop(1, 'rgba(255,70,0,0)');
  x.fillStyle = g;
  x.beginPath();
  x.moveTo(64, 16);
  x.bezierCurveTo(98, 96, 112, 176, 64, 238);
  x.bezierCurveTo(16, 176, 30, 96, 64, 16);
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function heartShape(s = 1) {
  const sh = new THREE.Shape();
  sh.moveTo(0, -1.0 * s);
  sh.bezierCurveTo(-0.2 * s, -0.75 * s, -1.0 * s, -0.35 * s, -1.0 * s, 0.25 * s);
  sh.bezierCurveTo(-1.0 * s, 0.8 * s, -0.35 * s, 1.0 * s, 0, 0.55 * s);
  sh.bezierCurveTo(0.35 * s, 1.0 * s, 1.0 * s, 0.8 * s, 1.0 * s, 0.25 * s);
  sh.bezierCurveTo(1.0 * s, -0.35 * s, 0.2 * s, -0.75 * s, 0, -1.0 * s);
  return sh;
}

const CAKE = { plateTop: 0.18, b: { r: 2.6, h: 1.6 }, t: { r: 1.75, h: 1.3 } };
CAKE.bTop = CAKE.plateTop + CAKE.b.h;
CAKE.tTop = CAKE.bTop + CAKE.t.h;

function buildCake() {
  const cake = new THREE.Group();
  const shadowy = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };

  const plateMat = new THREE.MeshStandardMaterial({ color: 0xe6e3f5, metalness: 1, roughness: 0.3, envMapIntensity: 0.9 });
  const plate = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.15, 0.18, 72), plateMat));
  plate.position.y = 0.09;
  cake.add(plate);

  const pinkCream = new THREE.MeshPhysicalMaterial({
    color: 0xff8dbb, roughness: 0.62, sheen: 1, sheenColor: new THREE.Color(0xffd0e4), sheenRoughness: 0.45,
    clearcoat: 0.15, clearcoatRoughness: 0.6, envMapIntensity: 0.3, emissive: 0xffffff, emissiveIntensity: 0,
  });
  const vanilla = new THREE.MeshPhysicalMaterial({
    color: 0xfff0dc, roughness: 0.6, sheen: 1, sheenColor: new THREE.Color(0xffffff), sheenRoughness: 0.5,
    clearcoat: 0.1, envMapIntensity: 0.3, emissive: 0xffffff, emissiveIntensity: 0,
  });
  const whiteGlaze = new THREE.MeshPhysicalMaterial({ color: 0xf4ece4, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 0.45 });
  const pinkGlaze = new THREE.MeshPhysicalMaterial({ color: 0xff4f93, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 0.8 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xffcc66, metalness: 1, roughness: 0.22, envMapIntensity: 1.3 });

  const bottom = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(CAKE.b.r, CAKE.b.r, CAKE.b.h, 96), pinkCream));
  bottom.position.y = CAKE.plateTop + CAKE.b.h / 2;
  const top = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(CAKE.t.r, CAKE.t.r, CAKE.t.h, 96), vanilla));
  top.position.y = CAKE.bTop + CAKE.t.h / 2;
  cake.add(bottom, top);

  // glossy icing caps + drips
  function drips(radius, topY, mat, count) {
    const cap = shadowy(new THREE.Mesh(new THREE.CylinderGeometry(radius + 0.035, radius + 0.035, 0.16, 96), mat));
    cap.position.y = topY - 0.06;
    cake.add(cap);
    const geo = new THREE.CapsuleGeometry(0.085, 1, 4, 10);
    const inst = new THREE.InstancedMesh(geo, mat, count);
    inst.castShadow = true;
    const d = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand(-0.04, 0.04);
      const len = Math.random() < 0.3 ? rand(0.1, 0.2) : rand(0.25, 0.7);
      d.position.set(Math.cos(a) * (radius + 0.02), topY - 0.1 - len / 2, Math.sin(a) * (radius + 0.02));
      d.scale.set(1, len, 1);
      d.updateMatrix();
      inst.setMatrixAt(i, d.matrix);
    }
    cake.add(inst);
  }
  drips(CAKE.b.r, CAKE.bTop, whiteGlaze, 46);
  drips(CAKE.t.r, CAKE.tTop, pinkGlaze, 32);

  // pearl borders
  function pearls(radius, y, size, count, mat) {
    const inst = new THREE.InstancedMesh(new THREE.SphereGeometry(size, 14, 10), mat, count);
    inst.castShadow = true;
    const d = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      d.position.set(Math.cos(a) * radius, y, Math.sin(a) * radius);
      d.updateMatrix();
      inst.setMatrixAt(i, d.matrix);
    }
    cake.add(inst);
  }
  pearls(CAKE.b.r + 0.04, CAKE.plateTop + 0.12, 0.13, 64, whiteGlaze);
  pearls(CAKE.t.r + 0.04, CAKE.bTop + 0.1, 0.1, 54, gold);
  pearls(CAKE.t.r - 0.12, CAKE.tTop + 0.04, 0.065, 48, gold);

  // sprinkles
  const sprinkleCols = [0xff5fa2, 0xffd166, 0x7ee0ff, 0xb28dff, 0x8dffb5, 0xffffff];
  const sp = new THREE.InstancedMesh(
    new THREE.CapsuleGeometry(0.022, 0.09, 2, 6),
    new THREE.MeshStandardMaterial({ roughness: 0.35, envMapIntensity: 0.6 }),
    IS_MOBILE ? 140 : 240
  );
  const d = new THREE.Object3D();
  for (let i = 0; i < sp.count; i++) {
    let r, y;
    if (i % 3 === 0) { r = rand(CAKE.t.r + 0.25, CAKE.b.r - 0.15); y = CAKE.bTop + 0.035; }
    else { r = Math.sqrt(Math.random()) * (CAKE.t.r - 0.3); y = CAKE.tTop + 0.035; }
    const a = rand(0, Math.PI * 2);
    d.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    d.rotation.set(Math.PI / 2, 0, rand(0, Math.PI * 2));
    d.updateMatrix();
    sp.setMatrixAt(i, d.matrix);
    sp.setColorAt(i, new THREE.Color(pick(sprinkleCols)));
  }
  cake.add(sp);

  // little 3D hearts around the lower ledge
  const heartGeo = new THREE.ExtrudeGeometry(heartShape(0.17), { depth: 0.08, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.035, bevelSegments: 3, curveSegments: 16 });
  heartGeo.center();
  const heartMat = new THREE.MeshPhysicalMaterial({ color: 0xff2d6f, roughness: 0.18, clearcoat: 1, envMapIntensity: 0.9 });
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 + 0.3;
    const h = shadowy(new THREE.Mesh(heartGeo, heartMat));
    const r = (CAKE.t.r + CAKE.b.r) / 2 + 0.05;
    h.position.set(Math.cos(a) * r, CAKE.bTop + 0.2, Math.sin(a) * r);
    h.lookAt(Math.cos(a) * 10, CAKE.bTop + 0.2, Math.sin(a) * 10);
    h.rotateX(-0.25);
    cake.add(h);
  }

  // candles
  const palettes = [['#fff6fb', '#ff6fae'], ['#f6fffd', '#45d6c0'], ['#fbf6ff', '#a07bff'], ['#fffaf0', '#ffbf3d']];
  const stripeTex = palettes.map(([a, b]) => stripeTexture(a, b));
  const flameTex = flameTexture();
  const candles = [];
  const n = CFG.candles;
  for (let i = 0; i < n; i++) {
    const g = new THREE.Group();
    let x = 0, z = 0;
    if (n > 1) {
      const ring = n > 8 ? (i < n - 5 ? 1.18 : 0.55) : 1.02;
      const idx = n > 8 ? (i < n - 5 ? i : i - (n - 5)) : i;
      const cnt = n > 8 ? (i < n - 5 ? n - 5 : 5) : n;
      const a = (idx / cnt) * Math.PI * 2 + (ring < 1 ? 0.6 : 0);
      x = Math.cos(a) * ring; z = Math.sin(a) * ring;
    }
    const h = 0.9 + (i % 2) * 0.12;
    const tex = stripeTex[i % stripeTex.length];
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.075, 0.08, h, 20),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.45, envMapIntensity: 0.5 })
    );
    body.castShadow = true;
    body.position.y = h / 2;
    const wick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.12, 6), new THREE.MeshBasicMaterial({ color: 0x1a1210 }));
    wick.position.y = h + 0.05;
    const flame = new THREE.Group();
    flame.position.y = h + 0.24;
    const outer = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, color: new THREE.Color(3.6, 1.45, 0.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    const inner = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, color: new THREE.Color(2.8, 2.5, 1.9), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    inner.position.y = -0.05;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, color: new THREE.Color(0.22, 0.1, 0.03), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    flame.add(halo, outer, inner);
    flame.scale.setScalar(0.0001);
    g.add(body, wick, flame);
    g.position.set(x, CAKE.tTop, z);
    cake.add(g);
    candles.push({ group: g, flame, outer, inner, halo, life: { v: 0 }, lean: { v: 0 }, phase: Math.random() * 10, lit: false });
  }

  // glow on the floor
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(16, 16),
    new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(255,140,200,0.22)'], [0.4, 'rgba(160,90,255,0.07)'], [1, 'rgba(0,0,0,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.01;
  cake.add(glow);

  cake.visible = false;
  cake.scale.setScalar(0.001);
  return { group: cake, candles, flashMats: [pinkCream, vanilla] };
}
const cake = buildCake();
scene.add(cake.group);

// ============================================================================
// hero particle system — morphs between galaxy, words, heart, cake, orbit
// ============================================================================

const N = IS_MOBILE ? 5000 : 9000;
const hero = {
  pos: new Float32Array(N * 3), col: new Float32Array(N * 3),
  start: new Float32Array(N * 3), startCol: new Float32Array(N * 3),
  target: new Float32Array(N * 3), targetCol: new Float32Array(N * 3),
  arc: new Float32Array(N * 3), delay: new Float32Array(N), phase: new Float32Array(N),
  gR: new Float32Array(N), gA: new Float32Array(N), gY: new Float32Array(N), spin: 0, tilt: 1.08,
  oR: new Float32Array(N), oA: new Float32Array(N), oY: new Float32Array(N), oS: new Float32Array(N), orbitCol: new Float32Array(N * 3),
  mode: 'galaxy', t: 0, dur: 1, next: 'static', arcAmt: 2.5,
  pulseStart: -1, pulseCenter: new THREE.Vector3(),
};
{
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(hero.pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aColor', new THREE.BufferAttribute(hero.col, 3).setUsage(THREE.DynamicDrawUsage));
  const size = new Float32Array(N), rnd = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    size[i] = Math.random() < 0.06 ? rand(1.6, 2.4) : rand(0.6, 1.25);
    rnd[i] = Math.random();
    hero.phase[i] = Math.random() * Math.PI * 2;
    hero.delay[i] = Math.random() * 0.3;
    const v = new THREE.Vector3(randn(), randn(), randn()).normalize().multiplyScalar(rand(0.4, 1));
    hero.arc.set([v.x, v.y, v.z], i * 3);
  }
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
  hero.geo = g;
  hero.mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime, uScale: uPointScale, uSize: { value: 0.15 }, uOpacity: { value: 0 }, uShimmer: { value: 0 } },
    vertexShader: /* glsl */ `
      uniform float uTime, uScale, uSize, uShimmer;
      attribute vec3 aColor; attribute float aSize, aRand;
      varying vec3 vC; varying float vFade;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = 0.78 + 0.22 * sin(uTime * (1.5 + aRand * 2.0) + aRand * 60.0);
        float sh = 1.0 + uShimmer * 1.6 * pow(max(0.0, sin(position.x * 0.42 + position.y * 0.2 - uTime * 2.4)), 14.0);
        vC = aColor * tw * sh;
        float dist = -mv.z;
        vFade = smoothstep(0.6, 3.5, dist);
        gl_PointSize = min(aSize * uSize * uScale / dist, 90.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uOpacity; varying vec3 vC; varying float vFade;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vC, a * a * uOpacity * vFade);
      }`,
  });
  hero.points = new THREE.Points(g, hero.mat);
  hero.points.frustumCulled = false;
  hero.points.renderOrder = 5;
  scene.add(hero.points);

  // galaxy layout
  const core = lin(0xfff1d6, 1.0), armA = lin(0xff5fb0, 0.9), armB = lin(0x8a6bff, 0.9), armC = lin(0x4fd3ff, 0.85);
  for (let i = 0; i < N; i++) {
    const r = 0.25 + Math.pow(Math.random(), 1.5) * 14;
    const arm = i % 3;
    hero.gR[i] = r;
    hero.gA[i] = arm * ((Math.PI * 2) / 3) + r * 0.52 + randn() * (0.28 + r * 0.02);
    hero.gY[i] = randn() * 0.6 * Math.exp(-r * 0.12);
    const t = clamp01(r / 12);
    const c = t < 0.15 ? core : t < 0.55 ? (arm === 1 ? armB : armA) : arm === 2 ? armC : armB;
    const k = 0.75 + Math.random() * 0.5;
    const mix = clamp01(t * 6);
    hero.col[i * 3] = (core[0] * (1 - mix) + c[0] * mix) * k;
    hero.col[i * 3 + 1] = (core[1] * (1 - mix) + c[1] * mix) * k;
    hero.col[i * 3 + 2] = (core[2] * (1 - mix) + c[2] * mix) * k;
  }

  // ambient orbit layout around the cake
  const pastel = [lin(0xffb3d6, 0.9), lin(0xffe1a1, 0.9), lin(0xc7b3ff, 0.9), lin(0xa8e8ff, 0.85), lin(0xffffff, 0.8)];
  for (let i = 0; i < N; i++) {
    hero.oR[i] = 4.2 + Math.pow(Math.random(), 0.8) * 13;
    hero.oA[i] = Math.random() * Math.PI * 2;
    hero.oY[i] = 0.3 + Math.pow(Math.random(), 1.3) * 15;
    hero.oS[i] = (0.05 + 0.6 / hero.oR[i]) * (Math.random() < 0.5 ? 0.8 : 1.2);
    hero.orbitCol.set(pick(pastel), i * 3);
  }
}

function heroUpdate(dt, t) {
  const P = hero.pos, S = hero.start, T = hero.target, A = hero.arc;
  const C = hero.col, SC = hero.startCol, TC = hero.targetCol;
  if (hero.mode === 'galaxy') {
    hero.spin += dt * 0.11;
    const ct = Math.cos(hero.tilt), st = Math.sin(hero.tilt);
    for (let i = 0; i < N; i++) {
      const r = hero.gR[i];
      const a = hero.gA[i] + hero.spin * (0.55 + 2.4 / (r + 1.6));
      const x = Math.cos(a) * r, z = Math.sin(a) * r, y = hero.gY[i];
      P[i * 3] = x;
      P[i * 3 + 1] = y * ct - z * st + TEXT_Y;
      P[i * 3 + 2] = y * st + z * ct;
    }
  } else if (hero.mode === 'morph') {
    hero.t += dt;
    const p = hero.t / hero.dur;
    const amt = hero.arcAmt;
    for (let i = 0; i < N; i++) {
      const lt = clamp01((p - hero.delay[i]) / 0.7);
      const e = ease.inOutCubic(lt);
      const s = Math.sin(e * Math.PI) * amt;
      const j = i * 3;
      P[j] = S[j] + (T[j] - S[j]) * e + A[j] * s;
      P[j + 1] = S[j + 1] + (T[j + 1] - S[j + 1]) * e + A[j + 1] * s;
      P[j + 2] = S[j + 2] + (T[j + 2] - S[j + 2]) * e + A[j + 2] * s;
      C[j] = SC[j] + (TC[j] - SC[j]) * e;
      C[j + 1] = SC[j + 1] + (TC[j + 1] - SC[j + 1]) * e;
      C[j + 2] = SC[j + 2] + (TC[j + 2] - SC[j + 2]) * e;
    }
    hero.geo.attributes.aColor.needsUpdate = true;
    if (p >= 1) hero.mode = hero.next;
  } else if (hero.mode === 'static') {
    let k = 1;
    if (hero.pulseStart >= 0) {
      const bt = (t - hero.pulseStart) % 0.9;
      k = 1 + 0.07 * Math.exp(-Math.pow((bt - 0.04) * 22, 2)) + 0.045 * Math.exp(-Math.pow((bt - 0.26) * 22, 2));
    }
    const c = hero.pulseCenter;
    for (let i = 0; i < N; i++) {
      const j = i * 3, ph = hero.phase[i];
      P[j] = c.x + (T[j] - c.x) * k + Math.sin(t * 1.3 + ph) * 0.025;
      P[j + 1] = c.y + (T[j + 1] - c.y) * k + Math.cos(t * 1.1 + ph * 1.7) * 0.025;
      P[j + 2] = c.z + (T[j + 2] - c.z) * k;
    }
  } else if (hero.mode === 'orbit') {
    for (let i = 0; i < N; i++) {
      hero.oA[i] += hero.oS[i] * dt;
      const j = i * 3, r = hero.oR[i], a = hero.oA[i];
      P[j] = Math.cos(a) * r;
      P[j + 1] = hero.oY[i];
      P[j + 2] = Math.sin(a) * r;
    }
  }
  hero.geo.attributes.position.needsUpdate = true;
}

function orbitTargets() {
  for (let i = 0; i < N; i++) {
    const j = i * 3, r = hero.oR[i], a = hero.oA[i];
    hero.target[j] = Math.cos(a) * r;
    hero.target[j + 1] = hero.oY[i];
    hero.target[j + 2] = Math.sin(a) * r;
  }
  hero.targetCol.set(hero.orbitCol);
}

function morphTo(state, dur, { next = 'static', arc = 2.5, sweep = false, pulse = false } = {}) {
  hero.start.set(hero.pos);
  hero.startCol.set(hero.col);
  if (state === 'orbit') { orbitTargets(); next = 'orbit'; }
  else { hero.target.set(state.pos); hero.targetCol.set(state.col); }
  // left→right sweep looks like handwriting; otherwise organic random stagger
  if (sweep) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < N; i++) { const x = hero.target[i * 3]; if (x < mn) mn = x; if (x > mx) mx = x; }
    for (let i = 0; i < N; i++) hero.delay[i] = ((hero.target[i * 3] - mn) / (mx - mn || 1)) * 0.24 + Math.random() * 0.06;
  } else {
    for (let i = 0; i < N; i++) hero.delay[i] = Math.random() * 0.3;
  }
  hero.mode = 'morph';
  hero.t = 0;
  hero.dur = dur;
  hero.next = next;
  hero.arcAmt = arc;
  hero.pulseStart = -1;
  if (pulse) hero.pulseCenter.copy(state.center || new THREE.Vector3());
  else hero.pulseCenter.set(0, 0, 0);
  return sleep(dur);
}

// --- shape samplers ----------------------------------------------------------

function sampleText(lines, { width, centerY, z = 0, font, colorFn }) {
  const W = 1600, LH = 300, H = LH * lines.length;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  const [weight, family] = font.split('|');
  lines.forEach((line, i) => {
    let size = 250;
    x.font = `${weight} ${size}px ${family}`;
    const m = x.measureText(line).width;
    if (m > W * 0.92) size *= (W * 0.92) / m;
    x.font = `${weight} ${size}px ${family}`;
    x.fillText(line, W / 2, LH * (i + 0.5));
  });
  const data = x.getImageData(0, 0, W, H).data;
  const pts = [];
  const step = 2;
  for (let py = 0; py < H; py += step) for (let px = 0; px < W; px += step) if (data[(py * W + px) * 4 + 3] > 150) pts.push(px, py);
  const count = pts.length / 2;
  const k = width / W;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < N; i++) {
    const s = count ? ((Math.random() * count) | 0) * 2 : 0;
    const px = count ? pts[s] : W / 2, py = count ? pts[s + 1] : H / 2;
    pos[i * 3] = (px - W / 2 + rand(-1, 1) * step) * k;
    pos[i * 3 + 1] = -(py - H / 2 + rand(-1, 1) * step) * k + centerY;
    pos[i * 3 + 2] = z + rand(-0.25, 0.25);
    minX = Math.min(minX, pos[i * 3]);
    maxX = Math.max(maxX, pos[i * 3]);
  }
  for (let i = 0; i < N; i++) {
    const u = (pos[i * 3] - minX) / (maxX - minX || 1);
    col.set(colorFn(u, i), i * 3);
  }
  // particles per world-unit² of glyph area — used to even out brightness between words
  const density = N / Math.max(1, count * (step * k) * (step * k));
  return { pos, col, height: (H / W) * width, width, density };
}

function gradient(stops) {
  const cols = stops.map((s) => lin(s));
  return (u) => {
    const f = u * (cols.length - 1);
    const i = Math.min(cols.length - 2, Math.floor(f));
    const t = f - i;
    const k = rand(0.7, 1.05);
    return [0, 1, 2].map((ch) => (cols[i][ch] * (1 - t) + cols[i + 1][ch] * t) * k);
  };
}
const goldFn = () => (Math.random() < 0.14 ? lin(0xffffff, rand(0.9, 1.2)) : lin(pick([0xffc24d, 0xffd88a, 0xffb347]), rand(0.75, 1.05)));

function sampleHeart(scale, centerY, z = 0) {
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const shades = [0xff2d6f, 0xff5c93, 0xff86b0, 0xff3b5c];
  for (let i = 0; i < N; i++) {
    const t = Math.random() * Math.PI * 2;
    const edge = Math.random() < 0.4;
    const k = edge ? 1 + randn() * 0.025 : Math.sqrt(Math.random());
    const hx = 16 * Math.pow(Math.sin(t), 3);
    const hy = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pos[i * 3] = hx * k * scale;
    pos[i * 3 + 1] = (hy + 3) * k * scale + centerY;
    pos[i * 3 + 2] = z + randn() * (1 - k * 0.8) * 1.6;
    col.set(edge ? lin(pick([0xff9cc0, 0xffc2d8]), rand(0.45, 0.7)) : lin(pick(shades), rand(0.6, 0.95)), i * 3);
  }
  return { pos, col, center: new THREE.Vector3(0, centerY, z) };
}

function sampleCakeCloud() {
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const parts = [
    { w: 26, f: () => { const a = rand(0, 6.283); return [Math.cos(a) * CAKE.b.r, rand(CAKE.plateTop, CAKE.bTop), Math.sin(a) * CAKE.b.r]; }, c: 0xff8dbb },
    { w: 12, f: () => { const a = rand(0, 6.283), r = Math.sqrt(rand(Math.pow(CAKE.t.r / CAKE.b.r, 2), 1)) * CAKE.b.r; return [Math.cos(a) * r, CAKE.bTop, Math.sin(a) * r]; }, c: 0xfff7ee },
    { w: 14, f: () => { const a = rand(0, 6.283); return [Math.cos(a) * CAKE.t.r, rand(CAKE.bTop, CAKE.tTop), Math.sin(a) * CAKE.t.r]; }, c: 0xfff0dc },
    { w: 9.6, f: () => { const a = rand(0, 6.283), r = Math.sqrt(Math.random()) * CAKE.t.r; return [Math.cos(a) * r, CAKE.tTop, Math.sin(a) * r]; }, c: 0xff4f93 },
    { w: 6, f: () => { const a = rand(0, 6.283), r = Math.sqrt(Math.random()) * 3.4; return [Math.cos(a) * r, 0.18, Math.sin(a) * r]; }, c: 0xd9d6ff },
  ];
  const total = parts.reduce((s, p) => s + p.w, 0);
  for (let i = 0; i < N; i++) {
    let r = Math.random() * total, part = parts[0];
    for (const p of parts) { if ((r -= p.w) <= 0) { part = p; break; } }
    pos.set(part.f(), i * 3);
    col.set(lin(part.c, rand(0.25, 0.4)), i * 3);
  }
  return { pos, col };
}

// ============================================================================
// fireworks
// ============================================================================

class Fireworks {
  constructor(max) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.kind = new Uint8Array(max); // 0 spark, 1 rocket, 2 flash, 3 glitter
    this.payload = new Array(max);
    this.head = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uScale: uPointScale },
      vertexShader: /* glsl */ `
        uniform float uScale; attribute vec3 aColor; attribute float aSize, aAlpha; varying vec3 vC; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          vC = aColor; vA = aAlpha * smoothstep(0.5, 3.0, -mv.z);
          gl_PointSize = aAlpha > 0.0 ? min(aSize * uScale / -mv.z, 160.0) : 0.0;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC; varying float vA;
        void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC, a * a * vA); }`,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }

  spawn(x, y, z, vx, vy, vz, c, life, size, drag, grav, kind = 0) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    const j = i * 3;
    this.pos[j] = x; this.pos[j + 1] = y; this.pos[j + 2] = z;
    this.vel[j] = vx; this.vel[j + 1] = vy; this.vel[j + 2] = vz;
    this.col[j] = c[0]; this.col[j + 1] = c[1]; this.col[j + 2] = c[2];
    this.life[i] = this.maxLife[i] = life;
    this.size[i] = size; this.drag[i] = drag; this.grav[i] = grav; this.kind[i] = kind; this.alpha[i] = 1;
    this.payload[i] = null;
    return i;
  }

  launch(tx, ty, tz, opts = {}) {
    const x0 = tx + rand(-2.5, 2.5), y0 = 0.4, z0 = tz + rand(-1, 1);
    const g = 9.5;
    const vy = Math.sqrt(2 * g * Math.max(2, ty - y0));
    const T = vy / g;
    const i = this.spawn(x0, y0, z0, (tx - x0) / T, vy, (tz - z0) / T, [3.2, 2.3, 1.4], T, 0.26, 0, g, 1);
    this.payload[i] = opts;
    sound.whoosh();
  }

  burst(x, y, z, opts = {}) {
    const type = opts.type || pick(['peony', 'peony', 'ring', 'willow', 'heart', 'twotone', 'glitter', 'peony']);
    const hue = opts.hue ?? Math.random();
    const hue2 = (hue + 0.35 + Math.random() * 0.3) % 1;
    const toCol = (h, s = 1, l = 0.6, k = 3.1) => { const c = new THREE.Color().setHSL(h, s, l); return [c.r * k, c.g * k, c.b * k]; };
    const big = opts.big ? 1.3 : 1;
    const count = Math.round((IS_MOBILE ? 150 : 270) * big * (type === 'ring' ? 0.6 : 1));
    const speed = rand(6.5, 8.5) * big;
    const v = new THREE.Vector3();
    let u, w;
    if (type === 'ring') {
      const nrm = new THREE.Vector3(randn(), randn() + 1.5, randn()).normalize();
      u = new THREE.Vector3(1, 0, 0).cross(nrm).normalize();
      w = nrm.clone().cross(u).normalize();
    }
    for (let k = 0; k < count; k++) {
      let c = toCol(hue, 1, rand(0.55, 0.72));
      let life = rand(1.3, 2.1), drag = 1.5, grav = 2.6, size = rand(0.17, 0.26), kind = 0;
      if (type === 'ring') {
        const a = (k / count) * Math.PI * 2;
        v.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(w, Math.sin(a)).multiplyScalar(speed * rand(0.97, 1.03));
      } else if (type === 'heart') {
        const t = (k / count) * Math.PI * 2;
        const hx = 16 * Math.pow(Math.sin(t), 3) / 16, hy = (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 16;
        v.set(hx, hy, randn() * 0.06).multiplyScalar(speed * 0.95).applyQuaternion(camera.quaternion);
        c = toCol(rand(0.93, 0.99), 1, rand(0.6, 0.7), 3.3);
        grav = 0.9; drag = 1.7;
      } else {
        v.set(randn(), randn(), randn()).normalize().multiplyScalar(speed * rand(0.82, 1.0));
        if (type === 'willow') { c = toCol(0.11, 1, rand(0.55, 0.7), 2.9); life = rand(2.8, 3.6); drag = 1.9; grav = 2.2; kind = 3; size = rand(0.13, 0.2); }
        if (type === 'twotone' && k % 2) c = toCol(hue2, 1, rand(0.55, 0.7));
        if (type === 'glitter') { kind = 3; c = k % 3 ? toCol(hue, 0.6, 0.8, 3.2) : [3.2, 3.0, 2.5]; life = rand(1.8, 2.6); }
      }
      this.spawn(x, y, z, v.x, v.y, v.z, c, life, size, drag, grav, kind);
    }
    // inner pistil of white/gold
    if (type !== 'willow') for (let k = 0; k < count * 0.18; k++) {
      v.set(randn(), randn(), randn()).normalize().multiplyScalar(speed * 0.35);
      this.spawn(x, y, z, v.x, v.y, v.z, [3.2, 2.8, 2.0], rand(0.6, 1.0), 0.14, 2.2, 1.5, 3);
    }
    this.spawn(x, y, z, 0, 0, 0, toCol(hue, 0.6, 0.8, 3), 0.3, 4.5 * big, 0, 0, 2);
    const fc = new THREE.Color().setHSL(type === 'willow' ? 0.11 : hue, 0.8, 0.6);
    fwLight.color.copy(fc);
    fwLight.position.set(x, y, z);
    fwLight.intensity = 70 * big;
    sound.boom(opts.big ? 1.2 : rand(0.7, 1));
    if (type === 'glitter' || type === 'willow') sound.crackle();
  }

  update(dt, t) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const j = i * 3;
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        if (this.kind[i] === 1) this.burst(this.pos[j], this.pos[j + 1], this.pos[j + 2], this.payload[i] || {});
        continue;
      }
      const dr = Math.exp(-this.drag[i] * dt);
      this.vel[j] *= dr; this.vel[j + 1] = this.vel[j + 1] * dr - this.grav[i] * dt; this.vel[j + 2] *= dr;
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt;
      const k = this.life[i] / this.maxLife[i];
      const kind = this.kind[i];
      if (kind === 1) {
        this.alpha[i] = 1;
        for (let s = 0; s < 2; s++) this.spawn(this.pos[j] + randn() * 0.05, this.pos[j + 1], this.pos[j + 2] + randn() * 0.05, randn() * 0.4, rand(-1.5, -0.3), randn() * 0.4, [2.8, 1.6, 0.6], rand(0.35, 0.7), 0.12, 2, 1.2, 0);
      } else if (kind === 2) {
        this.alpha[i] = k * k;
      } else {
        let a = Math.pow(Math.min(1, k * 1.5), 1.3);
        if (kind === 3 && k < 0.7) a *= Math.sin(t * 40 + i) > 0.2 ? 1 : 0.15;
        this.alpha[i] = a;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
    fwLight.intensity *= Math.exp(-5 * dt);
  }
}
const fireworks = new Fireworks(IS_MOBILE ? 9000 : 18000);
scene.add(fireworks.points);

function skyPoint() {
  const spread = camera.aspect < 0.9 ? 6 : 13;
  return [rand(-spread, spread), rand(9, 16), rand(-14, -6)];
}

// ============================================================================
// confetti
// ============================================================================

const confetti = (() => {
  const max = IS_MOBILE ? 450 : 1000;
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.11, 0.2),
    new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.45, metalness: 0.35, envMapIntensity: 0.9 }),
    max
  );
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const cols = [0xff4f9a, 0xffd166, 0x5fd4ff, 0xa883ff, 0x7dffb0, 0xffffff, 0xff8a5c];
  const st = Array.from({ length: max }, () => ({
    on: false, landed: false, p: new THREE.Vector3(), v: new THREE.Vector3(),
    q: new THREE.Quaternion(), axis: new THREE.Vector3(), spin: 0, ph: 0,
  }));
  const d = new THREE.Object3D();
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < max; i++) { mesh.setMatrixAt(i, zero); mesh.setColorAt(i, new THREE.Color(pick(cols))); }
  let head = 0;
  const tmpQ = new THREE.Quaternion();

  function spawn(p, v) {
    const s = st[head];
    head = (head + 1) % max;
    s.on = true; s.landed = false;
    s.p.copy(p); s.v.copy(v);
    s.axis.set(randn(), randn(), randn()).normalize();
    s.spin = rand(6, 14);
    s.ph = Math.random() * 10;
    s.q.setFromAxisAngle(s.axis, Math.random() * 6);
  }
  function cannon(origin, dir, n = 160) {
    const d0 = dir.clone().normalize();
    for (let i = 0; i < n; i++) {
      const v = d0.clone().multiplyScalar(rand(7, 13)).add(new THREE.Vector3(randn() * 1.6, randn() * 1.6, randn() * 1.6));
      spawn(origin.clone().add(new THREE.Vector3(randn() * 0.2, 0, randn() * 0.2)), v);
    }
    sound.pop();
  }
  function rain(n = 200) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 10;
      spawn(new THREE.Vector3(Math.cos(a) * r, rand(14, 22), Math.sin(a) * r), new THREE.Vector3(0, rand(-1, 0), 0));
    }
  }
  function update(dt, t) {
    for (let i = 0; i < max; i++) {
      const s = st[i];
      if (!s.on || s.landed) continue;
      s.v.y -= 7 * dt;
      const dr = Math.exp(-2.4 * dt);
      s.v.multiplyScalar(dr);
      s.p.addScaledVector(s.v, dt);
      s.p.x += Math.sin(t * 3 + s.ph) * 0.7 * dt;
      s.p.z += Math.cos(t * 2.3 + s.ph) * 0.5 * dt;
      tmpQ.setFromAxisAngle(s.axis, s.spin * dt);
      s.q.multiply(tmpQ);
      // land on the cake ledges or on the floor
      const r = Math.hypot(s.p.x, s.p.z);
      let ground = 0.012;
      if (r < CAKE.t.r) ground = CAKE.tTop + 0.03;
      else if (r < CAKE.b.r) ground = CAKE.bTop + 0.03;
      else if (r < 3.35) ground = 0.2;
      if (s.v.y < 0 && s.p.y <= ground && s.p.y > ground - 0.6) {
        s.p.y = ground;
        s.landed = true;
        s.q.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, Math.random() * 6));
      } else if (s.p.y < -1) { s.on = false; mesh.setMatrixAt(i, zero); continue; }
      d.position.copy(s.p);
      d.quaternion.copy(s.q);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  return { mesh, cannon, rain, update };
})();
scene.add(confetti.mesh);

// ============================================================================
// balloons
// ============================================================================

const balloons = (() => {
  const group = new THREE.Group();
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI;
    pts.push(new THREE.Vector2(Math.sin(a) * 0.85 * (1 + 0.2 * -Math.cos(a)) + 0.0001, -Math.cos(a) * 1.15));
  }
  const geo = new THREE.LatheGeometry(pts, 36);
  const knotGeo = new THREE.ConeGeometry(0.09, 0.14, 10);
  const cols = [0xff4f9a, 0xffc94d, 0x5fc8ff, 0xa883ff, 0xff7a6b, 0x6dffc2, 0xffffff];
  const list = [];
  const count = IS_MOBILE ? 8 : 14;
  for (let i = 0; i < count; i++) {
    const c = cols[i % cols.length];
    const mat = new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1, sheen: 0.5, sheenColor: new THREE.Color(0xffffff) });
    const b = new THREE.Group();
    const body = new THREE.Mesh(geo, mat);
    body.castShadow = true;
    const knot = new THREE.Mesh(knotGeo, mat);
    knot.position.y = -1.2;
    const sp = [];
    for (let k = 0; k <= 14; k++) sp.push(new THREE.Vector3(Math.sin(k * 0.6) * 0.08, -1.25 - k * 0.22, Math.cos(k * 0.4) * 0.05));
    const string = new THREE.Line(new THREE.BufferGeometry().setFromPoints(sp), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }));
    b.add(body, knot, string);
    let x, z;
    do { x = rand(-12, 12); z = rand(-11, 3); } while (Math.hypot(x, z) < 4.5);
    b.position.set(x, rand(-2, 8), z);
    const s = rand(0.5, 0.7);
    b.userData = { base: new THREE.Vector3(x, 0, z), speed: rand(0.7, 1.3), ph: Math.random() * 10, s, grow: { v: 0 } };
    b.scale.setScalar(0.0001);
    group.add(b);
    list.push(b);
  }
  group.visible = false;
  let active = false;
  function release() {
    group.visible = true;
    active = true;
    list.forEach((b, i) => {
      b.position.y = rand(0.6, 5);
      sleep(i * 0.15).then(() => animate(b.userData.grow, { v: 1 }, 1.0, ease.outBack));
    });
  }
  function update(dt, t) {
    if (!active) return;
    for (const b of list) {
      const u = b.userData;
      b.position.y += u.speed * dt;
      b.position.x = u.base.x + Math.sin(t * 0.6 + u.ph) * 0.6;
      b.position.z = u.base.z + Math.cos(t * 0.5 + u.ph) * 0.4;
      b.rotation.z = Math.sin(t * 0.9 + u.ph) * 0.12;
      b.rotation.y += dt * 0.2;
      b.scale.setScalar(Math.max(0.0001, u.grow.v * u.s));
      if (b.position.y > 30) { b.position.y = 0.8; u.grow.v = 0; animate(u.grow, { v: 1 }, 1.0, ease.outBack); }
    }
  }
  return { group, release, update };
})();
scene.add(balloons.group);

// ============================================================================
// floating polaroid photos
// ============================================================================

const photos = (() => {
  const group = new THREE.Group();
  const items = [];
  const loader = new THREE.TextureLoader();
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xf3efe6, roughness: 0.85, envMapIntensity: 0.4 });
  const frameGeo = new THREE.BoxGeometry(1.72, 2.32, 0.035);
  CFG.photos.forEach((src, i) => {
    const holder = new THREE.Group();
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.castShadow = true;
    const photoMat = new THREE.MeshBasicMaterial({ color: 0x222222, toneMapped: false });
    const photo = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.82), photoMat);
    photo.position.set(0, 0.17, 0.019);
    photo.userData.src = src;
    frame.userData.src = src;
    holder.add(frame, photo);
    loader.load(src, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      // cover-fit the photo into a 1.5 × 1.82 window (slightly portrait polaroid)
      const img = tex.image, target = 1.5 / 1.82, aspect = img.width / img.height;
      if (aspect > target) { tex.repeat.set(target / aspect, 1); tex.offset.set((1 - target / aspect) / 2, 0); }
      else { tex.repeat.set(1, aspect / target); tex.offset.set(0, (1 - aspect / target) * 0.62); }
      photoMat.map = tex;
      photoMat.color.set(0xffffff);
      photoMat.needsUpdate = true;
    });
    holder.userData = { ph: i * 1.7, tilt: rand(-0.12, 0.12), grow: { v: 0 } };
    holder.scale.setScalar(0.0001);
    group.add(holder);
    items.push({ holder, hit: [frame, photo] });
  });
  group.visible = false;
  const state = { radius: { v: 0 }, angle: 0, active: false };
  const n = Math.max(1, items.length);
  function show() {
    group.visible = true;
    state.active = true;
    animate(state.radius, { v: camera.aspect < 0.9 ? 4.9 : 6.8 }, 2.6, ease.outCubic);
    items.forEach((it, i) => sleep(0.25 + i * 0.25).then(() => animate(it.holder.userData.grow, { v: 1 }, 1.2, ease.outBack)));
  }
  function update(dt, t) {
    if (!state.active) return;
    state.angle += dt * 0.16;
    items.forEach((it, i) => {
      const h = it.holder, u = h.userData;
      const a = state.angle + (i / n) * Math.PI * 2;
      const r = state.radius.v;
      h.position.set(Math.cos(a) * r, 4.4 + Math.sin(t * 0.8 + u.ph) * 0.3, Math.sin(a) * r);
      h.quaternion.copy(camera.quaternion);
      h.rotateZ(u.tilt + Math.sin(t * 0.7 + u.ph) * 0.06);
      h.scale.setScalar(Math.max(0.0001, u.grow.v * (camera.aspect < 0.9 ? 1.0 : 1.15)));
    });
  }
  const hitList = items.flatMap((it) => it.hit);
  return { group, show, update, hitList, state };
})();
scene.add(photos.group);

// ============================================================================
// candle smoke
// ============================================================================

const smoke = (() => {
  const list = [];
  for (let i = 0; i < 90; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDot, color: 0xb9b2c9, transparent: true, opacity: 0, depthWrite: false }));
    s.visible = false;
    scene.add(s);
    list.push({ s, life: 0, max: 1, v: new THREE.Vector3() });
  }
  let head = 0;
  function puff(pos, n = 14) {
    for (let k = 0; k < n; k++) {
      const p = list[head];
      head = (head + 1) % list.length;
      p.s.position.copy(pos).add(new THREE.Vector3(randn() * 0.03, k * 0.02, randn() * 0.03));
      p.v.set(randn() * 0.12, rand(0.45, 0.8), randn() * 0.12);
      p.life = p.max = rand(1.8, 3.2) + k * 0.05;
      p.s.visible = true;
    }
  }
  function update(dt, t) {
    for (const p of list) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      const k = 1 - p.life / p.max;
      p.s.position.addScaledVector(p.v, dt);
      p.s.position.x += Math.sin(t * 2 + p.max * 9) * 0.12 * dt;
      p.s.scale.setScalar(0.12 + k * 0.9);
      p.s.material.opacity = Math.sin(Math.min(1, k * 4) * Math.PI / 2) * (1 - k) * 0.32;
    }
  }
  return { puff, update };
})();

// ============================================================================
// camera rig (framing adapts to any screen shape)
// ============================================================================

const cam = { target: new THREE.Vector3(0, TEXT_Y, 0), offset: new THREE.Vector3(0, 0, 30), yaw: 0, userYaw: 0, sway: 0 };
const SHOTS = {};
let currentShot = null;
// pixels of the screen reserved for UI (right side or bottom); the 3D view is
// shifted with setViewOffset so the scene stays centred in the free area
const view = { x: 0, y: 0, tx: 0, ty: 0 };
function fitDist(halfW, halfH) {
  const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const fw = Math.max(0.35, 1 - view.tx / innerWidth), fh = Math.max(0.35, 1 - view.ty / innerHeight);
  return Math.max(halfH / (t * fh), halfW / (t * camera.aspect * fw));
}
function pose(shot) {
  const d = fitDist(shot.halfW, shot.halfH) * (shot.mul || 1);
  return { target: shot.target.clone(), offset: shot.dir.clone().normalize().multiplyScalar(d) };
}
function cut(shot) {
  currentShot = shot;
  const p = pose(shot);
  cam.target.copy(p.target);
  cam.offset.copy(p.offset);
}
function moveTo(shot, dur, e = ease.inOutCubic) {
  currentShot = shot;
  const p = pose(shot);
  return Promise.all([
    animate(cam.target, { x: p.target.x, y: p.target.y, z: p.target.z }, dur, e),
    animate(cam.offset, { x: p.offset.x, y: p.offset.y, z: p.offset.z }, dur, e),
  ]);
}

const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
function updateCamera(dt, t) {
  pointer.sx += (pointer.x - pointer.sx) * Math.min(1, dt * 2.5);
  pointer.sy += (pointer.y - pointer.sy) * Math.min(1, dt * 2.5);
  cam.yaw += cam.sway * dt;
  const yaw = cam.yaw + cam.userYaw + pointer.sx * 0.12;
  tmpV.copy(cam.offset).applyAxisAngle(Y_AXIS, yaw);
  camera.position.copy(cam.target).add(tmpV);
  camera.position.y += -pointer.sy * 0.8 + Math.sin(t * 0.4) * 0.12;
  camera.lookAt(cam.target);
  if (view.x > 0.5 || view.y > 0.5) camera.setViewOffset(innerWidth, innerHeight, view.x / 2, view.y / 2, innerWidth, innerHeight);
  else if (camera.view && camera.view.enabled) camera.clearViewOffset();
}

// ============================================================================
// layout for the current screen shape
// ============================================================================

const STATES = {};
async function buildStates() {
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('900 100px "Poppins"'),
        document.fonts.load('800 100px "Poppins"'),
        document.fonts.load('italic 900 100px "Playfair Display"'),
      ]),
      new Promise((r) => setTimeout(r, 3500)),
    ]);
  } catch { /* fall back to system fonts */ }

  const portrait = camera.aspect < 0.9;
  const sans = '800|"Poppins", system-ui, sans-serif';
  const serif = 'italic 900|"Playfair Display", Georgia, serif';
  const w = portrait ? 12 : 23;

  STATES.happy = sampleText(portrait ? ['HAPPY', 'BIRTHDAY'] : ['HAPPY BIRTHDAY'], {
    width: w, centerY: TEXT_Y, font: sans, colorFn: gradient([0xff5fae, 0xc06bff, 0x5fd0ff]),
  });
  if (CFG.age) {
    STATES.age = sampleText([String(CFG.age)], { width: portrait ? 15 : 22, centerY: TEXT_Y, font: sans, colorFn: gradient([0x7ee0ff, 0xffffff, 0xffd27a]) });
  }
  STATES.name = sampleText([CFG.name], { width: portrait ? 13 : 22, centerY: TEXT_Y, font: serif, colorFn: goldFn });
  // short words pack the same particle count into less area, so dim them to match
  const refDensity = STATES.happy.density;
  for (const st of [STATES.age, STATES.name]) {
    if (!st) continue;
    const f = Math.min(1, Math.pow(refDensity / st.density, 0.8));
    for (let i = 0; i < st.col.length; i++) st.col[i] *= f;
  }
  STATES.heart = sampleHeart(portrait ? 0.29 : 0.27, TEXT_Y);
  STATES.cake = sampleCakeCloud();
  const fw = portrait ? 9.5 : 15;
  STATES.final = sampleText(['Happy Birthday', CFG.name], { width: fw, centerY: 10.3, z: -3, font: serif, colorFn: goldFn });

  const textHalfW = (w / 2) * 0.98 + 0.6;
  SHOTS.intro = { target: new THREE.Vector3(0, TEXT_Y, 0), dir: new THREE.Vector3(0, 0.02, 1), halfW: textHalfW, halfH: 5.6, mul: 1.3 };
  SHOTS.text = { target: new THREE.Vector3(0, TEXT_Y, 0), dir: new THREE.Vector3(0, 0.02, 1), halfW: textHalfW, halfH: 5.6 };
  SHOTS.cake = { target: new THREE.Vector3(0, 2.3, 0), dir: new THREE.Vector3(0, 0.42, 1), halfW: 4.4, halfH: 3.3 };
  SHOTS.wish = { target: new THREE.Vector3(0, 3.1, 0), dir: new THREE.Vector3(0, 0.55, 1), halfW: 2.9, halfH: 2.3 };
  SHOTS.finale = { target: new THREE.Vector3(0, 6, 0), dir: new THREE.Vector3(0, 0.1, 1), halfW: Math.max(fw / 2 + 0.8, 6.8), halfH: 7.9 };
}

function onResize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.fov = camera.aspect < 0.9 ? 62 : 50;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.resolution.set(w, h);
  updatePointScale();
  if (phase === 'finale') layoutCard(!$('finale').classList.contains('hidden'), false);
  if (currentShot && ![...tweens].some((tw) => tw.obj === cam.offset)) cut(currentShot);
}
addEventListener('resize', onResize);
onResize();

// ============================================================================
// UI helpers
// ============================================================================

const ui = {
  caption: $('caption'),
  say(text) {
    const el = this.caption;
    el.classList.remove('show');
    clearTimeout(this._t);
    this._t = setTimeout(() => { el.textContent = text; el.classList.add('show'); }, text ? 280 : 0);
  },
  hush() { clearTimeout(this._t); this.caption.classList.remove('show'); },
  show(id) { $(id).classList.remove('hidden'); },
  hide(id) { $(id).classList.add('hidden'); },
  flash() { const f = $('flash'); f.classList.remove('go'); void f.offsetWidth; f.classList.add('go'); },
};

$('mute').addEventListener('click', (e) => {
  e.stopPropagation();
  sound.setMuted(!sound.muted);
  $('mute').textContent = sound.muted ? '🔇' : '🔊';
});

// ============================================================================
// the show
// ============================================================================

// Make room for the message card: side panel on wide screens, bottom sheet on tall ones.
function layoutCard(visible, smooth = true) {
  const card = $('finale');
  const side = innerWidth / innerHeight >= 1.1 && innerWidth >= 860;
  card.classList.toggle('side', side);
  let tx = 0, ty = 0;
  if (visible) {
    const r = card.getBoundingClientRect();
    if (side) tx = r.width + 56; else ty = r.height + 28;
  }
  view.tx = tx; view.ty = ty;
  if (smooth) {
    animate(view, { x: tx, y: ty }, 1.4);
    moveTo(SHOTS.finale, 1.6);
  } else { view.x = tx; view.y = ty; }
}
let autoFire = false, fireTimer = 0;
let resolveBlow = null;
let mic = null, micAcc = 0;

function lightCandles() {
  return cake.candles.reduce((p, c, i) => p.then(async () => {
    c.lit = true;
    animate(c.life, { v: 1 }, 0.5, ease.outBack);
    sound.ting(i);
    await sleep(0.22);
  }), Promise.resolve());
}

async function startShow() {
  phase = 'show';
  sound.init();
  sound.chime();
  sound.ambience(9, 2.4);
  ui.hide('intro');
  canvas.focus();

  // galaxy → HAPPY BIRTHDAY
  moveTo(SHOTS.text, 3.2);
  await morphTo(STATES.happy, 2.8, { arc: 3, sweep: true });
  sound.sparkle();
  await sleep(2.2);

  if (STATES.age) {
    await morphTo(STATES.age, 2.2, { arc: 2.5 });
    sound.sparkle();
    await sleep(1.8);
  }

  // → the name, in gold
  await morphTo(STATES.name, 2.6, { arc: 3.2, sweep: true });
  sound.sparkle(sound.now, 0.09);
  animate(hero.mat.uniforms.uShimmer, { value: 1 }, 0.6);
  await sleep(2.8);
  animate(hero.mat.uniforms.uShimmer, { value: 0 }, 0.6);

  // → a beating heart
  await morphTo(STATES.heart, 2.3, { arc: 2.2, pulse: true });
  hero.pulseStart = elapsed;
  for (let k = 0; k < 3; k++) sound.heartbeat(sound.now + k * 0.9);
  await sleep(2.7);
  hero.pulseStart = -1;

  // → particles rain down and *build* the cake
  moveTo(SHOTS.cake, 3.4, ease.inOutCubic);
  await morphTo(STATES.cake, 3.0, { arc: 4 });
  cake.group.visible = true;
  ui.flash();
  sound.sparkle(sound.now, 0.1);
  cake.flashMats.forEach((m) => { m.emissiveIntensity = 0.5; animate(m, { emissiveIntensity: 0 }, 1.6, ease.outCubic); });
  animate(cake.group.scale, { x: 1, y: 1, z: 1 }, 0.9, ease.outBack);
  morphTo('orbit', 2.4, { arc: 3 });
  animate(hero.mat.uniforms.uOpacity, { value: 0.5 }, 2.4);
  animate(hero.mat.uniforms.uSize, { value: 0.11 }, 2.4);
  cam.sway = 0.07;
  await sleep(1.4);

  // light the candles and sing
  await lightCandles();
  animate(candleGlow, { v: 5 }, 1.2);
  await sleep(0.4);
  const song = sound.song();
  const lines = ['Happy birthday to you', 'Happy birthday to you', `Happy birthday dear ${CFG.name}`, 'Happy birthday to you 🎂'];
  let elapsedSong = 0;
  for (let i = 0; i < 4; i++) {
    await sleep(song.lines[i] - elapsedSong);
    elapsedSong = song.lines[i];
    ui.say(lines[i]);
  }
  await sleep(song.duration - elapsedSong + 0.6);
  ui.hush();

  // make a wish
  cam.sway = 0.025;
  moveTo(SHOTS.wish, 2.6);
  $('wish-text').textContent = 'Close your eyes and make a wish… ✨';
  ui.show('wish');
  await sleep(3.6);
  $('wish-text').style.opacity = 0;
  await sleep(0.4);
  $('wish-text').textContent = 'Now… blow out the candles! 🕯️';
  $('wish-text').style.opacity = 1;
  $('blow-controls').classList.remove('hidden');
  phase = 'blow';
  await new Promise((res) => { resolveBlow = res; });
  await blowOut();
  await finale();
}

function triggerBlow() {
  if (phase !== 'blow' || !resolveBlow) return;
  phase = 'blowing';
  const r = resolveBlow;
  resolveBlow = null;
  if (mic) { mic.stop(); mic = null; }
  r();
}

async function blowOut() {
  ui.hide('wish');
  sound.blow();
  cake.candles.forEach((c, i) => {
    sleep(i * 0.06).then(async () => {
      animate(c.lean, { v: 1 }, 0.25, ease.outCubic);
      await animate(c.life, { v: 0 }, 0.35, ease.inCubic);
      c.lit = false;
      const p = new THREE.Vector3();
      c.flame.getWorldPosition(p);
      smoke.puff(p);
    });
  });
  animate(candleGlow, { v: 0 }, 0.6);
  animate(key, { intensity: LIGHT_LEVELS.key * 0.25 }, 0.8);
  animate(hemi, { intensity: 0.18 }, 0.8);
  animate(rimPink, { intensity: 25 }, 0.8);
  animate(rimBlue, { intensity: 20 }, 0.8);
  animate(hero.mat.uniforms.uOpacity, { value: 0.2 }, 0.8);
  await sleep(1.9);
}

async function finale() {
  phase = 'finale';
  ui.flash();
  sound.fanfare();
  animate(key, { intensity: LIGHT_LEVELS.key }, 1.2);
  animate(hemi, { intensity: LIGHT_LEVELS.hemi }, 1.2);
  animate(rimPink, { intensity: LIGHT_LEVELS.rimPink * 1.3 }, 1.2);
  animate(rimBlue, { intensity: LIGHT_LEVELS.rimBlue * 1.3 }, 1.2);
  cam.sway = 0;
  animate(cam, { yaw: Math.round(cam.yaw / (Math.PI * 2)) * Math.PI * 2 }, 3.6);
  moveTo(SHOTS.finale, 3.6);

  for (let k = 0; k < 5; k++) { const [x, y, z] = skyPoint(); fireworks.launch(x, y, z, { big: k === 2 }); }
  confetti.cannon(new THREE.Vector3(-4.6, 0.3, 2.6), new THREE.Vector3(0.3, 1, -0.2));
  confetti.cannon(new THREE.Vector3(4.6, 0.3, 2.6), new THREE.Vector3(-0.3, 1, -0.2));
  balloons.release();
  sleep(1.8).then(photos.show);

  animate(hero.mat.uniforms.uOpacity, { value: 1 }, 2.5);
  animate(hero.mat.uniforms.uSize, { value: 0.13 }, 2.5);
  await morphTo(STATES.final, 3.2, { arc: 3.5, sweep: true });
  animate(hero.mat.uniforms.uShimmer, { value: 1 }, 1);
  autoFire = true;
  fireTimer = 0.5;
  sound.sparkle(sound.now, 0.1);
  await sleep(1.0);
  confetti.rain(IS_MOBILE ? 140 : 260);
  await sleep(1.2);
  ui.show('finale');
  layoutCard(true);
  await sleep(1.5);
  const reprise = sound.song({ beat: 0.5, vol: 0.55, octave: 12 });
  void reprise;
}

// ============================================================================
// interaction
// ============================================================================

let down = null;
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

canvas.addEventListener('pointermove', (e) => {
  pointer.x = (e.clientX / innerWidth) * 2 - 1;
  pointer.y = (e.clientY / innerHeight) * 2 - 1;
  if (down && (phase === 'finale' || phase === 'blow')) {
    const dx = e.clientX - down.x;
    if (Math.abs(dx) > 6) down.moved = true;
    cam.userYaw = down.yaw - dx * 0.006;
  }
});
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, yaw: cam.userYaw, moved: false };
});
addEventListener('pointerup', (e) => {
  if (!down) return;
  const wasTap = !down.moved && e.target === canvas;
  down = null;
  if (!wasTap) return;
  if (IS_MOBILE) { pointer.x = 0; pointer.y = 0; }
  if (phase === 'blow') { triggerBlow(); return; }
  if (phase === 'finale') {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(photos.hitList, false)[0];
    if (hit && hit.object.userData.src) {
      $('lightbox').querySelector('img').src = hit.object.userData.src;
      ui.show('lightbox');
      return;
    }
    // launch a firework where the sky was tapped
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 9);
    const p = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(plane, p)) fireworks.launch(THREE.MathUtils.clamp(p.x, -16, 16), THREE.MathUtils.clamp(p.y, 7, 18), -9, { type: pick(['heart', 'peony', 'ring', 'glitter']) });
  }
});

$('start').addEventListener('click', () => { if (phase === 'intro') startShow(); });
addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && phase === 'intro') startShow();
  else if (e.key === ' ' && phase === 'blow') triggerBlow();
});
$('blow').addEventListener('click', triggerBlow);
$('mic').addEventListener('click', async () => {
  try {
    mic = await sound.startMic();
    $('mic').classList.add('hidden');
    $('meter').classList.remove('hidden');
    $('blow-hint').textContent = 'blow into your microphone… 🌬️';
  } catch {
    $('blow-hint').textContent = "couldn't reach the mic — just tap the button instead 💛";
  }
});
$('more').addEventListener('click', () => {
  for (let k = 0; k < 8; k++) sleep(k * 0.18).then(() => { const [x, y, z] = skyPoint(); fireworks.launch(x, y, z, { big: k % 4 === 0 }); });
  confetti.cannon(new THREE.Vector3(-4.6, 0.3, 2.6), new THREE.Vector3(0.3, 1, -0.2), 120);
  confetti.cannon(new THREE.Vector3(4.6, 0.3, 2.6), new THREE.Vector3(-0.3, 1, -0.2), 120);
});
$('replay').addEventListener('click', () => location.reload());
$('close-card').addEventListener('click', () => { ui.hide('finale'); ui.show('show-card'); layoutCard(false); });
$('show-card').addEventListener('click', () => { ui.hide('show-card'); ui.show('finale'); layoutCard(true); });
$('lightbox').addEventListener('click', () => ui.hide('lightbox'));

// ============================================================================
// render loop
// ============================================================================

let elapsed = 0;
let last = performance.now();
const SPEED = Math.min(8, Math.max(0.1, parseFloat(new URLSearchParams(location.search).get('speed')) || 1));
window.__show = { get t() { return elapsed; }, get phase() { return phase; }, blow: () => triggerBlow() };
function frame(now) {
  const dt = Math.min((now - last) / 1000, 1 / 20) * SPEED;
  last = now;
  elapsed += dt;
  uTime.value = elapsed;

  updateTimeline(dt);
  heroUpdate(dt, elapsed);

  // candles
  for (const c of cake.candles) {
    const l = c.life.v;
    if (l <= 0.0001 && !c.lit) { c.flame.visible = false; continue; }
    c.flame.visible = true;
    const f = 1 + Math.sin(elapsed * 13 + c.phase) * 0.08 + Math.sin(elapsed * 23.7 + c.phase * 2) * 0.05;
    c.flame.scale.set(l, l * f, l);
    c.outer.scale.set(0.24, 0.48, 1);
    c.inner.scale.set(0.1, 0.22, 1);
    c.halo.scale.set(0.9, 0.9, 1);
    c.flame.position.x = Math.sin(elapsed * 6 + c.phase) * 0.01 + c.lean.v * 0.12;
    c.flame.rotation.z = -c.lean.v * 0.5;
  }
  candleLight.intensity = candleGlow.v * (1 + Math.sin(elapsed * 17) * 0.08 + Math.sin(elapsed * 31.3) * 0.05);

  // mic blow detection
  if (mic && phase === 'blow') {
    const lvl = mic.level();
    $('meter').firstElementChild.style.width = `${Math.min(100, (lvl / 0.2) * 100)}%`;
    micAcc = lvl > 0.14 ? micAcc + dt : Math.max(0, micAcc - dt * 0.5);
    if (micAcc > 0.28) triggerBlow();
  }

  // finale fireworks
  if (autoFire) {
    fireTimer -= dt;
    if (fireTimer <= 0) {
      const salvo = Math.random() < 0.18 ? 3 : 1;
      for (let k = 0; k < salvo; k++) { const [x, y, z] = skyPoint(); fireworks.launch(x, y, z); }
      fireTimer = rand(0.6, 1.6);
    }
  }

  fireworks.update(dt, elapsed);
  confetti.update(dt, elapsed);
  balloons.update(dt, elapsed);
  smoke.update(dt, elapsed);
  updateCamera(dt, elapsed);
  photos.update(dt, elapsed);

  composer.render();
  requestAnimationFrame(frame);
}

// ============================================================================
// boot
// ============================================================================

(async function boot() {
  $('intro-name').textContent = CFG.name;
  document.title = `Happy Birthday, ${CFG.name} ✨`;
  $('final-name').textContent = CFG.name;
  $('final-message').textContent = CFG.message;
  $('final-from').textContent = CFG.from ? `with love, ${CFG.from}` : '';

  await buildStates();
  cut(SHOTS.intro);
  heroUpdate(0, 0);
  animate(hero.mat.uniforms.uOpacity, { value: 1 }, 2.5, ease.outCubic);
  requestAnimationFrame((t) => { last = t; frame(t); });

  ui.hide('loader');
  await sleep(0.6);
  ui.show('intro');

  // debug / preview helper: ?autoplay skips the button (sound will stay off until a tap)
  if (new URLSearchParams(location.search).has('autoplay')) startShow();
})();
