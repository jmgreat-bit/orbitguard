/**
 * Gemini planner — browser side.
 *
 * The API key never reaches the browser any more: the page POSTs the telemetry
 * snapshot to /api/plan on the Vite dev/preview server (server/api.js), which holds
 * GEMINI_API_KEY and calls the Gemini REST API with a structured-output schema.
 * (Previously VITE_GEMINI_API_KEY was compiled into the JavaScript bundle.)
 *
 * The brain never touches the spacecraft: it returns a raw plan, and the caller
 * submits it to the FlightController, which validates it.
 */
import { buildTelemetryPrompt } from './autonomy/prompt.js';
import { THERMAL_LIMITS } from './sim/thermal.js';

export class SatelliteBrain {
    constructor({ endpoint = '/api', timeoutMs = 45000 } = {}) {
        this.endpoint = endpoint;
        this.timeoutMs = timeoutMs;
        this.status = { online: false, model: null, reason: 'not checked' };
        this.inFlight = false;
        this.failures = 0;
        this.lastLatencyMs = null;
    }

    /** Ask the server whether a key is configured. Never throws. */
    async checkHealth() {
        try {
            const r = await fetch(`${this.endpoint}/health`, { signal: AbortSignal.timeout(5000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const j = await r.json();
            this.status = j.ai?.configured
                ? { online: true, model: j.ai.model, reason: 'ready' }
                : { online: false, model: j.ai?.model ?? null, reason: 'no GEMINI_API_KEY on the server (.env)' };
        } catch (e) {
            this.status = { online: false, model: null, reason: `planner server unreachable (${e.message}) — static build?` };
        }
        return this.status;
    }

    /**
     * Request a plan for the current state. Resolves to the raw plan object.
     * @param {object} state        VirtualSatellite.getFullState()
     * @param {object} [avoidance]  VirtualSatellite.avoidanceOption(), shown to the model as SOLVER OPTION
     * Throws on network/model errors (the caller falls back to the autopilot).
     */
    async decide(state, avoidance = null) {
        if (this.inFlight) throw new Error('previous request still running');
        this.inFlight = true;
        const t0 = performance.now();
        try {
            const prompt = buildTelemetryPrompt(state, THERMAL_LIMITS, avoidance);
            const r = await fetch(`${this.endpoint}/plan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt }),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            if (!j.plan || typeof j.plan !== 'object') throw new Error('empty plan from server');
            this.failures = 0;
            this.lastLatencyMs = performance.now() - t0;
            return { ...j.plan, source: 'gemini', model: j.model };
        } catch (e) {
            this.failures += 1;
            throw e;
        } finally {
            this.inFlight = false;
        }
    }
}
