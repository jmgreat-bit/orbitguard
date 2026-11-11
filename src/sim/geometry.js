/**
 * Orbit and Earth geometry — pure functions (vectors are plain [x, y, z] arrays).
 *
 * Frames: ECI (inertial, x → vernal equinox, z → north pole) and ECEF (Earth-fixed).
 * The sim flies a circular orbit described by semi-major axis a, inclination i,
 * right ascension of the ascending node Ω and argument of latitude u.
 */

export const RE_KM = 6371.0;
const DEG = Math.PI / 180;

// ── tiny vector helpers ─────────────────────────────────────────────────────
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const unit = (a) => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
export const angleBetween = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b)))));

/** Rotate unit vector `from` toward `to` by at most maxRad (Rodrigues). Returns a unit vector. */
export function rotateToward(from, to, maxRad) {
    const ang = angleBetween(from, to);
    if (ang <= maxRad || ang < 1e-9) return unit(to);
    let axis = cross(from, to);
    if (norm(axis) < 1e-9) { // antiparallel: pick any perpendicular axis
        axis = Math.abs(from[0]) < 0.9 ? cross(from, [1, 0, 0]) : cross(from, [0, 1, 0]);
    }
    const k = unit(axis);
    const c = Math.cos(maxRad), s = Math.sin(maxRad);
    const kxv = cross(k, from);
    const kdv = dot(k, from);
    return unit([
        from[0] * c + kxv[0] * s + k[0] * kdv * (1 - c),
        from[1] * c + kxv[1] * s + k[1] * kdv * (1 - c),
        from[2] * c + kxv[2] * s + k[2] * kdv * (1 - c),
    ]);
}

// ── time ────────────────────────────────────────────────────────────────────
export const julianDate = (ms) => ms / 86400000 + 2440587.5;

/** Greenwich mean sidereal time (rad), IAU 1982 linear form. */
export function gmstRad(ms) {
    const d = julianDate(ms) - 2451545.0;
    const deg = 280.46061837 + 360.98564736629 * d;
    return ((deg % 360) + 360) % 360 * DEG;
}

/**
 * Unit vector from Earth to Sun in ECI (Astronomical Almanac low-precision formula,
 * good to ~0.01°, plenty for eclipse and panel incidence).
 */
export function sunDirectionECI(ms) {
    const n = julianDate(ms) - 2451545.0;
    const L = (280.460 + 0.9856474 * n) * DEG;
    const g = (357.528 + 0.9856003 * n) * DEG;
    const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    const eps = (23.439 - 0.0000004 * n) * DEG;
    return [Math.cos(lam), Math.cos(eps) * Math.sin(lam), Math.sin(eps) * Math.sin(lam)];
}

/** Sun–Earth distance factor for flux: (1 AU / r)². ±3.3 % over the year. */
export function solarFluxFactor(ms) {
    const n = julianDate(ms) - 2451545.0;
    const g = (357.528 + 0.9856003 * n) * DEG;
    const rAU = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
    return 1 / (rAU * rAU);
}

// ── circular orbit state ────────────────────────────────────────────────────
/**
 * Position (km), velocity direction and orbit normal in ECI for a circular orbit.
 * r = a·(cos u·P + sin u·Q) with P toward the ascending node.
 */
export function orbitStateECI(aKm, inclDeg, raanDeg, uDeg) {
    const i = inclDeg * DEG, O = raanDeg * DEG, u = uDeg * DEG;
    const cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(i), si = Math.sin(i);
    const cu = Math.cos(u), su = Math.sin(u);
    const rHat = [cu * cO - su * ci * sO, cu * sO + su * ci * cO, su * si];
    const vHat = [-su * cO - cu * ci * sO, -su * sO + cu * ci * cO, cu * si];
    const hHat = [si * sO, -si * cO, ci];
    return { r: scale(rHat, aKm), rHat, vHat, hHat };
}

/** Inverse: inclination, RAAN, argument of latitude from an ECI position/velocity. */
export function elementsFromRV(r, v) {
    const h = cross(r, v);
    const hHat = unit(h);
    const incl = Math.acos(Math.max(-1, Math.min(1, hHat[2]))) / DEG;
    const node = [-h[1], h[0], 0];
    const raan = norm(node) < 1e-9 ? 0 : (Math.atan2(node[1], node[0]) / DEG + 360) % 360;
    const nHat = norm(node) < 1e-9 ? [1, 0, 0] : unit(node);
    const m = cross(hHat, nHat);
    const u = (Math.atan2(dot(r, m), dot(r, nHat)) / DEG + 360) % 360;
    return { incl, raan, u };
}

