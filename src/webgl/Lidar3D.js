import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class Lidar3D {
    constructor(containerElement, maxRange = 200) {
        this.container = containerElement;
        this.maxRange = maxRange;
        this.isDestroyed = false;

        // Force container to clip any overflow from the canvas
        this.container.style.overflow = 'hidden';
        this.container.style.position = 'relative';

        this.scene = new THREE.Scene();

        // Read initial size ONCE
        const w = this.container.clientWidth || 400;
        const h = this.container.clientHeight || 280;

        this.camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 500);
        this.camera.position.set(0, 70, 70);
        this.camera.lookAt(0, 0, 0);

        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(w, h, false); // false = don't set CSS style
        // Manually set canvas CSS to fill container
        const canvas = this.renderer.domElement;
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        this.container.appendChild(canvas);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxPolarAngle = Math.PI / 2.2;
        this.controls.enableZoom = false;
        this.controls.enablePan = false;

        this.blipsGroup = new THREE.Group();
        this.scene.add(this.blipsGroup);

        this.initGeometry();

        // Use a simple window resize listener (no ResizeObserver loop)
        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);

        this.clock = new THREE.Clock();
        this.animationId = null;
        this.animate();
    }

    initGeometry() {
        const cyan = new THREE.Color(0x00d4ff);

        // Center satellite marker
        const satGeo = new THREE.SphereGeometry(1.5, 16, 16);
        const satMat = new THREE.MeshBasicMaterial({ color: cyan });
        this.satMesh = new THREE.Mesh(satGeo, satMat);
        this.scene.add(this.satMesh);

        // Concentric range rings (line loops)
        [30, 60, 90].forEach((r, i) => {
            const pts = [];
            for (let j = 0; j <= 64; j++) {
                const theta = (j / 64) * Math.PI * 2;
                pts.push(new THREE.Vector3(Math.cos(theta) * r, 0, Math.sin(theta) * r));
            }
            const geo = new THREE.BufferGeometry().setFromPoints(pts);
            const mat = new THREE.LineBasicMaterial({ color: cyan, transparent: true, opacity: 0.15 + i * 0.05 });
            this.scene.add(new THREE.Line(geo, mat));
        });

        // Radial crosshairs
        const crossMat = new THREE.LineBasicMaterial({ color: cyan, transparent: true, opacity: 0.1 });
        for (let a = 0; a < 4; a++) {
            const theta = (a / 4) * Math.PI * 2;
            const pts = [
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(Math.cos(theta) * 95, 0, Math.sin(theta) * 95),
            ];
            this.scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), crossMat));
        }

        // Sweeper fan (narrow triangle)
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);
        shape.lineTo(90, -6);
        shape.lineTo(90, 6);
        shape.closePath();
        const sweepGeo = new THREE.ShapeGeometry(shape);
        sweepGeo.rotateX(-Math.PI / 2);
        const sweepMat = new THREE.MeshBasicMaterial({
            color: cyan, transparent: true, opacity: 0.12,
            side: THREE.DoubleSide, depthWrite: false,
        });
        this.sweeper = new THREE.Mesh(sweepGeo, sweepMat);
        this.scene.add(this.sweeper);
    }

    resize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (w === 0 || h === 0) return;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h, false); // false = don't touch CSS
    }

    update(trackedObjects) {
        while (this.blipsGroup.children.length > 0) {
            const child = this.blipsGroup.children[0];
            this.blipsGroup.remove(child);
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        }

        trackedObjects.forEach(obj => {
            const r = Math.min((obj.distance / this.maxRange) * 90, 90);
            const rad = (obj.bearing * Math.PI) / 180;
            const x = r * Math.sin(rad);
            const z = -r * Math.cos(rad);

            let colorHex = 0x00d4ff;
            if (obj.riskColor === 'var(--red)' || obj.distance < 20) colorHex = 0xff003c;
            else if (obj.riskColor === 'var(--amber)' || obj.distance < 50) colorHex = 0xffb000;

            const blipGeo = new THREE.SphereGeometry(2, 8, 8);
            const blipMat = new THREE.MeshBasicMaterial({ color: colorHex });
            const blip = new THREE.Mesh(blipGeo, blipMat);
            blip.position.set(x, 0, z);
            this.blipsGroup.add(blip);
        });
    }

    animate() {
        if (this.isDestroyed) return;
        this.animationId = requestAnimationFrame(this.animate.bind(this));

        const dt = this.clock.getDelta();
        const t = this.clock.getElapsedTime();

        if (this.sweeper) this.sweeper.rotation.y -= 1.5 * dt;
        if (this.satMesh) {
            const s = 1 + 0.15 * Math.sin(t * 3);
            this.satMesh.scale.set(s, s, s);
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    destroy() {
        this.isDestroyed = true;
        if (this.animationId) cancelAnimationFrame(this.animationId);
        window.removeEventListener('resize', this._onResize);
        if (this.renderer && this.renderer.domElement && this.container.contains(this.renderer.domElement)) {
            this.container.removeChild(this.renderer.domElement);
        }
        this.renderer.dispose();
    }
}
