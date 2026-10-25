// RunTrack: views, routing and the live GPS recorder.

const app = document.getElementById('app');
let cleanupView = null;

// ---------- helpers ----------

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function units() {
    return Store.settings().units;
}

function unitLabel() {
    return units() === 'mi' ? 'mi' : 'km';
}

function dist(m, decimals = 2) {
    return Geo.fmtDistance(m, units(), decimals);
}

function pace(m, s) {
    return Geo.fmtPace(m, s, units());
}

function elev(m) {
    return units() === 'mi' ? `${Math.round(m * 3.28084)}<span class="unit">ft</span>` : `${Math.round(m)}<span class="unit">m</span>`;
}

function stat(label, value, unit = '') {
    return `<div class="stat"><div class="label">${label}</div><div class="value">${value}${unit ? `<span class="unit">${unit}</span>` : ''}</div></div>`;
}

function fmtDate(iso, withTime = true) {
    const d = new Date(iso);
    const opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' };
    if (withTime) Object.assign(opts, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleString(undefined, opts);
}

function startOfWeek(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d;
}

function defaultRunName(date = new Date()) {
    const h = date.getHours();
    if (h >= 5 && h < 12) return 'Morning Run';
    if (h >= 12 && h < 14) return 'Lunch Run';
    if (h >= 14 && h < 18) return 'Afternoon Run';
    if (h >= 18 && h < 22) return 'Evening Run';
    return 'Night Run';
}

function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
}

function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function totals(list) {
    return list.reduce((t, a) => ({
        count: t.count + 1,
        distance: t.distance + a.distance,
        time: t.time + a.movingTime,
        elev: t.elev + (a.elevGain || 0)
    }), { count: 0, distance: 0, time: 0, elev: 0 });
}

function thisWeek(list) {
    const start = startOfWeek(new Date());
    return list.filter(a => new Date(a.startTime) >= start);
}

