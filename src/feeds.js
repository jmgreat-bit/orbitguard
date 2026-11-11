/** Parsers for public space-weather feeds — shared by the browser and server/api.js. */

/** Tolerant Kp extraction: SWPC has served both array-of-arrays (header row) and array-of-objects. */
export function latestKp(data) {
    if (!Array.isArray(data) || !data.length) return null;
    for (let i = data.length - 1; i >= 0; i--) {
        const row = data[i];
        let v = null;
        if (Array.isArray(row)) v = Number(row[1]);
        else if (row && typeof row === 'object') v = Number(row.Kp ?? row.kp ?? row.kp_index ?? row.estimated_kp);
        if (Number.isFinite(v)) return v;
    }
    return null;
}

export function latestF107(data) {
    if (!Array.isArray(data)) return null;
    for (let i = data.length - 1; i >= 0; i--) {
        const v = Number(data[i]?.flux ?? data[i]?.f107);
        if (Number.isFinite(v) && v > 50) return v;
    }
    return null;
}
