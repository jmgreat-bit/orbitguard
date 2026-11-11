/**
 * Regression tests for the three autonomy-safety fixes:
 *  1. the collision backstop and threshold-crossing alerts run on simulation time;
 *  2. every burn is checked against the screening list before it is armed and before it fires;
 *  3. plans built from stale telemetry are rejected.
 */
import { describe, it, expect } from 'vitest';
import { VirtualSatellite } from '../src/satellite.js';
import { Autopilot } from '../src/autonomy/autopilot.js';
import { validatePlan, MAX_PLAN_AGE_S } from '../src/autonomy/plan.js';
import { buildTelemetryPrompt } from '../src/autonomy/prompt.js';
import { PC_MANEUVER_THRESHOLD } from '../src/sim/conjunctions.js';
import { meanMotion, cwDisplacement, bPlaneShift } from '../src/physics.js';
import { THERMAL_LIMITS } from '../src/sim/thermal.js';

function seeded(a = 1) {
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const EPOCH = Date.UTC(2026, 9, 14, 6, 0, 0);
const newSat = (opts = {}) => new VirtualSatellite({ epochMs: EPOCH, rng: seeded(42), conjunctionRatePerHour: 0, ...opts });
const collect = (sat, type) => { const out = []; sat.on(type, d => out.push(d)); return out; };
const burn = (vector, dv, extra = {}) => ({
    priority: 'HIGH', ...extra,
    commands: [{ type: 'PLAN_BURN', params: { vector, delta_v: dv, reason: 'test' } }, { type: 'EXECUTE_BURN' }],
});

describe('stale plans', () => {
    it('validatePlan keeps the telemetry timestamp', () => {
        expect(validatePlan({ basedOnT: 12.5, commands: [] }).plan.basedOnT).toBe(12.5);
        expect(validatePlan({ commands: [] }).plan.basedOnT).toBeNull();
        expect(validatePlan({ basedOnT: 'soon', commands: [] }).plan.basedOnT).toBeNull();
    });

    it('rejects a plan built from telemetry older than the limit, accepts a fresh one', () => {
        const sat = newSat();
        const events = collect(sat, 'plan');
        sat.step(600);
        const cmd = [{ type: 'SET_PAYLOAD_STATE', params: { state: 'STANDBY' } }];
        const old = sat.flightController.submitPlan({ basedOnT: sat.missionTime - MAX_PLAN_AGE_S - 1, commands: cmd }, 'gemini');
        expect(old.accepted).toBe(false);
        expect(old.reason).toBe('stale');
        expect(events.some(e => e.kind === 'rejected' && e.command === 'STALE_PLAN')).toBe(true);
        expect(sat.flightController.queue).toHaveLength(0);

        const fresh = sat.flightController.submitPlan({ basedOnT: sat.missionTime - 10, commands: cmd }, 'gemini');
        expect(fresh.accepted).toBe(true);
    });

    it('autopilot plans are stamped with the mission time they were planned at', () => {
        const sat = newSat();
        sat.step(120);
        const p = new Autopilot().decide(sat);
        expect(p.basedOnT).toBe(sat.missionTime);
    });
});

describe('burn verification', () => {
    /**
     * A quiet event half an orbit ahead, placed exactly where a 0.3 m/s prograde burn would
     * carry the satellite: harmless if left alone, a near-certain red alert if that burn flies.
     */
    function trap() {
        const sat = newSat();
        const now = sat.missionTime;
        const ev = sat.conjunctions.spawn(now, { leadS: 2760, missM: 900, crossingDeg: 90 });
        const dv = 0.3;
        const shift = bPlaneShift(cwDisplacement(0, dv, 0, meanMotion(sat.orbit.baseAltitude), ev.tca - now), ev.crossingDeg);
        ev.xi = -shift.xi;
        ev.zeta = -shift.zeta;
        sat.conjunctions.tick(now, 0); // re-evaluate Pc for the new geometry
        expect(Math.hypot(ev.xi, ev.zeta)).toBeGreaterThan(500);
        expect(ev.pc).toBeLessThan(PC_MANEUVER_THRESHOLD / 100);
        return { sat, ev, vector: [1, 0, 0], dv };
    }

    it('vetoes a burn that would raise a quiet conjunction above the manoeuvre threshold', () => {
        const { sat, ev, vector, dv } = trap();
        const events = collect(sat, 'plan');
        const pc0 = ev.pc;
        sat.flightController.submitPlan(burn(vector, dv), 'gemini');
        for (let i = 0; i < 300; i++) sat.step(1);
        const veto = events.find(e => e.kind === 'vetoed' && e.command === 'PLAN_BURN');
        expect(veto?.reason).toMatch(/would raise/);
        expect(sat.propulsion.totalDeltaVUsed).toBe(0);
        expect(sat.flightController.pendingBurn).toBeNull();
        expect(ev.maneuvered).toBe(false);
        expect(ev.pc).toBeLessThan(Math.max(PC_MANEUVER_THRESHOLD, pc0 * 2));
    });

    it('vetoes a burn that leaves a red conjunction red without reducing it', () => {
        const sat = newSat();
        sat.injectEvent('debris_close');
        const ev = sat.conjunctions.events[0];
        expect(ev.pc).toBeGreaterThan(PC_MANEUVER_THRESHOLD);
        const n = meanMotion(sat.orbit.baseAltitude);
        // Pick whichever tiny burn makes things (slightly) worse.
        const dv = 0.002;
        const v = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]].find(d => {
            const a = sat.conjunctions.assessImpulse(d[1] * dv, d[0] * dv, d[2] * dv, sat.missionTime, n);
            return a.worstAfter >= a.worstBefore;
        });
        expect(v).toBeDefined();
        const events = collect(sat, 'plan');
        sat.flightController.submitPlan(burn(v, dv, { priority: 'CRITICAL' }), 'gemini');
        for (let i = 0; i < 60; i++) sat.step(1);
        expect(events.find(e => e.kind === 'vetoed')?.reason).toMatch(/does not reduce/);
        expect(sat.propulsion.totalDeltaVUsed).toBe(0);
    });

    it('lets an ordinary burn fly when nothing is in the screening window', () => {
        const sat = newSat();
        sat.flightController.submitPlan(burn([1, 0, 0], 0.2));
        for (let i = 0; i < 600; i++) sat.step(1);
        expect(sat.propulsion.totalDeltaVUsed).toBeCloseTo(0.2, 6);
    });

    it('re-checks at ignition: a burn armed while safe is aborted if a conjunction appears during the slew', () => {
        const { sat, vector, dv } = trap();
        const quiet = sat.conjunctions.events.splice(0); // nothing on the list while the burn is armed
        const events = collect(sat, 'plan');
        sat.flightController.submitPlan(burn(vector, dv));
        sat.step(2); // PLAN_BURN accepted, slew begins
        expect(sat.flightController.pendingBurn).not.toBeNull();
        sat.conjunctions.events.push(...quiet); // the screening message arrives mid-slew
        for (let i = 0; i < 600; i++) sat.step(1);
        expect(events.some(e => e.kind === 'vetoed' && e.command === 'EXECUTE_BURN')).toBe(true);
        expect(sat.propulsion.totalDeltaVUsed).toBe(0);
        expect(sat.flightController.pendingBurn).toBeNull();
    });
});

