/**
 * Conjunction screening — how real operators see debris.
 *
 * A 1U CubeSat has no 200 km LIDAR; debris warnings come from ground tracking as
 * conjunction data messages (CDMs): time of closest approach (TCA), predicted miss
 * vector in the B-plane, its uncertainty σ and a collision probability Pc. That is
 * what this module simulates:
 *
 *  - events are discovered hours before TCA, with σ shrinking as TCA approaches
 *    (tracking improves), so Pc rises and falls the way real CDM series do;
 *  - Pc uses Chan's exact isotropic formula (physics.js);
 *  - a burn shifts every upcoming miss vector by the Clohessy–Wiltshire response
 *    projected into each event's B-plane — so avoidance actually works, and can
 *    make a different event worse;
 *  - at TCA the outcome is drawn from the uncertainty: rare, but collisions happen.
 *
 * Object names come from real debris families (2021 Cosmos 1408 ASAT test, 2007
 * Fengyun-1C test, 2009 Iridium-33/Cosmos-2251 collision …). Catalogue numbers and
 * encounter geometry are synthetic.
 */
import {
    chanCollisionProbability, classifyCollisionRisk, formatPc,
    cwDisplacement, bPlaneShift, relativeSpeed,
} from '../physics.js';

const FAMILIES = [
    'COSMOS 1408 DEB', 'FENGYUN 1C DEB', 'COSMOS 2251 DEB', 'IRIDIUM 33 DEB',
    'CZ-6A DEB', 'NOAA 16 DEB', 'SL-8 R/B', 'COSMOS 1484 DEB', 'PSLV DEB', 'DELTA 1 DEB',
];

export const PC_MANEUVER_THRESHOLD = 1e-4;   // NASA CARA red threshold
export const PC_SAFE_TARGET = 1e-6;

export class ConjunctionManager {
    /**
     * @param {object} opts
     * @param {() => number} [opts.rng]
     * @param {number} [opts.ratePerHour]   mean screening events per simulated hour
     * @param {number} [opts.maxActive]
     * @param {number} [opts.hardBodyRadius_m]
     */
    constructor({ rng = Math.random, ratePerHour = 0.35, maxActive = 4, hardBodyRadius_m = 10 } = {}) {
        this.rng = rng;
        this.ratePerHour = ratePerHour;
        this.maxActive = maxActive;
        this.hardBodyRadius_m = hardBodyRadius_m;
        this.events = [];
        this.history = [];
        this._seq = 1;
    }