function baseMap(elId) {
    const map = L.map(elId, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    return map;
}

// Split a track into polylines at pause breaks.
function trackLines(points) {
    const lines = [];
    let cur = [];
    for (const p of points) {
        if (p[4] && cur.length) { lines.push(cur); cur = []; }
        cur.push([p[0], p[1]]);
    }
    if (cur.length) lines.push(cur);
    return lines;
}

// A small SVG outline of the route for feed cards.
function routeThumb(points) {
    if (!points || points.length < 2) return '';
    const step = Math.max(1, Math.floor(points.length / 200));
    const cosLat = Math.cos(points[0][0] * Math.PI / 180);
    const xy = points.filter((_, i) => i % step === 0).map(p => [p[1] * cosLat, -p[0]]);
    const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const w = Math.max(...xs) - minX || 1e-5, h = Math.max(...ys) - minY || 1e-5;
    const padX = w * 0.08, padY = h * 0.08;
    const pts = xy.map(([x, y]) => `${(x - minX).toFixed(6)},${(y - minY).toFixed(6)}`).join(' ');
    return `<svg class="route-thumb" viewBox="${-padX} ${-padY} ${w + 2 * padX} ${h + 2 * padY}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}

function buzz(pattern) {
    try { navigator.vibrate?.(pattern); } catch {}
}

// Spoken updates so you don't have to look at the phone mid-run.
function say(text) {
    if (!Store.settings().voiceCues || !window.speechSynthesis) return;
    try {
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1;
        speechSynthesis.cancel();
        speechSynthesis.speak(u);
    } catch {}
}

function spokenDuration(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const parts = [];
    if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
    if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
    if (s || !parts.length) parts.push(`${s} second${s === 1 ? '' : 's'}`);
    return parts.join(' ');
}

// ---------- install as an app ----------

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    installPrompt = e;
    if ((location.hash || '#/feed').startsWith('#/feed') || location.hash.startsWith('#/settings')) router();
});
window.addEventListener('appinstalled', () => { installPrompt = null; toast('RunTrack installed'); });

function isStandalone() {
    return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function installCard({ dismissible }) {
    if (isStandalone()) return '';
    if (dismissible) {
        try { if (localStorage.getItem('runtrack.installDismissed')) return ''; } catch {}
    }
    let body;
    if (installPrompt) {
        body = '<div><strong>Install RunTrack</strong><div class="muted small">Add it to your home screen and use it like an app, even offline.</div></div><button class="btn btn-primary" id="install-btn">Install</button>';
    } else if (isIOS()) {
        body = '<div><strong>Install RunTrack</strong><div class="muted small">In Safari, tap the Share button, then <b>Add to Home Screen</b>.</div></div>';
    } else if (!dismissible) {
        body = '<div><strong>Install RunTrack</strong><div class="muted small">Open this page in Chrome or Safari on your phone and use “Add to Home Screen” / “Install app”.</div></div>';
    } else {
        return '';
    }
    return `<div class="card install-banner"><img src="icons/icon-192.png" alt="">${body}${dismissible ? '<button class="btn" id="install-dismiss" aria-label="Dismiss">✕</button>' : ''}</div>`;
}

function bindInstallCard() {
    document.getElementById('install-btn')?.addEventListener('click', async () => {
        if (!installPrompt) return;
        installPrompt.prompt();
        await installPrompt.userChoice.catch(() => {});
        installPrompt = null;
        router();
    });
    document.getElementById('install-dismiss')?.addEventListener('click', e => {
        try { localStorage.setItem('runtrack.installDismissed', '1'); } catch {}
        e.target.closest('.card').remove();
    });
}

// ---------- router ----------

const routes = {
    feed: renderFeed,
    activity: renderActivity,
    record: renderRecord,
    add: renderAdd,
    profile: renderProfile,
    settings: renderSettings
};

function router() {
    const [name = 'feed', param] = location.hash.replace(/^#\/?/, '').split('/');
    if (cleanupView) { cleanupView(); cleanupView = null; }
    document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === name));
    document.body.classList.toggle('on-record', name === 'record');
    window.scrollTo(0, 0);
    (routes[name] || renderFeed)(param);
}

window.addEventListener('hashchange', router);

// The OS drops the screen wake lock whenever the page is hidden; take it back.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') Rec.keepAwake();
});

// ---------- feed ----------

function renderFeed() {
    const list = Store.activities();
    const s = Store.settings();
    const week = totals(thisWeek(list));
    const goalPct = Math.min(100, (week.distance / s.weeklyGoal) * 100);
    const latest = list[0];

    const sidebar = `
        <div class="card">
            <div class="activity-head">
                <div class="avatar lg">${esc(s.name.charAt(0).toUpperCase())}</div>
                <div><h2 style="margin:0">${esc(s.name)}</h2><div class="muted small">${list.length} runs</div></div>
            </div>
            ${latest ? `<div class="muted small">Latest: <a href="#/activity/${latest.id}">${esc(latest.name)}</a></div>` : ''}
        </div>
        <div class="card">
            <h2>This week</h2>
            <div class="stats">${stat('Distance', dist(week.distance, 1), unitLabel())}${stat('Time', Geo.fmtDuration(week.time))}${stat('Runs', week.count)}</div>
            <div class="progress" role="progressbar" aria-valuenow="${Math.round(goalPct)}" aria-valuemin="0" aria-valuemax="100"><div style="width:${goalPct}%"></div></div>
            <div class="muted small">${dist(week.distance, 1)} / ${dist(s.weeklyGoal, 0)} ${unitLabel()} weekly goal</div>
        </div>`;

    const feed = list.length ? list.map(activityCard).join('') : `
        <div class="card empty">
            <div class="icon">👟</div>
            <h2>No runs yet</h2>
            <p>Record your first run with GPS, import a GPX file, or load some sample runs to explore.</p>
            <div class="btn-row" style="justify-content:center">
                <a class="btn btn-primary" href="#/record">Record a run</a>
                <a class="btn" href="#/add">Import GPX</a>
                <button class="btn" id="load-samples">Load sample runs</button>
            </div>
        </div>`;

    app.innerHTML = `${installCard({ dismissible: true })}<div class="grid-2"><aside>${sidebar}</aside><section>${feed}</section></div>`;
    bindInstallCard();
    document.getElementById('load-samples')?.addEventListener('click', () => {
        Store.loadSamples();
        toast('Sample runs loaded');
        router();
    });
}

function activityCard(a) {
    const s = Store.settings();
    return `
        <a class="card activity-card" href="#/activity/${a.id}">
            <div class="activity-head">
                <div class="avatar">${esc(s.name.charAt(0).toUpperCase())}</div>
                <div>
                    <div style="font-weight:600">${esc(s.name)}</div>
                    <div class="muted small">${fmtDate(a.startTime)}${a.points ? '' : ' · Manual entry'}</div>
                </div>
            </div>
            <h3>${esc(a.name)}</h3>
            <div class="stats">
                ${stat('Distance', dist(a.distance), unitLabel())}
                ${stat('Pace', pace(a.distance, a.movingTime), `/${unitLabel()}`)}
                ${stat('Time', Geo.fmtDuration(a.movingTime))}
                ${a.elevGain ? stat('Elev gain', elev(a.elevGain)) : ''}
            </div>
            ${routeThumb(a.points)}
        </a>`;
}

// ---------- activity detail ----------

function renderActivity(id) {
    const a = Store.get(id);
    if (!a) {
        app.innerHTML = `<div class="card empty"><h2>Activity not found</h2><p><a href="#/feed">Back to feed</a></p></div>`;
        return;
    }
    const u = units();
    const prs = Store.personalRecords();
    const splitList = a.points ? Geo.splits(a.points, Geo.unitMeters(u)) : [];
    const fastest = Math.min(...splitList.map(sp => sp.time / sp.distance));
    const hasElev = a.points && a.points.some(p => p[3] != null);

    const splitsHtml = splitList.length ? `
        <div class="card">
            <h2>Splits</h2>
            <table>
                <thead><tr><th>${unitLabel().toUpperCase()}</th><th class="num">Pace</th><th style="width:45%"></th><th class="num">Elev</th></tr></thead>
                <tbody>${splitList.map(sp => `
                    <tr>
                        <td>${sp.partial ? dist(sp.distance) : sp.n}</td>
                        <td class="num">${pace(sp.distance, sp.time)}</td>
                        <td><div class="split-bar" style="width:${(fastest / (sp.time / sp.distance)) * 100}%" title="${pace(sp.distance, sp.time)} /${unitLabel()}"></div></td>
                        <td class="num">${sp.elev == null ? '–' : (u === 'mi' ? Math.round(sp.elev * 3.28084) : Math.round(sp.elev))}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>` : '';

    const efforts = Geo.BEST_EFFORTS.filter(e => a.bestEfforts?.[e.key]);
    const effortsHtml = efforts.length ? `
        <div class="card">
            <h2>Best efforts</h2>
            <table>
                <thead><tr><th>Distance</th><th class="num">Time</th><th class="num">Pace</th></tr></thead>
                <tbody>${efforts.map(e => {
                    const t = a.bestEfforts[e.key];
                    const isPR = prs[e.key]?.activityId === a.id;
                    return `<tr><td>${e.label}${isPR ? '<span class="pr-badge">PR</span>' : ''}</td><td class="num">${Geo.fmtDuration(t)}</td><td class="num">${pace(e.dist, t)} /${unitLabel()}</td></tr>`;
                }).join('')}</tbody>
            </table>
        </div>` : '';

    app.innerHTML = `
        <div class="card">
            <div class="muted small">${fmtDate(a.startTime)}${a.points ? '' : ' · Manual entry'}</div>
            <h1 class="page-title" style="margin:6px 0 4px">${esc(a.name)}</h1>
            ${a.description ? `<p style="margin-bottom:14px;white-space:pre-wrap">${esc(a.description)}</p>` : ''}
            <div class="stats" style="margin:14px 0">
                ${stat('Distance', dist(a.distance), unitLabel())}
                ${stat('Moving time', Geo.fmtDuration(a.movingTime))}
                ${stat('Pace', pace(a.distance, a.movingTime), `/${unitLabel()}`)}
                ${a.points ? stat('Elapsed time', Geo.fmtDuration(a.elapsedTime)) : ''}
                ${hasElev ? stat('Elevation gain', elev(a.elevGain || 0)) : ''}
            </div>
            <div class="btn-row">
                <button class="btn" id="edit">Edit</button>
                ${a.points ? '<button class="btn" id="gpx">Export GPX</button>' : ''}
                <button class="btn btn-danger" id="delete">Delete</button>
            </div>
            <form id="edit-form" style="display:none;margin-top:16px">
                <label class="field">Title<input name="name" value="${esc(a.name)}" required maxlength="100"></label>
                <label class="field">Description<textarea name="description" rows="3" maxlength="2000">${esc(a.description)}</textarea></label>
                <div class="btn-row"><button class="btn btn-primary" type="submit">Save</button><button class="btn" type="button" id="cancel-edit">Cancel</button></div>
            </form>
        </div>
        ${a.points ? '<div id="map" class="map"></div>' : ''}
        ${hasElev ? '<div class="card"><h2>Elevation</h2><div id="elev-chart"></div></div>' : ''}
        ${splitsHtml}
        ${effortsHtml}
        <div class="card">
            <h2>Notes</h2>
            <div id="comments">${(a.comments || []).map(c => `
                <div class="comment"><div class="muted small">${fmtDate(c.at)}</div><div style="white-space:pre-wrap">${esc(c.text)}</div></div>`).join('') || '<p class="muted small">Add how it felt, the weather, the shoes you wore…</p>'}
            </div>
            <form id="comment-form" style="margin-top:12px;display:flex;gap:8px">
                <input name="text" placeholder="Add a note" required maxlength="1000" style="flex:1;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font:inherit">
                <button class="btn btn-primary" type="submit">Post</button>
            </form>
        </div>`;

    const form = document.getElementById('edit-form');
    document.getElementById('edit').onclick = () => { form.style.display = form.style.display === 'none' ? 'block' : 'none'; };
    document.getElementById('cancel-edit').onclick = () => { form.style.display = 'none'; };
    form.onsubmit = e => {
        e.preventDefault();
        const fd = new FormData(form);
        Store.update(a.id, { name: fd.get('name').trim() || a.name, description: fd.get('description').trim() });
        router();
    };
    document.getElementById('delete').onclick = () => {
        if (confirm(`Delete "${a.name}"? This can't be undone.`)) {
            Store.remove(a.id);
            location.hash = '#/feed';
        }
    };
    document.getElementById('gpx')?.addEventListener('click', () => {
        download(`${a.name.replace(/[^\w-]+/g, '_')}.gpx`, Geo.toGPX(a), 'application/gpx+xml');
    });
    document.getElementById('comment-form').onsubmit = e => {
        e.preventDefault();
        const text = new FormData(e.target).get('text').trim();
        if (!text) return;
        Store.update(a.id, { comments: [...(a.comments || []), { text, at: new Date().toISOString() }] });
        router();
    };

    if (a.points) {
        const map = baseMap('map');
        const lines = trackLines(a.points);
        const poly = L.polyline(lines, { color: '#fc4c02', weight: 4 }).addTo(map);
        const first = a.points[0], last = a.points[a.points.length - 1];
        L.circleMarker([first[0], first[1]], { radius: 7, color: '#fff', weight: 2, fillColor: '#1f8a4c', fillOpacity: 1 }).addTo(map).bindTooltip('Start');
        L.circleMarker([last[0], last[1]], { radius: 7, color: '#fff', weight: 2, fillColor: '#c62828', fillOpacity: 1 }).addTo(map).bindTooltip('Finish');
        map.fitBounds(poly.getBounds(), { padding: [20, 20] });
        cleanupView = () => map.remove();
    }

    if (hasElev) {
        const { cumDist } = Geo.analyze(a.points);
        const xs = [], ys = [];
        a.points.forEach((p, i) => { if (p[3] != null) { xs.push(cumDist[i]); ys.push(u === 'mi' ? p[3] * 3.28084 : p[3]); } });
        const eu = u === 'mi' ? 'ft' : 'm';
        Charts.area(document.getElementById('elev-chart'), xs, ys, {
            formatX: v => `${dist(v, 1)} ${unitLabel()}`,
            formatY: v => `${Math.round(v)} ${eu}`
        });
    }
}

// ---------- live recorder ----------

const Rec = {
    status: 'idle', // idle | recording | paused
    points: [],
    distance: 0,
    startedAt: 0,
    pausedMs: 0,
    pauseStart: 0,
    needBreak: false,
    watchId: null,
    simTimer: null,
    simulate: false,
    simBase: 0,
    simReal: 0,
    simPos: null,
    simHeading: 0,
    lastFix: null,
    wakeLock: null,
    listeners: new Set(),

    // Simulation runs 10x faster than real time so a test run takes minutes, not an hour.
    now() {
        return this.simulate ? this.simBase + (Date.now() - this.simReal) * 10 : Date.now();
    },

    timer() {
        if (this.status === 'idle') return 0;
        const pausedNow = this.status === 'paused' ? this.now() - this.pauseStart : 0;
        return Math.max(0, (this.now() - this.startedAt - this.pausedMs - pausedNow) / 1000);
    },

    // Pace over the last ~30 seconds of movement.
    currentPace() {
        const pts = this.points;
        if (pts.length < 2 || this.status !== 'recording') return '–';
        const last = pts[pts.length - 1];
        let d = 0, i = pts.length - 1;
        while (i > 0 && !pts[i][4] && last[2] - pts[i - 1][2] <= 30) {
            d += Geo.haversine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
            i--;
        }
        return pace(d, last[2] - pts[i][2]);
    },

    emit() {
        this.listeners.forEach(fn => fn());
    },

    onFix(lat, lng, ele, accuracy, timestamp) {
        this.lastFix = { lat, lng, accuracy, at: Date.now() };
        if (this.status === 'recording' && accuracy <= 35) {
            const t = Math.round((timestamp - this.startedAt) / 100) / 10;
            const prev = this.points[this.points.length - 1];
            const point = [Geo.round(lat, 6), Geo.round(lng, 6), t, ele != null ? Geo.round(ele, 1) : null, this.needBreak ? 1 : 0];
            if (!prev) {
                this.points.push(point);
            } else {
                const d = Geo.haversine(prev[0], prev[1], lat, lng);
                const dt = t - prev[2];
                // Skip jitter while standing still and impossible GPS jumps.
                if (this.needBreak || (d >= 3 && dt > 0 && d / dt < 12)) {
                    if (!this.needBreak) this.distance += d;
                    this.points.push(point);
                    this.checkSplit();
                }
            }
            this.needBreak = false;
            if (this.points.length % 5 === 0) this.saveDraft();
        }
        this.emit();
    },

    // Announce each completed km/mile.
    checkSplit() {
        const unit = Geo.unitMeters(units());
        const done = Math.floor(this.distance / unit);
        if (done <= this.splitsAnnounced) return;
        const t = this.timer();
        const splitTime = t - this.lastSplitAt;
        this.splitsAnnounced = done;
        this.lastSplitAt = t;
        buzz([200, 100, 200]);
        const name = units() === 'mi' ? 'mile' : 'kilometre';
        say(`${done} ${name}${done === 1 ? '' : 's'}. Time ${spokenDuration(t)}. ` +
            `Average pace ${spokenDuration(t / done)} per ${name}. Last split ${spokenDuration(splitTime)}.`);
    },

    async keepAwake() {
        if (this.status === 'idle' || this.wakeLock) return;
        try {
            this.wakeLock = await navigator.wakeLock?.request('screen');
            this.wakeLock?.addEventListener?.('release', () => { this.wakeLock = null; });
        } catch {}
    },

    saveDraft() {
        Store.draft.set({ points: this.points, startedAt: this.startedAt });
    },

    startGPS() {
        if (this.simulate) {
            if (!this.simPos) {
                const origin = this.lastFix || { lat: 51.5073, lng: -0.1657 };
                this.simPos = { lat: origin.lat, lng: origin.lng };
                this.simHeading = Math.random() * 360;
            }
            this.simTimer = setInterval(() => this.simStep(), 100);
            this.simStep();
            return;
        }
        if (!navigator.geolocation) {
            alert('This browser does not support GPS location.');
            return;
        }
        this.watchId = navigator.geolocation.watchPosition(
            pos => this.onFix(pos.coords.latitude, pos.coords.longitude, pos.coords.altitude, pos.coords.accuracy, pos.timestamp),
            err => { this.gpsError = err.message; this.emit(); },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
        );
    },

    // One simulated second of running: ~3m/s with a wandering heading.
    simStep() {
        const speed = 2.8 + Math.random() * 0.6;
        this.simHeading += (Math.random() - 0.5) * 20;
        const rad = this.simHeading * Math.PI / 180;
        this.simPos.lat += (speed * Math.cos(rad)) / 111320;
        this.simPos.lng += (speed * Math.sin(rad)) / (111320 * Math.cos(this.simPos.lat * Math.PI / 180));
        const ele = 30 + 10 * Math.sin(this.distance / 400);
        this.onFix(this.simPos.lat, this.simPos.lng, ele, 5, this.now());
    },

    stopGPS() {
        if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
        clearInterval(this.simTimer);
        this.watchId = null;
        this.simTimer = null;
    },

    async start(simulate) {
        this.simulate = simulate;
        this.points = [];
        this.distance = 0;
        this.pausedMs = 0;
        this.needBreak = false;
        this.gpsError = null;
        this.stopGPS();
        this.simPos = null;
        this.simBase = Date.now();
        this.simReal = Date.now();
        this.startedAt = this.now();
        this.status = 'recording';
        this.splitsAnnounced = 0;
        this.lastSplitAt = 0;
        this.startGPS();
        buzz(300);
        say('Run started');
        this.keepAwake();
        this.emit();
    },

    pause(silent = false) {
        this.status = 'paused';
        this.pauseStart = this.now();
        if (!silent) { buzz(150); say('Run paused'); }
        this.emit();
    },

    resume() {
        if (this.watchId == null && this.simTimer == null) this.startGPS();
        this.pausedMs += this.now() - this.pauseStart;
        this.needBreak = this.points.length > 0;
        this.status = 'recording';
        buzz(150);
        say('Run resumed');
        this.keepAwake();
        this.emit();
    },

    finish() {
        if (this.status === 'recording') this.pause(true);
        this.stopGPS();
        this.wakeLock?.release?.();
        this.wakeLock = null;
    },

    reset() {
        this.stopGPS();
        this.status = 'idle';
        this.points = [];
        this.distance = 0;
        Store.draft.clear();
        this.emit();
    }
};

function renderRecord() {
    const draft = Rec.status === 'idle' ? Store.draft.get() : null;

    app.innerHTML = `
        ${draft && draft.points?.length > 1 ? `
            <div class="card draft-card">
                <h2>Unfinished run found</h2>
                <p class="muted" style="margin-bottom:12px">A recording from ${fmtDate(new Date(draft.startedAt).toISOString())} wasn't saved.</p>
                <div class="btn-row"><button class="btn btn-primary" id="draft-save">Save it</button><button class="btn" id="draft-discard">Discard</button></div>
            </div>` : ''}
        <div id="rec-map" class="map tall"></div>
        <div class="card rec-sheet" id="rec-sheet">
            <div class="record-stats big">
                <div class="stat primary"><div class="label">Distance (${unitLabel()})</div><div class="value" id="r-dist">0.00</div></div>
                <div class="stat"><div class="label">Time</div><div class="value" id="r-time">0:00</div></div>
                <div class="stat"><div class="label">Avg pace (/${unitLabel()})</div><div class="value" id="r-pace">–</div></div>
            </div>
            <div class="gps-status muted" id="r-gps"></div>
            <div class="record-controls" id="r-controls"></div>
            <form id="finish-form" style="display:none;margin-top:20px">
                <label class="field">Title<input name="name" required maxlength="100"></label>
                <label class="field">How did it go?<textarea name="description" rows="3" maxlength="2000"></textarea></label>
                <div class="btn-row"><button class="btn btn-primary" type="submit">Save run</button><button class="btn" type="button" id="resume-from-finish">Resume</button><button class="btn btn-danger" type="button" id="discard">Discard</button></div>
            </form>
        </div>`;

    if (draft) {
        document.getElementById('draft-save')?.addEventListener('click', () => {
            const a = Store.save({ name: defaultRunName(new Date(draft.startedAt)), startTime: new Date(draft.startedAt).toISOString(), points: draft.points });
            Store.draft.clear();
            if (a) location.hash = `#/activity/${a.id}`;
        });
        document.getElementById('draft-discard')?.addEventListener('click', () => { Store.draft.clear(); router(); });
    }

    const map = baseMap('rec-map');
    map.setView(Rec.lastFix ? [Rec.lastFix.lat, Rec.lastFix.lng] : [51.5073, -0.1657], 16);
    const track = L.polyline([], { color: '#fc4c02', weight: 5 }).addTo(map);
    const me = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 3, fillColor: '#1a73e8', fillOpacity: 1 });
    let follow = true;
    map.on('dragstart', () => { follow = false; });

    // Show where the user is before they press start.
    let previewWatch = null;
    if (Rec.status === 'idle' && navigator.geolocation) {
        previewWatch = navigator.geolocation.watchPosition(
            pos => Rec.onFix(pos.coords.latitude, pos.coords.longitude, pos.coords.altitude, pos.coords.accuracy, pos.timestamp),
            err => { Rec.gpsError = err.message; Rec.emit(); },
            { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
        );
    }
    const stopPreview = () => {
        if (previewWatch != null) navigator.geolocation.clearWatch(previewWatch);
        previewWatch = null;
    };

    const controls = document.getElementById('r-controls');
    const finishForm = document.getElementById('finish-form');

    function renderControls() {
        if (finishForm.style.display !== 'none') { controls.innerHTML = ''; return; }
        if (Rec.status === 'idle') {
            const voice = Store.settings().voiceCues;
            controls.innerHTML = `
                <button class="round-btn go lg" id="r-start">Start</button>
                <div class="record-options small muted">
                    <label><input type="checkbox" id="r-voice" ${voice ? 'checked' : ''}> Voice updates every ${unitLabel()}</label>
                    <label><input type="checkbox" id="r-sim"> Simulate GPS (10× speed, for trying it out)</label>
                </div>`;
            document.getElementById('r-voice').onchange = e => Store.saveSettings({ voiceCues: e.target.checked });
            document.getElementById('r-start').onclick = () => {
                stopPreview();
                Rec.start(document.getElementById('r-sim').checked);
                follow = true;
            };
        } else if (Rec.status === 'recording') {
            controls.innerHTML = '<button class="round-btn stop" id="r-lock" aria-label="Lock screen">🔒</button><button class="round-btn go lg" id="r-pause">Pause</button>';
            document.getElementById('r-pause').onclick = () => Rec.pause();
            document.getElementById('r-lock').onclick = lockScreen;
        } else {
            controls.innerHTML = '<button class="round-btn go lg" id="r-resume">Resume</button><button class="round-btn stop lg" id="r-finish">Finish</button>';
            document.getElementById('r-resume').onclick = () => Rec.resume();
            document.getElementById('r-finish').onclick = showFinish;
        }
        sizeMap();
    }

    // Stops pocket taps from pausing the run; press and hold to unlock.
    function lockScreen() {
        const overlay = document.createElement('div');
        overlay.className = 'locked-overlay';
        overlay.innerHTML = '<button type="button">🔒 Hold to unlock</button>';
        const btn = overlay.firstChild;
        let holdTimer = null;
        const cancel = () => { clearTimeout(holdTimer); btn.textContent = '🔒 Hold to unlock'; };
        btn.addEventListener('pointerdown', () => {
            btn.textContent = 'Keep holding…';
            holdTimer = setTimeout(() => { overlay.remove(); buzz(50); }, 800);
        });
        btn.addEventListener('pointerup', cancel);
        btn.addEventListener('pointerleave', cancel);
        overlay.addEventListener('contextmenu', e => e.preventDefault());
        document.body.appendChild(overlay);
        removeLock = () => overlay.remove();
    }
    let removeLock = () => {};

    // On phones the map fills whatever the bottom sheet leaves free.
    const sheet = document.getElementById('rec-sheet');
    function sizeMap() {
        document.body.style.setProperty('--sheet-h', `${sheet.offsetHeight - 16}px`);
        map.invalidateSize();
    }
    const resizeObs = new ResizeObserver(sizeMap);

    function showFinish() {
        if (Rec.points.length < 2) {
            if (confirm('Not enough GPS data was recorded to save this run. Discard it?')) {
                Rec.reset();
                router();
            }
            return;
        }
        Rec.finish();
        say('Run finished');
        finishForm.style.display = 'block';
        finishForm.elements.name.value = defaultRunName(new Date(Rec.startedAt));
        renderControls();
    }

    finishForm.onsubmit = e => {
        e.preventDefault();
        const fd = new FormData(finishForm);
        const a = Store.save({
            name: fd.get('name').trim() || defaultRunName(),
            description: fd.get('description').trim(),
            startTime: new Date(Rec.startedAt).toISOString(),
            points: Rec.points
        });
        if (!a) return;
        Rec.reset();
        toast('Run saved');
        location.hash = `#/activity/${a.id}`;
    };
    document.getElementById('resume-from-finish').onclick = () => {
        finishForm.style.display = 'none';
        Rec.resume();
    };
    document.getElementById('discard').onclick = () => {
        if (confirm('Discard this run?')) {
            Rec.reset();
            router();
        }
    };

    function update() {
        document.getElementById('r-dist').textContent = dist(Rec.distance);
        document.getElementById('r-time').textContent = Geo.fmtDuration(Rec.timer());
        document.getElementById('r-pace').textContent = pace(Rec.distance, Rec.timer());

        const gps = document.getElementById('r-gps');
        const fix = Rec.lastFix;
        if (Rec.simulate && Rec.status !== 'idle') {
            gps.innerHTML = `<span class="gps-dot ok"></span>Simulated GPS · current pace ${Rec.currentPace()} /${unitLabel()}`;
        } else if (fix && Date.now() - fix.at < 15000) {
            const good = fix.accuracy <= 35;
            gps.innerHTML = `<span class="gps-dot ${good ? 'ok' : 'bad'}"></span>GPS ±${Math.round(fix.accuracy)}m${Rec.status === 'recording' ? ` · current pace ${Rec.currentPace()} /${unitLabel()}` : ''}${good ? '' : ' · waiting for a better signal'}`;
        } else if (Rec.gpsError) {
            gps.innerHTML = `<span class="gps-dot bad"></span>${esc(Rec.gpsError)}`;
        } else {
            gps.innerHTML = '<span class="gps-dot"></span>Searching for GPS…';
        }
        if (Rec.status === 'paused' && finishForm.style.display === 'none') gps.innerHTML += ' · <strong>Paused</strong>';

        track.setLatLngs(trackLines(Rec.points));
        if (fix) {
            me.setLatLng([fix.lat, fix.lng]);
            if (!map.hasLayer(me)) me.addTo(map);
            if (follow) map.panTo([fix.lat, fix.lng], { animate: false });
        }
    }

    let lastStatus = null;
    const listener = () => {
        document.body.classList.toggle('rec-active', Rec.status !== 'idle');
        if (Rec.status !== lastStatus) { lastStatus = Rec.status; renderControls(); }
        update();
    };
    Rec.listeners.add(listener);
    const tick = setInterval(update, 1000);
    document.body.classList.toggle('rec-active', Rec.status !== 'idle');
    renderControls();
    update();

    resizeObs.observe(sheet);

    cleanupView = () => {
        resizeObs.disconnect();
        document.body.classList.remove('rec-active');
        removeLock();
        document.body.style.removeProperty('--sheet-h');
        Rec.listeners.delete(listener);
        clearInterval(tick);
        stopPreview();
        map.remove();
    };
}

// ---------- add / import ----------

function renderAdd() {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
    app.innerHTML = `
        <h1 class="page-title">Add a run</h1>
        <div class="card">
            <h2>Import a GPX file</h2>
            <p class="muted small" style="margin-bottom:12px">Export a GPX from your watch, Garmin Connect, Strava or any running app and drop it here. You can pick several files at once.</p>
            <input type="file" id="gpx-file" accept=".gpx,application/gpx+xml" multiple>
            <div id="gpx-result" class="small" style="margin-top:10px"></div>
        </div>
        <div class="card">
            <h2>Manual entry</h2>
            <form id="manual-form">
                <label class="field">Title<input name="name" maxlength="100" placeholder="${defaultRunName()}"></label>
                <div class="field-row">
                    <label class="field">Distance (${unitLabel()})<input name="distance" type="number" step="0.01" min="0.01" required></label>
                    <label class="field">Hours<input name="h" type="number" min="0" value="0"></label>
                    <label class="field">Minutes<input name="m" type="number" min="0" max="59" value="30"></label>
                    <label class="field">Seconds<input name="s" type="number" min="0" max="59" value="0"></label>
                </div>
                <label class="field">Date &amp; time<input name="date" type="datetime-local" value="${now.toISOString().slice(0, 16)}" required></label>
                <label class="field">Elevation gain (${units() === 'mi' ? 'ft' : 'm'}, optional)<input name="elev" type="number" min="0"></label>
                <label class="field">Description<textarea name="description" rows="3" maxlength="2000"></textarea></label>
                <button class="btn btn-primary" type="submit">Save run</button>
            </form>
        </div>`;

    document.getElementById('gpx-file').onchange = async e => {
        const out = document.getElementById('gpx-result');
        out.innerHTML = '';
        let lastId = null;
        for (const file of e.target.files) {
            try {
                const parsed = Geo.parseGPX(await file.text());
                const a = Store.save({
                    name: parsed.name || defaultRunName(new Date(parsed.startTime)),
                    startTime: parsed.startTime,
                    points: parsed.points
                });
                if (a) {
                    lastId = a.id;
                    out.innerHTML += `<div>✅ <a href="#/activity/${a.id}">${esc(a.name)}</a> — ${dist(a.distance)} ${unitLabel()}</div>`;
                }
            } catch (err) {
                out.innerHTML += `<div style="color:var(--danger)">⚠️ ${esc(file.name)}: ${esc(err.message)}</div>`;
            }
        }
        if (lastId && e.target.files.length === 1) location.hash = `#/activity/${lastId}`;
    };

    document.getElementById('manual-form').onsubmit = e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const time = (+fd.get('h') || 0) * 3600 + (+fd.get('m') || 0) * 60 + (+fd.get('s') || 0);
        if (time <= 0) { alert('Please enter how long the run took.'); return; }
        const date = new Date(fd.get('date'));
        const elevIn = parseFloat(fd.get('elev'));
        const a = Store.save({
            name: fd.get('name').trim() || defaultRunName(date),
            description: fd.get('description').trim(),
            startTime: date.toISOString(),
            distance: parseFloat(fd.get('distance')) * Geo.unitMeters(units()),
            movingTime: time,
            elevGain: isFinite(elevIn) ? (units() === 'mi' ? elevIn / 3.28084 : elevIn) : 0
        });
        if (a) location.hash = `#/activity/${a.id}`;
    };
}

// ---------- profile ----------

function renderProfile() {
    const list = Store.activities();
    const s = Store.settings();
    const now = new Date();
    const yearStart = new Date(now.getFullYear(), 0, 1);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const periods = [
        ['This week', thisWeek(list)],
        ['This month', list.filter(a => new Date(a.startTime) >= monthStart)],
        [`${now.getFullYear()}`, list.filter(a => new Date(a.startTime) >= yearStart)],
        ['All time', list]
    ];
    const prs = Store.personalRecords(list);
    const longest = list.reduce((best, a) => (!best || a.distance > best.distance ? a : best), null);

    app.innerHTML = `
        <div class="card">
            <div class="activity-head" style="margin:0">
                <div class="avatar lg">${esc(s.name.charAt(0).toUpperCase())}</div>
                <div><h1 class="page-title" style="margin:0">${esc(s.name)}</h1><div class="muted small">${list.length} runs logged</div></div>
            </div>
        </div>
        <div class="card">
            <h2>Weekly distance</h2>
            <div class="muted small" style="margin-bottom:8px">Last 12 weeks · dashed line is your weekly goal</div>
            <div id="weekly-chart"></div>
        </div>
        <div class="card">
            <h2>Totals</h2>
            <table>
                <thead><tr><th></th><th class="num">Runs</th><th class="num">Distance</th><th class="num">Time</th><th class="num">Elev gain</th></tr></thead>
                <tbody>${periods.map(([label, l]) => {
                    const t = totals(l);
                    return `<tr><td><strong>${label}</strong></td><td class="num">${t.count}</td><td class="num">${dist(t.distance, 1)} ${unitLabel()}</td><td class="num">${Geo.fmtDuration(t.time)}</td><td class="num">${units() === 'mi' ? `${Math.round(t.elev * 3.28084)} ft` : `${Math.round(t.elev)} m`}</td></tr>`;
                }).join('')}</tbody>
            </table>
        </div>
        <div class="card">
            <h2>Personal records</h2>
            <p class="muted small" style="margin-bottom:8px">Fastest efforts found inside your GPS-recorded runs.</p>
            <table>
                <thead><tr><th>Distance</th><th class="num">Time</th><th class="num">Pace</th><th>Run</th></tr></thead>
                <tbody>${Geo.BEST_EFFORTS.map(e => {
                    const pr = prs[e.key];
                    if (!pr) return `<tr><td>${e.label}</td><td class="num muted">–</td><td class="num muted">–</td><td class="muted">Not yet</td></tr>`;
                    const a = list.find(x => x.id === pr.activityId);
                    return `<tr><td>${e.label}</td><td class="num"><strong>${Geo.fmtDuration(pr.time)}</strong></td><td class="num">${pace(e.dist, pr.time)} /${unitLabel()}</td><td><a href="#/activity/${a.id}">${esc(a.name)}</a> <span class="muted small">${fmtDate(a.startTime, false)}</span></td></tr>`;
                }).join('')}
                ${longest ? `<tr><td>Longest run</td><td class="num"><strong>${dist(longest.distance)} ${unitLabel()}</strong></td><td class="num">${pace(longest.distance, longest.movingTime)} /${unitLabel()}</td><td><a href="#/activity/${longest.id}">${esc(longest.name)}</a> <span class="muted small">${fmtDate(longest.startTime, false)}</span></td></tr>` : ''}
                </tbody>
            </table>
        </div>`;

    const weekStart = startOfWeek(now);
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
        const start = new Date(weekStart);
        start.setDate(start.getDate() - i * 7);
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        const runs = list.filter(a => { const d = new Date(a.startTime); return d >= start && d < end; });
        const t = totals(runs);
        weeks.push({
            label: start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
            value: t.distance / Geo.unitMeters(units()),
            valueText: `${dist(t.distance, 1)} ${unitLabel()}`,
            tipLabel: `Week of ${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${t.count} run${t.count === 1 ? '' : 's'}`
        });
    }
    const drawChart = () => Charts.bars(document.getElementById('weekly-chart'), weeks, {
        goal: s.weeklyGoal / Geo.unitMeters(units()),
        formatAxis: v => `${Math.round(v)}`
    });
    drawChart();
    window.addEventListener('resize', drawChart);
    cleanupView = () => window.removeEventListener('resize', drawChart);
}

