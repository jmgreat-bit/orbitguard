import { describe, it, expect, vi } from 'vitest';
import { parseTLE, tleChecksumOk } from '../src/tle.js';
import { createApiMiddleware, extractJson, latestKp, latestF107 } from '../server/api.js';
import { VirtualSatellite } from '../src/satellite.js';
import { Autopilot } from '../src/autonomy/autopilot.js';
import { buildTelemetryPrompt, PLAN_SCHEMA } from '../src/autonomy/prompt.js';
import { THERMAL_LIMITS } from '../src/sim/thermal.js';

// The canonical example TLE (ISS, 2008) — checksums are valid.
const ISS_TLE = `ISS (ZARYA)
1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537`;

describe('TLE parsing', () => {
    it('validates the mod-10 checksums', () => {
        const [, l1, l2] = ISS_TLE.split('\n');
        expect(tleChecksumOk(l1)).toBe(true);
        expect(tleChecksumOk(l2)).toBe(true);
        expect(tleChecksumOk(l1.slice(0, 68) + '0')).toBe(false);
    });

    it('reads fields from fixed columns (regression: inclination parsed as 98067)', () => {
        const t = parseTLE(ISS_TLE);
        expect(t.name).toBe('ISS (ZARYA)');
        expect(t.inclination).toBeCloseTo(51.6416, 4);
        expect(t.raan).toBeCloseTo(247.4627, 4);
        expect(t.eccentricity).toBeCloseTo(0.0006703, 7);
        expect(t.meanMotion).toBeCloseTo(15.72125391, 8);
        expect(t.altitude).toBeGreaterThan(340);
        expect(t.altitude).toBeLessThan(360);
        expect(new Date(t.epochMs).toISOString().slice(0, 10)).toBe('2008-09-20');
    });

    it('rejects corrupted input', () => {
        expect(() => parseTLE(ISS_TLE.replace('51.6416', '51.6417'))).toThrow(/checksum/);
        expect(() => parseTLE('hello')).toThrow();
    });
});

describe('space-weather feed parsing is tolerant of format changes', () => {
    it('reads Kp from array-of-arrays with a header row, or from objects', () => {
        expect(latestKp([['time_tag', 'Kp'], ['2026-10-13 21:00:00', '2.33'], ['2026-10-14 00:00:00', '3.67']])).toBeCloseTo(3.67);
        expect(latestKp([{ time_tag: 'x', Kp: 4 }, { time_tag: 'y', kp_index: 5 }])).toBe(5);
        expect(latestKp('nope')).toBeNull();
    });
    it('reads F10.7 from the flux field', () => {
        expect(latestF107([{ flux: 140 }, { flux: 152.3 }])).toBeCloseTo(152.3);
    });
});

function fakeReqRes(method, url, body) {
    const listeners = {};
    const req = {
        method, url,
        on(ev, fn) { listeners[ev] = fn; return req; },
        destroy() { },
    };
    const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; this.done(); } };
    const done = new Promise(r => { res.done = r; });
    queueMicrotask(() => { if (body !== undefined) listeners.data?.(Buffer.from(JSON.stringify(body))); listeners.end?.(); });
    return { req, res, done };
}

