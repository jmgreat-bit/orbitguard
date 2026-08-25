// Complete satellite simulation with ALL subsystems
// Physics engine ported from Detour (TreeHacks 2026) — real orbital mechanics

import { DataService } from './data-service.js';
import {
    dragDecayRate,
    j2AltitudeCorrection,
    j2RaanDrift,
    tsiolkovskyFuel,
    maxDeltaV,
    chanCollisionProbability,
    classifyCollisionRisk,
    formatPc,
    orbitalVelocity,
    orbitalPeriod
} from './physics.js';
import { FlightController } from './autonomy/FlightController.js';

export class VirtualSatellite {
    constructor() {
        this.dataService = new DataService();
        this.lastRealDataSync = 0;

        this.lastUpdate = Date.now();
        this.missionTime = 0; // seconds since launch

        // ============ PHYSICS CONSTANTS (from Detour) ============
        this.physics = {
            dryMassKg: 3.0,     // kg  — cubesat dry mass (no fuel)
            isp_s: 60,      // s   — cold-gas thruster specific impulse
            Cd: 2.2,     // —   — drag coefficient
            Am: 0.025,   // m²/kg area-to-mass ratio
            collisionRadius_m: 10, // m — combined hard-body radius for Pc
            posUncertainty_m: 500, // m — 1-sigma position uncertainty
        };
        // Wet mass = dry + fuel (fuelMass in grams → kg)
        this._fuelMassKg = () => this.sections.thrusterPod.fuelMass / 1000;
        this._wetMassKg = () => this.physics.dryMassKg + this._fuelMassKg();

        // J2 drift accumulator
        this._raanDriftDeg = 0;

        // AI state (written by main.js after each AI decision)
        this._lastThreat = 'nominal';
        this._lastForecast = '';

        // Flight Actuators (For AI Control)
        this.attitude = {
            currentAngle: 0,
            targetAngle: 0,
            slewRate: 2.0 // deg/sec
        };

        this.propulsion = {
            isThrusting: false,
            remainingDeltaV: 154.2 // m/s budget
        };

        // Initialize Flight Controller
        this.flightController = new FlightController(this);

        // ============ SHIP SECTIONS ============
        // Each section has: status ('nominal'|'warning'|'critical'), temp, and specific data
        this.sections = {
            solarPanelA: {
                name: 'Solar Panel A (Port)',
                status: 'nominal',
                temperature: 35,
                deployed: true,
                efficiency: 0.92,   // 0-1, degrades with damage
                angle: 0,           // degrees from sun-optimal
                powerOutput: 5.0    // Watts (half of 10W total)
            },
            solarPanelB: {
                name: 'Solar Panel B (Starboard)',
                status: 'nominal',
                temperature: 35,
                deployed: true,
                efficiency: 0.94,
                angle: 0,
                powerOutput: 5.0
            },
            batteryBay: {
                name: 'Battery Bay',
                status: 'nominal',
                temperature: 25,
                charge: 73,          // percent
                voltage: 7.4,        // Volts
                currentDraw: 0.68,   // Amps
                cycleCount: 342,     // charge/discharge cycles
                capacityWh: 60,
                healthPercent: 96    // battery degradation
            },
            thrusterPod: {
                name: 'Thruster Pod',
                status: 'nominal',
                temperature: 18,
                fuelMass: 230,       // grams remaining (of 250)
                fuelPercent: 92,
                pressure: 2.1,       // MPa (tank pressure)
                nozzleTemp: 18,
                lastFired: null,
                totalBurns: 3
            },
            commArray: {
                name: 'Communication Array',
                status: 'nominal',
                temperature: 28,
                frequency: 435.0,    // MHz
                txPower: 1.0,        // Watts
                signalStrength: 35,  // dBm (higher = better)
                linkStatus: 'WEAK',  // STRONG, WEAK, LOST
                dataRate: 4800,      // bps
                lastContact: Date.now(),
                antennaAngle: 0
            },
            payloadBay: {
                name: 'Payload Bay (Sensors)',
                status: 'nominal',
                temperature: 22,
                lidarActive: true,
                cameraActive: false,
                magnetometerActive: true,
                radiationSensor: true,
                powerDraw: 1.2       // Watts
            },
            thermalRadiator: {
                name: 'Thermal Radiator',
                status: 'nominal',
                temperature: 40,
                emissivity: 0.85,    // 0-1
                heatRejection: 8.5,  // Watts being radiated away
                fluidTemp: 35,       // coolant fluid temp
                pumpActive: true
            },
            onboardComputer: {
                name: 'Onboard Computer',
                status: 'nominal',
                temperature: 45,
                cpuLoad: 34,         // percent
                memoryUsed: 28,      // percent
                uptimeHours: 2847,
                errorCount: 0,
                lastReboot: null
            }
        };

        // ============ ENVIRONMENT ============
        this.environment = {
            altitude: 420,          // km above Earth surface
            velocity: 7.66,         // km/s orbital velocity
            orbitalPeriod: 92.7,    // minutes per orbit
            inclination: 51.6,      // degrees (ISS-like orbit)
            eccentricity: 0.0001,   // nearly circular

            gravity: 8.66,          // m/s² (weaker than 9.81 at surface)
            atmosphericDrag: 0.00001, // N (tiny at 420km)

            nearestBody: 'Earth',
            distanceToBody: 420,    // km

            inSunlight: true,
            sunAngle: 45,           // degrees
            eclipseProgress: 0,     // 0=full sun, 1=full shadow

            radiationLevel: 0.15,   // mSv/hr (normal LEO)
            magneticField: 35000,   // nT (nanotesla)
            magneticDeclination: 12, // degrees

            solarFluxIndex: 120,    // SFU (solar radio flux)
            geomagneticIndex: 3     // Kp index 0-9
        };

        // ============ SENSORS (what LIDAR/instruments actually see) ============
        this.sensors = {
            lidar: {
                name: 'LIDAR Ranging System',
                active: true,
                scanRate: 10,         // Hz
                maxRange: 200,        // km
                nearestObject: {
                    id: 'COSMOS-1408-DEB',
                    distance: 145.2,    // km
                    closingSpeed: 0.02, // km/s (relative velocity)
                    bearing: 42,        // degrees
                    size: 0.1,          // meters estimated
                    threatLevel: 'low'
                },
                trackedObjects: [
                    { id: 'COSMOS-1408-DEB', distance: 145.2, bearing: 42, elevation: 15, size: 0.1 },
                    { id: 'CZ-6C-DEB-22', distance: 89.3, bearing: 210, elevation: -5, size: 0.05 },
                    { id: 'SL-8-RB', distance: 178.0, bearing: 315, elevation: 32, size: 2.0 }
                ]
            },
            thermalCamera: {
                name: 'Thermal Imaging',
                active: true,
                hotspots: [],         // filled dynamically
                coldspots: []
            },
            radiationDetector: {
                name: 'Radiation Dosimeter',
                active: true,
                currentDose: 0.15,    // mSv/hr
                cumulativeDose: 427,  // mSv total mission
                alertThreshold: 1.0,  // mSv/hr
                saaPassingGrade: false // South Atlantic Anomaly
            },
            magnetometer: {
                name: 'Magnetometer',
                active: true,
                fieldStrength: 35000, // nT
                fieldDirection: { x: 0.3, y: 0.8, z: 0.5 },
                anomalyDetected: false
            }
        };

        // ============ ORBIT TRACKING ============
        this.orbit = {
            baseAltitude: 420,      // km (updated by API)
            phase: 0,               // 0-360 degrees around Earth
            latitude: 28.5,         // current ground track
            longitude: -80.6,
            ascending: true,        // moving north or south
            orbitNumber: 1847,
            period: 92.7,           // minutes
            timeToNextEclipse: 32,  // minutes
            timeToNextContact: 12   // minutes until ground station pass
        };
    }

