/**
 * Explainer modal. (Moved out of main.js — views used to import main.js dynamically,
 * a circular import.) Content passed as HTML must be static, trusted markup.
 */
let overlay, title, body, lastFocus;

export function initModal() {
    overlay = document.getElementById('card-modal');
    title = document.getElementById('card-modal-title');
    body = document.getElementById('card-modal-body');
    document.getElementById('card-modal-close').addEventListener('click', hideModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideModal(); });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) hideModal(); });
}

export function showModal(heading, trustedHtml) {
    if (!overlay) initModal();
    lastFocus = document.activeElement;
    title.textContent = heading;
    body.innerHTML = trustedHtml;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    document.getElementById('card-modal-close').focus();
}

export function hideModal() {
    overlay?.classList.remove('open');
    overlay?.setAttribute('aria-hidden', 'true');
    lastFocus?.focus?.();
}

/** Wire every [data-explain] button inside root to an entry of `texts`. */
export function bindExplainers(root, texts) {
    root.querySelectorAll('[data-explain]').forEach(btn => {
        btn.addEventListener('click', () => {
            const t = texts[btn.dataset.explain];
            if (t) showModal(t.title, t.html);
        });
    });
}
