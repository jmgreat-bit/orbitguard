/**
 * Deterministic autopilot — the rule-based planner that flies the spacecraft when
 * Gemini is offline, and the backstop for imminent collisions when it is online.
 *
 * The original "fallback" only reacted to battery < 15 %, temperature > 75 °C or debris
 * closer than 15 km (and in that case planned a burn without executing it). This one
 * runs the whole mission: avoidance burns sized by the CW model, thermal and power
 * management, fault recovery and payload duty-cycling, with hysteresis so it does not chatter.
 */
import { meanMotion } from '../physics.js';
import { THERMAL_LIMITS } from '../sim/thermal.js';
import { PC_MANEUVER_THRESHOLD } from '../sim/conjunctions.js';

const INTERNAL = ['batteryBay', 'onboardComputer', 'payloadBay', 'commArray', 'thrusterPod'];

/** Convert the solver's [R, T, N] unit vector to the plan convention [T, R, N]. */
const toPlanVector = ([r, t, n]) => [t, r, n];

export class Autopilot {
    constructor() {
        this.lastPlanAt = {};
    }

    _cool(rule, now, seconds) {
        if (now - (this.lastPlanAt[rule] ?? -Infinity) < seconds) return true;
        this.lastPlanAt[rule] = now;
        return false;
    }

    /** Is the controller already doing (or about to do) something for this rule? */
    _busy(sat, rule) {
        const fc = sat.flightController;
        const tag = `autopilot:${rule}`;
        return (fc.current?.plan_id || '').startsWith(tag) || fc.queue.some(p => p.plan_id.startsWith(tag));
    }

    _plan(rule, priority, summary, commands, now) {
        return { plan_id: `autopilot:${rule}:${Math.round(now)}`, priority, summary, commands, source: 'autopilot', basedOnT: now };
    }

    /**
     * Collision backstop only: returns a CRITICAL avoidance plan if an event above the
     * manoeuvre threshold is close and nothing is already armed for it.
     */
    backstop(sat, { withinS = 20 * 60 } = {}) {
        const now = sat.missionTime;
        // The most dangerous event *inside the window* (the overall worst may still be hours away
        // while a lesser red one is minutes from closest approach).
        const due = sat.conjunctions.events
            .filter(e => e.pc >= PC_MANEUVER_THRESHOLD && e.tca - now <= withinS)
            .reduce((a, b) => (!a || b.pc > a.pc ? b : a), null);
        return due ? this._avoidance(sat, now, due) : null;
    }

    _avoidance(sat, now, worst) {
        const fc = sat.flightController;
        if (this._busy(sat, 'avoid') || fc.pendingBurn || sat.propulsion.isThrusting) return null;
        if (worst.tca - now < 90) return null; // too late: a burn would not separate in time
        const n = meanMotion(sat.orbit.baseAltitude);
        const usable = sat.propulsion.remainingDeltaV - sat.propulsion.reserveDeltaV;
        const sol = sat.conjunctions.solveAvoidance(now, n, { maxDv: Math.min(1.0, Math.max(0, usable)) });
        if (!sol) {
            if (this._cool('avoid-none', now, 600)) return null;
            return { info: `No burn within the usable Δv (${usable.toFixed(2)} m/s) clears ${worst.id} (Pc ${worst.pcFormatted}).` };
        }
        const dir = sol.vectorRTN[1] > 0 ? 'prograde' : sol.vectorRTN[1] < 0 ? 'retrograde' : sol.vectorRTN[0] > 0 ? 'radial-out' : 'radial-in';
        return this._plan('avoid', 'CRITICAL',
            `${worst.id}: Pc ${worst.pcFormatted} at TCA in ${(worst.timeToTca_s / 60).toFixed(0)} min (miss ${worst.missDistance_m.toFixed(0)} m). ${dir} ${sol.deltaV.toFixed(2)} m/s brings every upcoming event under 1e-6 (worst ${sol.worstPc.toExponential(1)}).`,
            [
                { type: 'PLAN_BURN', params: { vector: toPlanVector(sol.vectorRTN), delta_v: sol.deltaV, reason: `avoid ${worst.name}` } },
                { type: 'EXECUTE_BURN', params: {} },
            ], now);
    }

