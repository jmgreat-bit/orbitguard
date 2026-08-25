/**
 * CrisisAlert.js
 * Full-screen crisis popup that fires when the FlightController detects
 * an EMERGENCY or HIGH priority event.
 * 
 * Shows: What happened, telemetry data, AI solution, and live execution progress.
 * Closable by the user at any time.
 */

const ALERT_COLORS = {
    EMERGENCY: '#ff2244',
    HIGH: '#ffaa00',
    NORMAL: '#00d4ff'
};

// Action labels for the new realistic command dictionary
const ACTION_LABELS = {
    'SET_ATTITUDE_MODE': { icon: '🔄', label: 'ATTITUDE SLEW', verb: 'Orienting spacecraft...' },
    'PLAN_BURN': { icon: '📐', label: 'COMPUTE MANEUVER', verb: 'Calculating burn vector...' },
    'EXECUTE_BURN': { icon: '🔥', label: 'THRUSTER BURN', verb: 'Executing maneuver...' },
    'SET_POWER_MODE': { icon: '⚡', label: 'POWER CONFIG', verb: 'Adjusting power state...' },
    'SET_PAYLOAD_STATE': { icon: '📡', label: 'PAYLOAD CONFIG', verb: 'Configuring sensors...' },
    'ENTER_SAFE_MODE': { icon: '🛡️', label: 'SAFE MODE INIT', verb: 'Entering survival mode...' },
    'EXIT_SAFE_MODE': { icon: '✅', label: 'NOMINAL RESTORE', verb: 'Restoring nominal operations...' },
    'MAINTAIN': { icon: '⏳', label: 'HOLD POSITION', verb: 'Maintaining state...' }
};

let overlayEl = null;
let isVisible = false;
let isMinimized = false;
let currentPlanId = null;
let lastFireReason = null;
let lastFireTime = 0;
let updateInterval = null;

/**
 * Initialize the Crisis Alert DOM. Call once on app boot.
 */
