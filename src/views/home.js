// Overview — the real-time Earth and orbit, with the readings that matter at a glance.
import { app } from '../app.js';
import { MISSION_LOG, onLog } from '../log.js';
import { OrbitScene } from '../webgl/OrbitScene.js';
import { esc, fmt, setText, label, describeCommand, drawSparkline } from '../ui/dom.js';
import { bindExplainers } from '../ui/modal.js';

const EXPLAIN = {
    orbit: {
        title: 'Orbit and decay',
        html: `<p>The satellite flies a near-circular orbit. Its <strong>mean altitude</strong> is the orbit radius minus Earth's mean radius. The <strong>height above the ground</strong> changes by about 13 km around each orbit because Earth is flatter at the poles (WGS-84 ellipsoid).</p>
        <p>Thin air at this height drags on the satellite. The orbit shrinks at <code>dr/dt = −ρ·Cd·(A/m)·v·r</code>, faster when solar activity (F10.7) and geomagnetic storms (Kp) heat the upper atmosphere.</p>
        <p>The lifetime estimate integrates that decay down to 200 km, accounting for the denser air lower down.</p>`,
    },
    health: {
        title: 'Survival score',
        html: `<p>Starts at 100. Each subsystem outside its comfortable temperature band or in a fault costs 5 (warning) or 15 (critical). A conjunction above Pc 1e-5 costs 10, above 1e-4 costs 25. Radiation above 0.5 mSv/h costs 10, and an orbit below 250 km costs 20.</p>`,
    },
    autonomy: {
        title: 'How the satellite decides',
        html: `<p>A <strong>planner</strong> proposes a short plan in JSON: Gemini when the local server has an API key, otherwise the rule-based autopilot. The <strong>flight controller</strong> validates every command, runs the plan step by step on simulation time, and aligns the thruster before any burn.</p>
        <p>A <strong>safety supervisor</strong> watches battery and temperatures. When a hard limit is crossed it applies a safe configuration itself and vetoes any command that would undo it, until conditions recover.</p>`,
    },
};

const SHORT = {
    solarPanelA: 'Wing A', solarPanelB: 'Wing B', batteryBay: 'Battery', thrusterPod: 'Thruster',
    commArray: 'Radio', payloadBay: 'Camera', thermalRadiator: 'Structure', onboardComputer: 'Computer',
};