describe('collision alerts and backstop run on simulation time', () => {
    it('announces a conjunction once when shrinking uncertainty lifts its Pc through the threshold', () => {
        const sat = newSat();
        const seen = collect(sat, 'conjunction');
        const ev = sat.conjunctions.spawn(sat.missionTime, { leadS: 8 * 3600, missM: 40, crossingDeg: 90 });
        expect(ev.pc).toBeLessThan(PC_MANEUVER_THRESHOLD); // diluted while tracking is poor
        for (let t = 0; t < 7.5 * 3600; t += 50) sat.step(50);
        const esc = seen.filter(e => e.type === 'escalated');
        expect(esc).toHaveLength(1);
        expect(esc[0].event.pc).toBeGreaterThanOrEqual(PC_MANEUVER_THRESHOLD);
    });

    it('calls the backstop every 30 simulated seconds whatever the step size', () => {
        for (const step of [0.1, 1, 50]) {
            const sat = newSat();
            let calls = 0;
            sat.setBackstop(() => { calls++; });
            for (let t = 0; t < 3000; t += step) sat.step(step);
            expect(calls).toBeGreaterThanOrEqual(97);
            expect(calls).toBeLessThanOrEqual(101);
        }
    });

    it('at 500× with no planner calls at all, the backstop alone still burns before closest approach', () => {
        const sat = newSat();
        const ap = new Autopilot();
        sat.setBackstop(() => { const b = ap.backstop(sat); if (b?.commands) sat.flightController.submitPlan(b, 'autopilot'); });
        sat.injectEvent('debris_close');
        const id = sat.conjunctions.events[0].id;
        for (let t = 0; t < 2 * 3600 && !sat.mission.lost; t += 50) sat.step(50); // 50 s per tick = 500× warp
        const passed = sat.conjunctions.history.find(h => h.id === id);
        expect(passed).toBeDefined();
        expect(passed.maneuvered).toBe(true);
        expect(passed.pc).toBeLessThan(1e-6);
        expect(passed.collision).toBe(false);
        expect(sat.mission.maneuvers).toBeGreaterThanOrEqual(1);
    });
});

describe('planner prompt', () => {
    it('hands the planner the solver option when a conjunction is above the watch level', () => {
        const sat = newSat();
        expect(sat.avoidanceOption()).toBeNull();
        sat.injectEvent('debris_close');
        sat.step(31); // past the 30 s cache
        const opt = sat.avoidanceOption();
        expect(opt.deltaV).toBeGreaterThan(0);
        expect(opt.worstPcAfter).toBeLessThan(1e-6);
        const prompt = buildTelemetryPrompt(sat.getFullState(), THERMAL_LIMITS, opt);
        expect(prompt).toMatch(/SOLVER OPTION: PLAN_BURN vector \[/);
        expect(prompt).not.toMatch(/undefined|NaN/);
        // The option is in the plan convention [prograde, radial, normal] and passes the burn check.
        sat.flightController.submitPlan(burn(opt.vector, opt.deltaV, { priority: 'CRITICAL' }), 'gemini');
        for (let i = 0; i < 400; i++) sat.step(1);
        expect(sat.conjunctions.events[0].pc).toBeLessThan(1e-6);
    });
});
