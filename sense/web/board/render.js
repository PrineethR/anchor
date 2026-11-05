// Draws the board on one canvas. Only what is on screen is drawn, and the smallest things are drawn as flat blocks, which
// is what keeps panning and zooming smooth with thousands of objects. Colours that belong to the app (the page, the
// selection, the guides) come from the Noteworthy tokens; colours that belong to the board's content come from the objects.

import { cache } from './doc.js';
import { stickyHex, inkOn, INK } from './palette.js';
import * as T from './text.js';
import { trace, lid, textArea, radius, touches, grow, center } from './geom.js';
import * as C from './connectors.js';

const TOKENS = { bg: '--bg-canvas', dot: '--line', fg: '--fg-1', fg2: '--fg-2', fg3: '--fg-3', surface: '--bg-surface', sunken: '--bg-sunken', muted: '--bg-muted',
  line: '--line', soft: '--line-soft', action: '--action', ink: '--ink-900', hl: '--highlight', guide: '--berry', family: '--font-ui' };

export function readTheme(el = document.body) {
  const cs = getComputedStyle(el);
  const t = {};
  for (const [k, v] of Object.entries(TOKENS)) t[k] = cs.getPropertyValue(v).trim();
  return t;
}

const images = new Map();

export class Renderer {
  constructor(canvas, ed) {
    this.cv = canvas; this.ctx = canvas.getContext('2d', { alpha: false });
    this.ed = ed;
    this.dpr = 1;
    this.need = true;
    this.theme = readTheme();
    this.stats = { drawn: 0, ms: 0 };
    this.busy = false;
  }
  invalidate() { this.need = true; }
  refreshTheme() { this.theme = readTheme(); T.setFamily(this.theme.family); this.need = true; }

  resize(w, h, dpr) {
    this.dpr = dpr || Math.min(window.devicePixelRatio || 1, 2.5);
    this.cv.width = Math.round(w * this.dpr); this.cv.height = Math.round(h * this.dpr);
    this.cv.style.width = w + 'px'; this.cv.style.height = h + 'px';
    this.need = true;
  }

  image(src) {
    const url = this.ed.assetUrl(src);
    let im = images.get(url);
    if (!im) {
      im = new Image(); im.decoding = 'async';
      im.onload = () => { im.ready = true; this.need = true; };
      im.onerror = () => { im.failed = true; this.need = true; };
      im.src = url;
      images.set(url, im);
    }
    return im.ready ? im : null;
  }

  /** Wait for these pictures to load (an export needs every one). */
  preload(srcs) {
    return Promise.all([...new Set(srcs)].map(src => new Promise(done => {
      this.image(src);
      const im = images.get(this.ed.assetUrl(src));
      if (!im || im.ready || im.failed) return done();
      im.addEventListener('load', done, { once: true }); im.addEventListener('error', done, { once: true });
    })));
  }

  /** Redraw if anything changed (or something is still animating). Returns true if it drew. */
  frame(now) {
    const cam = this.ed.cam;
    const moving = cam.step(now);
    if (!this.need && !moving && !this.busy) return false;
    this.need = false;
    const t0 = performance.now();
    this.draw(now);
    this.stats.ms = performance.now() - t0;
    return true;
  }

