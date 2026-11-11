/**
 * Lumped-node radiative thermal model for a 1U CubeSat.
 *
 * Replaces the original fixed "+2.5 °C/min in sun, −1.5 °C/min in shadow" rates, which
 * have no equilibrium: every section climbed ~37 °C per orbit and sat on the 130 °C clamp.
 * Here each node obeys C·dT/dt = Q_in − Q_out, so temperatures settle into a realistic
 * orbit-periodic swing:
 *
 *   external nodes (structure/radiator, two deployable panels):
 *     Q_in  = direct sun (α·A·S) + Earth IR (ε·A_ir·237 W/m²·F) + albedo (0.3·S·…) + dissipation
 *     Q_out = ε·σ·A_rad·T⁴ (to deep space) + conduction to neighbours
 *   internal nodes (battery, OBC, payload, radio, propulsion):
 *     electrical dissipation in, conduction to the structure out.
 */
import { SIGMA_SB, SOLAR_CONSTANT } from '../physics.js';

const EARTH_IR = 237;   // W/m², orbit-average outgoing long-wave radiation
const ALBEDO = 0.30;
const K0 = 273.15;

/** Node parameters. C: heat capacity J/K. link: conductance to the structure W/K. */
export const THERMAL_NODES = {
    thermalRadiator: { label: 'Structure & radiator', C: 420, eps: 0.74, radArea: 0.061, irArea: 0.016, albArea: 0.011 },
    solarPanelA: { label: 'Solar panel A', C: 75, eps: 0.83, radArea: 0.0254, area: 0.0127, alpha: 0.91, alphaBack: 0.80, irArea: 0.008, link: 0.06 },
    solarPanelB: { label: 'Solar panel B', C: 75, eps: 0.83, radArea: 0.0254, area: 0.0127, alpha: 0.91, alphaBack: 0.80, irArea: 0.008, link: 0.06 },
    batteryBay: { label: 'Battery', C: 110, link: 0.15 },   // isolated pack + heater, as flown
    onboardComputer: { label: 'OBC', C: 60, link: 0.55, strap: true },
    payloadBay: { label: 'Payload', C: 120, link: 0.45, strap: true },
    commArray: { label: 'Radio', C: 70, link: 0.45, strap: true },
    thrusterPod: { label: 'Propulsion', C: 160, link: 0.40 },
};

/**
 * Sun absorptance × projected area of the bus (m²) for each attitude.
 * Sun-avoid (DEEP_SPACE) turns the low-α radiator end face to the Sun.
 */
export const BODY_SUN_ALPHA_AREA = {
    SUN_TRACKING: 0.0090,
    EARTH_NADIR: 0.0105,
    VELOCITY_ALIGNED: 0.0100,
    MANEUVER_ALIGNMENT: 0.0100,
    DEEP_SPACE: 0.0025,
    SAFE_TUMBLE_STOP: 0.0115,
};

/**
 * Operating limits per section (°C). warn = outside the comfortable band,
 * crit = outside the qualified range. Battery limits follow Li-ion practice
 * (no charging below 0 °C, damage above ~55 °C).
 */
export const THERMAL_LIMITS = {
    solarPanelA: { warnLo: -75, warnHi: 95, critLo: -95, critHi: 115 },
    solarPanelB: { warnLo: -75, warnHi: 95, critLo: -95, critHi: 115 },
    batteryBay: { warnLo: 2, warnHi: 40, critLo: -10, critHi: 55 },
    onboardComputer: { warnLo: -20, warnHi: 60, critLo: -35, critHi: 80 },
    payloadBay: { warnLo: -15, warnHi: 50, critLo: -25, critHi: 65 },
    commArray: { warnLo: -20, warnHi: 60, critLo: -30, critHi: 75 },
    thrusterPod: { warnLo: -15, warnHi: 50, critLo: -25, critHi: 65 },
    thermalRadiator: { warnLo: -40, warnHi: 70, critLo: -60, critHi: 90 },
};

/**
 * Advance node temperatures by dt seconds (sub-stepped for stability).
 * @param {Object<string, number>} T   temperatures °C, mutated in place
 * @param {number} dt                 seconds
 * @param {Object} env
 *   inSun (bool), flux (W/m²), attitudeMode, earthView (0..1 ≈ (Re/r)²),
 *   albedoCos (cos of sun-zenith angle at the sub-satellite point, ≥0),
 *   panels: { A: {cos, electricW, deployed}, B: {...} },
 *   dissipation: { node: W }, heatStrapOk (bool)
 * @returns {{radiatedW: number}} heat rejected by the structure (for display)
 */
export function stepThermal(T, dt, env) {
    let radiatedW = 0;
    const steps = Math.max(1, Math.ceil(dt / 5));
    const h = dt / steps;
    const flux = env.inSun ? env.flux : 0;
    const alb = env.inSun ? ALBEDO * env.flux * Math.max(0, env.albedoCos) * env.earthView : 0;
    const ir = EARTH_IR * env.earthView;

    for (let s = 0; s < steps; s++) {
        const Tb = T.thermalRadiator;
        const dQ = {};
        for (const key of Object.keys(THERMAL_NODES)) dQ[key] = env.dissipation[key] || 0;

        // ── structure / radiator ──
        const body = THERMAL_NODES.thermalRadiator;
        const bodyAlphaA = BODY_SUN_ALPHA_AREA[env.attitudeMode] ?? 0.0105;
        const TbK = Tb + K0;
        const bodyOut = body.eps * SIGMA_SB * body.radArea * TbK ** 4;
        dQ.thermalRadiator += flux * bodyAlphaA + body.eps * ir * body.irArea + 0.6 * alb * body.albArea - bodyOut;
        radiatedW = bodyOut;

        // ── deployable panels ──
        for (const id of ['A', 'B']) {
            const key = `solarPanel${id}`;
            const p = THERMAL_NODES[key];
            const st = env.panels[id];
            const TK = T[key] + K0;
            const deployed = st.deployed !== false;
            const cos = st.cos;
            const sunIn = flux * p.area * (cos >= 0 ? p.alpha * cos : p.alphaBack * -cos) * (deployed ? 1 : 0.3);
            const out = p.eps * SIGMA_SB * p.radArea * (deployed ? 1 : 0.5) * TK ** 4;
            const link = deployed ? p.link : 0.5;
            const cond = link * (Tb - T[key]);
            dQ[key] += sunIn - (st.electricW || 0) + p.eps * ir * p.irArea + 0.5 * alb * p.irArea - out + cond;
            dQ.thermalRadiator -= cond;
        }

        // ── internal nodes: conduction to the structure ──
        for (const [key, node] of Object.entries(THERMAL_NODES)) {
            if (!node.link || key.startsWith('solarPanel')) continue;
            const g = node.link * (node.strap && env.heatStrapOk === false ? 0.2 : 1);
            const cond = g * (Tb - T[key]);
            dQ[key] += cond;
            dQ.thermalRadiator -= cond;
        }

        for (const [key, node] of Object.entries(THERMAL_NODES)) {
            T[key] += (dQ[key] / node.C) * h;
        }
    }
    return { radiatedW };
}

/** 'nominal' | 'warning' | 'critical' from the section's limits. */
export function thermalStatus(key, tempC) {
    const L = THERMAL_LIMITS[key];
    if (!L) return 'nominal';
    if (tempC <= L.critLo || tempC >= L.critHi) return 'critical';
    if (tempC <= L.warnLo || tempC >= L.warnHi) return 'warning';
    return 'nominal';
}

export { SOLAR_CONSTANT };
