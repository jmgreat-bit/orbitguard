// Hash router. Builds a view once per navigation (setting the hash used to fire
// hashchange and build every view twice) and always tears the previous one down.

export class Router {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.routes = {};
        this.current = null;
        this.currentView = null;
        window.addEventListener('hashchange', () => this.navigate());
    }

    register(hash, viewFactory) {
        this.routes[hash] = viewFactory;
    }

    navigate(hash) {
        let target = hash || window.location.hash.slice(1) || 'home';
        if (!this.routes[target]) target = 'home';
        if (window.location.hash.slice(1) !== target) {
            history.replaceState(null, '', `#${target}`);
        }
        if (target === this.current) return;
        this.current = target;

        try { this.currentView?.destroy?.(); } catch (e) { console.error('view teardown failed', e); }
        this.container.innerHTML = '';
        this.currentView = this.routes[target]();
        this.container.appendChild(this.currentView.element);
        this.currentView.init?.();
        this.container.scrollTop = 0;

        document.querySelectorAll('.nav-btn').forEach(btn => {
            const on = btn.dataset.page === target;
            btn.classList.toggle('active', on);
            if (on) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
        });
    }
}
