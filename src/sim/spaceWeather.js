/**
 * Space weather state: geomagnetic Kp, F10.7 solar flux, solar energetic particle
 * (SEP) radiation and coronal mass ejection (CME) storms — all on simulation time.
 *
 * Fixes from the original:
 *  - the CME queue lived inside the Gemini brain, so with no API key CMEs never arrived;
 *  - arrivals used wall-clock time, ignoring time acceleration;
 *  - the radiation spike was overwritten by the environment update 100 ms later.
 * Here SEP radiation and storm Kp are persistent states that decay physically.
 */

const SEP_DECAY_S = 6 * 3600;    // proton flux e-folding time
const STORM_DECAY_S = 9 * 3600;  // geomagnetic storm recovery

export class SpaceWeather {
    constructor({ rng = Math.random } = {}) {
        this.rng = rng;
        this.baseKp = 3;
        this.f107 = 150;
        this.stormKp = 0;
        this.sepBoost = 0;           // mSv/h added to the dose rate
        this.pending = [];           // { type: 'SEP'|'CME', at, magnitude, label }
        this.seenFlares = new Set();
        this.source = { kp: 'SIMULATED', f107: 'SIMULATED', flares: 'SIMULATED' };
        this.lastFlare = null;
    }

    get kp() {
        return Math.min(9, Math.max(this.baseKp, this.stormKp));
    }

    /** Apply live values (from NOAA SWPC) when available. */
    setLive({ kp, f107 } = {}) {
        if (Number.isFinite(kp)) { this.baseKp = Math.max(0, Math.min(9, kp)); this.source.kp = 'LIVE'; }
        if (Number.isFinite(f107) && f107 > 50 && f107 < 400) { this.f107 = f107; this.source.f107 = 'LIVE'; }
    }

    queue(type, at, magnitude, label) {
        this.pending.push({ type, at, magnitude, label });
        this.pending.sort((a, b) => a.at - b.at);
    }

    /**
     * Turn a solar flare report into consequences on the sim clock.
     * X-class: SEP protons ~30–90 min later and a CME storm 18–48 h later.
     * Strong M-class (≥M5): smaller SEP event and a weaker storm.
     * Returns a short description, or null if the flare is too weak or already seen.
     */
    ingestFlare(flare, now) {
        const cls = String(flare?.classType || '').toUpperCase();
        const key = flare?.flrID || `${cls}@${flare?.beginTime}`;
        if (!cls || this.seenFlares.has(key)) return null;
        this.seenFlares.add(key);
        const letter = cls[0];
        const mag = parseFloat(cls.slice(1)) || 1;
        this.lastFlare = { classType: cls, beginTime: flare.beginTime };
        if (letter === 'X') {
            this.queue('SEP', now + (30 + 60 * this.rng()) * 60, Math.min(3, 0.6 + 0.15 * mag), `${cls} flare protons`);
            this.queue('CME', now + (18 + 30 * this.rng()) * 3600, Math.min(8.7, 6 + 0.3 * mag), `${cls} flare CME`);
            return `${cls} flare: SEP protons expected within ~1.5 h, CME storm in ~1–2 days`;
        }
        if (letter === 'M' && mag >= 5) {
            this.queue('SEP', now + (40 + 60 * this.rng()) * 60, 0.25, `${cls} flare protons`);
            this.queue('CME', now + (24 + 36 * this.rng()) * 3600, 6, `${cls} flare CME`);
            return `${cls} flare: minor SEP and possible storm`;
        }
        return null;
    }

    /** Advance by dt seconds; returns the events that arrived. */
    tick(now, dt) {
        this.sepBoost *= Math.exp(-dt / SEP_DECAY_S);
        if (this.sepBoost < 1e-4) this.sepBoost = 0;
        this.stormKp = this.stormKp > 0 ? this.stormKp * Math.exp(-dt / STORM_DECAY_S) : 0;
        if (this.stormKp < this.baseKp) this.stormKp = 0;
        const arrived = [];
        while (this.pending.length && this.pending[0].at <= now) {
            const ev = this.pending.shift();
            if (ev.type === 'SEP') this.sepBoost += ev.magnitude;
            if (ev.type === 'CME') this.stormKp = Math.max(this.stormKp, ev.magnitude);
            arrived.push(ev);
        }
        return arrived;
    }
}
