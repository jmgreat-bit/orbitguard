# ORBIT Core Physics Baseline Parameters

> **Source:** Based on 1U CubeSat standards, actual mission data (e.g. Deep Space 1, Dawn), and commercial satellite specs.
>
> **Note:** Real satellites vary widely based on payload, mission profile, and altitude. The parameters below are **representative baseline estimates** chosen to provide a credible, realistic foundation for the orbital mechanics simulation and autonomy testbed.

---

## 1U CubeSat Baseline (Virtual Satellite Model)

**Physical:**
- Size: 10cm × 10cm × 11.35cm
- Mass: ~1.33 kg (typical)

---

## ⚡ Power System (Real Specs)

| Parameter | Value | Source |
|---|---|---|
| **Battery Capacity** | 30-80 Wh (we'll use 60 Wh) | AAC Clyde Space commercial packs |
| **Battery Type** | Li-ion 18650 cells | Industry standard |
| **Battery Voltage** | 7.4V nominal | Typical 2S config |
| **Solar Panel Output** | ~10W peak (1U) | Standard Sun-facing |
| **Power Consumption (Idle)** | 2-3W | Avionics + comms off |
| **Power Consumption (Active)** | 5-8W | Full operations |
| **Critical Battery Level** | 20% (12 Wh) | Safe mode trigger |

**Key Formula:**
```
Time to full drain (hours) = Battery Capacity (Wh) / Power Consumption (W)
Example: 60 Wh / 5W = 12 hours
```

---

## 🌡️ Thermal System (Real Limits)

| Parameter | Value | Source |
|---|---|---|
| **Operating Range** | -20°C to +70°C | Standard electronics |
| **Critical Max Temp** | 85-120°C | Component failure threshold |
| **Critical Min Temp** | -40°C | Battery freezing risk |
| **External Space Temp Swing** | -100°C to +121°C | LEO sunlight/shadow |
| **Heat Absorbed (Sun)** | ~10-15W | Solar radiation |
| **Heat Radiated** | Depends on surface area | Stefan-Boltzmann law |

**Real Scenario:**
- In sunlight: Satellite heats up ~2-5°C per minute
- In shadow: Cools ~1-3°C per minute
- Must rotate or use heaters to stay in safe zone

---

## 📡 Communication System

| Parameter | Value | Source |
|---|---|---|
| **Frequency** | 435 MHz (amateur) or 2.4 GHz (commercial) | FCC allocations |
| **Transmission Power** | 0.5-2W | Typical UHF/S-band |
| **Ground Station Visibility** | 5-15 min/pass | LEO orbit geometry |
| **Signal Delay** | 0.003-0.01 sec | 500-3000 km altitude |
| **Data Rate** | 1200-9600 bps (UHF) | Real CubeSat telemetry |

**Loss of Signal Triggers:**
- Antenna misalignment (need attitude control)
- Behind Earth (orbital mechanics)
- Hardware failure

---

## 🛡️ Navigation & Attitude Control

### Reaction Wheels (Real Specs)

| Parameter | Value | Source |
|---|---|---|
| **Torque** | 0.2-12 mNm | AAC Clyde / NanoAvionics |
| **Max Speed** | 5000-6500 RPM | Industry standard |
| **Power Consumption** | 45 mW (idle), 200-1900 mW (active) | Manufacturer datasheets |
| **Operating Temp** | -40°C to +85°C | Radiation-hardened |

### Thrusters (Cold Gas - Simplest)

| Parameter | Value | Source |
|---|---|---|
| **Thrust** | 42 mN to 1.35 N | AST Technologies |
| **Specific Impulse (Isp)** | 69 sec (N₂ gas), 248 sec (green propellant) | Dawn Aerospace |
| **Fuel Mass** | 0.1-0.5 kg | Typical CubeSat load |

**Delta-V Budget (velocity changes):**
- **Debris avoidance maneuver:** 0.1-0.5 m/s (minor course correction)
- **Station-keeping (per year):** 5-25 m/s (LEO altitude dependent)
- **De-orbit burn:** 50-100 m/s (end-of-life)

**Fuel consumption example:**
- 1 debris dodge (0.2 m/s) = ~5-10 grams of gas
- Total fuel budget = 100-500g = ~10-100 dodges possible

---

## 🛰️ Orbital Mechanics (Real Numbers)

### Low Earth Orbit (LEO) - Where our satellite lives

| Parameter | Value |
|---|---|
| **Altitude** | 400-600 km (typical CubeSat) |
| **Orbital Period** | 92-96 minutes (one orbit around Earth) |
| **Velocity** | ~7.6 km/s (27,000 km/h) |
| **Sunlight/Shadow Ratio** | ~60% sun, 40% shadow per orbit |

---

## 🚨 Real Crisis Scenarios (What the AI Must Handle)

### 1. Solar Flare Event
- **Trigger:** NASA DONKI API reports M-class or X-class flare
- **Effect:** Electronics heating, radiation damage risk, power spike
- **AI Response:** Enter safe mode, rotate away from Sun, reduce power draw

### 2. Battery Critical (< 20%)
- **Cause:** Solar panels misaligned, excessive power use, battery degradation
- **Effect:** System shutdown imminent
- **AI Response:** Rotate to Sun (max solar exposure), shut down non-essential systems, beacon SOS signal

### 3. Overheating (> 70°C)
- **Cause:** Stuck in sunlight, thermal control failure
- **Effect:** Component damage, battery fire risk
- **AI Response:** Rotate to shadow side, reduce CPU load, activate thermal radiators

### 4. Space Debris Approach (< 1 km)
- **Source:** CelesTrak TLE data shows object closing in
- **Effect:** Collision = mission end
- **AI Response:** Calculate closest approach, if < 500m → execute evasion burn (0.1-0.5 m/s delta-V)

### 5. Communication Loss (> 15 min)
- **Cause:** Antenna failure, ground station issue, attitude drift
- **Effect:** Cannot receive commands from Earth
- **AI Response:** Enter autonomous mode, attempt antenna reorientation, continue mission objectives, beacon emergency signal

---

## How We'll Use This Data

Instead of saying "battery drains randomly," our code will calculate:

```javascript
// Real physics
battery_drain_rate = power_consumption_watts / battery_capacity_wh
battery_percent -= (battery_drain_rate * time_delta_hours) * 100

// Real solar charging
if (solar_panel_angle_to_sun > 80 && solar_panel_angle_to_sun < 100) {
  battery_percent += (solar_output_watts / battery_capacity_wh * time_delta_hours) * 100
}

// Real temperature change
if (facing_sun) {
  temperature += 3 * time_delta_minutes  // heats 3°C/min
} else {
  temperature -= 1.5 * time_delta_minutes  // cools 1.5°C/min
}
```

This makes our AI's decisions **realistic** — judges will see we did our homework! 🚀
