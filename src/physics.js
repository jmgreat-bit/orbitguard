/**
 * Co-Pilot Physics Engine
 * Ported and adapted from Detour (TreeHacks 2026) — Python → JavaScript
 *
 * Implements:
 *   1. J2 Perturbation         — Earth oblateness causes RAAN drift
 *   2. Atmospheric Drag Model  — Exponential density model causes orbital decay
 *   3. Tsiolkovsky Equation    — Realistic fuel-burn calculations
 *   4. Chan Collision Probability — B-plane projection for debris Pc
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
export const GM = 3.986004418e14; // m³/s²  Earth gravitational parameter
export const RE = 6.371e6;        // m       Earth mean radius
export const J2 = 1.08263e-3;     // —       Earth oblateness coefficient
export const G0 = 9.80665;        // m/s²    Standard gravity

// Atmospheric density model — references (alt km → base density kg/m³, scale height km)
// Simplified NRLMSISE-style exponential bands (good enough for LEO dashboard)
const ATMO_LAYERS = [
    { altKm: 0, rho0: 1.225, H: 8.44 },
    { altKm: 25, rho0: 3.899e-2, H: 6.49 },
    { altKm: 30, rho0: 1.774e-2, H: 6.75 },
    { altKm: 40, rho0: 3.972e-3, H: 7.47 },
    { altKm: 50, rho0: 1.057e-3, H: 8.38 },
    { altKm: 60, rho0: 3.206e-4, H: 7.71 },
    { altKm: 70, rho0: 8.770e-5, H: 6.34 },
    { altKm: 80, rho0: 1.905e-5, H: 5.80 },
    { altKm: 90, rho0: 3.396e-6, H: 5.53 },
    { altKm: 100, rho0: 5.604e-7, H: 7.80 },
    { altKm: 110, rho0: 9.708e-8, H: 8.10 },
    { altKm: 120, rho0: 2.222e-8, H: 9.50 },
    { altKm: 150, rho0: 2.438e-9, H: 22.2 },
    { altKm: 180, rho0: 5.416e-10, H: 29.9 },
    { altKm: 200, rho0: 1.714e-10, H: 37.5 },
    { altKm: 250, rho0: 3.845e-11, H: 45.5 },
    { altKm: 300, rho0: 9.518e-12, H: 53.3 },
    { altKm: 350, rho0: 2.985e-12, H: 53.3 },
    { altKm: 400, rho0: 1.057e-12, H: 58.2 },
    { altKm: 450, rho0: 3.845e-13, H: 65.5 },
    { altKm: 500, rho0: 1.170e-13, H: 73.5 },
    { altKm: 600, rho0: 1.844e-14, H: 84.0 },
    { altKm: 700, rho0: 3.614e-15, H: 100.0 },
    { altKm: 800, rho0: 1.170e-15, H: 111.0 },
    { altKm: 900, rho0: 5.245e-16, H: 116.0 },
];

// ─────────────────────────────────────────────────────────────────────────────
// 1. Atmospheric Density (exponential model)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns atmospheric density in kg/m³ at the given altitude (km).
 * Uses a piecewise exponential model matching the standard atmosphere.
 * @param {number} altKm - Altitude above Earth surface in km
 * @returns {number} Density in kg/m³
 */
