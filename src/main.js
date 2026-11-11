/**
 * Mission director: one simulation clock, the planner schedule, and the event log.
 *
 * - Physics runs at 10 Hz real time; each tick advances the simulation by real dt × warp
 *   (the satellite sub-steps internally, so physics is the same at any warp).
 * - Planning: every 15 s, and within ~1.5 s of anything important (a conjunction that is
 *   new or has just crossed the manoeuvre threshold, safety override, CME, drills). Gemini
 *   plans when the server has a key; otherwise, or when it fails, the deterministic
 *   autopilot plans.
 * - The collision backstop does not live on this wall-clock schedule: the simulation calls
 *   it every 30 simulated seconds, so it behaves the same at 1× and 500×.
 * - A planner reply is only useful if the spacecraft has not moved on. At a warp where
 *   Gemini's reply would be stale (latency × warp > the plan age limit) the autopilot plans
 *   routine cycles and Gemini is asked only about alerts, with the warp held down for it.
 * - Critical events drop the time warp so you can watch the response (toggle in the top bar).
 */
import { VirtualSatellite } from './satellite.js';
import { DataService } from './data-service.js';
import { SatelliteBrain } from './ai-brain.js';
import { Autopilot } from './autonomy/autopilot.js';
import { MAX_PLAN_AGE_S } from './autonomy/plan.js';
import { logEvent, setMissionClock } from './log.js';
import { Router } from './router.js';
import { app, TIME_SPEEDS } from './app.js';
import { createHomeView } from './views/home.js';
import { createShipView } from './views/ship.js';
import { createEngineView } from './views/engine.js';
import { createSpaceView } from './views/space.js';
import { createCrisisView } from './views/crisis.js';
import { initCrisisAlert, fireCrisisAlert } from './ui/CrisisAlert.js';
import { initModal } from './ui/modal.js';
import { initAssistant } from './ui/Assistant.js';
import { fmt, describeCommand } from './ui/dom.js';

const PLAN_INTERVAL_MS = 15000;
const data = new DataService();
const brain = new SatelliteBrain();
const autopilot = new Autopilot();

function priorityLevel(p) {
    return { CRITICAL: 'critical', HIGH: 'warning', MEDIUM: 'caution', LOW: 'nominal' }[p] || 'nominal';
}

// ── time warp ───────────────────────────────────────────────────────────────
function setWarp(speed, why) {
    const s = TIME_SPEEDS.includes(speed) ? speed : TIME_SPEEDS[0];
    if (s === app.warp) return;
    app.warp = s;
    document.getElementById('time-speed').textContent = `${s}×`;
    document.getElementById('time-speed-btn').dataset.fast = s > 1 ? 'true' : 'false';
    if (why) logEvent({ action: 'TIME_WARP', reason: `Time warp ${s}× — ${why}`, level: 'nominal', source: 'operator' });
}
function slowFor(reason, cap = 1) {
    if (app.autoSlow && app.warp > cap) setWarp(cap, reason);
}

// ── planning ────────────────────────────────────────────────────────────────
let decisionTimer = null;
let lastDecision = 0;
let deciding = false;
let geminiBackoffUntil = 0;
let lastDecisionSim = 0;
const AUTOPILOT_SIM_INTERVAL_S = 300; // at high warp the autopilot also plans every 5 simulated minutes

const ALERT_REASONS = new Set(['conjunction', 'override', 'drill', 'operator']);
let pendingReason = null;
function requestDecision(reason) {
    // An alert outranks a routine reason that is already waiting.
    if (!pendingReason || ALERT_REASONS.has(reason)) pendingReason = reason;
    if (decisionTimer) return;
    const wait = Math.max(1500, 5000 - (Date.now() - lastDecision));
    decisionTimer = setTimeout(() => { decisionTimer = null; const r = pendingReason; pendingReason = null; decide(r); }, wait);
}

/** Submit a plan to the flight controller and log it. Returns the controller's verdict. */
function submit(plan, source) {
    const sat = app.sat;
    const res = sat.flightController.submitPlan(plan, source);
    if (!res.plan || res.reason === 'stale') return res; // the controller's 'rejected' event is already in the log
    const p = res.plan;
    app.planner.lastSummary = p.summary;
    if (!p.commands.length) {
        logEvent({ action: 'HOLD', reason: p.summary, level: 'nominal', source });
        return res;
    }
    if (!res.accepted) return res;
    logEvent({
        action: p.commands.map(c => c.type).join(' + '),
        reason: `${p.summary} [${p.commands.map(describeCommand).join('; ')}]`,
        level: priorityLevel(p.priority), source, params: p.commands,
    });
    if (p.priority === 'CRITICAL') fireCrisisAlert({ ...p, reason: p.summary }, sat);
    return res;
}

