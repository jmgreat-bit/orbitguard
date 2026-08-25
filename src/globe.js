// 3D Globe with Three.js

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export class GlobeViz {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        this.controls = null;
        this.earth = null;
        this.clouds = null;
        this.satellite = null;
        this.sunLight = null;

        this.init();
    }

    init() {
        // Setup renderer
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.container.appendChild(this.renderer.domElement);

        // Setup camera
        this.camera.position.z = 3.5;

        // Setup controls (auto-rotate)
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.autoRotate = true;
        this.controls.autoRotateSpeed = 0.5;
        this.controls.enableZoom = false;

        // Lighting (Sun)
        const ambientLight = new THREE.AmbientLight(0x333333);
        this.scene.add(ambientLight);

        this.sunLight = new THREE.DirectionalLight(0xffffff, 2);
        this.sunLight.position.set(5, 3, 5);
        this.scene.add(this.sunLight);

        // Create Earth
        const earthGeometry = new THREE.SphereGeometry(1, 64, 64);
        const earthMaterial = new THREE.MeshPhongMaterial({
            map: new THREE.TextureLoader().load('https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_atmos_2048.jpg'),
            specularMap: new THREE.TextureLoader().load('https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_specular_2048.jpg'),
            normalMap: new THREE.TextureLoader().load('https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_normal_2048.jpg'),
            specular: new THREE.Color(0x333333),
            shininess: 15
        });
        this.earth = new THREE.Mesh(earthGeometry, earthMaterial);
        this.scene.add(this.earth);

        // Create Clouds
        const cloudGeometry = new THREE.SphereGeometry(1.02, 64, 64);
        const cloudMaterial = new THREE.MeshPhongMaterial({
            map: new THREE.TextureLoader().load('https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/planets/earth_clouds_1024.png'),
            transparent: true,
            opacity: 0.8,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide
        });
        this.clouds = new THREE.Mesh(cloudGeometry, cloudMaterial);
        this.scene.add(this.clouds);

        // Create Satellite
        const satGeometry = new THREE.BoxGeometry(0.05, 0.05, 0.1);
        const satMaterial = new THREE.MeshStandardMaterial({
            color: 0x00ffff,
            emissive: 0x00ffff,
            emissiveIntensity: 0.5
        });
        this.satellite = new THREE.Mesh(satGeometry, satMaterial);
        this.scene.add(this.satellite);

        // Create Debris particles
        this.createDebrisField();

        // Handle resize
        window.addEventListener('resize', () => this.onWindowResize(), false);

        // Start animation loop
        this.animate();
    }

    createDebrisField() {
        const debrisGeometry = new THREE.BufferGeometry();
        const debrisCount = 500;
        const positions = new Float32Array(debrisCount * 3);

        for (let i = 0; i < debrisCount; i++) {
            const r = 1.2 + Math.random() * 0.5; // Altitude
            const theta = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);

            positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
            positions[i * 3 + 2] = r * Math.cos(phi);
        }

        debrisGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        const debrisMaterial = new THREE.PointsMaterial({
            color: 0xff3366,
            size: 0.02,
            transparent: true,
            opacity: 0.6
        });

        const debrisField = new THREE.Points(debrisGeometry, debrisMaterial);
        this.scene.add(debrisField);
    }

    updateSatellitePosition(orbitPhase) {
        if (!this.satellite) return;

        // Orbit radius
        const r = 1.3;
        const rad = (orbitPhase * Math.PI) / 180;

        this.satellite.position.x = r * Math.cos(rad);
        this.satellite.position.z = r * Math.sin(rad);
        this.satellite.rotation.y = -rad;

        // Pulse effect
        const scale = 1 + Math.sin(Date.now() * 0.005) * 0.1;
        this.satellite.scale.set(scale, scale, scale);
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        if (this.earth) this.earth.rotation.y += 0.0005;
        if (this.clouds) this.clouds.rotation.y += 0.0007;

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}
