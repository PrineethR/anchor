// The Board's chrome: tool bar, title and status, the bar that appears over a selection, zoom and history controls,
// search, the frames list, shortcuts. Noteworthy tokens only (see board.css).

import { glyph } from './icons.js';
import { STICKY, STICKY_KEYS, SWATCHES, INK } from './palette.js';
import { SHAPES, SHAPE_NAMES, SHAPE_KEYS } from './geom.js';
import { PEN_WIDTHS, HL_WIDTHS } from './draw.js';
import * as T from './text.js';

const TOOLS = [
  ['select', 'Select', 'mouse-pointer-2', 'V'], ['hand', 'Pan', 'hand', 'H'], ['sticky', 'Sticky note', 'sticky-note', 'N'], ['text', 'Text', 'type', 'T'],
  ['shape', 'Shapes', 'shapes', 'S'], ['connector', 'Connector', 'move-up-right', 'L'], ['pen', 'Pen', 'pencil', 'P'], ['eraser', 'Eraser', 'eraser', 'E'],
  ['frame', 'Frame', 'frame', 'F'], ['mindmap', 'Mind map', 'mindmap', 'M'],
];
const HEADS = [['none', 'None'], ['arrow', 'Arrow'], ['triangle', 'Filled'], ['diamond', 'Diamond'], ['circle', 'Dot'], ['bar', 'Bar']];
const SHORTCUTS = [
  ['Tools', [['V', 'Select'], ['H', 'Pan'], ['N', 'Sticky note'], ['T', 'Text'], ['S', 'Shape (S again cycles)'], ['L', 'Connector'], ['P', 'Pen (P again: highlighter)'], ['E', 'Eraser'], ['F', 'Frame (or frame the selection)'], ['M', 'Mind map'], ['I', 'Add a picture or file']]],
  ['Build fast', [['Tab', 'New connected object to the right'], ['⇧ Tab', 'New connected object below'], ['⌥ ←↑→↓', 'New connected object that way'], ['Double-click', 'New sticky note'], ['Enter', 'Edit text'], ['Esc', 'Stop typing'], ['Tab / Enter', 'In a mind map: child / sibling'], ['C', 'Fold or unfold a branch']]],
  ['Shape tool', [['1–8', 'Pick a shape'], ['R U O D G X C A', 'Rect, rounded, ellipse, diamond, triangle, hexagon, cylinder, arrow'], ['⇧ S', 'Change the selected shape']]],
  ['Edit', [['⌘ Z / ⇧⌘ Z', 'Undo / redo'], ['⌘ C X V', 'Copy, cut, paste (also across boards)'], ['⌘ D', 'Duplicate'], ['⌥ drag', 'Duplicate while dragging'], ['⌘ G / ⇧⌘ G', 'Group / ungroup'], ['⇧⌘ L', 'Lock / unlock'], ['⌘ ] / ⌘ [', 'Forward / backward (add ⇧ for front / back)'], ['Delete', 'Delete'], ['Arrows', 'Nudge (⇧ for more)']]],
  ['View', [['Scroll or two fingers', 'Pan'], ['Pinch or ⌘ scroll', 'Zoom'], ['Space + drag', 'Pan'], ['⇧ 1', 'Fit the board'], ['⇧ 2', 'Fit the selection'], ['⇧ 0', 'Zoom to 100%'], ['⌘ + / ⌘ −', 'Zoom in / out'], ['⌘ F', 'Search this board'], ['⌘ hold', 'Drag without snapping']]],
];

export class UI {
  constructor(ed, root, ctx) {
    this.ed = ed; this.root = root; this.ctx = ctx;
    this.ic = (name, o) => ctx.ico(name, o) || glyph(name, o);
    this.pop = null;
    this.ctxDirty = true;
    this.build();
    ed.on(w => this.onEvent(w));
  }

  /** True when a panel owns the keyboard. Escape still closes a popover (the others are left to their own fields). */
  captured(e) {
    if (e && e.key === 'Escape' && this.pop) { e.preventDefault(); this.closePop(); return true; }
    return !!(this.pop || this.searching);
  }

  // --- build -------------------------------------------------------------------------------------

