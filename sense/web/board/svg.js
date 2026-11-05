// The board as a standalone SVG string: the picture render.js paints on the canvas, kept as vectors, for export.
// Everything that decides how something looks is borrowed from the canvas renderer's own helpers (text wrapping and fit, shape
// outlines, connector routes and arrowheads), so the two cannot drift apart; only the drawing calls change. Those helpers draw into
// a canvas or Path2D, so a small recorder (Rec) stands in for them and writes SVG path data instead.
// text.js measures with a canvas, so this needs a DOM: it runs in the browser, never in plain node.
//
// Differences from the screen, on purpose: it is drawn at full detail (the canvas leaves text off tiny objects and flattens the
// smallest ones for speed), there is no selection, hover, guide or author byline, and what a collapsed mind-map node folds away stays folded.

import { stickyHex, inkOn, INK } from './palette.js';
import * as T from './text.js';
import { trace, lid, textArea, box, grow, union } from './geom.js';
import * as C from './connectors.js';

// Only used when a caller passes no theme: plain named colours (export-ui.js always passes the light theme's tokens).
const THEME = { bg: 'white', fg: 'black', fg2: 'dimgray', fg3: 'gray', surface: 'white', sunken: 'whitesmoke', muted: 'gainsboro',
  line: 'silver', soft: 'gainsboro', action: 'slateblue', ink: INK, family: 'sans-serif' };

let seq = 0;   // clip ids stay unique when several exports are shown in one page

// --- small writers ------------------------------------------------------------------------------------

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
/** Text or an attribute value, safe in XML: markup escaped, and the characters XML 1.0 cannot hold dropped. */
const esc = s => {
  s = String(s);
  if (s.toWellFormed) s = s.toWellFormed();
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/[&<>"]/g, c => ENT[c]);
};
const f = v => { const r = Math.round(v * 100) / 100; return String(Number.isFinite(r) ? r : 0); };
const fill = c => `fill="${esc(c)}"`;
const R = (x, y, w, h, rx, a) => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}"${rx ? ` rx="${f(rx)}"` : ''}${a ? ' ' + a : ''}/>`;
const finite = (...v) => v.every(Number.isFinite);

/** One <text> for a run of lines. Each run is {x, y, s}: the baseline start (or anchor) point and the words. */
function txt({ fs, bold, italic, fill: c, anchor, face }, runs, extra = '') {
  runs = runs.filter(r => r.s);
  if (!runs.length) return '';
  const fam = face && T.FACES[face] && T.FACES[face].css;
  const a = `font-size="${f(fs)}"${fam ? ` font-family="${esc(fam)}"` : ''}${bold ? ' font-weight="600"' : ''}${italic ? ' font-style="italic"' : ''}${anchor && anchor !== 'start' ? ` text-anchor="${anchor}"` : ''} ${fill(c)}${extra}`;
  if (runs.length === 1) return `<text x="${f(runs[0].x)}" y="${f(runs[0].y)}" ${a}>${esc(runs[0].s)}</text>`;
  return `<text ${a}>${runs.map(r => `<tspan x="${f(r.x)}" y="${f(r.y)}">${esc(r.s)}</tspan>`).join('')}</text>`;
}

// --- path recorder ------------------------------------------------------------------------------------