    _gauss() {
        let u = 0, v = 0;
        while (u === 0) u = this.rng();
        while (v === 0) v = this.rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    sigmaAt(ev, now) {
        const hours = Math.max(0, (ev.tca - now) / 3600);
        return ev.sigmaFloor_m + ev.sigmaGrowth_mPerH * hours;
    }

    /**
     * Create a screening event. All options are optional (random if omitted).
     * @returns the event
     */
    spawn(now, { leadS, missM, crossingDeg, name, orbitalSpeedMs = 7660 } = {}) {
        const r = this.rng;
        const lead = leadS ?? (1.5 + 6.5 * r()) * 3600;
        const miss = missM ?? Math.exp(Math.log(80) + (Math.log(15000) - Math.log(80)) * r());
        const ang = 2 * Math.PI * r();
        const cross = crossingDeg ?? (20 + 160 * r());
        const family = name ?? FAMILIES[Math.floor(r() * FAMILIES.length)];
        const ev = {
            id: `${family} [${40000 + Math.floor(r() * 19999)}]`,
            name: family,
            seq: this._seq++,
            discovered: now,
            tca: now + lead,
            xi: miss * Math.cos(ang),        // radial component of the miss vector (m)
            zeta: miss * Math.sin(ang),      // horizontal B-plane component (m)
            crossingDeg: cross,
            relVel_ms: relativeSpeed(orbitalSpeedMs, cross),
            sigmaFloor_m: 30,
            sigmaGrowth_mPerH: 120,
            hardBodyRadius_m: this.hardBodyRadius_m,
            sizeM: 0.05 + r() * (family.includes('R/B') ? 8 : 0.6),
            peakPc: 0,
            maneuvered: false,
        };
        this._evaluate(ev, now);
        ev.escalated = ev.pc >= PC_MANEUVER_THRESHOLD; // the 'new' notification already covers it
        this.events.push(ev);
        this.events.sort((a, b) => a.tca - b.tca);
        return ev;
    }

    _evaluate(ev, now) {
        ev.sigma_m = this.sigmaAt(ev, now);
        ev.missDistance_m = Math.hypot(ev.xi, ev.zeta);
        ev.pc = chanCollisionProbability(ev.missDistance_m, ev.sigma_m, ev.hardBodyRadius_m);
        ev.peakPc = Math.max(ev.peakPc, ev.pc);
        const risk = classifyCollisionRisk(ev.pc);
        ev.riskLevel = risk.level;
        ev.riskLabel = risk.label;
        ev.riskColor = risk.color;
        ev.pcFormatted = formatPc(ev.pc);
        ev.timeToTca_s = ev.tca - now;
        ev.range_m = this.rangeAt(ev, now);
    }

    /** Straight-line relative range (m) — fine within minutes of TCA, a rough figure before. */
    rangeAt(ev, now) {
        return Math.hypot(ev.missDistance_m ?? Math.hypot(ev.xi, ev.zeta), ev.relVel_ms * (now - ev.tca));
    }

    /**
     * Advance to `now`. Returns { spawned: [], passed: [], escalated: [] } where passed
     * entries carry the realised outcome { realizedMiss_m, collision } and escalated lists
     * events whose Pc has just risen through the manoeuvre threshold (tracking tightened).
     */
    tick(now, dt, orbitalSpeedMs = 7660) {
        const out = { spawned: [], passed: [], escalated: [] };
        if (this.events.length < this.maxActive && this.ratePerHour > 0) {
            const p = 1 - Math.exp(-this.ratePerHour * dt / 3600);
            if (this.rng() < p) out.spawned.push(this.spawn(now, { orbitalSpeedMs }));
        }
        for (const ev of [...this.events]) {
            if (now >= ev.tca) {
                const s = this.sigmaAt(ev, ev.tca);
                const rx = ev.xi + s * this._gauss();
                const rz = ev.zeta + s * this._gauss();
                const realized = Math.hypot(rx, rz);
                const result = {
                    ...ev, realizedMiss_m: realized,
                    collision: realized < ev.hardBodyRadius_m,
                };
                this.events.splice(this.events.indexOf(ev), 1);
                this.history.unshift(result);
                this.history.length = Math.min(this.history.length, 20);
                out.passed.push(result);
            } else {
                this._evaluate(ev, now);
                if (!ev.escalated && ev.pc >= PC_MANEUVER_THRESHOLD) { ev.escalated = true; out.escalated.push(ev); }
                else if (ev.escalated && ev.pc < PC_MANEUVER_THRESHOLD / 10) ev.escalated = false; // re-arm
            }
        }
        return out;
    }

    /** Apply a (small, impulsive) velocity change in RTN axes to every upcoming event. */
    applyImpulse(dvR, dvT, dvN, now, n) {
        for (const ev of this.events) {
            const dtToTca = ev.tca - now;
            if (dtToTca <= 0) continue;
            const s = bPlaneShift(cwDisplacement(dvR, dvT, dvN, n, dtToTca), ev.crossingDeg);
            ev.xi += s.xi;
            ev.zeta += s.zeta;
            ev.maneuvered = true;
            this._evaluate(ev, now);
        }
    }

    /** Miss vector and Pc an event would have after a hypothetical impulse now. */
    preview(ev, dvR, dvT, dvN, now, n) {
        const s = bPlaneShift(cwDisplacement(dvR, dvT, dvN, n, ev.tca - now), ev.crossingDeg);
        const miss = Math.hypot(ev.xi + s.xi, ev.zeta + s.zeta);
        return { miss_m: miss, pc: chanCollisionProbability(miss, this.sigmaAt(ev, now), ev.hardBodyRadius_m) };
    }

    /**
     * What a hypothetical impulse now would do to the whole screening list.
     * @returns {{ worstBefore: number, worstAfter: number, worstAfterId: string|null, n: number }}
     */
    assessImpulse(dvR, dvT, dvN, now, n) {
        let worstBefore = 0, worstAfter = 0, worstAfterId = null, count = 0;
        for (const ev of this.events) {
            if (ev.tca - now <= 0) continue;
            count++;
            const before = chanCollisionProbability(Math.hypot(ev.xi, ev.zeta), this.sigmaAt(ev, now), ev.hardBodyRadius_m);
            const after = this.preview(ev, dvR, dvT, dvN, now, n).pc;
            worstBefore = Math.max(worstBefore, before);
            if (after > worstAfter) { worstAfter = after; worstAfterId = ev.id; }
        }
        return { worstBefore, worstAfter, worstAfterId, n: count };
    }

    /**
     * Smallest along-track or radial burn (≤ maxDv) that brings EVERY upcoming event
     * under targetPc. Returns null if none found.
     */
    solveAvoidance(now, n, { targetPc = PC_SAFE_TARGET, maxDv = 1.0, step = 0.01 } = {}) {
        const upcoming = this.events.filter(e => e.tca - now > 60);
        if (!upcoming.length) return null;
        const dirs = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0]]; // prograde, retrograde, radial ±
        for (let dv = step; dv <= maxDv + 1e-9; dv += step) {
            let best = null;
            for (const d of dirs) {
                const worst = Math.max(...upcoming.map(e => this.preview(e, d[0] * dv, d[1] * dv, d[2] * dv, now, n).pc));
                if (worst < targetPc && (!best || worst < best.worstPc)) best = { vectorRTN: d, deltaV: +dv.toFixed(3), worstPc: worst };
            }
            if (best) return best;
        }
        return null;
    }

    mostDangerous() {
        return this.events.reduce((a, b) => (!a || b.pc > a.pc ? b : a), null);
    }
}
