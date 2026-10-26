// The browser's Gemini reader, end to end with a pretend Google: settings, the request, fallbacks between models, every kind of failure,
// a sideways photo, and what it cost. Prints one JSON object of what happened; tests/test_cloud_reader.py checks it.
import { configure, PRESETS, ReaderError, checkKey, costUsd, forgetKey, hasKey, readPhoto, rupees, saveSettings, settings, turnPixels } from '../../sense/cloud/web/reader.js';

const fx = JSON.parse(await (await import('node:fs/promises')).readFile(process.argv[2], 'utf8'));
configure(fx.reader);
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };

const calls = [];
let script = [];   // what the pretend Google answers, in order: {status, body} or {throw: 'offline'|'abort'}
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), headers: init.headers, model: String(url).match(/models\/([^:]+):/)?.[1], body: init.body ? JSON.parse(init.body) : null });
  const step = script.shift() ?? { status: 200, body: fx.good };
  if (step.throw === 'offline') throw new TypeError('Failed to fetch');
  if (step.throw === 'abort') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
  return { ok: step.status < 400, status: step.status, json: async () => step.body };
};
const out = {};
const run = async (name, steps, w = 2000, h = 1000) => {
  script = steps; calls.length = 0;
  try { out[name] = { ok: await readPhoto(new Uint8Array([255, 216, 255, 0, 1, 2]), w, h, { hints: 'About this writer:\n- test', pageId: 'p1' }), calls: calls.map(c => c.model) }; }
  catch (e) { out[name] = { error: e.message, kind: e instanceof ReaderError ? e.kind : 'other', calls: calls.map(c => c.model) }; }
};

// no key
await run('nokey', []);
out.hasKeyBefore = hasKey();
saveSettings({ key: '  AIza-test-key  ', preset: 'better' });
out.settings = settings(); out.hasKeyAfter = hasKey();
saveSettings({ key: 'k', preset: 'nonsense' }); out.badPreset = settings().preset;
saveSettings({ key: 'k', preset: 'better' });

await run('good', []);
out.request = calls.length ? null : null;
script = []; calls.length = 0; await readPhoto(new Uint8Array([1, 2, 3]), 100, 100, { hints: 'H', pageId: 'p' });
out.sent = { url: calls[0].url, key: calls[0].headers['x-goog-api-key'], thinking: calls[0].body.generationConfig.thinkingConfig, temp: calls[0].body.generationConfig.temperature,
  endsWithHints: calls[0].body.contents[0].parts[1].text.endsWith('\nH'), image: calls[0].body.contents[0].parts[0].inline_data.mime_type };

await run('model_not_allowed_then_next', [{ status: 404, body: { error: { message: 'not found' } } }]);
await run('every_model_missing', PRESETS.better.models.map(() => ({ status: 404, body: {} })));
await run('bad_key', [{ status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } }]);
await run('forbidden', [{ status: 403, body: { error: { message: 'referer blocked' } } }]);
await run('quota', [{ status: 429, body: { error: { message: 'quota' } } }]);
await run('offline', [{ throw: 'offline' }]);
await run('too_slow', [{ throw: 'abort' }]);
await run('not_json', [{ status: 200, body: { candidates: [{ content: { parts: [{ text: 'sorry, I cannot' }] } }] } }]);
globalThis.__sleep = true;
await run('busy_then_ok', [{ status: 503, body: {} }, { status: 200, body: fx.good }]);
await run('sideways', [{ status: 200, body: fx.sideways }], 2000, 1000);
await run('upside_down', [{ status: 200, body: fx.upsideDown }], 2000, 1000);
await run('odd_boxes', [{ status: 200, body: fx.odd }], 1000, 1000);

saveSettings({ key: 'k', preset: 'cheaper' });
await run('cheaper', []);
out.cheaperThinking = null;
script = []; calls.length = 0; await readPhoto(new Uint8Array([1]), 10, 10); out.cheaperRequest = { model: calls[0].model, thinking: calls[0].body.generationConfig.thinkingConfig ?? null };

// the check, and forgetting
script = [{ status: 200, body: { models: [] } }]; out.checkOk = await checkKey(' k ');
script = [{ status: 400, body: { error: { message: 'API key not valid' } } }]; out.checkBad = await checkKey('nope');
script = [{ throw: 'offline' }]; out.checkOffline = await checkKey('k');
forgetKey(); out.afterForget = hasKey();

// money
out.cost = { known: costUsd('gemini-3.6-flash', { promptTokenCount: 1536, candidatesTokenCount: 2343, thoughtsTokenCount: 0 }),
  thinkingIsOutput: costUsd('gemini-3.6-flash', { promptTokenCount: 0, candidatesTokenCount: 1000, thoughtsTokenCount: 1000 }), unknown: costUsd('gemini-nobody', { promptTokenCount: 1e6 }), none: costUsd('x', null) };
out.rupees = [rupees(0.0099), rupees(0.2), rupees(0.00001), rupees(null)];

// the Rotate button on a page already read
const p = { page_size: [200, 100], elements: [{ id: 'a', type: 'text', text: 'x', bbox: [10, 20, 30, 5] }], links: [] };
out.turnOnce = turnPixels(structuredClone(p), 1);
out.turnFour = turnPixels(structuredClone(p), 4);
console.log(JSON.stringify(out));
