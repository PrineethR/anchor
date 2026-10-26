// Reads a photo of a notebook page with Gemini, from this browser, with a key kept on this device.
// The Mac is not involved: the photo goes from here to Google, and the answer becomes a page. Nothing is sent to Firestore but the result.
//
// geminiToPage and scalePage are line-for-line ports of baselines/gemini.py (to_page) and sense/engine.py (scale_page);
// tests/test_cloud_parity.py holds them to the same answers. The prompt, the answer's shape and the prices come from
// the Python through the build (reader.json), so there is one copy of each.
import { cleanPage } from './pageclean.js';
import { fmt, strip } from './pyish.js';

let cfg = { prompt: '', schema: null, prices: {}, grid: 1000 };
export const configure = c => { cfg = { ...cfg, ...c }; };

export const RUPEES_PER_DOLLAR = 95;   // an assumption, always shown as "about"
export const PRESETS = {
  better: { label: 'Better', models: ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-flash-latest'], thinking: 'low', cost: 'about ₹1 to ₹2 a page' },
  cheaper: { label: 'Cheaper', models: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'], thinking: null, cost: 'about ₹0.6 to ₹1 a page, finds fewer arrows' },
};
const STORE = 'makesense.gemini';
const API = 'https://generativelanguage.googleapis.com/v1beta';

export class ReaderError extends Error {
  /** kind: nokey | key | quota | model | busy | offline | timeout | bad */
  constructor(message, kind) { super(message); this.kind = kind; }
}

// ---- the key, kept on this device only -------------------------------------------------------------------------------------
export function settings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || '{}');
    return { key: typeof s.key === 'string' ? s.key : '', preset: s.preset in PRESETS ? s.preset : 'better' };
  } catch { return { key: '', preset: 'better' }; }
}
export function saveSettings({ key, preset }) {
  try { localStorage.setItem(STORE, JSON.stringify({ key: strip(key || ''), preset: preset in PRESETS ? preset : 'better' })); return true; } catch { return false; }
}
export const forgetKey = () => { try { localStorage.removeItem(STORE); } catch { /* nothing kept */ } };
export const hasKey = () => !!settings().key;

function explain(status, message = '') {
  if (status === 400 && /api key|API_KEY/i.test(message)) return new ReaderError("Google doesn't accept that key. Check it in Settings.", 'key');
  if (status === 401 || status === 403) return new ReaderError("Google won't let this key read from here. Check the key, and that it isn't limited to other sites.", 'key');
  if (status === 404) return new ReaderError('That model is not available to this key.', 'model');
  if (status === 429) return new ReaderError("Google says this key has no free requests left right now, or you went too fast. Try again in a minute, or turn on billing for the key.", 'quota');
  if (status >= 500) return new ReaderError('Google is busy. Try again in a minute.', 'busy');
  return new ReaderError(`Google refused the request (${status}). ${message.slice(0, 120)}`, 'bad');
}

/** Ask Google whether the key works. Reads nothing of yours and costs nothing. */
export async function checkKey(key) {
  try {
    const r = await fetch(`${API}/models?pageSize=1`, { headers: { 'x-goog-api-key': strip(key) } });
    if (r.ok) return { ok: true };
    const body = await r.json().catch(() => ({}));
    return { ok: false, message: explain(r.status, body?.error?.message || '').message };
  } catch { return { ok: false, message: "Couldn't reach Google. Check your connection." }; }
}

// ---- the request -------------------------------------------------------------------------------------------------------------
/** Exactly what baselines/gemini.py sends for one page with no examples, plus how much the model may think. */
export function buildRequest(b64, hints = '', preset = PRESETS.better) {
  const generationConfig = { temperature: 0, responseMimeType: 'application/json', responseSchema: cfg.schema };
  if (preset.thinking) generationConfig.thinkingConfig = { thinkingLevel: preset.thinking };
  const prompt = cfg.prompt + (hints ? '\n' + hints : '');
  return { contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: b64 } }, { text: prompt }] }], generationConfig };
}

const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function send(model, body, key) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 100_000);
    let r;
    try {
      r = await fetch(`${API}/models/${model}:generateContent`, { method: 'POST', signal: ctl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
    } catch (e) {
      throw e.name === 'AbortError' ? new ReaderError('Gemini took too long. Try again.', 'timeout') : new ReaderError("Couldn't reach Google.", 'offline');
    } finally { clearTimeout(timer); }
    if (r.ok) return r.json();
    const detail = (await r.json().catch(() => ({})))?.error?.message || '';
    if (r.status >= 500 && attempt < 2) { await sleep(2000 * (attempt + 1)); continue; }
    throw explain(r.status, detail);
  }
}

// ---- Gemini's answer, as a page (a port of baselines/gemini.py to_page) --------------------------------------------------------
const trunc = v => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : NaN; };
function bbox(box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  const v = box.map(trunc);
  if (v.some(Number.isNaN)) return null;
  const [a, b, c, d] = v.map(x => Math.min(cfg.grid, Math.max(0, x)));
  const [y0, y1] = a <= c ? [a, c] : [c, a], [x0, x1] = b <= d ? [b, d] : [d, b];
  return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
}