/** Takes the canvas path calls geom.js and connectors.js make and writes them as SVG path data. */
class Rec {
  constructor() { this.d = ''; this.x = 0; this.y = 0; this.sx = 0; this.sy = 0; this.filled = false; }
  beginPath() { this.d = ''; }
  fill() { this.filled = true; }
  stroke() {}
  moveTo(x, y) { this.d += `M${f(x)} ${f(y)}`; this.x = this.sx = x; this.y = this.sy = y; }
  lineTo(x, y) { this.d += `L${f(x)} ${f(y)}`; this.x = x; this.y = y; }
  closePath() { this.d += 'Z'; this.x = this.sx; this.y = this.sy; }
  bezierCurveTo(a, b, c, d, x, y) { this.d += `C${f(a)} ${f(b)} ${f(c)} ${f(d)} ${f(x)} ${f(y)}`; this.x = x; this.y = y; }
  rect(x, y, w, h) { this.moveTo(x, y); this.lineTo(x + w, y); this.lineTo(x + w, y + h); this.lineTo(x, y + h); this.closePath(); }
  roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    if (!(r > 0)) return this.rect(x, y, w, h);
    const a = `A${f(r)} ${f(r)} 0 0 1 `;
    this.moveTo(x + r, y); this.lineTo(x + w - r, y); this.d += `${a}${f(x + w)} ${f(y + r)}`; this.lineTo(x + w, y + h - r);
    this.d += `${a}${f(x + w - r)} ${f(y + h)}`; this.lineTo(x + r, y + h); this.d += `${a}${f(x)} ${f(y + h - r)}`; this.lineTo(x, y + r);
    this.d += `${a}${f(x + r)} ${f(y)}`; this.closePath();
  }
  /** The rounded corner the canvas draws between two lines, as a tangent line then an arc. */
  arcTo(x1, y1, x2, y2, r) {
    const ax = this.x - x1, ay = this.y - y1, bx = x2 - x1, by = y2 - y1;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by), cross = ax * by - ay * bx;
    if (!la || !lb || !r || Math.abs(cross) < 1e-9 * la * lb) return this.lineTo(x1, y1);
    const t = r / Math.tan(Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) / 2);
    const ex = x1 + bx / lb * t, ey = y1 + by / lb * t;
    this.lineTo(x1 + ax / la * t, y1 + ay / la * t);
    this.d += `A${f(r)} ${f(r)} 0 0 ${cross < 0 ? 1 : 0} ${f(ex)} ${f(ey)}`; this.x = ex; this.y = ey;
  }
  /** An ellipse arc (never rotated, which is all the shapes need), split into halves so SVG's arc flags stay unambiguous. */
  ellipse(cx, cy, rx, ry, rot, a0, a1, ccw) {
    const TAU = Math.PI * 2;
    let da = a1 - a0;
    if (!ccw) da = da >= TAU ? TAU : ((da % TAU) + TAU) % TAU;
    else da = da <= -TAU ? -TAU : -((((-da) % TAU) + TAU) % TAU);
    const sx = cx + rx * Math.cos(a0), sy = cy + ry * Math.sin(a0);
    if (!this.d) this.moveTo(sx, sy);
    else if (Math.abs(this.x - sx) > 1e-6 || Math.abs(this.y - sy) > 1e-6) this.lineTo(sx, sy);
    const n = Math.ceil(Math.abs(da) / Math.PI - 1e-9);
    for (let i = 1; i <= n; i++) {
      const a = a0 + da * i / n, x = cx + rx * Math.cos(a), y = cy + ry * Math.sin(a);
      this.d += `A${f(rx)} ${f(ry)} 0 0 ${da > 0 ? 1 : 0} ${f(x)} ${f(y)}`; this.x = x; this.y = y;
    }
  }
  arc(cx, cy, r, a0, a1, ccw) { this.ellipse(cx, cy, r, r, 0, a0, a1, ccw); }
}

/** The outline of a shape as SVG path data: the same one geom.trace draws on the canvas. */
export function svgPath(kind, x, y, w, h) { const p = new Rec(); trace(p, kind, x, y, w, h); return p.d; }
const lidPath = (x, y, w, h) => { const p = new Rec(); lid(p, x, y, w, h); return p.d; };

/** The line of a connector, already stopped short of its heads. strokePath makes its own Path2D, so it gets the recorder instead for the call. */
function lineD(c, r, w) {
  const real = globalThis.Path2D;
  globalThis.Path2D = Rec;
  try {
    const p = C.strokePath(c, r, w, c.start_head, c.end_head);
    if (!(p instanceof Rec)) throw new Error('connectors.strokePath did not use Path2D');
    return p.d;
  } finally { globalThis.Path2D = real; }
}

