/**
 * Electrical power system: loads, solar generation and a 2S Li-ion battery.
 *
 * Numbers are representative of a 1U CubeSat (see REAL_SATELLITE_SPECS.md):
 * 60 Wh pack, 2 × 5 W deployable panels, 2–3 W idle, 5–8 W fully active.
 */

export const PANEL_PEAK_W = 5.0;
export const MPPT_EFFICIENCY = 0.95;
export const CHARGE_EFFICIENCY = 0.95;
export const DISCHARGE_EFFICIENCY = 0.97;
export const PA_EFFICIENCY = 0.4;            // radio power amplifier: 1 W RF ≈ 2.5 W DC
export const BATTERY_HEATER_W = 1.0;
export const PAYLOAD_DRAW_W = { OFF: 0, STANDBY: 0.3, ACTIVE: 1.5 };

/** Transmit RF power (W) and duty cycle per power mode. */
export const TX_PROFILE = {
    NOMINAL: { rfW: 1.0, duty: 1.0 },
    LOW_POWER: { rfW: 0.5, duty: 1.0 },
    CHARGE_PRIORITY: { rfW: 0.5, duty: 1.0 },
    SURVIVAL: { rfW: 0.5, duty: 0.1 },  // beacon only
};

/**
 * Bus loads in watts, plus where each one turns into heat (for the thermal model).
 */
export function computeLoads({ extraW = 0, powerMode, payloadState, cpuLoad, slewing, inContact, antennaOk, heaterOn, obcDown, thrusting }) {
    const tx = TX_PROFILE[powerMode] || TX_PROFILE.NOMINAL;
    const txActive = inContact && antennaOk;
    const txRf = txActive ? tx.rfW * tx.duty : 0;
    const txDc = txRf / PA_EFFICIENCY;
    const loads = {
        obc: obcDown ? 0.05 : 0.35 + 0.45 * (cpuLoad / 100),
        eps: 0.15,
        adcs: 0.25 + (slewing ? 0.6 : 0),
        radioRx: 0.2,
        radioTx: txDc,
        payload: PAYLOAD_DRAW_W[payloadState] ?? 0,
        heater: heaterOn ? BATTERY_HEATER_W : 0,
        propulsion: thrusting ? 0.8 : 0.02, // valve + pressure transducer
        fault: extraW,
    };
    loads.total = Object.values(loads).reduce((a, b) => a + b, 0);
    loads.txRfW = txRf;
    return loads;
}

/** Open-circuit voltage of a 2S Li-ion pack versus state of charge (0..1). */
export function packOcv(soc) {
    const pts = [[0, 3.0], [0.05, 3.3], [0.1, 3.45], [0.2, 3.55], [0.4, 3.65], [0.6, 3.8], [0.8, 3.95], [0.9, 4.05], [1, 4.2]];
    const x = Math.max(0, Math.min(1, soc));
    for (let i = 1; i < pts.length; i++) {
        if (x <= pts[i][0]) {
            const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
            return 2 * (y0 + (y1 - y0) * (x - x0) / (x1 - x0));
        }
    }
    return 8.4;
}

/**
 * Advance the battery by dt seconds given solar input and bus load (both W).
 * Li-ion must not be charged below 0 °C: surplus solar is then shunted.
 * Mutates `bat` (charge %, voltage, currentDraw, flags). Returns the shunted watts.
 */
export function stepBattery(bat, solarW, loadW, dt, tempC) {
    const usable = bat.capacityWh * (bat.healthPercent / 100);
    const net = solarW * MPPT_EFFICIENCY - loadW;           // W at the bus
    bat.chargeInhibited = tempC < 0;
    let shunt = 0;
    let packW;                                                // + charging, − discharging
    if (net >= 0) {
        if (bat.chargeInhibited || bat.charge >= 100) { shunt = net; packW = 0; }
        else packW = net * CHARGE_EFFICIENCY;
    } else {
        packW = net / DISCHARGE_EFFICIENCY;
    }
    const prevSign = Math.sign(bat._lastPackW || 0);
    bat.charge = Math.max(0, Math.min(100, bat.charge + (packW * dt / 3600) / usable * 100));
    if (prevSign < 0 && packW > 0 && (bat._dodSinceCharge || 0) > 5) {
        bat.cycleCount += 1;
        bat.healthPercent = Math.max(50, bat.healthPercent - 0.004); // ~0.004 %/cycle
        bat._dodSinceCharge = 0;
    }
    if (packW < 0) bat._dodSinceCharge = (bat._dodSinceCharge || 0) + (-packW * dt / 3600) / usable * 100;
    bat._lastPackW = packW;

    const ocv = packOcv(bat.charge / 100);
    const R = 0.12; // pack internal resistance, Ω
    const I = -packW / ocv;                                   // + discharge
    bat.voltage = ocv - I * R;
    bat.currentDraw = I;
    bat.i2rW = I * I * R;
    bat.brownout = bat.charge <= 0.5 && net < 0;
    return shunt;
}
