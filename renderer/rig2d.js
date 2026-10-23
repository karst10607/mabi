// Live2D-style 2D pet rig: one texture, one deformable mesh.
// Weights are baked per-vertex on the CPU; the vertex shader moves the head,
// ears, tail and chest, the fragment shader swaps in a closed-eye texture.
import * as THREE from 'three';

const COLS = 72;
const ROWS = 148;

const VERT = /* glsl */ `
attribute float aHead;
attribute float aBreath;
attribute float aTail;
attribute float aEarL;
attribute float aEarR;

uniform vec2  uNeck;
uniform vec2  uHeadShift;
uniform float uHeadAngle;
uniform float uHeadSquash;
uniform float uBreath;
uniform float uTailSway;
uniform vec2  uEarPivotL;
uniform vec2  uEarPivotR;
uniform float uEarAngleL;
uniform float uEarAngleR;

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

  // ribcage: lift and widen around the chest only. The weight fades out by the
  // elbows so the forelegs and paws stay planted instead of the whole cat
  // stretching up and down like slime.
  float chest = aBreath * uBreath;
  p.y += chest * 9.0;
  p.x += (p.x - uNeck.x) * chest * 0.055;

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
  float m = 1.0 - smoothstep(0.6, 1.0, length(d));
  return uv + uGaze * 0.007 * m;
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
    this.params = {
      angleX: 0, angleY: 0, angleZ: 0, breath: 0, eyeOpen: 1,
      earL: 0, earR: 0, tail: 0, alpha: 1,
    };
    this.t = 0;
    this.clock = performance.now();
    this.blink = 0;
    this.blinkTimer = 2 + Math.random() * 3;
    this.sleepy = false;
    this.sleepBlend = 0;

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

  async load(texUrl, meta, closedTexUrl) {
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

    // rig landmarks are authored in the original matte image; weights live in
    // texture space, pivots in world space (y up)
    const texPoint = ([x, y]) => [x - ox, y - oy];
    const worldPoint = ([x, y]) => new THREE.Vector2(x - ox, -(y - oy));
    const ears = (rig.ears || []).map((e) => {
      const [cx, cy] = texPoint(e.center);
      return { cx, cy, sx: e.sigma[0], sy: e.sigma[1], pivot: worldPoint(e.pivot) };
    });
    if (ears.length !== 0 && ears.length !== 2) throw new Error('rig.ears must list 0 or 2 ears');
    const breath = rig.breath;
    const [breathCx, breathCy] = texPoint(breath.center);
    const tail = rig.tail || null;

    // grid in texture-pixel space with y flipped into world space (y up)
    const pos = [], uv = [], idx = [];
    const wHead = [], wBreath = [], wTail = [], wEarL = [], wEarR = [];

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
        const earL = ears.length ? gauss(x, y, ears[0].cx, ears[0].cy, ears[0].sx, ears[0].sy) : 0;
        const earR = ears.length ? gauss(x, y, ears[1].cx, ears[1].cy, ears[1].sx, ears[1].sy) : 0;
        const tailW = tail
          ? smoothstep(tail.x[0] - ox, tail.x[1] - ox, x) * smoothstep(tail.y[0] - oy, tail.y[1] - oy, y)
          : 0;
        const breathW = gauss(x, y, breathCx, breathCy, breath.sigma[0], breath.sigma[1])
          * smoothstep(breath.fade[0] - oy, breath.fade[1] - oy, y);
        wHead.push(head);
        wBreath.push(breathW);
        wTail.push(tailW);
        wEarL.push(earL * head);
        wEarR.push(earR * head);
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
    geo.setIndex(idx);

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      uniforms: {
        uTex: { value: tex },
        uTexClosed: { value: texClosed },
        uNeck: { value: neck },
        uHeadShift: { value: new THREE.Vector2() },
        uHeadAngle: { value: 0 },
        uHeadSquash: { value: 0 },
        uBreath: { value: 0 },
        uTailSway: { value: 0 },
        uEarPivotL: { value: ears.length ? ears[0].pivot : neck.clone() },
        uEarPivotR: { value: ears.length ? ears[1].pivot : neck.clone() },
        uEarAngleL: { value: 0 },
        uEarAngleR: { value: 0 },
        uEyeLUv: { value: new THREE.Vector2((eyeL.cx - ox) / W, (eyeL.cy - oy) / H) },
        uEyeRUv: { value: new THREE.Vector2((eyeR.cx - ox) / W, (eyeR.cy - oy) / H) },
        uEyeLRad: { value: new THREE.Vector2(eyeL.rx * rig.eyeRadiusScale / W, eyeL.ry * rig.eyeRadiusScale / H) },
        uEyeRRad: { value: new THREE.Vector2(eyeR.rx * rig.eyeRadiusScale / W, eyeR.ry * rig.eyeRadiusScale / H) },
        uEyeOpen: { value: 1 },
        uGaze: { value: new THREE.Vector2() },
        uAlpha: { value: 1 },
      },
    });

    this.mesh = new THREE.Mesh(geo, mat);
    if (this.oldMesh) {
      this.scene.remove(this.oldMesh);
      this.oldMesh.geometry?.dispose();
      this.oldMaterial?.uniforms?.uTex?.value?.dispose();
      this.oldMaterial?.uniforms?.uTexClosed?.value?.dispose();
      this.oldMaterial?.dispose();
    }
    this.oldMesh = this.mesh;
    this.oldMaterial = mat;
    this.material = mat;
    this.scene.add(this.mesh);
    this.size = new THREE.Vector2(W, H);
    this.setViewport(this.container.clientWidth || 140, this.container.clientHeight || 140);
    this.ready = true;
    return meta;
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

  setSleepy(flag) {
    this.sleepy = Boolean(flag);
  }

  react(kind) {
    if (kind === 'eating') this.nod = 1;
    else if (kind === 'happy') {
      this.pulse = 1;
      this.blinkTimer = Math.min(this.blinkTimer, 0.01);
    } else this.pulse = 1;
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

    const t = this.t;
    const u = this.material.uniforms;
    const p = this.params;

    this.pulse = Math.max(0, (this.pulse || 0) - dt * 2.2);
    this.nod = Math.max(0, (this.nod || 0) - dt * 1.6);
    this.sleepBlend += ((this.sleepy ? 1 : 0) - this.sleepBlend) * Math.min(1, dt * 3.5);
    const sb = this.sleepBlend;
    const awake = 1 - sb;

    this.blinkTimer -= dt;
    let blinkTarget = 0;
    if (this.blinkTimer <= 0) {
      blinkTarget = 1;
      if (this.blinkTimer < -0.14) this.blinkTimer = 2.2 + Math.random() * 4.5;
    }
    this.blink += (blinkTarget - this.blink) * Math.min(1, dt * 26);

    // asymmetric breath: quick inhale, longer exhale (~20 bpm awake, slower when dozing)
    const breathPeriod = 3.2 + sb * 2.0;
    const phase = (t % breathPeriod) / breathPeriod;
    const breath = phase < 0.35
      ? smoothstep(0, 1, phase / 0.35)
      : 1 - smoothstep(0, 1, (phase - 0.35) / 0.65);
    const sway = Math.sin(t * 0.53) * (1 - sb * 0.75);
    const headBob = Math.sin(t * 0.8 + 0.6) * awake + Math.sin(t * 0.6) * 0.35 * sb;
    const flickL = (Math.sin(t * 0.9) * 0.5 + 0.5 > 0.985 ? Math.sin(t * 34) * 0.16 : 0) * awake;
    const flickR = (Math.sin(t * 0.7 + 2.1) * 0.5 + 0.5 > 0.985 ? Math.sin(t * 31 + 1) * 0.16 : 0) * awake;

    const deg = Math.PI / 180;
    const angleZ = (p.angleZ + sway * 0.25 + sb * 0.22 + this.pulse * 0.6) * 7 * deg;
    const angleX = p.angleX + sway * 0.25;
    const angleY = p.angleY + headBob * 0.5 + sb * 0.75 + this.nod * 1.5;

    u.uHeadAngle.value += (angleZ - u.uHeadAngle.value) * Math.min(1, dt * 9);
    u.uHeadShift.value.set(angleX * 14, -angleY * 9 + (breath - 0.5) * 3);
    u.uHeadSquash.value = Math.abs(angleX) * 0.03;
    u.uBreath.value = breath * (1 + this.pulse * 0.3);
    u.uTailSway.value = Math.sin(t * (1.15 - sb * 0.5)) * (0.55 - sb * 0.42) + this.pulse * 0.5;
    u.uEarAngleL.value = (p.earL + sb * 0.42 + flickL) * 0.55;
    u.uEarAngleR.value = -(p.earR + sb * 0.42 + flickR) * 0.55;
    u.uEyeOpen.value = Math.min(p.eyeOpen, 1 - Math.max(this.blink, sb));
    u.uGaze.value.set((p.gazeX || 0) + angleX * 0.9, (p.gazeY || 0) - angleY * 0.9);
    u.uAlpha.value = p.alpha;

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
