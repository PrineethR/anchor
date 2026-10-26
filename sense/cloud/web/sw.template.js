// Keeps the site's own files on this device, so it opens with no connection. Your notes are kept by Firestore itself, not here.
// Build: build.py fills in the version and the file list. A new build means a new cache; the old one is dropped.
// Everything is relative to where this file lives (its scope), so the site works at a domain's root or in a folder of one (prineethr.com/anchor/app/).
const VERSION = '__VERSION__';
const FILES = __FILES__;                       // paths from this folder; '' is the page itself
const CACHE = 'makesense-' + VERSION;
const SCOPE = self.registration.scope;         // e.g. https://prineethr.com/anchor/app/

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(new Request(new URL(f, SCOPE).href, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('makesense-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Only our own files: not Firebase, not Google, not another page on this domain, not Firebase's sign-in helper (/__/auth/…).
  if (e.request.method !== 'GET' || !url.href.startsWith(SCOPE) || url.pathname.includes('/__/')) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = e.request.mode === 'navigate' ? SCOPE : e.request.url.split('#')[0];
    const hit = await cache.match(key, { ignoreSearch: true });
    const fresh = fetch(e.request).then(r => { if (r.ok) cache.put(key, r.clone()); return r; });
    if (hit) { fresh.catch(() => {}); return hit; }                   // open from the device, refresh behind it
    return fresh.catch(() => new Response('Offline, and this file has not been kept on this device yet.', { status: 503 }));
  })());
});
