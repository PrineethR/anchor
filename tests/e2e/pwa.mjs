// The website as an installed app, in a real browser engine: service worker, offline start, unsent changes, updates, sharing a photo.
//
//   npx firebase-tools emulators:start --only auth,firestore --project demo-anchor-notes        (in one terminal)
//   .venv/bin/python -m sense.cloud.build --emulator --out /tmp/site/anchor/app               (the emulator build, in a folder, as on Pages)
//   (cd /tmp/site && python3 -m http.server 8123 --bind 127.0.0.1)                           (serve it)
//   cd tests/e2e && npm install && npx playwright install chromium webkit
//   SITE_DIR=/tmp/site/anchor/app node pwa.mjs [chromium|webkit]
//
// It signs in as a made-up account on the emulator, so it never touches your real project.
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const engine = process.argv[2] || 'chromium';
const SITE = process.env.SITE || 'http://127.0.0.1:8123/anchor/app/';
const SITE_DIR = process.env.SITE_DIR;
const FS = 'http://127.0.0.1:8080/v1/projects/demo-anchor-notes/databases/(default)/documents';
const EMAIL = `e2e-${Date.now()}@example.com`;

let failed = 0;
const ok = (cond, what, extra = '') => { console.log(`${cond ? '  ok ' : '  FAIL'} ${what}${cond ? '' : '  ' + extra}`); if (!cond) failed++; };
const rest = async (path, init = {}) => { const r = await fetch(`${FS}/${path}`, { ...init, headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' } }); return r.status === 404 ? null : r.json(); };
const docs = async path => (await rest(path))?.documents || [];
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 150)); } };

await rest(`allowed/${EMAIL}`, { method: 'PATCH', body: JSON.stringify({ fields: { ok: { booleanValue: true } } }) });

const browser = await { chromium, webkit }[engine].launch();
const context = await browser.newContext({ viewport: { width: 420, height: 860 }, serviceWorkers: 'allow' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
console.log(`\n${engine} at ${SITE}`);

// ---- 1. the service worker, in a folder of a domain ----------------------------------------------------------------------
await page.goto(SITE);
await page.waitForSelector('#gate #gIn');
ok(true, 'the sign-in screen opens');
const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, state: r.active?.state }; });
ok(reg.scope === SITE, 'the service worker covers the site\'s own folder and nothing more', JSON.stringify(reg));
const active = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; for (let i = 0; i < 50 && r.active.state !== 'activated'; i++) await new Promise(x => setTimeout(x, 100)); return r.active.state; });
ok(active === 'activated', 'it is active', active);
const keep = await page.evaluate(async () => (await (await caches.open((await caches.keys()).find(k => k.startsWith('makesense-v') || /^makesense-[0-9a-f]{12}$/.test(k)))).keys()).map(r => new URL(r.url).pathname));
ok(keep.includes(new URL(SITE).pathname) && keep.some(k => k.endsWith('/cloud/backend.js')) && keep.some(k => k.endsWith('/static/ds.js')), 'the app\'s files are kept on the device', JSON.stringify(keep.slice(0, 4)));

