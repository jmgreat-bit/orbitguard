/**
 * FlightController.js
 * The Autonomous Flight Controller (Minimum Viable Autonomy)
 * 
 * Decouples the AI planner (Gemini 15s loop) from the Physics Executor (60Hz loop).
 * Maintains a Command Queue, executes step-by-step logic, and enforces Safety Override constraints.
 */

export class FlightController {
    constructor(satellitePhysics) {
        this.sat = satellitePhysics;
        this.queue = [];
        this.currentCommand = null;
        this.currentStepIndex = 0;
        this.stepStartTime = 0;
        this.lastAiPlanId = null;
    }

    /**
     * Called by the AI Brain whenever a new JSON plan is received.
     * @param {Object} jsonPlan 
     */
    processAIPlan(jsonPlan) {
        if (!jsonPlan || !jsonPlan.commands || jsonPlan.commands.length === 0) return;

        // Prevent executing the exact same plan twice if the AI loops
        if (jsonPlan.plan_id && jsonPlan.plan_id === this.lastAiPlanId) return;
        this.lastAiPlanId = jsonPlan.plan_id;

        // EMERGENCY priority overrides everything immediately
        if (jsonPlan.priority === 'EMERGENCY') {
            console.warn("[FLIGHT OPS] EMERGENCY OVERRIDE RECEIVED. Aborting current maneuvers.");
            this.abortCurrent();
        }

        // Push to queue
        this.queue.push(jsonPlan);
        console.log(`[FLIGHT OPS] Queued new plan (Priority: ${jsonPlan.priority})`, jsonPlan);
    }

    abortCurrent() {
        this.currentCommand = null;
        this.queue = [];
        this.stepStartTime = 0;
        // reset physical actuators if they were mid-burn
        this.sat.propulsion.isThrusting = false;
        this.sat.sections.commArray.linkStatus = 'STRONG'; // reset comms if disabled
    }

    /**
     * Evaluated every physics tick (`physics.js` integration loop).
     * @param {number} dtSeconds 
     */
    tick(dtSeconds) {
        // 1. SAFETY OVERRIDE (Hard limits the AI cannot ignore)
        const safetyBlock = this.checkSafetyConstraints();
        if (safetyBlock) {
            if (this.currentCommand) {
                console.warn(`[SAFETY SUPERVISOR] ABORTING MANEUVER: ${safetyBlock}`);
                this.abortCurrent();
            }
            // Dispatch crisis event so the UI popup can react
            window.dispatchEvent(new CustomEvent('safety-override', {
                detail: {
                    reason: safetyBlock,
                    priority: 'EMERGENCY',
                    plan_id: `safety_${Date.now()}`,
                    summary: safetyBlock,
                    commands: this._getSafetySequence(safetyBlock)
                }
            }));
            return; // Do not execute queue while unsafe
        }

        // 2. Queue Management
        if (!this.currentCommand && this.queue.length > 0) {
            // Sort queue by priority: EMERGENCY > HIGH > NORMAL
            this.queue.sort((a, b) => {
                const val = p => p === 'EMERGENCY' ? 3 : p === 'HIGH' ? 2 : 1;
                return val(b.priority) - val(a.priority);
            });

            this.currentCommand = this.queue.shift();
            this.currentStepIndex = 0;
            this.stepStartTime = Date.now();
            console.log(`[FLIGHT OPS] Starting Plan Execution`, this.currentCommand);
        }

        // 3. Execution Step
        if (this.currentCommand) {
            this.executeCurrentStep(dtSeconds);
        }
    }

