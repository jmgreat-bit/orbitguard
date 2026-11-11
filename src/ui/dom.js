/** Small DOM helpers shared by the views. */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape any text before it goes into innerHTML (planner output is untrusted). */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);

export function setText(root, sel, text) {
    const el = typeof sel === 'string' ? root.querySelector(sel) : sel;
    if (el && el.textContent !== String(text)) el.textContent = text;
    return el;
}

export function setStatus(el, status) {
    if (!el) return;
    el.dataset.status = status;
}

export const fmt = {
    num: (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—'),
    int: (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—'),
    dur(sec) {
        if (!Number.isFinite(sec)) return '—';
        const s = Math.max(0, Math.round(sec));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
        if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
        if (m > 0) return `${m} min ${String(r).padStart(2, '0')} s`;
        return `${r} s`;
    },
    clock(sec) {
        const s = Math.max(0, Math.floor(sec || 0));
        const d = Math.floor(s / 86400);
        const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        return `T+${d ? `${d}d ` : ''}${hh}:${mm}:${ss}`;
    },
    days(d) {
        if (!Number.isFinite(d)) return 'over 100 years';
        if (d > 730) return `${(d / 365.25).toFixed(1)} years`;
        if (d > 2) return `${Math.round(d)} days`;
        return `${(d * 24).toFixed(1)} hours`;
    },
    level: { nominal: 'Nominal', caution: 'Caution', warning: 'Warning', critical: 'Critical' },
};

/** Human labels for internal enums. */
export const LABELS = {
    SUN_TRACKING: 'Sun-pointing', EARTH_NADIR: 'Earth-pointing (nadir)', VELOCITY_ALIGNED: 'Velocity-aligned',
    DEEP_SPACE: 'Sun-avoid (cooling)', MANEUVER_ALIGNMENT: 'Thruster alignment', SAFE_TUMBLE_STOP: 'Detumbling',
    NOMINAL: 'Nominal', LOW_POWER: 'Low power', SURVIVAL: 'Survival', CHARGE_PRIORITY: 'Charge priority',
    OFF: 'Off', STANDBY: 'Standby', ACTIVE: 'Active',
    SET_ATTITUDE_MODE: 'Change attitude', PLAN_BURN: 'Plan burn', EXECUTE_BURN: 'Fire thruster',
    SET_POWER_MODE: 'Power mode', SET_PAYLOAD_STATE: 'Payload', ENTER_SAFE_MODE: 'Enter safe mode',
    EXIT_SAFE_MODE: 'Exit safe mode', RESET_OBC: 'Reboot computer',
};
export const label = (k) => LABELS[k] || k;

export function describeCommand(c) {
    const p = c.params || {};
    switch (c.type) {
        case 'SET_ATTITUDE_MODE': return `Point: ${label(p.target)}`;
        case 'PLAN_BURN': {
            const v = p.vector || [0, 0, 0];
            const dir = Math.abs(v[0]) >= Math.max(Math.abs(v[1]), Math.abs(v[2])) ? (v[0] >= 0 ? 'prograde' : 'retrograde')
                : Math.abs(v[1]) >= Math.abs(v[2]) ? (v[1] >= 0 ? 'radial out' : 'radial in') : 'out of plane';
            return `Plan ${fmt.num(p.delta_v, 2)} m/s ${dir} burn`;
        }
        case 'SET_POWER_MODE': return `Power: ${label(p.mode)}`;
        case 'SET_PAYLOAD_STATE': return `Payload: ${label(p.state)}`;
        default: return label(c.type);
    }
}

/**
 * Single-series sparkline on a canvas with a hover readout.
 * series: [{t, v}], opts: {color, min, max, format(v), unit, band:[lo,hi]}
 */
export function drawSparkline(canvas, series, opts = {}) {
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--line').trim() || '#22324D';
    const color = opts.color || css.getPropertyValue('--accent').trim();
    if (series.length < 2) {
        ctx.fillStyle = css.getPropertyValue('--ink-dim').trim();
        ctx.font = '12px Barlow, system-ui';
        ctx.fillText('Collecting data…', 4, h / 2 + 4);
        return;
    }
    const vs = series.map(p => p.v);
    let lo = opts.min ?? Math.min(...vs), hi = opts.max ?? Math.max(...vs);
    if (hi - lo < 1e-9) { hi += 1; lo -= 1; }
    const pad = 4;
    const x = (i) => pad + (i / (series.length - 1)) * (w - 2 * pad);
    const y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
    if (opts.band) {
        ctx.fillStyle = 'rgba(140,150,163,0.10)';
        const [b0, b1] = opts.band;
        ctx.fillRect(0, y(Math.min(hi, b1)), w, y(Math.max(lo, b0)) - y(Math.min(hi, b1)));
    }
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath();
    series.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.v)) : ctx.moveTo(x(i), y(p.v))));
    ctx.stroke();
    const hover = canvas._hover;
    const idx = hover == null ? series.length - 1 : Math.round(((hover - pad) / (w - 2 * pad)) * (series.length - 1));
    const i = Math.max(0, Math.min(series.length - 1, idx));
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x(i), y(series[i].v), 4, 0, Math.PI * 2); ctx.fill();
    if (hover != null) {
        ctx.strokeStyle = grid; ctx.beginPath(); ctx.moveTo(x(i), 0); ctx.lineTo(x(i), h); ctx.stroke();
    }
    const tip = canvas.parentElement?.querySelector('.spark-readout');
    if (tip) {
        const p = series[i];
        tip.textContent = `${opts.format ? opts.format(p.v) : p.v.toFixed(1)}${hover != null ? `  at T+${(p.t / 3600).toFixed(2)} h` : ''}`;
    }
    if (!canvas._bound) {
        canvas._bound = true;
        canvas.addEventListener('pointermove', e => { canvas._hover = e.offsetX; canvas._redraw?.(); });
        canvas.addEventListener('pointerleave', () => { canvas._hover = null; canvas._redraw?.(); });
    }
    canvas._redraw = () => drawSparkline(canvas, series, opts);
}

/** Diverging cold→neutral→hot colour for a temperature against its limits. */
export function thermalColor(t, L) {
    const mid = (L.warnLo + L.warnHi) / 2;
    const cold = [74, 143, 231], neutral = [140, 150, 163], hot = [229, 83, 75];
    let k, a, b;
    if (t >= mid) { k = Math.min(1, (t - mid) / (L.critHi - mid)); a = neutral; b = hot; }
    else { k = Math.min(1, (mid - t) / (mid - L.critLo)); a = neutral; b = cold; }
    k = Math.pow(Math.max(0, k), 0.8);
    return a.map((c, i) => Math.round(c + (b[i] - c) * k));
}
