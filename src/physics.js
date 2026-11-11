/**
 * OrbitGuard physics core — pure functions, no DOM, no state.
 *
 * Every function here is unit-tested in test/physics.test.js.
 * Units are in the parameter names: _m metres, _km kilometres, _ms m/s, _s seconds.
 *
 *   1. Atmosphere + drag decay      (exponential density bands, energy method)
 *   2. J2 secular RAAN drift
 *   3. Geodetic altitude            (WGS-84 ellipsoid — why altitude "wobbles" over an orbit)
 *   4. Rocket equation + manoeuvres (Tsiolkovsky, tangential Δa, Hohmann)
 *   5. Relative motion              (Clohessy–Wiltshire response to an impulsive burn)
 *   6. Collision probability        (Chan's series for an isotropic B-plane covariance)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
export const GM = 3.986004418e14;          // m³/s²   Earth gravitational parameter
export const RE = 6.371e6;                 // m       Earth mean radius (altitude reference in this sim)
export const RE_EQ = 6.378137e6;           // m       WGS-84 equatorial radius
export const FLATTENING = 1 / 298.257223563;
export const J2 = 1.08262668e-3;           // —       Earth oblateness (with RE_EQ)
export const G0 = 9.80665;                 // m/s²    standard gravity
export const SOLAR_CONSTANT = 1361;        // W/m²    at 1 AU
export const SIGMA_SB = 5.670374419e-8;    // W/m²K⁴  Stefan–Boltzmann
export const OMEGA_EARTH = 7.2921159e-5;   // rad/s   Earth rotation rate

// ─────────────────────────────────────────────────────────────────────────────
// 1. Atmosphere and drag
// ─────────────────────────────────────────────────────────────────────────────

// Piecewise-exponential density bands (alt km → base density kg/m³, scale height km).
// Values follow the U.S. Standard Atmosphere / CIRA-72 table used in Vallado,
// "Fundamentals of Astrodynamics", Table 8-4 — representative of moderate solar activity.
const ATMO_LAYERS = [
    { altKm: 0, rho0: 1.225, H: 7.249 },
    { altKm: 25, rho0: 3.899e-2, H: 6.349 },
    { altKm: 30, rho0: 1.774e-2, H: 6.682 },
    { altKm: 40, rho0: 3.972e-3, H: 7.554 },
    { altKm: 50, rho0: 1.057e-3, H: 8.382 },
    { altKm: 60, rho0: 3.206e-4, H: 7.714 },
    { altKm: 70, rho0: 8.770e-5, H: 6.549 },
    { altKm: 80, rho0: 1.905e-5, H: 5.799 },
    { altKm: 90, rho0: 3.396e-6, H: 5.382 },
    { altKm: 100, rho0: 5.297e-7, H: 5.877 },
    { altKm: 110, rho0: 9.661e-8, H: 7.263 },
    { altKm: 120, rho0: 2.438e-8, H: 9.473 },
    { altKm: 130, rho0: 8.484e-9, H: 12.636 },
    { altKm: 140, rho0: 3.845e-9, H: 16.149 },
    { altKm: 150, rho0: 2.070e-9, H: 22.523 },
    { altKm: 180, rho0: 5.464e-10, H: 29.740 },
    { altKm: 200, rho0: 2.789e-10, H: 37.105 },
    { altKm: 250, rho0: 7.248e-11, H: 45.546 },
    { altKm: 300, rho0: 2.418e-11, H: 53.628 },
    { altKm: 350, rho0: 9.518e-12, H: 53.298 },
    { altKm: 400, rho0: 3.725e-12, H: 58.515 },
    { altKm: 450, rho0: 1.585e-12, H: 60.828 },
    { altKm: 500, rho0: 6.967e-13, H: 63.822 },
    { altKm: 600, rho0: 1.454e-13, H: 71.835 },
    { altKm: 700, rho0: 3.614e-14, H: 88.667 },
    { altKm: 800, rho0: 1.170e-14, H: 124.64 },
    { altKm: 900, rho0: 5.245e-15, H: 181.05 },
    { altKm: 1000, rho0: 3.019e-15, H: 268.00 },
];

/**
 * Atmospheric density at a geometric altitude (kg/m³), piecewise exponential.
 * @param {number} altKm
 */
