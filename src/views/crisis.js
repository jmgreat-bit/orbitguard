// CRISIS SIMULATION VIEW — inject failures and test AI response

import { AI_LOG, logDecision } from '../ai-brain.js';

const EVENTS = [
    {
        id: 'solar_flare',
        label: 'SOLAR FLARE',
        desc: 'X-class flare -- radiation spike',
        color: '#ff8800',
        apply: (sat) => {
            sat.environment.radiationLevel = 1.8 + Math.random() * 0.8;
            sat.environment.geomagneticIndex = 7 + Math.floor(Math.random() * 3);
            sat.sensors.radiationDetector.saaPassingGrade = true;
            logDecision({ action: 'EVENT', reason: `X-class solar flare! Radiation: ${sat.environment.radiationLevel.toFixed(1)} mSv/hr, Kp=${sat.environment.geomagneticIndex}`, threat_level: 'critical' });
        }
    },
    {
        id: 'cme_incoming',
        label: 'CME INCOMING',
        desc: 'Coronal mass ejection -- impact in ~30 min',
        color: '#ff4400',
        apply: (sat, brain) => {
            if (brain && brain.queueCME) {
                brain.queueCME(1800000 + Math.random() * 1800000);
            } else {
                sat.environment.radiationLevel = 1.5;
                sat.environment.geomagneticIndex = 7;
                logDecision({ action: 'CME_ALERT', reason: 'CME incoming -- radiation elevated', threat_level: 'warning' });
            }
        }
    },
    {
        id: 'debris_close',
        label: 'DEBRIS INTERCEPT',
        desc: 'Object on collision trajectory',
        color: '#ff2244',
        apply: (sat) => {
            if (sat.sensors.lidar.trackedObjects.length > 0) {
                sat.sensors.lidar.trackedObjects[0].distance = 8 + Math.random() * 5;
                logDecision({ action: 'EVENT', reason: `Debris ${sat.sensors.lidar.trackedObjects[0].id} closing to ${sat.sensors.lidar.trackedObjects[0].distance.toFixed(1)}km -- CRITICAL INTERCEPT`, threat_level: 'critical' });
            }
        }
    },
    {
        id: 'battery_drain',
        label: 'BATTERY CRISIS',
        desc: 'Power cell failure -- rapid drain',
        color: '#ffdd00',
        apply: (sat) => {
            sat.sections.batteryBay.charge = 12 + Math.random() * 5;
            sat.sections.batteryBay.healthPercent = Math.max(40, sat.sections.batteryBay.healthPercent - 20);
            sat.sections.batteryBay.status = 'critical';
            logDecision({ action: 'EVENT', reason: `Battery cell failure! Charge at ${sat.sections.batteryBay.charge.toFixed(0)}%, health degraded`, threat_level: 'critical' });
        }
    },
    {
        id: 'thermal_runaway',
        label: 'THERMAL RUNAWAY',
        desc: 'CPU/reaction wheel overheating',
        color: '#ff4400',
        apply: (sat) => {
            sat.sections.onboardComputer.temperature = 82 + Math.random() * 15;
            sat.sections.onboardComputer.status = 'critical';
            sat.sections.onboardComputer.errorCount += 8;
            sat.sections.thermalRadiator.pumpActive = false;
            logDecision({ action: 'EVENT', reason: `Thermal runaway! OBC at ${sat.sections.onboardComputer.temperature.toFixed(0)}C, radiator pump failure`, threat_level: 'critical' });
        }
    },
    {
        id: 'solar_panel_a_fail',
        label: 'PANEL A FAILURE',
        desc: 'Micrometeorite impact -- panel A offline',
        color: '#ffdd00',
        apply: (sat) => {
            sat.sections.solarPanelA.deployed = false;
            sat.sections.solarPanelA.efficiency = 0.1;
            sat.sections.solarPanelA.powerOutput = 0;
            sat.sections.solarPanelA.status = 'critical';
            logDecision({ action: 'EVENT', reason: 'Micrometeorite impact! Solar Panel A offline -- power generation halved', threat_level: 'warning' });
        }
    },
    {
        id: 'comm_blackout',
        label: 'COMM BLACKOUT',
        desc: 'Antenna malfunction -- signal lost',
        color: '#888888',
        apply: (sat) => {
            sat.sections.commArray.linkStatus = 'LOST';
            sat.sections.commArray.signalStrength = -130;
            sat.sections.commArray.dataRate = 0;
            sat.sections.commArray.status = 'critical';
            logDecision({ action: 'EVENT', reason: 'Comm antenna failure -- complete signal blackout. AI operating autonomously', threat_level: 'warning' });
        }
    },
    {
        id: 'orbital_decay',
        label: 'RAPID DECAY',
        desc: 'Geomagnetic storm inflates atmosphere',
        color: '#00ccff',
        apply: (sat) => {
            sat.orbit.baseAltitude = Math.max(sat.orbit.baseAltitude - 12, 200);
            sat.environment.geomagneticIndex = 8;
            logDecision({ action: 'EVENT', reason: `Geomagnetic storm! Altitude dropped to ${sat.orbit.baseAltitude.toFixed(0)}km -- orbital reboost required`, threat_level: 'warning' });
        }
    },
    {
        id: 'all_clear',
        label: 'ALL CLEAR',
        desc: 'Reset all systems to nominal',
        color: '#00ff88',
        apply: (sat) => {
            sat.environment.radiationLevel = 0.12;
            sat.environment.geomagneticIndex = 3;
            sat.sections.batteryBay.charge = Math.max(sat.sections.batteryBay.charge, 60);
            sat.sections.batteryBay.status = 'nominal';
            sat.sections.onboardComputer.temperature = 45;
            sat.sections.onboardComputer.errorCount = 0;
            sat.sections.onboardComputer.status = 'nominal';
            sat.sections.thermalRadiator.pumpActive = true;
            sat.sections.commArray.status = 'nominal';
            Object.values(sat.sections).forEach(s => { if (s.status === 'critical') s.status = 'nominal'; });
            logDecision({ action: 'EVENT', reason: 'Systems nominal -- anomalies cleared by ground command', threat_level: 'nominal' });
        }
    }
];

