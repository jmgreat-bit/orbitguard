/**
 * FlightController — executes validated plans on simulation time, under a safety
 * supervisor the planner cannot override.
 *
 * What changed from the original and why:
 *  - Steps are timed in *simulated* seconds. The old controller timed steps with
 *    Date.now() but integrated thrust with scaled dt, so at 100× warp a burn
 *    delivered 100× the commanded Δv.
 *  - It writes to sections.payloadBay (it wrote to a non-existent sections.payload,
 *    which threw on 4 of the 7 commands and wedged the queue forever).
 *  - The supervisor reads batteryBay.charge (it read .percent, which does not exist,
 *    so the low-battery override never fired). It latches with hysteresis, acts once
 *    on entry, emits one event per transition (not 10 per second), and vetoes only the
 *    commands that conflict, so a collision-avoidance burn still runs on low battery.
 *  - Burns: PLAN_BURN registers a manoeuvre, EXECUTE_BURN aligns the thruster first,
 *    then fires for exactly the planned Δv, consuming propellant via the rocket equation.
 *  - Fuel reserve uses the real Δv budget computed from propellant mass.
 *  - Plans carry the mission time of the telemetry they were planned from; one older than
 *    MAX_PLAN_AGE_S is rejected at intake (a slow planner at high time warp).
 *  - Every burn is checked against the whole screening list before it is armed and again
 *    just before the thruster fires: a burn that would leave the worst collision
 *    probability at or above the manoeuvre threshold without reducing it is vetoed,
 *    whoever planned it.
 */
import { validatePlan, PRIORITY_RANK, MAX_PLAN_AGE_S } from './plan.js';
import { THERMAL_LIMITS } from '../sim/thermal.js';
import { PC_MANEUVER_THRESHOLD } from '../sim/conjunctions.js';
import { meanMotion, formatPc } from '../physics.js';

const INTERNAL_NODES = ['batteryBay', 'onboardComputer', 'payloadBay', 'commArray', 'thrusterPod'];
const ATTITUDE_TIMEOUT_S = 900;
const ALIGN_TIMEOUT_S = 900;

export class FlightController {
    constructor(sat) {
        this.sat = sat;
        this.queue = [];
        this.current = null;          // the plan being executed
        this.stepIndex = 0;
        this.stepElapsed = 0;         // simulated seconds in the current step
        this.stepState = {};
        this.pendingBurn = null;      // { vector, deltaV, delivered, reason }
        this.seenPlanIds = [];
        this.supervisor = { battery: false, thermal: false };
        this.recent = [];             // finished/aborted plans, newest first
        // Back-compat field names used by older UI code
        this.currentCommand = null;
        this.currentStepIndex = 0;
    }

    // ── intake ───────────────────────────────────────────────────────────────
    /**
     * Validate and queue a plan from any planner.
     * @returns {{accepted: boolean, plan: object|null, rejected: Array, reason?: string}}
     */
    submitPlan(raw, source = 'planner') {
        const { plan, rejected } = validatePlan(raw, source);
        rejected.forEach(r => this._event('rejected', { plan, command: r.type, reason: r.reason }));
        if (!plan) return { accepted: false, plan: null, rejected, reason: 'invalid plan' };
        if (plan.basedOnT !== null) {
            const age = this.sat.missionTime - plan.basedOnT;
            if (age > MAX_PLAN_AGE_S) {
                const reason = `planned from telemetry ${Math.round(age)} s old (limit ${MAX_PLAN_AGE_S} s)`;
                this._event('rejected', { plan, command: 'STALE_PLAN', reason });
                return { accepted: false, plan, rejected, reason: 'stale', detail: reason };
            }
        }
        if (this.seenPlanIds.includes(plan.plan_id)) return { accepted: false, plan, rejected, reason: 'duplicate plan_id' };
        this.seenPlanIds.push(plan.plan_id);
        if (this.seenPlanIds.length > 50) this.seenPlanIds.shift();
        if (!plan.commands.length) return { accepted: false, plan, rejected, reason: 'no executable commands' };

        if (plan.priority === 'CRITICAL') {
            if (this.current) this.abortCurrent(`pre-empted by CRITICAL plan ${plan.plan_id}`);
            this.queue = this.queue.filter(p => p.priority === 'CRITICAL');
        }
        // Stable insert: higher priority first, FIFO within a priority.
        const rank = PRIORITY_RANK[plan.priority];
        const idx = this.queue.findIndex(p => PRIORITY_RANK[p.priority] < rank);
        if (idx === -1) this.queue.push(plan); else this.queue.splice(idx, 0, plan);
        // A higher-priority plan pre-empts a lower one that is still running.
        if (this.current && PRIORITY_RANK[this.current.priority] < rank && this.current.priority !== 'CRITICAL') {
            this.abortCurrent(`pre-empted by ${plan.priority} plan`);
        }
        this._event('queued', { plan });
        return { accepted: true, plan, rejected };
    }

