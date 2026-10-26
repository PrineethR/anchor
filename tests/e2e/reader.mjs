// Adding a photo with a Gemini key on the device, in a real browser, against a pretend Google (nothing leaves your machine).
//
//   (same setup as pwa.mjs: emulators, an emulator build served in a folder, Playwright installed)
//   GEMINI_ANSWER=/tmp/gemini-answer.json SITE_DIR=/tmp/site/anchor/app node reader.mjs [chromium|webkit]
//
// GEMINI_ANSWER is what the pretend Gemini says: a JSON file {"answer": <Gemini's answer for the sample page>, "arrows": <how many it holds>}.
// Make it with:  .venv/bin/python -c "import json;from baselines import gemini;g=json.load(open('data/labeled/page-01.json'));a=gemini.from_page(g);print(json.dumps({'answer':a,'arrows':len(a['links'])}))" > /tmp/gemini-answer.json
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const engine = process.argv[2] || 'chromium';
const SITE = process.env.SITE || 'http://127.0.0.1:8123/anchor/app/';
const { answer, arrows } = JSON.parse(readFileSync(process.env.GEMINI_ANSWER, 'utf8'));
const FS = 'http://127.0.0.1:8080/v1/projects/demo-anchor-notes/databases/(default)/documents';
const EMAIL = `reader-${Date.now()}@example.com`;
const GOOGLE = /generativelanguage\.googleapis\.com/;

let failed = 0;
const ok = (cond, what, extra = '') => { console.log(`${cond ? '  ok ' : '  FAIL'} ${what}${cond ? '' : '  ' + extra}`); if (!cond) failed++; };
const rest = async (path, init = {}) => { const r = await fetch(`${FS}/${path}`, { ...init, headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' } }); return r.status === 404 ? null : r.json(); };
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 120)); } };
const field = (doc, k) => { const f = doc?.fields?.[k]; return f && (f.stringValue ?? f.integerValue ?? f.doubleValue ?? f.booleanValue ?? null); };

await rest(`allowed/${EMAIL}`, { method: 'PATCH', body: JSON.stringify({ fields: { ok: { booleanValue: true } } }) });
const browser = await { chromium, webkit }[engine].launch();
const context = await browser.newContext({ viewport: { width: 420, height: 860 }, serviceWorkers: 'block' });   // pwa.mjs covers the worker; Playwright cannot intercept requests of a page a worker controls
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

// the pretend Google
const seen = [];
let mode = 'ok';          // ok | quota | sideways
await context.route(GOOGLE, async route => {
  const req = route.request(), url = req.url();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-goog-api-key' } });   // spelled out, as Google does: Safari ignores a wildcard here
  const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  if (/\/models\?/.test(url)) return route.fulfill({ status: req.headers()['x-goog-api-key'] === 'good-key' ? 200 : 400, headers: cors, body: JSON.stringify(req.headers()['x-goog-api-key'] === 'good-key' ? { models: [] } : { error: { message: 'API key not valid. Please pass a valid API key.' } }) });
  const body = JSON.parse(req.postData());
  seen.push({ url, key: req.headers()['x-goog-api-key'], prompt: body.contents[0].parts[1].text, hasImage: !!body.contents[0].parts[0].inline_data.data });
  if (mode === 'quota') return route.fulfill({ status: 429, headers: cors, body: JSON.stringify({ error: { message: 'quota' } }) });
  const a = mode === 'sideways' ? { ...answer, page_rotation: '90' } : answer;
  return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(a) }] } }], usageMetadata: { promptTokenCount: 1536, candidatesTokenCount: 2343, thoughtsTokenCount: 0 } }) });
});

console.log(`\n${engine}, with a pretend Gemini`);
await page.goto(SITE);
await page.waitForSelector('#gate #gIn');
const uid = await page.evaluate(async email => { const r = await window.__signInAs(email); await window.MS_BOOT; return r.user.uid; }, EMAIL);
await page.waitForSelector('.page-h');

// ---- 1. the key ------------------------------------------------------------------------------------------------------------------
await page.evaluate(() => { location.hash = '#/profile'; });
await page.waitForSelector('.prof-reader');
ok(/read by your Mac/i.test(await page.locator('.prof-reader .lead').innerText()), 'with no key, the page says the Mac reads');
await page.fill('#gkey', 'wrong-key'); await page.click('#gSave');
await page.waitForSelector('.nw-toast:has-text("doesn")', { timeout: 8000 }).catch(() => {});
ok(await page.evaluate(() => !JSON.parse(localStorage.getItem('makesense.gemini') || '{}').key), 'a key Google refuses is not kept');
await page.fill('#gkey', 'good-key'); await page.click('#gSave');
await until(async () => page.evaluate(() => !!JSON.parse(localStorage.getItem('makesense.gemini') || '{}').key));
ok(await page.evaluate(() => JSON.parse(localStorage.getItem('makesense.gemini')).key === 'good-key'), 'a good key is kept on this device');
await page.waitForSelector('.prof-reader:has-text("read by Gemini")');
ok(true, 'and the page now says this device reads');
const inFirestore = await rest(`users/${uid}`);
ok(!JSON.stringify(await rest(`users/${uid}/pages`) ?? {}).includes('good-key') && !JSON.stringify(inFirestore ?? {}).includes('good-key'), 'the key is nowhere in the database');

