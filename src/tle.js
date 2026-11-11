/**
 * Two-line element set parsing (fixed columns, per the NORAD/CelesTrak format).
 *
 * The original parser split lines on whitespace and read inclination and
 * eccentricity from the wrong line (inclination came out as 98067° — the
 * international designator). TLE fields are column-positioned, so we slice columns
 * and verify each line's mod-10 checksum.
 */

const GM_KM = 398600.4418;
const RE_KM = 6371.0;

/** Mod-10 checksum: digits add their value, '-' adds 1; must equal column 69. */
export function tleChecksumOk(line) {
    if (!line || line.length < 69) return false;
    let sum = 0;
    for (const ch of line.slice(0, 68)) {
        if (ch >= '0' && ch <= '9') sum += ch.charCodeAt(0) - 48;
        else if (ch === '-') sum += 1;
    }
    return sum % 10 === Number(line[68]);
}

/** Parse a 2- or 3-line TLE. Throws on malformed input or a bad checksum. */
export function parseTLE(text, source = 'TLE') {
    const lines = String(text).split(/\r?\n/).map(l => l.replace(/\s+$/, '')).filter(Boolean);
    const i = lines.findIndex((l, k) => l.startsWith('1 ') && lines[k + 1]?.startsWith('2 '));
    if (i < 0) throw new Error('No TLE line pair found');
    const line1 = lines[i], line2 = lines[i + 1];
    const name = i > 0 ? lines[i - 1].replace(/^0 /, '').trim() : 'UNKNOWN';
    if (line1.length < 69 || line2.length < 69) throw new Error('TLE lines must be 69 characters');
    if (!tleChecksumOk(line1) || !tleChecksumOk(line2)) throw new Error('TLE checksum mismatch');

    const yy = Number(line1.slice(18, 20));
    const day = Number(line1.slice(20, 32));
    const year = yy < 57 ? 2000 + yy : 1900 + yy;
    const epochMs = Date.UTC(year, 0, 1) + (day - 1) * 86400000;

    const inclination = Number(line2.slice(8, 16));
    const raan = Number(line2.slice(17, 25));
    const eccentricity = Number(`0.${line2.slice(26, 33).trim()}`);
    const argPerigee = Number(line2.slice(34, 42));
    const meanAnomaly = Number(line2.slice(43, 51));
    const meanMotion = Number(line2.slice(52, 63)); // rev/day

    const T = 86400 / meanMotion;
    const a = Math.cbrt(GM_KM * T * T / (4 * Math.PI * Math.PI));
    const altitude = a - RE_KM;
    return {
        name, line1, line2, epochMs, inclination, raan, eccentricity, argPerigee, meanAnomaly, meanMotion,
        periodMinutes: T / 60, altitude, velocity: Math.sqrt(GM_KM / a), source,
    };
}
