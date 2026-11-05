// The minimap: the whole board as flat blocks, with a frame showing where you are. Click or drag to go somewhere.

import * as G from './geom.js';
import { stickyHex } from './palette.js';

const W = 208, H = 136;

export class Minimap {
  constructor(ed, host) {
    this.ed = ed;
    this.el = document.createElement('div');
    this.el.className = 'bd-mini';
    this.cv = document.createElement('canvas');
    this.el.appendChild(this.cv);
    host.appendChild(this.el);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cv.width = W * this.dpr; this.cv.height = H * this.dpr;
    this.cv.style.width = W + 'px'; this.cv.style.height = H + 'px';
    this.ctx = this.cv.getContext('2d');
    this.key = ''; this.map = null; this.drag = false;
    this.cv.addEventListener('pointerdown', e => { this.cv.setPointerCapture(e.pointerId); this.drag = true; this.go(e); });
    this.cv.addEventListener('pointermove', e => { if (this.drag) this.go(e); });
    this.cv.addEventListener('pointerup', () => { this.drag = false; });
    this.hidden = false;
  }

  show(on) { this.hidden = !on; this.el.hidden = !on; if (on) this.key = ''; }

  /** world <-> minimap pixels for the current content + view */
  frame() {
    const ed = this.ed, cam = ed.cam;
    const content = ed.bounds() || { x: 0, y: 0, w: 1, h: 1 };
    const vis = cam.visible();
    const all = G.union([content, vis]);
    const pad = Math.max(all.w, all.h) * 0.06;
    const b = G.grow(all, pad);
    const s = Math.min(W / b.w, H / b.h);
    return { b, s, ox: (W - b.w * s) / 2, oy: (H - b.h * s) / 2 };
  }

  go(e) {
    const r = this.cv.getBoundingClientRect(), f = this.frame();
    const wx = (e.clientX - r.left - f.ox) / f.s + f.b.x, wy = (e.clientY - r.top - f.oy) / f.s + f.b.y;
    const cam = this.ed.cam;
    cam.stop(); cam.x = wx - cam.w / 2 / cam.z; cam.y = wy - cam.h / 2 / cam.z; cam.onChange();
  }

  draw() {
    if (this.hidden) return;
    const ed = this.ed, cam = ed.cam, ctx = this.ctx, t = ed.r.theme, dpr = this.dpr;
    const key = `${ed.doc.geoVer}|${cam.x | 0}|${cam.y | 0}|${cam.z.toFixed(3)}|${cam.w}|${cam.h}|${ed.v.sel.size}`;
    if (key === this.key) return;
    this.key = key;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = t.surface; ctx.globalAlpha = 0.92; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    const f = this.frame();
    const X = x => (x - f.b.x) * f.s + f.ox, Y = y => (y - f.b.y) * f.s + f.oy;
    for (const o of ed.doc.list()) {
      if (ed.v.hidden.has(o.id) || o.type === 'connector') continue;
      const w = Math.max(1.5, o.w * f.s), h = Math.max(1.5, o.h * f.s);
      ctx.fillStyle = o.type === 'sticky' ? stickyHex(o.color) : o.type === 'draw' ? o.color : o.type === 'frame' ? 'transparent' : o.fill || t.muted;
      if (o.type === 'frame') { ctx.strokeStyle = t.line; ctx.lineWidth = 1; ctx.strokeRect(X(o.x), Y(o.y), w, h); continue; }
      ctx.fillRect(X(o.x), Y(o.y), w, h);
    }
    const v = cam.visible();
    ctx.strokeStyle = t.action; ctx.lineWidth = 1.5; ctx.fillStyle = t.action; ctx.globalAlpha = 0.1;
    ctx.fillRect(X(v.x), Y(v.y), v.w * f.s, v.h * f.s); ctx.globalAlpha = 1;
    ctx.strokeRect(X(v.x), Y(v.y), v.w * f.s, v.h * f.s);
  }
}
