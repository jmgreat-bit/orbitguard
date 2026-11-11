// Power & propulsion — battery, power budget, propellant and a manoeuvre calculator.
import { app } from '../app.js';
import { hohmannDeltaV, tsiolkovskyFuel, meanMotion } from '../physics.js';
import { esc, fmt, setText, label, drawSparkline } from '../ui/dom.js';
import { bindExplainers } from '../ui/modal.js';

const LOAD_NAMES = {
    obc: 'Onboard computer', eps: 'Power electronics', adcs: 'Attitude control', radioRx: 'Radio receiver',
    radioTx: 'Radio transmitter', payload: 'Camera payload', heater: 'Battery heater', propulsion: 'Thruster valves', fault: 'Fault (stuck wheel)',
};

const EXPLAIN = {
    power: {
        title: 'Power budget',
        html: `<p>Two deployable wings give up to 5 W each when they face the Sun squarely, falling with the cosine of the Sun angle and to zero in Earth's shadow. Cells also lose about 0.45 % of output per °C above 28 °C.</p>
        <p>The 60 Wh 2S lithium-ion pack charges at 95 % efficiency. It may not be charged below 0 °C, so a 1 W heater keeps it above 2 °C. Surplus power is shunted as heat when the pack is full or too cold.</p>
        <p>Imaging needs Earth-pointing, which charges poorly. The planners alternate: image above 70 %, recharge below 45 %.</p>`,
    },
    prop: {
        title: 'Propellant and Δv',
        html: `<p>A 0.1 N cold-gas thruster with a specific impulse of 60 s. The Δv the remaining propellant can deliver comes from the rocket equation: <code>Δv = Isp·g₀·ln((m_dry + m_prop)/m_dry)</code>.</p>
        <p>The controller refuses any burn that would dip into the reserve. Collision-avoidance burns are typically a few cm/s to a few tenths of a m/s.</p>`,
    },
    calc: {
        title: 'Manoeuvre calculator',
        html: `<p><strong>Raise the orbit:</strong> a two-burn Hohmann transfer between circular orbits. For small changes the total is about <code>Δv ≈ v·Δr/(2r)</code>, roughly 0.56 m/s per km at this altitude.</p>
        <p><strong>Dodge debris:</strong> the Clohessy–Wiltshire equations give the satellite's displacement after a small burn. A prograde burn made half an orbit before closest approach lifts the satellite by <code>4·Δv/n</code>, about 3.5 km for every m/s.</p>`,
    },
};

