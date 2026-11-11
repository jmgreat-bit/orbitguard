/**
 * Crisis alert — a non-blocking panel for CRITICAL plans and safety overrides.
 * Shows what happened, a telemetry snapshot, and each step's live state.
 * All planner text is escaped (it used to go straight into innerHTML).
 */
import { esc, describeCommand, fmt } from './dom.js';

let el, timer, closeTimer, current = null, lastKey = '', lastAt = 0;
const LINGER_MS = 20000; // a finished plan's alert stays this long, then gets out of the way (it remains in the log)

export function initCrisisAlert() {
    if (el) return;
    el = document.createElement('section');
    el.className = 'alert';
    el.setAttribute('role', 'alert');
    el.innerHTML = `
      <div class="alert-head">
        <div><div class="alert-kicker" id="al-kicker"></div><div class="alert-reason" id="al-reason"></div></div>
        <div class="alert-actions">
          <button class="btn al-explain" id="al-explain">Explain</button>
          <button class="icon-btn" id="al-min" aria-label="Minimise">–</button>
          <button class="icon-btn" id="al-close" aria-label="Dismiss">×</button>
        </div>
      </div>
      <div class="alert-body">
        <div class="alert-telem" id="al-telem"></div>
        <ol class="steps" id="al-steps"></ol>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#al-close').addEventListener('click', dismissAlert);
    el.querySelector('#al-explain').addEventListener('click', () => {
        const k = el.querySelector('#al-kicker').textContent, r = el.querySelector('#al-reason').textContent;
        window.dispatchEvent(new CustomEvent('orbitguard:ask', { detail: { question: `Explain this alert in plain words and tell me whether I need to act: ${k}. ${r} (${current?.code || current?.plan_id || ''})` } }));
    });
    el.querySelector('#al-min').addEventListener('click', () => el.classList.toggle('min'));
}

/**
 * @param {object} plan  { priority, summary|reason, commands, plan_id, applied?, source? }
 * @param {object} sat   VirtualSatellite
 */
export function fireCrisisAlert(plan, sat) {
    if (!el) initCrisisAlert();
    const key = plan.code || plan.summary;
    if (key === lastKey && Date.now() - lastAt < 60000) return; // de-duplicate
    lastKey = key; lastAt = Date.now();
    current = plan;
    el.dataset.priority = plan.priority === 'CRITICAL' ? 'CRITICAL' : 'HIGH';
    el.classList.remove('min');
    el.querySelector('#al-kicker').textContent = plan.applied ? 'Safety supervisor took over' : `Critical plan from ${plan.source || 'planner'}`;
    el.querySelector('#al-reason').textContent = plan.summary || plan.reason || 'Anomaly detected';
    const s = sat.sections, env = sat.environment;
    const worst = sat.conjunctions.mostDangerous();
    el.querySelector('#al-telem').innerHTML = [
        ['Battery', `${s.batteryBay.charge.toFixed(0)}%`],
        ['Computer', `${s.onboardComputer.temperature.toFixed(0)} °C`],
        ['Altitude', `${sat.orbit.baseAltitude.toFixed(1)} km`],
        ['Dose rate', `${env.radiationLevel.toFixed(2)} mSv/h`],
        ['Sunlight', env.inSunlight ? 'Sunlit' : 'Eclipse'],
        ['Worst Pc', worst ? worst.pcFormatted : 'None'],
    ].map(([k, v]) => `<div><span>${esc(k)}</span>${esc(v)}</div>`).join('');
    renderSteps(sat);
    el.classList.add('open');
    clearInterval(timer);
    clearTimeout(closeTimer);
    timer = setInterval(() => renderSteps(sat), 300);
}

function renderSteps(sat) {
    if (!current) return;
    const f = sat.flightController.status();
    const mine = f.plan?.plan_id === current.plan_id;
    const finished = f.recent.find(r => r.plan_id === current.plan_id);
    el.querySelector('#al-steps').innerHTML = (current.commands || []).map((c, i) => {
        let state = 'queued', word = 'Queued';
        if (current.applied) { state = 'done'; word = 'Applied'; }
        else if (finished) { state = 'done'; word = finished.outcome === 'completed' ? 'Done' : 'Aborted'; }
        else if (mine && i < f.stepIndex) { state = 'done'; word = 'Done'; }
        else if (mine && i === f.stepIndex) { state = 'active'; word = f.stepPhase === 'align' ? 'Aligning' : f.stepType === 'EXECUTE_BURN' ? `Firing ${Math.round(f.stepFraction * 100)}%` : 'Running'; }
        return `<li data-state="${state}"><span>${esc(describeCommand(c))}</span><em>${esc(word)}</em></li>`;
    }).join('');
    if (finished || current.applied) clearInterval(timer);
    // The plan has run its course: leave the result on screen briefly, then stop covering the readings.
    // Supervisor overrides stay until dismissed, because the override itself is still in force.
    if (finished && !current.applied) {
        const shown = current;
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => { if (current === shown && !el.matches(':hover, :focus-within')) dismissAlert(); }, LINGER_MS);
    }
}

export function dismissAlert() {
    el?.classList.remove('open');
    clearInterval(timer);
    clearTimeout(closeTimer);
}