/** One arrowhead, from connectors.head: its path data, and whether it is solid (filled) or an open line. */
function headD(kind, p, dir, w) {
  if (!kind || kind === 'none') return null;
  const g = new Rec();
  C.head(g, kind, p.x, p.y, dir.x, dir.y, w);
  return g.d ? { d: g.d, solid: g.filled } : null;
}

// --- text ------------------------------------------------------------------------------------------------

/** An object's words, laid out by text.layout and placed as text.draw does (same box, same line height, same baseline). */
function words(o, inner, color) {
  if (!o.text) return '';
  const t = T.layout(o, inner), st = T.style(o);
  const x0 = (inner ? inner.x : o.x) + t.pad;
  const x = st.align === 'center' ? x0 + t.iw / 2 : st.align === 'right' ? x0 + t.iw : x0;
  let y = (inner ? inner.y : o.y) + t.pad + (o.type === 'text' ? 0 : Math.max(0, (t.ih - t.lines.length * t.lh) / 2));
  const runs = [];
  let rules = '';
  for (const line of t.lines) {
    const base = y + t.fs * 0.99;
    if (line) {
      runs.push({ x, y: base, s: line });
      if (st.underline) {
        // drawn as a bar, as the canvas does, so it sits the same whatever font ends up rendering
        const lw = T.measure(line, t.fs, st.bold, st.italic, st.face), l = st.align === 'center' ? x - lw / 2 : st.align === 'right' ? x - lw : x;
        rules += `M${f(l)} ${f(base + t.fs * 0.1)}h${f(lw)}v${f(Math.max(1, t.fs * 0.06))}h${f(-lw)}z`;
      }
    }
    y += t.lh;
  }
  const anchor = st.align === 'center' ? 'middle' : st.align === 'right' ? 'end' : 'start';
  return txt({ fs: t.fs, bold: st.bold, italic: st.italic, fill: color, anchor, face: st.face }, runs) + (rules ? `<path d="${rules}" ${fill(color)}/>` : '');
}

const own = o => o.text_style && o.text_style.color;
const onFill = (o, th) => own(o) || (o.fill ? inkOn(o.fill) : th.fg);

