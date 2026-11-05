// Text on the canvas: wrap it, fit it, draw it. The canvas measures with the same font the page uses, so what the
// editor overlay shows while you type and what the canvas draws afterwards wrap the same way.

let family = 'sans-serif';
export const setFamily = f => { family = f; widths.clear(); };

const ctx = document.createElement('canvas').getContext('2d');
const REF = 40;
const widths = new Map();

/** The typefaces a text can be set in. `ui` is the app's own (whatever the theme says); the rest are bundled or common system faces. */
export const FACES = {
  ui: { label: 'Figtree', css: null },
  serif: { label: 'Newsreader', css: "'Newsreader', Georgia, 'Times New Roman', serif" },
  mono: { label: 'JetBrains Mono', css: "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace" },
  georgia: { label: 'Georgia', css: "Georgia, 'Times New Roman', serif" },
  helvetica: { label: 'Helvetica', css: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  rounded: { label: 'Rounded', css: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Nunito, sans-serif" },
  slab: { label: 'Slab', css: "Rockwell, 'Roboto Slab', 'Courier New', serif" },
  marker: { label: 'Marker', css: "'Marker Felt', 'Bradley Hand', 'Segoe Print', 'Comic Sans MS', cursive" },
  hand: { label: 'Handwritten', css: "'Snell Roundhand', 'Apple Chancery', 'Segoe Script', cursive" },
  impact: { label: 'Bold display', css: "Impact, 'Arial Narrow Bold', 'Haettenschweiler', sans-serif" },
};
export const famOf = face => (face && FACES[face] && FACES[face].css) || family;

export const fontOf = (fs, bold, italic, face) => `${italic ? 'italic ' : ''}${bold ? 600 : 400} ${fs}px ${famOf(face)}`;

function word(w, bold, italic, face) {
  const k = (face || '') + '|' + (bold ? 'b' : '') + (italic ? 'i' : '') + '|' + w;
  let v = widths.get(k);
  if (v === undefined) {
    ctx.font = fontOf(REF, bold, italic, face);
    v = ctx.measureText(w).width;
    if (widths.size > 20000) widths.clear();
    widths.set(k, v);
  }
  return v;
}
export const measure = (s, fs, bold, italic, face) => word(s, bold, italic, face) * fs / REF;

/** Break `text` into lines no wider than `maxW`, keeping the author's own line breaks and splitting a word only when it can't fit on a line. */
export function wrap(text, maxW, fs, bold, italic, face) {
  const out = [];
  const space = word(' ', bold, italic, face) * fs / REF;
  for (const para of String(text).split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '', lw = 0;
    for (const w of para.split(/ +/)) {
      if (!w) continue;
      const ww = measure(w, fs, bold, italic, face);
      if (line && lw + space + ww <= maxW) { line += ' ' + w; lw += space + ww; continue; }
      if (line) { out.push(line); line = ''; lw = 0; }
      if (ww <= maxW) { line = w; lw = ww; continue; }
      let chunk = '';
      for (const ch of w) {
        if (chunk && measure(chunk + ch, fs, bold, italic, face) > maxW) { out.push(chunk); chunk = ch; } else chunk += ch;
      }
      line = chunk; lw = measure(chunk, fs, bold, italic, face);
    }
    out.push(line);
  }
  return out;
}

export const LH = 1.28;

/** The largest size in [min, max] at which the text fits the box. */
export function fit(text, w, h, bold, italic, max = 40, min = 8, face) {
  if (!text) return max;
  let lo = min, hi = max;
  const longest = String(text).split(/\s+/).reduce((a, x) => (x.length > a.length ? x : a), '');
  // fits only if the longest word stays whole: a sticky should shrink its text before it breaks a word in two
  const fits = fs => { if (longest && measure(longest, fs, bold, italic, face) > w && fs > min) return false; const lines = wrap(text, w, fs, bold, italic, face); return lines.length * fs * LH <= h; };
  if (fits(hi)) return hi;
  while (hi - lo > 0.5) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
  return Math.max(min, Math.floor(lo * 2) / 2);
}

export function style(o) {
  const t = o.text_style || {};
  return { size: t.size ?? (o.type === 'sticky' ? 'auto' : o.type === 'node' ? 18 : 16), bold: !!t.bold, italic: !!t.italic, underline: !!t.underline, face: FACES[t.font] ? t.font : null,
    align: t.align || (o.type === 'text' ? 'left' : 'center'), color: t.color || null };
}

/** The padded box a type keeps its words in, within its own rectangle. */
export function pad(o) {
  if (o.type === 'sticky') return Math.max(8, Math.min(o.w, o.h) * 0.09);
  if (o.type === 'text') return 6;
  if (o.type === 'node') return 12;
  return 10;
}

/** Lay out an object's text and cache it on the object (the cache is not saved). Returns {lines, fs, lh}. */
export function layout(o, inner) {
  const st = style(o);
  const c = o._ || (Object.defineProperty(o, '_', { value: {}, enumerable: false, writable: true }), o._);
  const p = pad(o);
  const iw = Math.max(4, (inner ? inner.w : o.w) - p * 2), ih = Math.max(4, (inner ? inner.h : o.h) - p * 2);
  const key = `${o.text}|${iw | 0}|${ih | 0}|${st.size}|${st.bold}|${st.italic}|${st.face}|${family}`;
  if (c.tl && c.tl.key === key) return c.tl;
  const fs = st.size === 'auto' ? fit(o.text, iw, ih, st.bold, st.italic, o.type === 'sticky' ? Math.max(14, Math.min(o.w, o.h) * 0.14) : 28, 8, st.face) : st.size;
  const lines = wrap(o.text, iw, fs, st.bold, st.italic, st.face);
  c.tl = { key, lines, fs, lh: fs * LH, iw, ih, pad: p };
  return c.tl;
}

/** A text box's height: it hugs its words, but never goes below a height you pulled it to. */
export const hug = o => Math.max(textHeight(o), o.minh || 0);

/** How tall a text box must be to show all its words at its width. */
export function textHeight(o) {
  const st = style(o);
  const p = pad(o);
  const fs = typeof st.size === 'number' ? st.size : 18;
  const lines = wrap(o.text, Math.max(4, o.w - p * 2), fs, st.bold, st.italic, st.face);
  return Math.max(fs * LH + p * 2, lines.length * fs * LH + p * 2);
}

export function draw(c, o, inner, fill, z) {
  if (!o.text) return;
  const t = layout(o, inner);
  const st = style(o);
  c.font = fontOf(t.fs, st.bold, st.italic, st.face);
  c.fillStyle = fill;
  c.textBaseline = 'alphabetic';
  const x0 = (inner ? inner.x : o.x) + t.pad, w = t.iw;
  const total = t.lines.length * t.lh;
  const vert = o.type === 'text' ? 0 : Math.max(0, (t.ih - total) / 2);
  let y = (inner ? inner.y : o.y) + t.pad + vert;
  for (const line of t.lines) {
    const lw = measure(line, t.fs, st.bold, st.italic, st.face);
    const x = st.align === 'center' ? x0 + (w - lw) / 2 : st.align === 'right' ? x0 + w - lw : x0;
    const base = y + t.fs * 0.99;   // where the page's own text puts the baseline at this line height
    c.fillText(line, x, base);
    if (st.underline && line) c.fillRect(x, base + t.fs * 0.1, lw, Math.max(1, t.fs * 0.06));
    y += t.lh;
  }
}