  draw(now) {
    const { ctx, ed, theme } = this;
    const cam = ed.cam, doc = ed.doc, v = ed.v;
    const z = cam.z, dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, this.cv.width, this.cv.height);
    if (!this.noGrid) this.grid();
    ctx.setTransform(dpr * z, 0, 0, dpr * z, -cam.x * dpr * z, -cam.y * dpr * z);
    const view = cam.visible(8 / z);
    this.busy = false;
    let drawn = 0;
    for (const id of doc.order) {
      const o = doc.map.get(id);
      if (v.hidden && v.hidden.has(id)) continue;
      const r = o.type === 'connector' ? this.routeBox(o) : o;
      if (!r || !touches(r, view)) continue;
      if (r.w * z < 2 && r.h * z < 2 && o.type !== 'draw') continue;
      const tw = o._ && o._.tw;
      let saved = false;
      if (tw) {
        const k = Math.min(1, (now - tw.t0) / tw.ms);
        if (k >= 1) o._.tw = null;
        else {
          this.busy = true; saved = true; ctx.save();
          const e = 1 - Math.pow(1 - k, 3);
          if (tw.pop) { const s = 0.7 + 0.3 * e, c = center(o); ctx.translate(c.x, c.y); ctx.scale(s, s); ctx.translate(-c.x, -c.y); ctx.globalAlpha = e; }
          else ctx.translate(tw.dx * (1 - e), tw.dy * (1 - e));
        }
      }
      this.object(o, z, v);
      if (saved) ctx.restore();
      drawn++;
    }
    if (v.stroke) this.liveStroke(v.stroke, z);
    if (v.connDraft) this.draftConnector(v.connDraft, z);
    this.overlay(z, now);
    this.stats.drawn = drawn;
  }

  grid() {
    const { ctx, theme, ed } = this;
    const cam = ed.cam, dpr = this.dpr;
    let step = 24;
    while (step * cam.z < 14) step *= 2;
    const sp = step * cam.z * dpr;
    if (sp < 6) return;
    const fade = Math.min(1, (step * cam.z - 8) / 14);
    ctx.globalAlpha = 0.5 + 0.5 * fade;
    ctx.fillStyle = theme.dot;
    const x0 = Math.floor(cam.x / step) * step, y0 = Math.floor(cam.y / step) * step;
    const r = Math.max(1, 1.1 * dpr);
    ctx.beginPath();
    for (let wx = x0; wx < cam.x + cam.w / cam.z + step; wx += step) {
      const sx = (wx - cam.x) * cam.z * dpr;
      for (let wy = y0; wy < cam.y + cam.h / cam.z + step; wy += step) {
        const sy = (wy - cam.y) * cam.z * dpr;
        ctx.rect(sx - r / 2, sy - r / 2, r, r);
      }
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  routeBox(o) {
    const c = cache(o), ed = this.ed;
    if (!c.rt || c.rt.ver !== ed.doc.geoVer) {
      const r = C.route(o, id => ed.doc.map.get(id));
      c.rt = { ver: ed.doc.geoVer, r, bb: C.bounds(r) };
    }
    return grow(c.rt.bb, 12 + (o.width || 2) * 2);
  }
  route(o) { this.routeBox(o); return cache(o).rt.r; }

  // --- one object --------------------------------------------------------------------------------

  object(o, z, v) {
    const { ctx, theme } = this;
    const sw = o.w * z, sh = o.h * z;
    switch (o.type) {
      case 'sticky': return this.sticky(o, z, sw, sh, v);
      case 'text': return this.textbox(o, z, sw, v);
      case 'shape': return this.shape(o, z, sw, sh, v);
      case 'node': return this.node(o, z, sw, sh, v);
      case 'frame': return this.frame_(o, z, v);
      case 'connector': return this.connector(o, z, v);
      case 'draw': return this.stroke(o, z);
      case 'image': return this.picture(o, z, sw);
      case 'file': return this.fileCard(o, z, sw, v);
      case 'link': return this.linkCard(o, z, sw, v);
    }
  }

  sticky(o, z, sw, sh, v) {
    const { ctx, theme } = this;
    const fill = stickyHex(o.color), ink = (o.text_style && o.text_style.color) || inkOn(fill);
    if (sw > 14) { ctx.globalAlpha *= 0.14; ctx.fillStyle = theme.ink; ctx.fillRect(o.x + 1 / z, o.y + 4 / z, o.w, o.h); ctx.globalAlpha /= 0.14; }
    ctx.fillStyle = fill;
    ctx.fillRect(o.x, o.y, o.w, o.h);
    if (sw > 36 && !(v.editing === o.id)) { ctx.fillStyle = ink; T.draw(ctx, o, null, ink, z); }
  }

  textbox(o, z, sw, v) {
    const { ctx, theme } = this;
    if (o.fill) { ctx.fillStyle = o.fill; ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 4); ctx.fill(); }
    if (v.editing === o.id) return;
    if (sw < 10) { ctx.globalAlpha *= 0.5; ctx.fillStyle = theme.fg3; ctx.fillRect(o.x + 2, o.y + o.h * 0.35, o.w - 4, Math.max(1 / z, o.h * 0.2)); ctx.globalAlpha /= 0.5; return; }
    const col = (o.text_style && o.text_style.color) || (o.fill ? inkOn(o.fill) : theme.fg);
    ctx.fillStyle = col;
    T.draw(ctx, o, null, col, z);
  }

  shape(o, z, sw, sh, v) {
    const { ctx, theme } = this;
    ctx.beginPath();
    trace(ctx, o.shape, o.x, o.y, o.w, o.h);
    if (o.fill) { ctx.fillStyle = o.fill; ctx.fill(); }
    const lw = o.stroke_width === undefined ? 2 : o.stroke_width;
    if (lw > 0) {
      ctx.lineWidth = lw; ctx.strokeStyle = o.stroke || theme.fg; ctx.lineJoin = 'round'; ctx.lineCap = 'butt';   // a connector drawn before leaves round caps behind, and dashes want butt
      ctx.setLineDash(o.dash === 'dashed' ? [lw * 4, lw * 3] : o.dash === 'dotted' ? [lw, lw * 2.2] : []);
      ctx.stroke();
      if (o.shape === 'cylinder') { ctx.beginPath(); lid(ctx, o.x, o.y, o.w, o.h); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    if (v.editing === o.id || sw < 30) return;
    const col = (o.text_style && o.text_style.color) || (o.fill ? inkOn(o.fill) : theme.fg);
    ctx.fillStyle = col;
    T.draw(ctx, o, textArea(o.shape, o), col, z);
  }

  node(o, z, sw, sh, v) {
    const { ctx, theme } = this;
    const fill = o.fill || theme.surface;
    ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, Math.min(o.h / 2, 26));
    ctx.fillStyle = fill; ctx.fill();
    if (!o.fill) { ctx.lineWidth = 2; ctx.strokeStyle = theme.line; ctx.stroke(); }
    const kids = this.ed.mm ? this.ed.mm.childrenOf(o.id).length : 0;
    if (kids && sw > 24 && (o.mm.collapsed || v.sel.has(o.id) || v.hover === o.id)) {
      const cx = o.x + o.w + 14 / z, cy = o.y + o.h / 2, rr = 9 / z;
      ctx.fillStyle = o.mm.collapsed ? theme.action : theme.surface; ctx.strokeStyle = theme.action; ctx.lineWidth = 1.5 / z;
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = o.mm.collapsed ? theme.surface : theme.action; ctx.font = T.fontOf(11 / z, true, false); ctx.textAlign = 'center';
      ctx.fillText(o.mm.collapsed ? String(this.ed.mm.hiddenCount(o.id)) : '−', cx, cy + 4 / z); ctx.textAlign = 'start';
    }
    if (v.editing === o.id || sw < 24) return;
    const col = (o.text_style && o.text_style.color) || (o.fill ? inkOn(o.fill) : theme.fg);
    ctx.fillStyle = col;
    T.draw(ctx, o, null, col, z);
  }

  frame_(o, z, v) {
    const { ctx, theme } = this;
    ctx.fillStyle = o.fill || theme.surface;
    ctx.fillRect(o.x, o.y, o.w, o.h);
    ctx.lineWidth = 1 / z; ctx.strokeStyle = theme.line;
    ctx.strokeRect(o.x, o.y, o.w, o.h);
    const fs = Math.max(14, 13 / z);
    if (fs * z > 5 && v.editing !== o.id) {
      ctx.font = T.fontOf(fs, true, false);
      ctx.fillStyle = theme.fg2;
      ctx.save(); ctx.beginPath(); ctx.rect(o.x, o.y - fs * 2, o.w, fs * 2); ctx.clip();
      ctx.fillText(o.title || 'Frame', o.x + 2 / z, o.y - fs * 0.45);
      ctx.restore();
    }
  }

  connector(o, z, v) {
    const { ctx, theme } = this;
    this.routeBox(o);
    const r = cache(o).rt.r;
    const w = o.width || 2;
    const col = o.color || theme.fg;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.setLineDash(o.dash === 'dashed' ? [w * 4, w * 3] : o.dash === 'dotted' ? [w * 0.1, w * 2.4] : []);
    ctx.stroke(C.strokePath(o, r, w, o.start_head, o.end_head));
    ctx.setLineDash([]);
    C.head(ctx, o.end_head, r.pts[r.pts.length - 1].x, r.pts[r.pts.length - 1].y, r.tip.x, r.tip.y, w);
    C.head(ctx, o.start_head, r.pts[0].x, r.pts[0].y, r.tail.x, r.tail.y, w);
    if (o.label && v.editing !== o.id && z > 0.25) {
      const m = C.midpoint(r), fs = (o.text_style && typeof o.text_style.size === 'number') ? o.text_style.size : 15;
      ctx.font = T.fontOf(fs, !!(o.text_style && o.text_style.bold), !!(o.text_style && o.text_style.italic), T.style(o).face);
      const tw = ctx.measureText(o.label).width;
      ctx.fillStyle = theme.bg; ctx.beginPath(); ctx.roundRect(m.x - tw / 2 - 6, m.y - fs * 0.8, tw + 12, fs * 1.6, 6); ctx.fill();
      ctx.fillStyle = (o.text_style && o.text_style.color) || theme.fg; ctx.textAlign = 'center'; ctx.fillText(o.label, m.x, m.y + fs * 0.33); ctx.textAlign = 'start';
    }
  }

  stroke(o, z) {
    const { ctx } = this;
    const c = cache(o);
    if (!c.path || c.pathKey !== o.points.length) {
      const pts = o.points, p = new Path2D();
      const n = pts.length / 3;
      if (n === 1) { p.arc(o.x + pts[0], o.y + pts[1], 0.1, 0, Math.PI * 2); }
      else {
        p.moveTo(o.x + pts[0], o.y + pts[1]);
        for (let i = 1; i < n - 1; i++) {
          const x = o.x + pts[i * 3], y = o.y + pts[i * 3 + 1];
          const nx = o.x + pts[(i + 1) * 3], ny = o.y + pts[(i + 1) * 3 + 1];
          p.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
        }
        p.lineTo(o.x + pts[(n - 1) * 3], o.y + pts[(n - 1) * 3 + 1]);
      }
      c.path = p; c.pathKey = o.points.length;
      let lo = 1, hi = 0;
      for (let i = 2; i < pts.length; i += 3) { if (pts[i] < lo) lo = pts[i]; if (pts[i] > hi) hi = pts[i]; }
      c.pressure = hi - lo > 0.12;
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = o.color; ctx.fillStyle = o.color;
    if (o.tool === 'highlighter') { ctx.globalAlpha *= 0.4; ctx.lineCap = 'butt'; }
    if (c.pressure && o.tool !== 'highlighter') this.pressureStroke(o);
    else { ctx.lineWidth = o.width; if (o.points.length === 3) { ctx.beginPath(); ctx.arc(o.x + o.points[0], o.y + o.points[1], o.width / 2, 0, Math.PI * 2); ctx.fill(); } else ctx.stroke(c.path); }
    if (o.tool === 'highlighter') ctx.globalAlpha /= 0.4;
  }
  pressureStroke(o) {
    const { ctx } = this, pts = o.points;
    for (let i = 1; i < pts.length / 3; i++) {
      const p = (pts[i * 3 + 2] + pts[(i - 1) * 3 + 2]) / 2;
      ctx.lineWidth = Math.max(0.6, o.width * (0.25 + p * 1.1));
      ctx.beginPath(); ctx.moveTo(o.x + pts[(i - 1) * 3], o.y + pts[(i - 1) * 3 + 1]); ctx.lineTo(o.x + pts[i * 3], o.y + pts[i * 3 + 1]); ctx.stroke();
    }
  }
  liveStroke(s, z) {
    const o = { x: 0, y: 0, points: s.points, tool: s.tool, color: s.color, width: s.width, _: {} };
    this.stroke(o, z);
  }

  picture(o, z, sw) {
    const { ctx, theme } = this;
    const im = this.image(o.src);
    if (im) { ctx.drawImage(im, o.x, o.y, o.w, o.h); }
    else { ctx.fillStyle = theme.muted; ctx.fillRect(o.x, o.y, o.w, o.h); }
    ctx.lineWidth = 1 / z; ctx.strokeStyle = theme.soft; ctx.strokeRect(o.x, o.y, o.w, o.h);
  }

  card(o, z) {
    const { ctx, theme } = this;
    ctx.globalAlpha *= 0.12; ctx.fillStyle = theme.ink; ctx.beginPath(); ctx.roundRect(o.x, o.y + 3 / z, o.w, o.h, 10); ctx.fill(); ctx.globalAlpha /= 0.12;
    ctx.fillStyle = theme.surface; ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 10); ctx.fill();
    ctx.lineWidth = 1 / z; ctx.strokeStyle = theme.line; ctx.stroke();
  }

  fileCard(o, z, sw, v) {
    const { ctx, theme } = this;
    this.card(o, z);
    if (sw < 40) return;
    const h = o.h, pad = 14, ext = ((o.name || '').split('.').pop() || 'file').slice(0, 4).toUpperCase();
    const ix = o.x + pad, iy = o.y + (h - 44) / 2;
    ctx.fillStyle = theme.sunken; ctx.beginPath(); ctx.roundRect(ix, iy, 36, 44, 5); ctx.fill();
    ctx.strokeStyle = theme.line; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = theme.fg2; ctx.font = T.fontOf(10, true, false); ctx.textAlign = 'center'; ctx.fillText(ext, ix + 18, iy + 28); ctx.textAlign = 'start';
    ctx.fillStyle = theme.fg; ctx.font = T.fontOf(15, true, false);
    ctx.fillText(ellipsize(ctx, o.name || 'File', o.w - pad * 2 - 48), ix + 48, o.y + h / 2 - 3);
    ctx.fillStyle = theme.fg3; ctx.font = T.fontOf(13, false, false);
    ctx.fillText(size(o.size), ix + 48, o.y + h / 2 + 17);
  }

  linkCard(o, z, sw, v) {
    const { ctx, theme } = this;
    this.card(o, z);
    if (sw < 40) return;
    const pad = 12, th = o.thumb ? Math.min(o.h * 0.5, o.w * 0.52) : 0;
    ctx.save(); ctx.beginPath(); ctx.roundRect(o.x, o.y, o.w, o.h, 10); ctx.clip();
    if (th) {
      const im = this.image(o.thumb);
      ctx.fillStyle = theme.muted; ctx.fillRect(o.x, o.y, o.w, th);
      if (im) { const s = Math.max(o.w / im.width, th / im.height), dw = im.width * s, dh = im.height * s; ctx.save(); ctx.beginPath(); ctx.rect(o.x, o.y, o.w, th); ctx.clip(); ctx.drawImage(im, o.x + (o.w - dw) / 2, o.y + (th - dh) / 2, dw, dh); ctx.restore(); }
    }
    ctx.restore();
    let y = o.y + th + pad;
    const fav = o.favicon && this.image(o.favicon);
    if (fav) ctx.drawImage(fav, o.x + pad, y + 2, 16, 16);
    else { ctx.fillStyle = theme.muted; ctx.beginPath(); ctx.arc(o.x + pad + 8, y + 10, 8, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = theme.fg3; ctx.font = T.fontOf(12, false, false);
    ctx.fillText(ellipsize(ctx, o.host || '', o.w - pad * 2 - 24), o.x + pad + 24, y + 14);
    y += 28;
    ctx.fillStyle = theme.fg; ctx.font = T.fontOf(15, true, false);
    const lines = T.wrap(o.title || o.url, o.w - pad * 2, 15, true, false).slice(0, Math.max(1, Math.floor((o.y + o.h - y - 8) / 19)));
    for (const l of lines) { ctx.fillText(l, o.x + pad, y + 14); y += 19; }
  }

  draftConnector(d, z) {
    const { ctx, theme } = this;
    const r = C.route({ ...d.c, from: d.c.from, to: d.c.to }, id => this.ed.doc.map.get(id));
    ctx.strokeStyle = theme.action; ctx.fillStyle = theme.action; ctx.lineWidth = 2; ctx.lineCap = 'round';
    ctx.stroke(C.strokePath(d.c, r, 2, 'none', d.c.end_head));
    C.head(ctx, d.c.end_head, r.pts[r.pts.length - 1].x, r.pts[r.pts.length - 1].y, r.tip.x, r.tip.y, 2);
  }

  // --- the editor's own marks, in screen pixels -------------------------------------------------------

  overlay(z, now) {
    const { ctx, theme, ed, dpr } = this;
    const v = ed.v, cam = ed.cam;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const S = (x, y) => ({ x: (x - cam.x) * z, y: (y - cam.y) * z });

    if (v.hl && v.hl.size) {
      ctx.strokeStyle = theme.hl; ctx.lineWidth = 4;
      for (const id of v.hl) { const o = ed.doc.map.get(id); if (!o) continue; const r = o.type === 'connector' ? ed.boxOf(o) : o, p = S(r.x, r.y); ctx.strokeRect(p.x - 3, p.y - 3, r.w * z + 6, r.h * z + 6); }
    }
    if (v.hover && !v.sel.has(v.hover) && ed.doc.map.has(v.hover) && v.tool === 'select') {
      const o = ed.doc.map.get(v.hover);
      if (o.type !== 'connector') { const p = S(o.x, o.y); ctx.strokeStyle = theme.action; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.5; ctx.strokeRect(p.x - 0.5, p.y - 0.5, o.w * z + 1, o.h * z + 1); ctx.globalAlpha = 1; }
    }
    if (v.sel.size) this.selection(z, S);

    if (v.guides && v.guides.length) {
      ctx.strokeStyle = theme.guide; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath();
      for (const g of v.guides) {
        if (g.x !== undefined) { const a = S(g.x, g.y0), b = S(g.x, g.y1); ctx.moveTo(Math.round(a.x) + 0.5, a.y); ctx.lineTo(Math.round(b.x) + 0.5, b.y); }
        else { const a = S(g.x0, g.y), b = S(g.x1, g.y); ctx.moveTo(a.x, Math.round(a.y) + 0.5); ctx.lineTo(b.x, Math.round(b.y) + 0.5); }
      }
      ctx.stroke();
    }
    if (v.marquee) {
      const m = v.marquee, a = S(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1));
      const w = Math.abs(m.x1 - m.x0) * z, h = Math.abs(m.y1 - m.y0) * z;
      ctx.globalAlpha = 0.1; ctx.fillStyle = theme.action; ctx.fillRect(a.x, a.y, w, h); ctx.globalAlpha = 1;
      ctx.strokeStyle = theme.action; ctx.lineWidth = 1; ctx.strokeRect(a.x + 0.5, a.y + 0.5, w, h);
    }
    if (v.eraser) { const p = S(v.eraser.x, v.eraser.y); ctx.strokeStyle = theme.fg2; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p.x, p.y, v.eraser.r * z, 0, Math.PI * 2); ctx.stroke(); }
    if (v.snapHint) { const p = S(v.snapHint.x, v.snapHint.y); ctx.strokeStyle = theme.action; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, 8, 0, Math.PI * 2); ctx.stroke(); }
  }

  selection(z, S) {
    const { ctx, theme, ed } = this;
    const v = ed.v;
    ctx.strokeStyle = theme.action; ctx.lineWidth = 1.5;
    const objs = [...v.sel].map(id => ed.doc.map.get(id)).filter(Boolean);
    if (objs.length === 1 && objs[0].type === 'connector') {
      const o = objs[0], r = cache(o).rt && cache(o).rt.r;
      if (r) {
        const a = S(r.pts[0].x, r.pts[0].y), b = S(r.pts[r.pts.length - 1].x, r.pts[r.pts.length - 1].y);
        ctx.globalAlpha = 0.35; ctx.lineWidth = Math.max(3, (o.width || 2) * z + 6); ctx.beginPath();
        r.pts.forEach((q, i) => { const s = S(q.x, q.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); });
        ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1.5;
        for (const p of [a, b]) { ctx.fillStyle = theme.surface; ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      }
      return;
    }
    const shapes = objs.filter(o => o.type !== 'connector');
    if (shapes.length <= 200) for (const o of shapes) { const p = S(o.x, o.y); ctx.strokeRect(p.x - 0.5, p.y - 0.5, o.w * z + 1, o.h * z + 1); }
    for (const o of objs) if (o.type === 'connector') { const r = cache(o).rt && cache(o).rt.r; if (r) { ctx.globalAlpha = 0.5; ctx.lineWidth = 3; ctx.beginPath(); r.pts.forEach((q, i) => { const s = S(q.x, q.y); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1.5; } }
    const bb = ed.selectionBox();
    if (!bb) return;
    const p = S(bb.x, bb.y), w = bb.w * z, h = bb.h * z;
    if (shapes.length > 1) { ctx.setLineDash([4, 3]); ctx.strokeRect(p.x - 0.5, p.y - 0.5, w + 1, h + 1); ctx.setLineDash([]); }
    if (ed.canResize()) {
      for (const hd of ed.handles(bb)) {
        const q = S(hd.x, hd.y);
        ctx.fillStyle = theme.surface; ctx.beginPath(); ctx.roundRect(q.x - 5, q.y - 5, 10, 10, 2.5); ctx.fill(); ctx.stroke();
      }
    }
    if (v.quick && !v.editing) {   // not while typing: they would sit on the words
      for (const q of v.quick) {
        const s0 = S(q.x, q.y), s = { x: s0.x + q.nx * 22, y: s0.y + q.ny * 22 }, on = v.quickHover === q.side;
        ctx.fillStyle = on ? theme.action : theme.surface; ctx.strokeStyle = theme.action; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(s.x, s.y, on ? 11 : 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = on ? theme.surface : theme.action; ctx.lineWidth = 1.8; ctx.beginPath();
        ctx.moveTo(s.x - 4, s.y); ctx.lineTo(s.x + 4, s.y); ctx.moveTo(s.x, s.y - 4); ctx.lineTo(s.x, s.y + 4); ctx.stroke();
      }
    }
  }
}

function ellipsize(ctx, s, w) {
  if (ctx.measureText(s).width <= w) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > w) s = s.slice(0, -1);
  return s + '…';
}
const size = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(1)} GB`;