    update() {
        const now = Date.now();
        const dt = (now - this.lastUpdate) / 1000; // seconds
        const dtMin = dt / 60;
        this.lastUpdate = now;
        this.missionTime += dt;

        // Sync with real data APIs every 60 seconds
        if (now - this.lastRealDataSync > 60000) {
            this._syncWithRealData();
            this.lastRealDataSync = now;
        }

        this._updateOrbit(dtMin);
        this._updateEnvironment(dtMin);
        this._updatePower(dtMin);
        this._updateThermal(dtMin);
        this._updateComms(dtMin);
        this._updateSensors(dtMin);
        this._updateSectionStatuses();
        this._updateActuators(dt); // New real-time actuator updates

        // Run the autonomy Flight Controller loop
        this.flightController.tick(dt);
    }

    _updateActuators(dtSeconds) {
        // Attitude slew logic
        if (this.attitude.currentAngle !== this.attitude.targetAngle) {
            const diff = this.attitude.targetAngle - this.attitude.currentAngle;
            const step = Math.sign(diff) * Math.min(Math.abs(diff), this.attitude.slewRate * dtSeconds);
            this.attitude.currentAngle += step;
        }
    }

    applyThrust(directionArray, deltaV) {
        // Consume fuel based on Tsiolkovsky equation
        const wetMass = this._wetMassKg();
        const fuelReq = tsiolkovskyFuel(deltaV, wetMass, this.physics.isp_s);

        if (this.sections.thrusterPod.fuelMass > fuelReq.fuelKg * 1000) {
            this.sections.thrusterPod.fuelMass -= fuelReq.fuelKg * 1000;
            this.propulsion.remainingDeltaV -= deltaV;
            // Simplified orbit boost (in reality, depends on position in orbit)
            if (directionArray[1] === 1) { // Radial Out approximation
                this.orbit.baseAltitude += deltaV * 0.1;
            } else if (directionArray[0] === 1) { // Prograde
                this.orbit.baseAltitude += deltaV * 2.0;
            }
        }
    }

