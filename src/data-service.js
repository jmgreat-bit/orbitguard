// Data Service — Manages Real API interactions with Mock Fallbacks
// APIs: CelesTrak (Orbit/Debris), NASA DONKI (Space Weather)

export class DataService {
    constructor() {
        this.tleCache = null;
        this.weatherCache = null;
        this.debrisCache = null;
        this.lastFetch = { tle: 0, weather: 0, debris: 0 };

        // API Endpoints
        this.CELESTRAK_URL = 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE'; // ISS
        this.DONKI_URL = 'https://api.nasa.gov/DONKI/FLR?startDate=2024-01-01&api_key=DEMO_KEY'; // Solar Flares
    }

    // Get Orbit Data (TLE) for our satellite (using ISS as live reference)
    async getOrbitalData() {
        const now = Date.now();
        if (this.tleCache && (now - this.lastFetch.tle < 3600000)) { // 1 hour cache
            return this.tleCache;
        }

        try {
            console.log('Fetching live TLE from CelesTrak...');
            const response = await fetch(this.CELESTRAK_URL);
            if (!response.ok) throw new Error('CelesTrak API failed');
            const text = await response.text();

            const parsed = this.parseTLE(text);
            this.tleCache = parsed;
            this.lastFetch.tle = now;
            return parsed;
        } catch (e) {
            console.warn('Using fallback TLE logic:', e.message);
            return this.getMockTLE();
        }
    }

    // Get Space Weather (Solar Flares)
    async getSpaceWeather() {
        const now = Date.now();
        if (this.weatherCache && (now - this.lastFetch.weather < 1800000)) { // 30 min cache
            return this.weatherCache;
        }

        try {
            // For demo, we might use a hardcoded recent date if live query returns nothing
            // But NASA DEMO_KEY has limits, so we handle failures gracefully
            const response = await fetch(this.DONKI_URL);
            if (!response.ok) throw new Error('NASA DONKI API failed');
            const data = await response.json();

            // Process most recent flare
            const latest = data[data.length - 1];
            const weather = {
                solarFlux: latest ? 150 + Math.random() * 20 : 120, // Mock flux if no recent flare
                geomagneticKp: latest && latest.classType.startsWith('X') ? 6 : 3,
                flareActive: !!latest,
                classType: latest ? latest.classType : 'None'
            };

            this.weatherCache = weather;
            this.lastFetch.weather = now;
            return weather;
        } catch (e) {
            return { solarFlux: 120, geomagneticKp: 3, flareActive: false, classType: 'None' };
        }
    }

    // Get Debris Risks (Mock for now, replacing previous random gen)
    // Real CelesTrak collision assessment (SOCRATES) is restricted, so we use representative real debris TLEs
    async getDebrisRisks() {
        // Return list of known threatening objects
        return [
            { id: 'COSMOS 1408 DEB', dist: 140 + Math.random() * 10, speed: 0.05 },
            { id: 'FENGYUN 1C DEB', dist: 85 + Math.random() * 15, speed: -0.02 },
            { id: 'NOAA 16 DEB', dist: 210 + Math.random() * 20, speed: 0.12 }
        ];
    }

    // TLE Parser (Simplified 3-line format)
    parseTLE(tleString) {
        const lines = tleString.trim().split('\n');
        if (lines.length < 3) return this.getMockTLE();

        // Line 1: Name
        const name = lines[0].trim();

        // Line 2: ... Inclination, RAAN, Eccentricity ...
        // Field 3: Inclination (degrees)
        // Field 4: RAAN (degrees)
        // Field 5: Eccentricity (decimal point assumed)
        const l2 = lines[1].split(/\s+/);
        const inclination = parseFloat(l2[2]);
        const eccentricity = parseFloat('0.' + l2[4]);

        // Line 3: ... ArgPerigee, MeanAnomaly, MeanMotion ...
        // Field 7: Mean Motion (revs per day)
        const l3 = lines[2].split(/\s+/);
        const meanMotion = parseFloat(l3[7]);

        // Orbit height approximation
        // Period T = 86400 / MeanMotion
        // a = cbrt(GM * T^2 / 4pi^2)
        // h = a - EarthRadius
        const T = 86400 / meanMotion;
        const GM = 3.986e14; // m^3/s^2
        const a = Math.cbrt(GM * (T * T) / (4 * Math.PI * Math.PI)); // meters
        const h = (a / 1000) - 6371; // km

        return {
            name,
            inclination,
            eccentricity,
            altitude: h,
            periodMinutes: T / 60,
            velocity: Math.sqrt(398600 / (6371 + h)) // v = sqrt(GM/r) km/s
        };
    }

    getMockTLE() {
        return {
            name: 'CO-PILOT-1 (SIM)',
            inclination: 51.6,
            eccentricity: 0.0005,
            altitude: 420.5,
            periodMinutes: 92.7,
            velocity: 7.66
        };
    }
}
