// "Make sense of this page" on the website, in a real browser, against a pretend Google (nothing leaves your machine).
//
//   (same setup as reader.mjs: emulators, an emulator build served in a folder, Playwright installed)
//   GEMINI_ANSWER=/tmp/gemini-answer.json node insight.mjs [chromium|webkit]
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const engine = process.argv[2] || 'chromium';
const SITE = process.env.SITE || 'http://127.0.0.1:8123/anchor/app/';
const { answer } = JSON.parse(readFileSync(process.env.GEMINI_ANSWER, 'utf8'));
const FS = 'http://127.0.0.1:8080/v1/projects/demo-anchor-notes/databases/(default)/documents';
const EMAIL = `insight-${Date.now()}@example.com`;

let failed = 0;
const ok = (cond, what, extra = '') => { console.log(`${cond ? '  ok ' : '  FAIL'} ${what}${cond ? '' : '  ' + extra}`); if (!cond) failed++; };
const rest = async (path, init = {}) => { const r = await fetch(`${FS}/${path}`, { ...init, headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' } }); return r.status === 404 ? null : r.json(); };
const until = async (fn, ms = 15000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) return v; await new Promise(r => setTimeout(r, 120)); } };
const field = (doc, k) => { const f = doc?.fields?.[k]; return f && (f.stringValue ?? f.integerValue ?? f.doubleValue ?? f.booleanValue ?? null); };

await rest(`allowed/${EMAIL}`, { method: 'PATCH', body: JSON.stringify({ fields: { ok: { booleanValue: true } } }) });
const browser = await { chromium, webkit }[engine].launch();
const context = await browser.newContext({ viewport: { width: +(process.env.W || 1100), height: +(process.env.H || 900) }, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

// the pretend Google: reads photos like reader.mjs, and answers "make sense" by citing real ids it finds in the outline it is sent
const sent = [];
let summary = 'First pretend summary.', failWith = null;
await context.route(/generativelanguage\.googleapis\.com/, async route => {
  const req = route.request(), cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,x-goog-api-key' } });
  if (/\/models\?/.test(req.url())) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ models: [] }) });
  const body = JSON.parse(req.postData()), parts = body.contents[0].parts;
  if (parts[0].inline_data) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 1536, candidatesTokenCount: 2343 } }) });
  sent.push({ parts: parts.length, hasImage: !!parts[0].inline_data, key: req.headers()['x-goog-api-key'], text: parts[0].text });
  if (failWith) return route.fulfill({ status: failWith, headers: cors, body: JSON.stringify({ error: { message: 'no' } }) });
  const ids = [...parts[0].text.split('THE PAGE')[1].matchAll(/\[([A-Za-z0-9_]+)\]/g)].map(m => m[1]);
  const text = JSON.stringify({ summary, how_it_fits: [{ text: 'Pretend fit one.', cites: [ids[0], ids[1]] }, { text: 'A made-up claim.', cites: ['no-such-id'] }],
    open_questions: [{ text: 'Pretend open question?', cites: [ids[2]] }], suggested_next_steps: [{ text: 'Pretend suggestion.', cites: [ids[3]] }] });
  return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 500, thoughtsTokenCount: 0 } }) });
});

console.log(`\n${engine}, making sense, with a pretend Gemini`);
await page.goto(SITE);
await page.waitForSelector('#gate #gIn');
const uid = await page.evaluate(async email => { const r = await window.__signInAs(email); await window.MS_BOOT; localStorage.setItem('makesense.gemini', JSON.stringify({ key: 'good-key', preset: 'better' })); return r.user.uid; }, EMAIL);
await page.waitForSelector('.page-h');
const id = await page.evaluate(async () => {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 800; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1200, 800);
  return (await MS_BACKEND.api('/notes', { method: 'POST', body: await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8)) })).id;
});
await until(async () => field(await rest(`users/${uid}/pages/${id}`), 'status') === 'ready');
await page.evaluate(i => { location.hash = '#/note/' + i; }, id);
await page.waitForSelector('#senseCol');

// ---- 1. not made yet -----------------------------------------------------------------------------------------------------------
ok(await page.locator('#insightMake').count() === 1, 'a page that has been read offers "Make sense of this page"');
ok((await page.locator('.insight').innerText()).includes('tied to words on your page'), 'and says what it will give');