    executeCurrentStep(dtSeconds) {
        const step = this.currentCommand.commands[this.currentStepIndex];
        if (!step) {
            // Plan finished
            this.currentCommand = null;
            return;
        }

        const elapsedSeconds = (Date.now() - this.stepStartTime) / 1000;
        const maxTime = step.duration || 60; // 60s fallback timeout

        if (elapsedSeconds > maxTime && step.type !== 'PLAN_BURN') {
            console.warn(`[FLIGHT OPS] Step timed out! Aborting plan.`);
            this.abortCurrent();
            return;
        }

        let stepComplete = false;

        // ACTUATOR LOGIC
        switch (step.type) {
            case 'SET_ATTITUDE_MODE':
                const target = step.params?.target || 'INERTIAL_LOCK';

                // Map logical targets to physical angles (simplified 1D ADCS)
                if (target === 'SUN_TRACKING') this.sat.attitude.targetAngle = 0;
                else if (target === 'EARTH_NADIR') this.sat.attitude.targetAngle = 90;
                else if (target === 'DEEP_SPACE') this.sat.attitude.targetAngle = 180;
                else if (target === 'VELOCITY_ALIGNED') this.sat.attitude.targetAngle = 270;

                // For attitude commands, we consider the step "complete" if it reaches the angle 
                // OR if it just runs for its stated duration (meaning "hold this attitude for X seconds").
                if (step.duration) {
                    if (elapsedSeconds >= step.duration) stepComplete = true;
                } else {
                    // If no duration, wait till converged
                    if (Math.abs(this.sat.attitude.currentAngle - this.sat.attitude.targetAngle) < 5) stepComplete = true;
                }
                break;

            case 'PLAN_BURN':
                // In a real system, this would queue a burn into a separate maneuver registry.
                // For this sim, we just log it and mark complete instantly.
                console.log(`[FLIGHT OPS] Burn Planned: ${step.params?.reason}, dv: ${step.params?.delta_v}`);
                stepComplete = true;
                break;

            case 'EXECUTE_BURN':
                // For simplicity in the sim, we'll actually execute thrust here if we find an adjacent PLAN_BURN, 
                // or just apply a default thrust if commanded directly.
                // We'll look back at the previous step for params if executing.
                let dv = 0.5; // default
                let dir = [1, 0, 0]; // prograde
                if (this.currentStepIndex > 0 && this.currentCommand.commands[this.currentStepIndex - 1].type === 'PLAN_BURN') {
                    const plan = this.currentCommand.commands[this.currentStepIndex - 1].params;
                    dv = plan.delta_v || 0.5;
                    dir = plan.vector || [1, 0, 0];
                }

                const burnSec = step.duration || 5.0;

                // Start burn
                this.sat.propulsion.isThrusting = true;

                if (elapsedSeconds <= burnSec) {
                    // Apply thrust (dv/dt)
                    this.sat.applyThrust(dir, dv / burnSec * dtSeconds);
                } else {
                    // Burn complete
                    this.sat.propulsion.isThrusting = false;
                    stepComplete = true;
                }
                break;

            case 'SET_POWER_MODE':
                const mode = step.params?.mode || 'NOMINAL';
                if (mode === 'LOW_POWER' || mode === 'SURVIVAL') {
                    this.sat.sections.payload.powerDraw = 2; // Nominal is usually 20
                } else if (mode === 'CHARGE_PRIORITY') {
                    this.sat.sections.payload.powerDraw = 5;
                } else {
                    this.sat.sections.payload.powerDraw = 20; // NOMINAL
                }
                stepComplete = true; // State change is instant
                break;

            case 'SET_PAYLOAD_STATE':
                const pstate = step.params?.state || 'ACTIVE';
                if (pstate === 'OFF') {
                    this.sat.sections.payload.powerDraw = 0;
                    this.sat.sections.payload.status = 'OFFLINE';
                } else if (pstate === 'ACTIVE') {
                    this.sat.sections.payload.powerDraw = 20;
                    this.sat.sections.payload.status = 'ONLINE';
                }
                stepComplete = true;
                break;

            case 'ENTER_SAFE_MODE':
                this.sat.sections.payload.powerDraw = 0;
                this.sat.sections.payload.status = 'OFFLINE';
                this.sat.attitude.targetAngle = 0; // Sun point
                this.sat.sections.commArray.linkStatus = 'LOW_BANDWIDTH';
                stepComplete = true;
                break;

            case 'EXIT_SAFE_MODE':
                this.sat.sections.payload.powerDraw = 20;
                this.sat.sections.payload.status = 'ONLINE';
                this.sat.sections.commArray.linkStatus = 'STRONG';
                stepComplete = true;
                break;

            default:
                console.warn("[FLIGHT OPS] Unknown action type: ", step.type);
                stepComplete = true;
        }

        // Expose elapsed for the UI progress bar tracking
        this.currentCommand.elapsed = elapsedSeconds;

        if (stepComplete) {
            this.currentStepIndex++;
            this.stepStartTime = Date.now();
        }
    }

    /**
     * Hard limits - Never trust AI
     * @returns {string|null} Reason for safety block, or null if safe
     */
    checkSafetyConstraints() {
        const bat = this.sat.sections.batteryBay.percent;
        const temp = this.sat.sections.batteryBay.temperature;

        // Auto-survival: If dying, force safe mode regardless of AI plan
        if (bat < 15) {
            this.sat.attitude.targetAngle = 0; // Force Sun point
            this.sat.sections.payload.status = 'OFFLINE';
            return "BATTERY_CRITICAL_OVERRIDE";
        }

        if (temp > 85) {
            this.sat.attitude.targetAngle = 180; // Force Shadow
            return "THERMAL_LIMIT_OVERRIDE";
        }

        if (this.currentCommand && this.currentCommand.commands[this.currentStepIndex]?.type === 'EXECUTE_BURN') {
            // Check Delta V reserve before allowing burn
            // We look back at plan_burns for the requested dv
            const requestedTotalDv = this.currentCommand.commands
                .filter(s => s.type === 'PLAN_BURN')
                .reduce((sum, s) => sum + (s.params?.delta_v || 0), 0);

            if (this.sat.propulsion.remainingDeltaV - requestedTotalDv < 50) {
                return "FUEL_RESERVE_OVERRIDE"; // Need 50m/s to de-orbit safely
            }
        }

        return null; // Safe to proceed
    }

    /**
     * Map safety override codes to human-readable action sequences for the Crisis Alert popup.
     */
    _getSafetySequence(overrideCode) {
        switch (overrideCode) {
            case 'BATTERY_CRITICAL_OVERRIDE':
                return [
                    { type: 'ENTER_SAFE_MODE', params: {} },
                    { type: 'SET_ATTITUDE_MODE', params: { target: 'SUN_TRACKING' }, duration: 60 }
                ];
            case 'THERMAL_LIMIT_OVERRIDE':
                return [
                    { type: 'SET_ATTITUDE_MODE', params: { target: 'DEEP_SPACE' }, duration: 60 }
                ];
            case 'FUEL_RESERVE_OVERRIDE':
                return [
                    { type: 'SET_ATTITUDE_MODE', params: { target: 'INERTIAL_LOCK' }, duration: 30 }
                ];
            default:
                return [{ type: 'SET_ATTITUDE_MODE', params: { target: 'INERTIAL_LOCK' }, duration: 30 }];
        }
    }
}
