/** Shared application state, filled in by main.js and read by the views. */
export const TIME_SPEEDS = [1, 5, 10, 50, 100, 500];

export const app = {
    sat: null,
    warp: 1,
    paused: false,
    autoSlow: true,
    planner: {
        mode: 'auto',           // 'auto' (Gemini if available) | 'autopilot'
        using: 'autopilot',     // what actually decided last
        status: 'Checking the planner server…',
        model: null,
        online: false,
        lastDecisionAt: null,
        lastLatencyMs: null,
        lastSummary: '',
    },
    sources: { tle: 'SIMULATED', kp: 'SIMULATED', f107: 'SIMULATED', flares: 'SIMULATED' },
    requestDecision: () => { },
    injectDrill: () => { },
    setWarp: () => { },
};