function ell(s, w, fs, bold) {
  const m = x => T.measure(x, fs, bold, false);
  if (m(s) <= w) return s;
  while (s.length > 1 && m(s + '…') > w) s = s.slice(0, -1);
  return s + '…';
}
const size = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`;

const dashOf = (kind, w, dotted) => kind === 'dashed' ? [w * 4, w * 3] : kind === 'dotted' ? dotted : null;

// --- one object each ------------------------------------------------------------------------------------

/** The card behind a file or a link: a soft shadow, the surface, a 1px edge. */
const card = (o, th) => R(o.x, o.y + 3, o.w, o.h, 10, `${fill(th.ink)} opacity=".12"`) + R(o.x, o.y, o.w, o.h, 10, `${fill(th.surface)} stroke="${esc(th.line)}"`);

const DRAW = {
  sticky(o, k) {
    const bg = stickyHex(o.color), ink = own(o) || inkOn(bg);
    return (o.w > 14 ? R(o.x + 1, o.y + 4, o.w, o.h, 0, `${fill(k.th.ink)} opacity=".14"`) : '') + R(o.x, o.y, o.w, o.h, 0, fill(bg)) + words(o, null, ink);
  },

  text(o, k) {
    return (o.fill ? R(o.x, o.y, o.w, o.h, 4, fill(o.fill)) : '') + words(o, null, onFill(o, k.th));
  },

  shape(o, k) {
    const { th } = k, lw = o.stroke_width === undefined ? 2 : o.stroke_width;
    let s = '';
    if (o.fill || lw > 0) {
      const dash = dashOf(o.dash, lw, [lw, lw * 2.2]);
      const line = lw > 0 ? ` stroke="${esc(o.stroke || th.fg)}" stroke-width="${f(lw)}" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash.map(f).join(' ')}"` : ''}` : '';
      s += `<path d="${svgPath(o.shape, o.x, o.y, o.w, o.h)}" ${o.fill ? fill(o.fill) : 'fill="none"'}${line}/>`;
      if (lw > 0 && o.shape === 'cylinder') s += `<path d="${lidPath(o.x, o.y, o.w, o.h)}" fill="none"${line}/>`;
    }
    return s + words(o, textArea(o.shape, o), onFill(o, th));
  },

  node(o, k) {
    const { th } = k, bg = o.fill || th.surface;
    let s = R(o.x, o.y, o.w, o.h, Math.min(o.h / 2, 26), `${fill(bg)}${o.fill ? '' : ` stroke="${esc(th.line)}" stroke-width="2"`}`);
    const folded = k.folded.get(o.id);
    if (folded) {
      const cx = o.x + o.w + 14, cy = o.y + o.h / 2;
      s += `<circle cx="${f(cx)}" cy="${f(cy)}" r="9" ${fill(th.action)} stroke="${esc(th.action)}" stroke-width="1.5"/>`
        + txt({ fs: 11, bold: true, fill: th.surface, anchor: 'middle' }, [{ x: cx, y: cy + 4, s: String(folded) }]);
    }
    return s + words(o, null, onFill(o, th));
  },

  frame(o, k) {
    const { th } = k, fs = 14;   // render.js: max(14, 13 / zoom), and an export is at zoom 1
    const clip = k.clip(R(o.x, o.y - fs * 2, o.w, fs * 2));
    return R(o.x, o.y, o.w, o.h, 0, `${fill(o.fill || th.surface)} stroke="${esc(th.line)}"`)
      + txt({ fs, bold: true, fill: th.fg2 }, [{ x: o.x + 2, y: o.y - fs * 0.45, s: o.title || 'Frame' }], ` clip-path="url(#${clip})"`);
  },

  connector(o, k) {
    const { th } = k, r = k.routes.get(o.id), w = o.width || 2, col = o.color || th.fg;
    const dash = dashOf(o.dash, w, [w * 0.1, w * 2.4]);
    const open = [], solid = [];
    for (const [kind, p, dir] of [[o.end_head, r.pts[r.pts.length - 1], r.tip], [o.start_head, r.pts[0], r.tail]]) {
      const h = headD(kind, p, dir, w);
      if (h) (h.solid ? solid : open).push(h.d);
    }
    let s = `<g fill="none" stroke="${esc(col)}" stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round">`
      + `<path d="${lineD(o, r, w)}"${dash ? ` stroke-dasharray="${dash.map(f).join(' ')}"` : ''}/>`
      + (open.length ? `<path d="${open.join('')}"/>` : '')
      + (solid.length ? `<path d="${solid.join('')}" ${fill(col)} stroke="none"/>` : '') + '</g>';
    if (o.label) {
      const m = C.midpoint(r), ts = o.text_style || {}, fs = typeof ts.size === 'number' ? ts.size : 15, tw = T.measure(o.label, fs, !!ts.bold, !!ts.italic, T.style(o).face);
      s += R(m.x - tw / 2 - 6, m.y - fs * 0.8, tw + 12, fs * 1.6, 6, fill(th.bg))
        + txt({ fs, bold: !!ts.bold, italic: !!ts.italic, fill: ts.color || th.fg, anchor: 'middle', face: T.style(o).face }, [{ x: m.x, y: m.y + fs * 0.33, s: o.label }]);
    }
    return s;
  },

  draw(o) {
    const pts = o.points, n = Math.floor(pts.length / 3), hl = o.tool === 'highlighter', col = o.color || INK, width = o.width || 4;
    const X = i => o.x + pts[i * 3], Y = i => o.y + pts[i * 3 + 1];
    const alpha = hl ? ' opacity=".4"' : '';
    if (n === 1) return `<circle cx="${f(X(0))}" cy="${f(Y(0))}" r="${f(width / 2)}" ${fill(col)}${alpha}/>`;
    let lo = 1, hi = 0;
    for (let i = 2; i < pts.length; i += 3) { if (pts[i] < lo) lo = pts[i]; if (pts[i] > hi) hi = pts[i]; }
    const ink = `fill="none" stroke="${esc(col)}" stroke-linejoin="round"`;
    if (hi - lo > 0.12 && !hl) {
      // a stylus: one segment per step with its own width. Equal widths share a path, which draws the same since the ink is opaque.
      const byW = new Map();
      for (let i = 1; i < n; i++) {
        const w = Math.round(Math.max(0.6, width * (0.25 + (pts[i * 3 + 2] + pts[(i - 1) * 3 + 2]) / 2 * 1.1)) * 10) / 10;
        byW.set(w, (byW.get(w) || '') + `M${f(X(i - 1))} ${f(Y(i - 1))}L${f(X(i))} ${f(Y(i))}`);
      }
      return `<g ${ink} stroke-linecap="round">${[...byW].map(([w, d]) => `<path d="${d}" stroke-width="${w}"/>`).join('')}</g>`;
    }
    // smooth through the midpoints, as render.js stroke() does
    let d = `M${f(X(0))} ${f(Y(0))}`;
    if (n > 2) {
      d += 'Q';
      for (let i = 1; i < n - 1; i++) d += `${f(X(i))} ${f(Y(i))} ${f((X(i) + X(i + 1)) / 2)} ${f((Y(i) + Y(i + 1)) / 2)} `;
    }
    return `<path d="${d}L${f(X(n - 1))} ${f(Y(n - 1))}" ${ink} stroke-width="${f(width)}" stroke-linecap="${hl ? 'butt' : 'round'}"${alpha}/>`;
  },

  image(o, k) {
    const src = k.assets.get(o.src);
    return (src ? `<image x="${f(o.x)}" y="${f(o.y)}" width="${f(o.w)}" height="${f(o.h)}" preserveAspectRatio="none" xlink:href="${esc(src)}"/>` : R(o.x, o.y, o.w, o.h, 0, fill(k.th.muted)))
      + R(o.x, o.y, o.w, o.h, 0, `fill="none" stroke="${esc(k.th.soft)}"`);
  },

  file(o, k) {
    const { th } = k, pad = 14, ext = ((o.name || '').split('.').pop() || 'file').slice(0, 4).toUpperCase();
    const ix = o.x + pad, iy = o.y + (o.h - 44) / 2, mid = o.y + o.h / 2;
    return card(o, th)
      + R(ix, iy, 36, 44, 5, `${fill(th.sunken)} stroke="${esc(th.line)}" stroke-width="1.2"`)
      + txt({ fs: 10, bold: true, fill: th.fg2, anchor: 'middle' }, [{ x: ix + 18, y: iy + 28, s: ext }])
      + txt({ fs: 15, bold: true, fill: th.fg }, [{ x: ix + 48, y: mid - 3, s: ell(o.name || 'File', o.w - pad * 2 - 48, 15, true) }])
      + txt({ fs: 13, fill: th.fg3 }, [{ x: ix + 48, y: mid + 17, s: size(Number(o.size) || 0) }]);
  },

  link(o, k) {
    const { th } = k, pad = 12, ph = o.thumb ? Math.min(o.h * 0.5, o.w * 0.52) : 0;
    let s = card(o, th);
    if (ph) {
      const im = k.assets.get(o.thumb);
      s += `<g clip-path="url(#${k.clip(R(o.x, o.y, o.w, o.h, 10))})">${R(o.x, o.y, o.w, ph, 0, fill(th.muted))}`
        // slice = cover: fills the strip and crops what spills out, centred, as the canvas does
        + (im ? `<image x="${f(o.x)}" y="${f(o.y)}" width="${f(o.w)}" height="${f(ph)}" preserveAspectRatio="xMidYMid slice" xlink:href="${esc(im)}"/>` : '') + '</g>';
    }
    let y = o.y + ph + pad;
    const fav = o.favicon && k.assets.get(o.favicon);
    s += fav ? `<image x="${f(o.x + pad)}" y="${f(y + 2)}" width="16" height="16" preserveAspectRatio="none" xlink:href="${esc(fav)}"/>`
      : `<circle cx="${f(o.x + pad + 8)}" cy="${f(y + 10)}" r="8" ${fill(th.muted)}/>`;
    s += txt({ fs: 12, fill: th.fg3 }, [{ x: o.x + pad + 24, y: y + 14, s: ell(o.host || '', o.w - pad * 2 - 24, 12, false) }]);
    y += 28;
    const lines = T.wrap(o.title || o.url || '', o.w - pad * 2, 15, true, false).slice(0, Math.max(1, Math.floor((o.y + o.h - y - 8) / 19)));
    return s + txt({ fs: 15, bold: true, fill: th.fg }, lines.map((l, i) => ({ x: o.x + pad, y: y + 14 + i * 19, s: l })));
  },
};

