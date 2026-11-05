// The editor: the board's state (document, camera, selection, tool) and everything you can do to it. Input, text editing,
// saving and the chrome are in their own files and call into this.

import { Doc, clone, cache, newId } from './doc.js';
import { Camera } from './camera.js';
import { Renderer } from './render.js';
import * as G from './geom.js';
import * as C from './connectors.js';
import * as T from './text.js';
import { SHAPES } from './geom.js';
import { STICKY_DEFAULT, INK, PAPER, stickyHex } from './palette.js';

const GAP = 56;                         // space left between an object and the copy quick-create makes
export const MIN = { sticky: 60, shape: 24, text: 40, frame: 120, image: 24, file: 120, link: 160, node: 60 };

export class Editor {
  constructor(host, data, ctx) {
    this.host = host; this.ctx = ctx;
    this.doc = new Doc(data);
    this.doc.settle();
    this.cam = new Camera(data.view);
    this.cam.onChange = () => this.invalidate();     // a pan or zoom has to be drawn (Sync wraps this to save the view)
    this.v = { sel: new Set(), hover: null, tool: 'select', editing: null, guides: [], marquee: null, hidden: new Set(), hl: new Set(),
      stroke: null, connDraft: null, eraser: null, quick: null, quickHover: null, snapHint: null };
    this.pref = loadPref();
    this.listeners = new Set();
    this.pointer = null;                // last pointer position in world coordinates
    this.destroyed = false;
    this.mm = null;                     // mind maps (set by mindmap.js)
    this.assetBase = `/api/board/${data.id}/assets/`;
    this.doc.on(ev => this.onDoc(ev));
  }

