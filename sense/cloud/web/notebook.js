// Notebooks: the pure parts of sense/notebooks.py (cleaning what the canvas sends, the canvas as a page, its thumbnail,
// and putting a photographed page onto it). The storage and the HTTP are not here: the cloud backend does those.
import { fmt, num, strip } from './pyish.js';

export const COLORS = ['sky', 'blush', 'mint', 'violet', 'tangerine', 'berry'];
export const ITEM_COLORS = new Set(['sky', 'blush', 'mint', 'violet', 'tangerine', 'berry', 'sun']);
const TEXT_SIZES = new Set(['body', 'heading', 'title']);
const SHAPE_KINDS = new Set(['blob', 'box', 'circle']);
const SHAPE_FILLS = new Set(['hatch', 'tint', 'outline']);
const SHAPE_STROKES = new Set(['dashed', 'solid', 'dotted']);
const LINK_HEADS = new Set(['forward', 'both', 'none']);
const LINK_STROKES = new Set(['solid', 'dashed', 'dotted']);
const KINDS = new Set(['flow', 'hook', 'connector']);
const MAX_ITEMS = 3000, MAX_TEXT = 5000, BOUND = 1_000_000;
const TEXT_W = 320, IMPORT_W = 640, TYPED_SCALE = 1.5, GAP = 100, PAD = 40;
const ITEM_ID = /^[A-Za-z0-9_-]{1,40}$/, ASSET = /^[A-Za-z0-9._-]{1,80}$/;
const n = (v, lo = -BOUND, hi = BOUND, d = 0.0) => num(v, lo, hi, d);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

export class Conflict extends Error {}

export function cleanItems(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) throw new Error('That notebook has too many things on it to keep.');
  const out = [], seen = new Set();
  for (const i of raw) {
    if (!isObj(i) || !['text', 'shape', 'image'].includes(i.type)) throw new Error("Something on the canvas isn't text, a shape or a photo.");
    const iid = String(i.id ?? '');
    if (!ITEM_ID.test(iid) || seen.has(iid)) throw new Error('Every item on the canvas needs its own id.');
    seen.add(iid);
    const item = { id: iid, type: i.type, x: n(i.x), y: n(i.y), w: n(i.w, 0, BOUND), h: n(i.h, 0, BOUND) };
    if (i.type === 'text') {
      item.text = Array.from(String(i.text ?? '')).slice(0, MAX_TEXT).join('');
      Object.assign(item, { underline: !!i.underline, caps: !!i.caps, fixed: !!i.fixed });
      if (TEXT_SIZES.has(i.size)) item.size = i.size;
      if (ITEM_COLORS.has(i.color)) item.color = i.color;
      if (['left', 'center'].includes(i.align)) item.align = i.align;
    }
    if (i.type === 'shape') {
      if (SHAPE_KINDS.has(i.shape)) item.shape = i.shape;
      if (SHAPE_FILLS.has(i.fill)) item.fill = i.fill;
      if (SHAPE_STROKES.has(i.stroke)) item.stroke = i.stroke;
      if (ITEM_COLORS.has(i.color)) item.color = i.color;
    }
    if (i.type === 'image') {
      const src = String(i.src ?? '');
      if (!ASSET.test(src)) throw new Error("A photo on the canvas points at a file that isn't allowed.");
      item.src = src;
      if ([0, 1, 2, 3, '0', '1', '2', '3'].includes(i.rot)) item.rot = ((parseInt(i.rot, 10) % 4) + 4) % 4;
      if (['back', 'front'].includes(i.z_order)) item.z_order = i.z_order;
    }
    out.push(item);
  }
  return out;
}

function endOf(v, ids) {
  if (isObj(v) && 'x' in v && 'y' in v) return { x: n(v.x), y: n(v.y) };
  if (typeof v === 'string' && ids.has(v)) return v;
  return null;   // the item it pointed at is gone
}
const sameEnd = (a, b) => (typeof a === 'string' ? a === b : typeof b !== 'string' && a.x === b.x && a.y === b.y);

