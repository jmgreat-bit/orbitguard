// ENGINE & POWER VIEW — Battery, fuel, solar, power budget
import { tsiolkovskyFuel, orbitalVelocity, maxDeltaV } from '../physics.js';

export function createEngineView(satellite) {
  const el = document.createElement('div');
  el.className = 'view view-engine';
  el.innerHTML = `
    <div class="engine-grid">
      <!-- Battery Section -->
      <div class="eng-card">
        <div class="eng-card-header">BATTERY SYSTEM</div>
        <div class="eng-big-value" id="e-bat-charge">73%</div>
        <div class="eng-bar-wrap"><div class="eng-bar" id="e-bat-bar"></div></div>
        <div class="eng-details">
          <div class="ed-row"><span>Voltage</span><span id="e-bat-volt">7.4V</span></div>
          <div class="ed-row"><span>Current Draw</span><span id="e-bat-current">0.68A</span></div>
          <div class="ed-row"><span>Capacity</span><span id="e-bat-cap">60 Wh</span></div>
          <div class="ed-row"><span>Health</span><span id="e-bat-health">96%</span></div>
          <div class="ed-row"><span>Charge Cycles</span><span id="e-bat-cycles">342</span></div>
          <div class="ed-row"><span>Temperature</span><span id="e-bat-temp">25°C</span></div>
        </div>
      </div>

      <!-- Fuel / Thruster Section -->
      <div class="eng-card">
        <div class="eng-card-header">PROPULSION</div>
        <div class="eng-big-value" id="e-fuel-pct">92%</div>
        <div class="eng-bar-wrap"><div class="eng-bar eng-bar-fuel" id="e-fuel-bar"></div></div>
        <div class="eng-details">
          <div class="ed-row"><span>Fuel Mass</span><span id="e-fuel-mass">230g</span></div>
          <div class="ed-row"><span>Tank Pressure</span><span id="e-fuel-press">2.1 MPa</span></div>
          <div class="ed-row"><span>Nozzle Temp</span><span id="e-noz-temp">18°C</span></div>
          <div class="ed-row"><span>Total Burns</span><span id="e-burns">3</span></div>
          <div class="ed-row"><span>Last Fired</span><span id="e-last-fire">—</span></div>
          <div class="ed-row"><span>Isp</span><span id="e-isp">60 s</span></div>
        </div>
      </div>

      <!-- Maneuver Planner (New Math Feature) -->
      <div class="eng-card maneuver-card" id="card-maneuver">
        <div class="eng-card-header">
          <span>ORBITAL MANEUVER PLANNER</span>
          <div class="card-btn-group">
            <button class="btn-icon" id="btn-info-maneuver" title="What is this?">?</button>
            <button class="btn-icon" id="btn-exp-maneuver" title="Expand View">↗</button>
          </div>
        </div>
        <div class="eng-details" style="margin-top: 8px;">
          <div class="ed-row">
            <span style="color:var(--text-dim)">Available Δv</span>
            <span id="e-deltav-avail" style="color:var(--cyan);font-weight:700;font-size:16px">—</span>
          </div>
          <div class="ed-row">
            <span style="color:var(--text-dim)">Est. Evasion Burns Remaining</span>
            <span id="e-dodges" style="color:#fff">—</span>
          </div>
          <div style="margin-top:12px; padding-top:12px; border-top:1px solid rgba(0,204,255,0.15)">
            <div style="font-size:11px; color:var(--text-dim); margin-bottom:8px; letter-spacing:1px;">HYPOTHETICAL 1KM REBOOST</div>
            <div class="ed-row">
              <span>Required Δv (Hohmann)</span>
              <span id="e-req-dv">—</span>
            </div>
            <div class="ed-row">
              <span>Propellant Required</span>
              <span id="e-req-prop" style="color:var(--amber)">—</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Solar Panels -->
      <div class="eng-card">
        <div class="eng-card-header">SOLAR PANELS</div>
        <div class="solar-dual">
          <div class="solar-panel-card">
            <div class="sp-name">PANEL A (Port)</div>
            <div class="sp-output" id="e-sol-a-out">5.0W</div>
            <div class="eng-details">
              <div class="ed-row"><span>Efficiency</span><span id="e-sol-a-eff">92%</span></div>
              <div class="ed-row"><span>Angle</span><span id="e-sol-a-ang">0°</span></div>
              <div class="ed-row"><span>Temp</span><span id="e-sol-a-temp">35°C</span></div>
              <div class="ed-row"><span>Deployed</span><span id="e-sol-a-dep">✓ YES</span></div>
            </div>
          </div>
          <div class="solar-panel-card">
            <div class="sp-name">PANEL B (Stbd)</div>
            <div class="sp-output" id="e-sol-b-out">5.0W</div>
            <div class="eng-details">
              <div class="ed-row"><span>Efficiency</span><span id="e-sol-b-eff">94%</span></div>
              <div class="ed-row"><span>Angle</span><span id="e-sol-b-ang">0°</span></div>
              <div class="ed-row"><span>Temp</span><span id="e-sol-b-temp">35°C</span></div>
              <div class="ed-row"><span>Deployed</span><span id="e-sol-b-dep">✓ YES</span></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Power Budget -->
      <div class="eng-card">
        <div class="eng-card-header">POWER BUDGET</div>
        <div class="power-budget">
          <div class="pb-row pb-gen">
            <span>Generation</span>
            <span id="e-power-gen">+10.0W</span>
          </div>
          <div class="pb-row pb-draw">
            <span>Consumption</span>
            <span id="e-power-draw">-5.2W</span>
          </div>
          <div class="pb-row pb-net">
            <span>Net Balance</span>
            <span id="e-power-net">+4.8W</span>
          </div>
          <div class="pb-estimate" id="e-time-est">Est. full charge in 3.2 hrs</div>
        </div>
      </div>
    </div>
  `;

  let interval = null;

  return {
    element: el,
    init() {
      interval = setInterval(() => this.update(), 1000);
      this.update();

      // Modal Hooks
      import('../main.js').then(({ showModal }) => {
        const maneuverInfo = `
          <p><strong>Orbital Maneuver Planner (Propulsion)</strong></p>
          <p>This module evaluates the satellite's capability to alter its orbit using the onboard cold-gas thrusters.</p>
          <p><strong>1. Available $\\Delta v$</strong><br>
          Calculated using the <span class="math-highlight">Tsiolkovsky Rocket Equation</span>: $\\Delta v = I_{sp} g_0 \\ln(m_0/m_f)$<br>
          This is the total velocity change the ship can perform before running completely out of propellant.</p>
          <p><strong>2. Hypothetical 1km Reboost (Hohmann Transfer)</strong><br>
          Computes the theoretical $\\Delta v$ required to raise the orbital altitude by 1 kilometer using two impulsive burns. It then reverses the Tsiolkovsky equation to determine the exact <span class="math-highlight">propellant mass fraction</span> that would be consumed by this maneuver.
          </p>
        `;

        document.getElementById('btn-info-maneuver')?.addEventListener('click', () => {
          showModal('ORBITAL MANEUVER PLANNER', maneuverInfo, false);
        });

        document.getElementById('btn-exp-maneuver')?.addEventListener('click', () => {
          const cardHtml = document.getElementById('card-maneuver').innerHTML;
          showModal('ORBITAL MANEUVER PLANNER', `<div class="expanded-card-view">${cardHtml}</div>`, true);
        });
      });
    },
    update() {
      const state = satellite.getFullState();
      const bat = state.sections.batteryBay;
      const thr = state.sections.thrusterPod;
      const solA = state.sections.solarPanelA;
      const solB = state.sections.solarPanelB;

      // Battery
      setText('e-bat-charge', `${Math.round(bat.charge)} % `);
      setBar('e-bat-bar', bat.charge);
      setText('e-bat-volt', `${bat.voltage.toFixed(1)}V`);
      setText('e-bat-current', `${bat.currentDraw.toFixed(2)}A`);
      setText('e-bat-cap', `${bat.capacityWh} Wh`);
      setText('e-bat-health', `${bat.healthPercent} % `);
      setText('e-bat-cycles', bat.cycleCount);
      setText('e-bat-temp', `${bat.temperature.toFixed(0)}°C`);

      // Fuel — now uses Tsiolkovsky stats from state.physics
      const phys = state.physics || {};
      setText('e-fuel-pct', `${Math.round(thr.fuelPercent)} % `);
      setBar('e-fuel-bar', thr.fuelPercent);
      setText('e-fuel-mass', `${thr.fuelMass.toFixed(0)}g`);
      setText('e-fuel-press', `${thr.pressure.toFixed(1)} MPa`);
      setText('e-noz-temp', `${thr.nozzleTemp.toFixed(0)}°C`);
      setText('e-burns', thr.totalBurns);
      setText('e-last-fire', thr.lastFired ? new Date(thr.lastFired).toLocaleTimeString() : '—');
      // Tsiolkovsky delta-V budget
      const massDry = phys.dryMassKg || 3.0;
      const massFuel = thr.fuelMass / 1000;
      const isp = phys.isp_s || 60;
      const availableDv = maxDeltaV(massFuel, massDry, isp);

      setText('e-deltav-avail', `${availableDv.toFixed(1)} m / s`);
      setText('e-dodges', `~${Math.floor(availableDv / 0.5)}`);
      setText('e-isp', `${isp} s`);

      // 1km Reboost calculation (Hohmann approximation for circular LEO)
      // dV = V_circ(r) - V_circ(r + 1km)
      const env = state.environment;
      const vCurrent = orbitalVelocity(env.altitude) * 1000; // m/s
      const vTarget = orbitalVelocity(env.altitude + 1) * 1000; // m/s
      // It takes two burns to raise orbit, total dV is roughly the difference in orbital velocities
      // (Actually slightly more complex, but absolute difference is a decent proxy for tiny LEO changes)
      const requiredDv = Math.abs(vCurrent - vTarget) * 2;

      const requiredFuelKg = tsiolkovskyFuel(requiredDv, massDry + massFuel, isp);

      setText('e-req-dv', `${requiredDv.toFixed(2)} m / s`);
      setText('e-req-prop', `${(requiredFuelKg * 1000).toFixed(1)} g`);
      // Solar
      setText('e-sol-a-out', `${solA.powerOutput.toFixed(1)}W`);
      setText('e-sol-a-eff', `${(solA.efficiency * 100).toFixed(0)}% `);
      setText('e-sol-a-ang', `${solA.angle}°`);
      setText('e-sol-a-temp', `${solA.temperature.toFixed(0)}°C`);
      setText('e-sol-a-dep', solA.deployed ? '✓ YES' : '✗ NO');

      setText('e-sol-b-out', `${solB.powerOutput.toFixed(1)}W`);
      setText('e-sol-b-eff', `${(solB.efficiency * 100).toFixed(0)}% `);
      setText('e-sol-b-ang', `${solB.angle}°`);
      setText('e-sol-b-temp', `${solB.temperature.toFixed(0)}°C`);
      setText('e-sol-b-dep', solB.deployed ? '✓ YES' : '✗ NO');

      // Power budget
      const totalGen = solA.powerOutput + solB.powerOutput;
      const totalDraw = bat.currentDraw * bat.voltage;
      const net = totalGen - totalDraw;

      setText('e-power-gen', `+ ${totalGen.toFixed(1)} W`);
      setText('e-power-draw', `- ${totalDraw.toFixed(1)} W`);
      const netEl = document.getElementById('e-power-net');
      if (netEl) {
        netEl.textContent = `${net > 0 ? '+' : ''}${net.toFixed(1)} W`;
        netEl.style.color = net > 0 ? 'var(--green)' : 'var(--red)';
      }

      // Time estimate
      if (net > 0) {
        const hoursToFull = ((100 - bat.charge) / 100 * bat.capacityWh) / net;
        setText('e-time-est', `Est.full charge in ${hoursToFull.toFixed(1)} hrs`);
      } else if (net < 0) {
        const hoursToDead = (bat.charge / 100 * bat.capacityWh) / Math.abs(net);
        setText('e-time-est', `⚠ Battery depleted in ${hoursToDead.toFixed(1)} hrs`);
      } else {
        setText('e-time-est', 'Power balanced');
      }
    },
    destroy() { if (interval) clearInterval(interval); }
  };
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setBar(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}% `;
}
