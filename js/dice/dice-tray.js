// Loads three.js + cannon-es from CDN only when a dice tray actually mounts.
const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/+esm";
const CANNON_URL = "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/+esm";

const DIE_COLORS = {
  4: 0xc24b4b, 6: 0xc69a3e, 8: 0x56b8a5, 10: 0x8a6bc2, 12: 0x4b8bc2, 20: 0xe0b95c, 100: 0x8a6bc2
};

let THREE = null, CANNON = null, libsPromise = null;
function loadLibs() {
  if (!libsPromise) {
    libsPromise = Promise.all([import(THREE_URL), import(CANNON_URL)]).then(([t, c]) => {
      THREE = t; CANNON = c;
    });
  }
  return libsPromise;
}

// Deterministic PRNG so the same seed produces the same-looking tumble on every client.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGeometry(sides) {
  switch (sides) {
    case 4: return new THREE.TetrahedronGeometry(0.62);
    case 6: return new THREE.BoxGeometry(0.85, 0.85, 0.85);
    case 8: return new THREE.OctahedronGeometry(0.62);
    case 10:
    case 100: return new THREE.CylinderGeometry(0.02, 0.6, 0.75, 5, 1); // pentagonal bipyramid-ish stand-in
    case 12: return new THREE.DodecahedronGeometry(0.55);
    case 20: return new THREE.IcosahedronGeometry(0.62);
    default: return new THREE.IcosahedronGeometry(0.62);
  }
}

export class DiceTray {
  constructor(container) {
    this.container = container;
    this.dice = []; // { mesh, body }
    this.ready = false;
    this._raf = null;
  }

  async init() {
    await loadLibs();
    const { clientWidth: w, clientHeight: h } = this.container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, w / h, 0.1, 100);
    this.camera.position.set(0, 6.4, 5.6);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0x8899aa, 0.9));
    const key = new THREE.PointLight(0xfff2d0, 1.4, 30);
    key.position.set(3, 6, 3);
    this.scene.add(key);
    const rim = new THREE.PointLight(0x3f8f80, 0.8, 30);
    rim.position.set(-4, 3, -3);
    this.scene.add(rim);

    // Tray floor (visual only)
    const floorGeo = new THREE.CircleGeometry(3.4, 48);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x0e1512, roughness: 0.9 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    // Physics world
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, -28, 0) });
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    this.diceMaterial = new CANNON.Material("dice");
    this.floorMaterial = new CANNON.Material("floor");
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.diceMaterial, this.floorMaterial, { friction: 0.5, restitution: 0.35 }));
    this.world.addContactMaterial(new CANNON.ContactMaterial(this.diceMaterial, this.diceMaterial, { friction: 0.3, restitution: 0.4 }));

    const groundBody = new CANNON.Body({ mass: 0, material: this.floorMaterial });
    groundBody.addShape(new CANNON.Plane());
    groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    this.world.addBody(groundBody);

    // Invisible tray walls so dice don't fly off
    const wallDefs = [
      { pos: [3.3, 1, 0], rot: [0, -Math.PI / 2, 0] },
      { pos: [-3.3, 1, 0], rot: [0, Math.PI / 2, 0] },
      { pos: [0, 1, 3.3], rot: [0, Math.PI, 0] },
      { pos: [0, 1, -3.3], rot: [0, 0, 0] }
    ];
    wallDefs.forEach(({ pos, rot }) => {
      const body = new CANNON.Body({ mass: 0, material: this.floorMaterial });
      body.addShape(new CANNON.Plane());
      body.position.set(...pos);
      body.quaternion.setFromEuler(...rot);
      this.world.addBody(body);
    });

    this.ready = true;
    this._loop();

    this._resizeObserver = new ResizeObserver(() => this._onResize());
    this._resizeObserver.observe(this.container);
  }

  _onResize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  clear() {
    this.dice.forEach(({ mesh, body }) => {
      this.scene.remove(mesh);
      this.world.removeBody(body);
    });
    this.dice = [];
  }

  // diceList: [{ sides, count }], seed: integer shared across clients
  async roll(diceList, seed) {
    if (!this.ready) await this.init();
    this.clear();
    const rand = mulberry32(seed || Date.now());

    const flat = [];
    diceList.forEach(d => { for (let i = 0; i < d.count; i++) flat.push(d.sides); });

    flat.forEach((sides, i) => {
      const geo = makeGeometry(sides);
      const color = DIE_COLORS[sides] || 0xc69a3e;
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0.35, emissive: color, emissiveIntensity: 0.08 });
      const mesh = new THREE.Mesh(geo, mat);
      this.scene.add(mesh);

      const shape = sides === 6
        ? new CANNON.Box(new CANNON.Vec3(0.42, 0.42, 0.42))
        : new CANNON.Sphere(0.55);
      const body = new CANNON.Body({ mass: 1, material: this.diceMaterial, shape });

      const angle = (i / flat.length) * Math.PI * 2;
      const spread = Math.min(flat.length * 0.35, 2.2);
      body.position.set(Math.cos(angle) * spread * (0.3 + rand() * 0.5), 3.5 + rand() * 1.5 + i * 0.4, Math.sin(angle) * spread * (0.3 + rand() * 0.5));
      body.velocity.set((rand() - 0.5) * 6, -2, (rand() - 0.5) * 6);
      body.angularVelocity.set((rand() - 0.5) * 18, (rand() - 0.5) * 18, (rand() - 0.5) * 18);
      body.linearDamping = 0.35;
      body.angularDamping = 0.4;

      this.world.addBody(body);
      this.dice.push({ mesh, body });
    });

    return new Promise((resolve) => setTimeout(resolve, 1500 + flat.length * 60));
  }

  _loop() {
    this._raf = requestAnimationFrame(() => this._loop());
    if (!this.world) return;
    this.world.fixedStep(1 / 60);
    this.dice.forEach(({ mesh, body }) => {
      mesh.position.copy(body.position);
      mesh.quaternion.copy(body.quaternion);
    });
    this.renderer?.render(this.scene, this.camera);
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._resizeObserver?.disconnect();
    this.clear();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
  }
}