    _updateOrbit(dtMin) {
        // Use real period from altitude (not hardcoded 92.7 min)
        const period = orbitalPeriod(this.orbit.baseAltitude);
        this.orbit.period = period;
        this.orbit.phase = (this.orbit.phase + (dtMin / period) * 360) % 360;
        this.orbit.orbitNumber = Math.floor(this.missionTime / (period * 60)) + 1847;

        // Ground track (simplified sinusoidal)
        this.orbit.latitude = 51.6 * Math.sin((this.orbit.phase * Math.PI) / 180);
        this.orbit.longitude = (this.orbit.longitude - (dtMin / period) * 360 * 0.0667) % 360;
        this.orbit.ascending = Math.cos((this.orbit.phase * Math.PI) / 180) > 0;

        // J2 RAAN drift — accumulated over time
        const drift = j2RaanDrift(this.orbit.baseAltitude, 51.6, this.environment.eccentricity);
        this._raanDriftDeg += drift * (dtMin / (60 * 24)); // drift * fraction of day

        // Sun/shadow: 60% sunlight, 40% shadow
        this.environment.inSunlight = (this.orbit.phase % 360) < 216;
        this.environment.eclipseProgress = this.environment.inSunlight ? 0 :
            Math.min(1, (this.orbit.phase - 216) / 144);

        // Countdown timers
        if (this.environment.inSunlight) {
            this.orbit.timeToNextEclipse = ((216 - (this.orbit.phase % 360)) / 360) * period;
        } else {
            this.orbit.timeToNextEclipse = 0;
        }
        this.orbit.timeToNextContact = Math.max(0, 15 - (this.missionTime % 900) / 60);
    }