// ---------- settings ----------

function renderSettings() {
    const s = Store.settings();
    app.innerHTML = `
        <h1 class="page-title">Settings</h1>
        <div class="card">
            <form id="settings-form">
                <label class="field">Your name<input name="name" value="${esc(s.name)}" maxlength="50" required></label>
                <label class="field">Units
                    <select name="units">
                        <option value="km" ${s.units === 'km' ? 'selected' : ''}>Kilometres</option>
                        <option value="mi" ${s.units === 'mi' ? 'selected' : ''}>Miles</option>
                    </select>
                </label>
                <label class="field" style="display:flex;align-items:center;gap:10px"><input name="voice" type="checkbox" ${s.voiceCues ? 'checked' : ''} style="width:auto;margin:0"> Spoken updates while recording (every ${unitLabel()}, pause/resume)</label>
                <label class="field">Weekly distance goal (${unitLabel()})<input name="goal" type="number" min="1" step="0.5" value="${Geo.round(s.weeklyGoal / Geo.unitMeters(s.units), 1)}" required></label>
                <button class="btn btn-primary" type="submit">Save</button>
            </form>
        </div>
        ${installCard({ dismissible: false })}
        <div class="card">
            <h2>Your data</h2>
            <p class="muted small" style="margin-bottom:12px">Everything is stored in this browser only. Export a backup before clearing site data.</p>
            <div class="btn-row">
                <button class="btn" id="export">Export backup (JSON)</button>
                <label class="btn">Restore backup<input type="file" id="restore" accept=".json,application/json" hidden></label>
                <button class="btn" id="samples">Load sample runs</button>
                <button class="btn btn-danger" id="clear">Delete all runs</button>
            </div>
        </div>`;

    bindInstallCard();
    document.getElementById('settings-form').onsubmit = e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const u = fd.get('units');
        Store.saveSettings({
            name: fd.get('name').trim() || 'Runner',
            units: u,
            voiceCues: fd.get('voice') === 'on',
            // The goal box is in the units shown when the page loaded.
            weeklyGoal: parseFloat(fd.get('goal')) * Geo.unitMeters(s.units)
        });
        toast('Settings saved');
        router();
    };
    document.getElementById('export').onclick = () => {
        download(`runtrack-backup-${new Date().toISOString().slice(0, 10)}.json`,
            JSON.stringify({ settings: Store.settings(), activities: Store.activities() }), 'application/json');
    };
    document.getElementById('restore').onchange = async e => {
        try {
            const data = JSON.parse(await e.target.files[0].text());
            if (!Array.isArray(data.activities)) throw new Error('missing activities');
            if (data.settings) Store.saveSettings(data.settings);
            data.activities.forEach(a => Store.save(a));
            toast(`Restored ${data.activities.length} runs`);
            router();
        } catch (err) {
            alert(`That file isn't a RunTrack backup (${err.message}).`);
        }
    };
    document.getElementById('samples').onclick = () => {
        Store.loadSamples();
        toast('Sample runs loaded');
    };
    document.getElementById('clear').onclick = () => {
        if (confirm('Delete every run? Export a backup first if you want to keep them.')) {
            Store.clearAll();
            toast('All runs deleted');
        }
    };
}

router();
