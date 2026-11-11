/**
 * VirtualSatellite — the full 1U CubeSat simulation, on one simulation clock.
 *
 * DOM-free (runs in Node for tests). The UI reads getFullState(); the
 * FlightController changes the spacecraft only through the actuator methods
 * (setAttitudeMode, applyThrust, setPowerMode, setPayloadState, resetObc).
 *
 * Each step() advances, in ≤1 s sub-steps:
 *   orbit (drag decay, J2 RAAN drift) → geometry (Sun, eclipse, ground track)
 *   → space weather → attitude slew → comms (ground-station passes, link budget)
 *   → payload ops → power (solar incidence, loads, battery) → thermal nodes
 *   → radiation & single-event upsets → conjunctions → flight controller → statuses
 */
import * as satjs from 'satellite.js';
import {
    dragDecayRate, dragAcceleration, j2RaanDrift, geodeticAltitude, maxDeltaV,
    meanMotion, orbitalVelocity, orbitalPeriod, semiMajorAxisChange, G0, RE,
    orbitalLifetimeDays,
} from './physics.js';
import {
    RE_KM, orbitStateECI, elementsFromRV, gmstRad, sunDirectionECI, solarFluxFactor,
    eclipseState, betaAngleDeg, subSatellitePoint, lookAngles, dipoleField, saaIntensity,
    dot, unit, scale, add, angleBetween, rotateToward, cross,
} from './sim/geometry.js';
import { stepThermal, thermalStatus, THERMAL_LIMITS } from './sim/thermal.js';
import { computeLoads, stepBattery, PANEL_PEAK_W } from './sim/power.js';
import { ConjunctionManager } from './sim/conjunctions.js';
import { SpaceWeather } from './sim/spaceWeather.js';
import { FlightController } from './autonomy/FlightController.js';
import { SOLAR_CONSTANT } from './physics.js';

/** Physical spacecraft parameters. A 1U CubeSat may weigh at most 2.0 kg (CubeSat Design Spec rev. 14). */
export const SPACECRAFT = {
    dryMassKg: 1.25,
    fuelCapacityG: 70,
    isp_s: 60,              // cold gas (butane/N₂ class)
    thrustN: 0.1,
    tankPressureFullMPa: 2.4,
    Cd: 2.2,
    dragAreaM2: 0.02,       // mean cross-section with panels deployed
    slewRateDegS: 1.5,
    hardBodyRadius_m: 10,
    reserveDeltaV: 3.0,     // m/s kept back for end-of-life / contingency
};

export const GROUND_STATIONS = [
    { id: 'KGL', name: 'Kigali (simulated)', lat: -1.9441, lon: 30.0619, altKm: 1.57 },
    { id: 'HBK', name: 'Hartebeesthoek', lat: -25.89, lon: 27.69, altKm: 1.4 },
];
const ELEVATION_MASK = 5;
const C_KMS = 299792.458;

/** Fallback reference orbit when CelesTrak is unreachable (ISS-like). */
export const DEFAULT_ELEMENTS = { altKm: 420.5, incl: 51.64, raan: 120, u: 0, source: 'SIMULATED' };

/**
 * Initial orbit from a TLE. A fresh TLE (epoch within 14 days) is propagated with SGP4
 * to the mission epoch; a stale one only donates its shape (altitude, inclination).
 */
export function initialElements(tle, epochMs) {
    if (!tle?.line1 || !tle?.line2) return { ...DEFAULT_ELEMENTS };
    const altKm = tle.altitude;
    const fresh = tle.epochMs && Math.abs(epochMs - tle.epochMs) < 14 * 86400000;
    if (fresh) {
        try {
            const rec = satjs.twoline2satrec(tle.line1, tle.line2);
            const pv = satjs.propagate(rec, new Date(epochMs));
            if (pv?.position && pv?.velocity) {
                const r = [pv.position.x, pv.position.y, pv.position.z];
                const v = [pv.velocity.x, pv.velocity.y, pv.velocity.z];
                const el = elementsFromRV(r, v);
                return { altKm, incl: el.incl, raan: el.raan, u: el.u, source: tle.source || 'LIVE' };
            }
        } catch { /* fall through to element-only init */ }
    }
    return { altKm, incl: tle.inclination, raan: tle.raan ?? 0, u: ((tle.argPerigee ?? 0) + (tle.meanAnomaly ?? 0)) % 360, source: `${tle.source || 'TLE'} (stale epoch)` };
}

const ATT_THRUST_ALIGN_DEG = 3;
const BACKSTOP_INTERVAL_S = 30; // simulated seconds between collision-backstop checks
const ADCS_FAULT_W = 6.5; // heat from a wheel driven against its brake (thermal runaway drill)

