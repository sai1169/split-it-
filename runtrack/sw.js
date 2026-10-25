// Offline support: the app shell is served from cache and refreshed in the
// background; map tiles you've already seen are kept for offline viewing.

const SHELL_CACHE = 'runtrack-shell-v1';
const TILE_CACHE = 'runtrack-tiles-v1';
const MAX_TILES = 1500;

const SHELL = [
    './',
    './index.html',
    './styles.css',
    './geo.js',
    './store.js',
    './charts.js',
    './app.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/apple-touch-icon.png',
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => ![SHELL_CACHE, TILE_CACHE].includes(k)).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

async function trimTiles() {
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    if (url.hostname.endsWith('tile.openstreetmap.org')) {
        event.respondWith(caches.open(TILE_CACHE).then(async cache => {
            const hit = await cache.match(req);
            if (hit) return hit;
            const res = await fetch(req);
            if (res.ok) { cache.put(req, res.clone()); trimTiles(); }
            return res;
        }));
        return;
    }

    if (url.origin === location.origin || url.hostname === 'cdnjs.cloudflare.com') {
        event.respondWith(caches.open(SHELL_CACHE).then(async cache => {
            const hit = await cache.match(req, { ignoreSearch: true });
            const fresh = fetch(req).then(res => {
                if (res.ok) cache.put(req, res.clone());
                return res;
            }).catch(() => hit || cache.match('./index.html'));
            if (hit) {
                event.waitUntil(fresh.catch(() => {}));
                return hit;
            }
            return fresh;
        }));
    }
});
