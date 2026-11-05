// Keeping the file on this Mac the same as the board on screen: save within a second of any change, and take in
// changes made elsewhere (another tab on the same board) as they happen.

import { cache } from './doc.js';

const SAVE_AFTER = 350;       // ms of quiet before a save...
const SAVE_AT_MOST = 900;     // ...but never wait longer than this while changes keep coming

export class Sync {
  constructor(ed, { onStatus = () => {} } = {}) {
    this.ed = ed; this.onStatus = onStatus;
    this.client = Math.random().toString(36).slice(2, 10);
    this.timer = 0; this.first = 0; this.saving = false; this.again = false; this.fails = 0;
    this.titleDirty = false; this.viewDirty = false; this.viewReady = false; this.viewTimer = 0;
    this.es = null; this.opened = 0;
    this.off = [];
  }

  start() {
    const ed = this.ed;
    this.off.push(ed.doc.on(ev => {
      if (ev.type === 'remote') return;
      if (ed.doc.dirty.size || ed.doc.orderDirty) this.schedule();
    }));
    const prev = ed.cam.onChange;
    ed.cam.onChange = () => { prev(); this.viewDirty = true; this.viewReady = false; clearTimeout(this.viewTimer); this.viewTimer = setTimeout(() => { this.viewReady = true; this.schedule(); }, 1500); };
    this.connect();
    const hide = () => { if (document.visibilityState === 'hidden') this.flush(true, true); };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', () => this.flush(true, true));
    this.off.push(() => document.removeEventListener('visibilitychange', hide));
  }

  setTitle(t) { this.ed.doc.title = t; this.titleDirty = true; this.schedule(); }

  schedule() {
    this.onStatus('pending');
    clearTimeout(this.timer);
    const now = Date.now();
    if (!this.first) this.first = now;
    const wait = Math.max(0, Math.min(SAVE_AFTER, SAVE_AT_MOST - (now - this.first)));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  /** Save now. `keepalive` lets the request finish as the page closes. */
  async flush(force = false, keepalive = false) {
    clearTimeout(this.timer); this.first = 0;
    const ed = this.ed, doc = ed.doc;
    if (this.saving) { this.again = true; return; }
    const patch = doc.takePatch();
    const sendView = this.viewDirty && (force || this.viewReady || !!patch || this.titleDirty);
    if (!patch && !this.titleDirty && !sendView) { this.onStatus('saved'); return; }
    const body = { client: this.client, base_rev: doc.rev, ...(patch || { upsert: [], delete: [] }) };
    if (this.titleDirty) body.title = doc.title;
    if (sendView) body.view = ed.cam.view();
    const titleSent = this.titleDirty, viewSent = sendView;
    this.titleDirty = false; if (sendView) { this.viewDirty = false; this.viewReady = false; }
    this.saving = true; this.onStatus('saving');
    try {
      const r = await fetch(`/api/board/${doc.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Makesense': '1' }, body: JSON.stringify(body), keepalive: keepalive && JSON.stringify(body).length < 60000 });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      doc.rev = (await r.json()).rev;
      this.fails = 0;
      this.onStatus(doc.dirty.size || doc.orderDirty ? 'pending' : 'saved');
    } catch (err) {
      if (patch) doc.requeue(patch);
      this.titleDirty = this.titleDirty || titleSent; this.viewDirty = this.viewDirty || viewSent;
      this.fails++;
      this.onStatus('error', err.message);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), Math.min(10000, 1000 * 2 ** this.fails));
    } finally {
      this.saving = false;
      if (this.again) { this.again = false; this.flush(); }
    }
  }

  // --- changes from elsewhere ------------------------------------------------------------------

  connect() {
    const ed = this.ed;
    const es = this.es = new EventSource(`/api/board/${ed.doc.id}/events?client=${this.client}`);
    es.addEventListener('hello', () => { if (this.opened++) this.catchUp(); });
    es.addEventListener('patch', e => this.remote(JSON.parse(e.data)));
  }

  remote(msg) {
    const ed = this.ed, doc = ed.doc;
    if (msg.rev) doc.rev = Math.max(doc.rev, msg.rev);
    if (msg.title && msg.title !== doc.title) { doc.title = msg.title; ed.emit('title'); }
    const changes = doc.applyRemote({ upsert: msg.upsert, delete: msg.delete, order: msg.order });
    doc.settle();
    const now = performance.now();
    for (const [id, c] of changes) {
      const o = doc.map.get(id);
      if (!o || o.type === 'connector') continue;
      const k = cache(o);
      if (!c.before) k.tw = { pop: true, t0: now, ms: 420 };
      else if (c.before.x !== c.after.x || c.before.y !== c.after.y) k.tw = { dx: c.before.x - c.after.x, dy: c.before.y - c.after.y, t0: now, ms: 520 };
    }
    ed.invalidate();
    ed.emit({ type: 'remotePatch', changes });
  }

  /** After a lost connection: if the file moved on without us, take what's newer. */
  async catchUp() {
    const ed = this.ed, doc = ed.doc;
    try {
      const b = await (await fetch(`/api/board/${doc.id}`)).json();
      if (b.rev <= doc.rev) return;
      const ids = new Set(b.objects.map(o => o.id));
      const mine = new Set(doc.dirty);
      this.remote({ rev: b.rev, upsert: b.objects.filter(o => !mine.has(o.id)), delete: [...doc.map.keys()].filter(i => !ids.has(i) && !mine.has(i)), order: b.objects.map(o => o.id) });
    } catch { /* still offline; the next hello tries again */ }
  }

  stop() {
    clearTimeout(this.timer); clearTimeout(this.viewTimer);
    if (this.es) this.es.close();
    for (const f of this.off) f();
  }
}
