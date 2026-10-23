// Live2D-style 2D pet rig: one texture, one deformable mesh.
// Weights are baked per-vertex on the CPU; the vertex shader moves the head,
// ears, tail, chest, paws, and stepping legs; the fragment shader swaps in a
// natural fur-grained closed-eye texture and shifts iris gaze cleanly.
import * as THREE from 'three';

const COLS = 72;
const ROWS = 148;

const VERT = /* glsl */ `
attribute float aHead;
attribute float aBreath;
attribute float aTail;
attribute float aEarL;
attribute float aEarR;
attribute float aPawL;
attribute float aPawR;
attribute float aStepL;
attribute float aStepR;

uniform vec2  uNeck;
uniform float uBreathCx;
uniform vec2  uHeadShift;
uniform float uHeadAngle;
uniform float uHeadSquash;
uniform float uBreath;
uniform float uTailSway;
uniform vec2  uEarPivotL;
uniform vec2  uEarPivotR;
uniform float uEarAngleL;
uniform float uEarAngleR;
uniform vec2  uPawPivotL;
uniform vec2  uPawPivotR;
uniform float uPawAngleL;
uniform float uPawAngleR;
uniform float uStepPhase;
uniform float uStepAmp;

varying vec2 vUv;

vec2 rotateAbout(vec2 p, vec2 pivot, float a) {
  vec2 d = p - pivot;
  float c = cos(a), s = sin(a);
  return pivot + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
}

void main() {
  vec2 p = position.xy;

  // ears swing around their own base, in texture space so the head transform
  // below carries them along rigidly
  p = mix(p, rotateAbout(p, uEarPivotL, uEarAngleL), aEarL);
  p = mix(p, rotateAbout(p, uEarPivotR, uEarAngleR), aEarR);

  // head: rigid transform about the neck pivot, blended by weight so the
  // neck itself stretches instead of tearing
  vec2 rel = p - uNeck;
  float a = uHeadAngle * aHead;
  float c = cos(a), s = sin(a);
  rel = vec2(c * rel.x - s * rel.y, s * rel.x + c * rel.y);
  rel.x *= 1.0 - uHeadSquash * aHead;
  p = uNeck + rel + uHeadShift * aHead;

  // front paws (raised hands overhead in belly-up pose, curled fists in side-lying, or stepping forelegs in run pose)
  p = mix(p, rotateAbout(p, uPawPivotL, uPawAngleL), aPawL);
  p = mix(p, rotateAbout(p, uPawPivotR, uPawAngleR), aPawR);

  // procedural alternating lower-limb stepping gait (Mode A & Mode B locomotion)
  float sL = sin(uStepPhase);
  float sR = -sL;
  float cL = cos(uStepPhase);
  p.y += (max(0.0, sL) * aStepL + max(0.0, sR) * aStepR) * uStepAmp * 26.0;
  p.x += (cL * aStepL - cL * aStepR) * uStepAmp * 12.0;

  // ribcage: lift and widen around the chest only. The weight fades out by the
  // elbows so the forelegs and paws stay planted instead of the whole cat
  // stretching up and down like slime.
  float chest = aBreath * uBreath;
  p.y += chest * 9.0;
  p.x += (p.x - uBreathCx) * chest * 0.055;

  // tail sway, strongest at the very tip
  p.x += uTailSway * aTail * 34.0;
  p.y += abs(uTailSway) * aTail * 10.0;

  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D uTex;
uniform sampler2D uTexClosed;
uniform vec2 uEyeLUv;
uniform vec2 uEyeRUv;
uniform vec2 uEyeLRad;
uniform vec2 uEyeRRad;
uniform float uEyeOpen;
uniform vec2 uGaze;
uniform float uAlpha;

varying vec2 vUv;

vec2 gazeUv(vec2 uv, vec2 c, vec2 r) {
  vec2 d = (uv - c) / r;
  float dist = length(d);
  // uEyeLRad/uEyeRRad are multiplied by eyeRadiusScale (2.1), so the actual
  // iris boundary sits at dist ~ 0.47 and the dark eyeliner rim sits at 0.50..0.65.
  // Confining the warp strictly inside dist < 0.45 prevents the black eyelid rim
  // from ever being dragged into the eyeball or folding UV space when looking down.
  float m = 1.0 - smoothstep(0.10, 0.45, dist);
  vec2 g = clamp(uGaze, vec2(-1.0), vec2(1.0));
  return uv - g * r * 0.165 * m;
}

void main() {
  vec2 uv = vUv;
  vec2 openUv = gazeUv(gazeUv(uv, uEyeLUv, uEyeLRad), uEyeRUv, uEyeRRad);
  vec4 openEye = texture2D(uTex, clamp(openUv, vec2(0.0), vec2(1.0)));
  vec4 shutEye = texture2D(uTexClosed, uv);
  vec4 c = mix(openEye, shutEye, 1.0 - uEyeOpen);
  gl_FragColor = vec4(c.rgb, c.a * uAlpha);
  if (gl_FragColor.a < 0.004) discard;
}
`;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const gauss = (x, y, cx, cy, sx, sy) =>
  Math.exp(-(((x - cx) ** 2) / (2 * sx * sx) + ((y - cy) ** 2) / (2 * sy * sy)));

