// Mouse, trackpad, touch and keyboard. Each drag is a "gesture" with its own small state; the editor does the work.

import * as G from './geom.js';
import { snapMove, snapEdges } from './snap.js';
import { clone, newId } from './doc.js';
import { MIN } from './editor.js';
import * as T from './text.js';
import { SHAPES, SHAPE_KEYS } from './geom.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const TOOL_KEYS = { v: 'select', h: 'hand', n: 'sticky', t: 'text', s: 'shape', l: 'connector', p: 'pen', e: 'eraser', f: 'frame', m: 'mindmap' };
const CREATE = new Set(['sticky', 'text', 'shape', 'frame']);
const CURSOR = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

export class Input {
  constructor(ed, root, cv) {
    this.ed = ed; this.root = root; this.cv = cv;
    this.g = null;
    this.ptrs = new Map();
    this.space = false;
    this.off = [];
    this.pinch = null;
  }

  on(target, type, fn, opts) { target.addEventListener(type, fn, opts); this.off.push(() => target.removeEventListener(type, fn, opts)); }
  attach() {
    const cv = this.cv;
    this.on(cv, 'pointerdown', e => this.down(e));
    this.on(cv, 'pointermove', e => this.move(e));
    this.on(cv, 'pointerup', e => this.up(e));
    this.on(cv, 'pointercancel', e => this.up(e));
    this.on(cv, 'pointerleave', () => { this.ed.pointer = null; if (!this.g) { this.ed.v.hover = null; this.ed.invalidate(); } });
    this.on(cv, 'dblclick', e => this.dbl(e));
    this.on(cv, 'wheel', e => this.wheel(e), { passive: false });
    this.on(cv, 'contextmenu', e => { if (this.g || this.ed.v.tool !== 'select') e.preventDefault(); });
    this.on(cv, 'gesturestart', e => { e.preventDefault(); this.safari = { z: this.ed.cam.z }; });
    this.on(cv, 'gesturechange', e => { e.preventDefault(); if (this.safari) { const r = cv.getBoundingClientRect(); this.ed.cam.zoomAt(e.clientX - r.left, e.clientY - r.top, this.safari.z * e.scale / this.ed.cam.z); } });
    this.on(cv, 'gestureend', e => { e.preventDefault(); this.safari = null; });
    this.on(document, 'keydown', e => this.key(e));
    this.on(document, 'keyup', e => this.keyUp(e));
    this.on(window, 'blur', () => { this.space = false; this.updateCursor(); });
  }
  detach() { for (const f of this.off) f(); this.off = []; }

  pos(e) { const r = this.cv.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }
  world(e) { const { sx, sy } = this.pos(e); return this.ed.cam.toWorld(sx, sy); }

  // --- wheel and pinch ---------------------------------------------------------------------------

