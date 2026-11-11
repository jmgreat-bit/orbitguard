/**
 * Mission log — one ring buffer shared by the planners, the flight controller and the UI.
 * (Previously lived in ai-brain.js and was mirrored onto window.__AI_LOG.)
 *
 * Entry: { action, reason, level: nominal|caution|warning|critical, source, params?, timestamp, missionTime }
 */
export const MISSION_LOG = [];
const MAX = 200;
const listeners = new Set();
let clock = () => 0;

/** main.js points this at the satellite's mission clock. */
export function setMissionClock(fn) { clock = fn; }

const LEVELS = new Set(['nominal', 'caution', 'warning', 'critical']);
const LEVEL_ALIASES = { low: 'nominal', medium: 'caution', high: 'warning', emergency: 'critical', normal: 'nominal' };

export function normalizeLevel(l) {
    const s = String(l || 'nominal').toLowerCase();
    return LEVELS.has(s) ? s : (LEVEL_ALIASES[s] || 'nominal');
}

export function logEvent({ action, reason = '', level, threat_level, source = 'system', params } = {}) {
    const entry = {
        action: String(action || 'EVENT').slice(0, 40),
        reason: String(reason).slice(0, 400),
        level: normalizeLevel(level ?? threat_level),
        source, params, timestamp: Date.now(), missionTime: clock(),
    };
    MISSION_LOG.unshift(entry);
    if (MISSION_LOG.length > MAX) MISSION_LOG.length = MAX;
    for (const fn of listeners) { try { fn(entry); } catch (e) { console.error(e); } }
    return entry;
}

/** Subscribe; returns an unsubscribe function. */
export function onLog(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Back-compat name used by older code. */
export const logDecision = logEvent;