// --- what is on the board --------------------------------------------------------------------------------

/** Is this end of a connector somewhere? A glued end whose object is not in the list would otherwise be drawn from (0, 0). */
function placed(end, map) {
  if (!end) return false;
  if (end.id) { const t = map.get(end.id); return !!t && t.type !== 'connector'; }
  return finite(end.x, end.y);
}

/** What collapsed mind-map nodes fold away (their branches, and the connectors into them), and how many nodes each one holds. */
function foldedAway(all) {
  const kids = new Map(), hide = new Set(), count = new Map();
  for (const n of all) if (n.type === 'node' && n.mm && n.mm.parent) { if (!kids.has(n.mm.parent)) kids.set(n.mm.parent, []); kids.get(n.mm.parent).push(n.id); }
  for (const n of all) {
    if (n.type !== 'node' || !n.mm || !n.mm.collapsed) continue;
    const seen = new Set(), stack = [...(kids.get(n.id) || [])];
    while (stack.length) { const i = stack.pop(); if (seen.has(i)) continue; seen.add(i); stack.push(...(kids.get(i) || [])); }
    for (const i of seen) hide.add(i);
    if (seen.size) count.set(n.id, seen.size);
  }
  for (const c of all) if (c.type === 'connector' && ((c.from && c.from.id && hide.has(c.from.id)) || (c.to && c.to.id && hide.has(c.to.id)))) hide.add(c.id);
  return { hide, count };
}