    _updateEnvironment(dtMin) {
        const dtSec = dtMin * 60;

        // ── ATMOSPHERIC DRAG DECAY (Detour physics) ──
        const vMs = this.environment.velocity * 1000; // km/s → m/s
        const kp = this.environment.geomagneticIndex;
        const decay = dragDecayRate(
            this.orbit.baseAltitude, vMs,
            this.physics.Cd, this.physics.Am, kp
        );
        // Apply decay to base altitude (km/s * seconds = km)
        this.orbit.baseAltitude += decay * dtSec;
        // Clamp — if below 180km, satellite re-enters
        this.orbit.baseAltitude = Math.max(180, this.orbit.baseAltitude);

        // ── J2 ALTITUDE OSCILLATION (Detour physics) ──
        this.environment.altitude = j2AltitudeCorrection(
            this.orbit.baseAltitude,
            this.orbit.latitude,
            51.6
        );

        // ── VELOCITY (from altitude, continuously recomputed) ──
        this.environment.velocity = orbitalVelocity(this.environment.altitude);

        // Gravity at altitude: g = 9.81 * (R / (R + h))^2
        const R = 6371;
        const h = this.environment.altitude;
        this.environment.gravity = 9.81 * Math.pow(R / (R + h), 2);

        // Drag force magnitude (Newtons, for display)
        this.environment.atmosphericDrag = 0.5 * this.physics.Cd * this.physics.Am *
            (this.physics.dryMassKg + this._fuelMassKg()) *
            1e-10 * vMs * vMs * (1 + kp * 0.1);

        // Sun angle
        this.environment.sunAngle = this.environment.inSunlight ?
            45 + 30 * Math.sin((this.orbit.phase * Math.PI) / 90) : -90;

        // Radiation varies with latitude (South Atlantic Anomaly)
        const inSAA = this.orbit.latitude < -15 && this.orbit.latitude > -45 &&
            this.orbit.longitude > -90 && this.orbit.longitude < 40;
        this.environment.radiationLevel = inSAA ? 0.8 + Math.random() * 0.4 : 0.12 + Math.random() * 0.06;
        this.sensors.radiationDetector.saaPassingGrade = inSAA;
        this.sensors.radiationDetector.currentDose = this.environment.radiationLevel;
        this.sensors.radiationDetector.cumulativeDose += this.environment.radiationLevel * (dtMin / 60);

        // Magnetic field varies with position + space weather perturbation
        const baseField = 30000 + 10000 * Math.cos((this.orbit.latitude * Math.PI) / 90);
        // Kp index creates large perturbations. High Kp = big magnetic swing
        const perturbation = this.environment.geomagneticIndex > 4 ?
            (this.environment.geomagneticIndex * 250) * Math.sin(Date.now() / 1000) : 0;

        this.environment.magneticField = baseField + perturbation;
        this.sensors.magnetometer.fieldStrength = this.environment.magneticField;
        this.sensors.magnetometer.anomalyDetected = Math.abs(perturbation) > 500;

        if (this.sensors.magnetometer.anomalyDetected) {
            this.sensors.magnetometer.fieldDirection.x += Math.sin(Date.now() / 500) * 0.05;
            this.sensors.magnetometer.fieldDirection.y += Math.cos(Date.now() / 500) * 0.05;
        } else {
            this.sensors.magnetometer.fieldDirection = { x: 0.3, y: 0.8, z: 0.5 }; // normalized base
        }
    }

    _updatePower(dtMin) {
        const bat = this.sections.batteryBay;
        const panelA = this.sections.solarPanelA;
        const panelB = this.sections.solarPanelB;

        // Solar output depends on sun + angle + efficiency
        if (this.environment.inSunlight && panelA.deployed) {
            panelA.powerOutput = 5.0 * panelA.efficiency * Math.max(0, Math.cos((panelA.angle * Math.PI) / 180));
        } else {
            panelA.powerOutput = 0;
        }
        if (this.environment.inSunlight && panelB.deployed) {
            panelB.powerOutput = 5.0 * panelB.efficiency * Math.max(0, Math.cos((panelB.angle * Math.PI) / 180));
        } else {
            panelB.powerOutput = 0;
        }

        const totalSolar = panelA.powerOutput + panelB.powerOutput;

        // Total power draw from all sections
        const totalDraw = 2.5 + // base avionics
            (this.sections.payloadBay.lidarActive ? 0.5 : 0) +
            (this.sections.payloadBay.cameraActive ? 0.3 : 0) +
            (this.sections.commArray.linkStatus !== 'LOST' ? 1.0 : 0.1) +
            (this.sections.thermalRadiator.pumpActive ? 0.2 : 0);

        bat.currentDraw = totalDraw / bat.voltage;

        // Net energy balance
        const netPower = totalSolar - totalDraw; // Watts
        const chargeChange = (netPower / bat.capacityWh) * (dtMin / 60) * 100;
        bat.charge = Math.max(0, Math.min(100, bat.charge + chargeChange));

        // Voltage sag at low charge
        bat.voltage = bat.charge > 20 ? 7.4 : 6.8 + (bat.charge / 20) * 0.6;
    }