export function cleanLinks(raw, ids) {
  if (!Array.isArray(raw) || raw.length > MAX_ITEMS) throw new Error('That notebook has too many arrows to keep.');
  const out = [], seen = new Set();
  for (const l of raw) {
    if (!isObj(l) || !KINDS.has(l.kind)) throw new Error("An arrow on the canvas isn't a known kind.");
    const lid = String(l.id ?? '');
    if (!ITEM_ID.test(lid) || seen.has(lid)) throw new Error('Every arrow needs its own id.');
    seen.add(lid);
    const a = endOf(l.from, ids), b = endOf(l.to, ids);
    if (a === null || b === null || sameEnd(a, b)) continue;
    const link = { id: lid, kind: l.kind, from: a, to: b, bend: n(l.bend, -2, 2) };
    if (LINK_HEADS.has(l.heads)) link.heads = l.heads;
    if (LINK_STROKES.has(l.stroke)) link.stroke = l.stroke;
    if (ITEM_COLORS.has(l.color)) link.color = l.color;
    const label = Array.from(strip(String(l.label || ''))).slice(0, 200).join('');
    if (label) Object.assign(link, { label, caps: !!l.caps, underline: !!l.underline });
    out.push(link);
  }
  return out;
}

export const blank = (id, title, color, now) => ({ id, title, color, created: now, updated: now, rev: 1,
  view: { x: 0.0, y: 0.0, z: 1.0 }, sense_open: false, items: [], links: [], narration: null });

/** A text item's box. Measured by the browser; guessed from its text until then. */
function size(i) {
  if (i.type !== 'text') return [Math.max(i.w, 20.0), Math.max(i.h, 20.0)];
  const lines = i.text.split('\n');
  const w = i.w || Math.min(TEXT_W, Math.max(40.0, 9.5 * Math.max(...lines.map(l => Array.from(l).length))));
  return [Math.max(w, 20.0), Math.max(i.h || 26.0 * lines.length, 20.0)];
}

/** The canvas as a page in the harness schema. Photos are left out; arrows with a free end too, unless `withFree`. */
export function toPage(nb, withFree = false) {
  const texts = nb.items.filter(i => i.type === 'text' && strip(i.text));
  const shapes = nb.items.filter(i => i.type === 'shape');
  const keep = [...texts, ...shapes];
  if (!keep.length) return { page_id: nb.id, page_size: [1000.0, 700.0], elements: [], links: [] };
  const boxes = new Map(keep.map(i => [i.id, [i.x, i.y, ...size(i)]]));
  const bs = [...boxes.values()];
  const ox = Math.min(...bs.map(b => b[0])) - PAD, oy = Math.min(...bs.map(b => b[1])) - PAD;
  const Wd = Math.max(...bs.map(b => b[0] + b[2])) - ox + PAD, Ht = Math.max(...bs.map(b => b[1] + b[3])) - oy + PAD;
  const elements = keep.map(i => {
    const [x, y, w, h] = boxes.get(i.id);
    const e = { id: i.id, type: i.type, bbox: [x - ox, y - oy, w, h] };
    if (i.type === 'text') Object.assign(e, { text: strip(i.text), underline: i.underline, caps: i.caps });
    else e.contains = texts.filter(t => { const b = boxes.get(t.id); const cx = b[0] + b[2] / 2, cy = b[1] + b[3] / 2; return x <= cx && cx <= x + w && y <= cy && cy <= y + h; }).map(t => t.id);
    return e;
  });
  const links = [];
  for (const l of nb.links) {
    const ends = [l.from, l.to];
    if ((ends.some(e => typeof e !== 'string') && !withFree) || ends.some(e => typeof e === 'string' && !boxes.has(e))) continue;
    const out = { id: l.id, kind: l.kind, bend: l.bend ?? 0,
      from: typeof l.from !== 'string' ? { x: l.from.x - ox, y: l.from.y - oy } : l.from,
      to: typeof l.to !== 'string' ? { x: l.to.x - ox, y: l.to.y - oy } : l.to };
    if (l.label) Object.assign(out, { label: l.label, caps: l.caps ?? false, underline: l.underline ?? false });
    links.push(out);
  }
  return { page_id: nb.id, page_size: [Wd, Ht], elements, links };
}

export function threadOf(sense) {
  const out = {};
  sense.threads.forEach((t, k) => t.ids.forEach(i => { out[i] = k; }));
  return out;
}

