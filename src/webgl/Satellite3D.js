/**
 * Satellite close-up in its local orbital frame (LVLH): +Y = up (away from Earth),
 * +X = direction of flight. The real Earth fills the bottom of the view at the correct
 * angular size for the current altitude, rotated so the ground under the satellite is
 * what it is actually flying over. The Sun lights the model from its true direction,
 * and goes dark in eclipse.
 *
 * Load any real model (.glb / .gltf) by dropping it on the view — it replaces the
 * procedural CubeSat and follows the same attitude.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildCubeSat } from './CubeSatModel.js';
import { createEarth, createStars } from './earth.js';
import { RE_KM } from '../sim/geometry.js';

const EARTH_R = 4000; // scene units; the satellite is ~15 units across

export class Satellite3D {
    constructor(container, { onPick } = {}) {
        this.container = container;
        this.onPick = onPick;
        this.state = null;
        this.options = { thermal: false, xray: false, vectors: true };
        try {
            this.renderer = new THREE.WebGLRenderer({ antialias: true });
        } catch {
            container.innerHTML = '<p class="webgl-fallback">The 3D view needs WebGL, which this browser has turned off.</p>';
            this.failed = true;
            return;
        }
        const r = this.renderer;
        r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.0;
        r.domElement.className = 'gl-canvas';
        container.appendChild(r.domElement);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x02040a);
        const pmrem = new THREE.PMREMGenerator(r);
        this.envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
        pmrem.dispose();
        this.scene.environment = this.envTex;
        this.scene.environmentIntensity = 0.35;

        this.camera = new THREE.PerspectiveCamera(40, 1, 1, 60000);
        this.camera.position.set(48, 26, 58);
        this.controls = new OrbitControls(this.camera, r.domElement);
        Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.07, enablePan: false, minDistance: 18, maxDistance: 160 });

        this.scene.add(createStars(2000, 30000));
        this.earth = createEarth(EARTH_R, 160, { lightsBias: 1.6, lightsGain: 1.25 });
        this.earthHolder = new THREE.Group();
        this.earthHolder.add(this.earth.group);
        this.scene.add(this.earthHolder, this.earth.atmosphere);

        this.sun = new THREE.DirectionalLight(0xfff4e0, 3.2);
        this.earthshine = new THREE.HemisphereLight(0x0b1020, 0x2f5f9f, 0.55);
        this.scene.add(this.sun, this.sun.target, this.earthshine);

        this.model = buildCubeSat();
        this.body = new THREE.Group();
        this.body.add(this.model.group);
        this.scene.add(this.body);

        const arrow = (hex) => new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 22, hex, 2.2, 1.2);
        this.arrows = { sun: arrow(0xffd98a), nadir: arrow(0x4a8fe7), velocity: arrow(0x5cc8e0) };
        Object.values(this.arrows).forEach(a => this.scene.add(a));

        // picking
        this.ray = new THREE.Raycaster();
        this.pointer = new THREE.Vector2();
        this._down = null;
        r.domElement.addEventListener('pointerdown', this._onDown);
        r.domElement.addEventListener('pointerup', this._onUp);
        r.domElement.addEventListener('pointermove', this._onMove);

        // drag-and-drop glTF
        container.addEventListener('dragover', this._onDragOver);
        container.addEventListener('drop', this._onDrop);

        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(container);
        this.resize();
        this._raf = requestAnimationFrame(this._animate);
    }

    setOption(key, on, colors) {
        this.options[key] = on;
        if (key === 'thermal') this.model.setThermal(on, colors);
        if (key === 'xray') this.model.setXray(on, colors);
        if (key === 'vectors') Object.values(this.arrows).forEach(a => { a.visible = on; });
    }

    update(state, thermalColors) {
        this.state = state;
        this._colors = thermalColors;
        if (this.options.thermal) this.model.refresh(thermalColors);
        this.model.setWingEfficiency('A', state.sections.solarPanelA.efficiency);
        this.model.setWingEfficiency('B', state.sections.solarPanelB.efficiency);
    }

    /** ECI vector → LVLH scene vector (X along-track, Y radial, Z = −orbit normal). */
    _lvlh(v) {
        const g = this.state.geometry;
        const d = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        return new THREE.Vector3(d(v, g.vHat), d(v, g.rHat), -d(v, g.hHat));
    }

    _animate = () => {
        this._raf = requestAnimationFrame(this._animate);
        const st = this.state;
        if (st) {
            const g = st.geometry;
            // Attitude
            const X = this._lvlh(st.attitude.panelNormal).normalize();
            let Z = this._lvlh(st.attitude.thrustAxis);
            Z.sub(X.clone().multiplyScalar(Z.dot(X))).normalize();
            if (Z.lengthSq() < 0.5) Z = new THREE.Vector3(1, 0, 0);
            const Y = new THREE.Vector3().crossVectors(Z, X);
            const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
            this.body.quaternion.slerp(q, 0.15);

            // Sun and eclipse
            const sunDir = this._lvlh(g.sun).normalize();
            this.sun.position.copy(sunDir).multiplyScalar(200);
            const lit = st.environment.inSunlight ? 1 : 0;
            this.sun.intensity += (3.2 * lit - this.sun.intensity) * 0.1;
            this.earth.setSun(sunDir);
            this.model.setPlume(st.sections.thrusterPod.isThrusting, performance.now() / 1000);

            // Earth below: scene = M_lvlh · S⁻¹ · R_y(gmst) · local
            const aScene = EARTH_R * (RE_KM + st.orbit.baseAltitude) / RE_KM;
            const M = new THREE.Matrix4().set(
                g.vHat[0], g.vHat[1], g.vHat[2], 0,
                g.rHat[0], g.rHat[1], g.rHat[2], 0,
                -g.hHat[0], -g.hHat[1], -g.hHat[2], 0,
                0, 0, 0, 1);
            const Sinv = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1); // scene → ECI
            const Ry = new THREE.Matrix4().makeRotationY(g.gmst);
            this.earthHolder.matrixAutoUpdate = false;
            this.earthHolder.matrix.copy(new THREE.Matrix4().makeTranslation(0, -aScene, 0).multiply(M).multiply(Sinv).multiply(Ry));
            this.earthHolder.matrixWorldNeedsUpdate = true;
            this.earth.atmosphere.position.set(0, -aScene, 0);

            // Reference vectors
            this.arrows.sun.setDirection(sunDir);
            this.arrows.nadir.setDirection(new THREE.Vector3(0, -1, 0));
            this.arrows.velocity.setDirection(new THREE.Vector3(1, 0, 0));
        }
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    };

    _pick(e) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
        this.ray.setFromCamera(this.pointer, this.camera);
        const targets = this.custom ? [this.custom] : this.model.pickables.filter(m => m.visible);
        const hit = this.ray.intersectObjects(targets, true).find(h => !this.options.xray || (h.object.material?.opacity ?? 1) > 0.5); // in x-ray, click through the see-through shell
        return hit?.object.userData.section || null;
    }
    _onDown = (e) => { this._down = [e.clientX, e.clientY]; };
    _onUp = (e) => {
        if (!this._down || Math.hypot(e.clientX - this._down[0], e.clientY - this._down[1]) > 5) return;
        const sec = this._pick(e);
        if (sec && this.onPick) this.onPick(sec);
    };
    _onMove = (e) => { this.renderer.domElement.style.cursor = this._pick(e) ? 'pointer' : 'grab'; };
    _onDragOver = (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; };
    _onDrop = (e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) this.loadModelFile(f);
    };

    /** Replace the procedural model with a user glTF/GLB. Resolves to a status message. */
    async loadModelFile(file) {
        if (!/\.(glb|gltf)$/i.test(file.name)) throw new Error('Choose a .glb or .gltf file.');
        const url = URL.createObjectURL(file);
        try {
            const gltf = await new GLTFLoader().loadAsync(url);
            const obj = gltf.scene;
            const box = new THREE.Box3().setFromObject(obj);
            const size = box.getSize(new THREE.Vector3()).length() || 1;
            obj.scale.setScalar(22 / size);
            obj.position.sub(box.getCenter(new THREE.Vector3()).multiplyScalar(22 / size));
            obj.traverse(o => { o.userData.section = 'thermalRadiator'; });
            if (this.custom) this.body.remove(this.custom);
            this.custom = obj;
            this.model.group.visible = false;
            this.body.add(obj);
            return `Loaded ${file.name}`;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    resetModel() {
        if (this.custom) { this.body.remove(this.custom); this.custom = null; }
        this.model.group.visible = true;
    }

    resize() {
        const w = this.container.clientWidth, h = this.container.clientHeight;
        if (!w || !h) return;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h, false);
    }

    destroy() {
        if (this.failed) return;
        cancelAnimationFrame(this._raf);
        this._ro.disconnect();
        const c = this.renderer.domElement;
        c.removeEventListener('pointerdown', this._onDown);
        c.removeEventListener('pointerup', this._onUp);
        c.removeEventListener('pointermove', this._onMove);
        this.container.removeEventListener('dragover', this._onDragOver);
        this.container.removeEventListener('drop', this._onDrop);
        this.controls.dispose();
        this.model.dispose();
        this.earth.dispose();
        this.envTex.dispose();
        Object.values(this.arrows).forEach(a => a.dispose?.());
        this.renderer.dispose();
        c.remove();
    }
}
