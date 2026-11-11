import { describe, it, expect } from 'vitest';
import {
    atmosphericDensity, dragDecayRate, orbitalLifetimeDays, j2RaanDrift,
    geodeticAltitude, ellipsoidRadiusKm, tsiolkovskyFuel, maxDeltaV,
    semiMajorAxisChange, hohmannDeltaV, meanMotion, cwDisplacement, bPlaneShift,
    chanCollisionProbability, classifyCollisionRisk, formatPc,
    orbitalVelocity, orbitalPeriod, relativeSpeed, RE,
} from '../src/physics.js';

// Brute-force 2-D Gaussian integral over the hard-body disk (polar grid, centred
// on the disk). Independent of Chan's series, used to cross-check it.
function pcQuadrature(d, sigma, R, nr = 400, nt = 720) {
    let s = 0;
    const dr = R / nr, dth = 2 * Math.PI / nt;
    for (let i = 0; i < nr; i++) {
        const r = (i + 0.5) * dr;
        for (let j = 0; j < nt; j++) {
            const th = (j + 0.5) * dth;
            const dx = r * Math.cos(th) - d, dy = r * Math.sin(th);
            s += Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) * r * dr * dth;
        }
    }
    return s / (2 * Math.PI * sigma * sigma);
}

describe('atmosphere and drag', () => {
    it('density decreases monotonically with altitude', () => {
        let prev = Infinity;
        for (let h = 0; h <= 1000; h += 5) {
            const rho = atmosphericDensity(h);
            expect(rho).toBeLessThanOrEqual(prev);
            prev = rho;
        }
    });

    it('decay rate includes the factor v (regression: was ~7,660x too small)', () => {
        // Same inputs as the original bug report: 420 km, Am 0.025, Kp 3 → old code gave 3.1e-5 km/day.
        const kmPerDay = dragDecayRate(420, 7660, 2.2, 0.025, 3) * 86400;
        expect(kmPerDay).toBeLessThan(-0.1);
        expect(kmPerDay).toBeGreaterThan(-2);
    });

    it('matches the closed form dr/dt = -rho Cd (A/m) v r', () => {
        const alt = 400, v = orbitalVelocity(alt) * 1000, r = RE + alt * 1000;
        const expected = -atmosphericDensity(alt) * 2.2 * 0.02 * v * r / 1000; // km/s, Kp 3 = no storm term
        expect(dragDecayRate(alt, v, 2.2, 0.02, 3, 150)).toBeCloseTo(expected, 12);
    });

    it('a 1U CubeSat deployed at ~420 km lasts months, not decades', () => {
        const days = orbitalLifetimeDays(420, 2.2, 0.015, 3, 150);
        expect(days).toBeGreaterThan(60);
        expect(days).toBeLessThan(3 * 365);
    });

    it('high solar flux and storms shorten lifetime', () => {
        const quiet = orbitalLifetimeDays(420, 2.2, 0.015, 2, 80);
        const active = orbitalLifetimeDays(420, 2.2, 0.015, 7, 220);
        expect(active).toBeLessThan(quiet / 2);
    });
});

describe('J2 and geodetic altitude', () => {
    it('ISS-like orbit regresses about 5 deg/day westward', () => {
        const d = j2RaanDrift(420, 51.6, 0);
        expect(d).toBeLessThan(-4.5);
        expect(d).toBeGreaterThan(-5.5);
    });

    it('sun-synchronous inclination at 700 km drifts about +0.9856 deg/day', () => {
        expect(j2RaanDrift(700, 98.19, 0)).toBeCloseTo(0.9856, 1);
    });

    it('ellipsoid is ~21 km flatter at the poles', () => {
        expect(ellipsoidRadiusKm(0) - ellipsoidRadiusKm(90)).toBeCloseTo(21.38, 1);
    });

    it('a circular orbit sits 5-15 km higher above the surface at 51.6 deg than at the equator', () => {
        const r = 6371 + 420;
        const wobble = geodeticAltitude(r, 51.6) - geodeticAltitude(r, 0);
        expect(wobble).toBeGreaterThan(5);
        expect(wobble).toBeLessThan(15);
    });
});