/** A small picture of the notebook: its notes as tinted blocks, its shapes dashed, its arrows as lines. */
export function thumbSvg(nb, sense) {
  const items = nb.items.filter(i => ['text', 'shape', 'image'].includes(i.type));
  if (!items.length) return '';
  const sizes = new Map(items.map(i => [i.id, size(i)]));
  const minx = Math.min(...items.map(i => i.x)), miny = Math.min(...items.map(i => i.y));
  const maxx = Math.max(...items.map(i => i.x + sizes.get(i.id)[0])), maxy = Math.max(...items.map(i => i.y + sizes.get(i.id)[1]));
  const vw = 240, vh = 150;
  const s = Math.min((vw - 24) / Math.max(maxx - minx, 1), (vh - 24) / Math.max(maxy - miny, 1), 1.0);
  const ox = (vw - (maxx - minx) * s) / 2 - minx * s, oy = (vh - (maxy - miny) * s) / 2 - miny * s;
  const tint = threadOf(sense);
  const centre = new Map(items.map(i => [i.id, [ox + (i.x + sizes.get(i.id)[0] / 2) * s, oy + (i.y + sizes.get(i.id)[1] / 2) * s]]));
  const f = (v, d = 1) => fmt(v, d);
  const out = [`<svg viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">`];
  for (const i of items) {   // photos and shapes first, so notes sit on them
    const [w0, h0] = sizes.get(i.id);
    const [x, y, w, h] = [ox + i.x * s, oy + i.y * s, w0 * s, h0 * s];
    if (i.type === 'image') out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="3" fill="var(--bg-muted)" opacity=".7"/>`);
    else if (i.type === 'shape') out.push(`<ellipse cx="${f(x + w / 2)}" cy="${f(y + h / 2)}" rx="${f(w / 2)}" ry="${f(h / 2)}" fill="none" stroke="var(--line-strong)" stroke-dasharray="3 3" opacity=".6"/>`);
  }
  for (const l of nb.links) {
    if (typeof l.from === 'string' && typeof l.to === 'string' && centre.has(l.from) && centre.has(l.to)) {
      const [x1, y1] = centre.get(l.from), [x2, y2] = centre.get(l.to);
      out.push(`<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="var(--fg-3)" stroke-width="1"/>`);
    }
  }
  for (const i of items) {
    if (i.type !== 'text') continue;
    let [w, h] = sizes.get(i.id);
    w = Math.max(w * s, 10); h = Math.max(h * s, 6);
    const x = ox + i.x * s, y = oy + i.y * s;
    const k = tint[i.id];
    const fill = k !== undefined ? `var(--${COLORS[k % 6]}-soft)` : 'var(--bg-sunken)';
    out.push(`<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="3" fill="${fill}"/>` +
      `<rect x="${f(x + w * 0.12)}" y="${f(y + h / 2 - 0.75)}" width="${f(w * 0.76)}" height="1.5" rx=".75" fill="var(--fg-3)"/>`);
  }
  out.push('</svg>');
  return out.join('');
}

/** Where a new photo goes when nobody said: to the right of everything. */
export function freeSpot(nb) {
  if (!nb.items.length) return [0.0, 0.0];
  return [Math.max(...nb.items.map(i => i.x + size(i)[0])) + 160, Math.min(...nb.items.map(i => i.y))];
}

/**
 * Put a photographed page on the canvas: the photo, and beside it the words it was read as, at the same positions, as ordinary items.
 * `freshId(prefix)` makes unused ids. Returns the new items and links (not yet cleaned) and the photo's file name.
 */
export function importPage(nb, page, noteId, at, freshId) {
  const [pw, ph] = page.page_size;
  const s = IMPORT_W / pw;
  const [ox, oy] = at ? [n(at.x), n(at.y)] : freeSpot(nb);
  const asset = `${noteId}.jpg`;
  const ids = new Map();
  const items = [{ id: freshId('p'), type: 'image', x: ox, y: oy, w: IMPORT_W, h: ph * s, src: asset }];
  const cx = ox + IMPORT_W + GAP, si = s * TYPED_SCALE;
  for (const e of page.elements) {
    if (e.type !== 'text' && e.type !== 'shape') continue;
    const [x, y, w, h] = e.bbox;
    const item = { id: freshId('n'), type: e.type, x: cx + x * si, y: oy + y * si, w: Math.max(60.0, w * si * 1.15), h: h * si };
    if (e.type === 'text') Object.assign(item, { text: e.text, underline: !!e.underline, caps: !!e.caps });
    ids.set(e.id, item.id);
    items.push(item);
  }
  const links = [];
  const endId = v => ids.get(typeof v === 'string' ? v : v[0].id);
  for (const l of page.links) {
    const a = endId(l.from), b = endId(l.to);
    if (a && b) {
      const link = { id: freshId('a'), kind: l.kind, from: a, to: b, bend: 0 };
      if (l.label) Object.assign(link, { label: l.label, caps: !!l.caps, underline: !!l.underline });
      links.push(link);
    }
  }
  return { items, links, asset };
}
