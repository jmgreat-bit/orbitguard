// Satellite — the CubeSat in its real attitude over the real Earth, plus a subsystem inspector.
import { app } from '../app.js';
import { Satellite3D } from '../webgl/Satellite3D.js';
import { THERMAL_LIMITS } from '../sim/thermal.js';
import { esc, fmt, setText, label, thermalColor } from '../ui/dom.js';
import { bindExplainers } from '../ui/modal.js';

const EXPLAIN = {
    model: {
        title: 'The 3D model',
        html: `<p>Built to the 1U CubeSat envelope (10 × 10 × 11.35 cm on four rails) with two deployable solar wings, four UHF tape-measure antennas, an Earth camera and a cold-gas nozzle.</p>
        <p>You are looking from the satellite's local frame: up is away from Earth and the blue Earth below is the actual ground under the satellite at this moment. Light comes from the Sun's true direction and goes out in eclipse. The yellow arrow points to the Sun, cyan along the direction of flight, blue down to Earth.</p>
        <p><strong>Thermal</strong> colours each part by its temperature against that part's limits: blue cold, grey comfortable, red hot. <strong>X-ray</strong> shows the battery, computer boards, propellant tank and camera inside.</p>
        <p>To use a real model, drop a <code>.glb</code> or <code>.gltf</code> file onto the view (NASA publishes free spacecraft models at <code>science.nasa.gov/3d-resources</code>).</p>`,
    },
    heat: {
        title: 'Heat balance',
        html: `<p>Each part is a thermal node: <code>C·dT/dt = heat in − heat out</code>. External surfaces absorb sunlight, infrared from Earth and reflected sunlight (albedo), and radiate to deep space as <code>εσAT⁴</code>. Electronics turn their electrical power into heat and conduct it into the structure.</p>
        <p>Turning to <strong>sun-avoid</strong> points the white radiator face at the Sun and puts the wings edge-on, which cools the spacecraft but stops charging.</p>`,
    },
};

const FIELD_LABELS = {
    temperature: ['Temperature', v => `${v.toFixed(1)} °C`],
    charge: ['Charge', v => `${v.toFixed(1)}%`], voltage: ['Voltage', v => `${v.toFixed(2)} V`],
    currentDraw: ['Current (+ discharging)', v => `${v.toFixed(2)} A`], capacityWh: ['Capacity', v => `${v} Wh`],
    healthPercent: ['Capacity health', v => `${v.toFixed(1)}%`], cycleCount: ['Charge cycles', v => `${v}`],
    heaterOn: ['Heater', v => (v ? 'On' : 'Off')], chargeInhibited: ['Charging blocked (cold)', v => (v ? 'Yes' : 'No')],
    efficiency: ['Output vs new', v => `${(v * 100).toFixed(0)}%`], angle: ['Sun angle off the cells', v => `${v}°`],
    powerOutput: ['Power', v => `${v.toFixed(2)} W`], deployed: ['Deployed', v => (v ? 'Yes' : 'No')],
    fuelMass: ['Propellant', v => `${v.toFixed(1)} g`], fuelPercent: ['Tank', v => `${v.toFixed(0)}%`],
    pressure: ['Tank pressure', v => `${v.toFixed(2)} MPa`], nozzleTemp: ['Nozzle', v => `${v.toFixed(0)} °C`],
    totalBurns: ['Burns', v => `${v}`], isThrusting: ['Firing', v => (v ? 'Yes' : 'No')], thrustN: ['Thrust', v => `${v} N`],
    frequency: ['Frequency', v => `${v.toFixed(1)} MHz`], txPower: ['Transmit power', v => `${v.toFixed(1)} W`],
    linkStatus: ['Link', v => v], station: ['Ground station', v => v || 'None in view'], dataRate: ['Data rate', v => `${v} bit/s`],
    antennaOk: ['Radio', v => (v ? 'Working' : 'Locked up')], elevationDeg: ['Nearest station elevation', v => `${v.toFixed(1)}°`],
    state: ['State', v => label(v)], powerDraw: ['Power draw', v => `${v.toFixed(2)} W`], imaging: ['Imaging now', v => (v ? 'Yes' : 'No')],
    emissivity: ['Emissivity', v => v.toFixed(2)], heatRejection: ['Radiating to space', v => `${v.toFixed(1)} W`], heatStrapOk: ['Heat strap', v => (v ? 'OK' : 'Failed')],
    cpuLoad: ['CPU', v => `${v.toFixed(0)}%`], memoryUsed: ['Memory', v => `${v.toFixed(0)}%`], uptimeHours: ['Uptime', v => fmt.dur(v * 3600)],
    errorCount: ['Corrected upsets', v => `${v}`], throttled: ['Throttled', v => (v ? 'Yes' : 'No')],
};