    /**
     * Full rule set. Returns a plan, { info } for a log-only note, or null when nothing needs doing.
     */
    decide(sat) {
        const now = sat.missionTime;
        const s = sat.sections;
        const fc = sat.flightController;
        const sup = fc.supervisor;
        const soc = s.batteryBay.charge;
        const mode = sat.attitude.mode;

        // 1. Collision avoidance
        const worst = sat.conjunctions.mostDangerous();
        if (worst && worst.pc >= PC_MANEUVER_THRESHOLD) {
            const p = this._avoidance(sat, now, worst);
            if (p) return p;
        }
        if (fc.current && fc.current.priority === 'CRITICAL') return null; // let it finish

        // 2. Faults the computer can clear
        const o = s.onboardComputer;
        if ((sat.obc.cpuStuck || sat.faults?.adcsRunaway || o.errorCount > 30 || !s.commArray.antennaOk)
            && !sat.obc.down && !this._busy(sat, 'reset') && !this._cool('reset', now, 300)) {
            const why = sat.faults?.adcsRunaway || sat.obc.cpuStuck ? `CPU pinned at ${o.cpuLoad.toFixed(0)}% and OBC at ${o.temperature.toFixed(0)} °C`
                : !s.commArray.antennaOk ? 'radio not transmitting' : `${o.errorCount} memory upsets since boot`;
            return this._plan('reset', 'HIGH', `${why}: rebooting the OBC to clear it.`, [{ type: 'RESET_OBC', params: {} }], now);
        }

        // 3. Thermal: act at the warning band, before the supervisor has to
        const hot = INTERNAL.filter(k => s[k].temperature >= THERMAL_LIMITS[k].warnHi);
        if (hot.length && !sup.thermal && mode !== 'DEEP_SPACE' && !this._busy(sat, 'cool')) {
            return this._plan('cool', 'HIGH',
                `${hot.map(k => `${s[k].name} ${s[k].temperature.toFixed(0)} °C`).join(', ')} above the comfort band: turning the hot side away from the Sun.`,
                [{ type: 'SET_ATTITUDE_MODE', params: { target: 'DEEP_SPACE' } }, ...(s.payloadBay.state === 'ACTIVE' ? [{ type: 'SET_PAYLOAD_STATE', params: { state: 'STANDBY' } }] : [])], now);
        }
        const allCool = INTERNAL.every(k => s[k].temperature < THERMAL_LIMITS[k].warnHi - 12);
        const coldBattery = s.batteryBay.temperature < THERMAL_LIMITS.batteryBay.warnLo;

        // 4. Power
        if (soc < 25 && !sup.battery && sat.powerMode !== 'CHARGE_PRIORITY' && !this._busy(sat, 'power')) {
            return this._plan('power', 'HIGH', `Battery ${soc.toFixed(0)}%: charge priority, payload off, Sun-pointing.`, [
                { type: 'SET_POWER_MODE', params: { mode: 'CHARGE_PRIORITY' } },
                { type: 'SET_PAYLOAD_STATE', params: { state: 'OFF' } },
                ...(mode !== 'SUN_TRACKING' && !sup.thermal ? [{ type: 'SET_ATTITUDE_MODE', params: { target: 'SUN_TRACKING' } }] : []),
            ], now);
        }

        // 5. Radiation storm: protect the payload detector
        const dose = sat.environment.radiationLevel;
        if (dose > 0.8 && s.payloadBay.state === 'ACTIVE' && !this._busy(sat, 'rad')) {
            return this._plan('rad', 'MEDIUM', `Dose rate ${dose.toFixed(2)} mSv/h (solar protons): payload to standby until the storm passes.`,
                [{ type: 'SET_PAYLOAD_STATE', params: { state: 'STANDBY' } }], now);
        }
        if (this._busy(sat, 'ops') || fc.current) return null;
        if (this._cool('ops', now, 120)) return null;

        // 6. Recovery
        if (mode === 'DEEP_SPACE' && !sup.thermal && (allCool || coldBattery)) {
            return this._plan('ops', 'MEDIUM', `Temperatures back in band${coldBattery ? ' (battery getting cold)' : ''}: returning to Sun-pointing.`,
                [{ type: 'SET_ATTITUDE_MODE', params: { target: 'SUN_TRACKING' } }], now);
        }
        if (['SURVIVAL', 'CHARGE_PRIORITY', 'LOW_POWER'].includes(sat.powerMode) && soc > 55 && !sup.battery) {
            return this._plan('ops', 'MEDIUM', `Battery recovered to ${soc.toFixed(0)}%: NOMINAL power.`,
                [{ type: 'SET_POWER_MODE', params: { mode: 'NOMINAL' } }], now);
        }

        // 7. Mission duty cycle with hysteresis: image above 70 %, recharge below 45 %
        const canImage = !sup.battery && !sup.thermal && dose < 0.5 && !coldBattery && allCool;
        if (mode === 'EARTH_NADIR' && soc < 45) {
            return this._plan('ops', 'LOW', `Battery ${soc.toFixed(0)}% after imaging: Sun-pointing to recharge.`, [
                { type: 'SET_PAYLOAD_STATE', params: { state: 'STANDBY' } },
                { type: 'SET_ATTITUDE_MODE', params: { target: 'SUN_TRACKING' } },
            ], now);
        }
        if (canImage && soc > 70 && sat.powerMode === 'NOMINAL' && (mode !== 'EARTH_NADIR' || s.payloadBay.state !== 'ACTIVE')) {
            return this._plan('ops', 'LOW', `Battery ${soc.toFixed(0)}% and all systems nominal: nadir-pointing for Earth imaging.`, [
                { type: 'SET_ATTITUDE_MODE', params: { target: 'EARTH_NADIR' } },
                { type: 'SET_PAYLOAD_STATE', params: { state: 'ACTIVE' } },
            ], now);
        }
        if (dose < 0.3 && s.payloadBay.state === 'STANDBY' && mode === 'EARTH_NADIR' && canImage) {
            return this._plan('ops', 'LOW', 'Radiation back to normal: payload active.', [{ type: 'SET_PAYLOAD_STATE', params: { state: 'ACTIVE' } }], now);
        }
        return null;
    }
}