export function createHomeView() {
    const el = document.createElement('div');
    el.className = 'view overview';
    el.innerHTML = `
    <section class="hero" aria-label="Earth and orbit, live">
      <div class="hero-info">
        <p class="hero-where" id="h-where">—</p>
        <div class="hero-tags">
          <span class="tag" id="h-sun">—</span>
          <span class="tag" id="h-comm">—</span>
          <span class="tag" id="h-att">—</span>
        </div>
      </div>
      <div class="hero-tools">
        <div class="seg" role="group" aria-label="Camera">
          <button class="btn" id="cam-earth" aria-pressed="true">Whole Earth</button>
          <button class="btn" id="cam-sat" aria-pressed="false">Follow satellite</button>
        </div>
      </div>
      <div class="hero-legend">
        <span><i class="legend-line" style="background:var(--accent)"></i>Orbit</span>
        <span><i class="legend-line" style="background:var(--good)"></i>Ground-station link</span>
        <span><i class="legend-line" style="background:var(--critical)"></i>Debris track, near closest approach</span>
      </div>
    </section>

    <aside class="rail">
      <section class="block">
        <div class="block-head"><h2>Orbit</h2><button class="explain" data-explain="orbit" aria-label="About the orbit numbers">?</button></div>
        <div class="alt-hero"><span id="h-alt">—</span><small>km</small></div>
        <p class="alt-sub" id="h-alt-sub">—</p>
        <div class="rows">
          <div class="row"><span>Speed</span><span id="h-vel">—</span></div>
          <div class="row"><span>One orbit takes</span><span id="h-period">—</span></div>
          <div class="row"><span>Losing altitude</span><span id="h-decay">—</span></div>
          <div class="row"><span>Time left in orbit</span><span id="h-life">—</span></div>
        </div>
      </section>

      <section class="block">
        <div class="block-head"><h2>Health</h2><button class="explain" data-explain="health" aria-label="About the survival score">?</button></div>
        <div class="health">
          <div class="ring" id="h-ring">
            <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="bg" cx="50" cy="50" r="42"/><circle class="fg" id="h-ring-fg" cx="50" cy="50" r="42" stroke-dasharray="263.9" stroke-dashoffset="0"/></svg>
            <div class="ring-val"><b id="h-score">—</b><span>survival</span></div>
          </div>
          <div class="subsys" id="h-subsys"></div>
        </div>
      </section>

      <section class="block">
        <div class="block-head"><h2>Autonomy</h2><button class="explain" data-explain="autonomy" aria-label="How decisions are made">?</button></div>
        <p class="planner-line" id="h-planner">—</p>
        <div id="h-plan"></div>
      </section>

      <section class="block">
        <div class="block-head"><h2>Latest events</h2><a class="block-note" href="#crisis">Full log</a></div>
        <ul class="log" id="h-log"></ul>
      </section>
    </aside>

    <section class="strip" aria-label="Key telemetry">
      <div>
        <div class="strip-label"><span>Battery</span><span id="h-bat-state"></span></div>
        <div class="big" id="h-bat">—</div>
        <div class="spark"><canvas id="sp-bat" aria-label="Battery charge, last hours"></canvas><div class="spark-readout"></div></div>
      </div>
      <div>
        <div class="strip-label"><span>Solar power</span><span id="h-inc"></span></div>
        <div class="big" id="h-solar">—</div>
        <div class="spark"><canvas id="sp-solar" aria-label="Solar power, last hours"></canvas><div class="spark-readout"></div></div>
      </div>
      <div>
        <div class="strip-label"><span>Propellant</span></div>
        <div class="big" id="h-dv">—</div>
        <div class="meter" id="h-fuel-m"><i></i></div>
        <div class="spark-readout" id="h-fuel"></div>
      </div>
      <div>
        <div class="strip-label"><span>Highest collision risk</span></div>
        <div class="big" id="h-pc">—</div>
        <div class="spark-readout" id="h-pc-sub"></div>
      </div>
      <div>
        <div class="strip-label"><span>Radiation</span><span id="h-saa"></span></div>
        <div class="big" id="h-rad">—</div>
        <div class="spark"><canvas id="sp-rad" aria-label="Dose rate, last hours"></canvas><div class="spark-readout"></div></div>
      </div>
    </section>`;

    let interval, unsub, scene;

    function renderLog() {
        const ul = el.querySelector('#h-log');
        ul.innerHTML = MISSION_LOG.slice(0, 6).map(e => `
          <li data-level="${esc(e.level)}">
            <div class="log-head"><span class="log-action">${esc(e.action)}</span><span class="log-meta">${esc(fmt.clock(e.missionTime))}, ${esc(e.source)}</span></div>
            <div class="log-reason">${esc(e.reason)}</div>
          </li>`).join('') || '<li class="empty">Nothing yet.</li>';
    }

    function update() {
        const st = app.sat.getFullState();
        const env = st.environment, o = st.orbit, s = st.sections;
        scene?.update(st, app.paused ? 0 : app.warp);

        const ns = o.latitude >= 0 ? 'N' : 'S', ew = o.longitude >= 0 ? 'E' : 'W';
        setText(el, '#h-where', `Over ${Math.abs(o.latitude).toFixed(1)}° ${ns}, ${Math.abs(o.longitude).toFixed(1)}° ${ew}`);
        const sun = el.querySelector('#h-sun');
        sun.dataset.status = env.inSunlight ? 'sun' : 'caution';
        sun.textContent = env.inSunlight
            ? `Sunlit, eclipse in ${o.timeToNextEclipse == null ? '—' : fmt.dur(o.timeToNextEclipse * 60)}`
            : `In Earth's shadow, sunrise in ${fmt.dur((o.timeToSunrise || 0) * 60)}`;
        const comm = el.querySelector('#h-comm');
        const c = s.commArray;
        comm.dataset.status = !c.antennaOk ? 'critical' : c.station ? 'good' : '';
        comm.textContent = !c.antennaOk ? 'Radio not transmitting'
            : c.station ? `Talking to ${c.station}` : o.timeToNextContact == null ? 'No ground pass in 24 h' : `Next ground pass in ${fmt.dur(o.timeToNextContact * 60)}`;
        setText(el, '#h-att', `${label(st.attitude.mode)}${st.attitude.pointingErrorDeg > 2 ? `, turning (${st.attitude.pointingErrorDeg.toFixed(0)}° to go)` : ''}`);

        setText(el, '#h-alt', o.baseAltitude.toFixed(1));
        setText(el, '#h-alt-sub', `Mean altitude. ${env.altitude.toFixed(1)} km above the ground right now.`);
        setText(el, '#h-vel', `${env.velocity.toFixed(3)} km/s`);
        setText(el, '#h-period', `${o.period.toFixed(1)} min`);
        setText(el, '#h-decay', `${Math.abs(env.decayRateKmPerDay * 1000).toFixed(0)} m per day`);
        setText(el, '#h-life', fmt.days(env.lifetimeDays));

        // health
        const score = st.survivalScore;
        setText(el, '#h-score', `${score}`);
        el.querySelector('#h-ring').dataset.status = score > 70 ? 'nominal' : score > 40 ? 'warning' : 'critical';
        el.querySelector('#h-ring-fg').style.strokeDashoffset = 263.9 * (1 - score / 100);
        el.querySelector('#h-subsys').innerHTML = Object.entries(s).map(([k, sec]) =>
            `<span class="tag" data-status="${esc(sec.status)}" title="${esc(sec.name)}: ${esc(fmt.level[sec.status])}, ${sec.temperature.toFixed(0)} °C">${esc(SHORT[k] || sec.name)}</span>`).join('');

        // autonomy
        const pl = app.planner;
        const sup = st.flight.supervisor;
        setText(el, '#h-planner', `${pl.status}${sup.battery ? '. Battery override active' : ''}${sup.thermal ? '. Thermal override active' : ''}${st.obc.down ? '. Computer rebooting' : ''}.`);
        const f = st.flight;
        const planEl = el.querySelector('#h-plan');
        if (f.plan) {
            planEl.innerHTML = `<p class="plan-summary">${esc(f.plan.summary)}</p><ol class="steps">${f.plan.commands.map((cmd, i) => {
                const state = i < f.stepIndex ? 'done' : i === f.stepIndex ? 'active' : 'queued';
                const word = state === 'done' ? 'Done' : state === 'active' ? (f.stepPhase === 'align' ? 'Aligning' : f.stepType === 'EXECUTE_BURN' ? `Firing ${Math.round(f.stepFraction * 100)}%` : 'Running') : 'Queued';
                return `<li data-state="${state}"><span>${esc(describeCommand(cmd))}</span><em>${esc(word)}</em></li>`;
            }).join('')}</ol>`;
        } else {
            const last = f.recent[0];
            planEl.innerHTML = `<p class="empty">No plan running.${last ? ` Last: ${esc(last.summary.slice(0, 110))} (${esc(last.outcome)}).` : ''}</p>`;
        }

        // strip
        const bat = s.batteryBay;
        setText(el, '#h-bat', `${bat.charge.toFixed(0)}%`);
        setText(el, '#h-bat-state', bat.currentDraw < -0.02 ? 'charging' : bat.currentDraw > 0.02 ? 'discharging' : 'idle');
        setText(el, '#h-solar', `${st.power.solarW.toFixed(1)} W`);
        setText(el, '#h-inc', env.inSunlight ? `${st.attitude.sunIncidenceDeg.toFixed(0)}° off Sun` : 'in shadow');
        setText(el, '#h-dv', `${st.physics.maxDeltaV_ms.toFixed(1)} m/s`);
        const fm = el.querySelector('#h-fuel-m');
        fm.firstElementChild.style.width = `${s.thrusterPod.fuelPercent}%`;
        fm.dataset.status = st.physics.maxDeltaV_ms < st.physics.reserveDeltaV_ms ? 'critical' : s.thrusterPod.fuelPercent < 20 ? 'warning' : '';
        setText(el, '#h-fuel', `${s.thrusterPod.fuelMass.toFixed(1)} g left, ${st.physics.reserveDeltaV_ms} m/s kept in reserve`);
        const worst = st.conjunctions.reduce((a, b) => (!a || b.pc > a.pc ? b : a), null);
        setText(el, '#h-pc', worst ? worst.pcFormatted : 'None');
        el.querySelector('#h-pc').style.color = worst && worst.pc >= 1e-4 ? 'var(--critical)' : worst && worst.pc >= 1e-5 ? 'var(--caution)' : '';
        setText(el, '#h-pc-sub', worst ? `${worst.name}, closest approach in ${fmt.dur(worst.timeToTca_s)}` : 'No debris in the screening window');
        setText(el, '#h-rad', `${env.radiationLevel.toFixed(3)} mSv/h`);
        setText(el, '#h-saa', st.sensors.radiationDetector.saaPassingGrade ? 'South Atlantic Anomaly' : '');

        const hist = st.history.slice(-240);
        drawSparkline(el.querySelector('#sp-bat'), hist.map(h => ({ t: h.t, v: h.soc })), { min: 0, max: 100, format: v => `${v.toFixed(0)}%` });
        drawSparkline(el.querySelector('#sp-solar'), hist.map(h => ({ t: h.t, v: h.solarW })), { min: 0, color: getComputedStyle(document.documentElement).getPropertyValue('--sun'), format: v => `${v.toFixed(1)} W` });
        drawSparkline(el.querySelector('#sp-rad'), hist.map(h => ({ t: h.t, v: h.dose })), { min: 0, format: v => `${v.toFixed(3)} mSv/h` });
    }

    return {
        element: el,
        init() {
            scene = new OrbitScene(el.querySelector('.hero'));
            const camE = el.querySelector('#cam-earth'), camS = el.querySelector('#cam-sat');
            camE.addEventListener('click', () => { scene.setFollow(false); camE.setAttribute('aria-pressed', 'true'); camS.setAttribute('aria-pressed', 'false'); });
            camS.addEventListener('click', () => { scene.setFollow(true); camS.setAttribute('aria-pressed', 'true'); camE.setAttribute('aria-pressed', 'false'); });
            bindExplainers(el, EXPLAIN);
            update();
            renderLog();
            interval = setInterval(update, 250);
            unsub = onLog(renderLog);
        },
        destroy() {
            clearInterval(interval);
            unsub?.();
            scene?.destroy();
        },
    };
}