export function createCrisisView(satellite, brain) {
    const el = document.createElement('div');
    el.className = 'view view-crisis';
    el.innerHTML = `
    <div class="crisis-layout">

      <!-- TOP: Event Injection Buttons -->
      <div class="eng-card crisis-events-card">
        <div class="eng-card-header">CRISIS INJECTION -- TEST AI RESPONSE</div>
        <div class="crisis-subtitle">Inject failure events and watch the AI autonomously respond</div>
        <div class="crisis-buttons" id="crisis-btns"></div>
      </div>

      <!-- BOTTOM ROW: Big Log + Threat Panel -->
      <div class="crisis-bottom-row">

        <!-- LARGE Decision Log -->
        <div class="eng-card crisis-log-card-big">
          <div class="crisis-log-header">
            <span class="crisis-log-title">AUTONOMOUS DECISION LOG</span>
            <button class="log-expand-btn" id="cr-expand-btn">EXPAND FULL LOG</button>
          </div>
          <div class="crisis-log-big" id="crisis-log"></div>
        </div>

        <!-- Threat Assessment Panel -->
        <div class="eng-card crisis-gauge-card">
          <div class="eng-card-header">THREAT ASSESSMENT</div>
          <div class="threat-display">
            <div class="threat-level-big" id="cr-threat">NOMINAL</div>
            <div class="threat-bars" id="cr-threat-bars"></div>
          </div>
          <div class="cr-stats">
            <div class="cr-stat-row"><span>Altitude</span><span id="cr-alt">--</span></div>
            <div class="cr-stat-row"><span>Dv Remaining</span><span id="cr-dv">--</span></div>
            <div class="cr-stat-row"><span>Closest Debris Pc</span><span id="cr-pc">--</span></div>
            <div class="cr-stat-row"><span>Radiation</span><span id="cr-rad">--</span></div>
            <div class="cr-stat-row"><span>Battery</span><span id="cr-bat">--</span></div>
            <div class="cr-stat-row cr-stat-score"><span>Survival Score</span><span id="cr-score">--</span></div>
          </div>
          <div class="crisis-forecast" id="cr-forecast">Awaiting AI assessment...</div>
        </div>

      </div>
    </div>

    <!-- FULLSCREEN LOG OVERLAY -->
    <div class="log-overlay" id="log-overlay">
      <div class="log-overlay-panel">
        <div class="log-overlay-header">
          <span class="log-overlay-title">FULL MISSION LOG</span>
          <button class="log-close-btn" id="cr-close-btn">X  CLOSE</button>
        </div>
        <div class="log-overlay-entries" id="log-overlay-entries"></div>
      </div>
    </div>
  `;

    // Build event buttons
    const btns = el.querySelector('#crisis-btns');
    EVENTS.forEach(ev => {
        const btn = document.createElement('button');
        btn.className = 'crisis-btn';
        btn.style.setProperty('--ev-color', ev.color);
        btn.innerHTML = `<span class="cb-label">${ev.label}</span><span class="cb-desc">${ev.desc}</span>`;
        btn.addEventListener('click', () => {
            ev.apply(satellite, brain);
            btn.classList.add('cb-flash');
            setTimeout(() => btn.classList.remove('cb-flash'), 600);
        });
        btns.appendChild(btn);
    });

    // Overlay open / close
    el.querySelector('#cr-expand-btn').addEventListener('click', () => {
        el.querySelector('#log-overlay').classList.add('overlay-open');
        renderOverlayLog(el);
    });
    el.querySelector('#cr-close-btn').addEventListener('click', () => {
        el.querySelector('#log-overlay').classList.remove('overlay-open');
    });
    el.querySelector('#log-overlay').addEventListener('click', (e) => {
        if (e.target === el.querySelector('#log-overlay')) {
            el.querySelector('#log-overlay').classList.remove('overlay-open');
        }
    });

    const escHandler = (e) => {
        if (e.key === 'Escape') el.querySelector('#log-overlay')?.classList.remove('overlay-open');
    };
    window.addEventListener('keydown', escHandler);

    let interval = null;

    return {
        element: el,
        init() {
            interval = setInterval(() => this.update(), 500);
            this.update();
            this._renderLog();
            window.addEventListener('ai-decision', () => {
                this._renderLog();
                if (el.querySelector('#log-overlay').classList.contains('overlay-open')) {
                    renderOverlayLog(el);
                }
            });
        },
        update() {
            const state = satellite.getFullState();
            const env = state.environment;
            const phys = state.physics || {};
            const nearest = state.sensors.lidar.nearestObject;

            const threat = satellite._lastThreat || 'nominal';
            const threatColors = { nominal: '#00ccff', caution: '#00ff88', warning: '#ffdd00', critical: '#ff2244' };

            const threatEl = el.querySelector('#cr-threat');
            if (threatEl) {
                threatEl.textContent = threat.toUpperCase();
                threatEl.style.color = threatColors[threat] || '#00ccff';
            }

            const barsEl = el.querySelector('#cr-threat-bars');
            if (barsEl) {
                const barCount = 8;
                const threatIdx = ['nominal', 'caution', 'warning', 'critical'].indexOf(threat);
                const fillCount = Math.round((threatIdx / 3) * barCount);
                barsEl.innerHTML = Array.from({ length: barCount }, (_, i) => {
                    const active = i < fillCount;
                    const color = i < 2 ? '#00ff88' : i < 5 ? '#ffdd00' : '#ff2244';
                    return `<div class="tb-bar" style="background:${active ? color : 'rgba(255,255,255,0.08)'}"></div>`;
                }).join('');
            }

            const set = (id, text) => { const e = el.querySelector(`#${id}`); if (e) e.textContent = text; };
            set('cr-alt', `${env.altitude.toFixed(1)} km`);
            set('cr-dv', `${phys.maxDeltaV_ms?.toFixed(1) ?? '?'} m/s`);
            set('cr-pc', nearest.pcFormatted || '< 1e-9');
            set('cr-rad', `${env.radiationLevel.toFixed(2)} mSv/hr`);
            set('cr-bat', `${state.sections.batteryBay.charge.toFixed(0)}%`);
            set('cr-score', `${state.survivalScore}%`);
            if (satellite._lastForecast) set('cr-forecast', satellite._lastForecast);
        },
        _renderLog() { renderInlineLog(el); },
        destroy() {
            if (interval) clearInterval(interval);
            window.removeEventListener('keydown', escHandler);
        }
    };
}

// ── Shared log entry renderer ──────────────────────────────────────────────
function entryHTML(entry, big = false) {
    const colors = { nominal: '#00ccff', caution: '#00ff88', warning: '#ffdd00', critical: '#ff2244' };
    const color = colors[entry.threat_level] || '#888888';
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const cls = big ? 'log-entry-big' : 'log-entry';
    return `<div class="${cls}" style="border-left:3px solid ${color}">
      <span class="log-time">${time}</span>
      <span class="log-action" style="color:${color}"> > ${entry.action}</span>
      <span class="log-reason">${entry.reason}</span>
    </div>`;
}

function renderInlineLog(el) {
    const logEl = el.querySelector('#crisis-log');
    if (!logEl) return;
    logEl.innerHTML = (window.__AI_LOG || []).slice(0, 10).map(e => entryHTML(e)).join('');
}

function renderOverlayLog(el) {
    const logEl = el.querySelector('#log-overlay-entries');
    if (!logEl) return;
    logEl.innerHTML = (window.__AI_LOG || []).map(e => entryHTML(e, true)).join('');
}