describe('local API', () => {
    it('reports no key without leaking anything, and refuses to plan', async () => {
        const mw = createApiMiddleware({});
        let x = fakeReqRes('GET', '/api/health');
        mw(x.req, x.res, () => { }); await x.done;
        expect(JSON.parse(x.res.body).ai.configured).toBe(false);
        x = fakeReqRes('POST', '/api/plan', { prompt: 'x'.repeat(50) });
        mw(x.req, x.res, () => { }); await x.done;
        expect(x.res.statusCode).toBe(503);
    });

    it('calls Gemini with the key in a header (not the URL), JSON mode and the schema', async () => {
        const fetch = vi.fn(async (url, init) => ({
            ok: true, status: 200,
            json: async () => ({ candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"priority":"HIGH","summary":"s","commands":[]}' }] } }] }),
        }));
        const mw = createApiMiddleware({ GEMINI_API_KEY: 'secret-key', GEMINI_MODEL: 'gemini-test' }, { fetch });
        const x = fakeReqRes('POST', '/api/plan', { prompt: 'telemetry '.repeat(5) });
        mw(x.req, x.res, () => { }); await x.done;
        expect(x.res.statusCode).toBe(200);
        expect(JSON.parse(x.res.body).plan.priority).toBe('HIGH');
        const [url, init] = fetch.mock.calls[0];
        expect(url).toContain('/models/gemini-test:generateContent');
        expect(url).not.toContain('secret-key');
        expect(init.headers['x-goog-api-key']).toBe('secret-key');
        const sent = JSON.parse(init.body);
        expect(sent.generationConfig.responseMimeType).toBe('application/json');
        expect(sent.generationConfig.responseSchema).toEqual(PLAN_SCHEMA);
    });

    it('explains a missing model', async () => {
        const fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'models/x is not found' } }) }));
        const mw = createApiMiddleware({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'x' }, { fetch });
        const x = fakeReqRes('POST', '/api/plan', { prompt: 'telemetry '.repeat(5) });
        mw(x.req, x.res, () => { }); await x.done;
        expect(JSON.parse(x.res.body).error).toMatch(/GEMINI_MODEL/);
    });

    it('passes non-API requests through', async () => {
        const next = vi.fn();
        await createApiMiddleware({})({ url: '/index.html', method: 'GET' }, {}, next);
        expect(next).toHaveBeenCalled();
    });

    it('extracts JSON from a fenced reply', () => {
        expect(extractJson('```json\n{"a":1}\n```').a).toBe(1);
    });
});

describe('planner prompt', () => {
    it('contains the numbers the planner needs and no undefined values', () => {
        const sat = new VirtualSatellite({ epochMs: Date.UTC(2026, 9, 14), conjunctionRatePerHour: 0 });
        sat.injectEvent('debris_close');
        for (let i = 0; i < 120; i++) sat.step(10);
        const p = buildTelemetryPrompt(sat.getFullState(), THERMAL_LIMITS);
        expect(p).toMatch(/CONJUNCTIONS:\n {2}.+Pc /);
        expect(p).toMatch(/reserve 3 m\/s/);
        expect(p).not.toMatch(/undefined|NaN/);
    });
});

describe('autopilot flies the mission with no AI', () => {
    function seeded(a = 3) {
        return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    }

    it('one day: dodges a drilled conjunction, keeps the battery up, captures images', () => {
        const sat = new VirtualSatellite({ epochMs: Date.UTC(2026, 9, 14, 6), rng: seeded(11), conjunctionRatePerHour: 0.3 });
        const ap = new Autopilot();
        const overrides = [];
        sat.on('safety-override', o => overrides.push(o.code));
        let minSoc = 100;
        for (let t = 0; t < 86400; t += 10) {
            if (t === 3600) sat.injectEvent('debris_close');
            if (t % 60 === 0) {
                const p = ap.decide(sat);
                if (p && p.commands) sat.flightController.submitPlan(p, 'autopilot');
            }
            sat.step(10);
            minSoc = Math.min(minSoc, sat.sections.batteryBay.charge);
            if (sat.mission.lost) break;
        }
        expect(sat.mission.lost).toBe(false);
        expect(sat.mission.maneuvers).toBeGreaterThanOrEqual(1);
        expect(sat.conjunctions.history.every(h => !h.collision)).toBe(true);
        expect(minSoc).toBeGreaterThan(30);
        expect(overrides).not.toContain('BATTERY_CRITICAL_OVERRIDE');
        expect(sat.mission.imagesCaptured).toBeGreaterThan(50);
    });

    it('handles the thermal runaway drill before the supervisor has to', () => {
        const sat = new VirtualSatellite({ epochMs: Date.UTC(2026, 9, 14, 6), rng: seeded(5), conjunctionRatePerHour: 0 });
        const ap = new Autopilot();
        const overrides = [];
        sat.on('safety-override', o => overrides.push(o.code));
        sat.injectEvent('thermal_runaway');
        for (let t = 0; t < 2 * 3600; t += 5) {
            if (t % 30 === 0) { const p = ap.decide(sat); if (p?.commands) sat.flightController.submitPlan(p, 'autopilot'); }
            sat.step(5);
        }
        expect(sat.faults.adcsRunaway).toBe(false);          // OBC reset cleared it
        expect(overrides).not.toContain('THERMAL_LIMIT_OVERRIDE');
        expect(sat.sections.onboardComputer.temperature).toBeLessThan(60);
    });
});