export class PetRig2D {
  constructor(container) {
    this.container = container;
    this.disposed = false;
    this.poseCache = new Map();
    this.params = {
      angleX: 0, angleY: 0, angleZ: 0, breath: 0, eyeOpen: 1,
      earL: 0, earR: 0, tail: 0, alpha: 1,
    };
    this.t = 0;
    this.breathPhase = 0;
    this.tailPhase = 0;
    this.stepPhase = 0;
    this.stepAmp = 0;
    this.stepAmpTarget = 0;
    this.stepSpeed = 11.5;
    this.clock = performance.now();
    this.blink = 0;
    this.blinkTimer = 2 + Math.random() * 3;
    this.sleepy = false;
    this.sleepBlend = 0;
    this.gazeTimer = 1.5;
    this.autoGazeTargetX = 0;
    this.autoGazeTargetY = 0;
    this.autoGazeX = 0;
    this.autoGazeY = 0;
    this.autoDrowsyTarget = 0;
    this.autoDrowsy = 0;
    this.mouseGazeX = 0;
    this.mouseGazeY = 0;
    this.lastMouseAt = 0;

    this.onMouseMove = (e) => {
      if (this.disposed || !this.container) return;
      const rect = this.container.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const nx = Math.max(-1.0, Math.min(1.0, ((e.clientX - (rect.left + rect.width * 0.5)) / (rect.width * 0.65))));
      const ny = Math.max(-0.85, Math.min(0.85, ((e.clientY - (rect.top + rect.height * 0.42)) / (rect.height * 0.65))));
      this.mouseGazeX = nx;
      this.mouseGazeY = ny;
      this.lastMouseAt = performance.now();
    };
    window.addEventListener('mousemove', this.onMouseMove, { passive: true });

    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: false });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 0, -1, -10, 10);
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  setLocomotion(active, speed = 11.5) {
    this.stepAmpTarget = active ? 1.0 : 0.0;
    this.stepSpeed = speed;
  }

  async _buildPose(texUrl, meta, closedTexUrl) {
    const cacheKey = `${texUrl}|${closedTexUrl}`;
    let cached = this.poseCache.get(cacheKey);
    if (cached) return cached;

    const loader = new THREE.TextureLoader();
    const [tex, texClosed] = await Promise.all([loader.loadAsync(texUrl), loader.loadAsync(closedTexUrl)]);
    for (const t of [tex, texClosed]) {
      t.flipY = false;
      t.colorSpace = THREE.NoColorSpace; // sprite art must come out pixel-exact
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 4;
    }

    const rig = meta.rig;
    if (!rig) throw new Error('skin meta is missing "rig"');
    const W = meta.texW, H = meta.texH;
    const ox = meta.origin[0], oy = meta.origin[1];
    const neckTX = meta.neck.cx - ox;
    const neckTY = meta.neck.y - oy;
    const neck = new THREE.Vector2(neckTX, -neckTY);
    const eyeL = meta.eyes[0], eyeR = meta.eyes[1];
    if (!eyeL || !eyeR) throw new Error('skin meta needs two eye landmarks');
    const eyeTY = ((eyeL.cy + eyeR.cy) * 0.5) - oy;

    const texPoint = ([x, y]) => [x - ox, y - oy];
    const worldPoint = ([x, y]) => new THREE.Vector2(x - ox, -(y - oy));
    const ears = (rig.ears || []).map((e) => {
      const [cx, cy] = texPoint(e.center);
      return { cx, cy, sx: e.sigma[0], sy: e.sigma[1], pivot: worldPoint(e.pivot) };
    });
    if (ears.length !== 0 && ears.length !== 2) throw new Error('rig.ears must list 0 or 2 ears');
    const paws = (rig.paws || []).map((pw) => {
      const [cx, cy] = texPoint(pw.center);
      return { cx, cy, sx: pw.sigma[0], sy: pw.sigma[1], pivot: worldPoint(pw.pivot) };
    });
    const breath = rig.breath;
    const [breathCx, breathCy] = texPoint(breath.center);
    const tail = rig.tail || null;

    const pos = [], uv = [], idx = [];
    const wHead = [], wBreath = [], wTail = [], wEarL = [], wEarR = [], wPawL = [], wPawR = [], wStepL = [], wStepR = [];

    for (let j = 0; j <= ROWS; j++) {
      for (let i = 0; i <= COLS; i++) {
        const x = (i / COLS) * W;
        const y = (j / ROWS) * H;
        pos.push(x, -y, 0);
        uv.push(i / COLS, j / ROWS);

        let head = smoothstep(neckTY + rig.head.zeroBelowNeck, neckTY - rig.head.fullAboveNeck, y);
        if (Array.isArray(rig.head.xSpan) && rig.head.xSpan.length === 2) {
          const xWeight = smoothstep(rig.head.xSpan[1], rig.head.xSpan[0], Math.abs(x - neckTX));
          const belowEyes = smoothstep(eyeTY - 20, eyeTY + 60, y);
          head *= 1 - belowEyes * (1 - xWeight);
        }
        if (Array.isArray(rig.head.xRange) && rig.head.xRange.length === 2) {
          const xMin = rig.head.xRange[0] - ox;
          const xMax = rig.head.xRange[1] - ox;
          const inX = smoothstep(xMin - 24, xMin + 12, x) * smoothstep(xMax + 24, xMax - 12, x);
          head *= inX;
        }
        const earL = ears.length ? gauss(x, y, ears[0].cx, ears[0].cy, ears[0].sx, ears[0].sy) : 0;
        const earR = ears.length ? gauss(x, y, ears[1].cx, ears[1].cy, ears[1].sx, ears[1].sy) : 0;
        const pawL = paws.length >= 1 ? gauss(x, y, paws[0].cx, paws[0].cy, paws[0].sx, paws[0].sy) : 0;
        const pawR = paws.length >= 2 ? gauss(x, y, paws[1].cx, paws[1].cy, paws[1].sx, paws[1].sy) : 0;
        const tailW = tail
          ? smoothstep(tail.x[0] - ox, tail.x[1] - ox, x) * smoothstep(tail.y[0] - oy, tail.y[1] - oy, y)
          : 0;
        const breathW = gauss(x, y, breathCx, breathCy, breath.sigma[0], breath.sigma[1])
          * smoothstep(breath.fade[0] - oy, breath.fade[1] - oy, y);

        // Lower-body alternating step weights for perspective walk/run gait (Mode A & Mode B)
        const lowerBody = smoothstep(H * 0.62, H * 0.86, y) * (1 - head) * (1 - tailW * 0.8);
        const midX = W * 0.48;
        const stepL = lowerBody * smoothstep(midX + 18, midX - 24, x);
        const stepR = lowerBody * smoothstep(midX - 18, midX + 24, x);

        wHead.push(head);
        wBreath.push(breathW);
        wTail.push(tailW);
        wEarL.push(earL * head);
        wEarR.push(earR * head);
        wPawL.push(pawL);
        wPawR.push(pawR);
        wStepL.push(stepL);
        wStepR.push(stepR);
      }
    }
    for (let j = 0; j < ROWS; j++) {
      for (let i = 0; i < COLS; i++) {
        const a = j * (COLS + 1) + i;
        const b = a + 1;
        const c = a + COLS + 1;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aHead', new THREE.Float32BufferAttribute(wHead, 1));
    geo.setAttribute('aBreath', new THREE.Float32BufferAttribute(wBreath, 1));
    geo.setAttribute('aTail', new THREE.Float32BufferAttribute(wTail, 1));
    geo.setAttribute('aEarL', new THREE.Float32BufferAttribute(wEarL, 1));
    geo.setAttribute('aEarR', new THREE.Float32BufferAttribute(wEarR, 1));
    geo.setAttribute('aPawL', new THREE.Float32BufferAttribute(wPawL, 1));
    geo.setAttribute('aPawR', new THREE.Float32BufferAttribute(wPawR, 1));
    geo.setAttribute('aStepL', new THREE.Float32BufferAttribute(wStepL, 1));
    geo.setAttribute('aStepR', new THREE.Float32BufferAttribute(wStepR, 1));
    geo.setIndex(idx);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      uniforms: {
        uTex: { value: tex },
        uTexClosed: { value: texClosed },
        uNeck: { value: neck },
        uBreathCx: { value: breathCx },
        uHeadShift: { value: new THREE.Vector2() },
        uHeadAngle: { value: 0 },
        uHeadSquash: { value: 0 },
        uBreath: { value: 0 },
        uTailSway: { value: 0 },
        uEarPivotL: { value: ears.length ? ears[0].pivot : neck.clone() },
        uEarPivotR: { value: ears.length ? ears[1].pivot : neck.clone() },
        uEarAngleL: { value: 0 },
        uEarAngleR: { value: 0 },
        uPawPivotL: { value: paws.length >= 1 ? paws[0].pivot : neck.clone() },
        uPawPivotR: { value: paws.length >= 2 ? paws[1].pivot : neck.clone() },
        uPawAngleL: { value: 0 },
        uPawAngleR: { value: 0 },
        uStepPhase: { value: 0 },
        uStepAmp: { value: 0 },
        uEyeLUv: { value: new THREE.Vector2((eyeL.cx - ox) / W, (eyeL.cy - oy) / H) },
        uEyeRUv: { value: new THREE.Vector2((eyeR.cx - ox) / W, (eyeR.cy - oy) / H) },
        uEyeLRad: { value: new THREE.Vector2(eyeL.rx * rig.eyeRadiusScale / W, eyeL.ry * rig.eyeRadiusScale / H) },
        uEyeRRad: { value: new THREE.Vector2(eyeR.rx * rig.eyeRadiusScale / W, eyeR.ry * rig.eyeRadiusScale / H) },
        uEyeOpen: { value: 1 },
        uGaze: { value: new THREE.Vector2() },
        uAlpha: { value: 1 },
      },
    });

    const mesh = new THREE.Mesh(geo, mat);
    cached = { mesh, mat, W, H, meta };
    this.poseCache.set(cacheKey, cached);
    return cached;
  }

  async preload(texUrl, meta, closedTexUrl) {
    return this._buildPose(texUrl, meta, closedTexUrl);
  }

  async load(texUrl, meta, closedTexUrl) {
    const cached = await this._buildPose(texUrl, meta, closedTexUrl);
    if (this.disposed) return cached.meta;

    if (this.mesh && this.mesh !== cached.mesh) {
      this.scene.remove(this.mesh);
    }
    this.mesh = cached.mesh;
    this.material = cached.mat;
    if (!this.mesh.parent) {
      this.scene.add(this.mesh);
    }
    this.size = new THREE.Vector2(cached.W, cached.H);
    this.setViewport(this.container.clientWidth || 140, this.container.clientHeight || 140);
    this.ready = true;
    return cached.meta;
  }

  setViewport(cssW, cssH) {
    this.renderer.setSize(cssW, cssH, true);
    const s = Math.min(cssW / this.size.x, cssH / this.size.y);
    this.camera.left = -cssW / 2;
    this.camera.right = cssW / 2;
    this.camera.top = cssH / 2;
    this.camera.bottom = -cssH / 2;
    this.camera.zoom = s;
    this.camera.position.set(this.size.x / 2, -this.size.y / 2, 5);
    this.camera.updateProjectionMatrix();
    this.viewScale = s;
  }

  setSleepy(flag, immediate = false) {
    this.sleepy = Boolean(flag);
    if (immediate) {
      this.sleepBlend = this.sleepy ? 1 : 0;
    }
  }

  react(kind) {
    if (kind === 'eating') this.nod = 1;
    else if (kind === 'happy') {
      this.pulse = 1;
      this.blinkTimer = Math.min(this.blinkTimer, 0.01);
    } else this.pulse = 1;
  }

  stepAndRender(dt) {
    if (!this.ready || !this.material) return;
    const t = this.t;
    const u = this.material.uniforms;
    const p = this.params;

    this.pulse = Math.max(0, (this.pulse || 0) - dt * 2.2);
    this.nod = Math.max(0, (this.nod || 0) - dt * 1.6);
    this.sleepBlend += ((this.sleepy ? 1 : 0) - this.sleepBlend) * Math.min(1, dt * 3.5);
    const sb = this.sleepBlend;
    const awake = 1 - sb;

    // Locomotion stepping phase & amplitude
    this.stepAmp += (this.stepAmpTarget - this.stepAmp) * (dt === 0 ? 1 : Math.min(1, dt * 10));
    if (this.stepAmp > 0.01) {
      this.stepPhase = (this.stepPhase + dt * this.stepSpeed) % (Math.PI * 2);
    }
    u.uStepPhase.value = this.stepPhase;
    u.uStepAmp.value = this.stepAmp;

    this.blinkTimer -= dt;
    let blinkTarget = 0;
    if (this.blinkTimer <= 0) {
      blinkTarget = 1;
      if (this.blinkTimer < -0.14) this.blinkTimer = 2.2 + Math.random() * 4.5;
    }
    this.blink += (blinkTarget - this.blink) * Math.min(1, dt * 26);

    // Integrate breath & tail phases incrementally by dt so changing frequency
    // during sleepBlend transitions never rewinds phase (t / period) and causes jelly vibration.
    const breathPeriod = 3.2 + sb * 2.0;
    this.breathPhase = ((this.breathPhase || 0) + dt / breathPeriod) % 1;
    const phase = this.breathPhase;
    const breath = phase < 0.35
      ? smoothstep(0, 1, phase / 0.35)
      : 1 - smoothstep(0, 1, (phase - 0.35) / 0.65);

    this.tailPhase = (this.tailPhase || 0) + dt * (1.15 - sb * 0.5 + this.stepAmp * 2.4);
    const sway = Math.sin(t * 0.53) * (1 - sb * 0.75);
    const runHeadBob = Math.sin(this.stepPhase * 2) * 0.45 * this.stepAmp;
    const headBob = Math.sin(t * 0.8 + 0.6) * awake + Math.sin(t * 0.6) * 0.35 * sb + runHeadBob;
    const flickL = (Math.sin(t * 0.9) * 0.5 + 0.5 > 0.985 ? Math.sin(t * 34) * 0.16 : 0) * awake;
    const flickR = (Math.sin(t * 0.7 + 2.1) * 0.5 + 0.5 > 0.985 ? Math.sin(t * 31 + 1) * 0.16 : 0) * awake;

    const deg = Math.PI / 180;
    const angleZ = (p.angleZ + sway * 0.25 + sb * 0.22 + this.pulse * 0.6 + Math.sin(this.stepPhase) * 0.35 * this.stepAmp) * 7 * deg;
    const angleX = p.angleX + sway * 0.25;
    const angleY = p.angleY + headBob * 0.5 + sb * 0.75 + this.nod * 1.5;

    if (dt === 0) {
      u.uHeadAngle.value = angleZ;
    } else {
      u.uHeadAngle.value += (angleZ - u.uHeadAngle.value) * Math.min(1, dt * 9);
    }
    u.uHeadShift.value.set(angleX * 14, -angleY * 9 + (breath - 0.5) * 3);
    u.uHeadSquash.value = Math.abs(angleX) * 0.03;
    u.uBreath.value = breath * (1 + this.pulse * 0.3 + this.stepAmp * 0.25);
    u.uTailSway.value = Math.sin(this.tailPhase) * (0.55 - sb * 0.42 + this.stepAmp * 0.35) + this.pulse * 0.5;
    u.uEarAngleL.value = (p.earL + sb * 0.42 + flickL) * 0.55;
    u.uEarAngleR.value = -(p.earR + sb * 0.42 + flickR) * 0.55;

    // Front paws: playful curled-fist knead in side-lying, gentle stretch in belly-up,
    // or active alternating stride swing when running/trotting
    const pawIdleAmp = (0.075 - sb * 0.045) + this.pulse * 0.14;
    const pawRunSwing = Math.sin(this.stepPhase) * 0.22 * this.stepAmp;
    u.uPawAngleL.value = Math.sin(this.tailPhase * 1.25 + 0.4) * pawIdleAmp * (1 - this.stepAmp) + pawRunSwing;
    u.uPawAngleR.value = -Math.sin(this.tailPhase * 1.1 + 1.5) * pawIdleAmp * (1 - this.stepAmp) - pawRunSwing;

    // Autonomous gaze cycling: look at camera (0,0) <-> look away elsewhere <-> drowsy eye-close
    this.gazeTimer -= dt;
    if (this.gazeTimer <= 0) {
      const r = Math.random();
      if (r < 0.44 || this.stepAmp > 0.2) {
        // Look straight at the viewer / camera (always alert while running)
        this.autoGazeTargetX = 0;
        this.autoGazeTargetY = 0;
        this.autoDrowsyTarget = 0;
        this.gazeTimer = 2.6 + Math.random() * 2.8;
      } else if (r < 0.80) {
        // Glance away to the side / elsewhere (moderate range so eyes stay natural)
        const dirX = Math.random() < 0.5 ? -1 : 1;
        this.autoGazeTargetX = dirX * (0.55 + Math.random() * 0.35);
        this.autoGazeTargetY = (Math.random() - 0.5) * 0.55;
        this.autoDrowsyTarget = 0;
        this.gazeTimer = 2.2 + Math.random() * 2.6;
      } else {
        // Cozy brief eye-close / squinting rest
        this.autoDrowsyTarget = 1;
        this.gazeTimer = 1.6 + Math.random() * 1.8;
      }
    }
    const mouseActive = (performance.now() - this.lastMouseAt) < 2200;
    const targetGX = mouseActive ? this.mouseGazeX : this.autoGazeTargetX;
    const targetGY = mouseActive ? this.mouseGazeY : this.autoGazeTargetY;
    const targetDrowsy = (mouseActive || this.stepAmp > 0.1) ? 0 : this.autoDrowsyTarget;
    const gazeLerp = dt === 0 ? 1 : Math.min(1, dt * 5.5);
    this.autoGazeX += (targetGX - this.autoGazeX) * gazeLerp;
    this.autoGazeY += (targetGY - this.autoGazeY) * gazeLerp;
    this.autoDrowsy += (targetDrowsy - this.autoDrowsy) * (dt === 0 ? 1 : Math.min(1, dt * 4.5));

    u.uEyeOpen.value = Math.min(p.eyeOpen, 1 - Math.max(this.blink, sb * (1 - this.stepAmp), this.autoDrowsy));
    const gx = Math.max(-0.95, Math.min(0.95, (p.gazeX || 0) + this.autoGazeX + angleX * 0.55));
    const gy = Math.max(-0.85, Math.min(0.85, (p.gazeY || 0) + this.autoGazeY - angleY * 0.45));
    u.uGaze.value.set(gx, gy);
    u.uAlpha.value = p.alpha;

    this.renderer.render(this.scene, this.camera);
  }

  animate(now) {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);
    const dt = Math.min(0.05, (now - this.clock) / 1000);
    if (now - (this.lastFrame || 0) < 30) return; // 30 fps is plenty and saves GPU on an always-on-top window
    this.lastFrame = now;
    this.clock = now;
    this.t += dt;
    if (!this.ready) return;
    this.stepAndRender(dt);
  }

  dispose() {
    this.disposed = true;
    window.removeEventListener('mousemove', this.onMouseMove);
    for (const entry of this.poseCache.values()) {
      entry.mesh?.geometry?.dispose();
      entry.mat?.uniforms?.uTex?.value?.dispose();
      entry.mat?.uniforms?.uTexClosed?.value?.dispose();
      entry.mat?.dispose();
    }
    this.poseCache.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
