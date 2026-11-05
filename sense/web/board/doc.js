// The board's document: objects in z-order, every change recorded so it can be undone, and a list of what changed
// since the last save. Everything that edits the board goes through here.

import * as T from './text.js';

const CLONE_SKIP = key => key.startsWith('_');

export function clone(o) {
  return JSON.parse(JSON.stringify(o, (k, v) => (CLONE_SKIP(k) ? undefined : v)));
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const cache = o => o._ || (Object.defineProperty(o, '_', { value: {}, enumerable: false, writable: true }), o._);

let counter = 0;
export function newId() {
  counter = (counter + 1) % 46656;
  return 'o' + Date.now().toString(36).slice(-6) + counter.toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 5);
}

export class Doc {
  constructor(data) {
    this.id = data.id;
    this.title = data.title;
    this.rev = data.rev;
    this.view = data.view || { x: 0, y: 0, z: 1 };
    this.map = new Map();
    this.order = [];
    for (const o of data.objects) { if (o.type === 'text') { try { o.h = T.hug(o); } catch (e) { /* keep the saved height */ } } this.map.set(o.id, o); this.order.push(o.id); }
    this.ver = 0;            // goes up on every change: the renderer redraws when it moves
    this.geoVer = 0;         // goes up when anything moved, resized or came or went (connector routes and the minimap depend on it)
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = new Set();  // ids changed since the last save, deleted ones included
    this.orderDirty = false;
    this.tx_ = null;
    this.listeners = new Set();
    this.indexCache = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) {
    this.ver++;
    if (this.holding) { this.pending = true; return; }
    for (const fn of this.listeners) fn(ev);
  }
  /** Run `fn` and tell listeners once at the end, not once per object (a drag of a thousand objects is one event). */
  batch(fn) {
    this.holding = (this.holding || 0) + 1;
    try { return fn(); } finally {
      if (--this.holding === 0 && this.pending) { this.pending = false; for (const f of this.listeners) f({ type: 'patch', batch: true }); }
    }
  }

  get(id) { return this.map.get(id); }
  has(id) { return this.map.has(id); }
  get size() { return this.map.size; }
  /** Objects back to front. */
  list() { return this.order.map(i => this.map.get(i)); }
  indexOf(id) {
    if (!this.indexCache) { this.indexCache = new Map(); this.order.forEach((i, n) => this.indexCache.set(i, n)); }
    return this.indexCache.get(id);
  }

  // --- transactions ------------------------------------------------------------------------------

  /** Run `fn` as one undo step. Nested calls join the outer step. Returns what `fn` returns. */
  tx(label, fn, meta) {
    if (this.tx_) return fn();
    this.tx_ = { label, before: new Map(), orderBefore: null, meta: meta || {} };
    let out;
    try { out = fn(); } finally { this.commit(); }
    return out;
  }

  /** Open a step that stays open across events (typing in an object), until end(). */
  begin(label) { if (!this.tx_) this.tx_ = { label, before: new Map(), orderBefore: null, meta: {} }; }
  end() { return this.commit(); }

  touch(id) {
    const t = this.tx_;
    if (!t || t.before.has(id)) return;
    const o = this.map.get(id);
    t.before.set(id, o ? clone(o) : null);
  }
  touchOrder() {
    const t = this.tx_;
    if (t && !t.orderBefore) t.orderBefore = this.order.slice();
    this.indexCache = null;
    this.orderDirty = true;
  }

  commit() {
    const t = this.tx_;
    this.tx_ = null;
    if (!t) return null;
    const changes = new Map();
    for (const [id, before] of t.before) {
      const now = this.map.get(id);
      const after = now ? clone(now) : null;
      if (!same(before, after)) changes.set(id, { before, after });
    }
    const order = t.orderBefore && !same(t.orderBefore, this.order) ? { before: t.orderBefore, after: this.order.slice() } : null;
    if (!changes.size && !order) return null;
    const entry = { label: t.label, changes, order, meta: t.meta, at: Date.now() };
    this.undoStack.push(entry);
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit({ type: 'commit', entry });
    return entry;
  }

  // --- changes -----------------------------------------------------------------------------------

  add(o, index) {
    this.touch(o.id); this.touchOrder();
    this.map.set(o.id, o);
    if (index === undefined || index >= this.order.length) this.order.push(o.id); else this.order.splice(Math.max(0, index), 0, o.id);
    this.dirty.add(o.id);
    this.geoVer++;
    this.emit({ type: 'add', id: o.id });
    return o;
  }

  patch(id, fields) {
    const o = this.map.get(id);
    if (!o) return null;
    this.touch(id);
    Object.assign(o, fields);
    if (o._) o._ = {};
    // a text box hugs its words: whatever changed its width, words or type, its height follows
    if (o.type === 'text' && !('h' in fields) && ('w' in fields || 'text' in fields || 'text_style' in fields)) {
      const h = T.hug(o);
      if (Math.abs(h - o.h) > 0.5) { o.h = h; fields = { ...fields, h }; }
    }
    this.dirty.add(id);
    if ('x' in fields || 'y' in fields || 'w' in fields || 'h' in fields || 'points' in fields || 'from' in fields || 'to' in fields || 'shape' in fields || 'mm' in fields) this.geoVer++;
    this.emit({ type: 'patch', id, fields });
    return o;
  }

