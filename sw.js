const CACHE_NAME = 'boxbox-v4';
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/styles.css',
    '/app.js',
    '/game.js',
    '/manifest.json',
];

/* Install — cache static assets */
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

/* Activate — clean old caches */
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

/* Fetch — network-first for API calls, cache-first for static assets */
self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    /* API calls: always go to network */
    if (url.hostname === 'api.openf1.org' || url.hostname === 'api.jolpi.ca') {
        return;  // let browser handle normally
    }

    /* Google Fonts: cache-first */
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
        e.respondWith(
            caches.match(e.request).then(cached =>
                cached || fetch(e.request).then(res => {
                    const clone = res.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                    return res;
                })
            )
        );
        return;
    }

    /* Static assets: cache-first, then network */
    e.respondWith(
        caches.match(e.request).then(cached =>
            cached || fetch(e.request)
        )
    );
});
