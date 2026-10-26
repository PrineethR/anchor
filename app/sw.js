// Keeps the site's own files on this device, so it opens with no connection. Your notes are kept by Firestore itself, not here.
// Build: build.py fills in the version and the file list. A new build means a new cache; the old one is dropped.
// Everything is relative to where this file lives (its scope), so the site works at a domain's root or in a folder of one (prineethr.com/anchor/app/).
//
// Updates: a new version installs beside the running one and WAITS. The page tells you it is ready, and only when you
// accept does it take over (message 'skip-waiting'). Taking over mid-session would swap files out from under a page that
// has already loaded half of the old ones. The very first install has nothing to wait for and starts at once.
const VERSION = 'b4295dbe8756';
const FILES = ["", "cloud/backend.js", "cloud/boot.js", "cloud/layout.js", "cloud/lib/firebase.js", "cloud/meaning.js", "cloud/notebook.js", "cloud/pageclean.js", "cloud/photo.js", "cloud/pwa.js", "cloud/pyish.js", "cloud/reader.js", "cloud/render.js", "config.json", "export-css.json", "icons/apple-touch-icon.png", "icons/favicon-32.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "manifest.webmanifest", "reader.json", "static/ds.js", "static/fonts/Figtree-italic.woff2", "static/fonts/Figtree-normal.woff2", "static/fonts/JetBrainsMono-normal.woff2", "static/fonts/Newsreader-italic.woff2", "static/fonts/Newsreader-normal.woff2", "static/noteworthy.css", "theme.json", "web/canvas.css", "web/canvas.js"];                       // paths from this folder; '' is the page itself
const CACHE = 'makesense-' + VERSION;
const SHARED = 'makesense-shared';             // photos shared to the app, until you say whether to add them (the page reads this name too)
const SCOPE = self.registration.scope;         // e.g. https://prineethr.com/anchor/app/
const SHARE_TARGET = new URL('share-target', SCOPE).href;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(new Request(new URL(f, SCOPE).href, { cache: 'reload' })).catch(() => {})))));
});
self.addEventListener('message', e => { if (e.data === 'skip-waiting') self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('makesense-') && k !== CACHE && k !== SHARED).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

/** "Share to Make sense" from a gallery or camera: keep the photos, then open the page that asks what to do with them. */
async function stageShared(request) {
  try {
    const files = (await request.formData()).getAll('photos').filter(f => typeof f !== 'string' && /^image\//.test(f.type)).slice(0, 6);
    await caches.delete(SHARED);               // whatever an earlier share left behind
    const c = await caches.open(SHARED);
    await Promise.all(files.map((f, i) => c.put(new URL(`shared/${i}`, SCOPE).href, new Response(f, { headers: { 'Content-Type': f.type, 'X-Name': encodeURIComponent(f.name || `photo-${i}`) } }))));
  } catch { /* nothing usable arrived: the page says so */ }
  return Response.redirect(new URL('#/shared', SCOPE).href, 303);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.href === SHARE_TARGET) return e.respondWith(stageShared(e.request));
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