/** Everything that will be drawn: the objects in order, their routes, and the box each one covers (strokes, shadows and labels included). */
function scan(objects) {
  const all = (objects || []).filter(o => o && typeof o === 'object');
  const map = new Map(all.map(o => [o.id, o]));
  const { hide, count } = foldedAway(all);
  const list = [], routes = new Map(), boxes = [];
  for (const o of all) {
    if (hide.has(o.id) || !Object.hasOwn(DRAW, o.type)) continue;
    if (o.type === 'connector') {
      if (!placed(o.from, map) || !placed(o.to, map)) continue;
      const r = C.route(o, id => map.get(id)), w = o.width || 2;
      routes.set(o.id, r);
      const heads = (o.start_head && o.start_head !== 'none') || (o.end_head && o.end_head !== 'none');
      boxes.push(grow(C.bounds(r), w / 2 + (heads ? (9 + w * 2.6) / 2 : 0)));
      if (o.label) {
        const m = C.midpoint(r), ts = o.text_style || {}, fs = typeof ts.size === 'number' ? ts.size : 15, tw = T.measure(o.label, fs, !!ts.bold, !!ts.italic, T.style(o).face);
        boxes.push({ x: m.x - tw / 2 - 6, y: m.y - fs * 0.8, w: tw + 12, h: fs * 1.6 });
      }
    } else if (o.type === 'draw') {
      if (!Array.isArray(o.points) || o.points.length < 3 || !finite(o.x, o.y)) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i + 1 < o.points.length; i += 3) { x0 = Math.min(x0, o.points[i]); x1 = Math.max(x1, o.points[i]); y0 = Math.min(y0, o.points[i + 1]); y1 = Math.max(y1, o.points[i + 1]); }
      if (!finite(x0, y0, x1, y1)) continue;
      boxes.push(grow({ x: o.x + x0, y: o.y + y0, w: x1 - x0, h: y1 - y0 }, (o.width || 4) / 2));
    } else {
      if (!finite(o.x, o.y, o.w, o.h)) continue;
      boxes.push(extent(o, count));
    }
    list.push(o);
  }
  return { list, routes, boxes, folded: count };
}