// ---- 2. a photo, read here ------------------------------------------------------------------------------------------------------
const add = () => page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1200, 800); g.fillStyle = '#111'; g.font = '48px serif'; g.fillText('a page', 100, 400);
  const note = await MS_BACKEND.api('/notes', { method: 'POST', body: await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8)) });
  return { id: note.id, status: note.status };
});
const first = await add();
ok(first.status === 'reading', 'adding a photo starts reading it on this device, not waiting for the Mac', first.status);
const ready = await until(async () => { const d = await rest(`users/${uid}/pages/${first.id}`); return field(d, 'status') === 'ready' && d; });
ok(!!ready, 'the page comes back read');
ok(field(ready, 'source') === 'gemini' && Number(field(ready, 'readUsd')) > 0, 'marked as read by Gemini, with what it cost', JSON.stringify([field(ready, 'source'), field(ready, 'readUsd')]));
const body = JSON.parse(ready.fields.pageJson.stringValue);
ok(body.links.length === arrows, `with its ${arrows} arrows`, `got ${body.links.length}`);
ok(seen.at(-1).key === 'good-key' && seen.at(-1).url.includes('gemini-3.6-flash') && seen.at(-1).hasImage && /handwritten concept map/.test(seen.at(-1).prompt), 'asked Google the right thing, with the key in a header');
await page.evaluate(id => { location.hash = '#/note/' + id; }, first.id);
await page.waitForSelector('#metaLine');
const meta = await page.locator('#metaLine').innerText();
ok(/Gemini/i.test(meta) && /₹/.test(meta), 'the page says who read it and about what it cost', meta);
ok((await page.locator('#senseCol .thread').count()) > 0, 'and the threads are there, which Apple Vision never gave');
ok((await page.locator('#cropBtn').count()) === 0 && (await page.locator('#againBtn').count()) === 1, 'the tools offer Read again, not the Mac\'s page edges');

// ---- 3. when Google says no ---------------------------------------------------------------------------------------------------------
mode = 'quota';
const second = await add();
await until(async () => field(await rest(`users/${uid}/pages/${second.id}`), 'status') === 'failed');
await page.evaluate(id => { location.hash = '#/note/' + id; }, second.id);
await page.waitForSelector('#again');
ok(/billing/i.test(await page.locator('.notice').innerText()), 'a refused read says why and what to do');
ok((await page.locator('#toMac').count()) === 1, 'and offers the Mac instead');
mode = 'ok';
await page.click('#again');
ok(!!(await until(async () => field(await rest(`users/${uid}/pages/${second.id}`), 'status') === 'ready')), 'Try again reads it');

// ---- 4. a sideways photo ---------------------------------------------------------------------------------------------------------------
mode = 'sideways';
const third = await add();
const turned = await until(async () => { const d = await rest(`users/${uid}/pages/${third.id}`); return field(d, 'status') === 'ready' && d; });
const f3 = await rest(`users/${uid}/pages/${third.id}/files/flat`); if (process.env.DEBUG) { const dd = await rest(`users/${uid}/pages/${third.id}`); console.log('DEBUG third:', field(dd,'status'), field(dd,'error'), field(dd,'source'), field(dd,'turns')); }
ok(field(turned, 'turns') == 1 && field(f3, 'w') == 800 && field(f3, 'h') == 1200, 'Gemini says it is sideways: the stored photo is turned to match', JSON.stringify([field(turned, 'turns'), field(f3, 'w'), field(f3, 'h')]));
mode = 'ok';
const rot = await page.evaluate(async id => { const n = await MS_BACKEND.api(`/notes/${id}/reread`, { method: 'POST', body: JSON.stringify({ rotate: true }) }); return { status: n.status, size: n.page.page_size }; }, third.id);
const f3b = await until(async () => { const f = await rest(`users/${uid}/pages/${third.id}/files/flat`); return field(f, 'w') == 1200 && f; });
ok(rot.status === 'ready' && !!f3b, 'Rotate turns a read page again without asking Google', JSON.stringify(rot));
const callsBefore = seen.length;
await page.evaluate(async id => MS_BACKEND.api(`/notes/${id}/reread`, { method: 'POST', body: JSON.stringify({ rotate: true }) }), third.id);
ok(seen.length === callsBefore, 'it cost nothing');

// ---- 5. offline, then back: this device picks it up ---------------------------------------------------------------------------------------
await context.setOffline(true);
const fourth = await add();
ok(fourth.status === 'queued', 'with no connection the photo waits instead of failing', fourth.status);
await context.setOffline(false);
const old = new Date(Date.now() - 10 * 60_000).toISOString().slice(0, 19);
await until(async () => field(await rest(`users/${uid}/pages/${fourth.id}`), 'status') === 'queued');
await rest(`users/${uid}/pages/${fourth.id}?updateMask.fieldPaths=created`, { method: 'PATCH', body: JSON.stringify({ fields: { created: { stringValue: old } } }) });
await new Promise(r => setTimeout(r, 1500));
await page.evaluate(() => MS_BACKEND.reader.resume());
ok(!!(await until(async () => field(await rest(`users/${uid}/pages/${fourth.id}`), 'status') === 'ready', 20000)), 'a page the Mac never picked up is read here once it has waited a few minutes');

// ---- 6. no key: back to the Mac's queue ------------------------------------------------------------------------------------------------------
await page.evaluate(() => localStorage.removeItem('makesense.gemini'));
const fifth = await add();
ok(fifth.status === 'queued', 'with the key removed, photos wait for the Mac again', fifth.status);

ok(errors.filter(e => !/WebSocket|Failed to fetch|network|access control checks/i.test(e)).length === 0, 'no script errors', errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
