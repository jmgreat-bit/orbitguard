import { Satellite3D } from '../webgl/Satellite3D.js';

export function createShipView(satellite) {
  const el = document.createElement('div');
  el.className = 'view view-ship';
  el.innerHTML = `
    <div class="ship-layout">
      <div class="ship-schematic-wrap" id="ship-3d-wrap" style="position:relative; width:100%; min-height:400px; display:flex; align-items:center; justify-content:center;">
        <!-- 3D Canvas injected here -->
      </div>

      <!-- Section Inspector -->
      <div class="section-inspector">
        <div class="inspector-title" id="insp-title">SELECT A SECTION</div>
        <div class="inspector-status" id="insp-status"></div>
        <div class="inspector-grid" id="insp-grid">
          <div class="insp-hint">Click any section on the schematic to inspect its data</div>
        </div>

        <!-- All sections summary -->
        <div class="sections-summary" id="sections-summary"></div>

        <!-- Thermodynamic & Power Equilibrium (New Math Feature) -->
        <div class="eng-card bplane-card" id="card-therm" style="margin-top:20px;">
          <div class="eng-card-header">
            <span>THERMODYNAMIC EQUILIBRIUM</span>
            <div class="card-btn-group">
              <button class="btn-icon" id="btn-info-therm" title="What is this?">?</button>
              <button class="btn-icon" id="btn-exp-therm" title="Expand View">↗</button>
            </div>
          </div>
          <div class="eng-details" style="margin-top:10px;">
            <div style="font-size:11px; color:var(--text-dim); margin-bottom:8px; letter-spacing:1px;">HEAT BALANCE (Q_in - Q_out)</div>
            <div class="ed-row"><span>Internal Heat Gen.</span><span id="sh-heat-in">—</span></div>
            <div class="ed-row"><span>Radiator Rejection</span><span id="sh-heat-out">—</span></div>
            <div class="ed-row" style="border-top:1px solid rgba(0,255,255,0.15);padding-top:4px;margin-top:4px">
              <span>Net Thermal Load</span>
              <span id="sh-heat-net" style="font-weight:700">—</span>
            </div>
            <div class="ed-row" style="margin-top:8px">
              <span style="color:var(--text-dim)">Est. Time to Runaway</span>
              <span id="sh-heat-time" style="color:var(--amber)">—</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  let interval = null;

  return {
    element: el,
    init() {
      const container = el.querySelector('#ship-3d-wrap');
      this.sat3D = new Satellite3D(
        container,
        null, // onHover
        (key) => { this.inspect(key); }
      );

      interval = setInterval(() => this.update(), 1000);
      this.update();

      // Modal Hooks
      import('../main.js').then(({ showModal }) => {
        const thermInfo = `
          <p><strong>Thermodynamic Heat Balance</strong></p>
          <p>This model calculates the net thermal load acting on the satellite's core subsystems.</p>
          <p>The equation used is: <span class="math-highlight">Q<sub>net</sub> = Q<sub>in</sub> - Q<sub>out</sub></span></p>
          <ul>
            <li><strong>Internal Heat Gen (Q<sub>in</sub>):</strong> Waste heat produced by active components, specifically the Onboard Computer (CPU load) and the Battery block ($I^2R$ losses).</li>
            <li><strong>Radiator Rejection (Q<sub>out</sub>):</strong> The rate at which the Thermal Radiator array bleeds heat into the vacuum of space (dependent on active coolant pumps).</li>
          </ul>
          <p>If <span class="math-highlight">Q<sub>net</sub> > 0</span>, the core temperature rises. The <em>Est. Time to Runaway</em> projects when the CPU will hit its critical shutdown threshold of 85°C, resulting in total satellite bricking.</p>
        `;

        document.getElementById('btn-info-therm')?.addEventListener('click', () => {
          showModal('THERMODYNAMIC EQUILIBRIUM', thermInfo, false);
        });

        document.getElementById('btn-exp-therm')?.addEventListener('click', () => {
          const cardHtml = document.getElementById('card-therm').innerHTML;
          showModal('THERMODYNAMIC EQUILIBRIUM', `<div class="expanded-card-view">${cardHtml}</div>`, true);
        });
      });
    },
    inspect(key) {
      const state = satellite.getFullState();
      const section = state.sections[key];
      if (!section) return;

      setText('insp-title', section.name);

      const statusEl = document.getElementById('insp-status');
      if (statusEl) {
        statusEl.textContent = section.status.toUpperCase();
        statusEl.className = 'inspector-status status-' + section.status;
      }

      const grid = document.getElementById('insp-grid');
      if (!grid) return;
      grid.innerHTML = '';

      for (const [k, v] of Object.entries(section)) {
        if (k === 'name') continue;
        const row = document.createElement('div');
        row.className = 'insp-row';

        const label = k.replace(/([A-Z])/g, ' $1').toUpperCase();
        let display;
        if (typeof v === 'number') display = v % 1 === 0 ? String(v) : v.toFixed(2);
        else if (typeof v === 'boolean') display = v ? '✓ ACTIVE' : '✗ OFF';
        else if (v === null) display = '—';
        else display = String(v);

        const isWarning = (k === 'temperature' && (v > 60 || v < -10)) ||
          (k === 'charge' && v < 25) ||
          (k === 'fuelPercent' && v < 20) ||
          (k === 'pressure' && v < 0.5);

        row.innerHTML = `
          <span class="insp-label">${label}</span>
          <span class="insp-val ${isWarning ? 'val-warn' : ''}">${display}</span>
        `;
        grid.appendChild(row);
      }
    },
    update() {
      const state = satellite.getFullState();

      // Update 3D Model
      if (this.sat3D) {
        this.sat3D.update(state.sections);
      }

      // Summary table
      const summary = document.getElementById('sections-summary');
      if (summary) {
        summary.innerHTML = Object.entries(state.sections).map(([key, s]) => {
          const statusColor = s.status === 'critical' ? 'var(--red)' : s.status === 'warning' ? 'var(--amber)' : 'var(--green)';
          return `<div class="sum-row">
            <span class="sum-dot" style="background:${statusColor}"></span>
            <span class="sum-name">${s.name}</span>
            <span class="sum-temp">${s.temperature.toFixed(0)}°C</span>
          </div>`;
        }).join('');
      }

      // Thermodynamic Equilibrium Math
      // Rough estimation of heat generation based on active components
      const obc = state.sections.onboardComputer;
      const bat = state.sections.batteryBay;
      const rad = state.sections.thermalRadiator;

      // Heat generated = (CPU load * some factor) + (Battery current * voltage * inefficiency)
      const heatIn = (obc.cpuLoad * 0.15) + (bat.currentDraw * bat.voltage * 0.2);
      // Heat out = radiator rejection
      const heatOut = rad.heatRejection * (rad.pumpActive ? 1 : 0.1);
      const netHeat = heatIn - heatOut;

      setText('sh-heat-in', `+ ${heatIn.toFixed(1)} W`);
      setText('sh-heat-out', `- ${heatOut.toFixed(1)} W`);

      const netEl = document.getElementById('sh-heat-net');
      if (netEl) {
        netEl.textContent = `${netHeat > 0 ? '+' : ''}${netHeat.toFixed(1)} W`;
        netEl.style.color = netHeat > 0 ? 'var(--red)' : 'var(--cyan)';
      }

      const timeEl = document.getElementById('sh-heat-time');
      if (timeEl) {
        if (netHeat <= 0) {
          timeEl.textContent = 'STABLE';
          timeEl.style.color = 'var(--cyan)';
        } else {
          // Assume ~1000 Joules/K thermal mass for the core
          // Time to hit 85C (critical) from current temp
          const tempToCrit = 85 - obc.temperature;
          if (tempToCrit <= 0) {
            timeEl.textContent = 'CRITICAL RUNAWAY';
            timeEl.style.color = 'var(--red)';
          } else {
            const secondsToCrit = (1000 * tempToCrit) / netHeat;
            timeEl.textContent = `${(secondsToCrit / 60).toFixed(1)} MIN`;
            timeEl.style.color = 'var(--amber)';
          }
        }
      }
    },
    destroy() {
      if (interval) clearInterval(interval);
      if (this.sat3D) this.sat3D.destroy();
    }
  };
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