    /** Back-compat alias. */
    processAIPlan(raw) { return this.submitPlan(raw, raw?.source || 'planner'); }

    abortCurrent(reason = 'aborted') {
        if (this.sat.propulsion.isThrusting) this.sat.endBurn();
        if (this.current) {
            this._finish('aborted', reason);
        }
    }

    // ── per-tick ─────────────────────────────────────────────────────────────
    tick(dt) {
        this._supervise();
        if (this.sat.obcDown) return; // computer rebooting: nothing executes

        if (!this.current && this.queue.length) {
            this.current = this.queue.shift();
            this.stepIndex = 0;
            this.stepElapsed = 0;
            this.stepState = {};
            this._event('started', { plan: this.current });
        }
        if (this.current) this._executeStep(dt);
        this.currentCommand = this.current;
        this.currentStepIndex = this.stepIndex;
    }

    // ── safety supervisor ────────────────────────────────────────────────────
    _supervise() {
        const s = this.sat.sections;
        const sup = this.supervisor;

        const hot = INTERNAL_NODES.filter(k => s[k].temperature >= THERMAL_LIMITS[k].critHi);
        const cooled = INTERNAL_NODES.every(k => s[k].temperature < THERMAL_LIMITS[k].warnHi - 3);
        if (!sup.thermal && hot.length) {
            sup.thermal = true;
            const actions = this._safeConfig('thermal');
            this._override('THERMAL_LIMIT_OVERRIDE', `${hot.map(k => s[k].name).join(', ')} above qualified limit`, actions);
        } else if (sup.thermal && cooled) {
            sup.thermal = false;
            this._clear('THERMAL_LIMIT_OVERRIDE', 'All internal temperatures back inside limits');
        }

        const soc = s.batteryBay.charge;
        if (!sup.battery && (soc < 15 || s.batteryBay.brownout)) {
            sup.battery = true;
            const actions = this._safeConfig('battery');
            this._override('BATTERY_CRITICAL_OVERRIDE', `Battery at ${soc.toFixed(0)}%`, actions);
        } else if (sup.battery && soc > 30) {
            sup.battery = false;
            this._clear('BATTERY_CRITICAL_OVERRIDE', `Battery recovered to ${soc.toFixed(0)}%`);
        }

        // Hold the safe configuration while latched (a plan may not undo it).
        if (sup.thermal) {
            if (!['DEEP_SPACE', 'MANEUVER_ALIGNMENT'].includes(this.sat.attitude.mode)) this.sat.setAttitudeMode('DEEP_SPACE');
            if (s.payloadBay.state === 'ACTIVE') this.sat.setPayloadState('OFF');
        } else if (sup.battery) {
            if (!['SUN_TRACKING', 'MANEUVER_ALIGNMENT', 'SAFE_TUMBLE_STOP'].includes(this.sat.attitude.mode)) this.sat.setAttitudeMode('SUN_TRACKING');
            if (s.payloadBay.state !== 'OFF') this.sat.setPayloadState('OFF');
        }
    }

    _safeConfig(kind) {
        const actions = [];
        const cur = this.current?.commands[this.stepIndex];
        if (cur && this._veto(cur)) this.abortCurrent(`conflicts with ${kind} safety override`);
        if (kind === 'thermal') {
            this.sat.setAttitudeMode('DEEP_SPACE');
            actions.push({ type: 'SET_ATTITUDE_MODE', params: { target: 'DEEP_SPACE' } });
            this.sat.setPayloadState('OFF');
            actions.push({ type: 'SET_PAYLOAD_STATE', params: { state: 'OFF' } });
        } else {
            this.sat.setPowerMode('SURVIVAL');
            actions.push({ type: 'SET_POWER_MODE', params: { mode: 'SURVIVAL' } });
            this.sat.setPayloadState('OFF');
            actions.push({ type: 'SET_PAYLOAD_STATE', params: { state: 'OFF' } });
            if (!this.supervisor.thermal) {
                this.sat.setAttitudeMode('SUN_TRACKING');
                actions.push({ type: 'SET_ATTITUDE_MODE', params: { target: 'SUN_TRACKING' } });
            }
        }
        return actions;
    }

