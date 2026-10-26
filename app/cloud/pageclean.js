// Keep only the fields the page format knows, and refuse a page that does not validate.
// A port of clean_page in sense/app.py with harness/schema.py's validate (gold=False).
import { pyRepr, strip } from './pyish.js';

const MAX_ELEMENTS = 500;
const TYPES = new Set(['text', 'shape', 'doodle']), KINDS = new Set(['flow', 'hook', 'connector']);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const flt = v => { const f = Number(v); if (!Number.isFinite(f) && typeof v !== 'number') throw new Error(`could not convert ${JSON.stringify(v)} to a number`); return f; };

export function cleanPage(raw, pageId) {
  if (!isObj(raw) || !Array.isArray(raw.elements)) throw new Error('That page is missing its list of elements.');
  if (raw.elements.length > MAX_ELEMENTS || (raw.links || []).length > MAX_ELEMENTS) throw new Error('That page has too many elements to keep.');
  const ids = raw.elements.map(e => { if (!isObj(e)) throw new Error("That request didn't look right (TypeError)."); return e.id; });
  if (new Set(ids).size !== ids.length || !ids.every(i => typeof i === 'string' && i)) throw new Error('Every element needs its own id.');
  const idSet = new Set(ids);
  const elements = raw.elements.map(e => {
    if (e.type === undefined || !Array.isArray(e.bbox)) throw new Error("That request didn't look right (KeyError).");
    const out = { id: e.id, type: e.type, bbox: e.bbox.map(flt) };
    if (e.type === 'text') Object.assign(out, { text: strip(String(e.text ?? '')), underline: !!e.underline, caps: !!e.caps });
    if (e.type === 'shape') out.contains = (e.contains || []).filter(c => idSet.has(c) && c !== e.id);
    return out;
  });
  const links = (raw.links || []).map((l, i) => {
    if (!isObj(l) || l.kind === undefined) throw new Error("That request didn't look right (KeyError).");
    const out = { id: String(l.id || `l${i + 1}`), kind: l.kind, from: l.from, to: l.to };
    const label = strip(String(l.label || ''));
    if (label) Object.assign(out, { label, caps: !!l.caps, underline: !!l.underline });
    return out;
  });
  const page = { page_id: pageId, page_size: raw.page_size.map(flt), elements, links };
  const errs = validate(page);
  if (errs.length) throw new Error(errs.slice(0, 5).join('; '));
  return page;
}

const candidates = v => {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.map(c => c.id);
  throw new Error(`bad link endpoint: ${JSON.stringify(v)}`);
};

function validate(page) {
  const [pw, ph] = page.page_size, errs = [];
  const ids = new Set(page.elements.map(e => e.id));
  for (const e of page.elements) {
    if (!TYPES.has(e.type)) errs.push(`${e.id}: unknown type ${pyRepr(String(e.type))}`);
    const [x, y, w, h] = [e.bbox[0] / pw, e.bbox[1] / ph, e.bbox[2] / pw, e.bbox[3] / ph];
    if (w <= 0 || h <= 0 || x < -0.01 || y < -0.01 || x + w > 1.01 || y + h > 1.01) errs.push(`${e.id}: bbox outside page or empty`);
    if (e.type === 'text' && !strip(e.text)) errs.push(`${e.id}: text element with no text`);
    for (const c of e.contains || []) if (!ids.has(c)) errs.push(`${e.id}: contains unknown id ${pyRepr(c)}`);
  }
  for (const l of page.links) {
    if (!KINDS.has(l.kind)) errs.push(`${l.id}: unknown kind ${pyRepr(String(l.kind))}`);
    for (const end of [candidates(l.from), candidates(l.to)]) for (const c of end) if (!ids.has(c)) errs.push(`${l.id}: endpoint ${pyRepr(String(c))} not an element`);
    if ((l.caps || l.underline) && !l.label) errs.push(`${l.id}: caps/underline set on a link with no label`);
  }
  return errs;
}
