// Simple hash-based page router

export class Router {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.routes = {};
        this.currentView = null;

        window.addEventListener('hashchange', () => this.navigate());
    }

    register(hash, viewFactory) {
        this.routes[hash] = viewFactory;
    }

    navigate(hash) {
        const target = hash || window.location.hash.slice(1) || 'home';
        window.location.hash = target;

        const factory = this.routes[target];
        if (!factory) return;

        // Destroy current view
        if (this.currentView && this.currentView.destroy) {
            this.currentView.destroy();
        }

        // Clear container & build new view
        this.container.innerHTML = '';
        this.currentView = factory();
        this.container.appendChild(this.currentView.element);

        if (this.currentView.init) {
            this.currentView.init();
        }

        // Update nav buttons
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.page === target);
        });
    }
}
