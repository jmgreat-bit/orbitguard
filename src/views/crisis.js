// Drills & log — inject failures, choose the planner, watch the controller and the full log.
import { app } from '../app.js';
import { MISSION_LOG, onLog } from '../log.js';
import { esc, fmt, setText, describeCommand } from '../ui/dom.js';

const DRILLS = [
    { id: 'debris_close', title: 'Debris on a collision course', desc: 'A tracked fragment, closest approach in about an hour, Pc around 1e-3.' },
    { id: 'thermal_runaway', title: 'Overheating computer', desc: 'A reaction wheel is driven against its brake and the heat strap fails.' },
    { id: 'battery_drain', title: 'Battery cell failure', desc: 'Charge drops to about 14 % and capacity is reduced.' },
    { id: 'solar_flare', title: 'X-class solar flare', desc: 'Energetic protons in about 20 min, a CME storm in about 6 h.' },
    { id: 'cme_incoming', title: 'CME on the way', desc: 'Geomagnetic storm in 30 to 60 min: more drag, more radiation.' },
    { id: 'solar_panel_a_fail', title: 'Solar wing hit', desc: 'A micrometeoroid cuts wing A to 15 % output.' },
    { id: 'comm_blackout', title: 'Radio lock-up', desc: 'The transmitter firmware hangs. A computer reboot fixes it.' },
    { id: 'orbital_decay', title: 'Severe geomagnetic storm', desc: 'Kp 8.3 now: the upper atmosphere swells and drag climbs.' },
    { id: 'all_clear', title: 'Reset drills', desc: 'Clear injected faults, calm space weather, empty the screening list.' },
];

