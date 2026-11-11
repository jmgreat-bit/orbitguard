/**
 * Shared Earth: day texture lit by the real Sun direction, city lights on the night
 * side, specular ocean glint, a cloud layer and an atmospheric rim.
 *
 * Mesh-local axes follow the "ECEF in three.js" convention used everywhere in the app:
 * local (x, y, z) = ECEF (x, z, −y)  — Y is the north pole, +X is 0° longitude.
 * Textures: three.js examples (MIT), derived from NASA Blue Marble / Black Marble imagery.
 */
import * as THREE from 'three';

const texCache = {};
function tex(name, srgb) {
    if (!texCache[name]) {
        const t = new THREE.TextureLoader().load(`${import.meta.env?.BASE_URL ?? '/'}textures/${name}`);
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        texCache[name] = t;
    }
    return texCache[name];
}

const VERT = /* glsl */`
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vUv = uv;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FRAG = /* glsl */`
uniform sampler2D dayMap;
uniform sampler2D nightMap;
uniform sampler2D specMap;
uniform vec3 sunDir;
uniform float lightsBias;   // mip bias for the night map: > 0 softens it for low-altitude close-ups
uniform float lightsGain;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float d = dot(N, sunDir);
  float day = smoothstep(-0.10, 0.20, d);
  vec3 dayCol = texture2D(dayMap, vUv).rgb * (0.06 + 1.05 * max(d, 0.0));
  vec3 lights = texture2D(nightMap, vUv, lightsBias).rgb * vec3(1.0, 0.82, 0.55) * lightsGain;
  vec3 col = dayCol * day + lights * (1.0 - day) * (1.0 - day);
  vec3 H = normalize(sunDir + V);
  // Ocean glint: a tight core with a faint wide sheen (the old single wide lobe drew a white blob on the sea).
  float nh = max(dot(N, H), 0.0);
  float spec = (pow(nh, 420.0) * 0.32 + pow(nh, 24.0) * 0.07) * texture2D(specMap, vUv).r * day;
  col += vec3(1.0, 0.94, 0.82) * spec;
  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  col += vec3(0.30, 0.58, 1.0) * fres * 0.45 * (0.15 + 0.85 * day);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const ATMO_VERT = /* glsl */`
varying vec3 vN;
varying vec3 vW;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const ATMO_FRAG = /* glsl */`
uniform vec3 sunDir;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float rim = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 4.0);
  float lit = smoothstep(-0.35, 0.35, dot(N, sunDir));
  vec3 c = mix(vec3(0.05, 0.10, 0.25), vec3(0.35, 0.65, 1.0), lit);
  gl_FragColor = vec4(c * rim * 1.4, rim * (0.25 + 0.75 * lit));
}`;

/**
 * @param {number} radius     scene units
 * @param {number} segments   sphere detail
 * @param {{lightsBias?: number, lightsGain?: number}} [opts]  night-lights look (see the shader)
 */
export function createEarth(radius = 1, segments = 96, { lightsBias = 0, lightsGain = 1.6 } = {}) {
    const group = new THREE.Group();
    const sunDir = new THREE.Vector3(1, 0, 0);
    const surfaceMat = new THREE.ShaderMaterial({
        uniforms: {
            dayMap: { value: tex('earth_atmos_2048.jpg', true) },
            nightMap: { value: tex('earth_lights_2048.png', true) },
            specMap: { value: tex('earth_specular_2048.jpg', false) },
            sunDir: { value: sunDir },
            lightsBias: { value: lightsBias },
            lightsGain: { value: lightsGain },
        },
        vertexShader: VERT,
        fragmentShader: FRAG,
    });
    const surface = new THREE.Mesh(new THREE.SphereGeometry(radius, segments, segments / 2), surfaceMat);
    group.add(surface);

    const cloudMat = new THREE.MeshLambertMaterial({ map: tex('earth_clouds_1024.png', true), transparent: true, opacity: 0.75, depthWrite: false });
    const clouds = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.006, segments, segments / 2), cloudMat);
    group.add(clouds);

    const atmoMat = new THREE.ShaderMaterial({
        uniforms: { sunDir: { value: sunDir } },
        vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG,
        side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.045, segments, segments / 2), atmoMat);

    return {
        group,      // rotate this (Earth rotation)
        atmosphere: atmo, // add to the scene unrotated, at the same centre
        clouds,
        /** World-space unit vector toward the Sun. */
        setSun(v) { sunDir.copy(v).normalize(); },
        dispose() {
            for (const m of [surface, clouds, atmo]) m.geometry.dispose();
            surfaceMat.dispose(); cloudMat.dispose(); atmoMat.dispose();
        },
    };
}

/** ECI/ECEF [x,y,z] → three.js vector in the app convention (Y = north). */
export const toScene = (v, s = 1) => new THREE.Vector3(v[0] * s, v[2] * s, -v[1] * s);

/** Simple star field. */
export function createStars(count = 2500, radius = 400) {
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        pos.set([radius * s * Math.cos(th), radius * u, radius * s * Math.sin(th)], i * 3);
        const b = 0.35 + Math.random() ** 3 * 0.65;
        const warm = Math.random() < 0.2;
        col.set([b, b * (warm ? 0.9 : 0.97), b * (warm ? 0.8 : 1.0)], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false });
    return new THREE.Points(g, m);
}

/** Soft round sprite texture for markers and the Sun. */
export function glowTexture(rgb = '255,255,255') {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, `rgba(${rgb},1)`);
    grad.addColorStop(0.25, `rgba(${rgb},0.6)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