// ---- 2. made ---------------------------------------------------------------------------------------------------------------------
await page.click('#insightMake');
await page.waitForSelector('.insight-summary', { timeout: 15000 });
ok((await page.locator('.insight-summary').innerText()) === 'First pretend summary.', 'the summary appears');
const text = await page.locator('.insight').innerText();
ok(text.includes('How it fits together') && text.includes('Pretend fit one.'), 'how it fits together');
ok(text.includes('Still open') && text.includes('Pretend open question?'), 'what is still open');
ok(text.includes('Next steps') && /Suggested/.test(text) && text.includes('Pretend suggestion.'), 'next steps, with the suggested ones labelled');
ok(!text.includes('A made-up claim.'), 'a claim that cites nothing on the page is gone');
ok(/₹/.test(text), 'with what it cost', text.slice(-120));
const last = sent.at(-1);
ok(last.parts === 1 && !last.hasImage && last.key === 'good-key' && /\[t?\w+\] /.test(last.text), 'Google was sent the typed outline with ids, not the photo, with the key in a header');
await page.hover('.insight .sugg li, .insight ul li');
const lit = await page.evaluate(() => document.querySelectorAll('#typed .box.hl, #ovl .bx.hl').length);
ok(lit > 0, 'hovering a point lights up the words it comes from on the page', String(lit));
if (process.env.SHOT) { await page.evaluate(() => document.querySelector('.insight').scrollIntoView({ block: 'start' })); await page.waitForTimeout(400); await page.screenshot({ path: process.env.SHOT }); }
const doc = await rest(`users/${uid}/pages/${id}`);
ok(!!field(doc, 'insightJson') && Number(field(doc, 'insightUsd')) > 0 && !JSON.stringify(doc).includes('good-key'), 'it is kept with the page, with its cost, and the key is not in it');

// ---- 3. kept across a reload ---------------------------------------------------------------------------------------------------------
await page.reload();
await page.waitForSelector('.insight-summary');
ok(true, 'still there after a reload');
ok((await page.locator('.insight-note').count()) === 0, 'and not marked out of date');

// ---- 4. the page changes: out of date --------------------------------------------------------------------------------------------------
await page.evaluate(async i => {
  const n = await MS_BACKEND.api('/notes/' + i); const p = JSON.parse(JSON.stringify(n.page)); const t = p.elements.find(e => e.type === 'text'); t.text = 'A changed word';
  await MS_BACKEND.api('/notes/' + i, { method: 'PUT', body: JSON.stringify({ page: p }) });
}, id);
await page.evaluate(() => { location.hash = '#/'; });
await page.evaluate(i => { location.hash = '#/note/' + i; }, id);
await page.waitForSelector('.insight-note');
ok(/changed the page/.test(await page.locator('.insight-note').innerText()), 'once you change a word it says so');
summary = 'Second pretend summary.';
await page.click('#insightAgain');
await page.waitForFunction(() => document.querySelector('.insight-summary')?.textContent === 'Second pretend summary.', null, { timeout: 15000 });
ok((await page.locator('.insight-note').count()) === 0, 'Make sense again brings it up to date');

// ---- 5. when Google says no ---------------------------------------------------------------------------------------------------------------
failWith = 429;
await page.click('#insightAgain');
await page.waitForSelector('.nw-toast:has-text("billing")', { timeout: 10000 }).catch(() => {});
ok((await page.locator('.nw-toast:has-text("billing")').count()) > 0, 'a refusal from Google says why, in the corner');
ok((await page.locator('.insight-summary').innerText()) === 'Second pretend summary.', 'and the last good one is still there');
failWith = null;

// ---- 6. remove, and no key ---------------------------------------------------------------------------------------------------------------------
await page.click('#insightRemove');
await page.waitForSelector('#insightMake');
ok(!field(await rest(`users/${uid}/pages/${id}`), 'insightJson'), 'Remove takes it off the page');
await page.evaluate(() => localStorage.removeItem('makesense.gemini'));
await page.evaluate(() => { location.hash = '#/'; });
await page.evaluate(i => { location.hash = '#/note/' + i; }, id);
await page.waitForSelector('.insight');
ok((await page.locator('#insightMake').count()) === 0 && (await page.locator('.insight a[href="#/profile"]').count()) === 1, 'with no key it points you to where to add one');

ok(errors.filter(e => !/WebSocket|Failed to fetch|network|access control checks/i.test(e)).length === 0, 'no script errors', errors.slice(0, 3).join(' | '));
await browser.close();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