    _override(code, why, actions) {
        this.sat.emit('safety-override', {
            code, reason: code, summary: `${why}. Supervisor applied safe configuration.`,
            priority: 'CRITICAL', plan_id: `safety_${code}_${Math.round(this.sat.missionTime)}`,
            commands: actions, applied: true, source: 'supervisor',
        });
    }

    _clear(code, why) {
        this.sat.emit('safety-clear', { code, summary: why });
    }

    /** Returns a reason string if the supervisor forbids this command right now. */
    _veto(cmd) {
        const sup = this.supervisor;
        const p = cmd.params || {};
        if (sup.thermal) {
            if (cmd.type === 'SET_ATTITUDE_MODE' && !['DEEP_SPACE', 'MANEUVER_ALIGNMENT'].includes(p.target)) return 'thermal override holds sun-avoid attitude';
            if (cmd.type === 'SET_PAYLOAD_STATE' && p.state === 'ACTIVE') return 'thermal override keeps payload off';
            if (cmd.type === 'EXIT_SAFE_MODE') return 'thermal override active';
        }
        if (sup.battery) {
            if (cmd.type === 'SET_ATTITUDE_MODE' && !['SUN_TRACKING', 'MANEUVER_ALIGNMENT', 'SAFE_TUMBLE_STOP'].includes(p.target)) return 'battery override holds sun-pointing';
            if (cmd.type === 'SET_PAYLOAD_STATE' && p.state !== 'OFF') return 'battery override keeps payload off';
            if (cmd.type === 'SET_POWER_MODE' && p.mode === 'NOMINAL') return 'battery override forbids NOMINAL power';
            if (cmd.type === 'EXIT_SAFE_MODE') return 'battery override active';
        }
        if (cmd.type === 'PLAN_BURN') {
            const avail = this.sat.propulsion.remainingDeltaV - this.sat.propulsion.reserveDeltaV;
            if (p.delta_v > avail) return `Δv ${p.delta_v.toFixed(2)} m/s exceeds usable budget ${Math.max(0, avail).toFixed(2)} m/s (reserve ${this.sat.propulsion.reserveDeltaV} m/s)`;
            const risk = this._burnRisk(p.vector, p.delta_v);
            if (risk) return risk;
        }
        if (cmd.type === 'EXECUTE_BURN' && !this.pendingBurn) return 'no burn planned (PLAN_BURN must come first)';
        return null;
    }

    /**
     * Collision check for a burn of dv m/s along vecTRN = [prograde, radial, normal], fired now.
     * Returns a reason string if it must not fly: the worst Pc over every upcoming event would
     * be at or above the manoeuvre threshold and no lower than it is today. Burns with nothing
     * in the screening window, and burns that leave everything under the threshold, pass.
     */
    _burnRisk(vecTRN, dv) {
        const sat = this.sat;
        const [t, r, n] = vecTRN.map(x => x * dv);
        const a = sat.conjunctions.assessImpulse(r, t, n, sat.missionTime, meanMotion(sat.orbit.baseAltitude));
        if (!a.n || a.worstAfter < PC_MANEUVER_THRESHOLD || a.worstAfter < a.worstBefore) return null;
        return a.worstBefore >= PC_MANEUVER_THRESHOLD
            ? `burn does not reduce the collision risk (worst Pc ${formatPc(a.worstBefore)} now, ${formatPc(a.worstAfter)} after, ${a.worstAfterId})`
            : `burn would raise ${a.worstAfterId} to Pc ${formatPc(a.worstAfter)} (worst is ${formatPc(a.worstBefore)} now)`;
    }