export class VirtualSatellite {
    /**
     * @param {object} [opts]
     * @param {number} [opts.epochMs]  wall-clock time the mission starts (Sun and Earth rotation are real)
     * @param {object} [opts.tle]      parsed TLE from data-service (optional)
     * @param {() => number} [opts.rng]
     * @param {number} [opts.conjunctionRatePerHour]
     */
    constructor({ epochMs = Date.now(), tle = null, rng = Math.random, conjunctionRatePerHour = 0.35 } = {}) {
        this.epochMs = epochMs;
        this.missionTime = 0;
        this.rng = rng;
        this._listeners = new Map();
        this.physics = { ...SPACECRAFT };

        const el = initialElements(tle, epochMs);
        this.orbit = {
            baseAltitude: el.altKm, inclination: el.incl, raan: el.raan, phase: el.u,
            eccentricity: 0, latitude: 0, longitude: 0, ascending: true,
            orbitNumber: 1, period: orbitalPeriod(el.altKm), source: el.source,
            timeToNextEclipse: 0, eclipseDurationMin: 0, sunlitFraction: 0.6,
            timeToNextContact: null, nextContact: null, groundTrack: [],
        };

        this.attitude = {
            mode: 'SUN_TRACKING', panelNormal: [1, 0, 0], thrustAxis: [0, 1, 0],
            pointingErrorDeg: 0, slewing: false, slewRateDegS: SPACECRAFT.slewRateDegS,
            burnDirRTN: [0, 1, 0], tumbleRateDegS: 0, tumbleAxis: [0, 0, 1],
            sunIncidenceDeg: 0,
        };
        this.propulsion = { isThrusting: false, remainingDeltaV: 0, reserveDeltaV: SPACECRAFT.reserveDeltaV, totalDeltaVUsed: 0 };
        this.powerMode = 'NOMINAL';
        this.obc = { down: false, downUntil: 0, cpuStuck: false };
        this.faults = { adcsRunaway: false }; // ADCS controller driving a wheel against its brake

        this.sections = {
            solarPanelA: { name: 'Solar Panel A (Port)', status: 'nominal', temperature: 20, deployed: true, efficiency: 1.0, angle: 0, powerOutput: 0 },
            solarPanelB: { name: 'Solar Panel B (Starboard)', status: 'nominal', temperature: 20, deployed: true, efficiency: 1.0, angle: 0, powerOutput: 0 },
            batteryBay: {
                name: 'Battery (2S Li-ion)', status: 'nominal', temperature: 18, charge: 73, voltage: 7.6,
                currentDraw: 0, cycleCount: 0, capacityWh: 60, healthPercent: 100,
                heaterOn: false, chargeInhibited: false, brownout: false,
            },
            thrusterPod: {
                name: 'Cold-Gas Thruster', status: 'nominal', temperature: 15, fuelMass: 60,
                fuelCapacity: SPACECRAFT.fuelCapacityG, fuelPercent: 0, pressure: 0, nozzleTemp: 15,
                lastFired: null, totalBurns: 0, isThrusting: false, thrustN: SPACECRAFT.thrustN,
            },
            commArray: {
                name: 'UHF Radio', status: 'nominal', temperature: 18, frequency: 435.0, txPower: 1.0,
                signalStrength: -150, linkStatus: 'LOST', dataRate: 0, lastContact: null,
                antennaOk: true, station: null, elevationDeg: -90, rangeKm: 0, signalLatency_ms: 0,
            },
            payloadBay: {
                name: 'Payload (Earth camera)', status: 'nominal', temperature: 18, state: 'ACTIVE',
                powerDraw: 1.5, imaging: false,
            },
            thermalRadiator: {
                name: 'Structure & Radiator', status: 'nominal', temperature: 15, emissivity: 0.8,
                heatRejection: 0, heatStrapOk: true,
            },
            onboardComputer: {
                name: 'Onboard Computer', status: 'nominal', temperature: 22, cpuLoad: 28, memoryUsed: 31,
                uptimeHours: 0, errorCount: 0, lastReboot: null, throttled: false,
            },
        };

        this.environment = {
            altitude: el.altKm, meanAltitude: el.altKm, velocity: orbitalVelocity(el.altKm),
            orbitalPeriod: orbitalPeriod(el.altKm), inclination: el.incl, eccentricity: 0,
            gravity: 0, atmosphericDrag: 0, density: 0, nearestBody: 'Earth', distanceToBody: el.altKm,
            inSunlight: true, eclipseProgress: 0, betaAngle: 0, sunAngle: 0,
            radiationLevel: 0.02, magneticField: 0, magneticDeclination: 0, magneticInclination: 0,
            solarFluxIndex: 150, geomagneticIndex: 3, decayRateKmPerDay: 0, lifetimeDays: null,
        };

        this.sensors = {
            radiationDetector: { name: 'Radiation Dosimeter', active: true, currentDose: 0.02, cumulativeDose: 0, alertThreshold: 1.0, saaPassingGrade: false, saaIntensity: 0 },
            magnetometer: { name: 'Magnetometer', active: true, fieldStrength: 0, fieldDirection: { x: 0, y: 0, z: 0 }, anomalyDetected: false, perturbation: 0 },
            conjunctions: [],
        };

        this.mission = {
            imagesCaptured: 0, dataBufferedMB: 0, dataDownlinkedMB: 0,
            conjunctionsPassed: 0, maneuvers: 0, collisions: 0,
            lost: false, lostReason: null,
        };

        this.spaceWeather = new SpaceWeather({ rng });
        this.conjunctions = new ConjunctionManager({ rng, ratePerHour: conjunctionRatePerHour, hardBodyRadius_m: SPACECRAFT.hardBodyRadius_m });
        this.history = [];
        this._lastHistory = -Infinity;
        this._lastImage = 0;
        this._lastContactCalc = -Infinity;
        this._lastEclipseCalc = -Infinity;
        this._seuAccumulator = 0;
        this._backstop = null;
        this._lastBackstop = -Infinity;

        this.flightController = new FlightController(this);

        this._updateGeometry();
        this.attitude.panelNormal = this._g.sun.slice();
        this.attitude.thrustAxis = unit(cross(this._g.sun, this._g.hHat));
        this._updatePropellantDerived();
        this._preSoakThermal();
        this._updateComms(0);
        this._updateSectionStatuses();
    }