    _updateThermal(dtMin) {
        for (const key of Object.keys(this.sections)) {
            const section = this.sections[key];

            if (this.environment.inSunlight) {
                // Sun heating — different rates per section
                const heatRate = key.includes('solar') ? 4 : key === 'thermalRadiator' ? 1 : 2.5;
                section.temperature += heatRate * dtMin;
            } else {
                // Shadow cooling
                const coolRate = key === 'thermalRadiator' ? 3 : 1.5;
                section.temperature -= coolRate * dtMin;
            }

            // Radiator actively cools other sections
            if (this.sections.thermalRadiator.pumpActive && key !== 'thermalRadiator') {
                section.temperature -= 0.5 * dtMin;
            }

            section.temperature = Math.max(-80, Math.min(130, section.temperature));
        }

        // Generate thermal hotspots for thermal camera
        this.sensors.thermalCamera.hotspots = Object.entries(this.sections)
            .filter(([_, s]) => s.temperature > 60)
            .map(([key, s]) => ({ section: key, temp: s.temperature }));

        this.sensors.thermalCamera.coldspots = Object.entries(this.sections)
            .filter(([_, s]) => s.temperature < -10)
            .map(([key, s]) => ({ section: key, temp: s.temperature }));
    }

    _updateComms(dtMin) {
        const comm = this.sections.commArray;
        const behind = this.orbit.phase > 180 && this.orbit.phase < 270;

        if (behind) {
            comm.linkStatus = 'LOST';
            comm.signalStrength = -120;
            comm.dataRate = 0;
        } else if (this.orbit.phase > 150 && this.orbit.phase < 210) {
            comm.linkStatus = 'WEAK';
            comm.signalStrength = -95;
            comm.dataRate = 1200;
        } else {
            comm.linkStatus = 'STRONG';
            comm.signalStrength = -65;
            comm.dataRate = 9600;
            comm.lastContact = Date.now();
        }
    }

    _updateSensors(dtMin) {
        const relVel_ms = 500 + Math.random() * 6000; // m/s relative velocity (typical LEO)

        // LIDAR: tracked objects drift slowly, compute real Pc for each
        this.sensors.lidar.trackedObjects.forEach(obj => {
            obj.distance += (Math.random() - 0.5) * 2 * dtMin;
            obj.distance = Math.max(5, obj.distance);
            obj.bearing = (obj.bearing + Math.random() * 0.5) % 360;
            if (obj.elevation === undefined) obj.elevation = (Math.random() - 0.5) * 90;
            obj.elevation = Math.max(-90, Math.min(90, obj.elevation + (Math.random() - 0.5) * 1.5));

            // ── CHAN COLLISION PROBABILITY (Detour physics) ──
            const missDist_m = obj.distance * 1000;
            obj.pc = chanCollisionProbability(
                missDist_m,
                relVel_ms,
                this.physics.posUncertainty_m,
                this.physics.collisionRadius_m
            );
            obj.pcFormatted = formatPc(obj.pc);
            const risk = classifyCollisionRisk(obj.pc);
            obj.riskLevel = risk.level;
            obj.riskLabel = risk.label;
            obj.riskColor = risk.color;
        });

        // Update nearest object
        const nearest = this.sensors.lidar.trackedObjects.reduce((a, b) =>
            a.distance < b.distance ? a : b);
        const closingSpeed = +(((Math.random() - 0.3) * 0.05)).toFixed(4);
        this.sensors.lidar.nearestObject = {
            ...nearest,
            closingSpeed,
            threatLevel: nearest.riskLevel
        };
    }

