import { VirtualSatellite } from './satellite.js';
import { SatelliteBrain, AI_LOG, logDecision } from './ai-brain.js';
import { Router } from './router.js';
import { createHomeView } from './views/home.js';
import { createShipView } from './views/ship.js';
import { createEngineView } from './views/engine.js';
import { createSpaceView } from './views/space.js';
import { createCrisisView } from './views/crisis.js';
import { initCrisisAlert, fireCrisisAlert } from './ui/CrisisAlert.js';

// Loaded from `.env` (see .env.example). Never hardcode the key here.
// If it's missing the sim still runs — FlightController falls back to safety rules.
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

// ─────────────────────────────────────────────────────────────────────────────
// Time Acceleration — global multiplier
// ─────────────────────────────────────────────────────────────────────────────
const TIME_SPEEDS = [1, 5, 10, 50, 100];
let timeSpeedIndex = 0;
let timeMultiplier = 1;

function setTimeSpeed(idx) {
    timeSpeedIndex = Math.max(0, Math.min(TIME_SPEEDS.length - 1, idx));
    timeMultiplier = TIME_SPEEDS[timeSpeedIndex];
    const el = document.getElementById('time-speed');
    if (el) el.textContent = `${timeMultiplier}×`;
    const cls = document.getElementById('time-speed-btn');
    if (cls) cls.classList.toggle('speed-fast', timeMultiplier > 1);
    logDecision({ action: 'SIM_SPEED', reason: `Simulation speed set to ${timeMultiplier}×`, threat_level: 'nominal' });
}

let satellite = null;
let aiBrain = null;

async function init() {
    satellite = new VirtualSatellite();

    // ── Physics tick — respects timeMultiplier ──
    // We run the update loop at 10Hz but scale the dt by timeMultiplier
    let lastPhysicsTick = Date.now();
    setInterval(() => {
        const now = Date.now();
        const realDt = now - lastPhysicsTick;
        lastPhysicsTick = now;

        // Inject scaled time into satellite
        const scaledDt = realDt * timeMultiplier;
        satellite._scaledUpdate(scaledDt);

        // CME arrivals
        if (aiBrain) aiBrain.processCME(satellite);

        // Mission clock
        const s = Math.floor(satellite.missionTime);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sc = s % 60;
        const el = document.getElementById('mission-time');
        if (el) el.textContent = `T+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sc).padStart(2, '0')}`;
    }, 100); // 10 Hz

    // ── Router ──
    const router = new Router('page-content');
    router.register('home', () => createHomeView(satellite));
    router.register('ship', () => createShipView(satellite));
    router.register('engine', () => createEngineView(satellite));
    router.register('space', () => createSpaceView(satellite));
    router.register('crisis', () => createCrisisView(satellite, aiBrain));
    router.navigate('home');

    // ── AI Brain ──
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_api_key_here') {
        console.warn('⚠️ No VITE_GEMINI_API_KEY found — copy .env.example to .env to enable the AI planner.');
        logDecision({ action: 'AI_OFFLINE', reason: 'No API key configured. Flight computer running on deterministic safety rules.', threat_level: 'warning' });
    } else {
        try {
            aiBrain = new SatelliteBrain(GEMINI_API_KEY);
            await aiBrain.initialize();
            logDecision({ action: 'AI_ONLINE', reason: 'Gemini 2.5 Flash autonomy loop initialized. Monitoring all channels.', threat_level: 'nominal' });
            console.log('✅ AI brain online');
        } catch (e) {
            console.warn('⚠️ AI init failed:', e.message);
            logDecision({ action: 'AI_OFFLINE', reason: `AI initialization failed: ${e.message}. Emergency rules active.`, threat_level: 'warning' });
        }
    }

    // ── AI decision loop — every 15s (real time, not scaled) ──
    setInterval(async () => {
        if (!aiBrain || !aiBrain.model) return;
        try {
            // Pass the entire satellite instance so ai-brain can access satellite.flightController
            const result = await aiBrain.decide(satellite);

            // Store threat + forecast on satellite for views to read
            satellite._lastThreat = result.priority?.toLowerCase() || 'nominal';
            satellite._lastForecast = result.reason || '';

            // Fire Crisis Alert popup for HIGH / EMERGENCY plans
            if (result.priority === 'EMERGENCY' || result.priority === 'HIGH') {
                fireCrisisAlert(result, satellite);
            }

            // Note: We no longer execute commands here.
            // The AI Brain pushes the JSON sequence into FlightController.processAIPlan,
            // and physics.js executes the queue loop.

        } catch (e) {
            console.error('AI loop error:', e);
        }
    }, 15000);

    // ── Time speed buttons ──
    document.getElementById('time-slower')?.addEventListener('click', () => setTimeSpeed(timeSpeedIndex - 1));
    document.getElementById('time-faster')?.addEventListener('click', () => setTimeSpeed(timeSpeedIndex + 1));
    document.getElementById('time-speed-btn')?.addEventListener('click', () => {
        // Cycle through speeds on tap
        setTimeSpeed((timeSpeedIndex + 1) % TIME_SPEEDS.length);
    });

    initModals();
    initCrisisAlert();

    // ── Safety Override Crisis Popup — fires from FlightController.tick() ──
    let lastSafetyAlertTime = 0;
    window.addEventListener('safety-override', (e) => {
        const now = Date.now();
        if (now - lastSafetyAlertTime < 30000) return; // throttle: max one popup per 30s
        lastSafetyAlertTime = now;
        fireCrisisAlert(e.detail, satellite);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Universal Card Modal Framework (v3)
// ─────────────────────────────────────────────────────────────────────────────

export function showModal(title, htmlContent, isExpand = false) {
    const overlay = document.getElementById('card-modal');
    const contentBox = document.getElementById('card-modal-content');

    document.getElementById('card-modal-title').textContent = title;
    document.getElementById('card-modal-body').innerHTML = htmlContent;

    if (isExpand) {
        contentBox.classList.add('expand-mode');
    } else {
        contentBox.classList.remove('expand-mode');
    }

    overlay.classList.add('open');
}

export function hideModal() {
    document.getElementById('card-modal').classList.remove('open');
}

function initModals() {
    const overlay = document.getElementById('card-modal');
    document.getElementById('card-modal-close').addEventListener('click', hideModal);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) hideModal();
    });
    window.addEventListener('keydown', (e) => {
        if (e.key.toLowerCase() === 'e') {
            satellite.executeAction('evasion_burn', { deltaV_ms: 1.5 });
            console.log("🔥 MANUAL BURN: 1.5 m/s");
        }
        if (e.key.toLowerCase() === 'f') {
            // Test FlightController manual override
            satellite.flightController.processAIPlan({
                priority: "HIGH",
                summary: "Manual Keyboard Override",
                commands: [
                    { type: 'PLAN_BURN', params: { vector: [1, 0, 0], delta_v: 1.0, reason: "Manual Boost" }, duration: 1 },
                    { type: 'EXECUTE_BURN', params: {}, duration: 10 }
                ],
                plan_id: `manual_${Date.now()}`
            });
            console.log("🔥 FLIGHT CONTROLLER INJECT: 1.0 m/s Burn");
        }
        if (e.key === 'Escape' && overlay.classList.contains('open')) {
            hideModal();
        }
    });
}

document.addEventListener('DOMContentLoaded', init);