export function atmosphericDensity(altKm) {
    if (!Number.isFinite(altKm)) return 0;
    if (altKm <= 0) return ATMO_LAYERS[0].rho0;
    let layer = ATMO_LAYERS[0];
    for (let i = ATMO_LAYERS.length - 1; i >= 0; i--) {
        if (altKm >= ATMO_LAYERS[i].altKm) { layer = ATMO_LAYERS[i]; break; }
    }
    return layer.rho0 * Math.exp(-(altKm - layer.altKm) / layer.H);
}

/**
 * Space-weather multiplier on thermospheric density.
 * Empirical and approximate (order of magnitude, not NRLMSISE):
 *   - F10.7 solar flux: density at ~400 km changes roughly ×10 between solar
 *     minimum (F10.7≈70) and maximum (≈250) → exp(0.0128·(F10.7−150)).
 *   - Geomagnetic storms heat the thermosphere: +10 % per Kp unit above 3.
 * Below 150 km the thermosphere barely responds, so the factor fades out.
 */
export function spaceWeatherDensityFactor(altKm, f107 = 150, kp = 3) {
    const blend = Math.min(1, Math.max(0, (altKm - 150) / 100)); // 0 at 150 km → 1 at 250 km
    const solar = Math.exp(0.0128 * (f107 - 150));
    const storm = 1 + 0.1 * Math.max(0, kp - 3);
    return 1 + blend * (solar * storm - 1);
}

/** Drag deceleration magnitude a = ½ ρ v² Cd (A/m), m/s². */
export function dragAcceleration(altKm, velocityMs, Cd, Am, f107 = 150, kp = 3) {
    const rho = atmosphericDensity(altKm) * spaceWeatherDensityFactor(altKm, f107, kp);
    return 0.5 * rho * velocityMs * velocityMs * Cd * Am;
}

/**
 * Orbit-radius decay rate from drag for a near-circular orbit, km/s (negative).
 *
 * Energy method: specific orbital energy ε = −GM/(2r), so dε/dr = GM/(2r²).
 * Drag removes energy at dε/dt = −a·v. Therefore
 *      dr/dt = (dε/dt)/(dε/dr) = −2 r² a v / GM = −2 a r / v      (using v² = GM/r)
 * The original code dropped the factor v and decayed ~7,600× too slowly.
 *
 * @param {number} altKm      altitude (km)
 * @param {number} velocityMs orbital speed (m/s)
 * @param {number} Cd         drag coefficient (≈2.2 for a CubeSat)
 * @param {number} Am         area-to-mass ratio (m²/kg)
 * @param {number} kp         geomagnetic Kp (0–9)
 * @param {number} f107       10.7 cm solar flux (SFU)
 */
export function dragDecayRate(altKm, velocityMs, Cd, Am, kp = 3, f107 = 150) {
    const r = RE + altKm * 1000;
    const a = dragAcceleration(altKm, velocityMs, Cd, Am, f107, kp);
    const drdt_ms = -2 * a * r / velocityMs;
    return drdt_ms / 1000;
}

/**
 * Days until the orbit decays to floorKm, integrating dr/dt (density grows as it sinks,
 * so a constant-rate extrapolation would badly overestimate lifetime).
 * Returns Infinity beyond 100 years.
 */