export function createShipView() {
    const el = document.createElement('div');
    el.className = 'view split';
    el.innerHTML = `
    <section class="stage" id="ship-stage" aria-label="CubeSat 3D model">
      <div class="stage-tools">
        <div class="seg" role="group" aria-label="Colouring">
          <button class="btn" data-mode="normal" aria-pressed="true">As built</button>
          <button class="btn" data-mode="thermal" aria-pressed="false">Thermal</button>
        </div>
        <button class="btn" id="opt-xray" aria-pressed="false">X-ray</button>
        <button class="btn" id="opt-vec" aria-pressed="true">Vectors</button>
        <label class="btn" for="glb-file">Load model…</label>
        <input type="file" id="glb-file" accept=".glb,.gltf" hidden>
        <button class="btn" id="glb-reset" hidden>Back to CubeSat</button>
        <button class="explain" data-explain="model" aria-label="About this view">?</button>
      </div>
      <p class="stage-hint" id="stage-hint">Drag to look around, scroll to zoom, click a part to inspect it. Drop a .glb file here to fly your own model.</p>
      <div class="stage-legend" id="stage-legend">
        <span><i class="legend-line" style="background:var(--sun)"></i>To the Sun</span>
        <span><i class="legend-line" style="background:var(--accent)"></i>Direction of flight</span>
        <span><i class="legend-line" style="background:var(--cold)"></i>Down to Earth</span>
      </div>
      <div class="stage-legend" id="thermal-legend" hidden>
        <div class="scale-bar"></div>
        <div class="scale-ends"><span>Cold limit</span><span>Comfortable</span><span>Hot limit</span></div>
      </div>
    </section>
    <aside class="side">
      <section class="block">
        <div class="block-head"><h2 class="inspect-title" id="insp-title">Satellite</h2><span class="tag" id="insp-status"></span></div>
        <div class="rows" id="insp-rows"><p class="empty">Click a part of the model or a subsystem below.</p></div>
      </section>
      <section class="block">
        <div class="block-head"><h3>Temperatures</h3><span class="block-note">Green band: comfortable range</span></div>
        <div class="temp-list" id="temps"></div>
      </section>
      <section class="block">
        <div class="block-head"><h3>Heat balance</h3><button class="explain" data-explain="heat" aria-label="About the heat balance">?</button></div>
        <div class="rows">
          <div class="row"><span>Electrical power turned into heat</span><span id="hb-elec">—</span></div>
          <div class="row"><span>Sunlight heating the wings</span><span id="hb-sun">—</span></div>
          <div class="row"><span>Radiated to space by the structure</span><span id="hb-rad">—</span></div>
          <div class="row"><span>Attitude</span><span id="hb-att">—</span></div>
        </div>
      </section>
    </aside>`;

    let interval, view, selected = null;

    const colors = (s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, thermalColor(v.temperature, THERMAL_LIMITS[k])]));

    function inspect(key) {
        selected = key;
        renderInspector(app.sat.getFullState());
        el.querySelectorAll('.temp-item').forEach(b => b.setAttribute('aria-current', String(b.dataset.key === key)));
    }

    function renderInspector(st) {
        if (!selected) return;
        const sec = st.sections[selected];
        setText(el, '#insp-title', sec.name);
        const tag = el.querySelector('#insp-status');
        tag.dataset.status = sec.status;
        tag.textContent = fmt.level[sec.status] || sec.status;
        el.querySelector('#insp-rows').innerHTML = Object.entries(sec)
            .filter(([k, v]) => FIELD_LABELS[k] && (v !== undefined && v !== null || k === 'station'))
            .map(([k, v]) => `<div class="row"><span>${esc(FIELD_LABELS[k][0])}</span><span>${esc(FIELD_LABELS[k][1](v))}</span></div>`).join('');
    }

    function update() {
        const st = app.sat.getFullState();
        const s = st.sections;
        const col = colors(s);
        view?.update(st, col);

        const list = el.querySelector('#temps');
        if (!list.childElementCount) {
            list.innerHTML = Object.entries(s).map(([k, sec]) => `<button class="temp-item" data-key="${k}" aria-current="false">
              <span class="temp-name"><span class="tag"></span>${esc(sec.name)}</span>
              <span class="temp-val"></span>
              <span class="temp-track" aria-hidden="true"><i class="ok"></i><i class="now"></i></span>
            </button>`).join('');
            list.querySelectorAll('.temp-item').forEach(b => b.addEventListener('click', () => inspect(b.dataset.key)));
        }
        for (const b of list.children) {
            const k = b.dataset.key, sec = s[k], L = THERMAL_LIMITS[k];
            const pos = (v) => Math.max(0, Math.min(100, ((v - L.critLo) / (L.critHi - L.critLo)) * 100));
            b.querySelector('.tag').dataset.status = sec.status;
            b.querySelector('.temp-val').textContent = `${sec.temperature.toFixed(1)} °C`;
            const ok = b.querySelector('.ok');
            ok.style.left = `${pos(L.warnLo)}%`; ok.style.right = `${100 - pos(L.warnHi)}%`;
            const now = b.querySelector('.now');
            now.dataset.status = sec.status; now.style.left = `${pos(sec.temperature)}%`;
            b.title = `${sec.name}: ${fmt.level[sec.status]}. Comfortable ${L.warnLo} to ${L.warnHi} °C, limits ${L.critLo} to ${L.critHi} °C.`;
        }

        const loads = st.power.loads;
        setText(el, '#hb-elec', loads ? `${loads.total.toFixed(2)} W` : '—');
        setText(el, '#hb-sun', st.environment.inSunlight ? `${(st.power.solarW / 0.29 * 0.91 - st.power.solarW).toFixed(1)} W` : 'None (eclipse)');
        setText(el, '#hb-rad', `${s.thermalRadiator.heatRejection.toFixed(1)} W`);
        setText(el, '#hb-att', label(st.attitude.mode));
        renderInspector(st);
    }

    return {
        element: el,
        init() {
            view = new Satellite3D(el.querySelector('#ship-stage'), { onPick: inspect });
            el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
                const thermal = b.dataset.mode === 'thermal';
                el.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
                view.setOption('thermal', thermal, colors(app.sat.sections));
                el.querySelector('#thermal-legend').hidden = !thermal;
                el.querySelector('#stage-legend').hidden = thermal;
            }));
            const toggle = (id, key) => {
                const b = el.querySelector(id);
                b.addEventListener('click', () => {
                    const on = b.getAttribute('aria-pressed') !== 'true';
                    b.setAttribute('aria-pressed', String(on));
                    view.setOption(key, on, colors(app.sat.sections));
                });
            };
            toggle('#opt-xray', 'xray');
            toggle('#opt-vec', 'vectors');
            const file = el.querySelector('#glb-file');
            const hint = el.querySelector('#stage-hint');
            const reset = el.querySelector('#glb-reset');
            const load = async (f) => {
                try { hint.textContent = await view.loadModelFile(f); reset.hidden = false; }
                catch (e) { hint.textContent = `Could not load that model: ${e.message}`; }
            };
            file.addEventListener('change', () => file.files[0] && load(file.files[0]));
            el.querySelector('#ship-stage').addEventListener('drop', () => { reset.hidden = false; });
            reset.addEventListener('click', () => { view.resetModel(); reset.hidden = true; hint.textContent = 'Back to the procedural CubeSat.'; });
            bindExplainers(el, EXPLAIN);
            update();
            inspect('batteryBay');
            interval = setInterval(update, 500);
        },
        destroy() {
            clearInterval(interval);
            view?.destroy();
        },
    };
}