  wheel(e) {
    e.preventDefault();
    const ed = this.ed, { sx, sy } = this.pos(e);
    if (e.ctrlKey) {   // a trackpad pinch arrives as ctrl + wheel
      ed.cam.zoomAt(sx, sy, Math.exp(-clamp(e.deltaY, -60, 60) * 0.012));
    } else if (e.metaKey) {
      ed.cam.zoomAt(sx, sy, Math.exp(-clamp(e.deltaY, -60, 60) * 0.006));
    } else if (e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 100 && Number.isInteger(e.deltaY) && !e.shiftKey)) {
      ed.cam.zoomAt(sx, sy, e.deltaY < 0 ? 1.18 : 1 / 1.18);   // a notched mouse wheel zooms
    } else {
      ed.cam.panBy(-(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX), e.shiftKey && !e.deltaX ? 0 : -e.deltaY);
    }
    this.afterView();
  }
  afterView() {
    const ed = this.ed;
    if (ed.te && ed.te.open_) ed.te.place();
    ed.refreshQuick();
    if (this.ed.pointer === null) return;
  }

  // --- pointer ------------------------------------------------------------------------------------

  down(e) {
    const ed = this.ed, v = ed.v;
    this.root.focus({ preventScroll: true });
    if (ed.te && ed.te.open_) ed.te.close();
    try { this.cv.setPointerCapture(e.pointerId); } catch { /* a pointer that is already gone */ }
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (e.pointerType === 'touch' && this.ptrs.size === 2) return this.startPinch();
    const { sx, sy } = this.pos(e), w = ed.cam.toWorld(sx, sy);
    ed.pointer = w;
    ed.cam.stop();
    if (e.button === 1 || this.space || v.tool === 'hand') { this.g = { type: 'pan', x: e.clientX, y: e.clientY }; this.updateCursor(); return; }
    if (e.button !== 0) return;
    switch (v.tool) {
      case 'select': return this.downSelect(e, sx, sy, w);
      case 'pen': case 'highlighter': return ed.drawing.begin(e, w);
      case 'eraser': this.g = { type: 'erase' }; ed.doc.begin('Erase'); ed.drawing.erase(w); return;
      case 'connector': return this.startConnect(w);
      case 'mindmap': return;
      default: if (CREATE.has(v.tool)) { this.g = { type: 'create', kind: v.tool, x0: w.x, y0: w.y, sx, sy, dragged: false }; }
    }
  }

  downSelect(e, sx, sy, w) {
    const ed = this.ed, v = ed.v;
    const h = ed.handleAt(sx, sy);
    if (h) return this.startResize(h);
    const q = ed.quickAt(sx, sy);
    if (q) { this.g = { type: 'quick', src: [...v.sel][0], side: q, sx, sy, moved: false }; return; }
    const one = v.sel.size === 1 ? ed.doc.map.get([...v.sel][0]) : null;
    if (one && one.type === 'connector') {
      const end = this.connectorEnd(one, sx, sy);
      if (end) { ed.doc.begin('Move connector end'); this.g = { type: 'connEnd', id: one.id, which: end }; return; }
    }
    const fold = ed.mm && ed.mm.hitToggle(w.x, w.y);
    if (fold) { ed.mm.toggle(fold); return; }
    const hit = ed.pick(w.x, w.y);
    if (hit) {
      if (e.shiftKey) { ed.toggle(hit.id); return; }
      if (!v.sel.has(hit.id)) ed.select([hit.id]);
      this.startMove(e, w);
      return;
    }
    if (!e.shiftKey) ed.clear();
    this.g = { type: 'marquee', x0: w.x, y0: w.y, base: new Set(e.shiftKey ? v.sel : []) };
    v.marquee = { x0: w.x, y0: w.y, x1: w.x, y1: w.y };
  }

  connectorEnd(c, sx, sy) {
    const r = this.ed.r.route(c), a = this.ed.cam.toScreen(r.pts[0].x, r.pts[0].y), b = this.ed.cam.toScreen(r.pts[r.pts.length - 1].x, r.pts[r.pts.length - 1].y);
    if (Math.hypot(a.x - sx, a.y - sy) <= 10) return 'from';
    if (Math.hypot(b.x - sx, b.y - sy) <= 10) return 'to';
    return null;
  }

  move(e) {
    const ed = this.ed, v = ed.v, g = this.g;
    if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (this.pinch) return this.movePinch();
    const { sx, sy } = this.pos(e), w = ed.cam.toWorld(sx, sy);
    ed.pointer = w;
    if (!g) return this.hover(e, sx, sy, w);
    switch (g.type) {
      case 'pan': ed.cam.panBy(e.clientX - g.x, e.clientY - g.y); g.x = e.clientX; g.y = e.clientY; this.afterView(); break;
      case 'marquee': this.moveMarquee(e, w); break;
      case 'move': this.moveObjects(e, sx, sy, w); break;
      case 'resize': this.moveResize(e, w); break;
      case 'connEnd': this.moveConnEnd(w); break;
      case 'quick': this.moveQuick(sx, sy, w); break;
      case 'create': this.moveCreate(sx, sy, w); break;
      case 'connect': this.moveConnect(w); break;
      case 'draw': ed.drawing.move(e, w); break;
      case 'erase': ed.drawing.erase(w); break;
    }
  }

  up(e) {
    const ed = this.ed, g = this.g;
    this.ptrs.delete(e.pointerId);
    if (this.pinch) { if (this.ptrs.size < 2) this.pinch = null; return; }
    try { this.cv.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!g) return;
    this.g = null;
    const w = this.world(e);
    switch (g.type) {
      case 'marquee': ed.v.marquee = null; ed.invalidate(); break;
      case 'move': this.endMove(g); break;
      case 'resize': this.endResize(g); break;
      case 'connEnd': ed.v.snapHint = null; ed.doc.end(); break;
      case 'quick': this.endQuick(g, w); break;
      case 'create': this.endCreate(g, w); break;
      case 'connect': this.endConnect(g, w); break;
      case 'draw': ed.drawing.end(); break;
      case 'erase': ed.doc.end(); break;
    }
    this.updateCursor();
  }

  // --- hover and cursor ---------------------------------------------------------------------------

  hover(e, sx, sy, w) {
    const ed = this.ed, v = ed.v;
    if (v.tool === 'eraser') { v.eraser = { x: w.x, y: w.y, r: 10 / ed.cam.z }; ed.invalidate(); }
    if (v.tool !== 'select') return this.updateCursor();
    const q = ed.quickAt(sx, sy), h = ed.pick(w.x, w.y);
    const hid = h ? h.id : null;
    if (q !== v.quickHover || hid !== v.hover) { v.quickHover = q; v.hover = hid; ed.invalidate(); }
    this.updateCursor(sx, sy, h);
  }

  updateCursor(sx, sy, hit) {
    const ed = this.ed, v = ed.v;
    let c = 'default';
    if (this.g && this.g.type === 'pan' || this.space || v.tool === 'hand') c = this.g && this.g.type === 'pan' ? 'grabbing' : 'grab';
    else if (v.tool === 'pen' || v.tool === 'highlighter' || CREATE.has(v.tool) || v.tool === 'connector' || v.tool === 'mindmap') c = v.tool === 'text' ? 'text' : 'crosshair';
    else if (v.tool === 'eraser') c = 'none';
    else if (sx !== undefined) {
      const h = ed.handleAt(sx, sy);
      if (h) c = CURSOR[h]; else if (ed.quickAt(sx, sy)) c = 'pointer';
      else if (hit && v.sel.has(hit.id)) c = hit.locked ? 'not-allowed' : 'move';
      else if (hit) c = 'pointer';
    }
    this.cv.style.cursor = c;
  }

  // --- moving ---------------------------------------------------------------------------------------

  startMove(e, w) {
    const ed = this.ed;
    const ids = ed.moveSet(ed.v.sel);
    const origin = new Map();
    for (const id of ids) origin.set(id, clone(ed.doc.map.get(id)));
    // connectors that are selected but glued at both ends travel with their objects; nothing to do
    this.g = { type: 'move', wx0: w.x, wy0: w.y, origin, ids, started: false, alt: e.altKey, sx: e.clientX, sy: e.clientY, bb0: ed.selectionBox() };
  }

  moveObjects(e, sx, sy, w) {
    const ed = this.ed, g = this.g;
    if (!g.started) {
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 3) return;
      g.started = true;
      if (g.alt) {   // option-drag leaves a copy behind and drags the copy
        const p = ed.payload();
        if (p) { ed.place(p, null, { quiet: true }); const dup = ed.moveSet(ed.v.sel); g.origin = new Map([...dup].map(id => [id, clone(ed.doc.map.get(id))])); g.ids = dup; g.bb0 = ed.selectionBox(); }
      }
      ed.doc.begin(g.alt ? 'Duplicate' : 'Move');
    }
    let dx = w.x - g.wx0, dy = w.y - g.wy0;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    ed.v.guides = [];
    if (g.bb0 && !(e.metaKey || e.ctrlKey)) {
      const s = snapMove(ed, { x: g.bb0.x + dx, y: g.bb0.y + dy, w: g.bb0.w, h: g.bb0.h }, g.ids);
      dx += s.dx; dy += s.dy; ed.v.guides = s.guides;
    }
    ed.doc.batch(() => {
      for (const [id, o0] of g.origin) {
        if (o0.type === 'connector') {
          const f = {};
          if (o0.from.id === undefined) f.from = { x: o0.from.x + dx, y: o0.from.y + dy };
          if (o0.to.id === undefined) f.to = { x: o0.to.x + dx, y: o0.to.y + dy };
          if (f.from || f.to) ed.doc.patch(id, f);
        } else ed.doc.patch(id, { x: o0.x + dx, y: o0.y + dy });
      }
    });
    ed.refreshQuick();
    ed.emit('moving');
  }

  endMove(g) {
    const ed = this.ed;
    ed.v.guides = [];
    if (g.started) {
      ed.doc.batch(() => { for (const id of g.ids) { const o = ed.doc.map.get(id); if (o && !['frame', 'connector'].includes(o.type) && !(o.parent && g.ids.has(o.parent))) ed.adopt(o); } });
      if (ed.mm) ed.mm.afterMove(g.ids);
      ed.doc.end();
    }
    ed.refreshQuick(); ed.invalidate();
  }

  // --- resizing -------------------------------------------------------------------------------------

  startResize(h) {
    const ed = this.ed, bb = ed.selectionBox();
    const origin = new Map();
    for (const o of ed.selected()) origin.set(o.id, clone(o));
    ed.doc.begin('Resize');
    this.g = { type: 'resize', h, bb0: bb, origin };
  }

  moveResize(e, w) {
    const ed = this.ed, g = this.g, { bb0 } = g, h = g.h;
    let x0 = bb0.x, y0 = bb0.y, x1 = bb0.x + bb0.w, y1 = bb0.y + bb0.h;
    const edges = { l: h.includes('w'), r: h.includes('e'), t: h.includes('n'), b: h.includes('s') };
    if (edges.r) x1 = w.x; if (edges.l) x0 = w.x; if (edges.b) y1 = w.y; if (edges.t) y0 = w.y;
    ed.v.guides = [];
    if (!(e.metaKey || e.ctrlKey)) {
      const s = snapEdges(ed, { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }, edges, new Set(g.origin.keys()));
      if (edges.r) x1 += s.dx; if (edges.l) x0 += s.dx; if (edges.b) y1 += s.dy; if (edges.t) y0 += s.dy;
      ed.v.guides = s.guides;
    }
    const first = [...g.origin.values()][0];
    const keep = g.origin.size === 1 && ['image', 'draw'].includes(first.type) ? !e.shiftKey : e.shiftKey;
    const corner = h.length === 2;
    let nw = Math.max(8, Math.abs(x1 - x0)), nh = Math.max(8, Math.abs(y1 - y0));
    if (keep && corner) {
      const k = Math.max(nw / bb0.w, nh / bb0.h);   // follow whichever way you pulled further
      nw = bb0.w * k; nh = bb0.h * k;
      if (edges.l) x0 = x1 - nw; else x1 = x0 + nw;
      if (edges.t) y0 = y1 - nh; else y1 = y0 + nh;
    }
    const nx = edges.l ? x1 - nw : x0, ny = edges.t ? y1 - nh : y0;
    const sx = nw / bb0.w, sy = nh / bb0.h;
    ed.doc.batch(() => {
      for (const [id, o0] of g.origin) {
        const min = MIN[o0.type] || 8;
        const f = { x: nx + (o0.x - bb0.x) * sx, y: ny + (o0.y - bb0.y) * sy, w: Math.max(min, o0.w * sx), h: Math.max(min, o0.h * sy) };
        if (o0.type === 'text') { f.h = edges.t || edges.b ? nh : o0.h; if (edges.t || edges.b) f.minh = nh; }   // pulled taller or shorter: the box keeps that height
        if (o0.type === 'draw') { f.points = o0.points.map((v, i) => (i % 3 === 0 ? v * sx : i % 3 === 1 ? v * sy : v)); f.w = o0.w * sx; f.h = o0.h * sy; f.x = nx + (o0.x - bb0.x) * sx; f.y = ny + (o0.y - bb0.y) * sy; }
        ed.doc.patch(id, f);
        if (o0.type === 'text') ed.doc.patch(id, { h: T.hug(ed.doc.map.get(id)) });
        if (o0.type === 'node' && ed.mm) ed.mm.resize(id);
      }
    });
    ed.refreshQuick();
    ed.emit('moving');
  }

  endResize() { this.ed.v.guides = []; this.ed.doc.end(); this.ed.invalidate(); }

  // --- connector ends, quick-create ---------------------------------------------------------------

  /** A connector end at a world point: glued to the object there (on its nearest side), or a free point. */
  endAt(w, skip = new Set()) {
    const ed = this.ed;
    const o = ed.pick(w.x, w.y, { skipConnectors: true, only: x => !skip.has(x.id) && !['draw', 'frame'].includes(x.type) });
    if (o) { const ns = G.nearestSide(o, w.x, w.y); return { end: { id: o.id, side: ns.side, t: ns.t }, obj: o }; }
    return { end: { x: w.x, y: w.y }, obj: null };
  }

  moveConnEnd(w) {
    const ed = this.ed, g = this.g, c = ed.doc.map.get(g.id);
    if (!c) return;
    const other = (g.which === 'from' ? c.to : c.from).id;
    const { end, obj } = this.endAt(w, new Set(other ? [] : []));
    ed.v.snapHint = obj ? (() => { const p = G.sidePoint(obj, end.side, end.t); return { x: p.x, y: p.y }; })() : null;
    ed.doc.patch(g.id, { [g.which]: end });
  }

  moveQuick(sx, sy, w) {
    const ed = this.ed, g = this.g;
    if (!g.moved && Math.hypot(sx - g.sx, sy - g.sy) < 5) return;
    g.moved = true;
    const src = ed.doc.map.get(g.src);
    if (!src) return;
    const { end, obj } = this.endAt(w, new Set([src.id]));
    ed.v.snapHint = obj ? (() => { const p = G.sidePoint(obj, end.side, end.t); return { x: p.x, y: p.y }; })() : null;
    ed.v.connDraft = { c: ed.defaults('connector', { from: { id: src.id, side: g.side, t: 0.5 }, to: end }) };
    ed.invalidate();
  }

  endQuick(g, w) {
    const ed = this.ed;
    ed.v.connDraft = null; ed.v.snapHint = null;
    if (!g.moved) { ed.spawn(g.src, g.side); return; }
    const src = ed.doc.map.get(g.src);
    if (!src) return;
    const { end, obj } = this.endAt(w, new Set([src.id]));
    if (obj) { ed.doc.tx('Connect', () => ed.doc.add(ed.defaults('connector', { from: { id: src.id, side: g.side, t: 0.5 }, to: end }))); return; }
    // dropped on empty canvas: make the copy right there, connected
    ed.doc.tx('Add connected', () => {
      const n = ed.twin(src);
      n.x = w.x - n.w / 2; n.y = w.y - n.h / 2;
      ed.doc.add(n); ed.adopt(n);
      const opposite = { t: 'b', r: 'l', b: 't', l: 'r' }[g.side];
      const near = G.facing(n, src.x + src.w / 2, src.y + src.h / 2);
      ed.doc.add(ed.defaults('connector', { from: { id: src.id, side: g.side, t: 0.5 }, to: { id: n.id, side: near || opposite, t: 0.5 } }));
      ed.select([n.id]);
      queueMicrotask(() => ed.edit(n.id, { fresh: false }));
    });
  }

  // --- creating by tool -----------------------------------------------------------------------------

  moveCreate(sx, sy, w) {
    const g = this.g, ed = this.ed;
    if (!g.dragged && Math.hypot(sx - g.sx, sy - g.sy) < 6) return;
    g.dragged = true;
    ed.v.marquee = { x0: g.x0, y0: g.y0, x1: w.x, y1: w.y };
    ed.invalidate();
  }

  endCreate(g, w) {
    const ed = this.ed;
    ed.v.marquee = null;
    let props;
    if (g.dragged) {
      const x = Math.min(g.x0, w.x), y = Math.min(g.y0, w.y), ww = Math.abs(w.x - g.x0), hh = Math.abs(w.y - g.y0);
      const min = MIN[g.kind] || 24;
      props = { x, y, w: Math.max(min, ww), h: Math.max(min, hh) };
      if (g.kind === 'text') props.h = 36;
    } else if (g.kind === 'text') props = { x: g.x0 - 4, y: g.y0 - 18 };
    else props = {};
    if (!g.dragged && g.kind !== 'text') { const d = ed.defaults(g.kind); props = { x: g.x0 - d.w / 2, y: g.y0 - d.h / 2 }; }
    const shapeKind = g.kind === 'shape' ? ed.pref.shape : null;
    const o = ed.add(g.kind, props, { edit: true });
    if (g.kind === 'frame') ed.doc.tx('Frame contents', () => { for (const c of ed.within(o)) if (c.id !== o.id && c.type !== 'frame' && c.type !== 'connector' && G.inside(ed.boxOf(c), o)) ed.doc.patch(c.id, { parent: o.id }); });
    if (shapeKind === 'cylinder' || shapeKind === 'arrow') ed.doc.patch(o.id, { h: Math.min(o.h, 120) });
    ed.setTool('select');
    if (o && ed.te) queueMicrotask(() => { if (!ed.v.editing && !ed.destroyed) ed.edit(o.id, { fresh: g.kind === 'text', selectAll: g.kind === 'frame' }); });
  }

  startConnect(w) {
    const ed = this.ed;
    const { end } = this.endAt(w);
    this.g = { type: 'connect', from: end };
    ed.v.connDraft = { c: ed.defaults('connector', { from: end, to: { x: w.x, y: w.y } }) };
  }
  moveConnect(w) {
    const ed = this.ed, g = this.g;
    const skip = new Set(g.from.id ? [g.from.id] : []);
    const { end, obj } = this.endAt(w, skip);
    ed.v.snapHint = obj ? (() => { const p = G.sidePoint(obj, end.side, end.t); return { x: p.x, y: p.y }; })() : null;
    ed.v.connDraft = { c: ed.defaults('connector', { from: g.from, to: end }) };
    ed.invalidate();
  }
  endConnect(g, w) {
    const ed = this.ed;
    ed.v.connDraft = null; ed.v.snapHint = null;
    const skip = new Set(g.from.id ? [g.from.id] : []);
    const { end } = this.endAt(w, skip);
    const a = g.from;
    const far = a.id ? true : Math.hypot((a.x || 0) - (end.x ?? 0), (a.y || 0) - (end.y ?? 0)) > 12;
    if (far && !(end.id && end.id === a.id)) {
      const c = ed.doc.tx('Connector', () => ed.doc.add(ed.defaults('connector', { from: a, to: end })));
      ed.select([c.id]);
    }
    ed.invalidate();
  }

  moveMarquee(e, w) {
    const ed = this.ed, g = this.g, m = ed.v.marquee;
    m.x1 = w.x; m.y1 = w.y;
    const rect = { x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1), w: Math.abs(m.x1 - m.x0), h: Math.abs(m.y1 - m.y0) };
    const ids = ed.within(rect).map(o => o.id);
    ed.select([...g.base, ...ids]);
    ed.invalidate();
  }

  // --- pinch (touch) --------------------------------------------------------------------------------

  startPinch() {
    const [a, b] = [...this.ptrs.values()];
    this.g = null;
    this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
  movePinch() {
    const [a, b] = [...this.ptrs.values()], p = this.pinch;
    if (!b) return;
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const r = this.cv.getBoundingClientRect();
    this.ed.cam.panBy(mx - p.mx, my - p.my);
    this.ed.cam.zoomAt(mx - r.left, my - r.top, d / (p.d || d));
    p.d = d; p.mx = mx; p.my = my;
    this.afterView();
  }

  // --- double click ---------------------------------------------------------------------------------

  dbl(e) {
    const ed = this.ed, w = this.world(e), v = ed.v;
    if (v.tool !== 'select') return;
    const o = ed.pick(w.x, w.y);
    if (!o) {
      if (ed.mm && false) return;
      ed.setTool('select');
      ed.add('sticky', { x: w.x - 93, y: w.y - 93 }, { edit: true });
      return;
    }
    if (o.group && v.sel.size > 1) { ed.select([o.id]); return; }
    if (o.locked) return;
    switch (o.type) {
      case 'sticky': case 'text': case 'shape': case 'node': case 'frame': case 'connector': ed.edit(o.id, { selectAll: false }); break;
      case 'link': window.open(o.url, '_blank', 'noopener'); break;
      case 'file': ed.openFile && ed.openFile(o); break;
      case 'image': ed.cam.flyTo(ed.cam.framing(o, 80, 3)); break;
    }
  }

  // --- keyboard -------------------------------------------------------------------------------------

  typing(e) {
    const t = e.target;
    return t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
  }

  keyUp(e) {
    if (e.code === 'Space' && this.space) { this.space = false; this.updateCursor(); }
  }

  key(e) {
    const ed = this.ed, v = ed.v;
    if (ed.destroyed || (ed.te && ed.te.open_)) return;
    if (this.typing(e) || document.querySelector('#layer > *')) return;
    if (ed.ui && ed.ui.captured && ed.ui.captured(e)) return;
    const mod = e.metaKey || e.ctrlKey, k = e.key, lk = k.toLowerCase();
    if (e.code === 'Space' && !mod) { e.preventDefault(); if (!this.space) { this.space = true; this.updateCursor(); } return; }

    if (mod) {
      switch (lk) {
        case 'z': e.preventDefault(); return e.shiftKey ? ed.redo() : ed.undo();
        case 'y': e.preventDefault(); return ed.redo();
        case 'a': e.preventDefault(); return ed.selectAll();
        case 'c': e.preventDefault(); return ed.copy();
        case 'x': e.preventDefault(); return ed.cut();
        case 'v': return;   // the paste event does the work (it carries images and files)
        case 'd': e.preventDefault(); return ed.duplicate();
        case 'g': e.preventDefault(); return e.shiftKey ? ed.ungroup() : ed.group();
        case 'l': if (e.shiftKey) { e.preventDefault(); return ed.lock(); } return;
        case 'f': e.preventDefault(); return ed.ui && ed.ui.openSearch();
        case 's': e.preventDefault(); return ed.sync && ed.sync.flush(true);
        case ']': e.preventDefault(); return ed.arrange(e.shiftKey ? 'front' : 'forward');
        case '[': e.preventDefault(); return ed.arrange(e.shiftKey ? 'back' : 'backward');
        case '=': case '+': e.preventDefault(); return ed.zoomBy(1.25);
        case '-': e.preventDefault(); return ed.zoomBy(0.8);
      }
      return;
    }
    if (e.altKey && k.startsWith('Arrow') && v.sel.size === 1) {
      e.preventDefault();
      return ed.spawn([...v.sel][0], { ArrowUp: 't', ArrowRight: 'r', ArrowDown: 'b', ArrowLeft: 'l' }[k]);
    }
    if (e.shiftKey && !e.altKey) {
      if (k === '!' || e.code === 'Digit1') { e.preventDefault(); return ed.fit(); }
      if (k === '@' || e.code === 'Digit2') { e.preventDefault(); return ed.fitSelection(); }
      if (k === ')' || e.code === 'Digit0') { e.preventDefault(); return ed.zoomTo(1); }
      if (k === 'S' && v.sel.size) { e.preventDefault(); return ed.cycleShape(); }
    }
    switch (k) {
      case 'Escape':
        if (this.g) { this.cancel(); return; }
        if (v.tool !== 'select') { ed.setTool('select'); return; }
        ed.ui && ed.ui.escape();
        return ed.clear();
      case 'Delete': case 'Backspace': if (v.sel.size) { e.preventDefault(); ed.remove(); } return;
      case 'Enter':
        if (v.tool !== 'select' && v.tool !== 'hand' && CREATE.has(v.tool) && ed.pointer) { e.preventDefault(); return this.createAtPointer(); }
        if (v.sel.size === 1) {
          const o = ed.selected()[0];
          if (o.type === 'node' && ed.mm) { e.preventDefault(); return ed.mm.sibling(o.id, { edit: true }); }
          if (['sticky', 'text', 'shape', 'frame', 'connector'].includes(o.type)) { e.preventDefault(); return ed.edit(o.id, { selectAll: false }); }
          if (o.type === 'link') window.open(o.url, '_blank', 'noopener');
          if (o.type === 'file' && ed.openFile) ed.openFile(o);
        }
        return;
      case 'Tab':
        if (v.sel.size === 1) {
          e.preventDefault();
          const o = ed.selected()[0];
          if (o.type === 'node' && ed.mm) return ed.mm.child(o.id, { edit: true });
          return ed.spawn(o.id, e.shiftKey ? 'b' : 'r');
        }
        return;
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        if (!v.sel.size) return;
        e.preventDefault();
        const s = e.shiftKey ? 50 : 10;
        return ed.nudge(k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0);
      }
      case '+': case '=': return ed.zoomBy(1.25);
      case '-': case '_': return ed.zoomBy(0.8);
      case '?': return ed.ui && ed.ui.toggleHelp();
      case '/': if (ed.ui) { e.preventDefault(); ed.ui.openSearch(); } return;
    }
    if (v.tool === 'shape' && !e.altKey) {
      const n = Number(k);
      const kind = n >= 1 && n <= SHAPES.length ? SHAPES[n - 1] : SHAPES.find(s => SHAPE_KEYS[s] === lk);
      if (kind) { e.preventDefault(); return ed.savePref({ shape: kind }), ed.emit('tool'); }
    }
    if (lk === 'c' && ed.mm && !e.altKey) { const nodes = ed.selected().filter(o => o.type === 'node'); if (nodes.length) { e.preventDefault(); for (const n of nodes) ed.mm.toggle(n.id); return; } }
    if (TOOL_KEYS[lk] && !e.altKey) {
      e.preventDefault();
      let t = TOOL_KEYS[lk];
      if (t === 'pen' && v.tool === 'pen') t = 'highlighter';
      else if (t === 'shape' && v.tool === 'shape') { return ed.cycleShape(true); }
      if (t === 'frame' && v.sel.size && !v.sel.has('x')) { const f = ed.frameSelection(); if (f) return; }
      if (t === 'mindmap') { return ed.mm && ed.mm.start(); }
      ed.setTool(t);
    }
    if (lk === 'i' && !mod) { e.preventDefault(); ed.ui && ed.ui.pickFiles(); }
  }

  cancel() {
    const ed = this.ed, g = this.g;
    this.g = null;
    ed.v.marquee = null; ed.v.connDraft = null; ed.v.guides = []; ed.v.snapHint = null; ed.v.stroke = null;
    if (g && ['move', 'resize', 'connEnd'].includes(g.type)) { ed.doc.end(); ed.undo(); }
    else if (g && g.type === 'erase') ed.doc.end();
    ed.invalidate();
  }

  createAtPointer() {
    const ed = this.ed, p = ed.pointer, kind = ed.v.tool;
    const d = ed.defaults(kind);
    const o = ed.add(kind, kind === 'text' ? { x: p.x - 4, y: p.y - 18 } : { x: p.x - d.w / 2, y: p.y - d.h / 2 }, { edit: true });
    ed.setTool('select');
    return o;
  }
}