describe('rocket equation and manoeuvres', () => {
    it('tsiolkovskyFuel returns a number in kg (regression: callers used .fuelKg)', () => {
        const kg = tsiolkovskyFuel(1, 1.31, 60);
        expect(typeof kg).toBe('number');
        expect(kg).toBeCloseTo(1.31 * (1 - Math.exp(-1 / (60 * 9.80665))), 10);
    });

    it('requires an explicit Isp (regression: silently defaulted to hydrazine 220 s)', () => {
        expect(() => tsiolkovskyFuel(1, 1.3)).toThrow();
        expect(() => maxDeltaV(0.06, 1.25)).toThrow();
    });

    it('fuel for delta-v and delta-v for fuel are inverses', () => {
        const dry = 1.25, fuel = 0.06, isp = 60;
        const dv = maxDeltaV(fuel, dry, isp);
        expect(tsiolkovskyFuel(dv, dry + fuel, isp)).toBeCloseTo(fuel, 10);
    });

    it('prograde 1 m/s at 420 km raises the orbit about 1.77 km', () => {
        expect(semiMajorAxisChange(1, 420)).toBeCloseTo(1.77, 2);
    });

    it('Hohmann 1 km raise costs ~0.56 m/s (regression: engine view showed 2x)', () => {
        const dv = hohmannDeltaV(420, 421);
        expect(dv).toBeGreaterThan(0.55);
        expect(dv).toBeLessThan(0.58);
        // consistency with the tangential formula: Δa per unit Δv
        expect(semiMajorAxisChange(dv, 420)).toBeCloseTo(1, 2);
    });

    it('orbital period at 420 km is ~92.8 minutes', () => {
        expect(orbitalPeriod(420)).toBeCloseTo(92.8, 0);
    });
});

describe('Clohessy-Wiltshire avoidance geometry', () => {
    const n = meanMotion(420);
    const halfOrbit = Math.PI / n;

    it('prograde burn half an orbit early raises the satellite by 4 dv / n', () => {
        const d = cwDisplacement(0, 0.1, 0, n, halfOrbit);
        expect(d.x).toBeCloseTo(4 * 0.1 / n, 6);
        expect(4 * 1 / n).toBeGreaterThan(3400); // ≈3.5 km per m/s
        expect(4 * 1 / n).toBeLessThan(3600);
        expect(d.y).toBeLessThan(0); // and it falls behind
    });

    it('no displacement at the moment of the burn', () => {
        const d = cwDisplacement(0.3, 0.2, 0.1, n, 0);
        expect(Math.hypot(d.x, d.y, d.z)).toBeLessThan(1e-9);
    });

    it('a radial burn returns to the same radius after a full orbit', () => {
        const d = cwDisplacement(0.2, 0, 0, n, 2 * halfOrbit);
        expect(Math.abs(d.x)).toBeLessThan(1e-6);
    });

    it('along-track shift does not help in a head-on conjunction', () => {
        const s = bPlaneShift({ x: 0, y: 1000, z: 0 }, 180);
        expect(Math.abs(s.zeta)).toBeLessThan(1e-9);
        expect(bPlaneShift({ x: 0, y: 1000, z: 0 }, 30).zeta).toBeCloseTo(1000 * Math.cos(Math.PI / 12), 6);
    });

    it('relative speed of a head-on LEO pass is ~2v', () => {
        expect(relativeSpeed(7660, 180)).toBeCloseTo(15320, 0);
    });
});

describe("Chan collision probability", () => {
    it('d = 0 gives 1 - exp(-R^2/2s^2), not 1 (regression)', () => {
        const pc = chanCollisionProbability(0, 500, 10);
        expect(pc).toBeCloseTo(1 - Math.exp(-100 / (2 * 500 * 500)), 12);
        expect(pc).toBeLessThan(1e-3);
    });

    it.each([
        [0, 200, 10], [150, 200, 10], [400, 200, 10], [1000, 300, 20],
        [50, 40, 15], [2000, 900, 10], [30, 10, 25],
    ])('agrees with brute-force quadrature at d=%i m, sigma=%i m, R=%i m', (d, s, R) => {
        const chan = chanCollisionProbability(d, s, R);
        const quad = pcQuadrature(d, s, R);
        expect(Math.abs(chan - quad) / Math.max(quad, 1e-300)).toBeLessThan(2e-3);
    });

    it('is monotonic in miss distance', () => {
        let prev = 1;
        for (let d = 0; d <= 3000; d += 100) {
            const pc = chanCollisionProbability(d, 400, 10);
            expect(pc).toBeLessThanOrEqual(prev + 1e-15);
            prev = pc;
        }
    });

    it('never exceeds 1 even when the disk dominates the uncertainty', () => {
        const pc = chanCollisionProbability(5, 1, 100);
        expect(pc).toBeGreaterThan(0.999);
        expect(pc).toBeLessThanOrEqual(1);
    });

    it('returns 0 for degenerate inputs', () => {
        expect(chanCollisionProbability(100, 0, 10)).toBe(0);
        expect(chanCollisionProbability(100, 100, 0)).toBe(0);
    });

    it('risk bands and formatting', () => {
        expect(classifyCollisionRisk(2e-3).label).toBe('CRITICAL');
        expect(classifyCollisionRisk(2e-4).label).toBe('HIGH');
        expect(classifyCollisionRisk(1e-9).label).toBe('NOMINAL');
        expect(formatPc(3.4e-4)).toBe('3.40e-4');
        expect(formatPc(0)).toBe('< 1e-12');
    });
});
