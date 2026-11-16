// Offline cache. Bump VERSION whenever bank.js or app.js changes so phones pick up the update.
const VERSION = 'fifi-eod-v1';
const FILES = ['./', 'index.html', 'bank.js', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))); self.clients.claim(); });
// Network first (gets updates when there is signal), cache when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(VERSION).then(k => k.put(e.request, c)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
