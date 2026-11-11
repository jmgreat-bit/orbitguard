/**
 * Overview hero: the real Earth (rotating at sidereal rate, lit by the real Sun for the
 * simulated date), the satellite's orbit, ground stations, and debris on their
 * relative tracks as closest approach nears. 1 scene unit = 1 Earth radius.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createEarth, createStars, glowTexture, toScene } from './earth.js';
import { buildCubeSat } from './CubeSatModel.js';
import { orbitStateECI, stationEcef, RE_KM } from '../sim/geometry.js';
import { GROUND_STATIONS } from '../satellite.js';

export class OrbitScene {
    constructor(container) {
        this.container = container;
        this.state = null;
        this.follow = false;
        this._disposables = [];
        try {
            this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        } catch {
            container.innerHTML = '<p class="webgl-fallback">The 3D view needs WebGL, which this browser has turned off.</p>';
            this.failed = true;
            return;
        }
        const r = this.renderer;
        r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        r.toneMapping = THREE.ACESFilmicToneMapping;
        r.toneMappingExposure = 1.05;
        container.appendChild(r.domElement);
        r.domElement.className = 'gl-canvas';

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x03060c);
        this.camera = new THREE.PerspectiveCamera(38, 1, 0.005, 2000);
        this.camera.position.set(2.2, 1.3, 2.6);
        this.controls = new OrbitControls(this.camera, r.domElement);
        Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.06, enablePan: false, minDistance: 1.15, maxDistance: 9, rotateSpeed: 0.6 });

        this.scene.add(createStars());
        this.earth = createEarth(1, 128);
        this.scene.add(this.earth.group, this.earth.atmosphere);
        this.sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
        this.scene.add(this.sunLight, new THREE.AmbientLight(0x223044, 0.35));

        // Sun disc far away
        const sunTex = glowTexture('255,236,190');
        this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, color: 0xffffff, depthWrite: false, blending: THREE.AdditiveBlending }));
        this.sunSprite.scale.setScalar(60);
        this.scene.add(this.sunSprite);

        // Orbit path
        this.orbitGeom = new THREE.BufferGeometry();
        this.orbitGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(361 * 3), 3));
        this.orbitLine = new THREE.Line(this.orbitGeom, new THREE.LineBasicMaterial({ color: 0x5cc8e0, transparent: true, opacity: 0.55 }));
        this.scene.add(this.orbitLine);

        // Satellite: glow marker plus a (hugely enlarged) model so it reads at this scale
        this.sat = new THREE.Group();
        this.marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('120,215,240'), depthWrite: false, blending: THREE.AdditiveBlending }));
        this.marker.scale.setScalar(0.09);
        this.model = buildCubeSat();
        this.model.group.scale.setScalar(0.0012);
        this.sat.add(this.marker, this.model.group);
        this.scene.add(this.sat);

        // Ground stations (children of the rotating Earth) and the live link line
        this.stations = GROUND_STATIONS.map(gs => {
            const p = toScene(stationEcef(gs.lat, gs.lon, 0), 1.002 / RE_KM);
            const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), new THREE.MeshBasicMaterial({ color: 0x3fbf7f }));
            dot.position.copy(p);
            const ring = new THREE.Mesh(new THREE.RingGeometry(0.014, 0.018, 32), new THREE.MeshBasicMaterial({ color: 0x3fbf7f, transparent: true, opacity: 0.7, side: THREE.DoubleSide }));
            ring.position.copy(p);
            ring.lookAt(p.clone().multiplyScalar(2));
            this.earth.group.add(dot, ring);
            return { gs, dot, ring };
        });
        this.linkGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
        this.link = new THREE.Line(this.linkGeom, new THREE.LineBasicMaterial({ color: 0x3fbf7f, transparent: true, opacity: 0.85 }));
        this.scene.add(this.link);

        // Debris tracks (pool of 4)
        this.debris = Array.from({ length: 4 }, () => {
            const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
            const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xf0544f, dashSize: 0.02, gapSize: 0.015, transparent: true, opacity: 0.8 }));
            const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('240,84,79'), depthWrite: false, blending: THREE.AdditiveBlending }));
            dot.scale.setScalar(0.06);
            line.visible = dot.visible = false;
            this.scene.add(line, dot);
            return { line, dot, g };
        });

        this._ro = new ResizeObserver(() => this.resize());
        this._ro.observe(container);
        this.resize();
        this._t0 = performance.now();
        this._raf = requestAnimationFrame(this._animate);
    }

    setFollow(on) {
        this.follow = on;
        if (!on) this.controls.target.set(0, 0, 0);
        this.controls.minDistance = on ? 0.02 : 1.15;
        if (on && this._satPos) {
            const off = this._satPos.clone().normalize().multiplyScalar(0.18).add(new THREE.Vector3(0, 0.05, 0));
            this.camera.position.copy(this._satPos).add(off);
            this.controls.target.copy(this._satPos);
        } else if (!on) {
            const p = (this._satPos || new THREE.Vector3(1, 0, 0)).clone().normalize();
            this.camera.position.copy(p.multiplyScalar(3.2).add(new THREE.Vector3(0, 0.6, 0)));
        }
    }

    /** @param {object} state getFullState() @param {number} warp time multiplier */
    update(state, warp = 1) {
        if (!this.state && !this.failed) {
            // First frame: start looking at the satellite's side of the Earth.
            const o0 = state.orbit;
            const p0 = toScene(orbitStateECI(1, o0.inclination, o0.raan, o0.phase).r);
            const side = new THREE.Vector3(0, 1, 0).cross(p0).normalize().multiplyScalar(0.9);
            this.camera.position.copy(p0.multiplyScalar(3.0).add(side).add(new THREE.Vector3(0, 0.6, 0)));
        }
        this.state = state;
        this.warp = warp;
        this._stateAt = performance.now();
        // Orbit ring for the current elements
        const o = state.orbit;
        const arr = this.orbitGeom.attributes.position.array;
        const a = (RE_KM + o.baseAltitude) / RE_KM;
        for (let k = 0; k <= 360; k++) {
            const p = toScene(orbitStateECI(a, o.inclination, o.raan, k).r);
            arr.set([p.x, p.y, p.z], k * 3);
        }
        this.orbitGeom.attributes.position.needsUpdate = true;
    }

    _animate = () => {
        this._raf = requestAnimationFrame(this._animate);
        const st = this.state;
        if (st) {
            const o = st.orbit;
            // Extrapolate between 10 Hz state updates so the satellite moves smoothly at any warp.
            const dtSim = st.mission.lost ? 0 : ((performance.now() - this._stateAt) / 1000) * (this.warp || 1);
            const n = 360 / (o.period * 60);
            const u = o.phase + n * Math.min(dtSim, 5 * (this.warp || 1));
            const a = (RE_KM + o.baseAltitude) / RE_KM;
            const sv = orbitStateECI(a, o.inclination, o.raan, u);
            const pos = toScene(sv.r);
            this._satPos = pos;
            this.sat.position.copy(pos);

            const gm = st.geometry.gmst + (dtSim * 7.2921159e-5);
            this.earth.group.rotation.y = gm;
            this.earth.clouds.rotation.y += 0.00002;
            const sun = toScene(st.geometry.sun).normalize();
            this.earth.setSun(sun);
            this.sunLight.position.copy(sun).multiplyScalar(50);
            this.sunSprite.position.copy(sun).multiplyScalar(600);

            // Satellite attitude (body X = panel normal, Z = thrust axis) in scene space
            const X = toScene(st.attitude.panelNormal).normalize();
            let Z = toScene(st.attitude.thrustAxis);
            Z.sub(X.clone().multiplyScalar(Z.dot(X))).normalize();
            if (!Number.isFinite(Z.x) || Z.lengthSq() < 0.5) Z = new THREE.Vector3(0, 1, 0);
            const Y = new THREE.Vector3().crossVectors(Z, X);
            this.model.group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
            this.model.setPlume(st.sections.thrusterPod.isThrusting, performance.now() / 1000);
            const lit = st.environment.inSunlight;
            this.marker.material.color.setRGB(lit ? 1 : 0.45, lit ? 1 : 0.5, lit ? 1 : 0.65);

            // Ground-station link
            const comm = st.sections.commArray;
            const gsIdx = GROUND_STATIONS.findIndex(g => g.name === comm.station);
            this.link.visible = gsIdx >= 0;
            if (gsIdx >= 0) {
                const wp = this.stations[gsIdx].dot.getWorldPosition(new THREE.Vector3());
                this.linkGeom.setFromPoints([wp, pos]);
            }
            this.stations.forEach((s, i) => { s.ring.material.opacity = i === gsIdx ? 1 : 0.5; });

            // Debris on straight relative tracks within ±15 min of TCA
            const g = st.geometry;
            const evs = st.conjunctions.filter(e => Math.abs(e.tca - (st.missionTime + dtSim)) < 900).slice(0, 4);
            this.debris.forEach((d, i) => {
                const e = evs[i];
                d.line.visible = d.dot.visible = !!e;
                if (!e) return;
                const h2 = (e.crossingDeg * Math.PI / 180) / 2;
                const uHat = [0, 1, 2].map(k => -Math.sin(h2) * g.vHat[k] + Math.cos(h2) * g.hHat[k]);
                const dtT = st.missionTime + dtSim - e.tca;
                const along = toScene(uHat).multiplyScalar(e.relVel_ms * dtT / 1000 / RE_KM);
                d.dot.position.copy(pos).add(along);
                const span = toScene(uHat).multiplyScalar(e.relVel_ms * 900 / 1000 / RE_KM);
                d.g.setFromPoints([pos.clone().sub(span), pos.clone().add(span)]);
                d.line.computeLineDistances();
                d.dot.material.color.set(e.riskColor);
            });

            if (this.follow) {
                const delta = pos.clone().sub(this.controls.target);
                this.controls.target.add(delta);
                this.camera.position.add(delta);
            }
        }
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    };

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
        this.controls.dispose();
        this.earth.dispose();
        this.model.dispose();
        this.scene.traverse(o => { if (o.geometry && !o.userData.section) o.geometry.dispose(); if (o.material && !o.userData.section) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.map?.dispose?.(); m.dispose?.(); }); });
        this.renderer.dispose();
        this.renderer.domElement.remove();
    }
}