  remove(id) {
    if (!this.map.has(id)) return;
    this.touch(id); this.touchOrder();
    this.map.delete(id);
    this.order.splice(this.order.indexOf(id), 1);
    this.dirty.add(id);
    this.geoVer++;
    this.emit({ type: 'remove', id });
  }

  /** Put these ids in this order at the back, front, or one step. */
  reorder(ids, mode) {
    const set = new Set(ids);
    const o = this.order;
    this.touchOrder();
    if (mode === 'front') this.order = [...o.filter(i => !set.has(i)), ...o.filter(i => set.has(i))];
    else if (mode === 'back') this.order = [...o.filter(i => set.has(i)), ...o.filter(i => !set.has(i))];
    else if (mode === 'forward') { for (let i = o.length - 2; i >= 0; i--) if (set.has(o[i]) && !set.has(o[i + 1])) [o[i], o[i + 1]] = [o[i + 1], o[i]]; }
    else if (mode === 'backward') { for (let i = 1; i < o.length; i++) if (set.has(o[i]) && !set.has(o[i - 1])) [o[i], o[i - 1]] = [o[i - 1], o[i]]; }
    this.settle();
    this.indexCache = null;
    this.emit({ type: 'order' });
  }

  /** Frames always sit under what is on them. Stable: the order among frames, and among the rest, is kept. */
  settle() {
    const frames = this.order.filter(i => this.map.get(i).type === 'frame');
    if (!frames.length) return;
    const rest = this.order.filter(i => this.map.get(i).type !== 'frame');
    this.order = [...frames, ...rest];
    this.indexCache = null;
  }

  // --- undo, redo --------------------------------------------------------------------------------

  restore(entry, dir) {
    const key = dir === 'undo' ? 'before' : 'after';
    for (const [id, c] of entry.changes) {
      const st = c[key];
      if (st === null) this.map.delete(id); else this.map.set(id, clone(st));
      this.dirty.add(id);
    }
    if (entry.order) {
      const want = entry.order[key].filter(i => this.map.has(i));
      const seen = new Set(want);
      this.order = [...want, ...[...this.map.keys()].filter(i => !seen.has(i))];
      this.orderDirty = true;
    } else {
      this.order = this.order.filter(i => this.map.has(i));
      const seen = new Set(this.order);
      for (const id of entry.changes.keys()) if (this.map.has(id) && !seen.has(id)) this.order.push(id);
    }
    this.indexCache = null;
    this.geoVer++;
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.restore(e, 'undo');
    this.redoStack.push(e);
    this.emit({ type: 'undo', entry: e });
    return e;
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.restore(e, 'redo');
    this.undoStack.push(e);
    this.emit({ type: 'redo', entry: e });
    return e;
  }

  // --- saving, and changes that come from elsewhere -----------------------------------------------

  /** What to send to save: changed objects, removed ids, and the order if it moved. Clears the list. */
  takePatch() {
    if (!this.dirty.size && !this.orderDirty) return null;
    const upsert = [], del = [];
    for (const id of this.dirty) { const o = this.map.get(id); if (o) upsert.push(clone(o)); else del.push(id); }
    const patch = { upsert, delete: del };
    if (this.orderDirty) patch.order = this.order.slice();
    this.dirty = new Set(); this.orderDirty = false;
    return patch;
  }
  /** Put a patch back after a save failed. */
  requeue(patch) {
    for (const o of patch.upsert) this.dirty.add(o.id);
    for (const id of patch.delete) this.dirty.add(id);
    if (patch.order) this.orderDirty = true;
  }

  /** Apply a change made elsewhere (another tab). Not saved again, not undoable here. Returns what changed. */
  applyRemote(patch) {
    const changes = new Map();
    for (const id of patch.delete || []) {
      const was = this.map.get(id);
      if (!was) continue;
      changes.set(id, { before: clone(was), after: null });
      this.map.delete(id);
    }
    for (const raw of patch.upsert || []) {
      const was = this.map.get(raw.id);
      changes.set(raw.id, { before: was ? clone(was) : null, after: clone(raw) });
      this.map.set(raw.id, raw);
      if (!was) this.order.push(raw.id);
      this.dirty.delete(raw.id);
    }
    if (Array.isArray(patch.order)) {
      const want = patch.order.filter(i => this.map.has(i));
      const seen = new Set(want);
      this.order = [...want, ...this.order.filter(i => this.map.has(i) && !seen.has(i))];
    } else this.order = this.order.filter(i => this.map.has(i));
    this.indexCache = null;
    this.geoVer++;
    this.emit({ type: 'remote', changes });
    return changes;
  }

  /** Every object (a copy), for export. */
  snapshot() { return this.list().map(clone); }
}
