// Gemini AI Brain — full autonomous controller with structured command schema
// Upgraded to multi-command JSON, Pc-aware debris assessment, CME delay model

import { GoogleGenerativeAI } from '@google/generative-ai';

// ─────────────────────────────────────────────────────────────────────────────
// AI Decision Log — shared ring buffer for live display
// ─────────────────────────────────────────────────────────────────────────────
export const AI_LOG = [];
const MAX_LOG = 20;
export function logDecision(entry) {
    AI_LOG.unshift({ ...entry, timestamp: Date.now() });
    if (AI_LOG.length > MAX_LOG) AI_LOG.pop();
    // Sync to window for views that can't import ES modules directly
    window.__AI_LOG = AI_LOG;
    // Dispatch an event so the home view can react instantly
    window.dispatchEvent(new CustomEvent('ai-decision', { detail: entry }));
}

export class SatelliteBrain {
    constructor(apiKey) {
        this.genAI = new GoogleGenerativeAI(apiKey);
        this.model = null;
        this.lastDecision = null;
        this.actionCooldowns = {}; // prevent spam: action → last-fired timestamp
        this.cmeQueue = [];        // pending CME events with delay
    }

    async initialize() {
        this.model = this.genAI.getGenerativeModel({
            model: 'gemini-2.5-flash',
            systemInstruction: `You are FLIGHT, the onboard autonomous flight controller of a 1U CubeSat in Low Earth Orbit at ~420 km altitude.

Your responsibility is spacecraft survival and mission continuity.

You do NOT control physics directly.
You issue high-level commands which the flight computer executes.

Telemetry is noisy and delayed by signal latency.
Do not react to single anomalies; analyze trends.

Fuel is extremely limited.
Avoid burns unless necessary for collision avoidance or orbit correction.

Primary priorities in order:
1) Prevent collision
2) Maintain power above survival threshold
3) Maintain thermal stability
4) Preserve communication capability
5) Optimize mission performance

Allowed commands:
- SET_ATTITUDE_MODE (params: { target: "SUN_TRACKING" | "EARTH_NADIR" | "VELOCITY_ALIGNED" | "DEEP_SPACE" | "MANEUVER_ALIGNMENT" | "SAFE_TUMBLE_STOP" })
- PLAN_BURN (params: { vector: [x,y,z], delta_v: number, reason: string })
- EXECUTE_BURN (params: { plan_id: string })
- SET_POWER_MODE (params: { mode: "NOMINAL" | "LOW_POWER" | "SURVIVAL" | "CHARGE_PRIORITY" })
- SET_PAYLOAD_STATE (params: { state: "OFF" | "STANDBY" | "ACTIVE" })
- ENTER_SAFE_MODE (params: {})
- EXIT_SAFE_MODE (params: {})

Output ONLY valid JSON matching this schema. Never output text outside JSON. Prefer minimal commands. If no action needed, output an empty commands array.

{
  "timestamp": "ISO8601 string",
  "priority": "LOW|MEDIUM|HIGH|CRITICAL",
  "summary": "short human explanation of reasoning",
  "commands": [
    {
      "type": "SET_ATTITUDE_MODE",
      "params": { "target": "SUN_TRACKING" },
      "duration": 45
    }
  ],
  "confidence": 0.95
}`
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CME delay model — queues a radiation spike with a realistic arrival window
    // ─────────────────────────────────────────────────────────────────────────
    queueCME(delayMs = null) {
        // CME travel time: 15min–72hr, default random 1–8hr for demo
        const arrival = Date.now() + (delayMs ?? (3600000 + Math.random() * 25200000));
        this.cmeQueue.push({ arrivalTime: arrival, magnitude: 0.5 + Math.random() * 2 });
        logDecision({
            action: 'CME_ALERT',
            reason: `Solar energetic particle event detected. CME arrival in ~${Math.round((arrival - Date.now()) / 60000)} min`,
            threat_level: 'warning'
        });
    }

    // Process any pending CME arrivals — call this every tick
    processCME(satellite) {
        const now = Date.now();
        this.cmeQueue = this.cmeQueue.filter(cme => {
            if (now >= cme.arrivalTime) {
                // Inject the radiation spike into the satellite environment
                satellite.environment.radiationLevel = Math.min(3.0, cme.magnitude);
                satellite.environment.geomagneticIndex = Math.min(9, Math.round(cme.magnitude * 4));
                logDecision({
                    action: 'CME_IMPACT',
                    reason: `CME arrived! Radiation spiked to ${satellite.environment.radiationLevel.toFixed(1)} mSv/hr. Kp=${satellite.environment.geomagneticIndex}`,
                    threat_level: 'critical'
                });
                return false; // remove from queue
            }
            return true;
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Main decision loop
    // ─────────────────────────────────────────────────────────────────────────
    async decide(fullState) {
        try {
            const s = fullState.sections;
            const env = fullState.environment;
            const lidar = fullState.sensors.lidar;
            const rad = fullState.sensors.radiationDetector;
            const phys = fullState.physics || {};

            // Build richly detailed telemetry prompt including new physics data
            const nearestDebris = lidar.nearestObject;
            const debrisStr = lidar.trackedObjects
                .map(o => `  ${o.id}: ${o.distance.toFixed(1)}km Pc=${o.pcFormatted || '?'} [${o.riskLabel || '?'}]`)
                .join('\n');

            const prompt = `=== TELEMETRY SNAPSHOT (${new Date().toISOString()}) ===

POWER:
  Battery: ${s.batteryBay.charge.toFixed(1)}% | ${s.batteryBay.voltage.toFixed(1)}V | health:${s.batteryBay.healthPercent}%
  Solar A: ${s.solarPanelA.powerOutput.toFixed(1)}W (eff:${(s.solarPanelA.efficiency * 100).toFixed(0)}% ang:${s.solarPanelA.angle}°)
  Solar B: ${s.solarPanelB.powerOutput.toFixed(1)}W (eff:${(s.solarPanelB.efficiency * 100).toFixed(0)}% ang:${s.solarPanelB.angle}°)

PROPULSION:
  Fuel: ${s.thrusterPod.fuelPercent.toFixed(0)}% (${s.thrusterPod.fuelMass.toFixed(0)}g) pressure:${s.thrusterPod.pressure.toFixed(2)}MPa burns:${s.thrusterPod.totalBurns}
  Δv budget: ${phys.maxDeltaV_ms?.toFixed(1) ?? '?'} m/s remaining | Isp:${phys.isp_s ?? 60}s

THERMAL (°C): ${Object.entries(s).map(([k, v]) => `${k}:${v.temperature.toFixed(0)}`).join(' | ')}
STATUS: ${Object.entries(s).map(([k, v]) => `${k}:${v.status}`).join(' | ')}

ENVIRONMENT:
  Alt:${env.altitude.toFixed(1)}km | Vel:${env.velocity.toFixed(3)}km/s | Sun:${env.inSunlight ? 'YES' : 'NO (ECLIPSE)'}
  Radiation:${env.radiationLevel.toFixed(3)}mSv/hr | SAA:${rad.saaPassingGrade ? 'IN SAA' : 'clear'} | Kp:${env.geomagneticIndex}
  Mag:${Math.round(env.magneticField)}nT | AtmDrag:${(env.atmosphericDrag * 1e10).toFixed(2)}×10⁻¹⁰N

LIDAR DEBRIS (Chan Pc):
${debrisStr}
  Nearest: ${nearestDebris.id} @ ${nearestDebris.distance.toFixed(1)}km Pc=${nearestDebris.pcFormatted || '?'} [${nearestDebris.riskLabel || nearestDebris.threatLevel}] closing:${nearestDebris.closingSpeed?.toFixed(4)}km/s

COMMS: ${s.commArray.linkStatus} @ ${s.commArray.signalStrength}dBm | ${s.commArray.dataRate}bps
OBC: CPU:${s.onboardComputer.cpuLoad}% mem:${s.onboardComputer.memoryUsed}% temp:${s.onboardComputer.temperature.toFixed(0)}°C errors:${s.onboardComputer.errorCount}
Survival Score: ${fullState.survivalScore}%

What commands do you issue?`;

            const result = await this.model.generateContent(prompt);
            const raw = result.response.text().trim();

            // Robust JSON extraction — handles markdown fences too
            let parsed;
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('No JSON found in response');
            }

            const priority = parsed.priority || 'NORMAL';
            const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
            const summary = parsed.summary || 'No reasoning provided';

            // Give the plan an ID so FlightController doesn't loop it
            parsed.plan_id = `gemini_${Date.now()}`;

            // Send the entire packet to the FlightController Queue
            fullState.flightController.processAIPlan(parsed);

            // Log the sequence
            commands.forEach(cmd => {
                logDecision({ action: cmd.type, reason: summary, params: cmd.params, threat_level: priority.toLowerCase() });
            });

            this.lastDecision = parsed;
            return parsed;

        } catch (error) {
            console.error('AI brain error:', error);
            const fallback = this._emergencyFallback(fullState);
            fullState.flightController.processAIPlan(fallback);

            fallback.commands.forEach(cmd => {
                logDecision({ action: cmd.type, reason: fallback.summary, params: cmd.params, threat_level: 'warning' });
            });
            return fallback;
        }
    }

    _emergencyFallback(state) {
        const fallbackId = `fallback_${Date.now()}`;
        const s = state.sections;

        if (s.batteryBay.charge < 15) {
            return { plan_id: fallbackId, priority: 'EMERGENCY', commands: [{ type: 'SET_ATTITUDE_MODE', params: { target: 'SUN_TRACKING' }, duration: 60 }], summary: `EMERGENCY: Battery ${s.batteryBay.charge.toFixed(0)}%` };
        }
        for (const [key, section] of Object.entries(s)) {
            if (section.temperature > 75) {
                return { plan_id: fallbackId, priority: 'EMERGENCY', commands: [{ type: 'SET_ATTITUDE_MODE', params: { target: 'DEEP_SPACE' }, duration: 60 }], summary: `EMERGENCY: ${section.name} at ${section.temperature.toFixed(0)}°C` };
            }
        }
        if (state.sensors.lidar.nearestObject && state.sensors.lidar.nearestObject.distance < 15) {
            return { plan_id: fallbackId, priority: 'EMERGENCY', commands: [{ type: 'PLAN_BURN', params: { vector: [0, 1, 0], delta_v: 0.8, reason: "Debris Avoidance" }, duration: 10 }], summary: `EMERGENCY: Debris at ${state.sensors.lidar.nearestObject.distance.toFixed(1)}km` };
        }

        return { plan_id: fallbackId, priority: 'NORMAL', commands: [], summary: 'All systems within tolerance (Fallback)' };
    }
}
