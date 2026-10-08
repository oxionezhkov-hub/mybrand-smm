// Offline cache for the ARA trainer (/ara/). Network first, cached copy when offline.
const CACHE = 'ara-v1';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.add('/ara/')).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('ara-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const put = (req, res) => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; };

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/ara/api/')) return;
  if (url.origin === self.location.origin && url.pathname.startsWith('/ara')) {
    e.respondWith(fetch(req).then(res => res.ok ? put(req, res) : res)
      .catch(() => caches.match(req).then(m => m || caches.match('/ara/'))));
  } else if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.match(req).then(m => m || fetch(req).then(res => put(req, res))));
  }
});