export function createEngineView() {
    const el = document.createElement('div');
    el.className = 'view panels';
    el.innerHTML = `
    <section class="surface">
      <div class="block">
        <div class="block-head"><h2>Battery</h2><span class="tag" id="e-bat-tag"></span></div>
        <div class="big" id="e-soc">—</div>
        <div class="meter" id="e-soc-m"><i></i></div>
        <div class="spark" style="margin-top:10px"><canvas id="e-soc-spark" aria-label="Battery charge history"></canvas><div class="spark-readout"></div></div>
      </div>
      <div class="block rows">
        <div class="row"><span>Voltage</span><span id="e-v">—</span></div>
        <div class="row"><span>Current</span><span id="e-i">—</span></div>
        <div class="row"><span>Temperature</span><span id="e-t">—</span></div>
        <div class="row"><span>Heater</span><span id="e-heat">—</span></div>
        <div class="row"><span>Capacity health</span><span id="e-health">—</span></div>
        <div class="row"><span>Charge cycles</span><span id="e-cyc">—</span></div>
      </div>
    </section>

    <section class="surface">
      <div class="block">
        <div class="block-head"><h2>Power budget</h2><button class="explain" data-explain="power" aria-label="About the power budget">?</button></div>
        <div class="rows">
          <div class="row"><span>Power mode</span><span id="e-mode">—</span></div>
          <div class="row"><span>Solar input</span><span id="e-solar" style="color:var(--sun)">—</span></div>
          <div class="row"><span>Bus load</span><span id="e-load">—</span></div>
          <div class="row"><span><b>Net</b></span><span id="e-net">—</span></div>
          <div class="row"><span>Outlook</span><span id="e-eta">—</span></div>
        </div>
      </div>
      <div class="block">
        <div class="block-head"><h3>Where the power goes</h3></div>
        <div class="rows" id="e-loads"></div>
      </div>
      <div class="block">
        <div class="block-head"><h3>Solar wings</h3></div>
        <div class="rows">
          <div class="row"><span>Sun angle off the cells</span><span id="e-inc">—</span></div>
          <div class="row"><span>Wing A (port)</span><span id="e-wa">—</span></div>
          <div class="row"><span>Wing B (starboard)</span><span id="e-wb">—</span></div>
        </div>
        <div class="spark" style="margin-top:8px"><canvas id="e-solar-spark" aria-label="Solar input history"></canvas><div class="spark-readout"></div></div>
      </div>
    </section>

    <section class="surface">
      <div class="block">
        <div class="block-head"><h2>Propulsion</h2><button class="explain" data-explain="prop" aria-label="About propellant and delta-v">?</button></div>
        <div class="big" id="e-dv">—</div>
        <p class="block-note" id="e-dv-sub">—</p>
        <div class="meter" id="e-fuel-m"><i></i></div>
      </div>
      <div class="block rows">
        <div class="row"><span>Propellant</span><span id="e-fuel">—</span></div>
        <div class="row"><span>Tank pressure</span><span id="e-press">—</span></div>
        <div class="row"><span>Nozzle temperature</span><span id="e-noz">—</span></div>
        <div class="row"><span>Burns so far</span><span id="e-burns">—</span></div>
        <div class="row"><span>Δv used</span><span id="e-used">—</span></div>
        <div class="row"><span>Mass</span><span id="e-mass">—</span></div>
        <div class="row"><span>Armed burn</span><span id="e-armed">—</span></div>
      </div>
    </section>

    <section class="surface calc">
      <div class="block">
        <div class="block-head"><h2>Manoeuvre calculator</h2><button class="explain" data-explain="calc" aria-label="About the calculator">?</button></div>
        <label>Raise the orbit by <output id="c-raise-o">1.0 km</output>
          <input type="range" id="c-raise" min="0.1" max="20" step="0.1" value="1"></label>
        <div class="rows">
          <div class="row"><span>Δv (two burns)</span><span id="c-raise-dv">—</span></div>
          <div class="row"><span>Propellant</span><span id="c-raise-g">—</span></div>
          <div class="row"><span>Affordable now</span><span id="c-raise-ok">—</span></div>
        </div>
      </div>
      <div class="block">
        <label>Dodge with a prograde burn of <output id="c-dodge-o">0.10 m/s</output>
          <input type="range" id="c-dodge" min="0.01" max="1" step="0.01" value="0.1"></label>
        <label>made <output id="c-lead-o">47 min</output> before closest approach
          <input type="range" id="c-lead" min="2" max="180" step="1" value="47"></label>
        <div class="rows">
          <div class="row"><span>Moves the satellite up by</span><span id="c-up">—</span></div>
          <div class="row"><span>and back along its orbit by</span><span id="c-back">—</span></div>
          <div class="row"><span>Propellant</span><span id="c-dodge-g">—</span></div>
        </div>
      </div>
    </section>`;

    let interval;

    function calc() {
        const st = app.sat.getFullState();
        const alt = st.orbit.baseAltitude;
        const raise = +el.querySelector('#c-raise').value;
        const dv = hohmannDeltaV(alt, alt + raise);
        const g = tsiolkovskyFuel(dv, st.physics.wetMassKg, st.physics.isp_s) * 1000;
        setText(el, '#c-raise-o', `${raise.toFixed(1)} km`);
        setText(el, '#c-raise-dv', `${dv.toFixed(3)} m/s`);
        setText(el, '#c-raise-g', `${g.toFixed(2)} g`);
        const usable = st.physics.maxDeltaV_ms - st.physics.reserveDeltaV_ms;
        setText(el, '#c-raise-ok', dv <= usable ? 'Yes' : `No, ${Math.max(0, usable).toFixed(2)} m/s usable`);

        const ddv = +el.querySelector('#c-dodge').value;
        const lead = +el.querySelector('#c-lead').value * 60;
        const n = meanMotion(alt);
        const up = (2 * ddv / n) * (1 - Math.cos(n * lead));
        const back = Math.abs((ddv / n) * (4 * Math.sin(n * lead) - 3 * n * lead));
        setText(el, '#c-dodge-o', `${ddv.toFixed(2)} m/s`);
        setText(el, '#c-lead-o', `${(lead / 60).toFixed(0)} min${Math.abs(lead / 60 - st.orbit.period / 2) < 2 ? ' (half an orbit)' : ''}`);
        setText(el, '#c-up', up >= 1000 ? `${(up / 1000).toFixed(2)} km` : `${up.toFixed(0)} m`);
        setText(el, '#c-back', back >= 1000 ? `${(back / 1000).toFixed(1)} km` : `${back.toFixed(0)} m`);
        setText(el, '#c-dodge-g', `${(tsiolkovskyFuel(ddv, st.physics.wetMassKg, st.physics.isp_s) * 1000).toFixed(2)} g`);
    }

    function update() {
        const st = app.sat.getFullState();
        const s = st.sections, bat = s.batteryBay, tp = s.thrusterPod;
        const tag = el.querySelector('#e-bat-tag');
        tag.dataset.status = bat.status; tag.textContent = fmt.level[bat.status];
        setText(el, '#e-soc', `${bat.charge.toFixed(1)}%`);
        const m = el.querySelector('#e-soc-m');
        m.firstElementChild.style.width = `${bat.charge}%`;
        m.dataset.status = bat.charge < 15 ? 'critical' : bat.charge < 30 ? 'warning' : '';
        setText(el, '#e-v', `${bat.voltage.toFixed(2)} V`);
        setText(el, '#e-i', `${Math.abs(bat.currentDraw).toFixed(2)} A ${bat.currentDraw < -0.01 ? 'charging' : bat.currentDraw > 0.01 ? 'discharging' : ''}`);
        setText(el, '#e-t', `${bat.temperature.toFixed(1)} °C${bat.chargeInhibited ? ' (too cold to charge)' : ''}`);
        setText(el, '#e-heat', bat.heaterOn ? 'On' : 'Off');
        setText(el, '#e-health', `${bat.healthPercent.toFixed(1)}%`);
        setText(el, '#e-cyc', `${bat.cycleCount}`);

        const loads = st.power.loads || { total: 0 };
        const net = st.power.solarW * 0.95 - loads.total;
        setText(el, '#e-mode', label(st.powerMode));
        setText(el, '#e-solar', `${st.power.solarW.toFixed(2)} W`);
        setText(el, '#e-load', `${loads.total.toFixed(2)} W`);
        const ne = setText(el, '#e-net', `${net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(2)} W`);
        ne.style.color = net >= 0 ? 'var(--good)' : 'var(--caution)';
        const usable = bat.capacityWh * bat.healthPercent / 100;
        setText(el, '#e-eta', net > 0.05 && bat.charge < 99.5 ? `Full in ${fmt.dur(((100 - bat.charge) / 100 * usable) / (net * 0.95) * 3600)}`
            : net < -0.05 ? `Empty in ${fmt.dur((bat.charge / 100 * usable) / -net * 3600)} at this rate` : 'Balanced');
        el.querySelector('#e-loads').innerHTML = Object.entries(LOAD_NAMES)
            .filter(([k]) => loads[k] > 0.005)
            .map(([k, n]) => `<div class="row"><span>${esc(n)}</span><span>${loads[k].toFixed(2)} W</span></div>`).join('');
        setText(el, '#e-inc', st.environment.inSunlight ? `${st.attitude.sunIncidenceDeg.toFixed(0)}°` : 'In shadow');
        setText(el, '#e-wa', `${s.solarPanelA.powerOutput.toFixed(2)} W, ${(s.solarPanelA.efficiency * 100).toFixed(0)}% of new`);
        setText(el, '#e-wb', `${s.solarPanelB.powerOutput.toFixed(2)} W, ${(s.solarPanelB.efficiency * 100).toFixed(0)}% of new`);

        const ph = st.physics;
        setText(el, '#e-dv', `${ph.maxDeltaV_ms.toFixed(2)} m/s`);
        setText(el, '#e-dv-sub', `of Δv left, ${ph.reserveDeltaV_ms} m/s held in reserve, ${Math.max(0, ph.maxDeltaV_ms - ph.reserveDeltaV_ms).toFixed(2)} m/s usable`);
        const fm = el.querySelector('#e-fuel-m');
        fm.firstElementChild.style.width = `${tp.fuelPercent}%`;
        fm.dataset.status = ph.maxDeltaV_ms < ph.reserveDeltaV_ms ? 'critical' : tp.fuelPercent < 20 ? 'warning' : '';
        setText(el, '#e-fuel', `${tp.fuelMass.toFixed(2)} g of ${tp.fuelCapacity} g`);
        setText(el, '#e-press', `${tp.pressure.toFixed(2)} MPa`);
        setText(el, '#e-noz', `${tp.nozzleTemp.toFixed(0)} °C${tp.isThrusting ? ', firing' : ''}`);
        setText(el, '#e-burns', `${tp.totalBurns}`);
        setText(el, '#e-used', `${app.sat.propulsion.totalDeltaVUsed.toFixed(3)} m/s`);
        setText(el, '#e-mass', `${ph.wetMassKg.toFixed(3)} kg (dry ${ph.dryMassKg} kg)`);
        const pb = st.flight.pendingBurn;
        setText(el, '#e-armed', pb ? `${pb.deltaV.toFixed(3)} m/s, ${(pb.delivered / pb.deltaV * 100).toFixed(0)}% delivered` : 'None');

        const hist = st.history.slice(-240);
        drawSparkline(el.querySelector('#e-soc-spark'), hist.map(h => ({ t: h.t, v: h.soc })), { min: 0, max: 100, format: v => `${v.toFixed(0)}%` });
        drawSparkline(el.querySelector('#e-solar-spark'), hist.map(h => ({ t: h.t, v: h.solarW })), { min: 0, color: getComputedStyle(document.documentElement).getPropertyValue('--sun'), format: v => `${v.toFixed(1)} W` });
        calc();
    }

    return {
        element: el,
        init() {
            bindExplainers(el, EXPLAIN);
            el.querySelectorAll('input[type=range]').forEach(i => i.addEventListener('input', calc));
            const half = Math.round(app.sat.orbit.period / 2);
            el.querySelector('#c-lead').value = half;
            update();
            interval = setInterval(update, 1000);
        },
        destroy() { clearInterval(interval); },
    };
}
