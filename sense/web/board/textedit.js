// Typing into an object: a real text field laid exactly over it, sized to the zoom, so you get caret, selection, IME and
// spell-check for free. The canvas skips drawing that object's words while this is open.

import * as T from './text.js';
import * as G from './geom.js';
import * as C from './connectors.js';
import { cache } from './doc.js';
import { inkOn } from './palette.js';

export class TextEdit {
  constructor(ed, host) {
    this.ed = ed;
    this.el = document.createElement('div');
    this.el.className = 'bd-edit';
    this.el.hidden = true;
    this.in = document.createElement('div');
    this.in.className = 'bd-edit-in';
    this.in.contentEditable = 'plaintext-only';
    if (this.in.contentEditable !== 'plaintext-only') this.in.contentEditable = 'true';
    this.in.spellcheck = true;
    this.in.setAttribute('role', 'textbox');
    this.in.setAttribute('aria-multiline', 'true');
    this.el.appendChild(this.in);
    host.appendChild(this.el);
    this.id = null;
    this.kind = null;
    this.fresh = false;
    this.in.addEventListener('input', () => this.input());
    this.in.addEventListener('keydown', e => this.key(e));
    this.in.addEventListener('blur', () => { if (this.id) this.close(); });
    this.in.addEventListener('paste', e => {
      e.preventDefault();
      const t = (e.clipboardData || window.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, this.kind === 'single' ? t.replace(/\s*\n\s*/g, ' ') : t);
    });
    this.el.addEventListener('pointerdown', e => e.stopPropagation());
    this.el.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
  }

  get open_() { return this.id !== null; }

  /** Open an object for typing. `fresh` marks one that was just made, so an empty text box can vanish if you walk away. */
  open(id, { fresh = false, selectAll = false } = {}) {
    const ed = this.ed, o = ed.doc.map.get(id);
    if (!o || o.locked) return;
    if (this.id) this.close();
    this.id = id; this.fresh = fresh;
    this.kind = o.type === 'frame' || o.type === 'connector' ? 'single' : 'multi';
    ed.v.editing = id;
    ed.doc.begin(o.type === 'frame' ? 'Rename frame' : 'Edit text');
    const text = o.type === 'frame' ? o.title : o.type === 'connector' ? o.label : o.text;
    this.in.textContent = text;
    this.el.hidden = false;
    this.place();
    this.in.focus();
    const sel = getSelection(), r = document.createRange();
    r.selectNodeContents(this.in);
    if (!selectAll) r.collapse(false);
    sel.removeAllRanges(); sel.addRange(r);
    ed.invalidate();
    ed.emit('editing');
  }

  /** Put the field where the object's words go, at the current zoom. */
  place() {
    const ed = this.ed, o = ed.doc.map.get(this.id);
    if (!o) return;
    const z = ed.cam.z, st = T.style(o), el = this.el, inn = this.in;
    let rect, fs, align = st.align, col, vcenter = true, pad = 0;
    if (o.type === 'frame') {
      fs = Math.max(14, 13 / z);
      rect = { x: o.x, y: o.y - fs * 1.7, w: Math.max(o.w, 160 / z), h: fs * 1.5 };
      align = 'left'; vcenter = true; col = getComputedStyle(document.body).getPropertyValue('--fg-1');
      inn.style.fontWeight = '600'; inn.style.fontStyle = 'normal';
    } else if (o.type === 'connector') {
      const mp = C.midpoint(ed.r.route(o)), w = Math.max(160, 60);
      fs = (o.text_style && o.text_style.size) || 15;
      rect = { x: mp.x - w / 2, y: mp.y - fs, w, h: fs * 2 };
      align = 'center'; col = (o.text_style && o.text_style.color) || getComputedStyle(document.body).getPropertyValue('--fg-1');
      inn.style.fontWeight = (o.text_style && o.text_style.bold) ? '600' : '400'; inn.style.fontStyle = (o.text_style && o.text_style.italic) ? 'italic' : 'normal';
    } else {
      const area = o.type === 'shape' ? G.textArea(o.shape, o) : o;
      const t = T.layout(o, area);
      fs = t.fs; pad = t.pad; rect = area;
      vcenter = o.type !== 'text';
      const fill = o.type === 'sticky' ? null : o.fill;
      col = st.color || (o.type === 'sticky' ? inkOn(ed.stickyFill(o)) : fill ? inkOn(fill) : getComputedStyle(document.body).getPropertyValue('--fg-1'));
      inn.style.fontWeight = st.bold ? '600' : '400'; inn.style.fontStyle = st.italic ? 'italic' : 'normal';
    }
    const p = ed.cam.toScreen(rect.x, rect.y);
    el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    el.style.width = rect.w * z + 'px';
    el.style.minHeight = rect.h * z + 'px';
    el.style.height = o.type === 'text' ? 'auto' : rect.h * z + 'px';
    el.style.alignItems = vcenter ? 'center' : 'flex-start';
    inn.style.fontSize = fs * z + 'px';
    inn.style.fontFamily = o.type === 'frame' ? '' : T.famOf(st.face);
    inn.style.lineHeight = String(T.LH);
    inn.style.padding = pad * z + 'px';
    inn.style.textAlign = align;
    inn.style.color = col;
    inn.style.textDecoration = st.underline ? 'underline' : 'none';
    inn.style.whiteSpace = this.kind === 'single' ? 'nowrap' : 'pre-wrap';
    el.dataset.type = o.type;
  }

