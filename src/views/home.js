// HOME VIEW — Overview dashboard with key readings
import { dragDecayRate } from '../physics.js';

export function createHomeView(satellite) {
  const el = document.createElement('div');
  el.className = 'view view-home';
  el.innerHTML = `
    <div class="home-grid">
      <!-- Big Readouts -->
      <div class="big-readout">
        <div class="readout-label">ALTITUDE</div>
        <div class="readout-value" id="h-altitude">420</div>
        <div class="readout-unit">km</div>
      </div>

      <div class="big-readout">
        <div class="readout-label">VELOCITY</div>
        <div class="readout-value" id="h-velocity">7.66</div>
        <div class="readout-unit">km/s</div>
      </div>

      <div class="big-readout">
        <div class="readout-label">GRAVITY</div>
        <div class="readout-value" id="h-gravity">8.66</div>
        <div class="readout-unit">m/s²</div>
      </div>

      <div class="big-readout">
        <div class="readout-label">ORBIT</div>
        <div class="readout-value" id="h-orbit">#1847</div>
        <div class="readout-unit">revolution</div>
      </div>

      <!-- Status Row -->
      <div class="status-row">
        <div class="status-pill" id="h-sun">
          <span class="pill-icon">SUN</span>
          <span class="pill-text" id="h-sun-text">SUNLIT</span>
        </div>
        <div class="status-pill" id="h-comm">
          <span class="pill-icon">COMM</span>
          <span class="pill-text" id="h-comm-text">WEAK LINK</span>
        </div>
        <div class="status-pill" id="h-ai-status">
          <span class="pill-icon">AI</span>
          <span class="pill-text">ACTIVE</span>
        </div>
      </div>

      <!-- Survival Score -->
      <div class="home-survival">
        <div class="surv-ring" id="h-surv-ring">
          <svg viewBox="0 0 120 120" class="ring-svg">
            <circle cx="60" cy="60" r="52" class="ring-bg"/>
            <circle cx="60" cy="60" r="52" class="ring-fg" id="h-ring-fg"
              stroke-dasharray="326.7" stroke-dashoffset="58"/>
          </svg>
          <div class="ring-text">
            <div class="ring-value" id="h-score">82%</div>
            <div class="ring-label">SURVIVAL</div>
          </div>
        </div>
      </div>

      <!-- Orbital Decay Forecast (New Math Feature) -->
      <div class="home-decay eng-card" id="card-decay">
        <div class="eng-card-header" style="margin-bottom:6px">
          <span>ORBITAL DECAY FORECAST</span>
          <div class="card-btn-group">
            <button class="btn-icon" id="btn-info-decay" title="What is this?">?</button>
            <button class="btn-icon" id="btn-exp-decay" title="Expand View">↗</button>
          </div>
        </div>
        <div class="decay-stats" style="display:flex; justify-content:space-between; margin-bottom: 8px;">
          <div>
            <div class="qs-label">DRAG RATE</div>
            <div class="qs-val" id="h-decay-rate" style="font-size:16px;">--</div>
          </div>
          <div style="text-align:right">
            <div class="qs-label">TIME TO < 200KM</div>
            <div class="qs-val" id="h-decay-time" style="font-size:16px; color:var(--amber)">--</div>
          </div>
        </div>
        <div class="decay-bar-wrap" style="height:4px; background:rgba(255,255,255,0.1); border-radius:2px; overflow:hidden;">
          <div id="h-decay-bar" style="height:100%; width:100%; background:var(--cyan); transition:width 1s linear;"></div>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:11px; color:var(--text-dim); margin-top:4px;">
          <span>Current (420km)</span>
          <span>Critical (200km)</span>
        </div>
      </div>

      <!-- Quick Stats -->
      <div class="quick-stats">
        <div class="qs">
          <span class="qs-label">BATTERY</span>
          <span class="qs-val" id="h-bat">73%</span>
        </div>
        <div class="qs">
          <span class="qs-label">FUEL</span>
          <span class="qs-val" id="h-fuel">92%</span>
        </div>
        <div class="qs">
          <span class="qs-label">TEMP AVG</span>
          <span class="qs-val" id="h-temp">34°C</span>
        </div>
        <div class="qs">
          <span class="qs-label">RADIATION</span>
          <span class="qs-val" id="h-rad">0.15</span>
        </div>
      </div>

      <!-- AI Decision Log -->
      <div class="home-ai-box">
        <div class="ai-box-header">
          <span class="ai-box-label">AUTONOMOUS DECISION LOG</span>
          <span class="ai-threat-badge" id="h-threat-badge">NOMINAL</span>
        </div>
        <div class="ai-log-scroll" id="h-ai-log"></div>
        <div class="ai-forecast" id="h-forecast">Awaiting AI assessment...</div>
      </div>
    </div>
  `;

  let interval = null;

  return {
    element: el,
    _logHandler: null,
    init() {
      interval = setInterval(() => this.update(), 1000);
      this.update();
      this._renderLog();
      this._logHandler = () => this._renderLog();
      window.addEventListener('ai-decision', this._logHandler);

      // Modal Hooks
      import('../main.js').then(({ showModal }) => {
        const decayInfo = `
          <p><strong>Atmospheric Drag Model</strong></p>
          <p>This projection calculates the aerodynamic drag force ($F_{drag}$) acting on the satellite as it moves through the upper thermosphere.</p>
          <p>The time-to-decay is estimated by integrating the current <span class="math-highlight">drag rate (m/day)</span> until the satellite reaches the critical 200km altitude boundary, where atmospheric friction will cause a rapid, unrecoverable deorbit.</p>
          <p><strong>Variables:</strong></p>
          <ul>
            <li><strong>Current Solar Flux (SFU):</strong> Higher solar activity expands the Earth's atmosphere upwards, exponentially increasing drag.</li>
            <li><strong>Geomagnetic Kp Index:</strong> Solar storms heat the atmosphere, dramatically increasing density and drag rates at Low Earth Orbit (LEO).</li>
          </ul>
        `;

        document.getElementById('btn-info-decay')?.addEventListener('click', () => {
          showModal('ORBITAL DECAY FORECAST', decayInfo, false);
        });

        document.getElementById('btn-exp-decay')?.addEventListener('click', () => {
          const cardHtml = document.getElementById('card-decay').innerHTML;
          showModal('ORBITAL DECAY FORECAST', `<div class="expanded-card-view">${cardHtml}</div>`, true);
        });
      });
    },
    update() {
      const state = satellite.getFullState();
      const env = state.environment;
      const s = state.sections;

      setText('h-altitude', env.altitude.toFixed(0));
      setText('h-velocity', env.velocity.toFixed(2));
      setText('h-gravity', env.gravity.toFixed(2));
      setText('h-orbit', `#${state.orbit.orbitNumber}`);

      // Sun status
      const sunEl = document.getElementById('h-sun-text');
      if (sunEl) {
        sunEl.textContent = env.inSunlight ? 'SUNLIT' : 'SHADOW';
        sunEl.parentElement.classList.toggle('pill-warning', !env.inSunlight);
      }

      // Comm
      const commEl = document.getElementById('h-comm-text');
      if (commEl) {
        commEl.textContent = s.commArray.linkStatus + ' LINK';
        commEl.parentElement.classList.toggle('pill-warning', s.commArray.linkStatus === 'LOST');
      }

      // Survival
      const score = state.survivalScore;
      setText('h-score', `${score}%`);
      const ring = document.getElementById('h-ring-fg');
      if (ring) {
        const offset = 326.7 * (1 - score / 100);
        ring.style.strokeDashoffset = offset;
        ring.style.stroke = score > 60 ? 'var(--cyan)' : score > 30 ? 'var(--amber)' : 'var(--red)';
      }

      // Orbital Decay Math
      // Uses drag decay rate (km/s) from physics.js
      const decayKps = dragDecayRate(
        env.altitude, env.velocity * 1000,
        satellite.physics.Cd, satellite.physics.Am, env.geomagneticIndex
      );
      // convert km/s to meters/day
      const decayMetersPerDay = Math.abs(decayKps) * 1000 * 86400;
      setText('h-decay-rate', `-${decayMetersPerDay.toFixed(1)} m/day`);

      const altToLose = env.altitude - 200; // drops dead at 200km
      if (altToLose <= 0) {
        setText('h-decay-time', 'IMMINENT');
        if (document.getElementById('h-decay-bar')) document.getElementById('h-decay-bar').style.width = '0%';
      } else {
        const daysLeft = (altToLose * 1000) / (decayMetersPerDay || 1);
        const yearsLeft = daysLeft / 365;

        // Cap display — thousands of years is physically correct but useless
        if (yearsLeft > 100) {
          setText('h-decay-time', 'STABLE ORBIT');
          // Also make drag rate more readable when negligible
          if (decayMetersPerDay < 0.1) setText('h-decay-rate', '~0.0 m/day');
        } else if (yearsLeft > 1) {
          setText('h-decay-time', `${yearsLeft.toFixed(1)} YEARS`);
        } else if (daysLeft > 1) {
          setText('h-decay-time', `${daysLeft.toFixed(0)} DAYS`);
        } else {
          const hoursLeft = daysLeft * 24;
          setText('h-decay-time', `${hoursLeft.toFixed(1)} HOURS`);
        }

        const startAlt = satellite.orbit?.baseAltitude || 420;
        const pct = Math.max(0, Math.min(100, (altToLose / (startAlt - 200)) * 100));
        const bar = document.getElementById('h-decay-bar');
        if (bar) {
          bar.style.width = `${pct}%`;
          bar.style.background = pct > 50 ? 'var(--cyan)' : pct > 20 ? 'var(--amber)' : 'var(--red)';
        }
      }


      // Quick stats
      setText('h-bat', `${Math.round(s.batteryBay.charge)}%`);
      setText('h-fuel', `${Math.round(s.thrusterPod.fuelPercent)}%`);
      const avgTemp = Object.values(s).reduce((sum, sec) => sum + sec.temperature, 0) / Object.keys(s).length;
      setText('h-temp', `${avgTemp.toFixed(0)}°C`);
      setText('h-rad', env.radiationLevel.toFixed(2));

      // Color code radiation
      const radEl = document.getElementById('h-rad');
      if (radEl) radEl.style.color = env.radiationLevel > 0.5 ? 'var(--red)' : 'var(--cyan)';
      // Threat badge
      const threat = satellite._lastThreat || 'nominal';
      const tColors = { nominal: '#00ccff', caution: '#00ff88', warning: '#ffdd00', critical: '#ff2244' };
      const badge = document.getElementById('h-threat-badge');
      if (badge) {
        badge.textContent = threat.toUpperCase();
        badge.style.background = tColors[threat] || '#00ccff';
        badge.style.color = '#000';
      }
      if (satellite._lastForecast) {
        const fc = document.getElementById('h-forecast');
        if (fc) fc.textContent = satellite._lastForecast;
      }
    },
    _renderLog() {
      // Import AI_LOG lazily from the module scope
      const logEl = document.getElementById('h-ai-log');
      if (!logEl) return;
      // Read from window.__aiLog set by ai-brain
      const log = window.__AI_LOG || [];
      const colors = { nominal: '#00ccff', caution: '#00ff88', warning: '#ffdd00', critical: '#ff2244', normal: '#00ccff', high: '#ffdd00', emergency: '#ff2244' };
      logEl.innerHTML = log.slice(0, 6).map(entry => {
        const color = colors[entry.threat_level?.toLowerCase()] || '#aaa';
        const icon = ['MAINTAIN', 'coast'].includes(entry.action) ? '||' :
          ['EVENT', 'CME_ALERT', 'CME_IMPACT'].includes(entry.action) ? '!!' :
            entry.action === 'FORECAST' ? '--' :
              ['FACE_SUN', 'FACE_SHADOW', 'FACE_EARTH'].includes(entry.action) ? '⟳' :
                entry.action === 'BURN' ? '🔥' :
                  entry.action === 'AI_ONLINE' ? 'OK' : '>>';
        return `<div class="h-log-row" style="border-left:2px solid ${color}">
            <span style="color:${color};font-weight:700">${icon} ${entry.action}</span>
            <span class="h-log-reason">${entry.reason}</span>
          </div>`;
      }).join('');
    },
    destroy() {
      if (interval) clearInterval(interval);
      if (this._logHandler) window.removeEventListener('ai-decision', this._logHandler);
    }
  };
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
