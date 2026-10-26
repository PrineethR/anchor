// Runs the browser ports on the cases tests/test_cloud_parity.py computed with the Python originals, and says where they differ.
//   node tests/js/parity.mjs fixture.json
import { readFileSync } from 'node:fs';
import { cleanPage } from '../../sense/cloud/web/pageclean.js';
import { layout, renderHtml } from '../../sense/cloud/web/layout.js';
import { makeSense } from '../../sense/cloud/web/meaning.js';
import { blank, cleanItems, cleanLinks, importPage, thumbSvg, toPage } from '../../sense/cloud/web/notebook.js';
import { configure, senseHtml, toHtml, toMarkdown } from '../../sense/cloud/web/render.js';

const fx = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const fresh = (used) => { let c = 0; return prefix => { for (;;) { const cand = prefix + (++c).toString(16).padStart(6, '0'); if (!used.has(cand)) { used.add(cand); return cand; } } }; };

const ops = {
  makeSense: (page, cues, noun) => makeSense(page, cues, noun),
  layout: (page, threadOf, normalize) => layout(page, threadOf, normalize),
  renderHtml: (page, threadOf, normalize) => renderHtml(layout(page, threadOf, normalize)),
  senseHtml: (sense, editable, empty) => senseHtml(sense, editable, empty),
  toMarkdown: note => toMarkdown(note),
  toHtml: (note, photo) => toHtml(note, photo),
  cleanPage: (raw, id) => cleanPage(raw, id),
  cleanItems: raw => cleanItems(raw),
  cleanLinks: (raw, ids) => cleanLinks(raw, new Set(ids)),
  toPage: (nb, withFree) => toPage(nb, withFree),
  thumbSvg: (nb, sense) => thumbSvg(nb, sense),
  importPage: (nb, page, noteId, at) => {
    const used = new Set([...nb.items.map(i => i.id), ...nb.links.map(l => l.id)]);
    const imp = importPage(nb, page, noteId, at, fresh(used));
    const items = cleanItems([...nb.items, ...imp.items]);
    return { items, links: cleanLinks([...nb.links, ...imp.links], new Set(items.map(i => i.id))), asset: imp.asset };
  },
};

const same = (a, b) => {
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return true;
  // Python's math.hypot and JS's can differ in the last bit; nothing drawn depends on a bit that small
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
  return ka.length === kb.length && ka.every(k => k in b && same(a[k], b[k]));
};
const firstDiff = (a, b, path = '') => {
  if (same(a, b)) return null;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${path}/${k}`); if (d) return d; }
  }
  if (typeof a === 'string' && typeof b === 'string') {
    let i = 0; while (i < a.length && a[i] === b[i]) i++;
    return { path, python: a.slice(Math.max(0, i - 40), i + 80), js: b.slice(Math.max(0, i - 40), i + 80) };
  }
  return { path, python: a, js: b };
};

configure(fx.config);
const failures = [];
let ran = 0;
for (const c of fx.cases) {
  ran++;
  let got;
  try { got = { ok: ops[c.op](...c.args) }; } catch (e) { got = { error: e.message }; }
  const want = c.expect;
  if (want.error !== undefined && got.error !== undefined) {
    if (c.exact !== false && want.error !== got.error) failures.push({ case: c.name, op: c.op, diff: { path: 'error', python: want.error, js: got.error } });
    continue;
  }
  const d = firstDiff(want, got);
  if (d) failures.push({ case: c.name, op: c.op, diff: d });
}
console.log(JSON.stringify({ ran, failures: failures.slice(0, 12), failed: failures.length }));
process.exit(failures.length ? 1 : 0);
