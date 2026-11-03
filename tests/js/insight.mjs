// "Make sense of this page" in node, against a pretend Google: the outline Gemini reads, the request, what is kept of its answer, and the screen's view of it.
import { configure, PRESETS, saveSettings } from '../../sense/cloud/web/reader.js';
import { INSTRUCTIONS, SCHEMA, buildRequest, cleanInsight, inputKey, makeSenseOf, outline, view } from '../../sense/cloud/web/insight.js';

const fx = JSON.parse(await (await import('node:fs/promises')).readFile(process.argv[2], 'utf8'));
configure({ prompt: 'x', schema: {}, prices: fx.prices, grid: 1000 });
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const calls = []; let script = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
  const step = script.shift() ?? { status: 200, body: fx.answer };
  if (step.throw) throw new TypeError('Failed to fetch');
  return { ok: step.status < 400, status: step.status, json: async () => step.body };
};
const out = {};
const sense = fx.sense;
const o = outline(sense);
out.outline = o.text; out.known = [...o.known.entries()]; out.empty = o.empty; out.emptyPage = outline({ threads: [], loose: [] }).empty;
out.keySame = inputKey(o.text) === inputKey(outline(structuredClone(sense)).text);
const edited = structuredClone(sense); edited.threads[0].roots[0].text = 'Something else';
out.keyChanges = inputKey(o.text) !== inputKey(outline(edited).text);

const known = new Map([['a', ['a', 'x']], ['b', ['b']], ['c', ['c']]]);
const written = new Set(['call the printer', 'ask']);
out.clean = cleanInsight({
  summary: '  A page about things.  ',
  how_it_fits: [{ text: 'a leads to b', cites: ['a', 'b', 'ghost', 'a'] }, { text: 'invented', cites: ['ghost'] }, { text: 'no cites', cites: [] }, { text: '', cites: ['a'] }, { text: 'x'.repeat(400), cites: ['c'] }],
  open_questions: 'not a list',
  suggested_next_steps: [{ text: 'Call the printer', cites: ['a'] }, { text: 'Please call the printer about the proof', cites: ['a'] }, { text: 'ask', cites: ['b'] }, { text: 'Ask Sam about it', cites: ['b'] }, ...Array.from({ length: 8 }, (_, i) => ({ text: `step ${i}`, cites: ['c'] }))],
}, known, written);
try { cleanInsight({ summary: '   ' }, known); out.noSummary = 'no error'; } catch (e) { out.noSummary = e.message; }
out.cleanTolerant = cleanInsight({ summary: 's', how_it_fits: null, open_questions: [null, 5, {}], suggested_next_steps: undefined }, known);

const better = buildRequest(o.text, 'About this writer:\n- x', PRESETS.better), cheaper = buildRequest(o.text, '', PRESETS.cheaper);
out.request = { parts: better.contents[0].parts.map(p => Object.keys(p)), text: better.contents[0].parts[0].text, thinking: better.generationConfig.thinkingConfig, cheaperThinking: cheaper.generationConfig.thinkingConfig ?? null,
  temp: better.generationConfig.temperature, mime: better.generationConfig.responseMimeType, schemaKeys: Object.keys(SCHEMA.properties), instructionsHaveRules: /Use only what is on the page/.test(INSTRUCTIONS), noHintsLine: /About this writer/.test(cheaper.contents[0].parts[0].text) };

// the whole thing against a pretend Google
const run = async (name, steps) => { script = steps; calls.length = 0; try { out[name] = { ok: await makeSenseOf(sense, 'HINTS'), calls: calls.length }; } catch (e) { out[name] = { error: e.message, kind: e.kind, calls: calls.length }; } };
await run('nokey', []);
saveSettings({ key: 'k', preset: 'better' });
await run('good', []);
out.goodBody = calls[0].body.contents[0].parts[0].text.slice(-60);
out.goodUrl = calls[0].url;
await run('quota', [{ status: 429, body: {} }]);
await run('offline', [{ throw: true }]);
await run('notJson', [{ status: 200, body: { candidates: [{ content: { parts: [{ text: 'no' }] } }] } }]);
await run('uncitedOnly', [{ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ summary: 'Only a summary.', how_it_fits: [{ text: 'made up', cites: ['nope'] }], open_questions: [], suggested_next_steps: [] }) }] } }] } }]);
script = []; calls.length = 0;
try { await makeSenseOf({ threads: [], loose: [], actions: [] }); } catch (e) { out.emptyPageError = { error: e.message, calls: calls.length }; }

// what the screen shows
const stored = out.good.ok.insight;
const v1 = view(stored, sense, out.good.ok.key);
out.view = { fits: v1.fits, written: v1.written, stale: v1.stale };
out.viewStale = view(stored, edited, out.good.ok.key).stale;
console.log(JSON.stringify(out));