// ── Gemini and time warp ────────────────────────────────────────────────────
const geminiAvailable = () => app.planner.mode === 'auto' && brain.status.online && Date.now() > geminiBackoffUntil;
/** Expected reply time in wall seconds (last measured, or a cautious first guess). */
const geminiLatencyS = () => (brain.lastLatencyMs ?? 4000) / 1000;
/** Fastest warp at which a reply still lands inside the plan age limit, with 25 % margin. */
const geminiMaxWarp = () => [...TIME_SPEEDS].reverse().find(s => s * geminiLatencyS() <= MAX_PLAN_AGE_S * 0.75) ?? TIME_SPEEDS[0];
const geminiFitsWarp = () => app.warp <= geminiMaxWarp();

async function decide(reason = 'scheduled') {
    const sat = app.sat;
    if (!sat || deciding || sat.mission.lost) return;
    if (sat.obcDown) return;
    deciding = true;
    lastDecision = Date.now();
    lastDecisionSim = sat.missionTime;
    try {
        let useGemini = geminiAvailable();
        if (useGemini && !geminiFitsWarp()) {
            const cap = geminiMaxWarp();
            if (ALERT_REASONS.has(reason) && app.autoSlow) {
                setWarp(cap, `holding for the Gemini planner (${reason})`);
            } else {
                useGemini = false;
                app.planner.status = `Autopilot planning at ${app.warp}× — a Gemini reply would be stale by the time it arrived. Gemini plans at ${cap}× or slower${app.autoSlow ? ', and on alerts' : ''}.`;
            }
        }
        if (useGemini) {
            try {
                const basedOnT = sat.missionTime;
                const raw = await brain.decide(sat.getFullState(), sat.avoidanceOption());
                app.planner.lastLatencyMs = brain.lastLatencyMs;
                const res = submit({ ...raw, plan_id: `gemini_${Date.now()}`, basedOnT }, 'gemini');
                if (res?.reason !== 'stale') {
                    app.planner.using = 'gemini';
                    app.planner.status = `Gemini (${brain.status.model}) planning — ${(brain.lastLatencyMs / 1000).toFixed(1)} s per decision`;
                    return;
                }
                app.planner.status = `Gemini's reply arrived ${Math.round(sat.missionTime - basedOnT)} simulated seconds late and was discarded — autopilot planned this cycle`;
            } catch (e) {
                logEvent({ action: 'AI_ERROR', reason: `Gemini request failed (${e.message}). Autopilot planned this cycle.`, level: 'warning', source: 'gemini' });
                if (brain.failures >= 3) {
                    geminiBackoffUntil = Date.now() + 120000;
                    app.planner.status = 'Gemini failing — autopilot for 2 minutes, then retrying';
                }
            }
        }
        app.planner.using = 'autopilot';
        const p = autopilot.decide(sat);
        if (p?.info) logEvent({ action: 'NOTE', reason: p.info, level: 'warning', source: 'autopilot' });
        else if (p) submit(p, 'autopilot');
    } finally {
        app.planner.lastDecisionAt = Date.now();
        deciding = false;
    }
}

// ── live data ───────────────────────────────────────────────────────────────
async function refreshSpaceWeather() {
    const sw = await data.getSpaceWeather().catch(() => null);
    const W = app.sat.spaceWeather;
    if (!sw) return;
    W.setLive({ kp: sw.kp, f107: sw.f107 });
    app.sources.kp = W.source.kp;
    app.sources.f107 = W.source.f107;
    if (Array.isArray(sw.flares) && sw.via === 'server') {
        app.sources.flares = 'LIVE';
        const recent = sw.flares.filter(f => Date.now() - Date.parse(f.beginTime) < 6 * 3600_000);
        for (const f of recent) {
            const note = W.ingestFlare(f, app.sat.missionTime);
            if (note) { logEvent({ action: 'SOLAR_FLARE', reason: `NASA DONKI: ${note}`, level: 'warning', source: 'nasa' }); requestDecision('flare'); }
        }
    }
}