    // ── events ───────────────────────────────────────────────────────────────
    on(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, new Set()); this._listeners.get(type).add(fn); return () => this.off(type, fn); }
    off(type, fn) { this._listeners.get(type)?.delete(fn); }
    emit(type, detail) { for (const fn of this._listeners.get(type) || []) { try { fn(detail); } catch (e) { console.error(`listener for ${type} failed`, e); } } }

    /**
     * Register the collision backstop: fn(sat) is called every BACKSTOP_INTERVAL_S of
     * simulated time, inside the physics step, whatever the planner or the time warp is doing.
     */
    setBackstop(fn) { this._backstop = typeof fn === 'function' ? fn : null; }

    get simTimeMs() { return this.epochMs + this.missionTime * 1000; }
    get wetMassKg() { return this.physics.dryMassKg + this.sections.thrusterPod.fuelMass / 1000; }
    get obcDown() { return this.obc.down; }

    // ── main loop ────────────────────────────────────────────────────────────
    /** Advance the simulation by dtS seconds of simulated time. */
    step(dtS) {
        if (this.mission.lost || !(dtS > 0)) return;
        const n = Math.ceil(dtS / 1.0);
        const h = dtS / n;
        for (let i = 0; i < n && !this.mission.lost; i++) this._substep(h);
    }

    _substep(dt) {
        this.missionTime += dt;
        const t = this.missionTime;

        this._propagateOrbit(dt);
        this._updateGeometry();

        for (const ev of this.spaceWeather.tick(t, dt)) {
            this.emit('space-weather', ev.type === 'SEP'
                ? { action: 'SEP_ARRIVAL', level: 'critical', reason: `${ev.label}: proton flux rising, dose rate +${ev.magnitude.toFixed(2)} mSv/h` }
                : { action: 'CME_IMPACT', level: 'critical', reason: `${ev.label}: geomagnetic storm, Kp ${ev.magnitude.toFixed(1)}. Thermosphere heating, drag rising.` });
        }

        this._updateAttitude(dt);
        this._updateComms(dt);
        this._updatePayload(dt);
        this._updatePowerAndThermal(dt);
        this._updateRadiation(dt);
        this._updateObc(dt);
        this._updateConjunctions(dt);
        // Collision backstop runs on the simulation clock, so its cadence is the same at 1× and 500×.
        if (this._backstop && !this.obc.down && t - this._lastBackstop >= BACKSTOP_INTERVAL_S) {
            this._lastBackstop = t;
            try { this._backstop(this); } catch (e) { console.error('collision backstop failed', e); }
        }
        this.flightController.tick(dt);
        this._updatePropellantDerived();
        this._updateSectionStatuses();

        if (t - this._lastHistory >= 60) {
            this._lastHistory = t;
            const worst = this.conjunctions.mostDangerous();
            this.history.push({
                t, soc: this.sections.batteryBay.charge, alt: this.orbit.baseAltitude,
                maxPc: worst ? worst.pc : 0, tBatt: this.sections.batteryBay.temperature,
                tObc: this.sections.onboardComputer.temperature, solarW: this._solarW || 0,
                loadW: this._loads?.total || 0, dose: this.environment.radiationLevel, kp: this.spaceWeather.kp,
            });
            if (this.history.length > 360) this.history.shift();
        }
    }

    // ── orbit ────────────────────────────────────────────────────────────────
    _propagateOrbit(dt) {
        const o = this.orbit;
        const n = meanMotion(o.baseAltitude);
        o.phase += (n * dt) * 180 / Math.PI;
        if (o.phase >= 360) { o.phase -= 360; o.orbitNumber += 1; }
        o.raan = (o.raan + j2RaanDrift(o.baseAltitude, o.inclination, 0) * dt / 86400 + 360) % 360;

        const v = orbitalVelocity(o.baseAltitude) * 1000;
        const kp = this.spaceWeather.kp, f107 = this.spaceWeather.f107;
        const geoAlt = this.environment.altitude || o.baseAltitude;
        const rate = dragDecayRate(geoAlt, v, this.physics.Cd, this.physics.dragAreaM2 / this.wetMassKg, kp, f107);
        o.baseAltitude += rate * dt;
        o.period = orbitalPeriod(o.baseAltitude);
        this.environment.decayRateKmPerDay = rate * 86400;
        if (o.baseAltitude < 150) this._loseMission('Re-entered the atmosphere: orbit decayed below 150 km.');
    }

    _updateGeometry() {
        const o = this.orbit;
        const aKm = RE_KM + o.baseAltitude;
        const st = orbitStateECI(aKm, o.inclination, o.raan, o.phase);
        const ms = this.simTimeMs;
        const gmst = gmstRad(ms);
        const sun = sunDirectionECI(ms);
        const ecl = eclipseState(st.r, sun);
        const ssp = subSatellitePoint(st.r, gmst);
        this._g = { ...st, sun, gmst, ecl, ssp, aKm, flux: SOLAR_CONSTANT * solarFluxFactor(ms) };

        o.latitude = ssp.lat;
        o.longitude = ssp.lon;
        o.ascending = st.vHat[2] > 0;

        const env = this.environment;
        env.meanAltitude = o.baseAltitude;
        env.altitude = geodeticAltitude(aKm, ssp.lat);
        env.distanceToBody = env.altitude;
        env.velocity = orbitalVelocity(o.baseAltitude);
        env.orbitalPeriod = o.period;
        env.inclination = o.inclination;
        env.gravity = 9.80665 * Math.pow(RE / (RE + o.baseAltitude * 1000), 2);
        env.inSunlight = !ecl.inShadow;
        env.eclipseProgress = ecl.depth;
        env.betaAngle = betaAngleDeg(st.hHat, sun);
        env.sunAngle = env.betaAngle;
        env.solarFluxIndex = Math.round(this.spaceWeather.f107);
        env.geomagneticIndex = +this.spaceWeather.kp.toFixed(1);
        const acc = dragAcceleration(env.altitude, env.velocity * 1000, this.physics.Cd, this.physics.dragAreaM2 / this.wetMassKg, this.spaceWeather.f107, this.spaceWeather.kp);
        env.atmosphericDrag = acc * this.wetMassKg; // N
        env.density = acc / (0.5 * (env.velocity * 1000) ** 2 * this.physics.Cd * this.physics.dragAreaM2 / this.wetMassKg);

        // Eclipse timing: scan one revolution ahead in 1° steps (cheap, refreshed every 30 s).
        if (this.missionTime - this._lastEclipseCalc >= 30) {
            this._lastEclipseCalc = this.missionTime;
            let toEclipse = null, toSun = null, dark = 0;
            for (let k = 1; k <= 360; k++) {
                const s2 = orbitStateECI(aKm, o.inclination, o.raan, o.phase + k);
                const shadow = eclipseState(s2.r, sun).inShadow;
                if (shadow) dark++;
                if (shadow && toEclipse === null && !ecl.inShadow) toEclipse = k;
                if (!shadow && toSun === null && ecl.inShadow) toSun = k;
            }
            const minPerDeg = o.period / 360;
            o.timeToNextEclipse = ecl.inShadow ? 0 : (toEclipse === null ? null : toEclipse * minPerDeg);
            o.timeToSunrise = ecl.inShadow && toSun !== null ? toSun * minPerDeg : 0;
            o.eclipseDurationMin = dark * minPerDeg;
            o.sunlitFraction = 1 - dark / 360;
        }
    }

    // ── attitude ─────────────────────────────────────────────────────────────
    /** Target unit vectors (ECI) for the panel normal and thruster axis in a mode. */
    _attitudeTargets(mode) {
        const g = this._g;
        const perp = (a, b) => { const p = add(a, scale(b, -dot(a, b))); return Math.hypot(...p) < 1e-6 ? null : unit(p); };
        switch (mode) {
            case 'SUN_TRACKING':
                return { panel: g.sun, thrust: perp(g.vHat, g.sun) || g.hHat };
            case 'EARTH_NADIR': // camera on the nadir face, panels on the zenith face
                return { panel: g.rHat, thrust: g.vHat };
            case 'VELOCITY_ALIGNED': // thruster along velocity, yaw-steered so panels see the Sun
                return { panel: perp(g.sun, g.vHat) || g.rHat, thrust: g.vHat };
            case 'MANEUVER_ALIGNMENT': {
                const d = this._burnDirEci();
                return { panel: perp(g.sun, d) || g.rHat, thrust: d };
            }
            case 'DEEP_SPACE': // sun-avoid: panels edge-on, radiator end toward the Sun
                return { panel: perp(g.hHat, g.sun) || g.rHat, thrust: scale(g.sun, -1) };
            default:
                return null;
        }
    }

    _burnDirEci() {
        const [t, r, n] = this.attitude.burnDirRTN; // stored as [prograde, radial, normal]
        const g = this._g;
        return unit(add(add(scale(g.vHat, t), scale(g.rHat, r)), scale(g.hHat, n)));
    }

    _updateAttitude(dt) {
        const a = this.attitude;
        if (a.mode === 'SAFE_TUMBLE_STOP') {
            // B-dot detumble: body rate decays with ~3 min time constant.
            a.tumbleRateDegS *= Math.exp(-dt / 180);
            const ang = a.tumbleRateDegS * dt * Math.PI / 180;
            a.panelNormal = rotateToward(a.panelNormal, cross(a.tumbleAxis, a.panelNormal), ang);
            a.pointingErrorDeg = a.tumbleRateDegS > 0.2 ? 90 : 0;
            a.slewing = a.tumbleRateDegS > 0.2;
        } else {
            const tgt = this._attitudeTargets(a.mode);
            const step = a.slewRateDegS * dt * Math.PI / 180;
            a.panelNormal = rotateToward(a.panelNormal, tgt.panel, step);
            a.thrustAxis = rotateToward(a.thrustAxis, tgt.thrust, step);
            const e1 = angleBetween(a.panelNormal, tgt.panel);
            const e2 = (a.mode === 'MANEUVER_ALIGNMENT' || a.mode === 'VELOCITY_ALIGNED') ? angleBetween(a.thrustAxis, tgt.thrust) : 0;
            a.pointingErrorDeg = Math.max(e1, e2) * 180 / Math.PI;
            a.slewing = a.pointingErrorDeg > 2;
        }
        const cosInc = dot(a.panelNormal, this._g.sun);
        a.sunIncidenceDeg = Math.acos(Math.max(-1, Math.min(1, cosInc))) * 180 / Math.PI;
        this.sections.solarPanelA.angle = Math.round(a.sunIncidenceDeg);
        this.sections.solarPanelB.angle = Math.round(a.sunIncidenceDeg);
    }

    // ── comms ────────────────────────────────────────────────────────────────
    _updateComms(dt) {
        const c = this.sections.commArray;
        let best = null;
        for (const gs of GROUND_STATIONS) {
            const la = lookAngles(gs, this._g.r, this._g.gmst);
            if (!best || la.elevation > best.elevation) best = { ...la, gs };
        }
        c.elevationDeg = best.elevation;
        c.rangeKm = best.range;
        const visible = best.elevation >= ELEVATION_MASK;
        c.station = visible ? best.gs.name : null;
        const prof = this.powerMode === 'SURVIVAL' ? 0.5 : this.powerMode === 'NOMINAL' ? 1.0 : 0.5;
        c.txPower = prof;
        if (visible && c.antennaOk && !this.obc.down) {
            // Link budget: P_rx = P_tx + G_tx + G_rx − FSPL − losses (dBm)
            const fspl = 20 * Math.log10(best.range) + 20 * Math.log10(c.frequency) + 32.44;
            const pr = 10 * Math.log10(prof * 1000) + 0 + 14 - fspl - 3;
            c.signalStrength = pr;
            c.linkStatus = best.elevation >= 20 ? 'STRONG' : 'WEAK';
            c.dataRate = this.powerMode === 'SURVIVAL' ? 1200 : (pr >= -110 ? 9600 : 1200);
            c.lastContact = this.missionTime;
            c.signalLatency_ms = best.range / C_KMS * 1000 + 5;
            this.mission.dataDownlinkedMB += Math.min(this.mission.dataBufferedMB, c.dataRate / 8 / 1e6 * dt);
            this.mission.dataBufferedMB = Math.max(0, this.mission.dataBufferedMB - c.dataRate / 8 / 1e6 * dt);
        } else {
            c.signalStrength = -150;
            c.linkStatus = 'LOST';
            c.dataRate = 0;
            c.signalLatency_ms = 0;
        }

        // Next-pass prediction, cached until that pass ends.
        const nc = this.orbit.nextContact;
        const stale = !nc || (this.missionTime > nc.endS) || this.missionTime - this._lastContactCalc > 1800;
        if (stale && this.missionTime - this._lastContactCalc > 60) {
            this._lastContactCalc = this.missionTime;
            this.orbit.nextContact = this._predictContact();
        }
        const p = this.orbit.nextContact;
        this.orbit.timeToNextContact = !p ? null : visible ? 0 : Math.max(0, (p.startS - this.missionTime) / 60);
    }

    _predictContact(horizonS = 24 * 3600, stepS = 30) {
        const o = this.orbit;
        const n = meanMotion(o.baseAltitude) * 180 / Math.PI;
        const raanRate = j2RaanDrift(o.baseAltitude, o.inclination, 0) / 86400;
        let start = null, gsName = null, maxEl = -90;
        for (let dt = 0; dt <= horizonS; dt += stepS) {
            const st = orbitStateECI(RE_KM + o.baseAltitude, o.inclination, o.raan + raanRate * dt, o.phase + n * dt);
            const gmst = gmstRad(this.simTimeMs + dt * 1000);
            let el = -90, name = null;
            for (const gs of GROUND_STATIONS) {
                const e = lookAngles(gs, st.r, gmst).elevation;
                if (e > el) { el = e; name = gs.name; }
            }
            if (el >= ELEVATION_MASK) {
                if (start === null) { start = dt; gsName = name; }
                maxEl = Math.max(maxEl, el);
            } else if (start !== null) {
                return { station: gsName, startS: this.missionTime + start, endS: this.missionTime + dt, durationMin: (dt - start) / 60, maxElevation: maxEl };
            }
        }
        return start !== null ? { station: gsName, startS: this.missionTime + start, endS: this.missionTime + horizonS, durationMin: (horizonS - start) / 60, maxElevation: maxEl } : null;
    }

    // ── payload ──────────────────────────────────────────────────────────────
    _updatePayload(dt) {
        const p = this.sections.payloadBay;
        const dayside = dot(this._g.rHat, this._g.sun) > 0.15;
        p.imaging = p.state === 'ACTIVE' && this.attitude.mode === 'EARTH_NADIR'
            && this.attitude.pointingErrorDeg < 5 && dayside && !this.obc.down;
        if (p.imaging && this.missionTime - this._lastImage >= 30 && this.mission.dataBufferedMB < 64) {
            this._lastImage = this.missionTime;
            this.mission.imagesCaptured += 1;
            this.mission.dataBufferedMB += 0.05; // 50 kB thumbnail
        }
    }

    // ── power + thermal ──────────────────────────────────────────────────────
    _updatePowerAndThermal(dt) {
        const s = this.sections;
        const bat = s.batteryBay;
        const g = this._g;
        const inSun = this.environment.inSunlight;
        const cosInc = dot(this.attitude.panelNormal, g.sun);
        const tumbling = this.attitude.mode === 'SAFE_TUMBLE_STOP' && this.attitude.tumbleRateDegS > 0.2;
        const effCos = tumbling ? 0.25 : Math.max(0, cosInc);
        const fluxRatio = g.flux / SOLAR_CONSTANT;

        let solar = 0;
        const panelState = {};
        for (const id of ['A', 'B']) {
            const sec = s[`solarPanel${id}`];
            const tempDerate = 1 - 0.0045 * (sec.temperature - 28); // triple-junction cells lose ~0.45 %/°C
            const out = inSun && sec.deployed ? PANEL_PEAK_W * sec.efficiency * effCos * fluxRatio * Math.max(0.6, Math.min(1.15, tempDerate)) : 0;
            sec.powerOutput = out;
            solar += out;
            panelState[id] = { cos: tumbling ? 0.25 : cosInc, electricW: out, deployed: sec.deployed };
        }
        this._solarW = solar;

        // Battery heater thermostat (on < 2 °C, off > 6 °C)
        if (bat.temperature < 2) bat.heaterOn = true;
        else if (bat.temperature > 6) bat.heaterOn = false;

        const loads = computeLoads({
            extraW: this.faults.adcsRunaway ? ADCS_FAULT_W : 0,
            powerMode: this.powerMode, payloadState: s.payloadBay.state, cpuLoad: s.onboardComputer.cpuLoad,
            slewing: this.attitude.slewing, inContact: s.commArray.linkStatus !== 'LOST',
            antennaOk: s.commArray.antennaOk, heaterOn: bat.heaterOn, obcDown: this.obc.down,
            thrusting: this.propulsion.isThrusting,
        });
        this._loads = loads;
        s.payloadBay.powerDraw = loads.payload;
        const shunt = stepBattery(bat, solar, loads.total, dt, bat.temperature);
        this._shuntW = shunt;
        if (bat.brownout && !this.obc.down) {
            this._rebootObc(60, 'Brownout: battery exhausted, OBC lost power');
            this.setPayloadState('OFF');
            this.setPowerMode('SURVIVAL');
        }

        const T = {};
        for (const [k, v] of Object.entries(s)) T[k] = v.temperature;
        const res = stepThermal(T, dt, {
            inSun, flux: g.flux, attitudeMode: this.attitude.mode,
            earthView: Math.pow(RE_KM / g.aKm, 2),
            albedoCos: Math.max(0, dot(g.rHat, g.sun)),
            panels: panelState,
            heatStrapOk: s.thermalRadiator.heatStrapOk,
            dissipation: {
                onboardComputer: loads.obc + (this.faults.adcsRunaway ? ADCS_FAULT_W : 0),
                batteryBay: loads.eps + loads.heater + (bat.i2rW || 0) + solar * 0.05,
                commArray: loads.radioRx + loads.radioTx - loads.txRfW,
                payloadBay: loads.payload,
                thermalRadiator: loads.adcs + shunt,
                thrusterPod: loads.propulsion,
            },
        });
        for (const [k, v] of Object.entries(T)) s[k].temperature = v;
        s.thermalRadiator.heatRejection = res.radiatedW;
    }

    // ── radiation, magnetometer, SEUs ────────────────────────────────────────
    _updateRadiation(dt) {
        const { lat, lon } = this._g.ssp;
        const saa = saaIntensity(lat, lon);
        const base = 0.02 * (1 + (this.orbit.baseAltitude - 400) / 1500);
        const dose = base + 0.28 * saa + this.spaceWeather.sepBoost;
        const rd = this.sensors.radiationDetector;
        rd.currentDose = dose;
        rd.saaIntensity = saa;
        rd.saaPassingGrade = saa > 0.15;
        rd.cumulativeDose += dose * dt / 3600;
        this.environment.radiationLevel = dose;

        const B = dipoleField(lat, lon, this._g.aKm);
        const kp = this.spaceWeather.kp;
        const pert = kp > 4 ? (kp - 4) * 90 * Math.sin(this.missionTime / 420) : 0;
        const mag = this.sensors.magnetometer;
        mag.fieldStrength = B.total + pert;
        mag.fieldDirection = { x: B.north / B.total, y: B.east / B.total, z: B.down / B.total };
        mag.components = { north: B.north, east: B.east, down: B.down };
        mag.perturbation = pert;
        mag.anomalyDetected = Math.abs(pert) > 150;
        this.environment.magneticField = mag.fieldStrength;
        this.environment.magneticDeclination = +B.declination.toFixed(1);
        this.environment.magneticInclination = +B.inclination.toFixed(1);

        // Single-event upsets: corrected by EDAC and counted; ~1 % are uncorrectable and reset the OBC.
        if (!this.obc.down) {
            const rate = 0.4 * (dose / 0.02); // upsets per hour
            this._seuAccumulator += rate * dt / 3600;
            while (this._seuAccumulator >= 1) {
                this._seuAccumulator -= 1;
                if (this.rng() < 0.01) this._rebootObc(25, 'Uncorrectable single-event upset (radiation) - watchdog reset');
                else this.sections.onboardComputer.errorCount += 1;
            }
        }
    }

    // ── onboard computer ─────────────────────────────────────────────────────
    _updateObc(dt) {
        const o = this.sections.onboardComputer;
        if (this.obc.down) {
            o.cpuLoad = 0;
            if (this.missionTime >= this.obc.downUntil) {
                this.obc.down = false;
                o.lastReboot = this.missionTime;
                o.uptimeHours = 0;
                this.emit('obc', { action: 'OBC_ONLINE', level: 'nominal', reason: 'Onboard computer rebooted and running' });
            }
            return;
        }
        o.uptimeHours += dt / 3600;
        const target = this.obc.cpuStuck ? 100
            : 22 + (this.sections.payloadBay.imaging ? 18 : 0) + (this.flightController.current ? 10 : 0);
        o.throttled = this.flightController.supervisor.thermal;
        const cap = o.throttled ? 40 : 100;
        o.cpuLoad = Math.min(cap, o.cpuLoad + (target - o.cpuLoad) * Math.min(1, dt / 20));
        o.memoryUsed = Math.min(95, 30 + o.errorCount * 0.2 + (this.mission.dataBufferedMB / 64) * 40);
    }

    _rebootObc(seconds, reason) {
        this.obc.down = true;
        this.obc.downUntil = this.missionTime + seconds;
        this.obc.cpuStuck = false;
        this.faults.adcsRunaway = false;
        this.sections.onboardComputer.errorCount = 0;
        this.flightController.abortCurrent('OBC reset');
        this.emit('obc', { action: 'OBC_RESET', level: 'warning', reason });
    }

    // ── conjunctions ─────────────────────────────────────────────────────────
    _updateConjunctions(dt) {
        const out = this.conjunctions.tick(this.missionTime, dt, this.environment.velocity * 1000);
        for (const ev of out.spawned) this.emit('conjunction', { type: 'new', event: ev });
        for (const ev of out.escalated) this.emit('conjunction', { type: 'escalated', event: ev });
        for (const ev of out.passed) {
            this.mission.conjunctionsPassed += 1;
            this.emit('conjunction', { type: 'passed', event: ev });
            if (ev.collision) {
                this.mission.collisions += 1;
                this._loseMission(`Collision with ${ev.id}: realised miss ${ev.realizedMiss_m.toFixed(1)} m (Pc was ${ev.pcFormatted}).`);
            }
        }
        this.sensors.conjunctions = this.conjunctions.events;
    }

    _loseMission(reason) {
        if (this.mission.lost) return;
        this.mission.lost = true;
        this.mission.lostReason = reason;
        this.emit('mission-lost', { reason });
    }

    // ── actuators (called by FlightController and the supervisor) ────────────
    setAttitudeMode(mode) {
        const a = this.attitude;
        if (a.mode === mode) return;
        a.mode = mode;
        if (mode === 'SAFE_TUMBLE_STOP') {
            a.tumbleRateDegS = Math.max(a.tumbleRateDegS, 3);
            a.tumbleAxis = unit([this.rng() - 0.5, this.rng() - 0.5, this.rng() - 0.5]);
        }
    }

    setBurnDirection(vecTRN) { this.attitude.burnDirRTN = vecTRN.slice(); }

    setPowerMode(mode) { this.powerMode = mode; }

    setPayloadState(state) {
        this.sections.payloadBay.state = state;
    }

    resetObc() { this._rebootObc(20, 'Commanded OBC reset (clears upsets and stuck processes, restarts radio firmware)'); this.sections.commArray.antennaOk = true; }

    /** Is the thruster aligned with the commanded burn direction? */
    thrusterAligned() {
        return this.attitude.mode === 'MANEUVER_ALIGNMENT' && this.attitude.pointingErrorDeg < ATT_THRUST_ALIGN_DEG;
    }

    /**
     * Fire the thruster for up to dt seconds along vecTRN = [prograde, radial, normal].
     * Consumes propellant at ṁ = F/(Isp·g₀); applies Δa to the orbit and shifts every
     * upcoming conjunction. Returns the Δv actually delivered (m/s).
     */
    applyThrust(vecTRN, dt, maxDv = Infinity) {
        const tp = this.sections.thrusterPod;
        const m = this.wetMassKg;
        const ve = this.physics.isp_s * G0;
        const mdot = this.physics.thrustN / ve; // kg/s
        const fuelKg = tp.fuelMass / 1000;
        if (fuelKg <= 0 || !(maxDv > 0)) { tp.isThrusting = false; this.propulsion.isThrusting = false; return 0; }
        // Time to deliver exactly maxDv from the rocket equation: t = (m/ṁ)(1 − e^(−Δv/ve))
        const tForDv = Number.isFinite(maxDv) ? (m / mdot) * (1 - Math.exp(-maxDv / ve)) : Infinity;
        let burnT = Math.min(dt, tForDv, fuelKg / mdot);
        const used = mdot * burnT;
        // exact rocket-equation Δv for this slice
        const dv = this.physics.isp_s * G0 * Math.log(m / (m - used));
        tp.fuelMass = Math.max(0, tp.fuelMass - used * 1000);
        tp.isThrusting = true;
        this.propulsion.isThrusting = true;
        tp.lastFired = this.missionTime;
        tp.nozzleTemp = Math.max(-40, tp.nozzleTemp - 6 * burnT); // expanding cold gas chills the nozzle

        const [dT, dR, dN] = vecTRN.map(x => x * dv);
        this.orbit.baseAltitude += semiMajorAxisChange(dT, this.orbit.baseAltitude);
        this.conjunctions.applyImpulse(dR, dT, dN, this.missionTime, meanMotion(this.orbit.baseAltitude));
        this.propulsion.totalDeltaVUsed += dv;
        this._updatePropellantDerived();
        return dv;
    }

    endBurn() {
        const tp = this.sections.thrusterPod;
        if (tp.isThrusting) { tp.totalBurns += 1; this.mission.maneuvers += 1; }
        tp.isThrusting = false;
        this.propulsion.isThrusting = false;
    }

    _updatePropellantDerived() {
        const tp = this.sections.thrusterPod;
        tp.fuelPercent = (tp.fuelMass / tp.fuelCapacity) * 100;
        tp.pressure = SPACECRAFT.tankPressureFullMPa * (tp.fuelMass / tp.fuelCapacity) * ((tp.temperature + 273.15) / 293.15);
        if (!tp.isThrusting) tp.nozzleTemp += (tp.temperature - tp.nozzleTemp) * 0.02;
        this.propulsion.remainingDeltaV = maxDeltaV(tp.fuelMass / 1000, this.physics.dryMassKg, this.physics.isp_s);
    }

    // ── statuses and score ───────────────────────────────────────────────────
    _updateSectionStatuses() {
        const s = this.sections;
        const rank = { nominal: 0, warning: 1, critical: 2 };
        const worse = (a, b) => (rank[b] > rank[a] ? b : a);
        for (const [key, sec] of Object.entries(s)) sec.status = thermalStatus(key, sec.temperature);

        const bat = s.batteryBay;
        bat.status = worse(bat.status, bat.charge < 15 || bat.brownout ? 'critical' : bat.charge < 30 || bat.chargeInhibited ? 'warning' : 'nominal');
        for (const id of ['A', 'B']) {
            const p = s[`solarPanel${id}`];
            p.status = worse(p.status, !p.deployed || p.efficiency < 0.5 ? 'critical' : p.efficiency < 0.85 ? 'warning' : 'nominal');
        }
        const tp = s.thrusterPod;
        tp.status = worse(tp.status, tp.fuelMass <= 0.5 ? 'critical' : tp.fuelPercent < 15 || this.propulsion.remainingDeltaV < this.propulsion.reserveDeltaV ? 'warning' : 'nominal');
        s.commArray.status = worse(s.commArray.status, s.commArray.antennaOk ? 'nominal' : 'critical');
        const o = s.onboardComputer;
        o.status = worse(o.status, this.obc.down ? 'critical' : o.errorCount > 50 || this.obc.cpuStuck || this.faults.adcsRunaway ? 'critical' : o.errorCount > 10 ? 'warning' : 'nominal');
        s.thermalRadiator.status = worse(s.thermalRadiator.status, s.thermalRadiator.heatStrapOk ? 'nominal' : 'critical');
    }

    _calculateSurvivalScore() {
        let score = 100;
        for (const sec of Object.values(this.sections)) {
            if (sec.status === 'critical') score -= 15;
            else if (sec.status === 'warning') score -= 5;
        }
        const worst = this.conjunctions.mostDangerous();
        if (worst?.pc >= 1e-4) score -= 25; else if (worst?.pc >= 1e-5) score -= 10;
        if (this.environment.radiationLevel > 0.5) score -= 10;
        if (this.orbit.baseAltitude < 250) score -= 20;
        if (this.mission.lost) return 0;
        return Math.max(0, Math.min(100, Math.round(score)));
    }

    // ── thermal pre-soak so the mission starts near orbital equilibrium ─────
    _preSoakThermal() {
        const saved = { t: this.missionTime, phase: this.orbit.phase, raan: this.orbit.raan, soc: this.sections.batteryBay.charge, hist: this._lastHistory };
        const panel = this.attitude.panelNormal;
        for (let i = 0; i < 6 * 5600 / 10; i++) {
            this.orbit.phase = (this.orbit.phase + meanMotion(this.orbit.baseAltitude) * 10 * 180 / Math.PI) % 360;
            this._updateGeometry();
            this.attitude.panelNormal = this._g.sun;
            this._updatePowerAndThermal(10);
            this.sections.batteryBay.charge = saved.soc;
        }
        Object.assign(this.orbit, { phase: saved.phase, raan: saved.raan });
        this.attitude.panelNormal = panel;
        this.missionTime = saved.t;
        this._lastEclipseCalc = -Infinity;
        this._updateGeometry();
    }

    /**
     * Solver's avoidance option for the planner prompt: the smallest burn that clears every
     * upcoming event, or null when nothing is above the watch level. Cached for 30 s of sim time.
     */
    avoidanceOption() {
        const now = this.missionTime;
        if (this._avoid && now - this._avoid.at < 30) return this._avoid.value;
        const worst = this.conjunctions.mostDangerous();
        let value = null;
        if (worst && worst.pc >= 1e-5) {
            const usable = Math.max(0, this.propulsion.remainingDeltaV - this.propulsion.reserveDeltaV);
            const sol = this.conjunctions.solveAvoidance(now, meanMotion(this.orbit.baseAltitude), { maxDv: Math.min(1.0, usable) });
            value = sol
                ? { vector: [sol.vectorRTN[1], sol.vectorRTN[0], sol.vectorRTN[2]], deltaV: sol.deltaV, worstPcAfter: sol.worstPc }
                : { none: true, usableDv: usable };
        }
        this._avoid = { at: now, value };
        return value;
    }

    // ── snapshot for UI and planners ─────────────────────────────────────────
    getFullState() {
        const tp = this.sections.thrusterPod;
        const fuelKg = tp.fuelMass / 1000;
        const env = this.environment;
        if (env.lifetimeDays === null || this.missionTime - (this._lastLifetime || -1e9) > 600) {
            this._lastLifetime = this.missionTime;
            env.lifetimeDays = orbitalLifetimeDays(this.orbit.baseAltitude, this.physics.Cd, this.physics.dragAreaM2 / this.wetMassKg, this.spaceWeather.kp, this.spaceWeather.f107);
        }
        return {
            missionTime: this.missionTime,
            simTimeMs: this.simTimeMs,
            sections: this.sections,
            environment: env,
            sensors: this.sensors,
            orbit: { ...this.orbit, raanDriftDegPerDay: j2RaanDrift(this.orbit.baseAltitude, this.orbit.inclination, 0) },
            attitude: this.attitude,
            powerMode: this.powerMode,
            power: { solarW: this._solarW || 0, loads: this._loads || null, shuntW: this._shuntW || 0 },
            physics: {
                fuelMassKg: +fuelKg.toFixed(4),
                dryMassKg: this.physics.dryMassKg,
                wetMassKg: +this.wetMassKg.toFixed(4),
                maxDeltaV_ms: +this.propulsion.remainingDeltaV.toFixed(2),
                reserveDeltaV_ms: this.propulsion.reserveDeltaV,
                isp_s: this.physics.isp_s,
                thrustN: this.physics.thrustN,
                areaToMass: +(this.physics.dragAreaM2 / this.wetMassKg).toFixed(4),
                posUncertainty_m: null,
                collisionRadius_m: this.physics.hardBodyRadius_m,
            },
            spaceWeather: {
                kp: this.spaceWeather.kp, f107: this.spaceWeather.f107, sepBoost: this.spaceWeather.sepBoost,
                pending: this.spaceWeather.pending.map(p => ({ ...p, inS: p.at - this.missionTime })),
                source: this.spaceWeather.source, lastFlare: this.spaceWeather.lastFlare,
            },
            conjunctions: this.conjunctions.events,
            conjunctionHistory: this.conjunctions.history,
            mission: this.mission,
            obc: this.obc,
            flight: this.flightController.status(),
            history: this.history,
            survivalScore: this._calculateSurvivalScore(),
            geometry: { rHat: this._g.rHat, vHat: this._g.vHat, hHat: this._g.hHat, sun: this._g.sun, gmst: this._g.gmst, aKm: this._g.aKm },
        };
    }

    // ── crisis drills (Crisis view) ──────────────────────────────────────────
    /** Inject a scenario. Returns a log entry describing it. */
    injectEvent(id) {
        const s = this.sections, t = this.missionTime, r = this.rng;
        switch (id) {
            case 'solar_flare':
                this.spaceWeather.queue('SEP', t + 20 * 60, 1.6 + r() * 0.8, 'X2.4 flare protons (drill)');
                this.spaceWeather.queue('CME', t + 6 * 3600, 7.3, 'X2.4 flare CME (drill)');
                this.spaceWeather.lastFlare = { classType: 'X2.4', beginTime: new Date(this.simTimeMs).toISOString() };
                return { action: 'EVENT', level: 'warning', reason: 'X2.4 solar flare observed. Energetic protons expected in ~20 min, CME storm in ~6 h.' };
            case 'cme_incoming': {
                const inMin = 30 + Math.round(r() * 30);
                this.spaceWeather.queue('CME', t + inMin * 60, 7.7, 'Halo CME (drill)');
                this.spaceWeather.queue('SEP', t + inMin * 60, 0.5, 'CME shock protons (drill)');
                return { action: 'CME_ALERT', level: 'warning', reason: `Halo CME detected. Shock arrival in ~${inMin} min: storm Kp≈7.7, raised radiation and drag.` };
            }
            case 'debris_close': {
                const ev = this.conjunctions.spawn(t, {
                    leadS: (50 + r() * 20) * 60, missM: 40 + r() * 70, crossingDeg: 30 + r() * 120,
                    orbitalSpeedMs: this.environment.velocity * 1000,
                });
                this.emit('conjunction', { type: 'new', event: ev });
                return { action: 'EVENT', level: 'critical', reason: `Conjunction alert: ${ev.id}, TCA in ${(ev.timeToTca_s / 60).toFixed(0)} min, predicted miss ${ev.missDistance_m.toFixed(0)} m, Pc ${ev.pcFormatted}.` };
            }
            case 'battery_drain':
                s.batteryBay.charge = 13 + r() * 3;
                s.batteryBay.healthPercent = Math.max(60, s.batteryBay.healthPercent - 15);
                return { action: 'EVENT', level: 'critical', reason: `Battery cell fault: charge ${s.batteryBay.charge.toFixed(0)}%, capacity reduced to ${s.batteryBay.healthPercent.toFixed(0)}%.` };
            case 'thermal_runaway':
                s.thermalRadiator.heatStrapOk = false;
                this.obc.cpuStuck = true;
                this.faults.adcsRunaway = true;
                s.onboardComputer.temperature += 20;
                return { action: 'EVENT', level: 'critical', reason: 'ADCS controller fault: a reaction wheel is being driven against its brake (+6.5 W of heat on the OBC/ADCS stack) and the electronics heat strap has failed. An OBC reset restarts the ADCS controller.' };
            case 'solar_panel_a_fail':
                s.solarPanelA.efficiency = 0.15;
                return { action: 'EVENT', level: 'warning', reason: 'Micrometeoroid strike on Solar Panel A: output down to 15%.' };
            case 'comm_blackout':
                s.commArray.antennaOk = false;
                return { action: 'EVENT', level: 'warning', reason: 'UHF transceiver firmware lock-up: no transmissions. An OBC reset restarts the radio.' };
            case 'orbital_decay':
                this.spaceWeather.stormKp = 8.3;
                return { action: 'EVENT', level: 'warning', reason: 'Severe geomagnetic storm (Kp 8.3): thermosphere expanding, drag and decay rate rising.' };
            case 'all_clear':
                s.thermalRadiator.heatStrapOk = true;
                s.commArray.antennaOk = true;
                s.solarPanelA.efficiency = 1.0;
                s.solarPanelB.efficiency = 1.0;
                this.obc.cpuStuck = false;
                this.faults.adcsRunaway = false;
                this.spaceWeather.pending = [];
                this.spaceWeather.sepBoost = 0;
                this.spaceWeather.stormKp = 0;
                this.conjunctions.events = [];
                s.batteryBay.charge = Math.max(s.batteryBay.charge, 60);
                s.batteryBay.healthPercent = 100;
                return { action: 'EVENT', level: 'nominal', reason: 'Drill reset: injected faults cleared, space weather calm, screening list cleared.' };
            default:
                return null;
        }
    }

    /** Recompute the orbit after a live TLE arrives during the first minute of the mission. */
    adoptTle(tle) {
        if (this.missionTime > 60 || this.propulsion.totalDeltaVUsed > 0) return false;
        const el = initialElements(tle, this.simTimeMs);
        Object.assign(this.orbit, { baseAltitude: el.altKm, inclination: el.incl, raan: el.raan, phase: el.u, source: el.source });
        this._lastEclipseCalc = -Infinity;
        this._lastContactCalc = -Infinity;
        this.orbit.nextContact = null;
        this._updateGeometry();
        return true;
    }
}

export { THERMAL_LIMITS };