export function createCrisisView() {
    const el = document.createElement('div');
    el.className = 'view panels log-layout';
    el.innerHTML = `
    <section class="surface wide">
      <div class="block">
        <div class="block-head"><h2>Drills</h2><span class="block-note">Each one is handled by the planner and the safety supervisor, exactly as in flight.</span></div>
        <div class="drills">${DRILLS.map(d => `<button class="drill" data-drill="${d.id}"><b>${esc(d.title)}</b><span>${esc(d.desc)}</span></button>`).join('')}</div>
      </div>
    </section>

    <section class="surface">
      <div class="block">
        <div class="block-head"><h2>Planner</h2></div>
        <p class="planner-line" id="pl-status">—</p>
        <div class="seg" role="group" aria-label="Who plans">
          <button class="btn" data-mode="auto">Gemini when available</button>
          <button class="btn" data-mode="autopilot">Autopilot only</button>
        </div>
        <div style="margin-top:10px"><button class="btn btn-primary" id="pl-now">Plan now</button></div>
        <div class="rows" style="margin-top:12px">
          <div class="row"><span>Last decision</span><span id="pl-last">—</span></div>
          <div class="row"><span>Battery override</span><span id="sup-bat">—</span></div>
          <div class="row"><span>Thermal override</span><span id="sup-th">—</span></div>
        </div>
      </div>
      <div class="block">
        <div class="block-head"><h3>Flight controller</h3></div>
        <div id="fc-now"></div>
        <div class="block-head" style="margin-top:12px"><h3>Queued</h3></div>
        <div class="rows" id="fc-queue"></div>
        <div class="block-head" style="margin-top:12px"><h3>Finished</h3></div>
        <div class="rows" id="fc-recent"></div>
      </div>
    </section>

    <section class="surface">
      <div class="block">
        <div class="block-head"><h2>Mission log</h2>
          <div class="filters seg" role="group" aria-label="Filter">
            <button class="btn" data-filter="all" aria-pressed="true">All</button>
            <button class="btn" data-filter="warn" aria-pressed="false">Warnings</button>
            <button class="btn" data-filter="critical" aria-pressed="false">Critical</button>
          </div>
        </div>
        <ul class="log log-full" id="log-full"></ul>
      </div>
    </section>`;

    let interval, unsub, filter = 'all', shown = [];
    el.querySelector('#log-full').addEventListener('click', (ev) => {
        const b = ev.target.closest('.log-explain');
        if (b && shown[Number(b.dataset.i)]) window.dispatchEvent(new CustomEvent('orbitguard:explain-entry', { detail: shown[Number(b.dataset.i)] }));
    });

    function renderLog() {
        const keep = filter === 'all' ? () => true : filter === 'critical' ? e => e.level === 'critical' : e => e.level !== 'nominal';
        shown = MISSION_LOG.filter(keep).slice(0, 120);
        el.querySelector('#log-full').innerHTML = shown.map((e, i) => `
          <li data-level="${esc(e.level)}">
            <div class="log-head"><span class="log-action">${esc(e.action)}</span><span class="log-meta">${esc(fmt.clock(e.missionTime))}, ${esc(e.source)}</span><button class="log-explain" data-i="${i}" aria-label="Explain ${esc(e.action)}">Explain</button></div>
            <div class="log-reason">${esc(e.reason)}</div>
          </li>`).join('') || '<li class="empty">No entries for this filter.</li>';
    }

    function update() {
        const st = app.sat.getFullState();
        const pl = app.planner;
        setText(el, '#pl-status', pl.status);
        el.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === pl.mode)));
        setText(el, '#pl-last', pl.lastDecisionAt ? `${Math.round((Date.now() - pl.lastDecisionAt) / 1000)} s ago by ${pl.using}` : '—');
        const sup = st.flight.supervisor;
        setText(el, '#sup-bat', sup.battery ? 'Active' : 'Off').className = sup.battery ? 'status-word' : '';
        el.querySelector('#sup-bat').dataset.status = sup.battery ? 'critical' : '';
        setText(el, '#sup-th', sup.thermal ? 'Active' : 'Off').dataset.status = sup.thermal ? 'critical' : '';
        el.querySelector('#sup-th').className = sup.thermal ? 'status-word' : '';

        const f = st.flight;
        el.querySelector('#fc-now').innerHTML = f.paused ? '<p class="empty">Computer rebooting, nothing executes.</p>'
            : f.plan ? `<p class="plan-summary"><b>${esc(f.plan.priority.toLowerCase())}</b> from ${esc(f.plan.source)}: ${esc(f.plan.summary)}</p>
              <ol class="steps">${f.plan.commands.map((c, i) => `<li data-state="${i < f.stepIndex ? 'done' : i === f.stepIndex ? 'active' : 'queued'}"><span>${esc(describeCommand(c))}</span><em>${i < f.stepIndex ? 'Done' : i === f.stepIndex ? (f.stepPhase === 'align' ? 'Aligning' : 'Running') : 'Queued'}</em></li>`).join('')}</ol>`
                : '<p class="empty">Idle.</p>';
        el.querySelector('#fc-queue').innerHTML = f.queue.length ? f.queue.map(q => `<div class="row"><span>${esc(q.summary.slice(0, 80))}</span><span>${esc(q.priority.toLowerCase())}</span></div>`).join('') : '<p class="empty">Empty.</p>';
        el.querySelector('#fc-recent').innerHTML = f.recent.length ? f.recent.slice(0, 5).map(r => `<div class="row"><span>${esc(r.summary.slice(0, 80))}</span><span class="status-word" data-status="${r.outcome === 'completed' ? 'nominal' : 'warning'}">${esc(r.outcome)}${r.reason ? `: ${esc(r.reason)}` : ''}</span></div>`).join('') : '<p class="empty">Nothing yet.</p>';
    }

    return {
        element: el,
        init() {
            el.querySelectorAll('[data-drill]').forEach(b => b.addEventListener('click', () => {
                app.injectDrill(b.dataset.drill);
                b.dataset.flash = 'true';
                setTimeout(() => { b.dataset.flash = 'false'; }, 700);
            }));
            el.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { app.planner.mode = b.dataset.mode; app.planner.status = b.dataset.mode === 'autopilot' ? 'Autopilot only (Gemini switched off here)' : app.planner.online ? `Gemini (${app.planner.model}) ready` : app.planner.status; update(); }));
            el.querySelector('#pl-now').addEventListener('click', () => app.requestDecision('operator'));
            el.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
                filter = b.dataset.filter;
                el.querySelectorAll('[data-filter]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
                renderLog();
            }));
            update(); renderLog();
            interval = setInterval(update, 500);
            unsub = onLog(renderLog); // removed on destroy (the old view leaked this listener)
        },
        destroy() { clearInterval(interval); unsub?.(); },
    };
}
