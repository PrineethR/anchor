// The page retyped: every box where you wrote it, every arrow where you drew it. A port of sense/canvas.py.
import { esc, fmt } from './pyish.js';

export const W = 1000;
const PAD = 6;   // how far an arrow stops short of a box, in layout units

/** Where the line from the centre of `box` to `toward` leaves it, pushed out by `pad`. */
function edge(box, toward, pad) {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const dx = toward[0] - cx, dy = toward[1] - cy;
  const norm = Math.hypot(dx, dy) || 1.0;
  let t = Math.min(dx ? (box.w / 2) / Math.abs(dx) : Infinity, dy ? (box.h / 2) / Math.abs(dy) : Infinity);
  if (t > 1) t = 0;   // the target's centre is inside this box: leave from the centre
  return [cx + dx * t + dx / norm * pad, cy + dy * t + dy / norm * pad];
}

/** The box an arrow end sits on, or a zero-size box for an end drawn on empty paper ({x, y}). */
function endOf(v, boxes, k) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return { x: v.x * k, y: v.y * k, w: 0, h: 0, thread: null, free: true };
  return boxes.get(typeof v === 'string' ? v : (v && v[0] ? v[0].id : undefined)) || null;
}

/**
 * Geometry for a page. `threadOf` maps an element id to the number of the thread it belongs to.
 * normalize: scale to 1000 across; otherwise keep the page's own units (one unit is one pixel at zoom 1: a notebook).
 */
export function layout(page, threadOf = {}, normalize = true) {
  const [pw, ph] = page.page_size;
  const k = normalize ? W / pw : 1.0;
  const boxes = new Map();
  for (const e of page.elements) {
    const [x, y, w, h] = e.bbox.map(v => v * k);
    boxes.set(e.id, { id: e.id, type: e.type, x, y, w, h, thread: Object.hasOwn(threadOf, e.id) ? threadOf[e.id] : null,
      text: e.text || '', underline: !!e.underline, caps: !!e.caps });
  }
  const arrows = [];
  for (const l of page.links || []) {
    const a = endOf(l.from, boxes, k), b = endOf(l.to, boxes, k);
    if (a === null || b === null || a === b) continue;
    const ac = [a.x + a.w / 2, a.y + a.h / 2], bc = [b.x + b.w / 2, b.y + b.h / 2];
    const dx = bc[0] - ac[0], dy = bc[1] - ac[1];
    const length = Math.hypot(dx, dy);
    const bend = Number(l.bend || 0);
    const c = bend && length ? [(ac[0] + bc[0]) / 2 - dy * bend, (ac[1] + bc[1]) / 2 + dx * bend] : null;
    const [x1, y1] = edge(a, c || bc, a.free ? 0 : PAD);
    const [x2, y2] = edge(b, c || ac, b.free ? 0 : PAD);
    const mid = c ? [(x1 + 2 * c[0] + x2) / 4, (y1 + 2 * c[1] + y2) / 4] : [(x1 + x2) / 2, (y1 + y2) / 2];
    arrows.push({ id: l.id, kind: l.kind, from: a.id ?? null, to: b.id ?? null, label: l.label || '',
      x1, y1, x2, y2, mx: mid[0], my: mid[1], cx: c ? c[0] : null, cy: c ? c[1] : null, bend: c ? bend : 0,
      thread: a.thread !== null && a.thread !== undefined ? a.thread : b.thread,
      caps: !!l.caps, underline: !!l.underline });
  }
  return { w: normalize ? W : pw, h: ph * k, px: !normalize, boxes: [...boxes.values()], arrows };
}

const th = n => (n === null || n === undefined ? '' : ` th${n % 6}`);

export function renderHtml(lay) {
  const { w, h } = lay;
  const pct = (v, total) => `${fmt(100 * v / total, 2)}%`;
  const px = lay.px;
  const maxW = px ? b => `${fmt(Math.max(b.w * 1.15, 80), 0)}px` : b => `${fmt(Math.max(b.w * 1.2, 120) / w * 100, 1)}%`;
  const size = px ? `width:${fmt(w, 0)}px;height:${fmt(h, 0)}px` : `aspect-ratio:${fmt(w, 0)}/${fmt(h, 0)}`;
  const out = [`<div class="canvas${px ? ' px' : ''}" style="${size}">`,
    `<svg viewBox="0 0 ${fmt(w, 0)} ${fmt(h, 0)}" preserveAspectRatio="none" aria-hidden="true">`,
    '<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ah" d="M0 0 10 5 0 10z"/></marker></defs>'];
  for (const a of lay.arrows) {
    if (a.cx === null) out.push(`<line class="wire ${esc(a.kind)}" x1="${fmt(a.x1, 1)}" y1="${fmt(a.y1, 1)}" x2="${fmt(a.x2, 1)}" y2="${fmt(a.y2, 1)}" marker-end="url(#ah)"/>`);
    else out.push(`<path class="wire ${esc(a.kind)}" d="M${fmt(a.x1, 1)} ${fmt(a.y1, 1)}Q${fmt(a.cx, 1)} ${fmt(a.cy, 1)} ${fmt(a.x2, 1)} ${fmt(a.y2, 1)}" marker-end="url(#ah)"/>`);
  }
  out.push('</svg>');
  for (const b of lay.boxes) {
    if (b.type === 'shape') out.push(`<div class="blob" style="left:${pct(b.x, w)};top:${pct(b.y, h)};width:${pct(b.w, w)};height:${pct(b.h, h)}"></div>`);
  }
  for (const b of lay.boxes) {
    if (b.type !== 'text') continue;
    const cls = 'box' + th(b.thread) + (b.underline ? ' u' : '') + (b.caps ? ' c' : '');
    out.push(`<div class="${cls}" data-id="${esc(b.id)}" style="left:${pct(b.x + b.w / 2, w)};top:${pct(b.y + b.h / 2, h)};max-width:${maxW(b)}">${esc(b.text)}</div>`);
  }
  for (const a of lay.arrows) {
    if (a.label) {
      const cls = 'alabel' + th(a.thread) + (a.underline ? ' u' : '') + (a.caps ? ' c' : '');
      out.push(`<div class="${cls}" style="left:${pct(a.mx, w)};top:${pct(a.my, h)}">${esc(a.label)}</div>`);
    }
  }
  out.push('</div>');
  return out.join('');
}
