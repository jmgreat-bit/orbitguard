/**
 * Procedural 1U CubeSat built to the CubeSat Design Specification envelope
 * (100 × 100 × 113.5 mm, four rails), in centimetres.
 *
 * Body axes: +X = solar-cell face (the attitude model's "panel normal"),
 *            +Z = thrust direction (cold-gas nozzle on the −Z face),
 *            wings deploy along ±Y, flush with the +X face.
 *
 * Every mesh is tagged with the simulated subsystem it belongs to, so the view can
 * pick it, colour it by temperature, or reveal internals in x-ray mode.
 */
import * as THREE from 'three';

const W = 10, L = 11.35, RAIL = 0.85;
const WING_W = 12.7, WING_H = 10;   // 0.0127 m² per wing — matches the power/thermal model

let cellTexture = null;
function solarCellTexture() {
    if (cellTexture) return cellTexture;
    const c = document.createElement('canvas');
    c.width = 256; c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#2a3a2e'; g.fillRect(0, 0, 256, 512);          // PCB between cells
    const cell = (x, y, w, h) => {
        const grad = g.createLinearGradient(x, y, x + w, y + h);
        grad.addColorStop(0, '#1d2f63'); grad.addColorStop(1, '#101b40');
        g.fillStyle = grad;
        const k = 10; // cropped corners, as on real triple-junction cells
        g.beginPath();
        g.moveTo(x + k, y); g.lineTo(x + w - k, y); g.lineTo(x + w, y + k); g.lineTo(x + w, y + h - k);
        g.lineTo(x + w - k, y + h); g.lineTo(x + k, y + h); g.lineTo(x, y + h - k); g.lineTo(x, y + k);
        g.closePath(); g.fill();
        g.strokeStyle = 'rgba(190,200,215,0.35)'; g.lineWidth = 1;
        for (let i = x + 6; i < x + w - 3; i += 6) { g.beginPath(); g.moveTo(i, y + 4); g.lineTo(i, y + h - 4); g.stroke(); }
        g.fillStyle = 'rgba(210,215,225,0.85)';
        g.fillRect(x + 4, y + 3, w - 8, 3); g.fillRect(x + 4, y + h - 6, w - 8, 3);
    };
    cell(10, 10, 236, 240);
    cell(10, 262, 236, 240);
    cellTexture = new THREE.CanvasTexture(c);
    cellTexture.colorSpace = THREE.SRGBColorSpace;
    cellTexture.anisotropy = 4;
    return cellTexture;
}

const MAT = {
    rail: () => new THREE.MeshStandardMaterial({ color: 0x3a3f47, metalness: 0.7, roughness: 0.38 }),
    alu: () => new THREE.MeshStandardMaterial({ color: 0xb9c0c9, metalness: 0.85, roughness: 0.32 }),
    pcb: () => new THREE.MeshStandardMaterial({ color: 0x1f3a2c, metalness: 0.1, roughness: 0.6 }),
    radiator: () => new THREE.MeshStandardMaterial({ color: 0xe9ecef, metalness: 0.0, roughness: 0.85 }),
    cells: () => new THREE.MeshStandardMaterial({ map: solarCellTexture(), metalness: 0.35, roughness: 0.22 }),
    black: () => new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.3, roughness: 0.5 }),
    glass: () => new THREE.MeshPhysicalMaterial({ color: 0x223355, metalness: 0, roughness: 0.05, clearcoat: 1, transmission: 0, reflectivity: 0.9 }),
    brass: () => new THREE.MeshStandardMaterial({ color: 0xc9a356, metalness: 0.9, roughness: 0.3 }),
    tape: () => new THREE.MeshStandardMaterial({ color: 0xd5d9de, metalness: 0.9, roughness: 0.25 }),
    kapton: () => new THREE.MeshStandardMaterial({ color: 0xc8892a, metalness: 0.6, roughness: 0.35 }),
    cellBattery: () => new THREE.MeshStandardMaterial({ color: 0x2f6fb5, metalness: 0.3, roughness: 0.45 }),
};

/**
 * @returns {{ group: THREE.Group, pickables: THREE.Mesh[], setThermal(on, colors), setXray(on), setPlume(on, t), setWingEfficiency(id, eff) }}
 */
