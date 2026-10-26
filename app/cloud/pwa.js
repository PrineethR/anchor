// The site as an installed app: its service worker and updates, the install prompt, storage that is kept, and photos shared to it.
// Nothing here needs you to be signed in. boot.js loads it first so no browser event is missed.

export const SHARED = 'makesense-shared';   // the cache sw.js keeps shared photos in

export const state = { updateReady: false, canInstall: false, installed: false, persisted: null, worker: false };
let waiting = null, installEvent = null, applying = false;
const announce = () => window.dispatchEvent(new CustomEvent('ms:pwa'));

export const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export function platform() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios' : /Android/.test(ua) ? 'android' : 'desktop';
}
state.installed = standalone();

// Chrome and Edge offer installing through this event; Safari has no equivalent (Share, then Add to Home Screen).
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvent = e; state.canInstall = true; announce(); });
window.addEventListener('appinstalled', () => { installEvent = null; Object.assign(state, { canInstall: false, installed: true }); announce(); });
matchMedia('(display-mode: standalone)').addEventListener?.('change', () => { state.installed = standalone(); announce(); });

export async function install() {
  if (!installEvent) return false;
  installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  installEvent = null; state.canInstall = false; announce();
  return outcome === 'accepted';
}

/** Register sw.js, and say (ms:pwa) when a newer version has been downloaded and is waiting for you to accept it. */
export async function registerWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    state.worker = true;
    const ready = w => { waiting = w; state.updateReady = true; announce(); };
    if (reg.waiting && navigator.serviceWorker.controller) ready(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) ready(w); });   // no controller yet: the first install, nothing to replace
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (applying) location.reload(); });   // only when you asked: the first install also "takes control"
    let checked = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - checked > 3_600_000) { checked = Date.now(); reg.update().catch(() => {}); }   // an installed app can stay open for days
    });
    return reg;
  } catch (e) { console.warn('service worker', e); return null; }
}
export function applyUpdate() { if (waiting) { applying = true; waiting.postMessage('skip-waiting'); } }

/** Ask the browser not to clear what this device keeps for offline use when space runs low. Safari and Chrome decide for themselves; installed apps are usually granted it. */
export async function keepStorage() {
  try { state.persisted = !!(await navigator.storage?.persisted?.()) || !!(await navigator.storage?.persist?.()); } catch { state.persisted = false; }
  announce();
  return state.persisted;
}

/** Photos someone shared to the app from a gallery or camera, waiting for you to say whether to add them. */
export async function sharedPhotos() {
  if (!('caches' in self)) return [];
  const c = await caches.open(SHARED);
  const out = [];
  for (const req of (await c.keys()).sort((a, b) => a.url.localeCompare(b.url))) {
    const res = await c.match(req);
    out.push({ blob: await res.blob(), name: decodeURIComponent(res.headers.get('X-Name') || 'photo') });
  }
  return out;
}
export const clearShared = () => ('caches' in self ? caches.delete(SHARED) : Promise.resolve());