/** (page on the 1000-unit grid, notes on what was dropped). Arrow ends are kept as plain ids: the app does not use the runner-up. */
export function geminiToPage(raw, pageId) {
  const notes = [], elements = [], seen = new Set();
  for (const e of raw.elements || []) {
    const box = bbox(e.box_2d);
    let eid = String(e.id || `e${elements.length + 1}`);
    if (box === null) { notes.push(`dropped element ${eid}: bad box_2d`); continue; }
    if (!['text', 'shape', 'doodle'].includes(e.type)) { notes.push(`dropped element ${eid}: unknown type`); continue; }
    if (e.type === 'text' && !strip(String(e.text ?? ''))) { notes.push(`dropped element ${eid}: text with no text`); continue; }
    while (seen.has(eid)) eid += '_';
    seen.add(eid);
    const out = { id: eid, type: e.type, bbox: box };
    if (e.type === 'text') Object.assign(out, { text: strip(String(e.text)), underline: !!e.underline, caps: !!e.caps });
    if (e.type === 'shape') out.contains = [...(e.contains || [])];
    elements.push(out);
  }
  for (const out of elements) if ('contains' in out) out.contains = out.contains.filter(c => seen.has(c) && c !== out.id);

  const links = [];
  (raw.links || []).forEach((l, i) => {
    const lid = String(l.id || `l${i + 1}`);
    if (!seen.has(l.from) || !seen.has(l.to)) { notes.push(`dropped link ${lid}: an end is not an element`); return; }
    const link = { id: lid, kind: l.kind, from: l.from, to: l.to };
    const label = strip(String(l.label || ''));
    if (label) Object.assign(link, { label, caps: !!l.caps, underline: !!l.underline });
    links.push(link);
  });
  return { page: { page_id: pageId, page_size: [cfg.grid, cfg.grid], elements, links }, notes };
}

/** Python's round(x, 1) (halves go to even), which JS's Math.round does not do. */
const round1 = x => Number(fmt(x, 1));

/** Port of sense/engine.py scale_page: from the 1000-unit grid to the pixels of the image that was read. */
export function scalePage(page, w, h) {
  const sx = w / page.page_size[0], sy = h / page.page_size[1];
  for (const e of page.elements) {
    const [x, y, bw, bh] = e.bbox;
    e.bbox = [round1(x * sx), round1(y * sy), round1(bw * sx), round1(bh * sy)];
  }
  page.page_size = [w, h];
  return page;
}

/** Boxes on a square grid when the photo is turned a quarter at a time clockwise: what Gemini said about which way up the page is. */
export function turnGrid(page, degrees) {
  const G = cfg.grid;
  for (const e of page.elements) {
    const [x, y, w, h] = e.bbox;
    if (degrees === 90) e.bbox = [G - (y + h), x, h, w];
    else if (degrees === 180) e.bbox = [G - (x + w), G - (y + h), w, h];
    else if (degrees === 270) e.bbox = [y, G - (x + w), h, w];
  }
  return page;
}

/** The same turn in pixels, for the Rotate button on a page that has already been read: [W, H] becomes [H, W]. */
export function turnPixels(page, quarterTurns = 1) {
  for (let i = 0; i < ((quarterTurns % 4) + 4) % 4; i++) {
    const [W, H] = page.page_size;
    for (const e of page.elements) { const [x, y, w, h] = e.bbox; e.bbox = [round1(H - (y + h)), round1(x), h, w]; }
    page.page_size = [H, W];
  }
  return page;
}

// ---- what it cost -------------------------------------------------------------------------------------------------------------
export function costUsd(model, usage) {
  if (!usage) return null;
  const [pin, pout] = cfg.prices[model] || [1.5, 7.5];   // a model nobody priced here is assumed to cost like the dearest Flash
  return ((usage.promptTokenCount || 0) * pin + ((usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0)) * pout) / 1e6;
}
export function rupees(usd) {
  if (usd === null || usd === undefined) return '';
  const r = usd * RUPEES_PER_DOLLAR;
  return r < 0.1 ? 'under ₹0.1' : `about ₹${r < 10 ? r.toFixed(1) : Math.round(r)}`;
}

// ---- one photo in, one page out -------------------------------------------------------------------------------------------------
/**
 * Read a photo (JPEG bytes, w x h pixels, already upright as the browser holds it).
 * Returns { page, rotation, notes, model, usage, usd }: `page` is in the pixels of the photo as it should be shown
 * (turned if Gemini said it was sideways: then `rotation` says by how much, and the caller turns the stored photo too).
 */
export async function readPhoto(jpeg, w, h, { hints = '', pageId = 'page' } = {}) {
  const s = settings();
  if (!s.key) throw new ReaderError('Add a Gemini key in Settings to read pages here.', 'nokey');
  if (!cfg.prompt || !cfg.schema) throw new ReaderError('The reader is not set up (reader.json is missing).', 'bad');
  const preset = PRESETS[s.preset], body = buildRequest(b64(jpeg), hints, preset);
  let resp, used, last;
  for (const model of preset.models) {
    try { resp = await send(model, body, s.key); used = model; break; }
    catch (e) { if (e.kind !== 'model') throw e; last = e; }   // not available to this key: try the next one
  }
  if (!resp) throw last;
  const text = (resp.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  let raw;
  try { raw = JSON.parse(text); } catch { throw new ReaderError("Gemini's answer wasn't readable. Try again.", 'bad'); }
  const rotation = [90, 180, 270].includes(Number(raw.page_rotation)) ? Number(raw.page_rotation) : 0;
  const { page, notes } = geminiToPage(raw, pageId);
  turnGrid(page, rotation);
  scalePage(page, rotation % 180 ? h : w, rotation % 180 ? w : h);
  let clean;
  try { clean = cleanPage(page, pageId); }
  catch (e) {   // something Gemini boxed that the page format will not hold: keep what it will
    page.elements = page.elements.filter(el => el.bbox[2] > 0 && el.bbox[3] > 0);
    const ids = new Set(page.elements.map(el => el.id));
    page.links = page.links.filter(l => ids.has(l.from) && ids.has(l.to));
    clean = cleanPage(page, pageId);
    notes.push(`some boxes were dropped (${e.message})`);
  }
  const usage = resp.usageMetadata || null;
  return { page: clean, rotation, notes, model: used, usage, usd: costUsd(used, usage) };
}