  input() {
    const ed = this.ed, o = ed.doc.map.get(this.id);
    if (!o) return;
    const raw = this.in.innerText.replace(/ /g, ' ').replace(/\n$/, '');
    if (o.type === 'frame') ed.doc.patch(o.id, { title: raw.replace(/\n/g, ' ').slice(0, 200) });
    else if (o.type === 'connector') ed.doc.patch(o.id, { label: raw.replace(/\n/g, ' ').slice(0, 500) });
    else {
      ed.doc.patch(o.id, { text: raw.slice(0, 10000) });
      const n = ed.doc.map.get(o.id);
      if (o.type === 'text') ed.doc.patch(o.id, { h: T.hug(n) });
      if (o.type === 'node' && ed.mm) ed.mm.resize(o.id);
    }
    this.place();
  }

  key(e) {
    const ed = this.ed, o = ed.doc.map.get(this.id);
    if (!o) return;
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); const id = this.id; this.close(); ed.select([id]); ed.host.querySelector('.bd').focus({ preventScroll: true }); return; }
    if (this.kind === 'single' && e.key === 'Enter') { e.preventDefault(); const id = this.id; this.close(); ed.select([id]); return; }
    if (e.key === 'Enter' && mod) { e.preventDefault(); const id = this.id; this.close(); ed.select([id]); return; }
    if (o.type === 'node' && ed.mm && !e.isComposing) {
      if (e.key === 'Tab') { e.preventDefault(); const id = this.id; this.close(); ed.mm.child(id, { edit: true }); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const id = this.id; this.close(); ed.mm.sibling(id, { edit: true }); return; }
    }
    if (e.key === 'Tab' && !e.isComposing && this.kind === 'multi') {
      e.preventDefault();
      const id = this.id; this.close();
      ed.spawn(id, e.shiftKey ? 'b' : 'r');
      return;
    }
    if (mod && (e.key === 'b' || e.key === 'i' || e.key === 'u') && o.type !== 'frame' && o.type !== 'connector') {
      e.preventDefault();
      const k = { b: 'bold', i: 'italic', u: 'underline' }[e.key];
      ed.setText({ [k]: !T.style(o)[k] });
      this.place();
    }
  }

  close() {
    const ed = this.ed, id = this.id;
    if (!id) return;
    this.id = null;
    const o = ed.doc.map.get(id);
    ed.v.editing = null;
    const had = document.activeElement === this.in;   // a hidden field keeps focus, and would swallow the next shortcut
    this.in.blur();
    if (had) ed.host.querySelector('.bd').focus({ preventScroll: true });
    this.el.hidden = true;
    if (o && this.fresh && o.type === 'text' && !o.text.trim()) { ed.doc.remove(id); ed.v.sel.delete(id); ed.emit('selection'); }
    else if (o && o.type === 'node' && ed.mm) ed.mm.resize(id, true);
    ed.doc.end();
    this.fresh = false;
    ed.invalidate();
    ed.emit('editing');
  }
}