export function initCrisisAlert() {
    if (overlayEl) return;

    overlayEl = document.createElement('div');
    overlayEl.id = 'crisis-alert-overlay';
    overlayEl.className = 'crisis-alert-overlay';
    overlayEl.innerHTML = `
        <!-- Floating Badge (Minimized State) -->
        <div id="ca-minimized-badge" class="ca-minimized-badge">
            <span class="ca-badge-dot"></span>
            <span class="ca-badge-label">CRISIS ACTIVE</span>
        </div>

        <div class="crisis-alert-panel" id="ca-panel">
            <div class="crisis-alert-header">
                <div class="ca-issue-wrapper">
                    <div class="crisis-alert-badge" id="ca-badge">EMERGENCY</div>
                    <div class="ca-reason" id="ca-reason">—</div>
                </div>
                <div class="ca-header-actions">
                    <button class="ca-action-btn" id="ca-minimize" title="Minimize Alert">_</button>
                    <button class="ca-action-btn" id="ca-close" title="Dismiss Alert">&times;</button>
                </div>
            </div>

            <div class="crisis-alert-body">
                <!-- Telemetry snapshot -->
                <div>
                    <div class="ca-section-title">Telemetry Snapshot</div>
                    <div class="ca-telem-grid" id="ca-telem">
                        <!-- injected -->
                    </div>
                </div>

                <!-- AI Solution -->
                <div>
                    <div class="ca-section-title">Autonomous Response Sequence</div>
                    <div class="ca-sequence" id="ca-sequence">
                        <!-- injected -->
                    </div>
                </div>

                <!-- Live progress -->
                <div class="ca-progress-area" id="ca-progress">
                    <div class="ca-progress-status" id="ca-status-text">
                        <span>Awaiting execution...</span>
                        <span id="ca-percent">0%</span>
                    </div>
                    <div class="ca-progress-bar-track">
                        <div class="ca-progress-bar-fill" id="ca-bar"></div>
                    </div>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(overlayEl);

    // Handlers
    document.getElementById('ca-close').addEventListener('click', dismissAlert);
    document.getElementById('ca-minimize').addEventListener('click', toggleMinimize);
    document.getElementById('ca-minimized-badge').addEventListener('click', expandAlert);

    overlayEl.addEventListener('click', (e) => {
        if (e.target === overlayEl && !isMinimized) dismissAlert();
    });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isVisible && !isMinimized) dismissAlert();
    });
}

/**
 * Toggle between minimized and expanded states.
 */
export function toggleMinimize() {
    isMinimized = true;
    overlayEl.classList.add('minimized');
}

export function expandAlert() {
    isMinimized = false;
    overlayEl.classList.remove('minimized');
}

/**
 * Fire the crisis alert popup.
 * @param {Object} plan  — the JSON plan from ai-brain { priority, sequence, reason, plan_id }
 * @param {Object} satellite — the VirtualSatellite instance for telemetry
 */
export function fireCrisisAlert(plan, satellite) {
    if (!overlayEl) initCrisisAlert();
    if (!plan || plan.priority === 'NORMAL') return; // Only fire for HIGH / EMERGENCY

    // Deduplication / Anti-spam logic
    const now = Date.now();
    if (plan.reason === lastFireReason && (now - lastFireTime < 60000)) {
        console.log(`[CrisisAlert] Blocked duplicate alert for: ${plan.reason}`);
        return;
    }

    // If already visible and reason is same, just update, don't "fire" again
    if (isVisible && plan.reason === lastFireReason) {
        // Just update tracking if needed, but don't re-trigger animation/sound
        return;
    }

    lastFireReason = plan.reason;
    lastFireTime = now;
    currentPlanId = plan.plan_id;
    const color = ALERT_COLORS[plan.priority] || ALERT_COLORS.NORMAL;

    // Badge
    const badge = document.getElementById('ca-badge');
    badge.textContent = plan.priority === 'EMERGENCY' ? 'EMERGENCY' : 'HIGH ALERT';
    badge.style.color = color;

    // Reason
    document.getElementById('ca-reason').textContent = plan.reason || 'Unknown anomaly detected.';

    // Telemetry snapshot
    const s = satellite.sections || satellite.getFullState?.()?.sections || {};
    const env = satellite.environment || satellite.getFullState?.()?.environment || {};
    const telem = document.getElementById('ca-telem');
    telem.innerHTML = `
        <div class="ca-telem-item">
            <span class="ca-telem-label">BATTERY</span>
            <span class="ca-telem-value" style="color:${(s.batteryBay?.charge || 0) < 20 ? '#ff2244' : '#fff'}">${(s.batteryBay?.charge || 0).toFixed(0)}%</span>
        </div>
        <div class="ca-telem-item">
            <span class="ca-telem-label">TEMP (BAT)</span>
            <span class="ca-telem-value" style="color:${(s.batteryBay?.temperature || 0) > 70 ? '#ff2244' : '#fff'}">${(s.batteryBay?.temperature || 0).toFixed(0)}°C</span>
        </div>
        <div class="ca-telem-item">
            <span class="ca-telem-label">FUEL</span>
            <span class="ca-telem-value">${(s.thrusterPod?.fuelPercent || 0).toFixed(0)}%</span>
        </div>
        <div class="ca-telem-item">
            <span class="ca-telem-label">ALTITUDE</span>
            <span class="ca-telem-value">${(env.altitude || 0).toFixed(1)} km</span>
        </div>
        <div class="ca-telem-item">
            <span class="ca-telem-label">RADIATION</span>
            <span class="ca-telem-value" style="color:${(env.radiationLevel || 0) > 0.5 ? '#ffaa00' : '#fff'}">${(env.radiationLevel || 0).toFixed(2)} mSv/hr</span>
        </div>
        <div class="ca-telem-item">
            <span class="ca-telem-label">SUN</span>
            <span class="ca-telem-value">${env.inSunlight ? '☀️ YES' : '🌑 ECLIPSE'}</span>
        </div>
    `;

    // AI Sequence
    const seqEl = document.getElementById('ca-sequence');
    seqEl.innerHTML = (plan.commands || []).map((step, i) => {
        const info = ACTION_LABELS[step.type] || { icon: '?', label: step.type, verb: 'Executing...' };
        return `
            <div class="ca-step" id="ca-step-${i}">
                <span class="ca-step-num">${String(i + 1).padStart(2, '0')}</span>
                <span class="ca-step-icon">${info.icon}</span>
                <span class="ca-step-label">${info.label}</span>
                <span class="ca-step-status" id="ca-step-status-${i}">QUEUED</span>
            </div>
        `;
    }).join('');

    // Reset progress
    const bar = document.getElementById('ca-bar');
    bar.style.width = '0%';
    bar.classList.remove('done');

    document.getElementById('ca-percent').textContent = '0%';
    document.getElementById('ca-status-text').querySelector('span').textContent = 'Initiating response sequence...';

    // Show
    overlayEl.classList.add('open');
    isVisible = true;

    // Start live progress tracking
    startProgressTracking(satellite, plan);
}

/**
 * Poll the FlightController state to update the progress bar and step statuses.
 */
function startProgressTracking(satellite, plan) {
    if (updateInterval) clearInterval(updateInterval);

    const totalSteps = plan.commands ? plan.commands.length : 0;

    updateInterval = setInterval(() => {
        const fc = satellite.flightController;
        if (!fc) return;

        // Figure out which step is currently executing
        const activeStepIdx = fc.currentCommand?.plan_id === plan.plan_id
            ? fc.currentStepIndex
            : (fc.currentCommand ? -1 : totalSteps); // If different plan or idle

        // Update step badges
        for (let i = 0; i < totalSteps; i++) {
            const stepEl = document.getElementById(`ca-step-${i}`);
            const statusEl = document.getElementById(`ca-step-status-${i}`);
            if (!stepEl || !statusEl) continue;

            stepEl.className = 'ca-step'; // reset

            if (i < activeStepIdx || activeStepIdx >= totalSteps) {
                stepEl.classList.add('done');
                statusEl.textContent = 'DONE';
            } else if (i === activeStepIdx) {
                stepEl.classList.add('active');
                const step = plan.commands[i];
                const info = ACTION_LABELS[step.type] || { verb: 'Executing...' };
                statusEl.textContent = 'ACTIVE';
                document.getElementById('ca-status-text').querySelector('span').textContent = info.verb;
            } else {
                statusEl.textContent = 'QUEUED';
            }
        }

        // Progress bar
        // We calculate a base progress (completed steps) + a fractional progress of the current step
        let fractionalProgress = 0;
        if (activeStepIdx >= 0 && activeStepIdx < totalSteps) {
            const step = plan.commands[activeStepIdx];

            // Interpolate progress for specific long-running actions
            if (step.type === 'SET_ATTITUDE_MODE') {
                const cur = satellite.attitude?.currentAngle || 0;
                const tar = satellite.attitude?.targetAngle || 0;
                const error = Math.abs(cur - tar);
                // Assume 180 deg is max error for 100% of this step
                // Progress of this step is (1 - error / 180)
                // However, targetAngle might change, so we clamp
                fractionalProgress = Math.min(0.95, Math.max(0, 1 - (error / 180)));
            } else if (fc.currentCommand?.duration) {
                // If it's a timed command, use time elapsed
                const elapsed = fc.currentCommand.elapsed || 0;
                const max = fc.currentCommand.duration || 1;
                fractionalProgress = Math.min(0.95, elapsed / max);
            }
        }

        const baseProgressPercentage = (activeStepIdx >= totalSteps ? totalSteps : Math.max(0, activeStepIdx)) / totalSteps;
        const currentStepContribution = fractionalProgress / totalSteps;
        const totalProgress = Math.min(1, baseProgressPercentage + currentStepContribution);

        const progressPercent = Math.round(totalProgress * 100);
        const bar = document.getElementById('ca-bar');
        const pct = document.getElementById('ca-percent');
        if (bar) bar.style.width = `${progressPercent}%`;
        if (pct) pct.textContent = `${progressPercent}%`;

        // If all steps done
        if (activeStepIdx >= totalSteps) {
            document.getElementById('ca-status-text').querySelector('span').textContent = 'Response sequence complete.';
            if (bar) {
                bar.style.width = '100%';
                bar.classList.add('done');
            }
            if (pct) pct.textContent = '100%';
            clearInterval(updateInterval);
        }
    }, 200); // 5Hz poll
}

export function dismissAlert() {
    if (!overlayEl) return;
    overlayEl.classList.remove('open');
    isVisible = false;
    if (updateInterval) clearInterval(updateInterval);
}

export function isCrisisAlertVisible() {
    return isVisible;
}
