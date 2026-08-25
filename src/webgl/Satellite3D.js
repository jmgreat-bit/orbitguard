import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class Satellite3D {
    constructor(containerElement, onHover, onClick) {
        this.container = containerElement;
        this.onHover = onHover;
        this.onClick = onClick;

        this.scene = new THREE.Scene();

        // Camera
        const w = this.container.clientWidth || 300;
        const h = this.container.clientHeight || 500;
        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
        this.camera.position.set(0, 2, 16);

        // Renderer
        this.container.style.overflow = 'hidden';
        this.container.style.position = 'relative';
        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(w, h, false); // false = don't set CSS
        const canvas = this.renderer.domElement;
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        this.container.appendChild(canvas);

        // Controls
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.enableZoom = false;
        this.controls.enablePan = false;

        this.meshes = {};
        this.group = new THREE.Group();
        this.scene.add(this.group);

        this.initGeometry();

        // Raycaster for interaction
        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.hoveredMesh = null;

        this.onMouseMoveBound = this.onMouseMove.bind(this);
        this.onMouseClickBound = this.onMouseClick.bind(this);
        this.container.addEventListener('mousemove', this.onMouseMoveBound);
        this.container.addEventListener('click', this.onMouseClickBound);

        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);

        this.clock = new THREE.Clock();
        this.animationId = null;
        this.animate();
    }

    createMaterial() {
        return new THREE.MeshBasicMaterial({
            color: 0x00d4ff,
            wireframe: true,
            transparent: true,
            opacity: 0.6
        });
    }

    initGeometry() {
        // Comm Array (Top)
        const commGeo = new THREE.ConeGeometry(0.8, 1.5, 8);
        const commMesh = new THREE.Mesh(commGeo, this.createMaterial());
        commMesh.position.set(0, 3.5, 0);
        commMesh.userData = { section: 'commArray' };
        this.group.add(commMesh);
        this.meshes.commArray = commMesh;

        // Payload Bay
        const payloadGeo = new THREE.BoxGeometry(2, 2, 2);
        const payloadMesh = new THREE.Mesh(payloadGeo, this.createMaterial());
        payloadMesh.position.set(0, 1.75, 0);
        payloadMesh.userData = { section: 'payloadBay' };
        this.group.add(payloadMesh);
        this.meshes.payloadBay = payloadMesh;

        // OBC (Central)
        const obcGeo = new THREE.BoxGeometry(2.2, 1.5, 2.2);
        const obcMesh = new THREE.Mesh(obcGeo, this.createMaterial());
        obcMesh.position.set(0, 0, 0);
        obcMesh.userData = { section: 'onboardComputer' };
        this.group.add(obcMesh);
        this.meshes.onboardComputer = obcMesh;

        // Battery Bay
        const battGeo = new THREE.BoxGeometry(2, 1.5, 2);
        const battMesh = new THREE.Mesh(battGeo, this.createMaterial());
        battMesh.position.set(0, -1.5, 0);
        battMesh.userData = { section: 'batteryBay' };
        this.group.add(battMesh);
        this.meshes.batteryBay = battMesh;

        // Thruster Pod (Bottom)
        const thrustGeo = new THREE.CylinderGeometry(0.8, 1.2, 1.5, 8);
        const thrustMesh = new THREE.Mesh(thrustGeo, this.createMaterial());
        thrustMesh.position.set(0, -3, 0);
        thrustMesh.userData = { section: 'thrusterPod' };
        this.group.add(thrustMesh);
        this.meshes.thrusterPod = thrustMesh;

        // Thermal Radiator (Backside)
        const radGeo = new THREE.BoxGeometry(1.5, 4, 0.4);
        const radMesh = new THREE.Mesh(radGeo, this.createMaterial());
        radMesh.position.set(0, 0, -1.3);
        radMesh.userData = { section: 'thermalRadiator' };
        this.group.add(radMesh);
        this.meshes.thermalRadiator = radMesh;

        // Solar Panel A (Port/Left)
        const solAGeo = new THREE.BoxGeometry(4, 1.5, 0.1);
        const solAMesh = new THREE.Mesh(solAGeo, this.createMaterial());
        solAMesh.position.set(-3.5, 0, 0);
        solAMesh.userData = { section: 'solarPanelA' };
        this.group.add(solAMesh);
        this.meshes.solarPanelA = solAMesh;

        // Solar Panel B (Starboard/Right)
        const solBGeo = new THREE.BoxGeometry(4, 1.5, 0.1);
        const solBMesh = new THREE.Mesh(solBGeo, this.createMaterial());
        solBMesh.position.set(3.5, 0, 0);
        solBMesh.userData = { section: 'solarPanelB' };
        this.group.add(solBMesh);
        this.meshes.solarPanelB = solBMesh;
    }

    resize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        if (w === 0 || h === 0) return;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h, false);
    }

    onMouseMove(e) {
        const rect = this.container.getBoundingClientRect();
        this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const intersects = this.raycaster.intersectObjects(this.group.children);

        // Reset scales
        Object.values(this.meshes).forEach(m => m.scale.set(1, 1, 1));
        this.container.style.cursor = 'default';

        if (intersects.length > 0) {
            const mesh = intersects[0].object;
            mesh.scale.set(1.05, 1.05, 1.05);
            this.container.style.cursor = 'pointer';

            const key = mesh.userData.section;
            if (this.hoveredMesh !== key) {
                this.hoveredMesh = key;
                if (this.onHover) this.onHover(key);
            }
        } else {
            if (this.hoveredMesh !== null) {
                this.hoveredMesh = null;
                if (this.onHover) this.onHover(null);
            }
        }
    }

    onMouseClick() {
        if (this.hoveredMesh && this.onClick) {
            this.onClick(this.hoveredMesh);
        }
    }

    update(sections) {
        // Process color state based on physics data
        for (const [key, state] of Object.entries(sections)) {
            const mesh = this.meshes[key];
            if (mesh) {
                if (state.status === 'critical') {
                    mesh.material.color.setHex(0xff003c); // --red
                    mesh.material.opacity = 0.9;
                } else if (state.status === 'warning') {
                    mesh.material.color.setHex(0xffb000); // --amber
                    mesh.material.opacity = 0.8;
                } else {
                    mesh.material.color.setHex(0x00d4ff); // --cyan
                    mesh.material.opacity = 0.6;
                }
            }
        }
    }

    animate() {
        this.animationId = requestAnimationFrame(this.animate.bind(this));

        const dt = this.clock.getDelta();
        const time = this.clock.getElapsedTime();

        // Slow cinematic rotation
        this.group.rotation.y += 0.1 * dt;
        this.group.position.y = Math.sin(time * 0.5) * 0.2; // subtle floating

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    destroy() {
        if (this.animationId) cancelAnimationFrame(this.animationId);
        window.removeEventListener('resize', this._onResize);
        this.container.removeEventListener('mousemove', this.onMouseMoveBound);
        this.container.removeEventListener('click', this.onMouseClickBound);
        if (this.renderer && this.renderer.domElement && this.container.contains(this.renderer.domElement)) {
            this.container.removeChild(this.renderer.domElement);
        }
        this.renderer.dispose();
    }
}
