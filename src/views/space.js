// Space environment — conjunction screening with the B-plane picture, space weather,
// radiation, the geomagnetic field and the radio link.
import { app } from '../app.js';
import { meanMotion } from '../physics.js';
import { esc, fmt, setText, drawSparkline } from '../ui/dom.js';
import { bindExplainers } from '../ui/modal.js';

const EXPLAIN = {
    conj: {
        title: 'Conjunction screening',
        html: `<p>A 1U CubeSat cannot see debris itself. Ground tracking networks predict close approaches and send <strong>conjunction data messages</strong>: the time of closest approach (TCA), the predicted miss distance and how uncertain the positions are (σ).</p>
        <p>The uncertainty shrinks as TCA gets closer and tracking improves, so the collision probability (Pc) often rises, then falls. NASA's practice is to consider a manoeuvre when <strong>Pc ≥ 1e-4</strong>. Object names are from real debris clouds. The individual encounters are simulated.</p>`,
    },
    bplane: {
        title: 'The B-plane',
        html: `<p>The plane through the satellite at right angles to the debris' relative velocity. Everything that matters for a hit happens in this plane: the <strong>miss vector</strong> (where the debris is predicted to cross), the <strong>uncertainty circles</strong> (1σ and 3σ) and the combined <strong>hard-body radius</strong> of both objects (10 m).</p>
        <p>Pc is the share of the Gaussian uncertainty that falls inside the hard-body circle, computed with Chan's exact series for a circular covariance (equal to 1 − Q₁(d/σ, R/σ), the Marcum Q-function).</p>
        <p>A burn moves the satellite: up or down (vertical axis) and along its orbit, which shows up on the horizontal axis depending on the crossing angle. For a head-on pass, only the vertical shift helps.</p>`,
    },
    weather: {
        title: 'Space weather',
        html: `<p><strong>Kp</strong> (0 to 9) measures geomagnetic disturbance. Storms heat the upper atmosphere and raise drag. <strong>F10.7</strong> is the Sun's radio flux, a proxy for the ultraviolet that inflates the thermosphere.</p>
        <p>Solar flares can send energetic protons (arriving within an hour or two) and coronal mass ejections (one to three days later). Live values come from NOAA SWPC and NASA DONKI when the local server can reach them. Otherwise the simulation uses calm defaults and says so.</p>
        <p>Dose rate rises over the South Atlantic Anomaly, where the inner radiation belt dips lowest.</p>`,
    },
};

const badge = (src) => `<span class="tag" data-status="${src && src.startsWith('LIVE') ? 'live' : ''}">${src && src.startsWith('LIVE') ? 'Live' : 'Simulated'}</span>`;

