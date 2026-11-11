/**
 * Planner prompt and structured-output schema (used by the server-side Gemini call)
 * and the telemetry snapshot builder (used in the browser).
 */
import {
    PRIORITIES, COMMAND_TYPES, ATTITUDE_MODES, POWER_MODES, PAYLOAD_STATES, MAX_BURN_DV,
} from './plan.js';

export const SYSTEM_PROMPT = `You are FLIGHT, the onboard autonomous planner of a 1U CubeSat (1.3 kg) in low Earth orbit.

You do not control hardware directly. You return a short JSON plan; a deterministic flight
controller validates it, executes it step by step, and a safety supervisor can veto any command.
Rejected or vetoed commands are reported back to you in the next telemetry snapshot.

Priorities, in order:
1. Avoid collisions.
2. Keep the battery above 30 % (the supervisor forces survival mode below 15 %).
3. Keep every component inside its temperature limits (limits are listed in the telemetry).
4. Keep the radio working.
5. Mission output: Earth images need payload ACTIVE + EARTH_NADIR attitude over the day side.

Physics you can rely on:
- Collision risk uses the probability Pc at the time of closest approach (TCA). NASA's manoeuvre
  threshold is Pc >= 1e-4; aim for every event below 1e-6 after a burn.
- An along-track burn of dv m/s made dt seconds before TCA moves the satellite radially by
  (2*dv/n)*(1 - cos(n*dt)), up to ~3.5 km per m/s half an orbit ahead (n = mean motion), and
  along-track by ~3*dv*dt. A burn moves EVERY upcoming conjunction, so check them all.
- Burn vectors are [prograde, radial-out, orbit-normal]. Typical avoidance burns are 0.02-0.5 m/s.
  The thruster is a 0.1 N cold-gas jet; the controller aligns the spacecraft before firing.
- Never spend into the delta-v reserve shown in telemetry.
- Every burn is checked against all upcoming conjunctions before it is armed and again before
  it fires. A burn that leaves the worst Pc at or above 1e-4 without lowering it is vetoed.
- When telemetry lists a SOLVER OPTION, it is the smallest burn the onboard solver found that
  takes every event below 1e-6. Prefer it unless you have a specific reason not to, and say why.
- Your plan is rejected as stale if it arrives more than 120 simulated seconds after this
  telemetry. If you do not act on a red conjunction, the autopilot backstop burns at TCA - 20 min.
- SUN_TRACKING charges fastest. EARTH_NADIR is needed for imaging but charges poorly.
  DEEP_SPACE turns the hot side away from the Sun and cools the spacecraft (no charging).
- RESET_OBC reboots the computer (~20 s): it clears single-event-upset errors, stuck processes,
  ADCS controller faults and radio firmware lock-ups.
- High radiation (solar proton events) raises upset rates; consider payload OFF during storms.

Commands (params in brackets):
- SET_ATTITUDE_MODE [target: ${ATTITUDE_MODES.join(' | ')}]
- PLAN_BURN [vector: [prograde, radial, normal], delta_v: m/s (max ${MAX_BURN_DV}), reason]
- EXECUTE_BURN [] executes the most recent PLAN_BURN
- SET_POWER_MODE [mode: ${POWER_MODES.join(' | ')}]
- SET_PAYLOAD_STATE [state: ${PAYLOAD_STATES.join(' | ')}]
- ENTER_SAFE_MODE [] / EXIT_SAFE_MODE []
- RESET_OBC []

Rules for your answer:
- priority is one of ${PRIORITIES.join(', ')}. CRITICAL pre-empts everything (use it for collision avoidance).
- Prefer the fewest commands. If nothing needs doing, return an empty commands array.
- Do not repeat a command whose effect is already in place (check the current modes).
- summary: one or two plain sentences with the numbers that justify the decision.`;

/** Gemini structured-output schema (OpenAPI subset). */
export const PLAN_SCHEMA = {
    type: 'OBJECT',
    properties: {
        priority: { type: 'STRING', enum: PRIORITIES },
        summary: { type: 'STRING' },
        confidence: { type: 'NUMBER' },
        commands: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    type: { type: 'STRING', enum: COMMAND_TYPES },
                    params: {
                        type: 'OBJECT',
                        properties: {
                            target: { type: 'STRING', enum: ATTITUDE_MODES },
                            mode: { type: 'STRING', enum: POWER_MODES },
                            state: { type: 'STRING', enum: PAYLOAD_STATES },
                            vector: { type: 'ARRAY', items: { type: 'NUMBER' } },
                            delta_v: { type: 'NUMBER' },
                            reason: { type: 'STRING' },
                        },
                    },
                },
                required: ['type'],
            },
        },
    },
    required: ['priority', 'summary', 'commands'],
};

const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '?');
const mins = (s) => (Number.isFinite(s) ? `${(s / 60).toFixed(1)} min` : '?');

/**
 * Compact, numbers-only telemetry for the planner.
 * @param {object} st          VirtualSatellite.getFullState()
 * @param {object} limits      THERMAL_LIMITS
 */