    _updateSectionStatuses() {
        for (const [key, section] of Object.entries(this.sections)) {
            if (section.temperature > 70 || section.temperature < -20) {
                section.status = 'critical';
            } else if (section.temperature > 55 || section.temperature < -5) {
                section.status = 'warning';
            } else {
                section.status = 'nominal';
            }
        }

        // Battery-specific status
        if (this.sections.batteryBay.charge < 15) this.sections.batteryBay.status = 'critical';
        else if (this.sections.batteryBay.charge < 30) this.sections.batteryBay.status = 'warning';

        // Thruster-specific
        if (this.sections.thrusterPod.fuelPercent < 10) this.sections.thrusterPod.status = 'critical';
        else if (this.sections.thrusterPod.pressure < 0.5) this.sections.thrusterPod.status = 'warning';

        // Comm-specific
        if (this.sections.commArray.linkStatus === 'LOST') this.sections.commArray.status = 'warning';
    }

    getFullState() {
        const fuelKg = this._fuelMassKg();
        const dryMass = this.physics.dryMassKg;
        const dv = maxDeltaV(fuelKg, dryMass, this.physics.isp_s);
        return {
            missionTime: this.missionTime,
            sections: this.sections,
            environment: this.environment,
            sensors: this.sensors,
            orbit: {
                ...this.orbit,
                raanDriftDeg: +this._raanDriftDeg.toFixed(3)
            },
            physics: {
                fuelMassKg: +fuelKg.toFixed(4),
                dryMassKg: dryMass,
                wetMassKg: +(fuelKg + dryMass).toFixed(4),
                maxDeltaV_ms: +dv.toFixed(2),
                isp_s: this.physics.isp_s
            },
            survivalScore: this._calculateSurvivalScore()
        };
    }

    // Backward compatible
    getState() {
        const s = this.sections;
        return {
            battery: s.batteryBay.charge,
            temperature: s.onboardComputer.temperature,
            fuel: s.thrusterPod.fuelPercent,
            signal: s.commArray.linkStatus,
            signalStrength: Math.max(0, Math.min(100, (s.commArray.signalStrength + 120) * 1.2)),
            inSunlight: this.environment.inSunlight,
            sunFacing: s.solarPanelA.angle < 30,
            powerMode: s.batteryBay.charge < 15 ? 'SAFE' : 'ACTIVE',
            orbitPhase: this.orbit.phase,
            survivalScore: this._calculateSurvivalScore(),
            threats: this.sensors.lidar.trackedObjects.map(o => ({
                name: o.id,
                distance: o.distance,
                level: o.distance < 20 ? 'critical' : o.distance < 50 ? 'warning' : 'safe'
            }))
        };
    }

    _calculateSurvivalScore() {
        let score = 100;

        // Check every section
        for (const section of Object.values(this.sections)) {
            if (section.status === 'critical') score -= 15;
            else if (section.status === 'warning') score -= 5;
        }

        // Environment penalties
        if (this.environment.radiationLevel > 0.5) score -= 10;
        if (this.sensors.lidar.nearestObject.distance < 20) score -= 25;

        return Math.max(0, Math.min(100, Math.round(score)));
    }