export function createSpaceView() {
    const el = document.createElement('div');
    el.className = 'view panels cols-2';
    el.innerHTML = `
    <section class="surface wide">
      <div class="block">
        <div class="block-head"><h2>Close approaches</h2><button class="explain" data-explain="conj" aria-label="About conjunction screening">?</button></div>
        <table class="table" aria-label="Upcoming close approaches">
          <thead><tr><th>Object</th><th class="num">Closest approach in</th><th class="num">Miss distance</th><th class="num">Uncertainty σ</th><th class="num">Pc</th><th>Risk</th></tr></thead>
          <tbody id="sp-conj"></tbody>
        </table>
      </div>
      <div class="block">
        <div class="block-head"><h3 id="bp-title">B-plane</h3><button class="explain" data-explain="bplane" aria-label="About the B-plane">?</button></div>
        <div class="bplane">
          <svg id="bp-svg" viewBox="-120 -120 240 240" role="img" aria-label="B-plane geometry"></svg>
          <div>
            <div class="rows" id="bp-rows"><p class="empty">Select an approach to see its geometry.</p></div>
            <div class="suggest" id="bp-suggest" hidden></div>
          </div>
        </div>
      </div>
      <div class="block">
        <div class="block-head"><h3>Recent passes</h3></div>
        <div class="rows" id="sp-hist"><p class="empty">None yet.</p></div>
      </div>
    </section>

    <section class="surface">
      <div class="block">
        <div class="block-head"><h2>Space weather</h2><button class="explain" data-explain="weather" aria-label="About space weather">?</button></div>
        <div class="rows">
          <div class="row"><span>Geomagnetic Kp</span><span id="sw-kp">—</span></div>
          <div class="row"><span>Solar flux F10.7</span><span id="sw-f107">—</span></div>
          <div class="row"><span>Last flare</span><span id="sw-flare">—</span></div>
        </div>
      </div>
      <div class="block">
        <div class="block-head"><h3>Incoming</h3></div>
        <div class="rows" id="sw-pending"></div>
      </div>
      <div class="block">
        <div class="block-head"><h3>Radiation</h3><span id="rad-saa"></span></div>
        <div class="big" id="rad-now">—</div>
        <div class="spark"><canvas id="rad-spark" aria-label="Dose rate history"></canvas><div class="spark-readout"></div></div>
        <div class="rows">
          <div class="row"><span>Mission dose</span><span id="rad-cum">—</span></div>
          <div class="row"><span>Computer upsets since reboot</span><span id="rad-seu">—</span></div>
        </div>
      </div>
    </section>

    <section class="surface">
      <div class="block">
        <div class="block-head"><h2>Radio link</h2><span class="tag" id="cm-tag"></span></div>
        <div class="rows">
          <div class="row"><span>Ground station</span><span id="cm-gs">—</span></div>
          <div class="row"><span>Elevation, range</span><span id="cm-geo">—</span></div>
          <div class="row"><span>Received signal</span><span id="cm-sig">—</span></div>
          <div class="row"><span>Data rate</span><span id="cm-rate">—</span></div>
          <div class="row"><span>One-way delay</span><span id="cm-lat">—</span></div>
          <div class="row"><span>Next pass</span><span id="cm-next">—</span></div>
          <div class="row"><span>Images captured</span><span id="cm-img">—</span></div>
          <div class="row"><span>Downlinked, waiting</span><span id="cm-data">—</span></div>
        </div>
      </div>
      <div class="block">
        <div class="block-head"><h3>Magnetic field</h3><span class="block-note">Tilted-dipole model</span></div>
        <div class="big" id="mag-total">—</div>
        <div class="rows">
          <div class="row"><span>North, east, down</span><span id="mag-ned">—</span></div>
          <div class="row"><span>Declination, inclination</span><span id="mag-dec">—</span></div>
          <div class="row"><span>Storm disturbance</span><span id="mag-pert">—</span></div>
        </div>
      </div>
    </section>`;

    let interval, selectedSeq = null;

    function drawBPlane(ev, st) {
        const svg = el.querySelector('#bp-svg');
        svg.style.display = ev ? '' : 'none';
        if (!ev) { svg.innerHTML = ''; return; }
        const s3 = 3 * ev.sigma_m;
        const extent = Math.max(s3, ev.missDistance_m) * 1.25;
        const k = 110 / extent;
        const mx = ev.zeta * k, my = -ev.xi * k;
        const hb = Math.max(2.5, ev.hardBodyRadius_m * k);
        const scaleM = Math.pow(10, Math.floor(Math.log10(extent / 2)));
        svg.innerHTML = `
          <line x1="-120" y1="0" x2="120" y2="0" stroke="var(--line)"/>
          <line x1="0" y1="-120" x2="0" y2="120" stroke="var(--line)"/>
          <text x="114" y="-6" text-anchor="end" fill="var(--ink-faint)" font-size="10">along-track</text>
          <text x="4" y="-108" fill="var(--ink-faint)" font-size="10">up</text>
          <circle cx="${mx}" cy="${my}" r="${s3 * k}" fill="rgba(240,84,79,0.06)" stroke="${esc(ev.riskColor)}" stroke-dasharray="3 3" stroke-opacity="0.6"/>
          <circle cx="${mx}" cy="${my}" r="${ev.sigma_m * k}" fill="rgba(240,84,79,0.12)" stroke="${esc(ev.riskColor)}" stroke-opacity="0.9"/>
          <line x1="0" y1="0" x2="${mx}" y2="${my}" stroke="var(--ink-dim)" stroke-width="1.5"/>
          <circle cx="${mx}" cy="${my}" r="3.5" fill="${esc(ev.riskColor)}"/>
          <circle cx="0" cy="0" r="${hb}" fill="var(--accent)" fill-opacity="0.35" stroke="var(--accent)"/>
          <line x1="-110" y1="110" x2="${-110 + scaleM * k}" y2="110" stroke="var(--ink-dim)" stroke-width="2"/>
          <text x="-110" y="104" fill="var(--ink-dim)" font-size="10">${scaleM >= 1000 ? `${scaleM / 1000} km` : `${scaleM} m`}</text>`;
        el.querySelector('#bp-rows').innerHTML = `
          <div class="row"><span>Object</span><span>${esc(ev.id)}</span></div>
          <div class="row"><span>Closest approach in</span><span>${esc(fmt.dur(ev.timeToTca_s))}</span></div>
          <div class="row"><span>Predicted miss</span><span>${ev.missDistance_m.toFixed(0)} m (${ev.xi >= 0 ? 'above' : 'below'} by ${Math.abs(ev.xi).toFixed(0)} m)</span></div>
          <div class="row"><span>Uncertainty σ</span><span>${ev.sigma_m.toFixed(0)} m</span></div>
          <div class="row"><span>Relative speed, crossing</span><span>${(ev.relVel_ms / 1000).toFixed(2)} km/s, ${ev.crossingDeg.toFixed(0)}°</span></div>
          <div class="row"><span>Collision probability</span><span style="color:${esc(ev.riskColor)}">${esc(ev.pcFormatted)} (${esc(ev.riskLabel.toLowerCase())})</span></div>
          <div class="row"><span>Peak Pc so far</span><span>${ev.peakPc.toExponential(1)}${ev.maneuvered ? ', manoeuvred' : ''}</span></div>`;
        const sug = el.querySelector('#bp-suggest');
        if (ev.pc >= 1e-5) {
            const n = meanMotion(st.orbit.baseAltitude);
            const sol = app.sat.conjunctions.solveAvoidance(st.missionTime, n, { maxDv: 1.0 });
            const dir = sol ? (sol.vectorRTN[1] > 0 ? 'prograde' : sol.vectorRTN[1] < 0 ? 'retrograde' : sol.vectorRTN[0] > 0 ? 'radial out' : 'radial in') : '';
            sug.hidden = false;
            sug.textContent = sol
                ? `Smallest burn that clears every upcoming approach right now: ${sol.deltaV.toFixed(2)} m/s ${dir} (worst Pc after: ${sol.worstPc.toExponential(1)}). The planner decides whether and when to fire.`
                : 'No burn up to 1 m/s clears every approach from here.';
        } else sug.hidden = true;
    }

    function update() {
        const st = app.sat.getFullState();
        const evs = st.conjunctions;
        if (!evs.some(e => e.seq === selectedSeq)) selectedSeq = evs.reduce((a, b) => (!a || b.pc > a.pc ? b : a), null)?.seq ?? null;
        const tb = el.querySelector('#sp-conj');
        tb.innerHTML = evs.length ? evs.map(e => `
          <tr data-seq="${e.seq}" aria-selected="${e.seq === selectedSeq}" tabindex="0">
            <td>${esc(e.name)}</td><td class="num">${esc(fmt.dur(e.timeToTca_s))}</td>
            <td class="num">${e.missDistance_m >= 1000 ? `${(e.missDistance_m / 1000).toFixed(2)} km` : `${e.missDistance_m.toFixed(0)} m`}</td>
            <td class="num">${e.sigma_m.toFixed(0)} m</td><td class="num">${esc(e.pcFormatted)}</td>
            <td><span class="tag" data-status="${e.pc >= 1e-4 ? 'critical' : e.pc >= 1e-5 ? 'warning' : 'nominal'}">${esc(e.riskLabel[0] + e.riskLabel.slice(1).toLowerCase())}</span></td>
          </tr>`).join('') : '<tr class="empty-row"><td colspan="6">Nothing in the screening window. New approaches are reported a few hours ahead.</td></tr>';
        tb.querySelectorAll('tr[data-seq]').forEach(tr => {
            const pick = () => { selectedSeq = +tr.dataset.seq; update(); };
            tr.addEventListener('click', pick);
            tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
        });
        const sel = evs.find(e => e.seq === selectedSeq);
        setText(el, '#bp-title', sel ? `B-plane: ${sel.name}` : 'B-plane');
        drawBPlane(sel, st);
        if (!sel) { el.querySelector('#bp-rows').innerHTML = '<p class="empty">Select an approach to see its geometry.</p>'; el.querySelector('#bp-suggest').hidden = true; }

        el.querySelector('#sp-hist').innerHTML = st.conjunctionHistory.length ? st.conjunctionHistory.slice(0, 5).map(h =>
            `<div class="row"><span>${esc(h.name)}${h.maneuvered ? ', after a burn' : ''}</span><span>missed by ${h.realizedMiss_m >= 1000 ? `${(h.realizedMiss_m / 1000).toFixed(2)} km` : `${h.realizedMiss_m.toFixed(0)} m`}</span></div>`).join('')
            : '<p class="empty">None yet.</p>';

        // space weather
        const sw = st.spaceWeather;
        el.querySelector('#sw-kp').innerHTML = `${sw.kp.toFixed(1)} ${badge(app.sources.kp)}`;
        el.querySelector('#sw-f107').innerHTML = `${sw.f107.toFixed(0)} sfu ${badge(app.sources.f107)}`;
        setText(el, '#sw-flare', sw.lastFlare ? `${sw.lastFlare.classType}, ${String(sw.lastFlare.beginTime).slice(0, 16).replace('T', ' ')}` : 'None reported');
        el.querySelector('#sw-pending').innerHTML = sw.pending.length ? sw.pending.map(p =>
            `<div class="row"><span>${p.type === 'SEP' ? 'Solar protons' : 'CME storm'}: ${esc(p.label)}</span><span>in ${esc(fmt.dur(p.inS))}</span></div>`).join('')
            : '<p class="empty">Nothing on the way.</p>';
        const rd = st.sensors.radiationDetector;
        setText(el, '#rad-now', `${rd.currentDose.toFixed(3)} mSv/h`);
        el.querySelector('#rad-now').style.color = rd.currentDose > 1 ? 'var(--critical)' : rd.currentDose > 0.2 ? 'var(--caution)' : '';
        el.querySelector('#rad-saa').innerHTML = rd.saaPassingGrade ? '<span class="tag" data-status="warning">South Atlantic Anomaly</span>' : '';
        setText(el, '#rad-cum', `${rd.cumulativeDose.toFixed(3)} mSv`);
        setText(el, '#rad-seu', `${st.sections.onboardComputer.errorCount}`);
        drawSparkline(el.querySelector('#rad-spark'), st.history.slice(-240).map(h => ({ t: h.t, v: h.dose })), { min: 0, format: v => `${v.toFixed(3)} mSv/h` });

        // comms
        const c = st.sections.commArray, o = st.orbit;
        const tag = el.querySelector('#cm-tag');
        tag.dataset.status = !c.antennaOk ? 'critical' : c.linkStatus === 'LOST' ? '' : 'good';
        tag.textContent = !c.antennaOk ? 'Radio locked up' : c.linkStatus === 'LOST' ? 'No station in view' : c.linkStatus === 'STRONG' ? 'Strong link' : 'Weak link';
        setText(el, '#cm-gs', c.station || 'None in view');
        setText(el, '#cm-geo', `${c.elevationDeg.toFixed(1)}°, ${fmt.int(c.rangeKm)} km`);
        setText(el, '#cm-sig', c.linkStatus === 'LOST' ? '—' : `${c.signalStrength.toFixed(1)} dBm`);
        setText(el, '#cm-rate', c.dataRate ? `${c.dataRate} bit/s` : '—');
        setText(el, '#cm-lat', c.signalLatency_ms ? `${c.signalLatency_ms.toFixed(1)} ms` : '—');
        const np = o.nextContact;
        setText(el, '#cm-next', !np ? 'None in the next 24 h' : o.timeToNextContact === 0 ? `Now, ${np.durationMin.toFixed(0)} min pass` : `${np.station} in ${fmt.dur(o.timeToNextContact * 60)}, ${np.durationMin.toFixed(0)} min, peak ${np.maxElevation.toFixed(0)}°`);
        setText(el, '#cm-img', `${st.mission.imagesCaptured}`);
        setText(el, '#cm-data', `${(st.mission.dataDownlinkedMB * 1000).toFixed(0)} kB sent, ${(st.mission.dataBufferedMB * 1000).toFixed(0)} kB queued`);

        const mag = st.sensors.magnetometer;
        setText(el, '#mag-total', `${fmt.int(mag.fieldStrength)} nT`);
        const ned = mag.components || { north: 0, east: 0, down: 0 };
        setText(el, '#mag-ned', `${fmt.int(ned.north)}, ${fmt.int(ned.east)}, ${fmt.int(ned.down)} nT`);
        setText(el, '#mag-dec', `${st.environment.magneticDeclination.toFixed(1)}°, ${st.environment.magneticInclination.toFixed(1)}°`);
        setText(el, '#mag-pert', mag.perturbation ? `${mag.perturbation.toFixed(0)} nT${mag.anomalyDetected ? ' (anomaly)' : ''}` : 'None');
    }

    return {
        element: el,
        init() { bindExplainers(el, EXPLAIN); update(); interval = setInterval(update, 1000); },
        destroy() { clearInterval(interval); },
    };
}
