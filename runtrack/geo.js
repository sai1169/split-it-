// Geometry, run analysis, GPX and formatting helpers.
// A track point is [lat, lng, t, ele, brk]: t = seconds since start,
// ele = metres or null, brk = 1 when the point follows a pause (no distance
// or time is counted between it and the previous point).

const Geo = (() => {
    const R = 6371000;
    const MILE = 1609.344;
    const MOVING_SPEED = 0.5; // m/s; slower than this counts as stopped

    const BEST_EFFORTS = [
        { key: '400m', label: '400m', dist: 400 },
        { key: '1k', label: '1K', dist: 1000 },
        { key: '1mi', label: '1 mile', dist: MILE },
        { key: '5k', label: '5K', dist: 5000 },
        { key: '10k', label: '10K', dist: 10000 },
        { key: 'half', label: 'Half marathon', dist: 21097.5 },
        { key: 'marathon', label: 'Marathon', dist: 42195 }
    ];

    function haversine(lat1, lng1, lat2, lng2) {
        const toRad = Math.PI / 180;
        const dLat = (lat2 - lat1) * toRad;
        const dLng = (lng2 - lng1) * toRad;
        const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(a));
    }

    // Cumulative distance and moving time at every point.
    function analyze(points) {
        const cumDist = [0];
        const cumTime = [0];
        let elevGain = 0;
        let elevRef = null;

        for (let i = 1; i < points.length; i++) {
            const [lat, lng, t, , brk] = points[i];
            const prev = points[i - 1];
            let d = 0;
            let moving = 0;
            if (!brk) {
                d = haversine(prev[0], prev[1], lat, lng);
                const dt = t - prev[2];
                if (dt > 0 && d / dt >= MOVING_SPEED) moving = dt;
            }
            cumDist.push(cumDist[i - 1] + d);
            cumTime.push(cumTime[i - 1] + moving);
        }

        // Elevation gain with a 3m hysteresis to ignore GPS altitude noise.
        for (const p of points) {
            if (p[3] == null) continue;
            if (elevRef == null) { elevRef = p[3]; continue; }
            if (p[3] > elevRef + 3) { elevGain += p[3] - elevRef; elevRef = p[3]; }
            else if (p[3] < elevRef - 3) elevRef = p[3];
        }

        const n = points.length;
        return {
            cumDist,
            cumTime,
            distance: n ? cumDist[n - 1] : 0,
            movingTime: n ? cumTime[n - 1] : 0,
            elapsedTime: n ? points[n - 1][2] - points[0][2] : 0,
            elevGain
        };
    }

    // Moving time at a given distance, interpolated between points.
    function timeAtDistance(cumDist, cumTime, target, hint = 0) {
        let i = hint;
        while (i < cumDist.length - 2 && cumDist[i + 1] < target) i++;
        const d0 = cumDist[i], d1 = cumDist[i + 1] ?? d0;
        const t0 = cumTime[i], t1 = cumTime[i + 1] ?? t0;
        const f = d1 > d0 ? (target - d0) / (d1 - d0) : 0;
        return { time: t0 + f * (t1 - t0), index: i };
    }

    function splits(points, unitMeters) {
        const { cumDist, cumTime, distance } = analyze(points);
        const result = [];
        let prevTime = 0;
        let hint = 0;
        let elevIdx = 0;
        const eleAt = idx => {
            for (let k = idx; k >= 0; k--) if (points[k][3] != null) return points[k][3];
            return null;
        };
        let prevEle = eleAt(0);

        for (let k = 1; k * unitMeters <= distance; k++) {
            const r = timeAtDistance(cumDist, cumTime, k * unitMeters, hint);
            hint = r.index;
            elevIdx = r.index + 1;
            const ele = eleAt(Math.min(elevIdx, points.length - 1));
            result.push({
                n: k,
                distance: unitMeters,
                time: r.time - prevTime,
                elev: ele != null && prevEle != null ? ele - prevEle : null
            });
            prevTime = r.time;
            prevEle = ele;
        }

        const rest = distance - result.length * unitMeters;
        if (rest > 50) {
            const ele = eleAt(points.length - 1);
            result.push({
                n: result.length + 1,
                distance: rest,
                time: cumTime[cumTime.length - 1] - prevTime,
                elev: ele != null && prevEle != null ? ele - prevEle : null,
                partial: true
            });
        }
        return result;
    }

    // Fastest moving time for each standard distance covered within a run.
    function bestEfforts(points) {
        const { cumDist, cumTime, distance } = analyze(points);
        const out = {};
        for (const e of BEST_EFFORTS) {
            if (distance < e.dist) continue;
            let best = Infinity;
            let i = 0;
            for (let j = 1; j < cumDist.length; j++) {
                if (cumDist[j] < e.dist) continue;
                const startDist = cumDist[j] - e.dist;
                while (i < j - 1 && cumDist[i + 1] <= startDist) i++;
                const span = cumDist[i + 1] - cumDist[i];
                const f = span > 0 ? (startDist - cumDist[i]) / span : 0;
                const tStart = cumTime[i] + f * (cumTime[i + 1] - cumTime[i]);
                best = Math.min(best, cumTime[j] - tStart);
            }
            if (best < Infinity && best > 0) out[e.key] = best;
        }
        return out;
    }

    // ---------- GPX ----------

    function parseGPX(text) {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('This file is not valid GPX/XML.');

        const name = doc.querySelector('trk > name, metadata > name')?.textContent?.trim();
        const segs = [...doc.getElementsByTagName('trkseg')];
        const groups = segs.length ? segs.map(s => [...s.getElementsByTagName('trkpt')])
            : [[...doc.getElementsByTagName('trkpt')]];

        const raw = [];
        groups.forEach((pts, gi) => {
            pts.forEach((p, pi) => {
                const time = p.getElementsByTagName('time')[0]?.textContent;
                const ele = p.getElementsByTagName('ele')[0]?.textContent;
                raw.push({
                    lat: parseFloat(p.getAttribute('lat')),
                    lng: parseFloat(p.getAttribute('lon')),
                    time: time ? Date.parse(time) : NaN,
                    ele: ele != null ? parseFloat(ele) : null,
                    brk: gi > 0 && pi === 0 ? 1 : 0
                });
            });
        });

        const valid = raw.filter(p => isFinite(p.lat) && isFinite(p.lng));
        if (valid.length < 2) throw new Error('No track points found in this GPX file.');
        if (valid.some(p => isNaN(p.time))) {
            throw new Error('This GPX track has no timestamps, so pace and time cannot be worked out.');
        }

        const start = valid[0].time;
        return {
            name,
            startTime: new Date(start).toISOString(),
            points: valid.map(p => [
                round(p.lat, 6), round(p.lng, 6), Math.round((p.time - start) / 1000),
                p.ele != null && isFinite(p.ele) ? round(p.ele, 1) : null, p.brk
            ])
        };
    }

    function toGPX(activity) {
        const start = Date.parse(activity.startTime);
        const esc = s => String(s).replace(/[<>&"']/g, c => `&#${c.charCodeAt(0)};`);
        let body = '';
        let open = false;
        activity.points.forEach((p, i) => {
            if (i === 0 || p[4]) {
                if (open) body += '    </trkseg>\n';
                body += '    <trkseg>\n';
                open = true;
            }
            body += `      <trkpt lat="${p[0]}" lon="${p[1]}">` +
                (p[3] != null ? `<ele>${p[3]}</ele>` : '') +
                `<time>${new Date(start + p[2] * 1000).toISOString()}</time></trkpt>\n`;
        });
        if (open) body += '    </trkseg>\n';
        return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunTrack" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(activity.name)}</name><time>${activity.startTime}</time></metadata>
  <trk>
    <name>${esc(activity.name)}</name>
    <type>running</type>
${body}  </trk>
</gpx>
`;
    }

    // ---------- formatting ----------

    function round(v, d) {
        const f = 10 ** d;
        return Math.round(v * f) / f;
    }

    function unitMeters(units) {
        return units === 'mi' ? MILE : 1000;
    }

    function fmtDistance(m, units, decimals = 2) {
        return (m / unitMeters(units)).toFixed(decimals);
    }

    function fmtDuration(sec) {
        sec = Math.round(sec || 0);
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const pad = v => String(v).padStart(2, '0');
        return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    // Pace as min:sec per unit, from metres and seconds.
    function fmtPace(meters, sec, units) {
        if (!meters || meters < 1 || !sec) return '–';
        const perUnit = sec / (meters / unitMeters(units));
        if (perUnit > 3600) return '–';
        const m = Math.floor(perUnit / 60);
        const s = Math.round(perUnit % 60);
        return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
    }

    return {
        MILE, BEST_EFFORTS, haversine, analyze, splits, bestEfforts,
        parseGPX, toGPX, round, unitMeters, fmtDistance, fmtDuration, fmtPace
    };
})();
