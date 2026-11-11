import { describe, it, expect, vi } from 'vitest';
import { createApiMiddleware } from '../server/api.js';
import { matchKnowledge, localAnswer, KB, ASSIST_SYSTEM_PROMPT } from '../src/assistant/knowledge.js';
import { renderAnswer } from '../src/ui/Assistant.js';
import { buildAssistContext } from '../src/assistant/context.js';
import { VirtualSatellite } from '../src/satellite.js';

function fakeReqRes(method, url, body) {
    const handlers = {};
    const req = { method, url, on: (e, f) => { handlers[e] = f; return req; }, destroy() { } };
    let resolve;
    const done = new Promise(r => { resolve = r; });
    const res = { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; resolve(); } };
    queueMicrotask(() => { if (body !== undefined) handlers.data?.(Buffer.from(JSON.stringify(body))); handlers.end?.(); });
    return { req, res, done };
}

describe('assistant knowledge base', () => {
    it('maps log codes and common questions to the right entry', () => {
        expect(matchKnowledge('Explain BATTERY_CRITICAL_OVERRIDE').id).toBe('battery');
        expect(matchKnowledge('what does THERMAL_LIMIT_OVERRIDE mean').id).toBe('thermal');
        expect(matchKnowledge('AI_ERROR Gemini request failed (HTTP 429)').id).toBe('ai_error');
        expect(matchKnowledge('why does it say SIMULATED').id).toBe('simulated');
        expect(matchKnowledge('VETOED: SET_PAYLOAD').id).toBe('veto');
    });
    it('falls back to guidance when nothing matches', () => {
        expect(localAnswer('zzz qqq')).toMatch(/GEMINI_API_KEY/);
    });
    it('has unique ids and non-empty answers', () => {
        expect(new Set(KB.map(e => e.id)).size).toBe(KB.length);
        expect(KB.every(e => e.answer.length > 60)).toBe(true);
    });
    it('system prompt treats live context as data', () => {
        expect(ASSIST_SYSTEM_PROMPT).toMatch(/never instructions/);
    });
});

describe('answer rendering is XSS-safe', () => {
    it('escapes HTML but keeps bold, code and bullets', () => {
        const h = renderAnswer('**ok** <img src=x onerror=alert(1)>\n- one `two`');
        expect(h).not.toContain('<img');
        expect(h).toContain('&lt;img');
        expect(h).toContain('<strong>ok</strong>');
        expect(h).toContain('<li>one <code>two</code></li>');
    });
});

describe('assistant context', () => {
    it('includes telemetry, planner status and recent log entries', () => {
        const sat = new VirtualSatellite({ epochMs: Date.UTC(2026, 9, 14) });
        const app = { warp: 10, paused: false, sat, planner: { using: 'autopilot', status: 'Autopilot planning' }, sources: { tle: 'SIMULATED', kp: 'SIMULATED', f107: 'SIMULATED', flares: 'SIMULATED' } };
        const ctx = buildAssistContext(app, [{ level: 'warning', action: 'AI_ERROR', source: 'gemini', missionTime: 5, reason: 'boom' }], 'crisis');
        expect(ctx).toMatch(/Time warp 10x/);
        expect(ctx).toMatch(/AI_ERROR/);
        expect(ctx).toMatch(/TELEMETRY/);
        expect(ctx.length).toBeLessThanOrEqual(9000);
    });
});

describe('POST /api/assist', () => {
    it('is unavailable without a key', async () => {
        const x = fakeReqRes('POST', '/api/assist', { question: 'hi' });
        createApiMiddleware({})(x.req, x.res, () => { }); await x.done;
        expect(x.res.statusCode).toBe(503);
    });
    it('sends the guide as system instruction, keeps the key in the header, returns text', async () => {
        const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: ' It means X. ' }] } }] }) }));
        const mw = createApiMiddleware({ GEMINI_API_KEY: 'k1' }, { fetch, now: () => 10_000 });
        const x = fakeReqRes('POST', '/api/assist', { question: 'What is Pc?', context: 'ctx', history: [{ role: 'user', text: 'a' }, { role: 'model', text: 'b' }] });
        mw(x.req, x.res, () => { }); await x.done;
        expect(x.res.statusCode).toBe(200);
        expect(JSON.parse(x.res.body).answer).toBe('It means X.');
        const [url, init] = fetch.mock.calls[0];
        expect(url).not.toContain('k1');
        expect(init.headers['x-goog-api-key']).toBe('k1');
        const sent = JSON.parse(init.body);
        expect(sent.systemInstruction.parts[0].text).toMatch(/OrbitGuard assistant/);
        expect(sent.generationConfig.responseSchema).toBeUndefined();
        expect(sent.contents).toHaveLength(3);
        expect(sent.contents.at(-1).parts[0].text).toContain('What is Pc?');
    });
    it('rejects empty or oversized questions and rate-limits', async () => {
        const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }));
        let t = 100_000;
        const mw = createApiMiddleware({ GEMINI_API_KEY: 'k' }, { fetch, now: () => t });
        let x = fakeReqRes('POST', '/api/assist', { question: '' });
        mw(x.req, x.res, () => { }); await x.done;
        expect(x.res.statusCode).toBe(400);
        t += 2000;
        x = fakeReqRes('POST', '/api/assist', { question: 'x'.repeat(1001) });
        mw(x.req, x.res, () => { }); await x.done;
        expect(x.res.statusCode).toBe(400);
        t += 2000;
        x = fakeReqRes('POST', '/api/assist', { question: 'ok?' });
        mw(x.req, x.res, () => { }); await x.done;
        expect(x.res.statusCode).toBe(200);
        x = fakeReqRes('POST', '/api/assist', { question: 'again?' });
        mw(x.req, x.res, () => { }); await x.done;
        expect(x.res.statusCode).toBe(429);
    });
});