    executeAction(action, params = {}) {
        switch (action) {
            case 'rotate_to_sun':
                this.sections.solarPanelA.angle = 0;
                this.sections.solarPanelB.angle = 0;
                break;
            case 'rotate_to_shadow':
                this.sections.solarPanelA.angle = 90;
                this.sections.solarPanelB.angle = 90;
                break;
            case 'safe_mode':
                this.sections.payloadBay.lidarActive = false;
                this.sections.payloadBay.cameraActive = false;
                this.sections.commArray.txPower = 0.1;
                break;
            case 'active_mode':
                this.sections.payloadBay.lidarActive = true;
                this.sections.commArray.txPower = 1.0;
                break;
            case 'evasion_burn': {
                // ── TSIOLKOVSKY FUEL BURN (Detour physics) ──
                // Evasion burn: 0.5 m/s delta-v (typical small avoidance maneuver)
                const deltaV_ms = params.deltaV_ms || 0.5;
                const tp = this.sections.thrusterPod;
                const fuelNeeded_kg = tsiolkovskyFuel(
                    deltaV_ms,
                    this._wetMassKg(),
                    this.physics.isp_s
                );
                const fuelNeeded_g = fuelNeeded_kg * 1000;
                if (tp.fuelMass >= fuelNeeded_g) {
                    tp.fuelMass -= fuelNeeded_g;
                } else {
                    tp.fuelMass = 0; // out of fuel
                }
                tp.fuelPercent = (tp.fuelMass / 250) * 100;
                tp.pressure = Math.max(0.1, tp.pressure - fuelNeeded_kg * 8);
                tp.totalBurns++;
                tp.lastFired = Date.now();
                tp.nozzleTemp = 180 + deltaV_ms * 40;
                break;
            }
            case 'orbital_reboost': {
                // Prograde burn to counteract drag decay — raises orbit
                const dvReboost = params.deltaV_ms || 0.2;
                const tpR = this.sections.thrusterPod;
                const fuelR_kg = tsiolkovskyFuel(dvReboost, this._wetMassKg(), this.physics.isp_s);
                const fuelR_g = fuelR_kg * 1000;
                if (tpR.fuelMass >= fuelR_g) {
                    tpR.fuelMass -= fuelR_g;
                    this.orbit.baseAltitude += dvReboost * 0.12; // ~0.12 km per m/s
                } else {
                    tpR.fuelMass = 0;
                }
                tpR.fuelPercent = (tpR.fuelMass / 250) * 100;
                tpR.pressure = Math.max(0.1, tpR.pressure - fuelR_kg * 8);
                tpR.totalBurns++;
                tpR.lastFired = Date.now();
                tpR.nozzleTemp = 160 + dvReboost * 30;
                break;
            }
            case 'vent_heat':
                this.sections.thermalRadiator.pumpActive = true;
                this.sections.thermalRadiator.heatRejection = 14;
                this.sections.thermalRadiator.fluidTemp = Math.max(15, this.sections.thermalRadiator.fluidTemp - 5);
                break;
            case 'restart_computer': {
                const obc = this.sections.onboardComputer;
                obc.errorCount = 0;
                obc.cpuLoad = 15;
                obc.memoryUsed = 10;
                obc.lastReboot = Date.now();
                obc.temperature = Math.max(obc.temperature - 8, 20);
                obc.status = 'nominal';
                break;
            }
        }
    }

    // Time-accelerated update — called by main.js with a scaled dt in ms
    _scaledUpdate(scaledDtMs) {
        const now = Date.now();
        // Temporarily override lastUpdate so update() calculates the right dt
        this.lastUpdate = now - scaledDtMs;
        this.update();
    }

    async _syncWithRealData() {
        try {
            // 1. Orbital Data (TLE)
            const tle = await this.dataService.getOrbitalData();
            if (tle) {
                // Update physics constants from real TLE
                this.orbit.baseAltitude = tle.altitude;
                this.environment.velocity = tle.velocity;
                this.orbit.period = tle.periodMinutes; // store for calculations
                // We don't overwrite phase/lat/lon directly to avoid jumpiness, 
                // but we could recalibrate drag/gravity based on real altitude
            }

            // 2. Space Weather
            const weather = await this.dataService.getSpaceWeather();
            if (weather) {
                this.environment.solarFluxIndex = weather.solarFlux;
                this.environment.geomagneticIndex = weather.geomagneticKp;
                // High Kp index increases atmospheric drag simulation
                this.environment.atmosphericDrag = 0.00001 * (1 + weather.geomagneticKp / 10);
            }

            // 3. Debris Risks
            const debris = await this.dataService.getDebrisRisks();
            if (debris && debris.length > 0) {
                // Update LIDAR tracks with real debris IDs
                // We keep the relative motion logic (closing speed) but use real names/distances
                this.sensors.lidar.trackedObjects = debris.map((d, i) => ({
                    id: d.id,
                    distance: d.dist,
                    bearing: (i * 120 + Math.random() * 40) % 360,
                    elevation: -45 + Math.random() * 90,
                    size: 0.1 + Math.random(),
                    closingSpeed: d.speed
                }));
            }

        } catch (e) {
            console.warn('Real data sync failed:', e);
        }
    }
}
