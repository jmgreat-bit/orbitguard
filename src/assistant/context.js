/**
 * Builds the "what is on screen right now" context sent to the assistant, and keeps a short
 * ring of browser errors so the assistant can explain software problems too.
 */
import { buildTelemetryPrompt } from '../autonomy/prompt.js';
import { THERMAL_LIMITS } from '../sim/thermal.js';

const errors = [];
let installed = false;

/** Capture uncaught errors and unhandled rejections (idempotent). */
export function installErrorCapture(win = window) {
    if (installed) return;
    installed = true;
    const push = (msg) => { errors.unshift({ at: Date.now(), msg: String(msg).slice(0, 300) }); if (errors.length > 8) errors.length = 8; };
    win.addEventListener('error', e => push(`${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
    win.addEventListener('unhandledrejection', e => push(`Unhandled rejection: ${e.reason?.message || e.reason}`));
    const orig = win.console.error.bind(win.console);
    win.console.error = (...a) => { push(a.map(x => (x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); orig(...a); };
}

export const recentErrors = () => errors.slice();

/**
 * @param {object} app   shared app state
 * @param {Array} log    MISSION_LOG (newest first)
 * @param {string} page  current route name
 */
export function buildAssistContext(app, log, page = '') {
    const parts = [];
    parts.push(`Current page: ${page || 'unknown'}. Time warp ${app.warp}x${app.paused ? ' (paused)' : ''}.`);
    parts.push(`Planner: using ${app.planner.using}; ${app.planner.status}`);
    parts.push(`Data sources: orbit ${app.sources.tle}, Kp ${app.sources.kp}, F10.7 ${app.sources.f107}, flares ${app.sources.flares}.`);
    if (app.sat) {
        try {
            parts.push('TELEMETRY\n' + buildTelemetryPrompt(app.sat.getFullState(), THERMAL_LIMITS).slice(0, 5000));
        } catch (e) {
            parts.push(`(telemetry unavailable: ${e.message})`);
        }
        const sup = app.sat.flightController?.supervisor;
        if (sup) parts.push(`Supervisor latches: ${JSON.stringify(sup)}`);
        if (app.sat.mission?.lost) parts.push('MISSION IS LOST.');
    }
    const lines = (log || []).slice(0, 15).map(e => `[${e.level}] ${e.action} (${e.source}) T+${Math.round(e.missionTime || 0)}s: ${e.reason}`);
    parts.push('RECENT MISSION LOG (newest first)\n' + (lines.join('\n') || '(empty)'));
    const errs = recentErrors();
    if (errs.length) parts.push('RECENT BROWSER ERRORS\n' + errs.map(e => `- ${e.msg}`).join('\n'));
    return parts.join('\n\n').slice(0, 9000);
}