    // ── step execution ───────────────────────────────────────────────────────
    _executeStep(dt) {
        const plan = this.current;
        const step = plan.commands[this.stepIndex];
        if (!step) { this._finish('completed'); return; }

        if (this.stepElapsed === 0 && !this.stepState.checked) {
            this.stepState.checked = true;
            const veto = this._veto(step);
            if (veto) {
                this._event('vetoed', { plan, command: step.type, reason: veto });
                this._advance();
                return;
            }
        }
        this.stepElapsed += dt;
        const sat = this.sat;
        const st = this.stepState;
        let done = false;

        switch (step.type) {
            case 'SET_ATTITUDE_MODE':
                // Command on the first tick; judge convergence from the next tick on, once the
                // attitude model has recomputed the error for the new target.
                if (!st.started) { sat.setAttitudeMode(step.params.target); st.started = true; break; }
                done = step.params.target === 'SAFE_TUMBLE_STOP' ? sat.attitude.tumbleRateDegS < 0.2 : sat.attitude.pointingErrorDeg < 2;
                if (!done && this.stepElapsed > ATTITUDE_TIMEOUT_S) { this.abortCurrent('attitude slew timed out'); return; }
                break;

            case 'PLAN_BURN':
                this.pendingBurn = { vector: step.params.vector, deltaV: step.params.delta_v, delivered: 0, reason: step.params.reason };
                this._event('burn-planned', { plan, burn: this.pendingBurn });
                done = true;
                break;

            case 'EXECUTE_BURN': {
                const b = this.pendingBurn;
                if (!st.phase) {
                    sat.setBurnDirection(b.vector);
                    sat.setAttitudeMode('MANEUVER_ALIGNMENT');
                    st.phase = 'align';
                    break; // alignment is judged from the next tick (fresh pointing error)
                }
                if (st.phase === 'align') {
                    if (sat.thrusterAligned()) {
                        // The slew took time and the picture may have changed: check once more before firing.
                        const risk = this._burnRisk(b.vector, b.deltaV);
                        if (risk) {
                            this._event('vetoed', { plan, command: 'EXECUTE_BURN', reason: risk });
                            this.abortCurrent('burn failed the pre-fire collision check');
                            return;
                        }
                        st.phase = 'burn'; st.burnStart = this.stepElapsed;
                    }
                    else if (this.stepElapsed > ALIGN_TIMEOUT_S) { this.abortCurrent('thruster alignment timed out'); return; }
                }
                if (st.phase === 'burn') {
                    const left = b.deltaV - b.delivered;
                    const got = sat.applyThrust(b.vector, dt, left);
                    b.delivered += got;
                    if (got <= 0) { this.abortCurrent('propellant exhausted'); return; }
                    if (b.deltaV - b.delivered < 1e-6) {
                        sat.endBurn();
                        this._event('burn-complete', { plan, burn: b });
                        this.pendingBurn = null;
                        done = true;
                    }
                }
                break;
            }

            case 'SET_POWER_MODE':
                sat.setPowerMode(step.params.mode);
                done = true;
                break;

            case 'SET_PAYLOAD_STATE':
                sat.setPayloadState(step.params.state);
                done = true;
                break;

            case 'ENTER_SAFE_MODE':
                sat.setPowerMode('SURVIVAL');
                sat.setPayloadState('OFF');
                if (!this.supervisor.thermal) sat.setAttitudeMode('SUN_TRACKING');
                done = true;
                break;

            case 'EXIT_SAFE_MODE':
                sat.setPowerMode('NOMINAL');
                sat.setPayloadState('ACTIVE');
                done = true;
                break;

            case 'RESET_OBC':
                this._advance();
                sat.resetObc(); // aborts this plan as the computer reboots
                return;

            default:
                done = true;
        }
        if (done) this._advance();
    }

    _advance() {
        this.stepIndex += 1;
        this.stepElapsed = 0;
        this.stepState = {};
        if (this.current && this.stepIndex >= this.current.commands.length) this._finish('completed');
    }

    _finish(outcome, reason) {
        const plan = this.current;
        this.current = null;
        this.currentCommand = null;
        this.stepIndex = 0;
        this.stepElapsed = 0;
        this.stepState = {};
        if (outcome === 'aborted') this.pendingBurn = null; // never leave a stale burn armed
        this.recent.unshift({ plan_id: plan.plan_id, summary: plan.summary, priority: plan.priority, outcome, reason, at: this.sat.missionTime });
        this.recent.length = Math.min(this.recent.length, 10);
        this._event(outcome, { plan, reason });
    }

    _event(kind, detail) {
        this.sat.emit('plan', { kind, ...detail, t: this.sat.missionTime });
    }

    /** UI-friendly snapshot of what the controller is doing. */
    status() {
        const p = this.current;
        const step = p?.commands[this.stepIndex];
        let fraction = 0;
        if (step?.type === 'EXECUTE_BURN' && this.pendingBurn) fraction = this.pendingBurn.delivered / this.pendingBurn.deltaV;
        else if (step?.type === 'SET_ATTITUDE_MODE') fraction = Math.max(0, 1 - this.sat.attitude.pointingErrorDeg / 180);
        return {
            plan: p ? { plan_id: p.plan_id, priority: p.priority, summary: p.summary, source: p.source, commands: p.commands } : null,
            stepIndex: this.stepIndex,
            stepType: step?.type || null,
            stepPhase: this.stepState.phase || null,
            stepFraction: fraction,
            queue: this.queue.map(q => ({ plan_id: q.plan_id, priority: q.priority, summary: q.summary, n: q.commands.length })),
            pendingBurn: this.pendingBurn,
            supervisor: { ...this.supervisor },
            recent: this.recent,
            paused: this.sat.obcDown,
        };
    }
}