  // --- wiring ------------------------------------------------------------------------------------

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what) { for (const fn of this.listeners) fn(what); }
  edit(id, opts) { if (this.te) this.te.open(id, opts); }
  stickyFill(o) { return stickyHex(o.color); }
  assetUrl(src) { return this.assetBase + encodeURIComponent(src); }
  invalidate() { this.r && this.r.invalidate(); }

  onDoc(ev) {
    // Forget selected ids that are gone.
    if (ev.type === 'remove' || ev.type === 'undo' || ev.type === 'redo' || ev.type === 'remote') {
      let changed = false;
      for (const id of this.v.sel) if (!this.doc.map.has(id)) { this.v.sel.delete(id); changed = true; }
      if (changed) this.emit('selection');
    }
    if (this.v.hover && !this.doc.map.has(this.v.hover)) this.v.hover = null;
    this.invalidate();
    this.emit('doc');
  }

  // --- geometry ----------------------------------------------------------------------------------

  boxOf(o) {
    if (o.type === 'connector') { this.r.routeBox(o); return cache(o).rt.bb; }
    return o;
  }
  /** Everything's box, or the given objects'. */
  bounds(objs) { const rs = (objs || this.doc.list()).filter(o => !this.v.hidden.has(o.id)).map(o => this.boxOf(o)); return G.union(rs); }
  viewCenter() { return this.cam.toWorld(this.cam.w / 2, this.cam.h / 2); }
  at() { return this.pointer || this.viewCenter(); }

  /** The topmost object at a world point, or null. */
  pick(x, y, { skipConnectors = false, only = null } = {}) {
    const z = this.cam.z, m = 4 / z;
    const order = this.doc.order;
    for (let i = order.length - 1; i >= 0; i--) {
      const o = this.doc.map.get(order[i]);
      if (this.v.hidden.has(o.id) || (only && !only(o))) continue;
      if (o.type === 'connector') {
        if (skipConnectors) continue;
        this.r.routeBox(o);
        if (C.near(cache(o).rt.r, x, y) <= Math.max(6 / z, (o.width || 2) / 2 + 3 / z)) return o;
        if (o.label) { const mp = C.midpoint(cache(o).rt.r); if (Math.abs(x - mp.x) < 40 && Math.abs(y - mp.y) < 12) return o; }
        continue;
      }
      if (!G.hit(o, x, y, m)) continue;
      if (o.type === 'draw') { if (this.nearStroke(o, x, y, m)) return o; continue; }
      if (o.type === 'frame') {
        const edge = 10 / z, title = Math.max(14, 13 / z) * 1.8;
        const onTitle = x >= o.x && x <= o.x + o.w && y >= o.y - title && y <= o.y;
        const onBorder = x < o.x + edge || x > o.x + o.w - edge || y > o.y + o.h - edge || y < o.y + edge;
        if (onTitle || onBorder || this.v.sel.has(o.id)) return o;
        continue;
      }
      if (o.type === 'shape' && o.shape !== 'rect' && !G.inShape(o.shape, o, x, y)) continue;
      return o;
    }
    // frame titles sit above the frame, outside its box
    for (let i = order.length - 1; i >= 0; i--) {
      const o = this.doc.map.get(order[i]);
      if (o.type !== 'frame') continue;
      const title = Math.max(14, 13 / z) * 1.8;
      if (x >= o.x && x <= o.x + o.w && y >= o.y - title && y <= o.y) return o;
    }
    return null;
  }
  nearStroke(o, x, y, m) {
    const p = o.points, r = o.width / 2 + m;
    for (let i = 0; i < p.length; i += 3) if (Math.abs(o.x + p[i] - x) <= r + 8 && Math.abs(o.y + p[i + 1] - y) <= r + 8) {
      if (i + 3 < p.length) { if (G.segDist(x, y, { x: o.x + p[i], y: o.y + p[i + 1] }, { x: o.x + p[i + 3], y: o.y + p[i + 4] }) <= r) return true; }
      else if (Math.hypot(o.x + p[i] - x, o.y + p[i + 1] - y) <= r) return true;
    }
    return false;
  }
  /** Objects whose box meets a world rectangle. Frames count only when wholly inside. */
  within(rect) {
    const out = [];
    for (const o of this.doc.list()) {
      if (this.v.hidden.has(o.id) || o.locked) continue;
      const b = this.boxOf(o);
      if (o.type === 'frame' ? G.inside(b, rect) : G.touches(b, rect)) out.push(o);
    }
    return out;
  }
  frameAt(x, y, skip = new Set()) {
    const order = this.doc.order;
    for (let i = order.length - 1; i >= 0; i--) {
      const o = this.doc.map.get(order[i]);
      if (o.type === 'frame' && !skip.has(o.id) && G.hit(o, x, y)) return o;
    }
    return null;
  }
  childrenOf(frameId) { return this.doc.list().filter(o => o.parent === frameId); }

  // --- selection ---------------------------------------------------------------------------------

  selected() { return [...this.v.sel].map(id => this.doc.map.get(id)).filter(Boolean); }
  select(ids, { add = false, quiet = false } = {}) {
    const next = add ? new Set(this.v.sel) : new Set();
    for (const id of ids) {
      const o = this.doc.map.get(id);
      if (!o || this.v.hidden.has(id)) continue;
      next.add(id);
      if (o.group) for (const m of this.doc.list()) if (m.group === o.group) next.add(m.id);
    }
    this.v.sel = next;
    this.refreshQuick();
    this.invalidate();
    if (!quiet) this.emit('selection');
  }
  toggle(id) {
    const o = this.doc.map.get(id);
    if (!o) return;
    const members = o.group ? this.doc.list().filter(m => m.group === o.group).map(m => m.id) : [id];
    const next = new Set(this.v.sel);
    const on = !next.has(id);
    for (const m of members) on ? next.add(m) : next.delete(m);
    this.v.sel = next; this.refreshQuick(); this.invalidate(); this.emit('selection');
  }
  clear() { if (this.v.sel.size) { this.v.sel = new Set(); this.refreshQuick(); this.invalidate(); this.emit('selection'); } }
  selectAll() { this.select(this.doc.order.filter(i => !this.doc.map.get(i).locked)); }
  selectionBox() {
    const objs = this.selected().filter(o => o.type !== 'connector');
    return objs.length ? G.union(objs.map(o => this.boxOf(o))) : null;
  }
  canResize() {
    const objs = this.selected();
    return objs.length > 0 && objs.every(o => o.type !== 'connector' && !o.locked);
  }
  /** Resize handles around a box: corners, and the middle of each side. A lone mind-map node only resizes sideways. */
  handles(bb) {
    const sel = this.selected();
    const sideways = sel.length === 1 && sel[0].type === 'node';
    const xs = [bb.x, bb.x + bb.w / 2, bb.x + bb.w], ys = [bb.y, bb.y + bb.h / 2, bb.y + bb.h];
    const names = [['nw', 'n', 'ne'], ['w', null, 'e'], ['sw', 's', 'se']];
    const out = [];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const id = names[j][i];
      if (!id || (sideways && id !== 'e' && id !== 'w')) continue;
      out.push({ id, x: xs[i], y: ys[j] });
    }
    return out;
  }
  handleAt(sx, sy) {
    const bb = this.selectionBox();
    if (!bb || !this.canResize()) return null;
    for (const h of this.handles(bb)) {
      const p = this.cam.toScreen(h.x, h.y);
      if (Math.abs(p.x - sx) <= 8 && Math.abs(p.y - sy) <= 8) return h.id;
    }
    return null;
  }

  /** The little + handles around a lone selected object. */
  refreshQuick() {
    const sel = this.selected();
    const one = sel.length === 1 ? sel[0] : null;
    if (!one || !['sticky', 'text', 'shape', 'node'].includes(one.type) || one.locked) { this.v.quick = null; return; }
    this.v.quick = ['t', 'r', 'b', 'l'].map(side => { const p = G.sidePoint(one, side); return { side, x: p.x + p.nx * 0, y: p.y + p.ny * 0, nx: p.nx, ny: p.ny }; });
  }
  quickAt(sx, sy) {
    if (!this.v.quick || this.v.editing) return null;
    for (const q of this.v.quick) {
      const p = this.cam.toScreen(q.x, q.y);
      if (Math.hypot(p.x + q.nx * 22 - sx, p.y + q.ny * 22 - sy) <= 13) return q.side;
    }
    return null;
  }

  // --- making things -----------------------------------------------------------------------------

  defaults(type, props = {}) {
    const p = this.pref;
    const base = { id: newId(), type };
    switch (type) {
      case 'sticky': return { ...base, w: 186, h: 186, text: '', color: p.sticky || STICKY_DEFAULT, ...props };
      case 'text': return { ...base, w: 240, h: 36, text: '', fill: null, text_style: { size: p.textSize || 20 }, ...props };
      case 'shape': return { ...base, w: 168, h: 120, shape: p.shape || 'rect', text: '', fill: PAPER, stroke: INK, stroke_width: 2, dash: 'solid', ...props };
      case 'frame': return { ...base, w: 640, h: 420, title: 'Frame', fill: null, ...props };
      case 'node': return { ...base, w: 140, h: 44, text: '', fill: null, mm: { parent: '', collapsed: false, side: 'right' }, ...props };
      case 'connector': return { ...base, x: 0, y: 0, w: 0, h: 0, shape: p.connector || 'elbow', start_head: 'none', end_head: p.endHead || 'arrow', color: null, width: 2, dash: 'solid', label: '', ...props };
      default: return { ...base, ...props };
    }
  }

  /** Add an object (one undo step on its own unless inside a transaction). Selects it and opens it for typing if asked. */
  add(type, props = {}, { select = true, edit = false } = {}) {
    const o = this.defaults(type, props);
    if (o.x === undefined) { const c = this.at(); o.x = c.x - o.w / 2; o.y = c.y - o.h / 2; }
    return this.doc.tx(`Add ${type}`, () => {
      this.doc.add(o);
      if (type === 'frame') this.doc.settle();
      this.adopt(o);
      if (type === 'text') this.doc.patch(o.id, { h: T.hug(o) });
      if (select) this.select([o.id]);
      if (edit) queueMicrotask(() => this.edit(o.id, { selectAll: type === 'frame' }));
      return o;
    });
  }

  /** Put an object into the frame it sits in (or out of the one it left). */
  adopt(o) {
    if (['frame', 'connector'].includes(o.type)) return;
    const b = this.boxOf(o), c = G.center(b);
    const f = this.frameAt(c.x, c.y, new Set([o.id]));
    const want = f ? f.id : undefined;
    if (o.parent !== want) { if (want) this.doc.patch(o.id, { parent: want }); else { const n = { ...o }; delete n.parent; this.replace(o.id, n); } }
  }
  /** Replace an object's fields wholesale (to remove one). */
  replace(id, next) {
    const o = this.doc.map.get(id);
    if (!o) return;
    this.doc.touch(id);
    for (const k of Object.keys(o)) if (!(k in next)) delete o[k];
    Object.assign(o, next);
    if (o._) o._ = {};
    this.doc.dirty.add(id);
    this.doc.geoVer++;
    this.doc.emit({ type: 'patch', id });
  }

  connect(fromId, toId, props = {}) {
    const a = this.doc.map.get(fromId), b = this.doc.map.get(toId);
    if (!a || !b || a.id === b.id) return null;
    const exists = this.doc.list().some(c => c.type === 'connector' && c.from.id === a.id && c.to.id === b.id);
    if (exists) return null;
    const o = this.defaults('connector', { from: { id: a.id, side: 'auto' }, to: { id: b.id, side: 'auto' }, ...props });
    return this.doc.tx('Connect', () => this.doc.add(o));
  }

  /** The copy quick-create makes: same kind, size and look, no words. */
  twin(src) {
    const n = clone(src);
    n.id = newId(); delete n.group; delete n.locked;
    if ('text' in n) n.text = '';
    if (src.type === 'node') n.mm = { ...src.mm };
    return n;
  }

  /** Make a connected copy of `id` on one side, select it, and start typing in it. */
  spawn(id, side, { edit = true } = {}) {
    const src = this.doc.map.get(id);
    if (!src || ['connector', 'draw', 'frame'].includes(src.type)) return null;
    if (src.type === 'node' && this.mm) return this.mm.child(id, { edit });
    const n = this.twin(src);
    if (src.type === 'image' || src.type === 'file' || src.type === 'link') { n.type = 'sticky'; Object.assign(n, { w: 186, h: 186, text: '', color: this.pref.sticky || STICKY_DEFAULT }); for (const k of ['src', 'name', 'size', 'mime', 'url', 'title', 'desc', 'host', 'favicon', 'thumb']) delete n[k]; }
    const nx = { t: [0, -1], r: [1, 0], b: [0, 1], l: [-1, 0] }[side];
    n.x = src.x + src.w / 2 + nx[0] * (src.w / 2 + GAP + n.w / 2) - n.w / 2;
    n.y = src.y + src.h / 2 + nx[1] * (src.h / 2 + GAP + n.h / 2) - n.h / 2;
    this.freeSpot(n, side, src);
    return this.doc.tx('Add connected', () => {
      this.doc.add(n);
      if (src.parent) this.doc.patch(n.id, { parent: src.parent }); else this.adopt(n);
      const opposite = { t: 'b', r: 'l', b: 't', l: 'r' }[side];
      const c = this.defaults('connector', { from: { id: src.id, side, t: 0.5 }, to: { id: n.id, side: opposite, t: 0.5 } });
      // follow the style of a connector already leaving the source, so a chain looks the same all the way
      const prev = this.doc.list().reverse().find(k => k.type === 'connector' && k.from.id === src.id);
      if (prev) Object.assign(c, { shape: prev.shape, end_head: prev.end_head, start_head: prev.start_head, color: prev.color, width: prev.width, dash: prev.dash });
      this.doc.add(c);
      this.select([n.id]);
      if (edit) queueMicrotask(() => this.edit(n.id));
      return n;
    });
  }
  /** Slide a new object along the perpendicular until it is clear of what is already there. */
  freeSpot(n, side, src) {
    const others = this.doc.list().filter(o => !['connector', 'frame', 'draw'].includes(o.type) && o.id !== src.id);
    const perp = side === 'l' || side === 'r' ? [0, 1] : [1, 0];
    const step = (side === 'l' || side === 'r' ? n.h : n.w) + 24;
    const clash = (x, y) => others.some(o => G.touches({ x, y, w: n.w, h: n.h }, G.grow(o, 8)));
    const x0 = n.x, y0 = n.y;
    for (let k = 0; k < 40; k++) {
      const s = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2);
      const x = x0 + perp[0] * s * step, y = y0 + perp[1] * s * step;
      if (!clash(x, y)) { n.x = x; n.y = y; return; }
    }
  }

  // --- changing things ---------------------------------------------------------------------------

  /** Change fields on all selected objects (or on the ones given). One undo step. */
  set(fields, ids = null, label = 'Style') {
    const list = (ids ? ids.map(i => this.doc.map.get(i)) : this.selected()).filter(Boolean);
    if (!list.length) return;
    this.doc.tx(label, () => { for (const o of list) this.doc.patch(o.id, typeof fields === 'function' ? fields(o) : fields); });
  }
  setText(fields, label = 'Text style') {
    this.doc.tx(label, () => {
      for (const o of this.selected()) {
        if (!('text' in o) && o.type !== 'connector') continue;
        this.doc.patch(o.id, { text_style: { ...(o.text_style || {}), ...fields } });
        if (o.type === 'text') this.doc.patch(o.id, { h: T.hug(this.doc.map.get(o.id)) });
      }
    });
  }
  moveBy(ids, dx, dy) {
    for (const id of ids) {
      const o = this.doc.map.get(id);
      if (!o) continue;
      if (o.type === 'connector') {
        const f = {};
        if (o.from.id === undefined) f.from = { x: o.from.x + dx, y: o.from.y + dy };
        if (o.to.id === undefined) f.to = { x: o.to.x + dx, y: o.to.y + dy };
        if (Object.keys(f).length) this.doc.patch(id, f);
      } else this.doc.patch(id, { x: o.x + dx, y: o.y + dy });
    }
  }
  /** What moves when these are moved: themselves, the contents of frames among them, and nothing locked. */
  moveSet(ids) {
    const out = new Set();
    for (const id of ids) {
      const o = this.doc.map.get(id);
      if (!o || o.locked) continue;
      out.add(id);
      if (o.type === 'frame') for (const c of this.childrenOf(id)) if (!c.locked) out.add(c.id);
      if (o.type === 'node' && this.mm) for (const d of this.mm.subtree(id)) out.add(d);
    }
    // a connector glued at both ends moves with its objects; one with a free end moves only if chosen
    return out;
  }
  nudge(dx, dy) {
    const ids = this.moveSet(this.v.sel);
    if (!ids.size) return;
    this.doc.tx('Move', () => { this.moveBy(ids, dx, dy); for (const id of ids) { const o = this.doc.map.get(id); if (o && o.type !== 'frame') this.adopt(o); } });
  }

  remove(ids = [...this.v.sel], label = 'Delete') {
    const doomed = new Set(ids.filter(i => this.doc.map.has(i) && !this.doc.map.get(i).locked));
    if (this.mm) for (const id of [...doomed]) for (const d of this.mm.subtree(id)) doomed.add(d);
    for (const c of this.doc.list()) if (c.type === 'connector' && ((c.from.id && doomed.has(c.from.id)) || (c.to.id && doomed.has(c.to.id)))) doomed.add(c.id);
    if (!doomed.size) return;
    this.doc.tx(label, () => {
      for (const id of doomed) {
        const o = this.doc.map.get(id);
        if (o.type === 'frame') for (const c of this.childrenOf(id)) if (!doomed.has(c.id)) { const n = { ...c }; delete n.parent; this.replace(c.id, n); }
      }
      for (const id of doomed) this.doc.remove(id);
    });
    this.emit('selection');
  }

  arrange(mode) {
    const ids = [...this.v.sel];
    if (ids.length) this.doc.tx('Arrange', () => this.doc.reorder(ids, mode));
  }
  group() {
    const objs = this.selected().filter(o => o.type !== 'connector' && !o.group);
    if (objs.length < 2) return;
    const g = 'g' + newId().slice(1, 9);
    this.doc.tx('Group', () => { for (const o of objs) this.doc.patch(o.id, { group: g }); });
    this.select(objs.map(o => o.id));
  }
  ungroup() {
    const gs = new Set(this.selected().map(o => o.group).filter(Boolean));
    if (!gs.size) return;
    this.doc.tx('Ungroup', () => { for (const o of this.doc.list()) if (gs.has(o.group)) { const n = { ...o }; delete n.group; this.replace(o.id, n); } });
  }
  lock(on) {
    const sel = this.selected();
    if (!sel.length) return;
    const want = on === undefined ? !sel.every(o => o.locked) : on;
    this.doc.tx(want ? 'Lock' : 'Unlock', () => { for (const o of sel) { if (want) this.doc.patch(o.id, { locked: true }); else { const n = { ...o }; delete n.locked; this.replace(o.id, n); } } });
  }
  /** Wrap the selection (or an empty area) in a frame. */
  frameSelection() {
    const sel = this.selected().filter(o => o.type !== 'connector' && o.type !== 'frame');
    const bb = sel.length ? G.union(sel) : null;
    if (!bb) return this.add('frame', {}, { edit: true });
    const pad = 40;
    return this.doc.tx('Frame', () => {
      const f = this.defaults('frame', { x: bb.x - pad, y: bb.y - pad - 14, w: bb.w + pad * 2, h: bb.h + pad * 2 + 14, title: 'Frame' });
      this.doc.add(f); this.doc.settle();
      for (const o of sel) this.doc.patch(o.id, { parent: f.id });
      this.select([f.id]);
      queueMicrotask(() => this.edit(f.id, { selectAll: true }));
      return f;
    });
  }

  // --- copy and paste ----------------------------------------------------------------------------

  /** Objects to copy: the selection, what's inside selected frames, and the connectors between them. */
  clipboardSet() {
    const ids = new Set();
    for (const o of this.selected()) { ids.add(o.id); if (o.type === 'frame') for (const c of this.childrenOf(o.id)) ids.add(c.id); if (o.type === 'node' && this.mm) for (const d of this.mm.subtree(o.id)) ids.add(d); }
    for (const c of this.doc.list()) if (c.type === 'connector' && (!c.from.id || ids.has(c.from.id)) && (!c.to.id || ids.has(c.to.id)) && (c.from.id || c.to.id)) ids.add(c.id);
    return this.doc.order.filter(i => ids.has(i)).map(i => clone(this.doc.map.get(i)));
  }
  payload() {
    const objects = this.clipboardSet();
    if (!objects.length) return null;
    const text = objects.map(o => o.text || o.title || o.label || o.url || o.name || '').filter(Boolean).join('\n');
    return { kind: 'anchor-board', board: this.doc.id, objects, text: text || `${objects.length} board object${objects.length > 1 ? 's' : ''}` };
  }

  /** Put copies of `objects` on the board, new ids throughout, centred on `at` (or offset from where they were). */
  async place(payload, at, { quiet = false } = {}) {
    const objs = payload.objects.map(clone);
    const idMap = new Map(objs.map(o => [o.id, newId()])), gmap = new Map();
    const assets = [...new Set(objs.flatMap(o => ['src', 'favicon', 'thumb'].map(k => o[k]).filter(Boolean)))];
    let rename = {};
    if (assets.length && (payload.board !== this.doc.id || payload.template)) {
      try { rename = (await this.ctx.send('POST', `/board/${this.doc.id}/assets/copy`, payload.template ? { from_template: payload.template, srcs: assets } : { from_board: payload.board, srcs: assets })).map || {}; }
      catch { /* a missing source file just leaves a blank picture */ }
    }
    const nodes = objs.filter(o => o.type !== 'connector');
    const bb = G.union(nodes.map(o => this.boxOf(o))) || { x: 0, y: 0, w: 0, h: 0 };
    const dx = at ? at.x - (bb.x + bb.w / 2) : 24, dy = at ? at.y - (bb.y + bb.h / 2) : 24;
    for (const o of objs) {
      o.id = idMap.get(o.id);
      for (const k of ['src', 'favicon', 'thumb']) if (o[k] && rename[o[k]]) o[k] = rename[o[k]];
      if (o.parent) o.parent = idMap.get(o.parent) || undefined; if (!o.parent) delete o.parent;
      if (o.group) o.group = 'g' + idMap.get(o.group || '') ;
      if (o.mm) o.mm = { ...o.mm, parent: idMap.get(o.mm.parent) || '' };
      if (o.type === 'connector') {
        for (const k of ['from', 'to']) o[k] = o[k].id ? (idMap.has(o[k].id) ? { ...o[k], id: idMap.get(o[k].id) } : { x: o.x, y: o.y }) : { x: o[k].x + dx, y: o[k].y + dy };
      } else { o.x += dx; o.y += dy; }
    }
    const groups = new Map();
    for (const o of objs) if (o.group) { const g = groups.get(o.group) || [];  g.push(o); groups.set(o.group, g); }
    for (const [, list] of groups) if (list.length < 2) for (const o of list) delete o.group;
    this.doc.tx('Paste', () => {
      for (const o of objs) this.doc.add(o);
      this.doc.settle();
      for (const o of objs) if (!o.parent && !['frame', 'connector'].includes(o.type) && payload.objects.every(p => p.type !== 'frame')) this.adopt(o);
      this.select(objs.filter(o => o.type !== 'connector' || objs.length === 1).map(o => o.id));
      if (this.mm) this.mm.refresh();
    });
    if (!quiet) this.emit('placed');
    return objs;
  }

  async duplicate() {
    const p = this.payload();
    if (p) await this.place(p, null);
  }

  // --- undo, clipboard ---------------------------------------------------------------------------

  undo() { const e = this.doc.undo(); if (e) this.afterHistory(e); else this.ctx.toast('Nothing to undo.', { icon: 'info' }); }
  redo() { const e = this.doc.redo(); if (e) this.afterHistory(e); else this.ctx.toast('Nothing to redo.', { icon: 'info' }); }
  afterHistory(e) {
    if (this.mm) this.mm.refresh();
    const ids = [...e.changes.keys()].filter(i => this.doc.map.has(i) && this.doc.map.get(i).type !== 'connector');
    this.select(ids.length < 400 ? ids : []);
  }

  copy() {
    const p = this.payload();
    if (!p) return;
    try { localStorage.setItem('anchor.board.clip', JSON.stringify(p)); } catch { /* storage full or blocked */ }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(p.text).catch(() => {});
    this.ctx.toast(p.objects.length === 1 ? 'Copied.' : `Copied ${p.objects.length} objects.`, { icon: 'copy' });
  }
  cut() { if (this.v.sel.size) { this.copy(); this.remove(); } }
  /** The objects last copied on this Mac, if the clipboard text is still the text that came with them. */
  clipped(text) {
    try {
      const p = JSON.parse(localStorage.getItem('anchor.board.clip') || 'null');
      if (p && p.kind === 'anchor-board' && (text === undefined || text === '' || text === p.text)) return p;
    } catch { /* nothing usable */ }
    return null;
  }

  cycleShape(armed) {
    const next = k => SHAPES[(SHAPES.indexOf(k) + 1) % SHAPES.length];
    if (armed) { this.savePref({ shape: next(this.pref.shape || 'rect') }); this.emit('tool'); return; }
    this.set(o => (o.type === 'shape' ? { shape: next(o.shape) } : {}), null, 'Change shape');
  }

  // --- view --------------------------------------------------------------------------------------

  fit() {
    const b = this.bounds();
    if (b) this.cam.flyTo(this.cam.framing(b)); else this.cam.flyTo({ x: -this.cam.w / 2, y: -this.cam.h / 2, z: 1 });
  }
  fitSelection() {
    const b = this.v.sel.size ? this.bounds(this.selected()) : null;
    if (b) this.cam.flyTo(this.cam.framing(b, 96, 2)); else this.fit();
  }
  reveal(id) {
    const o = this.doc.map.get(id);
    if (!o) return;
    this.cam.flyTo(this.cam.framing(this.boxOf(o), 140, 1.2));
  }
  zoomBy(f) { this.cam.flyTo(this.zoomView(this.cam.z * f), 180); }
  zoomView(z) {
    const c = this.viewCenter();
    return { x: c.x - this.cam.w / 2 / z, y: c.y - this.cam.h / 2 / z, z: Math.min(4, Math.max(0.02, z)) };
  }
  zoomTo(z) { this.cam.flyTo(this.zoomView(z), 180); }

  setTool(t) {
    if (this.v.tool === t) return;
    this.v.tool = t;
    this.v.connDraft = null; this.v.stroke = null; this.v.eraser = null;
    this.invalidate();
    this.emit('tool');
  }

  savePref(patch) { Object.assign(this.pref, patch); try { localStorage.setItem('anchor.board.pref', JSON.stringify(this.pref)); } catch { /* private window */ } }
}

function loadPref() {
  try { return JSON.parse(localStorage.getItem('anchor.board.pref') || '{}'); } catch { return {}; }
}
