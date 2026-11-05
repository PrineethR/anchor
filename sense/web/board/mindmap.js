// Mind maps. A mind map is nodes whose `mm.parent` points at another node. Tab adds a child, Enter adds a sibling, the
// tree lays itself out, and a branch can be folded away. The branch lines are ordinary connectors (marked auto: "mm").

import { newId } from './doc.js';
import * as T from './text.js';
import { INK, BRANCH } from './palette.js';
const H_GAP = 72, V_GAP = 16, MIN_W = 96, MAX_W = 320;

export class MindMaps {
  constructor(ed) {
    this.ed = ed;
    this.ver = -1;
    this.kids = new Map();
    this.refresh();
    ed.doc.on(ev => { if (ev.type !== 'patch' || !ev.batch) this.refresh(); });
  }

  /** parent id -> its children, top to bottom. Rebuilt only when the board's geometry has changed. */
  index() {
    const doc = this.ed.doc;
    if (this.ver === doc.geoVer) return this.kids;
    const kids = new Map();
    const nodes = doc.list().filter(o => o.type === 'node');
    for (const n of nodes) {
      const p = n.mm.parent;
      if (p && doc.map.has(p)) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(n); }
    }
    for (const list of kids.values()) list.sort((a, b) => a.y - b.y || doc.indexOf(a.id) - doc.indexOf(b.id));
    this.kids = kids; this.ver = doc.geoVer;
    return kids;
  }

  childrenOf(id) { return this.index().get(id) || []; }
  rootOf(id) {
    const doc = this.ed.doc;
    let n = doc.map.get(id), guard = 0;
    while (n && n.mm.parent && doc.map.has(n.mm.parent) && guard++ < 200) n = doc.map.get(n.mm.parent);
    return n;
  }
  depth(id) {
    const doc = this.ed.doc;
    let n = doc.map.get(id), d = 0;
    while (n && n.mm.parent && doc.map.has(n.mm.parent) && d < 200) { n = doc.map.get(n.mm.parent); d++; }
    return d;
  }
  subtree(id) {
    const out = [], stack = [...this.childrenOf(id)];
    while (stack.length) { const n = stack.pop(); out.push(n.id); stack.push(...this.childrenOf(n.id)); }
    return out;
  }
  hiddenCount(id) { return this.subtree(id).length; }

  /** Work out which nodes (and branch lines) are folded out of sight. */
  refresh() {
    const ed = this.ed, doc = ed.doc, hidden = new Set();
    this.index();
    for (const n of doc.list()) if (n.type === 'node' && n.mm.collapsed) for (const d of this.subtree(n.id)) hidden.add(d);
    for (const c of doc.list()) if (c.type === 'connector' && ((c.from.id && hidden.has(c.from.id)) || (c.to.id && hidden.has(c.to.id)))) hidden.add(c.id);
    const before = ed.v.hidden;
    if (hidden.size !== before.size || [...hidden].some(i => !before.has(i))) {
      ed.v.hidden = hidden;
      for (const id of [...ed.v.sel]) if (hidden.has(id)) ed.v.sel.delete(id);
      ed.invalidate();
    }
  }

  // --- making nodes ------------------------------------------------------------------------------

  start() {
    const ed = this.ed, at = ed.at();
    ed.setTool('select');
    const n = this.make({ x: at.x - 70, y: at.y - 22, parent: '' });
    ed.select([n.id]);
    queueMicrotask(() => ed.edit(n.id, { fresh: false }));
  }

  /** A node, sized and coloured for its place in the tree, plus its branch line. */
  make({ x, y, parent, text = '' }) {
    const ed = this.ed, doc = ed.doc;
    return doc.tx('Add node', () => {
      const depth = parent ? this.depth(parent) + 1 : 0;
      const n = ed.defaults('node', { x, y, text, mm: { parent, collapsed: false, side: 'right' } });
      const color = this.colorFor(parent, depth);
      n.fill = color;
      n.text_style = { size: depth === 0 ? 24 : depth === 1 ? 20 : 17, bold: depth <= 1 };
      doc.add(n);
      this.fit(n);
      if (parent) {
        const p = doc.map.get(parent);
        doc.add(ed.defaults('connector', { shape: 'curved', end_head: 'none', start_head: 'none', width: 3, color, auto: 'mm',
          from: { id: parent, side: 'r', t: 0.5 }, to: { id: n.id, side: 'l', t: 0.5 } }));
        if (p && p.mm.collapsed) doc.patch(parent, { mm: { ...p.mm, collapsed: false } });
      }
      return n;
    });
  }

  colorFor(parent, depth) {
    if (!parent || depth === 0) return INK;
    const doc = this.ed.doc;
    let top = doc.map.get(parent), guard = 0;
    while (top && top.mm.parent && doc.map.has(top.mm.parent) && doc.map.get(top.mm.parent).mm.parent && guard++ < 200) top = doc.map.get(top.mm.parent);
    if (depth === 1) { const root = doc.map.get(parent); const k = this.childrenOf(root.id).length; return BRANCH[k % BRANCH.length]; }
    return top.fill || BRANCH[0];
  }

  child(id, { edit = true } = {}) {
    const ed = this.ed, p = ed.doc.map.get(id);
    if (!p) return null;
    return ed.doc.tx('Add child', () => {
      const sibs = this.childrenOf(id);
      const last = sibs[sibs.length - 1];
      const n = this.make({ x: p.x + p.w + H_GAP, y: last ? last.y + last.h + V_GAP : p.y, parent: id });
      this.layout(this.rootOf(id).id);
      ed.select([n.id]);
      if (edit) queueMicrotask(() => ed.edit(n.id, { fresh: false }));
      return n;
    });
  }

  sibling(id, { edit = true } = {}) {
    const ed = this.ed, n = ed.doc.map.get(id);
    if (!n) return null;
    if (!n.mm.parent) return this.child(id, { edit });
    return ed.doc.tx('Add sibling', () => {
      const s = this.make({ x: n.x, y: n.y + n.h + 1, parent: n.mm.parent });
      this.layout(this.rootOf(id).id);
      ed.select([s.id]);
      if (edit) queueMicrotask(() => ed.edit(s.id, { fresh: false }));
      return s;
    });
  }

  toggle(id) {
    const ed = this.ed, n = ed.doc.map.get(id);
    if (!n || n.type !== 'node' || !this.childrenOf(id).length) return;
    ed.doc.tx(n.mm.collapsed ? 'Expand' : 'Collapse', () => { ed.doc.patch(id, { mm: { ...n.mm, collapsed: !n.mm.collapsed } }); this.refresh(); this.layout(this.rootOf(id).id); });
    this.refresh();
  }

  // --- size and layout ---------------------------------------------------------------------------

  /** Size a node to its words. */
  fit(n) {
    const doc = this.ed.doc, o = doc.map.get(n.id);
    const st = T.style(o), fs = typeof st.size === 'number' ? st.size : 18;
    const lines = o.text ? o.text.split('\n') : [''];
    const widest = Math.max(...lines.map(l => T.measure(l, fs, st.bold, st.italic)));
    const w = Math.min(MAX_W, Math.max(MIN_W, Math.ceil(widest) + 32));
    const rows = T.wrap(o.text, w - 24, fs, st.bold, st.italic).length || 1;
    const h = Math.max(44, Math.ceil(rows * fs * T.LH) + 20);
    if (Math.abs(o.w - w) > 0.5 || Math.abs(o.h - h) > 0.5) doc.patch(o.id, { w, h });
  }
  resize(id, final = false) {
    const n = this.ed.doc.map.get(id);
    if (!n) return;
    const before = `${n.w}x${n.h}`;
    this.fit(n);
    const a = this.ed.doc.map.get(id);
    if (final || `${a.w}x${a.h}` !== before) { const root = this.rootOf(id); if (root) this.layout(root.id); }
  }

  /** Lay a tree out to the right of its root, parents centred beside their children, nothing overlapping. */
  layout(rootId) {
    const ed = this.ed, doc = ed.doc, root = doc.map.get(rootId);
    if (!root) return;
    const height = new Map();
    const measure = n => {
      const ks = n.mm.collapsed ? [] : this.childrenOf(n.id);
      let h = 0;
      for (const k of ks) h += measure(k) + V_GAP;
      h = ks.length ? h - V_GAP : 0;
      height.set(n.id, Math.max(n.h, h));
      return height.get(n.id);
    };
    measure(root);
    const place = (n, x, cy) => {
      const o = doc.map.get(n.id);
      const y = cy - o.h / 2;
      if (Math.abs(o.x - x) > 0.5 || Math.abs(o.y - y) > 0.5) doc.patch(o.id, { x, y });
      if (n.mm.collapsed) return;
      const ks = this.childrenOf(n.id);
      if (!ks.length) return;
      let total = 0;
      for (const k of ks) total += height.get(k.id) + V_GAP;
      total -= V_GAP;
      let top = cy - total / 2;
      for (const k of ks) { place(k, x + o.w + H_GAP, top + height.get(k.id) / 2); top += height.get(k.id) + V_GAP; }
    };
    doc.batch(() => place(root, root.x, root.y + root.h / 2));
    this.ver = -1;
  }

  afterMove(ids) {
    const roots = new Set();
    for (const id of ids) { const o = this.ed.doc.map.get(id); if (o && o.type === 'node') roots.add(this.rootOf(id).id); }
    this.ed.doc.batch(() => { for (const r of roots) this.layout(r); });
  }

  /** The small fold/unfold circle at a node's right edge: which node's, if the point is on it. */
  hitToggle(x, y) {
    const ed = this.ed, z = ed.cam.z, r = 13 / z;
    for (const n of ed.doc.list()) {
      if (n.type !== 'node' || ed.v.hidden.has(n.id) || !this.childrenOf(n.id).length) continue;
      if (Math.hypot(x - (n.x + n.w + 14 / z), y - (n.y + n.h / 2)) <= r) return n.id;
    }
    return null;
  }
}
