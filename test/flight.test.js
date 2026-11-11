import { describe, it, expect } from 'vitest';
import { VirtualSatellite } from '../src/satellite.js';
import { validatePlan, normalizePriority, MAX_BURN_DV } from '../src/autonomy/plan.js';
import { semiMajorAxisChange, tsiolkovskyFuel } from '../src/physics.js';

function seeded(a = 1) {
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const EPOCH = Date.UTC(2026, 9, 14, 6, 0, 0);
const newSat = (opts = {}) => new VirtualSatellite({ epochMs: EPOCH, rng: seeded(42), conjunctionRatePerHour: 0, ...opts });
const run = (sat, seconds, dt = 1) => { for (let t = 0; t < seconds; t += dt) sat.step(dt); };
const collect = (sat, type) => { const out = []; sat.on(type, d => out.push(d)); return out; };

describe('plan validation', () => {
    it('maps legacy priorities onto one scale', () => {
        expect(normalizePriority('EMERGENCY')).toBe('CRITICAL');
        expect(normalizePriority('NORMAL')).toBe('MEDIUM');
        expect(normalizePriority('critical')).toBe('CRITICAL');
        expect(normalizePriority('???')).toBe('MEDIUM');
    });

    it('rejects unknown commands and bad parameters, keeps the good ones', () => {
        const { plan, rejected } = validatePlan({
            priority: 'HIGH', commands: [
                { type: 'SELF_DESTRUCT' },
                { type: 'SET_ATTITUDE_MODE', params: { target: 'SIDEWAYS' } },
                { type: 'PLAN_BURN', params: { vector: [0, 0, 0], delta_v: 0.1 } },
                { type: 'PLAN_BURN', params: { vector: [1, 0, 0], delta_v: MAX_BURN_DV + 1 } },
                { type: 'PLAN_BURN', params: { vector: [1, 0, 0], delta_v: -1 } },
                { type: 'SET_POWER_MODE', params: { mode: 'low_power' } },
            ],
        }, 'test');
        expect(rejected).toHaveLength(5);
        expect(plan.commands).toEqual([{ type: 'SET_POWER_MODE', params: { mode: 'LOW_POWER' } }]);
    });

    it('normalises burn vectors to unit length', () => {
        const { plan } = validatePlan({ commands: [{ type: 'PLAN_BURN', params: { vector: [3, 4, 0], delta_v: 0.2 } }] });
        expect(plan.commands[0].params.vector).toEqual([0.6, 0.8, 0]);
    });
});

describe('FlightController regressions', () => {
    it('power, payload and safe-mode commands execute (were TypeError on sections.payload)', () => {
        const sat = newSat();
        const fc = sat.flightController;
        const events = collect(sat, 'plan');
        for (const cmd of [
            { type: 'SET_POWER_MODE', params: { mode: 'LOW_POWER' } },
            { type: 'SET_PAYLOAD_STATE', params: { state: 'STANDBY' } },
            { type: 'ENTER_SAFE_MODE', params: {} },
        ]) {
            expect(fc.submitPlan({ priority: 'MEDIUM', commands: [cmd] }).accepted).toBe(true);
            expect(() => run(sat, 3)).not.toThrow();
        }
        expect(sat.powerMode).toBe('SURVIVAL');
        expect(sat.sections.payloadBay.state).toBe('OFF');
        fc.submitPlan({ commands: [{ type: 'EXIT_SAFE_MODE' }] });
        run(sat, 2);
        expect(sat.powerMode).toBe('NOMINAL');
        expect(sat.sections.payloadBay.state).toBe('ACTIVE');
        expect(events.filter(e => e.kind === 'completed')).toHaveLength(4);
        expect(fc.current).toBeNull();
    });

    it('battery override fires once at low charge and clears with hysteresis (read .percent before)', () => {
        const sat = newSat();
        const overrides = collect(sat, 'safety-override');
        const clears = collect(sat, 'safety-clear');
        sat.setAttitudeMode('EARTH_NADIR');
        sat.sections.batteryBay.charge = 12;
        run(sat, 120);
        expect(overrides).toHaveLength(1);                       // one event, not ten per second
        expect(overrides[0].code).toBe('BATTERY_CRITICAL_OVERRIDE');
        expect(sat.powerMode).toBe('SURVIVAL');
        expect(sat.sections.payloadBay.state).toBe('OFF');
        expect(sat.attitude.mode).toBe('SUN_TRACKING');
        // planner cannot undo it while latched
        sat.flightController.submitPlan({ commands: [{ type: 'SET_PAYLOAD_STATE', params: { state: 'ACTIVE' } }] });
        run(sat, 5);
        expect(sat.sections.payloadBay.state).toBe('OFF');
        sat.sections.batteryBay.charge = 20;                      // inside hysteresis band: still latched
        run(sat, 5);
        expect(clears).toHaveLength(0);
        sat.sections.batteryBay.charge = 35;
        run(sat, 5);
        expect(clears).toHaveLength(1);
    });

    it('CRITICAL plans pre-empt and outrank everything (CRITICAL used to rank with LOW)', () => {
        const sat = newSat();
        const fc = sat.flightController;
        fc.submitPlan({ plan_id: 'slow', priority: 'LOW', commands: [{ type: 'SET_ATTITUDE_MODE', params: { target: 'DEEP_SPACE' } }] });
        run(sat, 2);
        expect(fc.current.plan_id).toBe('slow');
        fc.submitPlan({ plan_id: 'hi', priority: 'HIGH', commands: [{ type: 'SET_POWER_MODE', params: { mode: 'LOW_POWER' } }] });
        fc.submitPlan({ plan_id: 'crit', priority: 'CRITICAL', commands: [{ type: 'SET_POWER_MODE', params: { mode: 'CHARGE_PRIORITY' } }] });
        expect(fc.current).toBeNull();                         // LOW plan aborted
        expect(fc.queue.map(p => p.plan_id)).toEqual(['crit']); // lower-priority queue flushed
        fc.submitPlan({ plan_id: 'emerg', priority: 'EMERGENCY', commands: [{ type: 'SET_POWER_MODE', params: { mode: 'SURVIVAL' } }] });
        expect(fc.queue.map(p => p.priority)).toEqual(['CRITICAL', 'CRITICAL']);
    });

    it('ignores a duplicate plan_id', () => {
        const fc = newSat().flightController;
        expect(fc.submitPlan({ plan_id: 'x', commands: [{ type: 'ENTER_SAFE_MODE' }] }).accepted).toBe(true);
        expect(fc.submitPlan({ plan_id: 'x', commands: [{ type: 'ENTER_SAFE_MODE' }] }).accepted).toBe(false);
    });

    it('EXECUTE_BURN without a PLAN_BURN is vetoed', () => {
        const sat = newSat();
        const events = collect(sat, 'plan');
        sat.flightController.submitPlan({ commands: [{ type: 'EXECUTE_BURN' }] });
        run(sat, 3);
        expect(events.some(e => e.kind === 'vetoed')).toBe(true);
        expect(sat.sections.thrusterPod.totalBurns).toBe(0);
    });
});

describe('burns', () => {
    const burnPlan = (dv) => ({
        priority: 'HIGH', commands: [
            { type: 'PLAN_BURN', params: { vector: [1, 0, 0], delta_v: dv, reason: 'test' } },
            { type: 'EXECUTE_BURN' },
        ],
    });

    it('delivers the planned delta-v and consumes propellant per the rocket equation (applyThrust was a no-op)', () => {
        const sat = newSat();
        const fuel0 = sat.sections.thrusterPod.fuelMass;
        const wet0 = sat.wetMassKg;
        sat.flightController.submitPlan(burnPlan(0.5));
        run(sat, 900);
        expect(sat.flightController.current).toBeNull();
        expect(sat.propulsion.totalDeltaVUsed).toBeCloseTo(0.5, 6);
        const usedG = fuel0 - sat.sections.thrusterPod.fuelMass;
        expect(usedG).toBeCloseTo(tsiolkovskyFuel(0.5, wet0, 60) * 1000, 4);
        expect(sat.sections.thrusterPod.totalBurns).toBe(1);
        expect(sat.sections.thrusterPod.fuelPercent).toBeLessThan(fuel0 / 70 * 100); // fuelPercent now tracks the tank
    });

    it('same delta-v at 1x and 100x time warp (was 100x too much)', () => {
        const results = [];
        for (const dt of [0.1, 10]) {
            const sat = newSat();
            const a0 = sat.orbit.baseAltitude;
            sat.flightController.submitPlan(burnPlan(0.3));
            run(sat, 1200, dt);
            results.push({ dv: sat.propulsion.totalDeltaVUsed, dAlt: sat.orbit.baseAltitude - a0 });
        }
        expect(results[0].dv).toBeCloseTo(0.3, 6);
        expect(results[1].dv).toBeCloseTo(0.3, 6);
        expect(results[1].dAlt).toBeCloseTo(results[0].dAlt, 2);
    });

    it('prograde burn raises the orbit by 2a dv / v (minus drag over the run)', () => {
        const sat = newSat();
        const a0 = sat.orbit.baseAltitude;
        sat.flightController.submitPlan(burnPlan(1.0));
        run(sat, 900);
        const expected = semiMajorAxisChange(1.0, a0);
        const decay = Math.abs(sat.environment.decayRateKmPerDay) * 900 / 86400;
        expect(sat.orbit.baseAltitude - a0).toBeCloseTo(expected - decay, 1);
    });

    it('refuses a burn that would eat into the delta-v reserve', () => {
        const sat = newSat();
        sat.sections.thrusterPod.fuelMass = 9; // ≈ 4.2 m/s total, 3 m/s reserved
        sat.step(0.01);
        const events = collect(sat, 'plan');
        sat.flightController.submitPlan(burnPlan(1.5));
        run(sat, 600);
        expect(events.find(e => e.kind === 'vetoed')?.reason).toMatch(/usable budget/);
        expect(sat.propulsion.totalDeltaVUsed).toBe(0);
    });
});

describe('collision avoidance', () => {
    it('a solved avoidance burn takes a CRITICAL conjunction below 1e-6', () => {
        const sat = newSat();
        sat.injectEvent('debris_close');
        const ev = sat.conjunctions.events[0];
        expect(ev.pc).toBeGreaterThan(1e-4);
        const n = Math.sqrt(3.986004418e14 / ((6371e3 + sat.orbit.baseAltitude * 1e3) ** 3));
        const sol = sat.conjunctions.solveAvoidance(sat.missionTime, n);
        expect(sol).not.toBeNull();
        expect(sol.deltaV).toBeLessThan(0.5);
        const [r, t, nn] = sol.vectorRTN;
        sat.flightController.submitPlan({
            priority: 'CRITICAL', commands: [
                { type: 'PLAN_BURN', params: { vector: [t, r, nn], delta_v: sol.deltaV, reason: 'avoid' } },
                { type: 'EXECUTE_BURN' },
            ],
        });
        run(sat, 400);
        expect(sat.propulsion.totalDeltaVUsed).toBeCloseTo(sol.deltaV, 5);
        expect(ev.pc).toBeLessThan(1e-6);
        expect(ev.maneuvered).toBe(true);
    });
});

describe('space weather without any AI', () => {
    it('a CME arrives on sim time and its storm persists for hours (spike used to last 100 ms)', () => {
        const sat = newSat();
        const sw = collect(sat, 'space-weather');
        sat.injectEvent('cme_incoming');
        run(sat, 3700, 10);
        expect(sw.some(e => e.action === 'CME_IMPACT')).toBe(true);
        expect(sat.spaceWeather.kp).toBeGreaterThan(6);
        run(sat, 3 * 3600, 10);
        expect(sat.spaceWeather.kp).toBeGreaterThan(5); // still stormy 3 h later
    });

    it('SEP protons raise the dose rate for hours', () => {
        const sat = newSat();
        sat.injectEvent('solar_flare');
        run(sat, 25 * 60, 10);
        const peak = sat.environment.radiationLevel;
        expect(peak).toBeGreaterThan(1);
        run(sat, 2 * 3600, 10);
        expect(sat.environment.radiationLevel).toBeGreaterThan(0.5);
    });
});

describe('thermal safety', () => {
    it('runaway drill trips the thermal override once and the supervisor vetoes sun-pointing', () => {
        const sat = newSat();
        const overrides = collect(sat, 'safety-override');
        sat.injectEvent('thermal_runaway');
        run(sat, 3600, 2);
        expect(overrides.filter(o => o.code === 'THERMAL_LIMIT_OVERRIDE')).toHaveLength(1);
        expect(sat.attitude.mode).toBe('DEEP_SPACE');
        const events = collect(sat, 'plan');
        sat.flightController.submitPlan({ commands: [{ type: 'SET_ATTITUDE_MODE', params: { target: 'SUN_TRACKING' } }] });
        run(sat, 5);
        if (sat.flightController.supervisor.thermal) {
            expect(events.some(e => e.kind === 'vetoed')).toBe(true);
            expect(sat.attitude.mode).toBe('DEEP_SPACE');
        }
    });

    it('RESET_OBC clears a stuck process and the OBC cools', () => {
        const sat = newSat();
        sat.injectEvent('thermal_runaway');
        run(sat, 300, 2);
        const hot = sat.sections.onboardComputer.temperature;
        sat.flightController.submitPlan({ priority: 'CRITICAL', commands: [{ type: 'RESET_OBC' }] });
        run(sat, 1800, 2);
        expect(sat.obc.cpuStuck).toBe(false);
        expect(sat.sections.onboardComputer.temperature).toBeLessThan(hot);
    });
});

describe('simulation integrity', () => {
    it('time warp gives the same physics (1 s vs 10 s steps over 2 h)', () => {
        const a = newSat(), b = newSat();
        run(a, 7200, 1);
        run(b, 7200, 10);
        expect(b.orbit.baseAltitude).toBeCloseTo(a.orbit.baseAltitude, 4);
        expect(b.sections.batteryBay.charge).toBeCloseTo(a.sections.batteryBay.charge, 0);
        expect(b.sections.onboardComputer.temperature).toBeCloseTo(a.sections.onboardComputer.temperature, 0);
    });

    it('temperatures reach an orbital equilibrium instead of running away (all used to hit 130 °C)', () => {
        const sat = newSat();
        let max = -Infinity, min = Infinity;
        run(sat, 5 * 5600, 10);
        for (let i = 0; i < 5600 / 10; i++) {
            sat.step(10);
            for (const k of ['batteryBay', 'onboardComputer', 'payloadBay', 'thermalRadiator']) {
                max = Math.max(max, sat.sections[k].temperature);
                min = Math.min(min, sat.sections[k].temperature);
            }
        }
        expect(max).toBeLessThan(50);
        expect(min).toBeGreaterThan(-25);
    });

    it('runs 2 days with random conjunctions and every drill without throwing', () => {
        const sat = newSat({ conjunctionRatePerHour: 1.5 });
        const drills = ['solar_flare', 'cme_incoming', 'debris_close', 'battery_drain', 'thermal_runaway', 'solar_panel_a_fail', 'comm_blackout', 'orbital_decay', 'all_clear'];
        expect(() => {
            for (let h = 0; h < 48; h++) {
                if (h % 5 === 0) sat.injectEvent(drills[(h / 5) % drills.length]);
                run(sat, 3600, 10);
                sat.getFullState();
            }
        }).not.toThrow();
        const st = sat.getFullState();
        expect(Number.isFinite(st.orbit.baseAltitude)).toBe(true);
        expect(Number.isFinite(st.sections.batteryBay.charge)).toBe(true);
    });

    it('a live TLE is only adopted at the very start (old code reset altitude every 60 s, erasing burns and decay)', () => {
        const sat = newSat();
        run(sat, 120);
        expect(sat.adoptTle({ line1: 'x', line2: 'y', altitude: 500, inclination: 97 })).toBe(false);
        expect(sat.orbit.baseAltitude).toBeLessThan(421);
    });
});
