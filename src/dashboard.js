// Dashboard controller — maps full satellite telemetry to UI

export function updateFullDashboard(satellite) {
    const state = satellite.getFullState();

    updateTopBar(state);
    updateSchematic(state.sections);
    updateEnvironment(state.environment, state.orbit);
    updateLidar(state.sensors.lidar);
    updateTelemetryGauges(state.sections);
    updateSurvival(state.survivalScore);
}

function updateTopBar(state) {
    // Mission time
    const s = Math.floor(state.missionTime);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const el = document.getElementById('mission-time');
    if (el) el.textContent = `T+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

    // Orbit info
    setText('orbit-num', state.orbit.orbitNumber);
    setText('altitude', state.environment.altitude.toFixed(0));
    setText('velocity', state.environment.velocity.toFixed(2));
}

function updateSchematic(sections) {
    for (const [key, section] of Object.entries(sections)) {
        const el = document.getElementById(`sec-${key}`);
        if (!el) continue;

        // Remove all status classes
        el.classList.remove('status-nominal', 'status-warning', 'status-critical');
        el.classList.add(`status-${section.status}`);
    }

    // Alert markers for critical/warning sections
    const markers = document.getElementById('alert-markers');
    if (markers) {
        markers.innerHTML = '';
        for (const [key, section] of Object.entries(sections)) {
            if (section.status === 'critical' || section.status === 'warning') {
                const el = document.getElementById(`sec-${key}`);
                if (!el) continue;
                const bbox = el.getBBox();
                const color = section.status === 'critical' ? '#ff2244' : '#ffaa00';
                const symbol = section.status === 'critical' ? '⚠' : '●';
                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', bbox.x + bbox.width - 5);
                text.setAttribute('y', bbox.y + 12);
                text.setAttribute('fill', color);
                text.setAttribute('font-size', '12');
                text.textContent = symbol;
                markers.appendChild(text);
            }
        }
    }
}

function updateEnvironment(env, orbit) {
    setText('gravity', env.gravity.toFixed(2));
    setText('radiation', env.radiationLevel.toFixed(2));
    setText('mag-field', Math.round(env.magneticField));

    const sunEl = document.getElementById('sun-status');
    if (sunEl) {
        sunEl.textContent = env.inSunlight ? '☀️ LIT' : '🌑 SHADOW';
        sunEl.style.color = env.inSunlight ? '#ffaa00' : '#5a6a7a';
    }

    setText('nearest-body', env.nearestBody);
    setText('body-dist', `${env.distanceToBody} km`);
    setText('lat-lon', `${orbit.latitude.toFixed(1)}°${orbit.latitude > 0 ? 'N' : 'S'}, ${Math.abs(orbit.longitude).toFixed(1)}°${orbit.longitude > 0 ? 'E' : 'W'}`);

    // Radiation warning color
    const radEl = document.getElementById('radiation');
    if (radEl) {
        radEl.style.color = env.radiationLevel > 0.5 ? '#ff2244' : env.radiationLevel > 0.3 ? '#ffaa00' : '#fff';
    }
}

function updateLidar(lidar) {
    const container = document.getElementById('lidar-blips');
    if (!container) return;
    container.innerHTML = '';

    const cx = 70, cy = 70, maxR = 65; // center and max radius of scope

    lidar.trackedObjects.forEach(obj => {
        const r = Math.min((obj.distance / lidar.maxRange) * maxR, maxR);
        const rad = (obj.bearing * Math.PI) / 180;
        const x = cx + r * Math.cos(rad);
        const y = cy + r * Math.sin(rad);

        const blip = document.createElement('div');
        blip.className = `lidar-blip threat-${obj.distance < 20 ? 'critical' : obj.distance < 50 ? 'warning' : 'low'}`;
        blip.style.left = `${x}px`;
        blip.style.top = `${y}px`;
        container.appendChild(blip);
    });

    // Nearest object readout
    const nearest = lidar.nearestObject;
    const infoEl = document.getElementById('lidar-nearest');
    if (infoEl && nearest) {
        const threatClass = nearest.threatLevel === 'critical' ? 'tag-critical' :
            nearest.threatLevel === 'warning' ? 'tag-warning' : 'tag-low';
        infoEl.innerHTML = `
      <span class="ln-id">${nearest.id}</span>
      <span class="ln-dist">${nearest.distance.toFixed(1)} km</span>
      <span class="ln-threat ${threatClass}">${nearest.threatLevel.toUpperCase()}</span>
    `;
    }
}

function updateTelemetryGauges(sections) {
    const bat = sections.batteryBay;
    const thr = sections.thrusterPod;
    const solA = sections.solarPanelA;
    const solB = sections.solarPanelB;

    // Battery bar
    setBar('bat-bar', bat.charge);
    setText('bat-val', `${Math.round(bat.charge)}%`);
    const batBar = document.getElementById('bat-bar');
    if (batBar) batBar.style.background = bat.charge < 20 ? 'var(--red)' : 'var(--cyan)';

    // Fuel bar
    setBar('fuel-bar', thr.fuelPercent);
    setText('fuel-val', `${Math.round(thr.fuelPercent)}%`);

    // Solar output
    const totalSolar = solA.powerOutput + solB.powerOutput;
    const solarPercent = (totalSolar / 10) * 100;
    setBar('solar-bar', solarPercent);
    setText('solar-val', `${totalSolar.toFixed(1)}W`);

    // Pressure
    setText('pressure-val', `${thr.pressure.toFixed(1)} MPa`);
}

function updateSurvival(score) {
    setText('survival-score', `${score}%`);
    const bar = document.getElementById('survival-bar');
    if (bar) bar.style.width = `${score}%`;

    const val = document.getElementById('survival-score');
    if (val) val.style.color = score > 50 ? 'var(--cyan)' : 'var(--red)';
}

// Click handler for ship sections
export function initSchematicInteraction(satellite) {
    document.querySelectorAll('.section[data-section]').forEach(el => {
        el.addEventListener('click', () => {
            const sectionKey = el.dataset.section;
            const state = satellite.getFullState();
            const section = state.sections[sectionKey];
            if (!section) return;

            const nameEl = document.getElementById('detail-name');
            const gridEl = document.getElementById('detail-grid');
            if (!nameEl || !gridEl) return;

            nameEl.textContent = section.name;
            nameEl.style.color = section.status === 'critical' ? 'var(--red)' :
                section.status === 'warning' ? 'var(--amber)' : 'var(--cyan)';

            // Build detail grid from section properties
            gridEl.innerHTML = '';
            for (const [key, value] of Object.entries(section)) {
                if (key === 'name') continue;
                const label = document.createElement('span');
                label.className = 'd-label';
                label.textContent = key.replace(/([A-Z])/g, ' $1').toUpperCase();

                const val = document.createElement('span');
                val.className = 'd-val';
                if (typeof value === 'number') {
                    val.textContent = value % 1 === 0 ? value : value.toFixed(2);
                } else if (typeof value === 'boolean') {
                    val.textContent = value ? '✓ ON' : '✗ OFF';
                    val.style.color = value ? 'var(--green)' : 'var(--red)';
                } else if (value === null) {
                    val.textContent = '—';
                } else {
                    val.textContent = String(value);
                }

                gridEl.appendChild(label);
                gridEl.appendChild(val);
            }
        });
    });
}

export function addLogEntry(type, message) {
    const logContainer = document.getElementById('ai-log');
    if (!logContainer) return;

    if (logContainer.children.length > 8) {
        logContainer.removeChild(logContainer.children[0]);
    }

    const entry = document.createElement('div');
    entry.className = 'log-line';

    const time = new Date().toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
    });

    const prefix = type === 'alert' ? '[!]' : type === 'success' ? '[✓]' : '[→]';
    const color = type === 'alert' ? 'var(--red)' : type === 'success' ? 'var(--green)' : 'var(--cyan)';

    entry.innerHTML = `<span style="color:${color}">${prefix}</span> <span style="color:var(--text-dim)">${time}</span> ${message}`;
    logContainer.appendChild(entry);
    logContainer.scrollTop = logContainer.scrollHeight;
}

// Utilities
function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function setBar(id, percent) {
    const el = document.getElementById(id);
    if (el) el.style.width = `${Math.max(0, Math.min(100, percent))}%`;
}
