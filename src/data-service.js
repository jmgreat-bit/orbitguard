/**
 * Live data with honest fallbacks. Every result carries a `source` so the UI can show
 * LIVE vs SIMULATED badges instead of passing invented numbers off as real.
 *
 * Primary path: the local API (server/api.js) fetches CelesTrak / NOAA / NASA from Node,
 * which avoids browser CORS limits. If the page is served statically (no /api), we try
 * the public endpoints directly, then fall back to the simulation defaults.
 */
import { parseTLE } from './tle.js';
import { latestKp, latestF107 } from './feeds.js';

const timeout = (ms) => AbortSignal.timeout(ms);

export class DataService {
    async getOrbitalData() {
        try {
            const r = await fetch('/api/tle', { signal: timeout(9000) });
            if (r.ok) return await r.json();
        } catch { /* try direct */ }
        try {
            const r = await fetch('https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE', { signal: timeout(8000) });
            if (r.ok) return parseTLE(await r.text(), 'LIVE (CelesTrak)');
        } catch { /* fall back */ }
        return null; // satellite.js uses its built-in ISS-like reference orbit
    }

    async getSpaceWeather() {
        try {
            const r = await fetch('/api/space-weather', { signal: timeout(15000) });
            if (r.ok) return { ...(await r.json()), via: 'server' };
        } catch { /* try direct */ }
        const out = { kp: null, f107: null, flares: [], errors: [], via: 'browser' };
        await Promise.allSettled([
            fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', { signal: timeout(8000) })
                .then(r => r.json()).then(j => { out.kp = latestKp(j); }),
            fetch('https://services.swpc.noaa.gov/json/f107_cm_flux.json', { signal: timeout(8000) })
                .then(r => r.json()).then(j => { out.f107 = latestF107(j); }),
        ]);
        return out;
    }
}