export function atmosphericDensity(altKm) {
    if (altKm > 1000) return 0;
    if (altKm < 0) return ATMO_LAYERS[0].rho0;

    // Find the right layer
    let layer = ATMO_LAYERS[0];
    for (let i = ATMO_LAYERS.length - 1; i >= 0; i--) {
        if (altKm >= ATMO_LAYERS[i].altKm) {
            layer = ATMO_LAYERS[i];
            break;
        }
    }

    return layer.rho0 * Math.exp(-(altKm - layer.altKm) / layer.H);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Atmospheric Drag — Altitude Decay
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes altitude change (km/s) due to atmospheric drag.
 * Simplified model: treats orbit as circular, drag continuously reduces energy.
 *
 * @param {number} altKm      - Current altitude in km
 * @param {number} velocityMs - Orbital velocity in m/s
 * @param {number} Cd         - Drag coefficient (typical 2.2 for cubesats)
 * @param {number} Am         - Area-to-mass ratio in m²/kg (typical 0.01–0.05)
 * @param {number} Kp         - Geomagnetic Kp index (0-9), inflates density
 * @returns {number} Altitude decay rate in km/s (negative = decaying)
 */
export function dragDecayRate(altKm, velocityMs, Cd = 2.2, Am = 0.02, Kp = 3) {
    const r = (RE / 1000 + altKm) * 1000; // orbital radius in m
    const rho = atmosphericDensity(altKm) * (1 + Kp * 0.1); // Kp inflates density
    const v = velocityMs;

    // Drag acceleration magnitude (m/s²)
    const aDrag = 0.5 * Cd * Am * rho * v * v;

    // Energy decay: dE/dt = -F_drag * v
    // For circular orbit: E = -GM*m / (2r), dE = GMm/(2r²) dr
    // So dr/dt = -2r² * aDrag / (GM)  [simplified, ignores second-order!]
    const drdt_ms = -(2 * r * r * aDrag) / GM; // m/s
    return drdt_ms / 1000; // km/s
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. J2 Perturbation — RAAN Drift
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the J2-induced Right Ascension of Ascending Node (RAAN) drift rate.
 * This causes the orbital plane to precess around Earth's pole.
 *
 * @param {number} altKm       - Altitude in km
 * @param {number} inclDeg     - Inclination in degrees
 * @param {number} eccentricity - Orbital eccentricity
 * @returns {number} RAAN drift rate in degrees/day
 */
export function j2RaanDrift(altKm, inclDeg, eccentricity = 0) {
    const a = (RE + altKm * 1000);       // semi-major axis in m
    const i = inclDeg * Math.PI / 180;
    const e = eccentricity;
    const n = Math.sqrt(GM / (a * a * a)); // mean motion rad/s

    // J2 RAAN drift: Ω̇ = -3/2 * n * J2 * (RE/a)² * cos(i) / (1-e²)²
    const drift_rad_s = -(3 / 2) * n * J2 *
        Math.pow(RE / a, 2) * Math.cos(i) /
        Math.pow(1 - e * e, 2);

    return drift_rad_s * (180 / Math.PI) * 86400; // deg/day
}

/**
 * Computes the J2-induced altitude oscillation at the current orbital phase.
 * Earth's equatorial bulge causes the satellite to be slightly higher at the
 * poles and lower at the equator (for ISS-like inclinations).
 *
 * @param {number} baseAltKm   - Mean altitude in km
 * @param {number} latDeg      - Current latitude in degrees
 * @param {number} inclDeg     - Inclination in degrees
 * @returns {number} Corrected altitude in km
 */
export function j2AltitudeCorrection(baseAltKm, latDeg, inclDeg = 51.6) {
    // J2 causes ~5-15km oscillation over an orbit for ISS-like orbits
    const lat = latDeg * Math.PI / 180;
    const incl = inclDeg * Math.PI / 180;
    const amplitude = baseAltKm * J2 * Math.pow(RE / ((RE + baseAltKm * 1000)), 2) * 3 / 2;
    return baseAltKm + amplitude * (1 - 3 * Math.sin(lat) * Math.sin(lat)) * Math.cos(incl);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Tsiolkovsky Rocket Equation — Fuel Consumption
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes propellant mass needed to achieve a given delta-v.
 * Uses the Tsiolkovsky rocket equation: Δv = Isp * g0 * ln(m0/mf)
 *
 * @param {number} deltaV_ms   - Required delta-v in m/s
 * @param {number} wetMassKg   - Current total mass (dry + fuel) in kg
 * @param {number} isp_s       - Specific impulse in seconds (cold gas ~50, hydrazine ~220)
 * @returns {object} { fuelKg, fuelPercent, feasible }
 */
export function tsiolkovskyFuel(deltaV_ms, wetMassKg, isp_s = 220) {
    const ve = isp_s * G0; // exhaust velocity m/s
    // m_propellant = m_wet * (1 - exp(-Δv/ve))
    const fuelKg = wetMassKg * (1 - Math.exp(-deltaV_ms / ve));
    return fuelKg;
}

/**
 * Computes current max achievable delta-v given remaining fuel.
 *
 * @param {number} fuelMassKg  - Current fuel mass in kg
 * @param {number} dryMassKg   - Dry mass (no fuel) in kg
 * @param {number} isp_s       - Specific impulse in seconds
 * @returns {number} Max delta-v in m/s
 */
export function maxDeltaV(fuelMassKg, dryMassKg, isp_s = 220) {
    if (fuelMassKg <= 0 || dryMassKg <= 0) return 0;
    const ve = isp_s * G0;
    const wetMass = fuelMassKg + dryMassKg;
    return ve * Math.log(wetMass / dryMassKg);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Chan Collision Probability (B-plane projection)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes collision probability using Chan's method.
 * Projects 3D relative state and position uncertainty onto the B-plane
 * (plane perpendicular to relative velocity), then integrates a 2D Gaussian
 * over a disk of the combined hard-body radius.
 *
 * Ported from Detour's Python implementation (chan_probability.py).
 *
 * @param {number} missDist_m     - Miss distance at TCA in meters
 * @param {number} relVel_ms      - Relative velocity at TCA in m/s
 * @param {number} sigma_m        - Position uncertainty (1-sigma) in meters
 * @param {number} collRadius_m   - Combined hard-body radius in meters (sum of object radii)
 * @returns {number} Collision probability (0 to 1)
 */
export function chanCollisionProbability(missDist_m, relVel_ms, sigma_m = 1000, collRadius_m = 10) {
    // For our simplified 2D case (circular covariance):
    // The B-plane covariance is isotropic: C = diag(σ², σ²)
    // Pc = integral over disk of radius R of 2D Gaussian centered at (d, 0)
    // where d = miss distance.
    //
    // Exact: Pc = exp(-d²/(2σ²)) * I0(d*R/σ²) * exp(-R²/(2σ²))
    // Approximation (Chan 1997 simplified): integrate numerically on 2D polar grid
    //
    // For speed, we use the Marcum Q-function approximation:
    // Pc ≈ Q1(d/σ, R/σ) where Q1 is the Marcum Q function of order 1.
    // We approximate Q1 via numerical integration.

    if (sigma_m <= 0 || collRadius_m <= 0) return 0;
    if (missDist_m <= 0) return 1;

    const d = missDist_m;
    const R = collRadius_m;
    const sigma = sigma_m;

    // Numerical polar integration (simplified from Detour's vectorized version)
    // n_r = 60, n_theta = 32 is fast enough for real-time
    const n_r = 60;
    const n_theta = 32;

    const norm = 1 / (2 * Math.PI * sigma * sigma);
    const dtheta = 2 * Math.PI / n_theta;
    const dr = R / n_r;

    let integral = 0;
    for (let ti = 0; ti < n_theta; ti++) {
        const theta = ti * dtheta;
        const cost = Math.cos(theta);
        const sint = Math.sin(theta);

        for (let ri = 0; ri < n_r; ri++) {
            const r = (ri + 0.5) * dr;
            // Point in B-plane: (r*cos θ, r*sin θ)
            // Offset from miss-distance center: (r*cos θ - d, r*sin θ)
            const dx = r * cost - d;
            const dy = r * sint;
            const exp_arg = -(dx * dx + dy * dy) / (2 * sigma * sigma);
            integral += Math.exp(exp_arg) * r * dr * dtheta;
        }
    }

    const prob = norm * integral;
    return Math.max(0, Math.min(1, prob));
}

/**
 * Classifies collision probability into human-readable risk levels.
 * Uses NASA/ESA standard thresholds.
 *
 * @param {number} pc - Collision probability (0-1)
 * @returns {{ level: string, label: string, color: string }}
 */
export function classifyCollisionRisk(pc) {
    if (pc >= 1e-3) return { level: 'critical', label: 'CRITICAL', color: '#ff2244' };
    if (pc >= 1e-4) return { level: 'warning', label: 'HIGH', color: '#ff8800' };
    if (pc >= 1e-5) return { level: 'caution', label: 'ELEVATED', color: '#ffdd00' };
    if (pc >= 1e-6) return { level: 'low', label: 'LOW', color: '#00ff88' };
    return { level: 'nominal', label: 'NOMINAL', color: '#00ccff' };
}

/**
 * Formats a collision probability as a scientific notation string.
 * e.g. 0.00034 → "3.40e-4"
 * @param {number} pc
 * @returns {string}
 */
export function formatPc(pc) {
    if (pc <= 0) return '< 1e-9';
    if (pc >= 1) return '1.00e+0';
    return pc.toExponential(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Orbital Velocity from Altitude
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes circular orbital velocity at a given altitude.
 * @param {number} altKm - Altitude in km
 * @returns {number} Orbital velocity in km/s
 */
export function orbitalVelocity(altKm) {
    const r = (RE + altKm * 1000); // meters
    return Math.sqrt(GM / r) / 1000; // km/s
}

/**
 * Computes orbital period at a given altitude.
 * @param {number} altKm - Altitude in km
 * @returns {number} Period in minutes
 */
export function orbitalPeriod(altKm) {
    const r = (RE + altKm * 1000);
    return 2 * Math.PI * Math.sqrt(r * r * r / GM) / 60;
}
