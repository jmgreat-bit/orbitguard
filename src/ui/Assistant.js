/**
 * Floating assistant: a button that opens a chat panel which explains the system and
 * anything shown on screen (alerts, log lines, errors). Uses Gemini through /api/assist
 * when a key is configured; otherwise answers from the built-in knowledge base.
 */
import { app } from '../app.js';
import { MISSION_LOG, onLog } from '../log.js';
import { esc } from './dom.js';
import { buildAssistContext, installErrorCapture } from '../assistant/context.js';
import { localAnswer } from '../assistant/knowledge.js';

/** Escape first, then allow only **bold**, `code` and "- " bullets. */
export function renderAnswer(text) {
    const lines = esc(text).split('\n');
    const out = [];
    let list = false;
    for (const raw of lines) {
        const inline = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
        const m = inline.match(/^\s*[-*]\s+(.*)$/);
        if (m) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${m[1]}</li>`); continue; }
        if (list) { out.push('</ul>'); list = false; }
        if (inline.trim()) out.push(`<p>${inline}</p>`);
    }
    if (list) out.push('</ul>');
    return out.join('');
}

const CHIPS = [
    ['What is OrbitGuard?', 'What is OrbitGuard and how does it work?'],
    ['Explain the latest alert', null],
    ['What is happening right now?', 'Summarise what the spacecraft is doing right now and whether anything needs my attention.'],
    ['What do SIMULATED badges mean?', 'What do the SIMULATED badges mean?'],
];

export function initAssistant() {
    installErrorCapture();
    const root = document.createElement('div');
    root.className = 'assistant';
    root.innerHTML = `
      <button class="assistant-fab" id="assistant-fab" aria-label="Ask the OrbitGuard assistant" aria-expanded="false" aria-controls="assistant-panel">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="9" cy="10.5" r="1.1" fill="currentColor"/><circle cx="12.5" cy="10.5" r="1.1" fill="currentColor"/><circle cx="16" cy="10.5" r="1.1" fill="currentColor"/></svg>
        <span class="assistant-fab-label">Ask</span>
        <span class="assistant-dot" hidden></span>
      </button>
      <section class="assistant-panel" id="assistant-panel" role="dialog" aria-label="OrbitGuard assistant" hidden>
        <header>
          <div><strong>Ask OrbitGuard</strong><span class="assistant-mode" id="assistant-mode"></span></div>
          <button class="icon-btn" id="assistant-close" aria-label="Close assistant">×</button>
        </header>
        <div class="assistant-msgs" id="assistant-msgs" aria-live="polite"></div>
        <div class="assistant-chips" id="assistant-chips"></div>
        <form class="assistant-form" id="assistant-form">
          <input id="assistant-input" type="text" maxlength="1000" autocomplete="off" placeholder="Ask about the system or an alert…" aria-label="Your question">
          <button class="btn btn-primary" type="submit">Ask</button>
        </form>
      </section>`;
    document.body.appendChild(root);

    const $ = (id) => root.querySelector('#' + id);
    const fab = $('assistant-fab'), panel = $('assistant-panel'), msgs = $('assistant-msgs');
    const input = $('assistant-input'), dot = root.querySelector('.assistant-dot');
    const history = [];
    let busy = false;
    // The button lives in the top bar (it used to float over the bottom-right corner, on top of readings).
    document.querySelector('.top-bar .warp')?.appendChild(fab);

    const mode = () => { $('assistant-mode').textContent = app.planner.online ? ` · Gemini` : ' · built-in answers'; };

    function add(role, html, cls = '') {
        const d = document.createElement('div');
        d.className = `amsg ${role} ${cls}`;
        d.innerHTML = html;
        msgs.appendChild(d);
        msgs.scrollTop = msgs.scrollHeight;
        return d;
    }

    function open(on = true) {
        panel.hidden = !on;
        fab.setAttribute('aria-expanded', String(on));
        if (on) {
            dot.hidden = true;
            mode();
            if (!msgs.children.length) add('bot', renderAnswer('Hi, I can explain how OrbitGuard works, and any warning, error or number on screen. Pick a question below or type your own.'));
            input.focus();
        } else fab.focus();
    }

    async function ask(question) {
        const q = question.trim();
        if (!q || busy) return;
        busy = true;
        add('user', esc(q));
        const pending = add('bot', 'Thinking…', 'pending');
        let answer, via = 'built-in';
        try {
            if (!app.planner.online) throw Object.assign(new Error('offline'), { offline: true });
            const page = location.hash.replace('#', '') || 'home';
            const r = await fetch('/api/assist', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ question: q, context: buildAssistContext(app, MISSION_LOG, page), history }),
                signal: AbortSignal.timeout(45000),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            answer = j.answer; via = 'Gemini';
            history.push({ role: 'user', text: q }, { role: 'model', text: answer });
            if (history.length > 12) history.splice(0, history.length - 12);
        } catch (e) {
            answer = localAnswer(q);
            if (!e.offline) answer += `\n\n(The AI could not answer: ${e.message}. This is a built-in answer.)`;
        }
        pending.classList.remove('pending');
        pending.innerHTML = renderAnswer(answer) + `<span class="amsg-via">${esc(via)}</span>`;
        msgs.scrollTop = msgs.scrollHeight;
        busy = false;
    }

    function latestAlert() {
        return MISSION_LOG.find(e => e.level === 'critical' || e.level === 'warning');
    }
    function explainEntry(e) {
        return `Explain this log entry in plain words and tell me whether I need to do anything: ${e.action} (${e.source}, ${e.level}): ${e.reason}`;
    }

    // chips
    $('assistant-chips').innerHTML = CHIPS.map(([label], i) => `<button type="button" class="chip" data-i="${i}">${esc(label)}</button>`).join('');
    $('assistant-chips').addEventListener('click', (ev) => {
        const b = ev.target.closest('.chip'); if (!b) return;
        const [label, q] = CHIPS[Number(b.dataset.i)];
        if (q) return ask(q);
        const a = latestAlert();
        if (!a) { add('user', esc(label)); add('bot', renderAnswer('There are no warnings or critical alerts in the log right now. Everything logged is nominal or advisory.')); return; }
        ask(explainEntry(a));
    });

    fab.addEventListener('click', () => open(panel.hidden));
    $('assistant-close').addEventListener('click', () => open(false));
    root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { e.stopPropagation(); open(false); } });
    $('assistant-form').addEventListener('submit', (e) => { e.preventDefault(); const v = input.value; input.value = ''; ask(v); });

    // other parts of the UI can ask the assistant things
    window.addEventListener('orbitguard:ask', (e) => { open(true); if (e.detail?.question) ask(e.detail.question); });
    window.addEventListener('orbitguard:explain-entry', (e) => { const entry = e.detail; if (entry) { open(true); ask(explainEntry(entry)); } });

    // nudge when something serious is logged and the panel is closed
    onLog((e) => { if (panel.hidden && (e.level === 'critical' || e.level === 'warning')) dot.hidden = false; });
}