// ---- 2. sign in, add things ----------------------------------------------------------------------------------------------
const uid = await page.evaluate(async email => { const r = await window.__signInAs(email); await window.MS_BOOT; return r.user.uid; }, EMAIL);
await page.waitForSelector('.page-h');
ok(!!uid, 'signed in as a made-up account on the emulator');
const made = await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 900; c.height = 700;
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 700); g.fillStyle = '#111'; g.font = '56px serif'; g.fillText('hello offline', 120, 340);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  const note = await MS_BACKEND.api('/notes', { method: 'POST', body: blob });
  const nb = await MS_BACKEND.api('/notebooks', { method: 'POST', body: JSON.stringify({ title: 'Kept offline' }) });
  return { note: note.id, nb: nb.id, rev: nb.rev, pages: (await MS_BACKEND.api('/notes')).length };
});
ok(made.pages === 1, 'a photo was shrunk and queued', JSON.stringify(made));
ok(!!(await until(async () => (await docs(`users/${uid}/pages`)).length === 1)), 'it reached the server');
await page.reload();
await page.waitForSelector('.page-row');
ok(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the page is controlled by the service worker after a reload');

// ---- 3. offline: open the app, read, write -----------------------------------------------------------------------------------
await context.setOffline(true);
await page.reload();
await page.waitForSelector('.page-row', { timeout: 20000 }).catch(() => {});
const offlineRows = await page.locator('.page-row').count();
ok(offlineRows === 1, 'with no connection the app still opens and shows the page that was added', `rows=${offlineRows}, body=${(await page.locator('body').innerText()).slice(0, 120).replace(/\n/g, ' | ')}`);
const pill = await until(async () => (await page.locator('.netpill:not([hidden])').count()) && (await page.locator('.netpill').innerText()), 8000);
ok(/Offline/.test(pill || ''), 'it says it is offline', pill);
const offlineNb = await page.evaluate(async id => (await MS_BACKEND.api('/notebooks/' + id)).title, made.nb);
ok(offlineNb === 'Kept offline', 'a notebook opens from this device', offlineNb);
await page.evaluate(async ({ id }) => {
  const nb = await MS_BACKEND.api('/notebooks/' + id);
  await MS_BACKEND.api('/notebooks/' + id, { method: 'PUT', body: JSON.stringify({ rev: nb.rev, items: [{ id: 'n1', type: 'text', x: 10, y: 10, w: 0, h: 0, text: 'written on the train', underline: false, caps: false }], links: [] }) });
}, { id: made.nb });
ok(true, 'and can be written in');
await context.setOffline(false);
const sent = await until(async () => { const b = await rest(`users/${uid}/notebooks/${made.nb}/parts/body`); return b && JSON.parse(b.fields.itemsJson.stringValue).some(i => i.text === 'written on the train'); }, 20000);
ok(sent, 'back online, what was written offline reaches the server');
const gone = await until(async () => (await page.locator('.netpill:not([hidden])').count()) === 0, 10000);
ok(gone, 'and the offline notice goes away');

// ---- 4. an update waits to be accepted ----------------------------------------------------------------------------------------
if (SITE_DIR) {
  const file = `${SITE_DIR}/sw.js`;
  const before = readFileSync(file, 'utf8');
  const was = await page.evaluate(async () => (await caches.keys()).filter(k => /^makesense-[0-9a-f]{12}$/.test(k)));
  writeFileSync(file, before.replace(/const VERSION = '[0-9a-f]+'/, "const VERSION = 'aaaaaaaaaaaa'"));
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
  const toast = await page.waitForSelector('#updateToast', { timeout: 15000 }).catch(() => null);
  ok(!!toast, 'a new version is announced, not forced on you');
  const during = await page.evaluate(async () => (await caches.keys()).filter(k => k.startsWith('makesense-')).sort());
  ok(during.length === 2 && was.every(k => during.includes(k)), 'the version you are using is still kept until you accept', JSON.stringify(during));
  await page.click('#updateToast [data-now]');
  await page.waitForFunction(() => !document.querySelector('#updateToast'), null, { timeout: 15000 }).catch(() => {});
  const after = await until(async () => { const k = await page.evaluate(async () => (await caches.keys()).filter(k => k.startsWith('makesense-') && k !== 'makesense-shared')); return k.length === 1 && k[0] === 'makesense-aaaaaaaaaaaa' && k; }, 15000);
  ok(!!after, 'accepting swaps to the new version and drops the old one', JSON.stringify(after));
  writeFileSync(file, before);
  await page.waitForSelector('.page-row', { timeout: 15000 }).catch(() => {});
}

// ---- 5. a photo shared to the app ------------------------------------------------------------------------------------------------
const shared = await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 600; c.height = 400; c.getContext('2d').fillRect(0, 0, 600, 400);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const form = new FormData();
  form.append('photos', new File([blob], 'shared.png', { type: 'image/png' }));
  form.append('photos', new File(['<script>alert(1)</script>'], 'x.html', { type: 'text/html' }));
  const res = await fetch('share-target', { method: 'POST', body: form });
  return { status: res.status };
});
await page.evaluate(() => { location.hash = '#/shared'; });
const sharedImgs = await until(async () => page.locator('.shared img').count(), 8000);
ok(sharedImgs === 1, 'a photo shared to the app waits for your yes (and the html file was refused)', `imgs=${sharedImgs} ${JSON.stringify(shared)}`);
const before = (await docs(`users/${uid}/pages`)).length;
ok(before === 1, 'nothing was added behind your back', String(before));
await page.click('#addShared');
const added = await until(async () => (await docs(`users/${uid}/pages`)).length === 2, 15000);
ok(added, 'saying yes adds it to your pages');
ok(await page.evaluate(async () => !(await caches.has('makesense-shared'))), 'and the kept copy is cleared');

// ---- 6. installable (Chromium reports why not) -----------------------------------------------------------------------------------
if (engine === 'chromium') {
  const cdp = await context.newCDPSession(page);
  await page.goto(SITE);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  ok(installabilityErrors.length === 0, 'Chrome finds nothing in the way of installing it', JSON.stringify(installabilityErrors));
  const m = await cdp.send('Page.getAppManifest');
  ok(!m.errors?.length, 'and nothing wrong with the manifest', JSON.stringify(m.errors));
}
ok(errors.filter(e => !/WebSocket|Failed to fetch|offline|network|access control checks/i.test(e)).length === 0, 'no script errors along the way', errors.slice(0, 3).join(' | '));

await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