  build() {
    const ed = this.ed, ic = this.ic, root = this.root;
    const mk = (cls, html, tag = 'div') => { const e = document.createElement(tag); e.className = cls; e.innerHTML = html || ''; root.appendChild(e); return e; };

    this.top = mk('bd-top', `
      <div class="bd-pill bd-title-pill">
        <a class="nw-ib nw-ib--soft nw-ib--sm" href="#/board" aria-label="Back to your boards" title="Back to your boards">${ic('arrow-left', { size: 18, sw: 1.6 })}</a>
        <input class="bd-title" aria-label="Board title" maxlength="120" spellcheck="false">
        <span class="bd-status" role="status" data-s="saved">Saved</span>
      </div>
      <span class="bd-spacer"></span>
      <div class="bd-pill">
        <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="search" aria-label="Search this board" title="Search this board (⌘F)">${ic('search', { size: 18, sw: 1.6 })}</button>
        <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="frames" aria-label="Frames" title="Frames">${ic('panel-left', { size: 18, sw: 1.6 })}</button>
        <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="templates" aria-label="Templates" title="Templates">${ic('layout-template', { size: 18, sw: 1.6 })}</button>
        <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="export" aria-label="Export" title="Export">${ic('download', { size: 18, sw: 1.6 })}</button>
        <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="help" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">${ic('keyboard', { size: 18, sw: 1.6 })}</button>
      </div>
      <button class="nw-btn nw-btn--primary" data-a="ask" type="button" title="Ask Claude to add notes">${ic('sparkles', { size: 20, cls: 'nw-btn__icon' })}<span>Ask Claude</span></button>`);
    this.title = this.top.querySelector('.bd-title');
    this.title.value = ed.doc.title;
    this.statusEl = this.top.querySelector('.bd-status');

    this.tools = mk('bd-tools bd-pill', TOOLS.map(([id, name, icon, key]) => `<button class="nw-ib nw-ib--sm bd-tool" data-tool="${id}" aria-label="${name}" title="${name} (${key})" aria-pressed="false">${ic(icon, { size: 20, sw: 1.6 })}</button>`).join('')
      + `<span class="bd-sep"></span><button class="nw-ib nw-ib--sm bd-tool" data-a="pick" aria-label="Add a picture or file" title="Add a picture or file (I)">${ic('image', { size: 20, sw: 1.6 })}</button>`, 'nav');
    this.tools.setAttribute('aria-label', 'Tools');
    this.fly = mk('bd-fly bd-pill'); this.fly.hidden = true;
    this.cbar = mk('bd-ctx bd-pill'); this.cbar.hidden = true;
    this.hist = mk('bd-hist bd-pill', `
      <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="undo" aria-label="Undo" title="Undo (⌘Z)">${ic('undo-2', { size: 18, sw: 1.6 })}</button>
      <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="redo" aria-label="Redo" title="Redo (⇧⌘Z)">${ic('redo-2', { size: 18, sw: 1.6 })}</button>`);
    this.zoom = mk('bd-zoom bd-pill', `
      <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="minimap" aria-label="Minimap" title="Minimap" aria-pressed="true">${ic('map', { size: 18, sw: 1.6 })}</button>
      <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="zout" aria-label="Zoom out" title="Zoom out (⌘−)">${ic('minus', { size: 18, sw: 1.6 })}</button>
      <button class="bd-zlabel" data-a="z100" title="Zoom to 100% (⇧0)">100%</button>
      <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="zin" aria-label="Zoom in" title="Zoom in (⌘+)">${ic('plus', { size: 18, sw: 1.6 })}</button>
      <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="fit" aria-label="Fit the board" title="Fit the board (⇧1)">${ic('maximize', { size: 18, sw: 1.6 })}</button>`);
    this.zlabel = this.zoom.querySelector('.bd-zlabel');
    this.search = mk('bd-search bd-pill', `${ic('search', { size: 18, sw: 1.6 })}<input type="search" placeholder="Search this board" aria-label="Search this board" spellcheck="false"><span class="bd-count" aria-live="polite"></span>
      <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="sprev" aria-label="Previous match">${ic('chevron-left', { size: 16, sw: 1.8 })}</button>
      <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="snext" aria-label="Next match">${ic('chevron-right', { size: 16, sw: 1.8 })}</button>
      <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="sclose" aria-label="Close search">${ic('x', { size: 16, sw: 1.8 })}</button>`);
    this.search.hidden = true;
    this.sbox = this.search.querySelector('input');
    this.frames = mk('bd-frames', '', 'aside'); this.frames.hidden = true;
    this.frames.setAttribute('aria-label', 'Frames');
    this.help = mk('bd-help', ''); this.help.hidden = true;

    root.addEventListener('click', e => this.click(e));
    root.addEventListener('pointerdown', e => { if (e.target.closest('.bd-pill, .bd-frames, .bd-pop, .bd-help')) e.stopPropagation(); }, true);
    this.title.addEventListener('input', () => ed.sync.setTitle(this.title.value.trim() || 'Untitled board'));
    this.title.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') this.title.blur(); });
    this.sbox.addEventListener('input', () => this.runSearch());
    this.sbox.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); this.stepSearch(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); this.closeSearch(); }
    });
    document.addEventListener('pointerdown', e => { if (this.pop && !e.target.closest('.bd-pop') && !e.target.closest('[data-pop]')) this.closePop(); }, true);
    this.refresh();
  }

  // --- events ------------------------------------------------------------------------------------

  onEvent(w) {
    const kind = typeof w === 'string' ? w : w.type;
    if (kind === 'selection' || kind === 'tool' || kind === 'doc' || kind === 'moving') this.ctxDirty = true;
    if (kind === 'tool') { this.paintTools(); this.paintFly(); }
    if (kind === 'selection') this.paintTools();
    if (kind === 'doc') { this.paintHist(); if (!this.frames.hidden) this.paintFrames(); }
    if (kind === 'title') this.title.value = this.ed.doc.title;
    if (kind === 'editing') this.ctxDirty = true;
  }

  refresh() { this.paintTools(); this.paintFly(); this.paintHist(); this.ctxDirty = true; }

  paintTools() {
    const t = this.ed.v.tool;
    for (const b of this.tools.querySelectorAll('[data-tool]')) {
      const on = b.dataset.tool === t || (b.dataset.tool === 'pen' && t === 'highlighter');
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('on', on);
    }
  }
  paintHist() {
    const d = this.ed.doc;
    this.hist.querySelector('[data-a=undo]').disabled = !d.undoStack.length;
    this.hist.querySelector('[data-a=redo]').disabled = !d.redoStack.length;
  }

  status(kind, msg) {
    const text = { saved: 'Saved', saving: 'Saving…', pending: 'Saving…', error: 'Not saved. Trying again…' }[kind];
    this.statusEl.dataset.s = kind; this.statusEl.textContent = text; this.statusEl.title = msg || '';
  }

  // --- flyouts -----------------------------------------------------------------------------------

  paintFly() {
    const ed = this.ed, t = ed.v.tool, ic = this.ic;
    let html = '';
    if (t === 'shape') {
      html = SHAPES.map((s, i) => `<button class="bd-shape${(ed.pref.shape || 'rect') === s ? ' on' : ''}" data-shape="${s}" aria-label="${SHAPE_NAMES[s]}" title="${SHAPE_NAMES[s]} (${i + 1} or ${SHAPE_KEYS[s].toUpperCase()})">${shapeGlyph(s)}</button>`).join('');
    } else if (t === 'pen' || t === 'highlighter') {
      const s = ed.drawing.settings(t), widths = t === 'pen' ? PEN_WIDTHS : HL_WIDTHS;
      html = `<div class="bd-seg">
          <button class="${t === 'pen' ? 'on' : ''}" data-tool="pen">${ic('pencil', { size: 16, sw: 1.7 })}<span>Pen</span></button>
          <button class="${t === 'highlighter' ? 'on' : ''}" data-tool="highlighter">${ic('highlighter', { size: 16, sw: 1.7 })}<span>Highlighter</span></button></div>
        <span class="bd-sep"></span>
        ${widths.map(w => `<button class="bd-width${s.width === w ? ' on' : ''}" data-width="${w}" aria-label="Width ${w}" title="Width ${w}"><i style="--w:${Math.min(w, 22)}px"></i></button>`).join('')}
        <span class="bd-sep"></span>${this.swatchRow(s.color, 'pencolor')}`;
    } else if (t === 'connector') {
      const cur = ed.pref.connector || 'elbow';
      html = ['straight', 'elbow', 'curved'].map(k => `<button class="nw-ib nw-ib--sm${cur === k ? ' on' : ''}" data-conn="${k}" aria-label="${cap(k)}" title="${cap(k)}">${ic(k === 'curved' ? 'spline' : k, { size: 18, sw: 1.7 })}</button>`).join('')
        + `<span class="bd-sep"></span><button class="bd-btn-text${(ed.pref.endHead || 'arrow') === 'arrow' ? ' on' : ''}" data-endhead="arrow">Arrow</button><button class="bd-btn-text${ed.pref.endHead === 'none' ? ' on' : ''}" data-endhead="none">Plain</button>`;
    }
    this.fly.innerHTML = html;
    this.fly.hidden = !html;
  }

  swatchRow(current, action, extra = '') {
    const cur = (current || '').toLowerCase();
    return `<span class="bd-swatches">${SWATCHES.map(c => `<button class="bd-sw${cur === c.toLowerCase() ? ' on' : ''}" data-${action}="${c}" style="--c:${c}" aria-label="${c}"></button>`).join('')}
      <label class="bd-sw bd-sw-custom" title="Any colour"><input type="color" data-${action}-custom value="${/^#[0-9a-f]{6}$/i.test(cur) ? cur : INK}" aria-label="Pick a colour"></label>${extra}</span>`;
  }

  // --- clicks ------------------------------------------------------------------------------------

  click(e) {
    const ed = this.ed, b = e.target.closest('button, [data-a]');
    if (!b || !this.root.contains(b)) return;
    const d = b.dataset;
    if (d.tool) { ed.setTool(d.tool); return; }
    if (d.shape) { ed.savePref({ shape: d.shape }); this.paintFly(); return; }
    if (d.width) { ed.savePref(ed.v.tool === 'highlighter' ? { hlWidth: +d.width } : { penWidth: +d.width }); this.paintFly(); return; }
    if (d.pencolor) { ed.savePref(ed.v.tool === 'highlighter' ? { hlColor: d.pencolor } : { penColor: d.pencolor }); this.paintFly(); return; }
    if (d.conn) { ed.savePref({ connector: d.conn }); this.paintFly(); return; }
    if (d.endhead) { ed.savePref({ endHead: d.endhead }); this.paintFly(); return; }
    if (d.cx) return this.ctxAction(d.cx, b, d);
    switch (d.a) {
      case 'undo': return ed.undo();
      case 'redo': return ed.redo();
      case 'zin': return ed.zoomBy(1.25);
      case 'zout': return ed.zoomBy(0.8);
      case 'z100': return ed.zoomTo(1);
      case 'fit': return ed.fit();
      case 'minimap': { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); ed.mini.show(on); ed.savePref({ minimap: on }); return; }
      case 'search': return this.openSearch();
      case 'sclose': return this.closeSearch();
      case 'snext': return this.stepSearch(1);
      case 'sprev': return this.stepSearch(-1);
      case 'frames': return this.toggleFrames();
      case 'help': return this.toggleHelp();
      case 'pick': return this.pickFiles();
      case 'templates': return ed.templates.open(b);
      case 'ask': return import('./ask.js').then(m => m.open(ed, b)).catch(e => ed.ctx.oops(e));
      case 'export': return ed.exporter.open(b);
      case 'frame-go': return ed.reveal(d.id), ed.select([d.id]);
      case 'frame-png': return ed.exporter.png({ frame: d.id });
    }
  }

  // --- the bar over a selection ----------------------------------------------------------------

  /** Called every frame: keep the bar attached to the selection. */
  tick() {
    const ed = this.ed, cam = ed.cam;
    const zl = Math.round(cam.z * 100) + '%';
    if (this.zlabel.textContent !== zl) this.zlabel.textContent = zl;
    if (!this.ctxDirty && this.lastCam === `${cam.x}|${cam.y}|${cam.z}`) return;
    this.lastCam = `${cam.x}|${cam.y}|${cam.z}`;
    const sel = ed.selected(), el = this.cbar;
    if (!sel.length || ed.v.editing || (this.ctxDirty && ed.input.g && ed.input.g.type === 'marquee')) { el.hidden = true; this.ctxDirty = false; return; }
    if (this.ctxDirty || this.ctxKey !== this.keyOf(sel)) { this.paintCtx(sel); this.ctxKey = this.keyOf(sel); }
    this.ctxDirty = false;
    const bb = ed.selectionBox() || ed.bounds(sel);
    if (!bb) { el.hidden = true; return; }
    const tl = cam.toScreen(bb.x, bb.y), br = cam.toScreen(bb.x + bb.w, bb.y + bb.h);
    el.hidden = false;
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = (tl.x + br.x) / 2 - w / 2, y = tl.y - h - 14;
    if (y < 64) y = Math.min(br.y + 14, cam.h - h - 70);
    el.style.transform = `translate(${Math.round(Math.max(76, Math.min(x, cam.w - w - 12)))}px, ${Math.round(Math.max(64, y))}px)`;
  }
  keyOf(sel) { return sel.map(o => o.id + o.type + (o.color || '') + (o.shape || '')).join(',').slice(0, 400); }

  paintCtx(sel) {
    const ed = this.ed, ic = this.ic, one = sel.length === 1 ? sel[0] : null;
    const types = new Set(sel.map(o => o.type));
    const only = types.size === 1 ? [...types][0] : null;
    const first = sel[0];
    const g = [];
    const btn = (cx, icon, label, extra = '') => `<button class="nw-ib nw-ib--sm" data-cx="${cx}" aria-label="${label}" title="${label}"${extra}>${ic(icon, { size: 18, sw: 1.6 })}</button>`;
    const chip = (cx, color, label) => `<button class="bd-chip" data-cx="${cx}" data-pop aria-label="${label}" title="${label}" style="--c:${color}"></button>`;
    const textOn = sel.filter(o => 'text' in o || o.type === 'connector');
    if (only === 'sticky') g.push(chip('stickycolor', STICKY[first.color] || STICKY.light_yellow, 'Colour'));
    if (only === 'shape') {
      g.push(`<button class="nw-ib nw-ib--sm" data-cx="shapekind" data-pop aria-label="Shape" title="Shape">${shapeGlyph(first.shape)}</button>`);
      g.push(chip('fill', first.fill || 'transparent', 'Fill'), `<button class="bd-chip ring" data-cx="stroke" data-pop aria-label="Border colour" title="Border colour" style="--c:${first.stroke || 'currentColor'}"></button>`);
      g.push(`<button class="bd-btn-text" data-cx="border" data-pop title="Border width and style">${first.stroke_width === 0 ? 'No border' : (first.stroke_width || 2) + ' px'}</button>`);
    }
    if (only === 'text' || only === 'node' || only === 'frame') g.push(chip('fill', first.fill || 'transparent', only === 'frame' ? 'Frame colour' : 'Fill'));
    if (only === 'connector') {
      g.push(`<button class="nw-ib nw-ib--sm" data-cx="connkind" data-pop aria-label="Line type" title="Line type">${ic(first.shape === 'curved' ? 'spline' : first.shape, { size: 18, sw: 1.6 })}</button>`);
      g.push(`<button class="bd-btn-text" data-cx="heads" data-pop title="Arrowheads">Ends</button>`);
      g.push(chip('linecolor', first.color || 'currentColor', 'Line colour'), `<button class="bd-btn-text" data-cx="border" data-pop title="Line width and style">${first.width || 2} px</button>`);
    }
    if (only === 'draw') g.push(chip('linecolor', first.color, 'Colour'), `<button class="bd-btn-text" data-cx="strokew" data-pop title="Width">${first.width} px</button>`);
    if (textOn.length && !['draw'].includes(only)) {
      const st = T.style(first), size = st.size === 'auto' ? 'Auto' : Math.round(st.size);
      g.push(`<span class="bd-sep"></span>
        <button class="bd-btn-text" data-cx="font" data-pop title="Font" style="font-family:${T.famOf(st.face)}">${T.FACES[st.face || 'ui'].label}</button>
        <button class="nw-ib nw-ib--sm" data-cx="size-" aria-label="Smaller text" title="Smaller text">${ic('minus', { size: 16, sw: 1.8 })}</button>
        <button class="bd-btn-text" data-cx="size-auto" title="${first.type === 'sticky' ? 'Fit text to the note' : 'Text size'}">${size}</button>
        <button class="nw-ib nw-ib--sm" data-cx="size+" aria-label="Larger text" title="Larger text">${ic('plus', { size: 16, sw: 1.8 })}</button>
        ${btn('bold', 'bold', 'Bold (⌘B)', st.bold ? ' class="nw-ib nw-ib--sm on"' : '')}${btn('italic', 'italic', 'Italic (⌘I)', st.italic ? ' class="nw-ib nw-ib--sm on"' : '')}${btn('underline', 'underline', 'Underline (⌘U)', st.underline ? ' class="nw-ib nw-ib--sm on"' : '')}
        ${btn('align', `align-${st.align}`, 'Align')}<button class="bd-chip ring tc" data-cx="textcolor" data-pop aria-label="Text colour" title="Text colour" style="--c:${st.color || 'currentColor'}">A</button>`);
    }
    if (g.length) g.push('<span class="bd-sep"></span>');
    if (sel.length > 1 && sel.some(o => !o.group)) g.push(btn('group', 'group', 'Group (⌘G)'));
    if (sel.some(o => o.group)) g.push(btn('ungroup', 'layers', 'Ungroup (⇧⌘G)'));
    if (sel.some(o => o.type !== 'connector' && o.type !== 'frame')) g.push(btn('frame', 'frame', 'Put in a frame (F)'));
    g.push(btn('forward', 'arrow-up', 'Bring forward (⌘])'), btn('back', 'layers', 'Send to back (⇧⌘[)'));
    g.push(btn('lock', sel.every(o => o.locked) ? 'unlock' : 'lock', sel.every(o => o.locked) ? 'Unlock (⇧⌘L)' : 'Lock (⇧⌘L)'));
    g.push(btn('dup', 'copy', 'Duplicate (⌘D)'), btn('del', 'trash-2', 'Delete'));
    if (one && one.type === 'link') g.push(btn('open', 'link', 'Open the page'));
    if (one && one.type === 'file') g.push(btn('open', 'file', 'Open the file'));
    if (one && one.type === 'frame') g.push(btn('png', 'download', 'Export this frame as PNG'));
    this.cbar.innerHTML = g.join('');
  }

  ctxAction(a, b, d) {
    const ed = this.ed, sel = ed.selected(), first = sel[0];
    switch (a) {
      case 'del': return ed.remove();
      case 'dup': return ed.duplicate();
      case 'lock': return ed.lock();
      case 'group': return ed.group();
      case 'ungroup': return ed.ungroup();
      case 'frame': return ed.frameSelection();
      case 'forward': return ed.arrange('forward');
      case 'back': return ed.arrange('back');
      case 'bold': case 'italic': case 'underline': return ed.setText({ [a]: !T.style(first)[a] });
      case 'align': return ed.setText({ align: { left: 'center', center: 'right', right: 'left' }[T.style(first).align] });
      case 'size+': case 'size-': {
        const st = T.style(first), cur = st.size === 'auto' ? T.layout(first).fs : st.size;
        return ed.setText({ size: Math.max(8, Math.min(200, Math.round(cur * (a === 'size+' ? 1.15 : 0.87)))) });
      }
      case 'size-auto': return ed.setText({ size: 'auto' });
      case 'open': return first.type === 'link' ? window.open(first.url, '_blank', 'noopener') : ed.openFile(first);
      case 'png': return ed.exporter.png({ frame: first.id });
      default: return this.ctxPop(a, b);
    }
  }

  ctxPop(a, b) {
    const ed = this.ed, first = ed.selected()[0], ic = this.ic;
    let html = '';
    const sw = (current, action, extra = '') => this.swatchRow(current, action, extra);
    if (a === 'stickycolor') html = `<div class="bd-grid">${STICKY_KEYS.map(k => `<button class="bd-sw lg${first.color === k ? ' on' : ''}" data-set-sticky="${k}" style="--c:${STICKY[k]}" aria-label="${k.replace('_', ' ')}" title="${k.replace('_', ' ')}"></button>`).join('')}</div>`;
    else if (a === 'fill') html = sw(first.fill, 'setfill', '<button class="bd-btn-text" data-setfill="">None</button>');
    else if (a === 'stroke') html = sw(first.stroke, 'setstroke');
    else if (a === 'linecolor') html = sw(first.color, 'setline');
    else if (a === 'font') html = `<div class="bd-fonts">${Object.entries(T.FACES).map(([k, v]) => `<button class="bd-font${(T.style(first).face || 'ui') === k ? ' on' : ''}" data-setfont="${k}" style="font-family:${T.famOf(k)}">${v.label}</button>`).join('')}</div>`;
    else if (a === 'textcolor') html = sw(T.style(first).color, 'settext', '<button class="bd-btn-text" data-settext="">Automatic</button>');
    else if (a === 'shapekind') html = `<div class="bd-grid c4">${SHAPES.map(s => `<button class="bd-shape${first.shape === s ? ' on' : ''}" data-setshape="${s}" title="${SHAPE_NAMES[s]}" aria-label="${SHAPE_NAMES[s]}">${shapeGlyph(s)}</button>`).join('')}</div>`;
    else if (a === 'connkind') html = ['straight', 'elbow', 'curved'].map(k => `<button class="bd-btn-text${first.shape === k ? ' on' : ''}" data-setconn="${k}">${ic(k === 'curved' ? 'spline' : k, { size: 16, sw: 1.7 })}<span>${cap(k)}</span></button>`).join('');
    else if (a === 'heads') html = `<div class="bd-heads"><b>Start</b>${HEADS.map(([k, n]) => `<button class="bd-btn-text${first.start_head === k ? ' on' : ''}" data-sethead="start_head:${k}">${n}</button>`).join('')}</div><div class="bd-heads"><b>End</b>${HEADS.map(([k, n]) => `<button class="bd-btn-text${first.end_head === k ? ' on' : ''}" data-sethead="end_head:${k}">${n}</button>`).join('')}</div>`;
    else if (a === 'border') {
      const key = first.type === 'connector' ? 'width' : 'stroke_width', cur = first[key] ?? 2;
      html = `<div class="bd-heads"><b>Width</b>${(first.type === 'connector' ? [1, 2, 4, 6] : [0, 1, 2, 4, 8]).map(w => `<button class="bd-btn-text${cur === w ? ' on' : ''}" data-setw="${key}:${w}">${w || 'None'}</button>`).join('')}</div>
        <div class="bd-heads"><b>Style</b>${['solid', 'dashed', 'dotted'].map(k => `<button class="bd-btn-text${(first.dash || 'solid') === k ? ' on' : ''}" data-setdash="${k}">${cap(k)}</button>`).join('')}</div>`;
    } else if (a === 'strokew') html = `<div class="bd-heads"><b>Width</b>${(first.tool === 'highlighter' ? HL_WIDTHS : PEN_WIDTHS).map(w => `<button class="bd-btn-text${first.width === w ? ' on' : ''}" data-setw="width:${w}">${w}</button>`).join('')}</div>`;
    this.popup(b, html, el => {
      const on = (sel, fn) => el.querySelectorAll(sel).forEach(x => x.addEventListener('click', () => fn(x)));
      el.querySelectorAll('input[type=color]').forEach(inp => {
        const name = Object.keys(inp.dataset).find(k => k.endsWith('Custom'));
        inp.addEventListener('input', () => this.applyColor(name.replace('Custom', ''), inp.value));
      });
      for (const [attr, action] of [['setfill', 'setfill'], ['setstroke', 'setstroke'], ['setline', 'setline'], ['settext', 'settext']]) on(`[data-${attr}]`, x => this.applyColor(action, x.dataset[attr] || null));
      on('[data-set-sticky]', x => { ed.set({ color: x.dataset.setSticky }); ed.savePref({ sticky: x.dataset.setSticky }); this.closePop(); });
      on('[data-setshape]', x => { ed.set({ shape: x.dataset.setshape }); ed.savePref({ shape: x.dataset.setshape }); this.closePop(); });
      on('[data-setconn]', x => { ed.set({ shape: x.dataset.setconn }); ed.savePref({ connector: x.dataset.setconn }); this.closePop(); });
      on('[data-sethead]', x => { const [k, v] = x.dataset.sethead.split(':'); ed.set({ [k]: v }); this.ctxPop('heads', b); });
      on('[data-setw]', x => { const [k, v] = x.dataset.setw.split(':'); ed.set({ [k]: +v }); this.ctxPop(a, b); });
      on('[data-setfont]', x => { ed.setText({ font: x.dataset.setfont }); this.closePop(); });
      on('[data-setdash]', x => { ed.set({ dash: x.dataset.setdash }); this.ctxPop(a, b); });
    });
  }

  applyColor(action, v) {
    const ed = this.ed;
    if (action === 'setfill') ed.set({ fill: v });
    else if (action === 'setstroke') ed.set({ stroke: v });
    else if (action === 'setline') ed.set(o => (o.type === 'connector' ? { color: v } : o.type === 'draw' ? { color: v || o.color } : {}));
    else if (action === 'settext') ed.setText({ color: v });
    this.ctxDirty = true;
  }

  // --- popovers ----------------------------------------------------------------------------------

  popup(anchor, html, mount, { cls = '', where = 'below' } = {}) {
    this.closePop();
    const el = document.createElement('div');
    el.className = `bd-pop bd-pill ${cls}`;
    el.innerHTML = html;
    el.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closePop(); } });
    this.root.appendChild(el);
    const r = anchor.getBoundingClientRect(), host = this.root.getBoundingClientRect();
    const w = el.offsetWidth, h = el.offsetHeight;
    let x = r.left - host.left + r.width / 2 - w / 2, y = r.bottom - host.top + 10;
    if (where === 'above' || y + h > host.height - 12) y = r.top - host.top - h - 10;
    if (where === 'right') { x = r.right - host.left + 12; y = r.top - host.top; }
    el.style.left = Math.max(12, Math.min(x, host.width - w - 12)) + 'px';
    el.style.top = Math.max(60, Math.min(y, host.height - h - 12)) + 'px';
    this.pop = el; this.popAnchor = anchor;
    if (mount) mount(el);
    return el;
  }
  closePop() { if (this.pop) { this.pop.remove(); this.pop = null; this.root.focus({ preventScroll: true }); } }
  escape() { if (this.pop) this.closePop(); else if (!this.help.hidden) this.toggleHelp(); else if (!this.search.hidden) this.closeSearch(); }

  // --- search ------------------------------------------------------------------------------------

  openSearch() { this.search.hidden = false; this.searching = true; this.sbox.focus(); this.sbox.select(); this.runSearch(); }
  closeSearch() { this.search.hidden = true; this.searching = false; this.ed.v.hl = new Set(); this.hits = []; this.ed.invalidate(); this.root.focus({ preventScroll: true }); }
  runSearch() {
    const q = this.sbox.value.trim().toLowerCase(), ed = this.ed;
    this.hits = q ? ed.doc.list().filter(o => [o.text, o.title, o.label, o.name, o.url, o.desc].some(s => s && String(s).toLowerCase().includes(q)) && !ed.v.hidden.has(o.id)).map(o => o.id) : [];
    ed.v.hl = new Set(this.hits);
    this.at = -1;
    this.search.querySelector('.bd-count').textContent = q ? (this.hits.length ? `${this.hits.length} found` : 'No matches') : '';
    ed.invalidate();
    if (this.hits.length) this.stepSearch(1);
  }
  stepSearch(d) {
    if (!this.hits || !this.hits.length) return;
    this.at = (this.at + d + this.hits.length) % this.hits.length;
    const id = this.hits[this.at];
    this.ed.reveal(id);
    this.ed.select([id], { quiet: true });
    this.search.querySelector('.bd-count').textContent = `${this.at + 1} of ${this.hits.length}`;
  }

  // --- frames list -------------------------------------------------------------------------------

  toggleFrames() { this.frames.hidden = !this.frames.hidden; if (!this.frames.hidden) this.paintFrames(); this.root.classList.toggle('with-frames', !this.frames.hidden); }
  paintFrames() {
    const fs = this.ed.doc.list().filter(o => o.type === 'frame');
    this.frames.innerHTML = `<h2 class="bd-h">Frames</h2>` + (fs.length ? `<ol>${fs.map((f, i) => `
      <li><button class="bd-frame-row" data-a="frame-go" data-id="${f.id}"><span class="n">${i + 1}</span><span class="t">${esc(f.title || 'Untitled frame')}</span></button>
        <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="frame-png" data-id="${f.id}" aria-label="Export ${esc(f.title || 'frame')} as PNG" title="Export as PNG">${this.ic('download', { size: 16, sw: 1.7 })}</button></li>`).join('')}</ol>`
      : '<p class="hint">No frames yet. Press F and drag, or select things and press F.</p>');
  }

  // --- help, files -------------------------------------------------------------------------------

  toggleHelp() {
    const h = this.help;
    if (h.hidden) {
      h.innerHTML = `<div class="bd-help-card nw-card nw-card--raised"><div class="bd-help-head"><h2 class="nw-h2">Keyboard <em>shortcuts</em></h2>
        <button class="nw-ib nw-ib--soft nw-ib--sm" data-a="help" aria-label="Close">${this.ic('x', { size: 18, sw: 1.6 })}</button></div>
        <div class="bd-help-grid">${SHORTCUTS.map(([t, rows]) => `<section><h3 class="nw-label">${t}</h3><dl>${rows.map(([k, v]) => `<div><dt>${k.split(' ').map(x => `<kbd>${esc(x)}</kbd>`).join('')}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>`).join('')}</div></div>`;
    }
    h.hidden = !h.hidden;
  }

  pickFiles() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = true;
    inp.onchange = () => { if (inp.files.length) import('./files.js').then(m => m.importFiles(this.ed, [...inp.files], this.ed.viewCenter())); };
    inp.click();
  }
}

const cap = s => s[0].toUpperCase() + s.slice(1);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A little drawing of a shape, for the shape pickers. */
export function shapeGlyph(kind) {
  const d = {
    rect: '<rect x="3" y="5" width="18" height="14" rx="1"/>', round: '<rect x="3" y="5" width="18" height="14" rx="5"/>', ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
    diamond: '<path d="M12 3 21 12 12 21 3 12Z"/>', triangle: '<path d="M12 4 21 20H3Z"/>', hexagon: '<path d="M7 5h10l5 7-5 7H7l-5-7Z"/>',
    cylinder: '<path d="M4 7a8 3 0 0 1 16 0v10a8 3 0 0 1-16 0Z"/><path d="M4 7a8 3 0 0 0 16 0"/>', arrow: '<path d="M3 9h11V4l7 8-7 8v-5H3Z"/>',
  }[kind] || '';
  return `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}
