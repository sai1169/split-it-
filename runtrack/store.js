// Persistence in localStorage, plus a generator for sample runs.

const Store = (() => {
    const KEY = 'runtrack.activities';
    const SETTINGS_KEY = 'runtrack.settings';
    const DRAFT_KEY = 'runtrack.draft';

    const defaultSettings = { name: 'Runner', units: 'km', weeklyGoal: 20000, voiceCues: true };

    function read(key, fallback) {
        try {
            const v = localStorage.getItem(key);
            return v ? JSON.parse(v) : fallback;
        } catch {
            return fallback;
        }
    }

    function write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            alert('Could not save: browser storage is full or unavailable.');
            return false;
        }
    }

    function activities() {
        return read(KEY, []).sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime));
    }

    function get(id) {
        return read(KEY, []).find(a => a.id === id);
    }

    // Fill in derived stats from the GPS track (if any) and store the activity.
    function save(activity) {
        const a = { comments: [], description: '', ...activity };
        if (a.points && a.points.length > 1) {
            const s = Geo.analyze(a.points);
            a.distance = s.distance;
            a.movingTime = s.movingTime;
            a.elapsedTime = s.elapsedTime;
            a.elevGain = s.elevGain;
            a.bestEfforts = Geo.bestEfforts(a.points);
        } else {
            a.points = null;
            a.elapsedTime = a.elapsedTime || a.movingTime;
            a.bestEfforts = {};
        }
        a.id = a.id || `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

        const all = read(KEY, []);
        const idx = all.findIndex(x => x.id === a.id);
        if (idx >= 0) all[idx] = a; else all.push(a);
        return write(KEY, all) ? a : null;
    }

    function update(id, changes) {
        const all = read(KEY, []);
        const a = all.find(x => x.id === id);
        if (!a) return null;
        Object.assign(a, changes);
        write(KEY, all);
        return a;
    }

    function remove(id) {
        write(KEY, read(KEY, []).filter(a => a.id !== id));
    }

    function clearAll() {
        localStorage.removeItem(KEY);
        localStorage.removeItem(DRAFT_KEY);
    }

    function settings() {
        return { ...defaultSettings, ...read(SETTINGS_KEY, {}) };
    }

    function saveSettings(s) {
        write(SETTINGS_KEY, { ...settings(), ...s });
    }

    const draft = {
        get: () => read(DRAFT_KEY, null),
        set: d => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch {} },
        clear: () => localStorage.removeItem(DRAFT_KEY)
    };

    // Best moving time per standard distance across every run.
    function personalRecords(list = activities()) {
        const prs = {};
        for (const a of list) {
            for (const [k, t] of Object.entries(a.bestEfforts || {})) {
                if (!prs[k] || t < prs[k].time) prs[k] = { time: t, activityId: a.id, date: a.startTime };
            }
        }
        return prs;
    }

    // ---------- sample data ----------

    function seededRandom(seed) {
        return () => {
            seed = (seed * 16807) % 2147483647;
            return (seed - 1) / 2147483646;
        };
    }

    // A wobbly loop around a park-sized area with a gentle hill.
    function generateRoute(rand, distance, paceSecPerKm, center) {
        const points = [];
        const baseR = distance / (2 * Math.PI);
        const stretch = 0.6 + rand() * 0.8;
        const phase = rand() * Math.PI * 2;
        const wobbleA = rand() * 0.25, wobbleB = rand() * 0.15;
        const mPerDegLat = 111320;
        const mPerDegLng = 111320 * Math.cos(center[0] * Math.PI / 180);
        const steps = Math.round(distance / 20);
        let t = 0;
        let prev = null;

        for (let i = 0; i <= steps; i++) {
            const th = phase + (i / steps) * Math.PI * 2;
            const r = baseR * (1 + wobbleA * Math.sin(3 * th) + wobbleB * Math.cos(5 * th));
            const x = r * Math.cos(th) * stretch;
            const y = r * Math.sin(th) / stretch;
            const lat = center[0] + y / mPerDegLat;
            const lng = center[1] + x / mPerDegLng;
            const ele = 40 + 18 * Math.sin(th - phase) + rand() * 1.5;
            if (prev) {
                const d = Geo.haversine(prev[0], prev[1], lat, lng);
                const variation = 1 + (rand() - 0.5) * 0.12 + 0.04 * Math.sin(th * 2);
                t += d * (paceSecPerKm / 1000) * variation;
            }
            prev = [Geo.round(lat, 6), Geo.round(lng, 6), Math.round(t), Geo.round(ele, 1), 0];
            points.push(prev);
        }
        return points;
    }

    function loadSamples() {
        const rand = seededRandom(Date.now() % 100000 + 1);
        const center = [51.5045, -0.1520]; // Hyde Park, London
        const names = {
            easy: ['Easy morning run', 'Recovery jog', 'Lunch run', 'Evening shakeout'],
            tempo: ['Tempo Tuesday', 'Threshold effort', 'Progression run'],
            long: ['Sunday long run', 'Long slow distance', 'Weekend long one']
        };
        const plan = [
            { day: 1, type: 'easy', km: [5, 7], pace: [330, 360] },
            { day: 2, type: 'tempo', km: [6, 9], pace: [270, 295] },
            { day: 4, type: 'easy', km: [5, 8], pace: [325, 355] },
            { day: 6, type: 'long', km: [12, 22], pace: [315, 345] }
        ];
        const pick = arr => arr[Math.floor(rand() * arr.length)];
        const between = ([a, b]) => a + rand() * (b - a);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const monday = new Date(today);
        monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));

        for (let w = 0; w < 10; w++) {
            for (const p of plan) {
                if (rand() < 0.15) continue; // the odd skipped session
                const date = new Date(monday);
                date.setDate(monday.getDate() - w * 7 + p.day - 1);
                if (date > today) continue;
                date.setHours(p.type === 'long' ? 8 : 7 + Math.floor(rand() * 11), Math.floor(rand() * 60));
                const offset = [center[0] + (rand() - 0.5) * 0.02, center[1] + (rand() - 0.5) * 0.04];
                save({
                    name: pick(names[p.type]),
                    startTime: date.toISOString(),
                    points: generateRoute(rand, between(p.km) * 1000, between(p.pace), offset),
                    sample: true
                });
            }
        }
    }

    return {
        activities, get, save, update, remove, clearAll,
        settings, saveSettings, draft, personalRecords, loadSamples
    };
})();