/** The box an object's drawing covers, which reaches a little past o.x/y/w/h for a shadow, a stroke, a frame's title or a fold badge. */
function extent(o, folded) {
  switch (o.type) {
    case 'sticky': return { x: o.x, y: o.y, w: o.w + 1, h: o.h + 4 };
    case 'file': case 'link': return { x: o.x, y: o.y, w: o.w, h: o.h + 3 };
    case 'frame': return { x: o.x, y: o.y - 18, w: o.w, h: o.h + 18 };
    case 'node': return folded.get(o.id) ? { x: o.x, y: o.y, w: o.w + 24, h: o.h } : box(o);
    case 'shape': { const lw = o.stroke_width === undefined ? 2 : o.stroke_width; return lw > 0 ? grow(box(o), lw / 2) : box(o); }
    default: return box(o);
  }
}

/** The box around everything the export draws, connectors by their routes. {x, y, w, h}, all 0 for an empty board. */
export function boundsOf(objects) {
  return union(scan(objects).boxes) || { x: 0, y: 0, w: 0, h: 0 };
}

const familyNow = () => T.fontOf(0, false, false).slice('400 0px '.length);

/**
 * objects: board objects back to front (connectors may point at others in the list; one pointing at something that is not there is left out).
 * opts.assets: Map of asset name (src, favicon, thumb) -> data: URI, loaded by the caller.
 * opts.theme: resolved colours {bg, fg, fg2, fg3, surface, sunken, muted, line, soft, action, ink, family}; render.readTheme() gives them.
 * opts.padding (48): room around the objects. opts.background (true): paint theme.bg behind everything.
 * opts.css: extra CSS for the <style> block, e.g. @font-face rules, because an SVG shown as an image cannot reach the page's fonts.
 */
export function toSVG(objects, opts = {}) {
  const th = { ...THEME };
  for (const key in opts.theme) if (opts.theme[key]) th[key] = opts.theme[key];
  const pad = opts.padding ?? 48, assets = opts.assets instanceof Map ? opts.assets : new Map(Object.entries(opts.assets || {}));
  const before = familyNow();
  if (th.family !== before) T.setFamily(th.family);   // measure with the font the SVG will name, then give the editor its own back
  try {
    const { list, routes, boxes, folded } = scan(objects);
    const b = union(boxes) || { x: 0, y: 0, w: 0, h: 0 };
    const x0 = Math.floor(b.x - pad), y0 = Math.floor(b.y - pad), w = Math.ceil(b.x + b.w + pad) - x0, h = Math.ceil(b.y + b.h + pad) - y0;
    const defs = [], pre = `bd${++seq}-`;
    const k = { th, assets, routes, folded, clip: inner => { const id = pre + (defs.length + 1); defs.push(`<clipPath id="${id}">${inner}</clipPath>`); return id; } };
    const body = list.map(o => DRAW[o.type](o, k)).filter(Boolean);
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${x0} ${y0} ${w} ${h}" width="${w}" height="${h}" font-family="${esc(th.family)}">`,
      opts.css ? `<style><![CDATA[${String(opts.css).replaceAll(']]>', ']]]]><![CDATA[>')}]]></style>` : '',
      defs.length ? `<defs>${defs.join('')}</defs>` : '',
      opts.background === false ? '' : R(x0, y0, w, h, 0, fill(th.bg)),
      ...body,
      '</svg>',
    ].filter(Boolean).join('\n');
  } finally {
    if (th.family !== before) T.setFamily(before);
  }
}
