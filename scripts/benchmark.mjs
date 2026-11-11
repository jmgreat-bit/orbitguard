/**
 * Monte Carlo scorecard for the autonomy stack: seeded multi-day missions, no browser.
 *
 *   npm run bench                  all scenarios, 30 missions × 3 days each (a few minutes)
 *   npm run bench -- warp500 10    one scenario, 10 missions
 *
 * Columns: missions lost · conjunctions whose Pc peaked ≥ 1e-4 · of those, still ≥ 1e-4 at
 * closest approach (the number that matters: should be 0) · Δv per mission · lowest battery ·
 * supervisor overrides.
 */
import { VirtualSatellite } from '../src/satellite.js';
import { Autopilot } from '../src/autonomy/autopilot.js';

const seeded = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

/**
 * @param {object} o
 * @param {number} o.planEveryS   simulated seconds between full autopilot planning cycles (0 = never)
 * @param {number} o.stepS        simulated seconds per physics tick (50 = 500× warp in the app)
 * @param {boolean} o.backstop    register the sim-clock collision backstop, as main.js does
 * @param {number} o.rate         screening events per simulated hour
 */
function fly(seed, days, { planEveryS = 300, stepS = 10, backstop = true, rate = 0.35 }) {
    const sat = new VirtualSatellite({ epochMs: Date.UTC(2026, 10, 11, 9), rng: seeded(seed), conjunctionRatePerHour: rate });
    const ap = new Autopilot();
    const submit = (p) => { if (p?.commands) sat.flightController.submitPlan(p, 'autopilot'); };
    if (backstop) sat.setBackstop(() => submit(ap.backstop(sat)));
    const r = { lost: false, peakRed: 0, redAtTca: 0, minSoc: 100, overrides: 0 };
    sat.on('safety-override', () => r.overrides++);
    sat.on('conjunction', ({ type, event: e }) => {
        if (type !== 'passed') return;
        if (e.peakPc >= 1e-4) r.peakRed++;
        if (e.pc >= 1e-4) r.redAtTca++;
    });
    let nextPlan = 0;
    for (let t = 0; t < days * 86400 && !sat.mission.lost; t += stepS) {
        if (planEveryS && t >= nextPlan) { nextPlan = t + planEveryS; submit(ap.decide(sat)); }
        sat.step(stepS);
        r.minSoc = Math.min(r.minSoc, sat.sections.batteryBay.charge);
    }
    return { ...r, lost: sat.mission.lost, dv: sat.propulsion.totalDeltaVUsed };
}

const SCENARIOS = {
    realtime: ['autopilot planning every 60 s', { planEveryS: 60 }],
    warp500: ['500× warp: autopilot every 300 s, 50 s ticks', { planEveryS: 300, stepS: 50 }],
    backstopOnly: ['no planner at all, backstop only, 50 s ticks', { planEveryS: 0, stepS: 50 }],
    dense: ['3× debris rate, autopilot every 60 s', { planEveryS: 60, rate: 1.0 }],
};

const [only, nArg] = process.argv.slice(2);
const N = Number(nArg) || 30, DAYS = 3;
console.log(`${N} missions × ${DAYS} days per scenario\n`);
for (const [key, [label, opts]] of Object.entries(SCENARIOS)) {
    if (only && only !== key) continue;
    const R = [];
    for (let s = 1; s <= N; s++) R.push(fly(s, DAYS, opts));
    const sum = (k) => R.reduce((a, r) => a + r[k], 0);
    console.log(`${key.padEnd(13)} ${label}`);
    console.log(`              lost ${R.filter(r => r.lost).length}/${N} · peaked red ${sum('peakRed')} · RED AT CLOSEST APPROACH ${sum('redAtTca')} · Δv ${(sum('dv') / N).toFixed(2)} m/s per mission · lowest battery ${Math.min(...R.map(r => r.minSoc)).toFixed(0)}% · overrides ${sum('overrides')}\n`);
}
