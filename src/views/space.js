import { Lidar3D } from '../webgl/Lidar3D.js';

export function createSpaceView(satellite) {
  const el = document.createElement('div');
  el.className = 'view view-space';
  el.innerHTML = `
    <div class="space-grid">
      <!-- LIDAR -->
      <div class="eng-card lidar-card" id="card-lidar">
        <div class="eng-card-header">
          <span>LIDAR PROXIMITY SCAN</span>
          <div class="card-btn-group">
            <button class="btn-icon" id="btn-info-lidar" title="What is this?">?</button>
            <button class="btn-icon" id="btn-exp-lidar" title="Expand View">↗</button>
          </div>
        </div>
        <div class="lidar-scope-lg" id="lidar-3d-wrap" style="position:relative; width:100%; height:280px; overflow:hidden;">
          <!-- 3D Canvas injected here -->
        </div>
        <!-- Tracked objects list -->
        <div class="tracked-list" id="sp-tracked">
        </div>
      </div>

      <!-- B-Plane Collision Analysis (New Math Feature) -->
      <div class="eng-card bplane-card" id="card-bplane" style="grid-column: 1 / -1; margin-bottom: 20px;">
        <div class="eng-card-header">
          <span>B-PLANE COLLISION PROBABILITY (CHAN)</span>
          <div class="card-btn-group">
            <button class="btn-icon" id="btn-info-bplane" title="What is this?">?</button>
            <button class="btn-icon" id="btn-exp-bplane" title="Expand View">↗</button>
          </div>
        </div>
        <div class="eng-details" style="display:grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start;">
          <div>
            <div class="ed-row"><span>Target Object</span><span id="sp-bp-target">—</span></div>
            <div class="ed-row"><span>Miss Distance (d)</span><span id="sp-bp-miss">—</span></div>
            <div class="ed-row"><span>Relative Velocity (v)</span><span id="sp-bp-vel">—</span></div>
            <div class="ed-row">
              <span style="border-bottom:1px dashed var(--text-dim)" title="1-sigma uncertainty disk radius">Positional Covariance (σ)</span>
              <span id="sp-bp-sigma">—</span>
            </div>
            <div class="ed-row">
              <span style="border-bottom:1px dashed var(--text-dim)" title="Combined radius of satellite + debris">Hard-body Radius (R)</span>
              <span id="sp-bp-radius">—</span>
            </div>
            <div class="ed-row" style="border-top:1px solid rgba(0,255,255,0.15);padding-top:8px;margin-top:8px">
              <span>Collision Risk (Pc)</span>
              <span id="sp-bp-pc" style="font-weight:700;font-size:16px">—</span>
            </div>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-dim); margin-bottom:8px; letter-spacing:1px; line-height:1.4">
              <span style="color:var(--cyan)">MATHEMATICAL MODEL</span><br/>
              <i>Pc ≈ Q1(d/σ, R/σ)</i> where Q1 is the Marcum Q-function.<br/><br/>
              The probability represents the 2D Gaussian integral over a disk of radius R, centered at miss distance d on the B-plane.
            </div>
            <div class="bplane-viz" style="height:60px; border:1px solid rgba(0,255,255,0.1); border-radius:3px; position:relative; overflow:hidden; background:rgba(0,0,0,0.5)">
              <div id="sp-bp-sat" style="position:absolute; top:28px; left:10%; width:4px; height:4px; background:var(--cyan); border-radius:50%;"></div>
              <div id="sp-bp-deb" style="position:absolute; top:28px; left:90%; width:4px; height:4px; background:var(--red); border-radius:50%; box-shadow:0 0 10px var(--red)"></div>
              <div id="sp-bp-cov" style="position:absolute; top:28px; left:10%; width:40px; height:40px; border:1px dashed var(--cyan); border-radius:50%; transform:translate(-50%, -50%); opacity:0.3"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- Radiation -->
      <div class="eng-card" id="card-rad">
        <div class="eng-card-header">
          <span>RADIATION MONITOR</span>
          <div class="card-btn-group">
            <button class="btn-icon" id="btn-info-rad" title="What is this?">?</button>
            <button class="btn-icon" id="btn-exp-rad" title="Expand View">↗</button>
          </div>
        </div>
        <div class="rad-display">
          <div class="rad-current">
            <div class="rad-big" id="sp-rad-rate">0.15</div>
            <div class="rad-unit">mSv/hr</div>
          </div>
          <div class="rad-bar-wrap">
            <div class="rad-bar" id="sp-rad-bar"></div>
            <div class="rad-threshold">ALERT: 1.0</div>
          </div>
        </div>
        <div class="eng-details">
          <div class="ed-row"><span>Cumulative Dose</span><span id="sp-rad-cum">427 mSv</span></div>
          <div class="ed-row"><span>SAA Status</span><span id="sp-rad-saa">CLEAR</span></div>
          <div class="ed-row"><span>Alert Threshold</span><span>1.0 mSv/hr</span></div>
          <div class="ed-row"><span>Solar Flux</span><span id="sp-solar-flux">120 SFU</span></div>
          <div class="ed-row"><span>Geomagnetic Kp</span><span id="sp-kp">3</span></div>
        </div>
      </div>

      <!-- Magnetic Field -->
      <div class="eng-card" id="card-mag">
        <div class="eng-card-header">
          <span>MAGNETOMETER</span>
          <div class="card-btn-group">
            <button class="btn-icon" id="btn-info-mag" title="What is this?">?</button>
            <button class="btn-icon" id="btn-exp-mag" title="Expand View">↗</button>
          </div>
        </div>
        <div class="mag-display">
          <div class="mag-big" id="sp-mag-str">35000</div>
          <div class="mag-unit">nT</div>
        </div>
        <div class="eng-details">
          <div class="ed-row"><span>Field X</span><span id="sp-mag-x">0.30</span></div>
          <div class="ed-row"><span>Field Y</span><span id="sp-mag-y">0.80</span></div>
          <div class="ed-row"><span>Field Z</span><span id="sp-mag-z">0.50</span></div>
          <div class="ed-row"><span>Declination</span><span id="sp-mag-dec">12°</span></div>
          <div class="ed-row"><span>Anomaly</span><span id="sp-mag-anom">NONE</span></div>
        </div>
      </div>

      <!-- Communications -->
      <div class="eng-card" id="card-comm">
        <div class="eng-card-header">
          <span>COMMUNICATION LINK</span>
          <div class="card-btn-group">
            <button class="btn-icon" id="btn-info-comm" title="What is this?">?</button>
            <button class="btn-icon" id="btn-exp-comm" title="Expand View">↗</button>
          </div>
        </div>
        <div class="comm-status-big" id="sp-comm-status">WEAK</div>
        <div class="eng-details">
          <div class="ed-row"><span>Frequency</span><span id="sp-comm-freq">435.0 MHz</span></div>
          <div class="ed-row"><span>TX Power</span><span id="sp-comm-tx">1.0W</span></div>
          <div class="ed-row"><span>Signal Strength</span><span id="sp-comm-sig">-95 dBm</span></div>
          <div class="ed-row" style="border-bottom:1px dashed var(--cyan-dim)" title="One-way Speed of Light + Hardware Delay">
            <span>Latency (Ping)</span><span id="sp-comm-ping">15 ms</span>
          </div>
          <div class="ed-row"><span>Data Rate</span><span id="sp-comm-rate">4800 bps</span></div>
          <div class="ed-row"><span>Antenna Temp</span><span id="sp-comm-temp">28°C</span></div>
          <div class="ed-row"><span>Last Contact</span><span id="sp-comm-last">—</span></div>
          <div class="ed-row"><span>Next Pass</span><span id="sp-comm-next">12 min</span></div>
        </div>
      </div>
    </div>
  `;

  let interval = null;

  return {
    element: el,
    init() {
      const lidarContainer = el.querySelector('#lidar-3d-wrap');
      this.lidar3D = new Lidar3D(lidarContainer, 200); // 200km max range

      interval = setInterval(() => this.update(), 500);
      this.update();

      // Modal Hooks
      import('../main.js').then(({ showModal }) => {
        const bplaneInfo = `
          <p><strong>B-Plane Collision Geometry (Chan's Model)</strong></p>
          <p>This panel visualizes the mathematical foundation used to calculate the risk of colliding with space debris.</p>
          <p><strong>Definitions:</strong></p>
          <ul>
            <li><strong>Miss Distance ($d$):</strong> The closest point of approach (CPA) between our satellite and the debris object.</li>
            <li><strong>Hard-body Radius ($R$):</strong> The combined physical size of both objects (if their centers come closer than this, they hit).</li>
            <li><strong>Positional Covariance ($\\sigma$):</strong> The 1-sigma uncertainty in the radar/tracking data. The exact position is a Gaussian distribution, not a single point.</li>
          </ul>
          <p><strong>The Math:</strong></p>
          <p>We use Chan's method, assuming a spherical, isotropic covariance matrix. The collision probability ($P_c$) is computed by integrating the 2D Gaussian probability density function over a disk of radius $R$ centered at the miss distance $d$ on the Encounter Plane (B-Plane).</p>
        `;

        document.getElementById('btn-info-bplane')?.addEventListener('click', () => {
          showModal('CHAN COLLISION PROBABILITY', bplaneInfo, false);
        });

        document.getElementById('btn-exp-bplane')?.addEventListener('click', () => {
          const cardHtml = document.getElementById('card-bplane').innerHTML;
          showModal('CHAN COLLISION PROBABILITY', `<div class="expanded-card-view">${cardHtml}</div>`, true);
        });

        // LIDAR Hook
        const lidarInfo = `
          <p><strong>LIDAR Sweeper Array</strong></p>
          <p>An active scanning system tracking nearby micrometeoroids and space debris within a 200km radius.</p>
          <p>It reports the physical distance and relative velocity of tracked objects. Not all objects pose a collision threat, but highly energetic ones trigger automatic AI evasion responses.</p>
        `;
        document.getElementById('btn-info-lidar')?.addEventListener('click', () => { showModal('LIDAR PROXIMITY SCAN', lidarInfo, false); });
        document.getElementById('btn-exp-lidar')?.addEventListener('click', () => {
          showModal('LIDAR PROXIMITY SCAN', `<div class="expanded-card-view">${document.getElementById('card-lidar').innerHTML}</div>`, true);
        });

        // RADIATION Hook
        const radInfo = `
          <p><strong>Geiger-Muller Tube Array</strong></p>
          <p>Measures high-energy ionizing radiation from solar flares, coronal mass ejections (CMEs), and the South Atlantic Anomaly (SAA).</p>
          <p>Dose rates above 1.0 mSv/hr degrade the satellite's solar panel efficiency and increase processing errors (bit-flips) in the Onboard Computer.</p>
        `;
        document.getElementById('btn-info-rad')?.addEventListener('click', () => { showModal('RADIATION MONITOR', radInfo, false); });
        document.getElementById('btn-exp-rad')?.addEventListener('click', () => {
          showModal('RADIATION MONITOR', `<div class="expanded-card-view">${document.getElementById('card-rad').innerHTML}</div>`, true);
        });

        // MAGNETOMETER Hook
        const magInfo = `
          <p><strong>Fluxgate Magnetometer</strong></p>
          <p>Measures the strength and vector of Earth's local magnetic field (in nanoTeslas).</p>
          <p>Used by the onboard AI to modulate the magnetic torque rods for attitude control without wasting thruster fuel. Major solar storms disrupt this field, causing navigational anomalies.</p>
        `;
        document.getElementById('btn-info-mag')?.addEventListener('click', () => { showModal('MAGNETOMETER', magInfo, false); });
        document.getElementById('btn-exp-mag')?.addEventListener('click', () => {
          showModal('MAGNETOMETER', `<div class="expanded-card-view">${document.getElementById('card-mag').innerHTML}</div>`, true);
        });

        // COMM Hook
        const commInfo = `
          <p><strong>Phased Array Transceiver</strong></p>
          <p>Maintains the uplink/downlink to ground control. Signal strength dictates the data rate.</p>
          <p>If the link drops below -105 dBm or the satellite passes over a blind spot, all systems switch to fully autonomous execution via the Gemini 2.0 AI Brain until contact is re-established.</p>
        `;
        document.getElementById('btn-info-comm')?.addEventListener('click', () => { showModal('COMMUNICATION LINK', commInfo, false); });
        document.getElementById('btn-exp-comm')?.addEventListener('click', () => {
          showModal('COMMUNICATION LINK', `<div class="expanded-card-view">${document.getElementById('card-comm').innerHTML}</div>`, true);
        });
      });
    },
    update() {
      const state = satellite.getFullState();
      const lidar = state.sensors.lidar;
      const rad = state.sensors.radiationDetector;
      const mag = state.sensors.magnetometer;
      const comm = state.sections.commArray;
      const env = state.environment;

      // 3D LIDAR Update
      if (this.lidar3D) {
        this.lidar3D.update(lidar.trackedObjects);
      }

      // Tracked list — now shows Chan collision probability
      const tracked = document.getElementById('sp-tracked');
      if (tracked) {
        tracked.innerHTML = lidar.trackedObjects.map(obj => {
          const color = obj.riskColor || 'var(--cyan)';
          const label = obj.riskLabel || '—';
          const pcStr = obj.pcFormatted || '—';
          return `<div class="tracked-row">
            <span class="tr-dot" style="background:${color}"></span>
            <span class="tr-id">${obj.id}</span>
            <span class="tr-dist">${obj.distance.toFixed(1)} km</span>
            <span class="tr-ang" style="color:var(--text-dim);font-family:monospace;font-size:0.7em;min-width:70px">Az ${Math.round(obj.bearing)}° El ${Math.round(obj.elevation || 0)}°</span>
            <span class="tr-pc" style="color:${color};font-family:monospace;font-size:0.75em">Pc ${pcStr}</span>
            <span class="tr-risk" style="color:${color};font-size:0.7em">${label}</span>
          </div>`;
        }).join('');
      }

      // B-Plane Analysis (Nearest Object)
      const nearest = lidar.nearestObject;
      if (nearest) {
        setText('sp-bp-target', nearest.id);
        setText('sp-bp-miss', `${(nearest.distance * 1000).toFixed(0)} m`);
        setText('sp-bp-vel', `${(nearest.closingSpeed * 1000).toFixed(0)} m / s`);

        const phys = state.physics || {};
        const sigma = phys.posUncertainty_m || 500;
        const radius = phys.collisionRadius_m || 10;

        setText('sp-bp-sigma', `${sigma} m`);
        setText('sp-bp-radius', `${radius} m`);

        const pcEl = document.getElementById('sp-bp-pc');
        if (pcEl) {
          pcEl.textContent = nearest.pcFormatted || '< 1e-9';
          pcEl.style.color = nearest.riskColor || 'var(--cyan)';
        }

        // Update mini B-plane viz
        const sat = document.getElementById('sp-bp-sat');
        const deb = document.getElementById('sp-bp-deb');
        const cov = document.getElementById('sp-bp-cov');

        if (sat && deb && cov) {
          // Mapping max distance 100km to pixels.
          // 10% is sat, up to 90% is debris.
          const maxDist = 100;
          const distPct = Math.min((nearest.distance / maxDist) * 80, 80);
          deb.style.left = `${10 + distPct} % `;
          deb.style.background = nearest.riskColor || 'var(--red)';
          deb.style.boxShadow = `0 0 10px ${nearest.riskColor || 'var(--red)'}`;
        }
      }

      // Radiation
      setText('sp-rad-rate', rad.currentDose.toFixed(2));
      setText('sp-rad-cum', `${rad.cumulativeDose.toFixed(0)} mSv`);
      const radBar = document.getElementById('sp-rad-bar');
      if (radBar) {
        const pct = Math.min((rad.currentDose / rad.alertThreshold) * 100, 100);
        radBar.style.width = `${pct} % `;
        radBar.style.background = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--amber)' : 'var(--green)';
      }
      const rateEl = document.getElementById('sp-rad-rate');
      if (rateEl) rateEl.style.color = rad.currentDose > 0.5 ? 'var(--red)' : 'var(--cyan)';

      const saaEl = document.getElementById('sp-rad-saa');
      if (saaEl) {
        saaEl.textContent = rad.saaPassingGrade ? '⚠ IN SAA' : 'CLEAR';
        saaEl.style.color = rad.saaPassingGrade ? 'var(--red)' : 'var(--green)';
      }
      setText('sp-solar-flux', `${env.solarFluxIndex} SFU`);
      setText('sp-kp', env.geomagneticIndex);

      // Magnetometer
      setText('sp-mag-str', Math.round(mag.fieldStrength));
      setText('sp-mag-x', mag.fieldDirection.x.toFixed(2));
      setText('sp-mag-y', mag.fieldDirection.y.toFixed(2));
      setText('sp-mag-z', mag.fieldDirection.z.toFixed(2));
      setText('sp-mag-dec', `${env.magneticDeclination}°`);
      const anomEl = document.getElementById('sp-mag-anom');
      if (anomEl) {
        anomEl.textContent = mag.anomalyDetected ? '⚠ DETECTED' : 'NONE';
        anomEl.style.color = mag.anomalyDetected ? 'var(--red)' : 'var(--green)';
      }

      // Communications
      const commSt = document.getElementById('sp-comm-status');
      if (commSt) {
        commSt.textContent = comm.linkStatus;
        commSt.style.color = comm.linkStatus === 'STRONG' ? 'var(--green)' :
          comm.linkStatus === 'WEAK' ? 'var(--amber)' : 'var(--red)';
      }
      setText('sp-comm-freq', `${comm.frequency} MHz`);
      setText('sp-comm-tx', `${comm.txPower.toFixed(1)}W`);
      setText('sp-comm-sig', `${comm.signalStrength.toFixed(0)} dBm`);
      setText('sp-comm-ping', comm.signalLatency_ms ? `${comm.signalLatency_ms.toFixed(1)} ms` : '—');
      setText('sp-comm-rate', `${comm.dataRate} bps`);
      setText('sp-comm-temp', `${comm.temperature.toFixed(0)}°C`);
      setText('sp-comm-last', comm.lastContact ? timeSince(comm.lastContact) : '—');
      setText('sp-comm-next', `${state.orbit.timeToNextContact.toFixed(0)} min`);
    },
    destroy() {
      if (interval) clearInterval(interval);
      if (this.lidar3D) this.lidar3D.destroy();
    }
  };
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function timeSince(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ago`;
}