export function buildTelemetryPrompt(st, limits, avoidance = null) {
    const solver = !avoidance ? ''
        : avoidance.none ? `\nSOLVER OPTION: none - no single burn within the usable ${f(avoidance.usableDv, 2)} m/s clears every event.`
            : `\nSOLVER OPTION: PLAN_BURN vector [${avoidance.vector.join(', ')}], delta_v ${avoidance.deltaV} m/s -> worst Pc after ${avoidance.worstPcAfter.toExponential(1)}`;
    const s = st.sections, env = st.environment, o = st.orbit, a = st.attitude, fl = st.flight;
    const thermal = Object.entries(s).map(([k, v]) => {
        const L = limits[k];
        return `  ${k}: ${f(v.temperature)} °C [${v.status}] (ok ${L.warnLo}..${L.warnHi}, limit ${L.critLo}..${L.critHi})`;
    }).join('\n');
    const conj = st.conjunctions.length
        ? st.conjunctions.map(c => `  ${c.id}: TCA in ${mins(c.timeToTca_s)}, miss ${f(c.missDistance_m, 0)} m (radial ${f(c.xi, 0)}, horizontal ${f(c.zeta, 0)}), sigma ${f(c.sigma_m, 0)} m, Pc ${c.pcFormatted} [${c.riskLabel}], rel. speed ${f(c.relVel_ms / 1000, 1)} km/s, crossing ${f(c.crossingDeg, 0)}°${c.maneuvered ? ', already manoeuvred' : ''}`).join('\n')
        : '  none in the screening window';
    const pend = st.spaceWeather.pending.length
        ? st.spaceWeather.pending.map(p => `  ${p.type} "${p.label}" in ${mins(p.inS)}`).join('\n')
        : '  none';
    const trend = st.history.filter((_, i, arr) => (arr.length - 1 - i) % 10 === 0).slice(-6)
        .map(h => `  T+${(h.t / 3600).toFixed(2)} h: battery ${f(h.soc, 0)}%, alt ${f(h.alt, 2)} km, OBC ${f(h.tObc, 0)} °C, dose ${f(h.dose, 2)} mSv/h, max Pc ${h.maxPc ? h.maxPc.toExponential(1) : '0'}`).join('\n');
    const recent = fl.recent.slice(0, 4).map(r => `  ${r.plan_id} ${r.outcome}${r.reason ? ` (${r.reason})` : ''}`).join('\n') || '  none';

    return `TELEMETRY  T+${(st.missionTime / 3600).toFixed(3)} h  (${new Date(st.simTimeMs).toISOString()})

ORBIT: mean alt ${f(o.baseAltitude, 2)} km (geodetic ${f(env.altitude)} km), incl ${f(o.inclination, 2)}°, period ${f(o.period, 2)} min, decay ${f(env.decayRateKmPerDay, 3)} km/day, lifetime ~${Number.isFinite(env.lifetimeDays) ? f(env.lifetimeDays, 0) : '>36500'} days
  lat ${f(o.latitude)}°, lon ${f(o.longitude)}°, ${env.inSunlight ? 'SUNLIT' : 'ECLIPSE'}, next eclipse in ${o.timeToNextEclipse == null ? 'n/a' : f(o.timeToNextEclipse) + ' min'}, eclipse length ${f(o.eclipseDurationMin)} min, beta ${f(env.betaAngle)}°
ATTITUDE: mode ${a.mode}, pointing error ${f(a.pointingErrorDeg)}°, sun incidence on panels ${f(a.sunIncidenceDeg, 0)}°
POWER: mode ${st.powerMode}, battery ${f(s.batteryBay.charge)}% ${f(s.batteryBay.voltage, 2)} V, solar ${f(st.power.solarW, 2)} W, load ${f(st.power.loads?.total, 2)} W, heater ${s.batteryBay.heaterOn ? 'ON' : 'off'}${s.batteryBay.chargeInhibited ? ', CHARGING INHIBITED (cold)' : ''}
  panel efficiency A ${f(s.solarPanelA.efficiency * 100, 0)}%, B ${f(s.solarPanelB.efficiency * 100, 0)}%
PAYLOAD: ${s.payloadBay.state}${s.payloadBay.imaging ? ' (imaging)' : ''}; images ${st.mission.imagesCaptured}, buffered ${f(st.mission.dataBufferedMB, 2)} MB
THERMAL:
${thermal}
PROPULSION: ${f(s.thrusterPod.fuelMass, 1)} g propellant, delta-v ${f(st.physics.maxDeltaV_ms, 2)} m/s (reserve ${st.physics.reserveDeltaV_ms} m/s), Isp ${st.physics.isp_s} s
COMMS: ${s.commArray.linkStatus}${s.commArray.station ? ` via ${s.commArray.station}` : ''}, radio ${s.commArray.antennaOk ? 'ok' : 'LOCKED UP'}, next pass ${o.timeToNextContact == null ? 'none in 24 h' : f(o.timeToNextContact) + ' min'}
OBC: CPU ${f(s.onboardComputer.cpuLoad, 0)}%, upsets since reboot ${s.onboardComputer.errorCount}, ${st.obc.down ? 'REBOOTING' : 'running'}
SPACE WEATHER: Kp ${f(st.spaceWeather.kp)}, F10.7 ${f(st.spaceWeather.f107, 0)}, dose ${f(env.radiationLevel, 3)} mSv/h${s.payloadBay && st.sensors.radiationDetector.saaPassingGrade ? ' (South Atlantic Anomaly)' : ''}
  incoming:
${pend}
CONJUNCTIONS:
${conj}${solver}
SUPERVISOR: battery override ${fl.supervisor.battery ? 'ACTIVE' : 'off'}, thermal override ${fl.supervisor.thermal ? 'ACTIVE' : 'off'}
CONTROLLER: ${fl.plan ? `executing ${fl.plan.plan_id} step ${fl.stepIndex + 1}/${fl.plan.commands.length} (${fl.stepType})` : 'idle'}, queued ${fl.queue.length}${fl.pendingBurn ? `, burn armed ${f(fl.pendingBurn.deltaV, 3)} m/s` : ''}
RECENT PLAN OUTCOMES:
${recent}
TREND (10-min samples):
${trend || '  (collecting)'}

What do you command?`;
}