export function buildCubeSat() {
    const group = new THREE.Group();
    const pickables = [];
    const shell = [];
    const internals = [];

    const add = (mesh, section, { internal = false, isShell = false } = {}) => {
        mesh.userData.section = section;
        mesh.userData.baseMaterial = mesh.material;
        mesh.castShadow = false;
        group.add(mesh);
        pickables.push(mesh);
        if (internal) { internals.push(mesh); mesh.visible = false; }
        if (isShell) shell.push(mesh);
        return mesh;
    };
    const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);

    // ── structure: four rails + top/bottom frames ──
    const h = W / 2 - RAIL / 2;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        const r = box(RAIL, RAIL, L, MAT.rail());
        r.position.set(sx * h, sy * h, 0);
        add(r, 'thermalRadiator', { isShell: true });
    }
    for (const sz of [-1, 1]) {
        const frame = box(W, W, 0.35, MAT.alu());
        frame.position.z = sz * (L / 2 - 0.6);
        add(frame, 'thermalRadiator', { isShell: true });
    }

    // ── side faces ──
    const faceW = W - 2 * RAIL + 0.1, faceH = L - 1.6;
    const plusX = box(0.16, faceW, faceH, MAT.cells());     // body-mounted cells
    plusX.position.x = W / 2 - 0.12;
    add(plusX, 'thermalRadiator', { isShell: true });
    const minusX = box(0.16, faceW, faceH, MAT.radiator()); // white radiator face (low α, high ε)
    minusX.position.x = -W / 2 + 0.12;
    add(minusX, 'thermalRadiator', { isShell: true });
    for (const sy of [-1, 1]) {
        const f = box(faceW, 0.16, faceH, MAT.cells());
        f.position.y = sy * (W / 2 - 0.12);
        add(f, 'thermalRadiator', { isShell: true });
    }

    // ── +Z face: UHF antenna deployer with four tape-measure antennas, sun sensor ──
    const top = box(faceW, faceW, 0.16, MAT.pcb());
    top.position.z = L / 2 - 0.1;
    add(top, 'commArray', { isShell: true });
    const deployer = box(7.2, 7.2, 0.7, MAT.black());
    deployer.position.z = L / 2 + 0.3;
    add(deployer, 'commArray');
    const antLen = 17;
    for (let k = 0; k < 4; k++) {
        const a = box(antLen, 0.5, 0.03, MAT.tape());
        const ang = k * Math.PI / 2 + Math.PI / 4;
        a.position.set(Math.cos(ang) * (antLen / 2 + 3.4), Math.sin(ang) * (antLen / 2 + 3.4), L / 2 + 0.68);
        a.rotation.z = ang;
        add(a, 'commArray');
    }
    const sunSensor = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.3, 20), MAT.glass());
    sunSensor.rotation.x = Math.PI / 2;
    sunSensor.position.set(0, 0, L / 2 + 0.75);
    add(sunSensor, 'onboardComputer');

    // ── −Z face: camera lens and cold-gas nozzle ──
    const bottom = box(faceW, faceW, 0.16, MAT.kapton());
    bottom.position.z = -L / 2 + 0.1;
    add(bottom, 'thrusterPod', { isShell: true });
    const lensBarrel = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 1.6, 32), MAT.black());
    lensBarrel.rotation.x = Math.PI / 2;
    lensBarrel.position.set(-1.6, 1.6, -L / 2 - 0.75);
    add(lensBarrel, 'payloadBay');
    const lens = new THREE.Mesh(new THREE.CircleGeometry(1.25, 32), MAT.glass());
    lens.rotation.x = Math.PI;
    lens.position.set(-1.6, 1.6, -L / 2 - 1.56);
    add(lens, 'payloadBay');
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.75, 1.4, 24, 1, true), MAT.brass());
    nozzle.material.side = THREE.DoubleSide;
    nozzle.rotation.x = -Math.PI / 2;
    nozzle.position.set(2.4, -2.4, -L / 2 - 0.7);
    add(nozzle, 'thrusterPod');

    // ── deployable wings (A = port −Y, B = starboard +Y), cells facing +X ──
    const wings = {};
    for (const [id, sy] of [['A', -1], ['B', 1]]) {
        const wing = new THREE.Group();
        const panel = box(0.18, WING_W, WING_H, MAT.pcb());
        const cells = box(0.02, WING_W - 0.6, WING_H - 0.6, MAT.cells());
        cells.position.x = 0.1;
        panel.position.y = sy * WING_W / 2;
        cells.position.y = sy * WING_W / 2;
        const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, WING_H, 12), MAT.alu());
        hinge.rotation.x = Math.PI / 2;
        wing.add(panel, cells, hinge);
        wing.position.set(W / 2 - 0.05, sy * (W / 2 + 0.25), 0);
        group.add(wing);
        for (const m of [panel, cells, hinge]) {
            m.userData.section = `solarPanel${id}`;
            m.userData.baseMaterial = m.material;
            pickables.push(m);
        }
        wings[id] = { wing, cells };
    }

    // ── internals (x-ray / thermal view) ──
    for (const sy of [-1, 1]) {
        const cell = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 6.5, 20), MAT.cellBattery());
        cell.rotation.z = Math.PI / 2;
        cell.position.set(0.5, sy * 1.2, -2.6);
        add(cell, 'batteryBay', { internal: true });
    }
    for (let k = 0; k < 3; k++) {
        const board = box(8.6, 8.6, 0.16, MAT.pcb());
        board.position.z = 0.6 + k * 1.1;
        add(board, 'onboardComputer', { internal: true });
    }
    const radio = box(8.6, 8.6, 0.16, MAT.pcb());
    radio.position.z = 4.0;
    add(radio, 'commArray', { internal: true });
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 3.6, 24), MAT.alu());
    tank.rotation.x = Math.PI / 2;
    tank.position.set(2.2, -2.2, -3.4);
    add(tank, 'thrusterPod', { internal: true });
    const camBody = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 3.0, 24), MAT.black());
    camBody.rotation.x = Math.PI / 2;
    camBody.position.set(-1.6, 1.6, -3.9);
    add(camBody, 'payloadBay', { internal: true });

    // ── exhaust plume ──
    const plumeMat = new THREE.MeshBasicMaterial({ color: 0xbfdcff, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const plume = new THREE.Mesh(new THREE.ConeGeometry(2.2, 9, 24, 1, true), plumeMat);
    plume.rotation.x = Math.PI / 2;
    plume.position.set(2.4, -2.4, -L / 2 - 1.4 - 4.5);
    group.add(plume);

    const thermalMats = {};
    let thermalOn = false, xrayOn = false;

    function applyMaterials(colors) {
        for (const m of pickables) {
            const sec = m.userData.section;
            if (thermalOn && colors?.[sec]) {
                // one material per mesh, so x-ray transparency on the shell never leaks to internals
                if (!thermalMats[m.uuid]) thermalMats[m.uuid] = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
                const tm = thermalMats[m.uuid];
                const [r, g, b] = colors[sec];
                tm.color.setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
                tm.emissive.setRGB(r / 255 * 0.45, g / 255 * 0.45, b / 255 * 0.45, THREE.SRGBColorSpace);
                m.material = tm;
            } else {
                m.material = m.userData.baseMaterial;
            }
            const isShell = shell.includes(m);
            const mat = m.material;
            mat.transparent = xrayOn && isShell;
            mat.opacity = xrayOn && isShell ? (thermalOn ? 0.08 : 0.14) : 1;
            mat.depthWrite = !(xrayOn && isShell);
        }
        for (const m of internals) m.visible = xrayOn;
    }

    return {
        group,
        pickables,
        setThermal(on, colors) { thermalOn = on; applyMaterials(colors); },
        setXray(on, colors) { xrayOn = on; applyMaterials(colors); },
        refresh(colors) { if (thermalOn) applyMaterials(colors); },
        setPlume(on, t = 0) {
            const target = on ? 0.55 + 0.15 * Math.sin(t * 40) : 0;
            plumeMat.opacity += (target - plumeMat.opacity) * 0.35;
            plume.visible = plumeMat.opacity > 0.01;
            plume.scale.set(1 + 0.05 * Math.sin(t * 33), 1 + 0.08 * Math.sin(t * 27), 1);
        },
        setWingEfficiency(id, eff) {
            const c = wings[id]?.cells;
            if (!c || thermalOn) return;
            const m = c.userData.baseMaterial;
            m.color.setScalar(eff < 0.5 ? 0.35 : 1);
        },
        dispose() {
            group.traverse(o => { o.geometry?.dispose?.(); });
            for (const m of pickables) m.userData.baseMaterial?.dispose?.();
            Object.values(thermalMats).forEach(m => m.dispose());
            plumeMat.dispose();
        },
    };
}
