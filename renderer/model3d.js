import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const VIEW = 140;

class PetModel3DImpl {
  constructor(container) {
    this.container = container;
    this.disposed = false;
    this.impulse = 0;
    this.nod = 0;
    this.clock = performance.now();

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: false });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.setSize(VIEW, VIEW, false);
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;
    container.appendChild(renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.camera.position.set(0, 0.35, 4.4);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.HemisphereLight(0xfff6ea, 0x6b5c4b, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(2.5, 3.5, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x99bbff, 1.1);
    rim.position.set(-3, 1.5, -2.5);
    this.scene.add(rim);

    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);

    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);
  }

  async load(url) {
    const gltf = await new Promise((resolve, reject) => {
      new GLTFLoader().load(url, resolve, undefined, reject);
    });

    const model = gltf.scene;

    const box = new THREE.Box3().setFromObject(model);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const s = 2.0 / maxDim;
    model.scale.setScalar(s);
    model.position.copy(center).multiplyScalar(-s);

    // The pivot yaws, so the silhouette width alternates between X and Z.
    const halfFov = Math.tan((this.camera.fov * Math.PI / 180) / 2);
    const needY = size.y * s / 2;
    const needX = Math.max(size.x, size.z) * s / 2;
    const dist = Math.max(needY / halfFov, needX / (halfFov * this.camera.aspect)) * 1.34;
    this.camera.position.set(0, dist * 0.06, dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();

    // The source photo caught the cat from behind, so the mesh's "front" is 270°
    // around Y. Rotate in a wrapper: spinning `model` itself would orbit it about
    // its geometry origin instead of the centred bbox.
    const orient = new THREE.Group();
    orient.rotation.y = -Math.PI / 2;
    orient.add(model);
    this.pivot.add(orient);
    this.model = model;
    this.ready = true;
    return model;
  }

  // Squash-and-stretch kick for pats, nod for feeding.
  react(kind) {
    if (kind === 'eating') this.nod = 1;
    else this.impulse = 1;
  }

  animate(now) {
    if (this.disposed) return;
    requestAnimationFrame(this.animate);

    const dt = Math.min(0.05, (now - this.clock) / 1000);
    this.clock = now;
    this.t = (this.t || 0) + dt;

    if (this.ready) {
      const breath = Math.sin(this.t * 1.9) * 0.022;
      const sway = Math.sin(this.t * 0.55);

      this.impulse = Math.max(0, this.impulse - dt * 2.6);
      this.nod = Math.max(0, this.nod - dt * 1.8);

      const kick = Math.sin(this.impulse * Math.PI * 3) * this.impulse * 0.13;

      this.pivot.position.y = breath * 8 + kick * 2.2;
      this.pivot.rotation.y = sway * 0.34 + this.impulse * Math.PI * 0.9;
      this.pivot.rotation.x = Math.sin(this.nod * Math.PI * 2) * this.nod * 0.3;
      this.pivot.scale.set(1 + kick * 0.5, 1 + breath + kick, 1 + kick * 0.5);
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

window.PetModel3D = PetModel3DImpl;
