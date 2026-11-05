// Freehand: a pen and a highlighter that smooth what your hand does, follow a stylus's pressure when the browser reports
// it, and an eraser that removes whole strokes. A stroke is an ordinary object: select it, move it, resize it.

import { newId } from './doc.js';
import { HIGHLIGHTER, INK } from './palette.js';

export const PEN_WIDTHS = [2, 4, 8, 14];
export const HL_WIDTHS = [14, 24, 40];
const SMOOTH = 0.5;      // 0 = follow the raw input, 1 = never move

export class Drawing {
  constructor(ed) { this.ed = ed; this.live = null; this.raw = null; }

  settings(tool) {
    const p = this.ed.pref;
    return tool === 'highlighter'
      ? { color: p.hlColor || HIGHLIGHTER, width: p.hlWidth || 24 }
      : { color: p.penColor || INK, width: p.penWidth || 4 };
  }

  begin(e, w) {
    const ed = this.ed, tool = ed.v.tool;
    const s = this.settings(tool);
    const p = this.pressure(e);
    this.live = { points: [w.x, w.y, p], tool, color: s.color, width: s.width };
    this.raw = { x: w.x, y: w.y };
    ed.v.stroke = this.live;
    ed.input.g = { type: 'draw' };
    ed.invalidate();
  }

  pressure(e) {
    // Only a pen reports real pressure; a mouse says 0.5 (down) and the stroke stays an even width.
    return e.pointerType === 'pen' && e.pressure > 0 ? Math.round(e.pressure * 100) / 100 : 0.5;
  }

  move(e, w) {
    const ed = this.ed, s = this.live;
    if (!s) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const min = 1.2 / ed.cam.z;
    for (const ev of events.length ? events : [e]) {
      const r = ed.input.world(ev);
      const px = this.raw.x + (r.x - this.raw.x) * (1 - SMOOTH), py = this.raw.y + (r.y - this.raw.y) * (1 - SMOOTH);
      this.raw = { x: px, y: py };
      const n = s.points.length;
      if (Math.hypot(px - s.points[n - 3], py - s.points[n - 2]) < min) continue;
      s.points.push(px, py, this.pressure(ev));
    }
    ed.invalidate();
  }

  end() {
    const ed = this.ed, s = this.live;
    this.live = null; this.raw = null;
    ed.v.stroke = null;
    if (!s) return;
    const pts = s.points, n = pts.length / 3;
    // finish at the true last position so a short stroke does not stop short
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 3) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]); }
    const rel = new Array(pts.length);
    for (let i = 0; i < pts.length; i += 3) { rel[i] = round(pts[i] - x0); rel[i + 1] = round(pts[i + 1] - y0); rel[i + 2] = pts[i + 2]; }
    ed.doc.tx('Draw', () => ed.doc.add({ id: newId(), type: 'draw', tool: s.tool, color: s.color, width: s.width, x: round(x0), y: round(y0), w: Math.max(1, round(x1 - x0)), h: Math.max(1, round(y1 - y0)), points: rel }));
    ed.invalidate();
  }

  /** Remove every stroke the eraser touches (inside a transaction opened by the caller). */
  erase(w) {
    const ed = this.ed, r = 10 / ed.cam.z;
    ed.v.eraser = { x: w.x, y: w.y, r };
    for (const o of ed.doc.list()) {
      if (o.type !== 'draw' || o.locked) continue;
      if (w.x < o.x - r - o.width || w.x > o.x + o.w + r + o.width || w.y < o.y - r - o.width || w.y > o.y + o.h + r + o.width) continue;
      if (ed.nearStroke(o, w.x, w.y, r)) { ed.doc.remove(o.id); ed.v.sel.delete(o.id); }
    }
    ed.invalidate();
  }
}
const round = v => Math.round(v * 10) / 10;
