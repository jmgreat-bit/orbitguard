/**
 * The command contract between planners (Gemini or the rule-based autopilot) and
 * the FlightController. One vocabulary, validated in one place.
 *
 * Fixes: the AI was told priorities LOW|MEDIUM|HIGH|CRITICAL while the controller
 * and UI only recognised EMERGENCY/HIGH/NORMAL, so a CRITICAL plan ranked lowest.
 * Plans were also executed with no parameter checks at all.
 */

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
export const PRIORITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const PRIORITY_ALIASES = { NORMAL: 'MEDIUM', NOMINAL: 'LOW', EMERGENCY: 'CRITICAL', URGENT: 'HIGH' };

export const ATTITUDE_MODES = ['SUN_TRACKING', 'EARTH_NADIR', 'VELOCITY_ALIGNED', 'DEEP_SPACE', 'MANEUVER_ALIGNMENT', 'SAFE_TUMBLE_STOP'];
export const POWER_MODES = ['NOMINAL', 'LOW_POWER', 'SURVIVAL', 'CHARGE_PRIORITY'];
export const PAYLOAD_STATES = ['OFF', 'STANDBY', 'ACTIVE'];

/** Largest single burn a plan may request (m/s). Real CubeSat avoidance burns are cm/s to tenths of m/s. */
export const MAX_BURN_DV = 2.0;

/**
 * Oldest telemetry (simulated seconds) a plan may be based on. A planner reply that took
 * 3 s of wall time at 500× warp describes a spacecraft 25 minutes in the past; executing
 * it then would point burns the wrong way. Stale plans are rejected at intake.
 */
export const MAX_PLAN_AGE_S = 120;

export const COMMAND_TYPES = [
    'SET_ATTITUDE_MODE', 'PLAN_BURN', 'EXECUTE_BURN', 'SET_POWER_MODE',
    'SET_PAYLOAD_STATE', 'ENTER_SAFE_MODE', 'EXIT_SAFE_MODE', 'RESET_OBC',
];

export function normalizePriority(p) {
    const s = String(p ?? '').trim().toUpperCase();
    if (PRIORITY_RANK[s] !== undefined) return s;
    return PRIORITY_ALIASES[s] || 'MEDIUM';
}

const clampText = (s, n = 240) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Burn vectors use [prograde, radial-out, orbit-normal] — the same order the original
 * code assumed ([1,0,0] = prograde, [0,1,0] = radial). Returns a unit vector or null.
 */
export function normalizeBurnVector(v) {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) return null;
    const n = Math.hypot(v[0], v[1], v[2]);
    if (n < 1e-6) return null;
    return v.map(x => x / n);
}

function sanitizeCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return { error: 'not an object' };
    const type = String(cmd.type ?? '').trim().toUpperCase();
    if (!COMMAND_TYPES.includes(type)) return { error: `unknown command "${clampText(type, 40)}"` };
    const p = cmd.params && typeof cmd.params === 'object' ? cmd.params : {};
    const out = { type, params: {} };
    switch (type) {
        case 'SET_ATTITUDE_MODE': {
            const t = String(p.target ?? '').toUpperCase();
            if (!ATTITUDE_MODES.includes(t)) return { error: `invalid attitude target "${clampText(t, 40)}"` };
            out.params.target = t;
            break;
        }
        case 'PLAN_BURN': {
            const vec = normalizeBurnVector(p.vector);
            const dv = Number(p.delta_v);
            if (!vec) return { error: 'burn vector must be three finite numbers, not all zero' };
            if (!(dv > 0)) return { error: 'delta_v must be > 0' };
            if (dv > MAX_BURN_DV) return { error: `delta_v ${dv} m/s exceeds the ${MAX_BURN_DV} m/s per-burn limit` };
            out.params = { vector: vec, delta_v: dv, reason: clampText(p.reason, 120) };
            break;
        }
        case 'SET_POWER_MODE': {
            const m = String(p.mode ?? '').toUpperCase();
            if (!POWER_MODES.includes(m)) return { error: `invalid power mode "${clampText(m, 40)}"` };
            out.params.mode = m;
            break;
        }
        case 'SET_PAYLOAD_STATE': {
            const s = String(p.state ?? '').toUpperCase();
            if (!PAYLOAD_STATES.includes(s)) return { error: `invalid payload state "${clampText(s, 40)}"` };
            out.params.state = s;
            break;
        }
        default:
            break; // EXECUTE_BURN, ENTER/EXIT_SAFE_MODE, RESET_OBC take no parameters
    }
    return { command: out };
}

let planCounter = 0;

/**
 * Validate and normalise a raw plan object from any planner.
 * @returns {{ plan: object|null, rejected: Array<{index:number, type:string, reason:string}> }}
 */
export function validatePlan(raw, source = 'unknown') {
    const rejected = [];
    if (!raw || typeof raw !== 'object') return { plan: null, rejected: [{ index: -1, type: '-', reason: 'plan is not an object' }] };
    const cmds = Array.isArray(raw.commands) ? raw.commands.slice(0, 12) : [];
    const commands = [];
    cmds.forEach((c, i) => {
        const r = sanitizeCommand(c);
        if (r.error) rejected.push({ index: i, type: clampText(c?.type, 40) || '?', reason: r.error });
        else commands.push(r.command);
    });
    const plan = {
        plan_id: clampText(raw.plan_id, 60) || `${source}_${Date.now()}_${++planCounter}`,
        priority: normalizePriority(raw.priority),
        summary: clampText(raw.summary || raw.reason, 300) || 'No reasoning provided',
        confidence: Number.isFinite(raw.confidence) ? Math.max(0, Math.min(1, raw.confidence)) : null,
        source,
        basedOnT: Number.isFinite(raw.basedOnT) ? raw.basedOnT : null, // mission time of the telemetry it was planned from
        commands,
    };
    return { plan, rejected };
}