export function orbitalLifetimeDays(altKm, Cd, Am, kp = 3, f107 = 150, floorKm = 200) {
    let alt = altKm;
    let t = 0;
    const limit = 36525 * 86400;
    for (let i = 0; i < 200000 && alt > floorKm; i++) {
        const rate = Math.abs(dragDecayRate(alt, orbitalVelocity(alt) * 1000, Cd, Am, kp, f107)); // km/s
        if (rate <= 0) return Infinity;
        const dt = Math.min(0.25 / rate, 30 * 86400); // ≤ 250 m per step
        alt -= rate * dt;
        t += dt;
        if (t > limit) return Infinity;
    }
    return t / 86400;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. J2 secular RAAN drift
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ω̇ = −(3/2) n J2 (R_eq/p)² cos i, with p = a(1−e²). Returns degrees/day.
 * ISS-like (420 km, 51.6°) gives about −5°/day.
 */
export function j2RaanDrift(altKm, inclDeg, eccentricity = 0) {
    const a = RE + altKm * 1000;
    const n = Math.sqrt(GM / (a * a * a));
    const p = a * (1 - eccentricity * eccentricity);
    const drift = -1.5 * n * J2 * Math.pow(RE_EQ / p, 2) * Math.cos(inclDeg * Math.PI / 180);
    return drift * (180 / Math.PI) * 86400;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Geodetic altitude above the WGS-84 ellipsoid
// ─────────────────────────────────────────────────────────────────────────────

/** Radius of the WGS-84 ellipsoid surface at a geocentric latitude, km. */
export function ellipsoidRadiusKm(latDeg) {
    const a = RE_EQ / 1000;
    const b = a * (1 - FLATTENING);
    const phi = latDeg * Math.PI / 180;
    const c = Math.cos(phi), s = Math.sin(phi);
    return (a * b) / Math.sqrt((b * c) ** 2 + (a * s) ** 2);
}

/**
 * Height above the ellipsoid for a satellite at orbital radius radiusKm.
 * Earth is ~21 km flatter at the poles, so a circular orbit's altitude rises by
 * ~13 km toward 51.6° latitude. This is the real 5–15 km "altitude wobble" the
 * original j2AltitudeCorrection() tried (and failed) to produce.
 */
export function geodeticAltitude(radiusKm, latDeg) {
    return radiusKm - ellipsoidRadiusKm(latDeg);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Rocket equation and manoeuvres
// ─────────────────────────────────────────────────────────────────────────────

function requireIsp(isp_s) {
    if (!(isp_s > 0)) throw new Error(`Isp must be a positive number of seconds, got ${isp_s}`);
}

/**
 * Propellant mass (kg) to deliver Δv from a wet mass: m_p = m₀ (1 − e^(−Δv / (Isp·g₀))).
 * Returns a plain number (the old JSDoc promised an object, which caused the
 * flight controller's burns to silently do nothing).
 */
export function tsiolkovskyFuel(deltaV_ms, wetMassKg, isp_s) {
    requireIsp(isp_s);
    if (!(deltaV_ms > 0) || !(wetMassKg > 0)) return 0;
    return wetMassKg * (1 - Math.exp(-deltaV_ms / (isp_s * G0)));
}

/** Δv capacity (m/s) of the remaining propellant: Isp·g₀·ln((m_dry+m_p)/m_dry). */
export function maxDeltaV(fuelMassKg, dryMassKg, isp_s) {
    requireIsp(isp_s);
    if (!(fuelMassKg > 0) || !(dryMassKg > 0)) return 0;
    return isp_s * G0 * Math.log((fuelMassKg + dryMassKg) / dryMassKg);
}

/** Mean motion of a circular orbit, rad/s. */
export function meanMotion(altKm) {
    const r = RE + altKm * 1000;
    return Math.sqrt(GM / (r * r * r));
}

/** Circular orbital speed, km/s. */
export function orbitalVelocity(altKm) {
    return Math.sqrt(GM / (RE + altKm * 1000)) / 1000;
}

/** Circular orbital period, minutes. */
export function orbitalPeriod(altKm) {
    const r = RE + altKm * 1000;
    return 2 * Math.PI * Math.sqrt(r * r * r / GM) / 60;
}

/**
 * Change in semi-major axis (km) from a small tangential Δv on a circular orbit.
 * From the vis-viva equation: δa = 2 a² v δv / GM = 2 a δv / v.
 * At 420 km that is ≈ 1.77 km per m/s prograde.
 */
export function semiMajorAxisChange(dvTangential_ms, altKm) {
    const a = RE + altKm * 1000;
    const v = Math.sqrt(GM / a);
    return (2 * a * dvTangential_ms / v) / 1000;
}

/** Total Δv (m/s) of a two-burn Hohmann transfer between circular orbits. */
export function hohmannDeltaV(fromAltKm, toAltKm) {
    const r1 = RE + fromAltKm * 1000;
    const r2 = RE + toAltKm * 1000;
    const at = (r1 + r2) / 2;
    const v1 = Math.sqrt(GM / r1), v2 = Math.sqrt(GM / r2);
    const vp = Math.sqrt(GM * (2 / r1 - 1 / at));
    const va = Math.sqrt(GM * (2 / r2 - 1 / at));
    return Math.abs(vp - v1) + Math.abs(v2 - va);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Relative motion — Clohessy–Wiltshire response to an impulse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Displacement (m) of the satellite from where it would have been, a time t after
 * an impulsive burn (dvR radial-out, dvT prograde, dvN orbit-normal, all m/s),
 * from the closed-form Clohessy–Wiltshire (Hill) solution with zero initial offset:
 *
 *   x(t) = (ẋ₀/n) sin nt + (2ẏ₀/n)(1 − cos nt)                 radial
 *   y(t) = (2ẋ₀/n)(cos nt − 1) + (ẏ₀/n)(4 sin nt − 3nt)         along-track
 *   z(t) = (ż₀/n) sin nt                                        cross-track
 *
 * Key consequence for collision avoidance: a prograde burn half an orbit before
 * closest approach raises the satellite by 4·Δv/n ≈ 3.5 km per m/s at 420 km.
 */
export function cwDisplacement(dvR, dvT, dvN, n, t) {
    const nt = n * t;
    const s = Math.sin(nt), c = Math.cos(nt);
    return {
        x: (dvR / n) * s + (2 * dvT / n) * (1 - c),
        y: (2 * dvR / n) * (c - 1) + (dvT / n) * (4 * s - 3 * nt),
        z: (dvN / n) * s,
    };
}

/**
 * Project a radial/along-track/cross-track displacement into the conjunction
 * B-plane (the plane perpendicular to the relative velocity).
 * For two objects in the local horizontal plane crossing at angle φ, the relative
 * velocity direction is (−sin φ/2, cos φ/2) in (along, cross) axes, so:
 *   ξ (radial axis)     = x
 *   ζ (horizontal axis) = y·cos(φ/2) + z·sin(φ/2)
 * Along-track shift is useless for a head-on pass (φ = 180°) — it only changes timing.
 */
export function bPlaneShift(disp, crossingDeg) {
    const h = (crossingDeg * Math.PI / 180) / 2;
    return { xi: disp.x, zeta: disp.y * Math.cos(h) + disp.z * Math.sin(h) };
}

/** Relative speed (m/s) of two equal-speed circular orbits crossing at angle φ. */
export function relativeSpeed(orbitalSpeedMs, crossingDeg) {
    return 2 * orbitalSpeedMs * Math.sin((crossingDeg * Math.PI / 180) / 2);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Collision probability — Chan's series, isotropic covariance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probability that the true miss vector falls inside the combined hard-body disk.
 *
 * In the B-plane the miss vector is Gaussian with mean d (predicted miss distance)
 * and isotropic standard deviation σ. Pc is the integral of that Gaussian over a
 * disk of radius R at the origin. Chan (1997, 2008) gives the exact series for the
 * isotropic case, with u = R²/σ² and v = d²/σ²:
 *
 *   Pc = Σₘ e^(−v/2) (v/2)ᵐ/m! · [1 − e^(−u/2) Σₖ₌₀ᵐ (u/2)ᵏ/k!]
 *
 * i.e. Σₘ Poisson(m; v/2) · P(Poisson(u/2) > m). It equals 1 − Q₁(d/σ, R/σ)
 * (Marcum Q). At d = 0 it reduces to 1 − exp(−R²/2σ²) — the original code
 * returned 1 there.
 *
 * @param {number} missDist_m  predicted miss distance at TCA (m)
 * @param {number} sigma_m     1-σ combined position uncertainty in the B-plane (m)
 * @param {number} radius_m    combined hard-body radius (m)
 */
export function chanCollisionProbability(missDist_m, sigma_m, radius_m) {
    if (!(sigma_m > 0) || !(radius_m > 0)) return 0;
    const d = Math.max(0, missDist_m);
    if (d - radius_m > 14 * sigma_m) return 0; // < 1e-40, below any meaningful threshold

    const lam = (d * d) / (2 * sigma_m * sigma_m);           // v/2
    const mu = (radius_m * radius_m) / (2 * sigma_m * sigma_m); // u/2

    // Outer Poisson(λ) terms with non-negligible mass.
    const mMax = Math.ceil(lam + 12 * Math.sqrt(lam) + 25);
    // Inner tail P(Poisson(μ) > m), summed from the top down for numerical stability.
    const kMax = Math.max(mMax + 1, Math.ceil(mu + 12 * Math.sqrt(mu) + 25));
    const pmfMu = new Float64Array(kMax + 2);
    const logMu = Math.log(mu);
    let lf = 0; // running log(k!)
    for (let k = 0; k <= kMax + 1; k++) {
        if (k > 0) lf += Math.log(k);
        pmfMu[k] = Math.exp(-mu + (k > 0 ? k * logMu : 0) - lf);
    }
    const tail = new Float64Array(kMax + 2); // tail[m] = Σ_{k>m} pmf
    let acc = 0;
    for (let k = kMax + 1; k >= 0; k--) { tail[k] = acc; acc += pmfMu[k]; }
    tail[0] = -Math.expm1(-mu); // exact for m = 0 (avoids cancellation when μ is tiny)

    let pc = 0;
    let logFact = 0;
    for (let m = 0; m <= mMax; m++) {
        if (m > 0) logFact += Math.log(m);
        const logPois = -lam + (m > 0 ? m * Math.log(lam || 1e-300) : 0) - logFact;
        const w = lam === 0 ? (m === 0 ? 1 : 0) : Math.exp(logPois);
        pc += w * tail[Math.min(m, kMax + 1)];
        if (lam === 0) break;
    }
    return Math.min(1, Math.max(0, pc));
}

/**
 * Risk bands. 1e-4 is the manoeuvre threshold used by NASA's Conjunction
 * Assessment Risk Analysis (CARA) programme.
 */
export function classifyCollisionRisk(pc) {
    if (pc >= 1e-3) return { level: 'critical', label: 'CRITICAL', color: '#ff2244' };
    if (pc >= 1e-4) return { level: 'warning', label: 'HIGH', color: '#ff8800' };
    if (pc >= 1e-5) return { level: 'caution', label: 'ELEVATED', color: '#ffdd00' };
    if (pc >= 1e-7) return { level: 'low', label: 'LOW', color: '#00ff88' };
    return { level: 'nominal', label: 'NOMINAL', color: '#00ccff' };
}

/** e.g. 0.00034 → "3.40e-4"; values under 1e-12 print as "< 1e-12". */
export function formatPc(pc) {
    if (!(pc > 1e-12)) return '< 1e-12';
    if (pc >= 1) return '1.00e+0';
    return pc.toExponential(2);
}