export function eciToEcef(r, gmst) {
    const c = Math.cos(gmst), s = Math.sin(gmst);
    return [c * r[0] + s * r[1], -s * r[0] + c * r[1], r[2]];
}

/** Geocentric latitude/longitude (deg) of an ECI position. */
export function subSatellitePoint(rEci, gmst) {
    const e = eciToEcef(rEci, gmst);
    const lat = Math.atan2(e[2], Math.hypot(e[0], e[1])) / DEG;
    let lon = Math.atan2(e[1], e[0]) / DEG;
    lon = ((lon + 540) % 360) - 180;
    return { lat, lon };
}

/**
 * Cylindrical Earth-shadow test. In shadow when the satellite is on the night side
 * and within one Earth radius of the Earth–Sun line. Returns depth 0..1 into the
 * shadow (for the eclipse progress readout).
 */
export function eclipseState(rEciKm, sunHat) {
    const s = dot(rEciKm, sunHat);
    if (s >= 0) return { inShadow: false, depth: 0 };
    const perp = norm(sub(rEciKm, scale(sunHat, s)));
    if (perp >= RE_KM) return { inShadow: false, depth: 0 };
    return { inShadow: true, depth: 1 - perp / RE_KM };
}

/** Beta angle (deg): Sun elevation above the orbit plane. Drives eclipse length and panel geometry. */
export const betaAngleDeg = (hHat, sunHat) => Math.asin(Math.max(-1, Math.min(1, dot(hHat, sunHat)))) / DEG;

// ── ground stations ─────────────────────────────────────────────────────────
export function stationEcef(latDeg, lonDeg, altKm = 0) {
    const la = latDeg * DEG, lo = lonDeg * DEG, R = RE_KM + altKm;
    return [R * Math.cos(la) * Math.cos(lo), R * Math.cos(la) * Math.sin(lo), R * Math.sin(la)];
}

/** Elevation (deg), slant range (km) and azimuth (deg) of the satellite seen from a station. */
export function lookAngles(station, rEci, gmst) {
    const sat = eciToEcef(rEci, gmst);
    const gs = stationEcef(station.lat, station.lon, station.altKm || 0);
    const rho = sub(sat, gs);
    const range = norm(rho);
    const la = station.lat * DEG, lo = station.lon * DEG;
    const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const east = [-Math.sin(lo), Math.cos(lo), 0];
    const north = cross(up, east);
    const el = Math.asin(dot(rho, up) / range) / DEG;
    const az = (Math.atan2(dot(rho, east), dot(rho, north)) / DEG + 360) % 360;
    return { elevation: el, range, azimuth: az };
}

// ── geomagnetic field: tilted dipole ────────────────────────────────────────
// IGRF-14 (2025) dipole: g10 ≈ −29,350 nT, geomagnetic north pole ≈ 80.8°N, 72.6°W.
const B0_NT = 29350;
const POLE = stationEcef(80.8, -72.6, -RE_KM + 1); // direction only
const POLE_HAT = unit(POLE);

/**
 * Tilted-dipole field at a geocentric lat/lon/radius. B = B0 (Re/r)³ [3(m̂·r̂)r̂ − m̂],
 * with m̂ pointing to the geomagnetic *south* pole (Earth's dipole moment).
 * Returns total intensity and local north/east/down components (nT).
 */
export function dipoleField(latDeg, lonDeg, rKm) {
    const rHat = unit(stationEcef(latDeg, lonDeg));
    const m = scale(POLE_HAT, -1);
    const k = B0_NT * Math.pow(RE_KM / rKm, 3);
    const mr = dot(m, rHat);
    const B = scale(sub(scale(rHat, 3 * mr), m), k);
    const lo = lonDeg * DEG;
    const east = [-Math.sin(lo), Math.cos(lo), 0];
    const north = cross(rHat, east);
    const N = dot(B, north), E = dot(B, east), D = -dot(B, rHat);
    return {
        total: Math.hypot(N, E, D), north: N, east: E, down: D,
        declination: Math.atan2(E, N) / DEG,
        inclination: Math.atan2(D, Math.hypot(N, E)) / DEG,
    };
}

/** South Atlantic Anomaly intensity 0..1 (smooth ellipse around −27°, −50°). */
export function saaIntensity(latDeg, lonDeg) {
    const dLat = (latDeg + 27) / 18;
    const dLon = (((lonDeg + 50 + 540) % 360) - 180) / 45;
    const q = dLat * dLat + dLon * dLon;
    return q >= 1 ? 0 : (1 - q) * (1 - q);
}