// ── boot ────────────────────────────────────────────────────────────────────
function init() {
    const sat = new VirtualSatellite({ epochMs: Date.now() });
    app.sat = sat;
    window.orbitguard = app; // handy in the browser console
    setMissionClock(() => sat.missionTime);
    initModal();
    initCrisisAlert();
    initAssistant();

    // Collision backstop: called by the simulation every 30 simulated seconds.
    sat.setBackstop(() => {
        const b = autopilot.backstop(sat);
        if (b?.commands) submit(b, 'autopilot');
        else if (b?.info) logEvent({ action: 'NOTE', reason: b.info, level: 'warning', source: 'autopilot' });
    });

    // Simulation events → log, alerts, planner triggers
    sat.on('safety-override', d => {
        logEvent({ action: d.code, reason: d.summary, level: 'critical', source: 'supervisor' });
        fireCrisisAlert(d, sat);
        slowFor('safety override');
        requestDecision('override');
    });
    sat.on('safety-clear', d => logEvent({ action: `${d.code}_CLEARED`, reason: d.summary, level: 'nominal', source: 'supervisor' }));
    sat.on('space-weather', d => {
        logEvent({ ...d, source: 'space weather' });
        if (d.action === 'CME_IMPACT' || d.action === 'SEP_ARRIVAL') slowFor(d.action === 'CME_IMPACT' ? 'CME arrival' : 'solar protons arriving', 5);
        requestDecision('space weather');
    });
    sat.on('obc', d => logEvent({ ...d, source: 'obc' }));
    sat.on('conjunction', ({ type, event: e }) => {
        if (type === 'escalated') {
            logEvent({ action: 'CONJUNCTION_RED', reason: `${e.id}: tracking has tightened and Pc is now ${e.pcFormatted}, above the 1e-4 manoeuvre threshold. TCA in ${fmt.dur(e.timeToTca_s)}, miss ${e.missDistance_m.toFixed(0)} m.`, level: 'critical', source: 'screening' });
            slowFor('conjunction crossed the manoeuvre threshold', 10);
            requestDecision('conjunction');
        } else if (type === 'new') {
            if (e.pc >= 1e-5) {
                logEvent({ action: 'CONJUNCTION', reason: `${e.id}: TCA in ${fmt.dur(e.timeToTca_s)}, miss ${e.missDistance_m.toFixed(0)} m, Pc ${e.pcFormatted}`, level: e.pc >= 1e-4 ? 'critical' : 'warning', source: 'screening' });
                if (e.pc >= 1e-4) slowFor('high-risk conjunction', 10);
                requestDecision('conjunction');
            }
        } else if (type === 'passed') {
            logEvent({
                action: e.collision ? 'COLLISION' : 'TCA_PASSED',
                reason: `${e.id}: actual miss ${e.realizedMiss_m.toFixed(0)} m (peak Pc ${e.peakPc.toExponential(1)}${e.maneuvered ? ', after avoidance burn' : ''})`,
                level: e.collision ? 'critical' : 'nominal', source: 'screening',
            });
        }
    });
    sat.on('plan', e => {
        if (e.kind === 'vetoed' || e.kind === 'rejected') logEvent({ action: e.kind === 'vetoed' ? 'VETOED' : 'REJECTED', reason: `${e.command}: ${e.reason}`, level: 'warning', source: e.kind === 'vetoed' ? 'supervisor' : 'validator' });
        else if (e.kind === 'aborted') logEvent({ action: 'PLAN_ABORTED', reason: `${e.plan.summary.slice(0, 120)} — ${e.reason}`, level: 'warning', source: 'controller' });
        else if (e.kind === 'burn-complete') {
            logEvent({ action: 'BURN_COMPLETE', reason: `${e.burn.delivered.toFixed(3)} m/s delivered. ${sat.sections.thrusterPod.fuelMass.toFixed(1)} g propellant left (${sat.propulsion.remainingDeltaV.toFixed(1)} m/s).`, level: 'nominal', source: 'controller' });
            requestDecision('burn complete');
        }
    });
    sat.on('mission-lost', d => {
        logEvent({ action: 'MISSION_LOST', reason: d.reason, level: 'critical', source: 'simulation' });
        const ov = document.getElementById('mission-lost');
        ov.querySelector('[data-reason]').textContent = d.reason;
        ov.querySelector('[data-stats]').textContent =
            `${fmt.clock(sat.missionTime)} flown, ${sat.mission.imagesCaptured} images, ${sat.mission.maneuvers} manoeuvres, ${sat.mission.conjunctionsPassed} conjunctions passed.`;
        ov.hidden = false;
        setWarp(1);
    });

    // Physics loop
    let last = performance.now();
    let errorShown = 0;
    setInterval(() => {
        const now = performance.now();
        const dt = Math.min(1, (now - last) / 1000);
        last = now;
        try {
            if (!app.paused) sat.step(dt * app.warp);
        } catch (e) {
            if (Date.now() - errorShown > 10000) { errorShown = Date.now(); console.error('Simulation step failed', e); logEvent({ action: 'SIM_ERROR', reason: e.message, level: 'critical', source: 'simulation' }); }
        }
        // Whenever Gemini is not the one planning routine cycles, the autopilot plans on simulation time.
        const geminiRoutine = geminiAvailable() && geminiFitsWarp();
        if (!geminiRoutine && !deciding && sat.missionTime - lastDecisionSim > AUTOPILOT_SIM_INTERVAL_S) decide('sim interval');
        document.getElementById('mission-time').textContent = fmt.clock(sat.missionTime);
        document.getElementById('utc-time').textContent = new Date(sat.simTimeMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    }, 100);

    // Views
    const router = new Router('page-content');
    router.register('home', () => createHomeView());
    router.register('ship', () => createShipView());
    router.register('engine', () => createEngineView());
    router.register('space', () => createSpaceView());
    router.register('crisis', () => createCrisisView());
    router.navigate();

    // Top-bar controls
    const idx = () => TIME_SPEEDS.indexOf(app.warp);
    document.getElementById('time-slower').addEventListener('click', () => setWarp(TIME_SPEEDS[Math.max(0, idx() - 1)]));
    document.getElementById('time-faster').addEventListener('click', () => setWarp(TIME_SPEEDS[Math.min(TIME_SPEEDS.length - 1, idx() + 1)]));
    document.getElementById('time-speed-btn').addEventListener('click', () => {
        app.paused = !app.paused;
        document.getElementById('time-speed-btn').dataset.paused = String(app.paused);
        document.getElementById('time-speed-btn').setAttribute('aria-pressed', String(app.paused));
        document.getElementById('time-speed').textContent = app.paused ? 'Paused' : `${app.warp}×`;
    });
    const auto = document.getElementById('auto-slow');
    auto.checked = app.autoSlow;
    auto.addEventListener('change', () => { app.autoSlow = auto.checked; });
    document.getElementById('mission-restart').addEventListener('click', () => location.reload());

    app.setWarp = setWarp;
    app.requestDecision = requestDecision;
    app.injectDrill = (id) => {
        const entry = sat.injectEvent(id);
        if (entry) logEvent({ ...entry, source: 'drill' });
        requestDecision('drill');
    };

    // Planner + data
    logEvent({ action: 'MISSION_START', reason: `OrbitGuard-1 in a ${sat.orbit.baseAltitude.toFixed(0)} km, ${sat.orbit.inclination.toFixed(1)}° orbit. Simulation clock starts at the current UTC time.`, level: 'nominal', source: 'simulation' });
    brain.checkHealth().then(s => {
        app.planner.online = s.online;
        app.planner.model = s.model;
        app.planner.status = s.online ? `Gemini (${s.model}) ready` : `Autopilot planning — ${s.reason}`;
        logEvent({ action: s.online ? 'AI_ONLINE' : 'AI_OFFLINE', reason: s.online ? `Gemini planner ready (${s.model}). The autopilot stays on as collision backstop.` : `Gemini unavailable: ${s.reason}. The rule-based autopilot is flying.`, level: s.online ? 'nominal' : 'caution', source: 'planner' });
        decide('startup');
    });
    data.getOrbitalData().then(tle => {
        if (tle && sat.adoptTle(tle)) {
            app.sources.tle = tle.source || 'LIVE';
            logEvent({ action: 'TLE_LOADED', reason: `Reference orbit from ${tle.name} (${tle.source}), epoch ${new Date(tle.epochMs).toISOString().slice(0, 16)} UTC: ${tle.altitude.toFixed(0)} km, ${tle.inclination.toFixed(2)}°.`, level: 'nominal', source: 'celestrak' });
        } else {
            logEvent({ action: 'TLE_FALLBACK', reason: 'CelesTrak unreachable — flying the built-in ISS-like reference orbit.', level: 'caution', source: 'celestrak' });
        }
    });
    refreshSpaceWeather();
    setInterval(refreshSpaceWeather, 15 * 60_000);
    setInterval(() => decide('scheduled'), PLAN_INTERVAL_MS);
}

document.addEventListener('DOMContentLoaded', init);
