// The notebooks canvas: an endless page to write anywhere on, draw the arrows you would draw on paper,
// circle things, and then ask it to make sense. Everything about it lives in this file and canvas.css;
// the rest of the app only mounts it:  const view = mountCanvas(host, notebook, ctx);  await view.destroy();
//
// World units are pixels at zoom 1, origin anywhere. Items: text, shape, image. Links: arrows, whose ends are
// an item id or a point {x, y} on empty paper. The server turns it into a page for make_sense (notebooks.py).

const PAD = 6;                 // how far an arrow stops short of a note (matches canvas.py)
const MIN_Z = 0.1, MAX_Z = 4;
const THREADS = 6;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => 'c' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

export function mountCanvas(host, nb, ctx) {
  const { ds, ico, esc, send, toast, oops, sheet, ask, guarded, go } = ctx;
  const st = {
    id: nb.id, rev: nb.rev, title: nb.title, color: nb.color, items: nb.items, links: nb.links,
    view: { ...nb.view }, senseOpen: !!nb.sense_open, sense: nb.sense, senseHtml: nb.sense_html,
    narration: nb.narration, canNarrate: nb.can_narrate,
    tool: 'select', sel: new Set(), selLink: null, editing: null, editingIsNew: false,
    status: 'saved', version: 0, savedVersion: 0, saving: false, timer: 0,
    past: [], future: [], last: '', preview: null, spaceDown: false, hl: new Set(),
  };
  const els = new Map();            // item id -> element
  const pointers = new Map();       // active pointers, for pinch
  let drag = null, pinch = null, raf = 0, destroyed = false;

  // ---------------------------------------------------------------------------------------------- build
  const toolList = [['select', 'Select', 'mouse-pointer-2'], ['text', 'Write', 'type'], ['arrow', 'Draw arrow', 'move-up-right'],
                    ['shape', 'Circle things', null], ['photo', 'Add a photo', 'image']];
  host.innerHTML = `
    <div class="cv" tabindex="0" aria-label="Notebook canvas">
      <div class="cv-dots"></div>
      <div class="cv-world">
        <svg class="cv-links" aria-hidden="true"><defs>
          <marker id="cv-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="cv-ah" d="M0 0 10 5 0 10z"/></marker>
          <marker id="cv-ah-sel" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="cv-ah-sel" d="M0 0 10 5 0 10z"/></marker>
          <marker id="cv-ah-start" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="cv-ah" d="M10 0 0 5 10 10z"/></marker>
          <marker id="cv-ah-start-sel" viewBox="0 0 10 10" refX="2" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path class="cv-ah-sel" d="M10 0 0 5 10 10z"/></marker>
          <pattern id="cv-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="7" stroke="currentColor" stroke-width="1"/></pattern>
        </defs><g class="links"></g></svg>
        <div class="cv-layer" id="cv-back"></div>
        <div class="cv-layer" id="cv-fore"></div>
        <div class="cv-layer" id="cv-ui"></div>
      </div>
      <div class="cv-empty" hidden>${ds.illustration('empty-journal', { size: 170, still: true })}
        <p>An empty page. Double-click anywhere to write.</p>
        <p class="hint">Drag from the dot beside a note to draw an arrow. Circle things with the circle tool. Then press Make sense.</p></div>
      <div class="cv-top">
        <div class="cv-title-pill">
          <a class="nw-ib nw-ib--soft nw-ib--sm" href="#/notebooks" aria-label="Back to your notebooks" title="Back to your notebooks">${ico('arrow-left', { size: 18, sw: 1.6 })}</a>
          <input class="cv-title" aria-label="Notebook title" value="${esc(st.title)}" maxlength="120">
          <span class="cv-status" data-s="saved" role="status">Saved</span>
        </div>
        <span class="spacer"></span>
        <button class="nw-btn nw-btn--secondary" id="cv-sense-btn" type="button" aria-pressed="false">${ico('sparkles', { size: 20, cls: 'nw-btn__icon' })}<span class="lbl">Make sense</span></button>
        <button class="nw-btn nw-btn--primary" id="cv-share" type="button">${ico('share', { size: 20, cls: 'nw-btn__icon' })}<span class="lbl">Share</span></button>
        <button class="nw-ib nw-ib--soft" id="cv-more" type="button" aria-label="Notebook options" title="Notebook options">${ico('ellipsis', { size: 22 })}</button>
      </div>
      <nav class="cv-tools nw-tabs" role="tablist" aria-label="Tools" style="--nw-c:var(--sky);--nw-oc:var(--ink-900)">
        ${toolList.map(([id, label, icon]) => `<button type="button" role="tab" class="nw-tabs__item" data-tool="${id}" aria-selected="${id === 'select'}" aria-label="${label}" title="${label}">${icon ? ico(icon, { size: 24, sw: 1.6 }) : `<svg class="nw-icon" width="26" height="26" viewBox="-4 -4 108 108" fill="none" stroke="currentColor" stroke-width="5" stroke-dasharray="13 9" stroke-linejoin="round" aria-hidden="true"><path d="${ds.SHAPES.blob[0]}"/></svg>`}</button>`).join('')}
      </nav>
      <div class="cv-cluster cv-hist"><button class="nw-ib nw-ib--ghost nw-ib--sm" id="cv-undo" type="button" aria-label="Undo" title="Undo">${ico('undo-2', { size: 18 })}</button>
        <button class="nw-ib nw-ib--ghost nw-ib--sm" id="cv-redo" type="button" aria-label="Redo" title="Redo">${ico('redo-2', { size: 18 })}</button></div>
      <div class="cv-cluster cv-zoom"><button class="nw-ib nw-ib--ghost nw-ib--sm" id="cv-zout" type="button" aria-label="Zoom out" title="Zoom out">${ico('minus', { size: 18 })}</button>
        <button class="pct" id="cv-pct" type="button" title="Back to 100%">100%</button>
        <button class="nw-ib nw-ib--ghost nw-ib--sm" id="cv-zin" type="button" aria-label="Zoom in" title="Zoom in">${ico('plus', { size: 18 })}</button>
        <button class="nw-ib nw-ib--ghost nw-ib--sm" id="cv-fit" type="button" aria-label="See everything" title="See everything">${ico('maximize', { size: 18 })}</button></div>
      <div class="cv-float" hidden></div>
      <aside class="cv-sense" aria-label="What the notebook says"></aside>
    </div>`;
  const $ = s => host.querySelector(s);
  const cv = $('.cv'), world = $('.cv-world'), back = $('#cv-back'), fore = $('#cv-fore'), uiLayer = $('#cv-ui');
  const linksG = $('.cv-links .links'), floatEl = $('.cv-float'), drawer = $('.cv-sense'), statusEl = $('.cv-status');

  // ---------------------------------------------------------------------------------------------- geometry
  const byId = id => st.items.find(i => i.id === id);
  const toWorld = (cx, cy) => { const r = cv.getBoundingClientRect(); return { x: (cx - r.left - st.view.x) / st.view.z, y: (cy - r.top - st.view.y) / st.view.z }; };
  const toScreen = (x, y) => ({ x: st.view.x + x * st.view.z, y: st.view.y + y * st.view.z });
  const rectOf = i => ({ x: i.x, y: i.y, w: i.w || 0, h: i.h || 0 });
  function endRect(e) {
    if (e && typeof e === 'object') return { x: e.x, y: e.y, w: 0, h: 0, free: true };
    const i = byId(e); return i ? rectOf(i) : null;
  }
  function edgePt(b, toward, pad) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = toward[0] - cx, dy = toward[1] - cy, n = Math.hypot(dx, dy) || 1;
    let t = Math.min(dx ? (b.w / 2) / Math.abs(dx) : Infinity, dy ? (b.h / 2) / Math.abs(dy) : Infinity);
    if (t > 1) t = 0;
    return [cx + dx * t + dx / n * pad, cy + dy * t + dy / n * pad];
  }
  // The same arithmetic as canvas.py: a positive bend bows to the right of the way the arrow points.
  function geom(a, b, bend = 0) {
    const ac = [a.x + a.w / 2, a.y + a.h / 2], bc = [b.x + b.w / 2, b.y + b.h / 2];
    const dx = bc[0] - ac[0], dy = bc[1] - ac[1], len = Math.hypot(dx, dy);
    const c = bend && len ? [(ac[0] + bc[0]) / 2 - dy * bend, (ac[1] + bc[1]) / 2 + dx * bend] : null;
    const p1 = edgePt(a, c || bc, a.free ? 0 : PAD), p2 = edgePt(b, c || ac, b.free ? 0 : PAD);
    const mid = c ? [(p1[0] + 2 * c[0] + p2[0]) / 4, (p1[1] + 2 * c[1] + p2[1]) / 4] : [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
    return { p1, p2, c, mid, ac, bc, len };
  }
  const linkGeom = l => { const a = endRect(l.from), b = endRect(l.to); return a && b ? geom(a, b, l.bend || 0) : null; };
  const pathOf = g => g.c ? `M${g.p1[0]} ${g.p1[1]}Q${g.c[0]} ${g.c[1]} ${g.p2[0]} ${g.p2[1]}` : `M${g.p1[0]} ${g.p1[1]}L${g.p2[0]} ${g.p2[1]}`;
  function boundsOf(ids) {
    const rs = (ids ? ids.map(byId).filter(Boolean) : st.items).map(rectOf);
    if (!rs.length) return null;
    const x0 = Math.min(...rs.map(r => r.x)), y0 = Math.min(...rs.map(r => r.y));
    return { x: x0, y: y0, w: Math.max(...rs.map(r => r.x + r.w)) - x0, h: Math.max(...rs.map(r => r.y + r.h)) - y0 };
  }
  const threadOf = () => { const m = new Map(); (st.sense?.threads || []).forEach((t, n) => t.ids.forEach(i => m.set(i, n))); return m; };

  // ---------------------------------------------------------------------------------------------- view
  function applyView() {
    const { x, y, z } = st.view, gs = 24 * z;
    world.style.transform = `translate(${x}px,${y}px) scale(${z})`;
    world.style.setProperty('--iz', 1 / z);
    cv.style.setProperty('--gs', gs + 'px'); cv.style.setProperty('--gx', (x % gs) + 'px'); cv.style.setProperty('--gy', (y % gs) + 'px');
    $('#cv-pct').textContent = Math.round(z * 100) + '%';
    placeFloat();
  }
  function setView(v, { fly = false, save = true } = {}) {
    st.view = { x: v.x, y: v.y, z: clamp(v.z, MIN_Z, MAX_Z) };
    if (fly) { world.classList.add('fly'); setTimeout(() => world.classList.remove('fly'), 460); }
    applyView();
    if (save) { st.version++; scheduleSave(1800); }
  }
  function zoomAt(cx, cy, factor) {
    const r = cv.getBoundingClientRect(), z = clamp(st.view.z * factor, MIN_Z, MAX_Z), k = z / st.view.z;
    const px = cx - r.left, py = cy - r.top;
    setView({ x: px - (px - st.view.x) * k, y: py - (py - st.view.y) * k, z });
  }
  function fitTo(b, { maxZ = 1.25, margin = 90, fly = true } = {}) {
    const r = cv.getBoundingClientRect();
    // the drawer covers part of the paper: fit into what it leaves free
    const phone = r.width <= 700, hideR = st.senseOpen && !phone ? drawer.offsetWidth + 24 : 0, hideB = st.senseOpen && phone ? drawer.offsetHeight + 12 : 0;
    const W = r.width - hideR, H = r.height - hideB;
    if (!b) return setView({ x: W * 0.3, y: H * 0.3, z: 1 }, { fly });
    const z = clamp(Math.min((W - margin * 2) / Math.max(b.w, 1), (H - margin * 2) / Math.max(b.h, 1)), MIN_Z, maxZ);
    setView({ x: W / 2 - (b.x + b.w / 2) * z, y: H / 2 - (b.y + b.h / 2) * z, z }, { fly });
  }

  // ---------------------------------------------------------------------------------------------- render: items
  function makeEl(it) {
    let el;
    if (it.type === 'shape') {
      const t = document.createElement('template');
      const shapeKind = it.shape === 'box' ? 'square' : (it.shape || 'blob');
      const shapePath = (ds.SHAPES[shapeKind] || ds.SHAPES.blob)[0];
      t.innerHTML = `<svg class="it shape" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="false"><path class="fillp" d="${shapePath}" fill="url(#cv-hatch)" stroke="none" opacity=".55"/>
        <path class="edge" d="${shapePath}" fill="none" stroke="var(--line-strong)" stroke-width="1.5" stroke-dasharray="6 5" vector-effect="non-scaling-stroke"/>
        <path class="ring" d="${shapePath}" fill="none" stroke="transparent" stroke-width="12" vector-effect="non-scaling-stroke"/></svg>`;
      el = t.content.firstElementChild;
    } else if (it.type === 'image') {
      el = document.createElement('img'); el.alt = 'A photo of a page'; el.draggable = false;
      el.className = 'it image';
      if (ctx.assetUrl) ctx.assetUrl(st.id, it.src).then(u => { el.src = u; }).catch(() => {});   // the website keeps photos in Firestore
      else el.src = `/api/notebooks/${st.id}/assets/${it.src}`;
    } else { el = document.createElement('div'); el.className = 'it text'; }
    el.dataset.id = it.id;
    return el;
  }
  function syncEl(el, it) {
    el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
    if (it.type === 'text') {
      if (st.editing !== it.id && el.textContent !== it.text) el.textContent = it.text;
      el.classList.toggle('u', !!it.underline); el.classList.toggle('c', !!it.caps); el.classList.toggle('fixed', !!it.fixed);
      if (it.fixed) el.style.setProperty('--w', it.w + 'px'); else el.style.removeProperty('--w');
      ['size-heading', 'size-title'].forEach(c => el.classList.remove(c));
      if (it.size === 'heading' || it.size === 'title') el.classList.add(`size-${it.size}`);
      el.classList.toggle('align-center', it.align === 'center');
      ['tint-sky', 'tint-mint', 'tint-blush', 'tint-sun', 'tint-violet', 'tint-tangerine', 'tint-berry'].forEach(c => el.classList.remove(c));
      if (it.color) el.classList.add(`tint-${it.color}`);
    } else if (it.type === 'shape') {
      el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
      const shapeKind = it.shape === 'box' ? 'square' : (it.shape || 'blob');
      const shapePath = (ds.SHAPES[shapeKind] || ds.SHAPES.blob)[0];
      el.querySelectorAll('path').forEach(p => { if (p.getAttribute('d') !== shapePath) p.setAttribute('d', shapePath); });
      ['fill-hatch', 'fill-tint', 'fill-outline'].forEach(c => el.classList.remove(c));
      el.classList.add(`fill-${it.fill || 'hatch'}`);
      ['stroke-dashed', 'stroke-solid', 'stroke-dotted'].forEach(c => el.classList.remove(c));
      el.classList.add(`stroke-${it.stroke || 'dashed'}`);
      ['tint-sky', 'tint-mint', 'tint-blush', 'tint-sun', 'tint-violet', 'tint-tangerine', 'tint-berry'].forEach(c => el.classList.remove(c));
      if (it.color) el.classList.add(`tint-${it.color}`);
    } else if (it.type === 'image') {
      const rot = ((it.rot || 0) % 4 + 4) % 4;
      if (rot === 1 || rot === 3) {
        el.style.width = it.h + 'px';
        el.style.height = it.w + 'px';
        const dx = (it.w - it.h) / 2, dy = (it.h - it.w) / 2;
        el.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot * 90}deg)`;
      } else {
        el.style.width = it.w + 'px';
        el.style.height = it.h + 'px';
        el.style.transform = rot === 2 ? 'rotate(180deg)' : '';
      }
    }
    el.style.zIndex = it.type === 'image' ? (it.z_order === 'front' ? 2 : 0) : it.type === 'shape' ? 1 : 3;
    el.classList.toggle('picked', st.sel.has(it.id)); el.classList.toggle('hl', st.hl.has(it.id));
    for (let n = 0; n < THREADS; n++) el.classList.remove('th' + n);
    if (it.type === 'text' && st.senseOpen) { const n = threadOf().get(it.id); if (n !== undefined) el.classList.add('th' + (n % THREADS)); }
  }
  function measure() {
    let changed = false;
    for (const it of st.items) {
      if (it.type !== 'text') continue;
      const el = els.get(it.id); if (!el) continue;
      const w = el.offsetWidth, h = el.offsetHeight;
      if (Math.abs(w - it.w) > 1 || Math.abs(h - it.h) > 1) { it.w = w; it.h = h; changed = true; }
    }
    return changed;
  }
  function renderItems() {
    const seen = new Set();
    const th = threadOf();
    for (const it of st.items) {
      let el = els.get(it.id);
      if (!el) { el = makeEl(it); els.set(it.id, el); (it.type === 'text' ? fore : back).appendChild(el); }
      syncEl(el, it); seen.add(it.id);
    }
    for (const [id, el] of els) if (!seen.has(id)) { el.remove(); els.delete(id); }
    world.classList.toggle('tinted', st.senseOpen);
    if (measure()) { st.version++; scheduleSave(900); }
    $('.cv-empty').hidden = st.items.length > 0 || st.editing;
    return th;
  }

  // ---------------------------------------------------------------------------------------------- render: arrows
  function renderLinks() {
    const th = threadOf();
    let svg = '', labels = '';
    for (const l of st.links) {
      const g = linkGeom(l); if (!g) continue;
      const sel = st.selLink === l.id;
      const a = typeof l.from === 'string' ? th.get(l.from) : undefined;
      const heads = l.heads || 'forward';
      const showEnd = heads === 'forward' || heads === 'both';
      const showStart = heads === 'both';
      const markerEnd = showEnd ? ` marker-end="url(#${sel ? 'cv-ah-sel' : 'cv-ah'})"` : '';
      const markerStart = showStart ? ` marker-start="url(#${sel ? 'cv-ah-start-sel' : 'cv-ah-start'})"` : '';
      const strokeClass = l.stroke ? ` stroke-${l.stroke}` : (l.kind === 'hook' ? ' stroke-dashed' : ' stroke-solid');
      const tintClass = l.color ? ` tint-${l.color}` : '';
      svg += `<g class="lk ${l.kind}${strokeClass}${tintClass}${sel ? ' picked' : ''}" data-lk="${l.id}"><path class="hit" d="${pathOf(g)}"/><path class="ln" d="${pathOf(g)}"${markerStart}${markerEnd}/></g>`;
      if (l.label) labels += `<div class="alabel${l.underline ? ' u' : ''}${l.caps ? ' c' : ''}${sel ? ' picked' : ''}${st.senseOpen && a !== undefined ? ' th' + (a % THREADS) : ''}" data-lk="${l.id}" style="left:${g.mid[0]}px;top:${g.mid[1]}px;z-index:4">${esc(l.label)}</div>`;
    }
    if (st.preview) {
      const a = endRect(st.preview.from), tgt = st.preview.toItem && byId(st.preview.toItem);
      const b = tgt ? rectOf(tgt) : { x: st.preview.to.x, y: st.preview.to.y, w: 0, h: 0, free: true };
      if (a) svg += `<g class="lk flow pv"><path class="ln" d="${pathOf(geom(a, b))}" marker-end="url(#cv-ah-sel)"/></g>`;
    }
    linksG.innerHTML = svg;
    fore.querySelectorAll(':scope > .alabel').forEach(n => n.remove());
    fore.insertAdjacentHTML('beforeend', labels);
  }

  // ---------------------------------------------------------------------------------------------- render: handles and the floating toolbar
  function renderHandles() {
    let h = '';
    const one = st.sel.size === 1 && !st.editing ? byId([...st.sel][0]) : null;
    const z = st.view.z;
    if (one && st.tool === 'select') {
      const r = rectOf(one);
      if (one.type !== 'image') h += `<div class="h" data-h="arrow" data-id="${one.id}" style="left:${r.x + r.w + 26 / z}px;top:${r.y + r.h / 2}px" title="Drag to draw an arrow">${ico('move-up-right', { size: 12, sw: 2 })}</div>`;
      if (one.type === 'text') h += `<div class="h size" data-h="size" data-id="${one.id}" style="left:${r.x + r.w}px;top:${r.y + r.h / 2}px" title="Drag to change the width"></div>`;
      else h += `<div class="h corner" data-h="corner" data-id="${one.id}" style="left:${r.x + r.w}px;top:${r.y + r.h}px" title="Drag to resize"></div>`;
    }
    const l = st.selLink && st.links.find(x => x.id === st.selLink);
    const g = l && linkGeom(l);
    if (g) h += `<div class="h bend" data-h="bend" data-id="${l.id}" style="left:${g.mid[0]}px;top:${g.mid[1]}px" title="Drag to bend the arrow"></div>`;
    uiLayer.innerHTML = h;
  }
  const selItems = () => [...st.sel].map(byId).filter(Boolean);
  function renderFloat() {
    const l = st.selLink && st.links.find(x => x.id === st.selLink);
    const its = selItems();
    let html = '';
    const swatches = (cur, role = 'colour') => `<div class="cv-swatches" role="radiogroup" aria-label="${role}">${['default', 'sky', 'mint', 'blush', 'sun', 'violet', 'tangerine', 'berry'].map(c =>
      `<button type="button" class="cv-swatch" role="radio" data-color="${c}" aria-label="${c}" aria-checked="${(cur || 'default') === c}" style="--sw:${c === 'default' ? 'var(--fg-2)' : 'var(--' + c + ')'}"></button>`).join('')}</div>`;

    if (l) {
      const curHeads = l.heads || 'forward';
      const curStroke = l.stroke || (l.kind === 'hook' ? 'dashed' : 'solid');
      html = `
        <div class="nw-seg nw-seg--sm" role="radiogroup" aria-label="Arrow type">${[['flow', 'Arrow'], ['hook', 'Aside'], ['connector', 'Word']].map(([k, t]) =>
          `<button type="button" role="radio" class="nw-seg__opt" data-kind="${k}" aria-checked="${l.kind === k}">${t}</button>`).join('')}</div>
        <div class="nw-seg nw-seg--sm" role="radiogroup" aria-label="Arrowhead">${[['forward', 'One way'], ['both', 'Two way'], ['none', 'Line']].map(([h, t]) =>
          `<button type="button" role="radio" class="nw-seg__opt" data-heads="${h}" aria-checked="${curHeads === h}">${t}</button>`).join('')}</div>
        <div class="nw-seg nw-seg--sm" role="radiogroup" aria-label="Stroke style">${[['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']].map(([s, t]) =>
          `<button type="button" role="radio" class="nw-seg__opt" data-arrow-stroke="${s}" aria-checked="${curStroke === s}">${t}</button>`).join('')}</div>
        ${swatches(l.color, 'Arrow colour')}
        <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-flip title="Flip arrow direction">${ico('refresh-cw', { size: 15, cls: 'nw-btn__icon' })}<span>Flip</span></button>
        ${l.kind === 'connector' ? `<input class="word" aria-label="The word on the arrow" placeholder="The word" value="${esc(l.label || '')}" maxlength="60">` : ''}
        ${l.label ? `<button type="button" class="nw-chip${l.underline ? ' nw-chip--on' : ''}" data-flag="underline">Underline</button><button type="button" class="nw-chip${l.caps ? ' nw-chip--on' : ''}" data-flag="caps">Caps</button>` : ''}
        <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-remove>${ico('trash-2', { size: 16, cls: 'nw-btn__icon' })}<span>Remove</span></button>`;
    } else if (its.length && !st.editing && st.tool === 'select') {
      const texts = its.filter(i => i.type === 'text');
      const shapes = its.filter(i => i.type === 'shape');
      const imgs = its.filter(i => i.type === 'image');

      if (texts.length && !shapes.length && !imgs.length) {
        const curSize = texts[0]?.size || 'body';
        const curAlign = texts[0]?.align || 'left';
        html = `
          <div class="nw-seg nw-seg--sm" role="radiogroup" aria-label="Text size">${[['body', 'Body'], ['heading', 'Heading'], ['title', 'Title']].map(([s, t]) =>
            `<button type="button" role="radio" class="nw-seg__opt" data-text-size="${s}" aria-checked="${curSize === s}">${t}</button>`).join('')}</div>
          ${swatches(texts[0]?.color, 'Text colour')}
          <div class="nw-seg nw-seg--sm" role="radiogroup" aria-label="Alignment">${[['left', 'Left'], ['center', 'Center']].map(([a, t]) =>
            `<button type="button" role="radio" class="nw-seg__opt" data-align="${a}" aria-checked="${curAlign === a}">${t}</button>`).join('')}</div>
          <button type="button" class="nw-chip${texts.every(i => i.underline) ? ' nw-chip--on' : ''}" data-flag="underline">Underline</button>
          <button type="button" class="nw-chip${texts.every(i => i.caps) ? ' nw-chip--on' : ''}" data-flag="caps">Caps</button>
          <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-duplicate>${ico('copy', { size: 15, cls: 'nw-btn__icon' })}<span>Duplicate</span></button>
          <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-remove>${ico('trash-2', { size: 16, cls: 'nw-btn__icon' })}<span>Remove${its.length > 1 ? ' ' + its.length : ''}</span></button>`;
      } else if (shapes.length && !texts.length && !imgs.length) {
        const curShape = shapes[0]?.shape || 'blob';
        const curFill = shapes[0]?.fill || 'hatch';
        const curStroke = shapes[0]?.stroke || 'dashed';
        html = `
          <div class="nw-seg nw-seg--sm" role="radiogroup" aria-label="Shape silhouette">${[['blob', 'Blob'], ['box', 'Box'], ['circle', 'Circle']].map(([s, t]) =>
            `<button type="button" role="radio" class="nw-seg__opt" data-shape="${s}" aria-checked="${curShape === s}">${t}</button>`).join('')}</div>
          <div class="nw-seg nw-seg--sm" role="radiogroup" aria-label="Shape fill">${[['hatch', 'Hatch'], ['tint', 'Tint'], ['outline', 'Clear']].map(([f, t]) =>
            `<button type="button" role="radio" class="nw-seg__opt" data-fill="${f}" aria-checked="${curFill === f}">${t}</button>`).join('')}</div>
          <div class="nw-seg nw-seg--sm" role="radiogroup" aria-label="Stroke style">${[['dashed', 'Dashed'], ['solid', 'Solid'], ['dotted', 'Dotted']].map(([s, t]) =>
            `<button type="button" role="radio" class="nw-seg__opt" data-shape-stroke="${s}" aria-checked="${curStroke === s}">${t}</button>`).join('')}</div>
          ${swatches(shapes[0]?.color, 'Shape colour')}
          <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-duplicate>${ico('copy', { size: 15, cls: 'nw-btn__icon' })}<span>Duplicate</span></button>
          <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-remove>${ico('trash-2', { size: 16, cls: 'nw-btn__icon' })}<span>Remove${its.length > 1 ? ' ' + its.length : ''}</span></button>`;
      } else if (imgs.length && !texts.length && !shapes.length) {
        const isFront = imgs.some(i => i.z_order === 'front');
        html = `
          <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-rotate-img>${ico('rotate-cw', { size: 15, cls: 'nw-btn__icon' })}<span>Rotate</span></button>
          <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-reset-aspect>${ico('maximize', { size: 15, cls: 'nw-btn__icon' })}<span>Fit aspect</span></button>
          <button type="button" class="nw-chip${isFront ? ' nw-chip--on' : ''}" data-toggle-z>${isFront ? 'In front' : 'In back'}</button>
          <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-duplicate>${ico('copy', { size: 15, cls: 'nw-btn__icon' })}<span>Duplicate</span></button>
          <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-remove>${ico('trash-2', { size: 16, cls: 'nw-btn__icon' })}<span>Remove${its.length > 1 ? ' ' + its.length : ''}</span></button>`;
      } else {
        if (texts.length) {
          html += `<button type="button" class="nw-chip${texts.every(i => i.underline) ? ' nw-chip--on' : ''}" data-flag="underline">Underline</button><button type="button" class="nw-chip${texts.every(i => i.caps) ? ' nw-chip--on' : ''}" data-flag="caps">Caps</button>`;
        }
        html += `
          <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-duplicate>${ico('copy', { size: 15, cls: 'nw-btn__icon' })}<span>Duplicate</span></button>
          <button type="button" class="nw-btn nw-btn--ghost nw-btn--sm" data-remove>${ico('trash-2', { size: 16, cls: 'nw-btn__icon' })}<span>Remove ${its.length}</span></button>`;
      }
    }
    floatEl.hidden = !html;
    if (html && floatEl.dataset.html !== html) { floatEl.innerHTML = html; floatEl.dataset.html = html; }
    if (!html) floatEl.dataset.html = '';
    placeFloat();
  }
  function placeFloat() {
    if (floatEl.hidden) return;
    let b;
    const l = st.selLink && st.links.find(x => x.id === st.selLink), g = l && linkGeom(l);
    if (g) { const xs = [g.p1[0], g.p2[0], ...(g.c ? [g.c[0]] : [])], ys = [g.p1[1], g.p2[1], ...(g.c ? [g.c[1]] : [])]; b = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; }
    else b = boundsOf([...st.sel]);
    if (!b) return;
    const s0 = toScreen(b.x, b.y), s1 = toScreen(b.x + b.w, b.y + b.h), W = cv.clientWidth, w = floatEl.offsetWidth, h = floatEl.offsetHeight;
    let y = s0.y - h - 14; if (y < 76) y = s1.y + 44;
    floatEl.style.left = clamp((s0.x + s1.x) / 2 - w / 2, 8, Math.max(8, W - w - 8)) + 'px';
    floatEl.style.top = clamp(y, 76, cv.clientHeight - h - 90) + 'px';
  }

  function renderStatus() {
    statusEl.dataset.s = st.status;
    statusEl.textContent = { saved: 'Saved', dirty: 'Unsaved', saving: 'Saving…', error: "Couldn't save" }[st.status];
  }
  function renderChrome() {
    cv.classList.toggle('sense-open', st.senseOpen);
    for (const t of host.querySelectorAll('[data-tool]')) t.setAttribute('aria-selected', t.dataset.tool === st.tool);
    cv.className = cv.className.replace(/\btool-\w+/g, '').trim() + ' tool-' + st.tool;
    const sb = $('#cv-sense-btn'); sb.setAttribute('aria-pressed', st.senseOpen); sb.className = 'nw-btn nw-btn--' + (st.senseOpen ? 'primary' : 'secondary');
    $('#cv-undo').disabled = !st.past.length; $('#cv-redo').disabled = !st.future.length;
  }
  function renderSense() {
    const s = st.sense || { stats: { text: 0, threads: 0, loose: 0 }, summary: '' };
    const n = st.narration;
    drawer.innerHTML = `<button class="nw-ib nw-ib--soft nw-ib--sm close" id="cv-sense-x" type="button" aria-label="Close" title="Close">${ico('x', { size: 18, sw: 1.6 })}</button>
      <p class="summary">${esc(n && n.summary ? n.summary : s.summary)}</p>
      <p class="nw-label">${esc([ctx.plural(s.stats.text, 'note'), ctx.plural(s.stats.threads, 'thread'), n && n.stale ? 'Summary is from before your last edit' : ''].filter(Boolean).join(' · '))}</p>
      ${st.canNarrate ? `<button class="nw-btn nw-btn--secondary nw-btn--sm" id="cv-narrate" type="button">${ico('sparkles', { size: 16, cls: 'nw-btn__icon' })}<span>${n ? 'Write it again' : 'Write a summary'}</span></button>` : ''}
      ${st.senseHtml}`;
  }
  function renderAll() { renderItems(); renderLinks(); renderHandles(); renderFloat(); renderChrome(); renderStatus(); }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderLinks(); renderHandles(); placeFloat(); }); };

  // ---------------------------------------------------------------------------------------------- history and saving
  const snap = () => JSON.stringify({ items: st.items, links: st.links });
  function commit() {                      // a finished change: remember how it was, and save
    const now = snap();
    if (now !== st.last) { st.past.push(st.last); if (st.past.length > 100) st.past.shift(); st.last = now; st.future = []; }
    st.version++; setStatus('dirty'); scheduleSave(700); renderChrome();
  }
  function restore(s) {
    const o = JSON.parse(s); st.items = o.items; st.links = o.links;
    st.sel = new Set([...st.sel].filter(id => byId(id))); if (st.selLink && !st.links.some(l => l.id === st.selLink)) st.selLink = null;
    st.version++; setStatus('dirty'); scheduleSave(700); renderAll();
  }
  function undo() { if (!st.past.length) return; st.future.push(st.last); st.last = st.past.pop(); restore(st.last); }
  function redo() { if (!st.future.length) return; st.past.push(st.last); st.last = st.future.pop(); restore(st.last); }
  function setStatus(s) { st.status = s; renderStatus(); }
  function scheduleSave(ms) { clearTimeout(st.timer); st.timer = setTimeout(save, ms); }
  async function save() {
    if (destroyed) return;
    if (st.saving) { st.again = true; return; }
    if (st.version === st.savedVersion) { setStatus('saved'); return; }
    st.saving = true; st.again = false; setStatus('saving');
    const sent = st.version;
    try {
      const r = await send('PUT', `/notebooks/${st.id}`, { rev: st.rev, items: st.items, links: st.links, title: st.title, view: st.view, sense_open: st.senseOpen, color: st.color });
      st.rev = r.rev; st.sense = r.sense; st.senseHtml = r.sense_html; st.savedVersion = sent;
      st.saving = false;
      if (st.version !== sent || st.again) { setStatus('dirty'); scheduleSave(200); } else setStatus('saved');
      renderSense(); renderItems(); renderLinks();
    } catch (e) {
      st.saving = false;
      if (/another tab/.test(e.message)) {
        setStatus('error');
        sheet({ title: 'This notebook changed <em>elsewhere</em>', body: `<p class="lead">${esc(e.message)} Your latest edits here haven't been saved.</p>`,
                buttons: [{ id: 'reload', label: 'Reload', variant: 'primary' }, { id: 'keep', label: 'Keep looking at this copy', variant: 'soft' }] })
          .then(r => { if (r.id === 'reload') location.reload(); });
      } else { setStatus('error'); oops(e); }
    }
  }
  const flush = async () => { clearTimeout(st.timer); while (st.saving) await new Promise(r => setTimeout(r, 40)); if (st.version !== st.savedVersion) await save(); };

  // ---------------------------------------------------------------------------------------------- editing text
  function addText(x, y, text = '') {
    const it = { id: uid(), type: 'text', x: Math.round(x), y: Math.round(y), w: 0, h: 0, text, underline: false, caps: false };
    st.items.push(it); st.sel = new Set([it.id]); st.selLink = null;
    renderItems(); startEdit(it.id, true);
    return it;
  }
  function startEdit(id, isNew = false) {
    const el = els.get(id), it = byId(id); if (!el || !it || it.type !== 'text') return;
    if (st.editing && st.editing !== id) endEdit();
    st.editing = id; st.editingIsNew = isNew; st.editStart = it.text;
    el.classList.add('editing');
    el.contentEditable = 'plaintext-only';
    if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';   // browsers without plaintext-only
    el.focus();
    const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    renderHandles(); renderFloat(); $('.cv-empty').hidden = true;
  }
  function endEdit() {
    const id = st.editing; if (!id) return;
    const el = els.get(id), it = byId(id);
    st.editing = null;
    if (el) { el.contentEditable = 'false'; el.classList.remove('editing'); }
    if (!it) return;
    const text = (el ? el.innerText : it.text).replace(/\s+$/g, '').replace(/^\n+/, '');
    if (!text.trim()) {                                  // nothing written: the note goes away
      st.items = st.items.filter(i => i.id !== id); st.links = st.links.filter(l => l.from !== id && l.to !== id); st.sel.delete(id);
      if (!st.editingIsNew) commit();
    } else { it.text = text; if (el) el.textContent = text; commit(); }
    renderAll();
  }

  // ---------------------------------------------------------------------------------------------- pointer handling
  const isChrome = t => t.closest('.cv-top, .cv-tools, .cv-cluster, .cv-float, .cv-sense');
  const hitItem = t => { const el = t.closest('.it[data-id]'); return el ? byId(el.dataset.id) : null; };
  const hitLink = t => { const el = t.closest('[data-lk]'); return el ? el.dataset.lk : null; };
  function itemUnder(cx, cy, except) {
    for (const el of document.elementsFromPoint(cx, cy)) {
      const own = el.closest?.('.it[data-id]');
      const it = own ? byId(own.dataset.id) : null;
      if (it && it.id !== except && it.type !== 'image') return it;
    }
    return null;
  }
  let lastTap = { t: 0, x: 0, y: 0 };

  cv.addEventListener('pointerdown', e => {
    if (isChrome(e.target)) return;
    cv.focus({ preventScroll: true });
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { startPinch(); return; }
    if (pointers.size > 2) return;
    if (st.editing && !e.target.closest(`.it[data-id="${st.editing}"]`)) endEdit();
    else if (st.editing) return;                        // clicks inside the text being edited are the caret's business
    cv.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId, shift: e.shiftKey };
    const h = e.target.closest('[data-h]');
    const w = toWorld(e.clientX, e.clientY);
    const it = hitItem(e.target), lk = hitLink(e.target);

    if (e.button === 1 || st.spaceDown) { drag = { ...start, type: 'pan', vx: st.view.x, vy: st.view.y }; cv.classList.add('panning'); return; }
    if (h) {
      const kind = h.dataset.h, id = h.dataset.id;
      if (kind === 'arrow') drag = { ...start, type: 'arrow', from: id };
      else if (kind === 'size' || kind === 'corner') drag = { ...start, type: kind, id, orig: { ...byId(id) } };
      else if (kind === 'bend') drag = { ...start, type: 'bend', id };
      return;
    }
    if (st.tool === 'text') {
      if (it && it.type === 'text') { st.sel = new Set([it.id]); startEdit(it.id); return; }
      addText(w.x - 10, w.y - 16); return;
    }
    if (st.tool === 'arrow') { drag = { ...start, type: 'arrow', from: it && it.type !== 'image' ? it.id : { x: w.x, y: w.y } }; return; }
    if (st.tool === 'shape') { drag = { ...start, type: 'shape', x0: w.x, y0: w.y }; return; }
    // select tool
    if (lk && !it) { st.selLink = lk; st.sel = new Set(); renderHandles(); renderFloat(); renderLinks(); return; }
    if (it) {
      if (e.shiftKey) { st.sel.has(it.id) ? st.sel.delete(it.id) : st.sel.add(it.id); }
      else if (!st.sel.has(it.id)) st.sel = new Set([it.id]);
      st.selLink = null;
      drag = { ...start, type: 'move', ids: [...st.sel], orig: new Map([...st.sel].map(id => [id, { x: byId(id).x, y: byId(id).y }])), onItem: it.id };
      renderItems(); renderLinks(); renderHandles(); renderFloat();
      return;
    }
    // empty paper
    if (e.shiftKey) { drag = { ...start, type: 'marquee', base: new Set(st.sel) }; return; }
    drag = { ...start, type: 'pan', vx: st.view.x, vy: st.view.y, empty: true };
  });

  cv.addEventListener('pointermove', e => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch) { movePinch(); return; }
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    const z = st.view.z, w = toWorld(e.clientX, e.clientY);
    switch (drag.type) {
      case 'pan': cv.classList.add('panning'); st.view = { ...st.view, x: drag.vx + dx, y: drag.vy + dy }; applyView(); break;
      case 'move':
        for (const id of drag.ids) { const it = byId(id), o = drag.orig.get(id); it.x = Math.round(o.x + dx / z); it.y = Math.round(o.y + dy / z); const el = els.get(id); el.style.left = it.x + 'px'; el.style.top = it.y + 'px'; }
        schedule(); break;
      case 'size': { const it = byId(drag.id); it.w = Math.max(60, Math.round(drag.orig.w + dx / z)); it.fixed = true; syncEl(els.get(it.id), it); measureOne(it); schedule(); break; }
      case 'corner': { const it = byId(drag.id); it.w = Math.max(40, Math.round(drag.orig.w + dx / z)); it.h = Math.max(30, Math.round(drag.orig.h + dy / z)); syncEl(els.get(it.id), it); schedule(); break; }
      case 'bend': { const l = st.links.find(x => x.id === drag.id), a = endRect(l.from), b = endRect(l.to); if (!a || !b) break; l.bend = bendFor(a, b, [w.x, w.y]); schedule(); break; }
      case 'shape': drawGhost(drag.x0, drag.y0, w.x, w.y); break;
      case 'arrow': {
        const under = itemUnder(e.clientX, e.clientY, typeof drag.from === 'string' ? drag.from : null);
        st.hl = new Set(under ? [under.id] : []); els.forEach((el, id) => el.classList.toggle('hl', st.hl.has(id)));
        st.preview = { from: drag.from, toItem: under ? under.id : null, to: { x: w.x, y: w.y } };
        renderLinks(); break;
      }
      case 'marquee': drawMarquee(drag.x, drag.y, e.clientX, e.clientY); break;
    }
  });

  const finish = e => {
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag; drag = null; cv.classList.remove('panning');
    const w = toWorld(e.clientX, e.clientY);
    switch (d.type) {
      case 'pan':
        if (!d.moved) { tapEmpty(e); } else { st.version++; scheduleSave(1800); }
        break;
      case 'move': if (d.moved) commit(); else if (!d.shift && st.sel.size > 1) { st.sel = new Set([d.onItem]); renderAll(); } break;
      case 'size': case 'corner': case 'bend': if (d.moved) { renderItems(); commit(); } break;
      case 'shape': {
        clearGhost();
        const x = Math.min(d.x0, w.x), y = Math.min(d.y0, w.y), ww = Math.abs(w.x - d.x0), hh = Math.abs(w.y - d.y0);
        if (ww > 30 && hh > 30) { const it = { id: uid(), type: 'shape', x: Math.round(x), y: Math.round(y), w: Math.round(ww), h: Math.round(hh) }; st.items.push(it); st.sel = new Set([it.id]); setTool('select'); commit(); renderAll(); }
        break;
      }
      case 'arrow': {
        st.preview = null; st.hl = new Set(); els.forEach(el => el.classList.remove('hl'));
        const under = itemUnder(e.clientX, e.clientY, typeof d.from === 'string' ? d.from : null);
        const to = under ? under.id : { x: Math.round(w.x), y: Math.round(w.y) };
        const far = d.moved && (typeof d.from === 'string' || typeof to === 'string' || Math.hypot(w.x - toWorld(d.x, d.y).x, w.y - toWorld(d.x, d.y).y) > 24);
        if (far && to !== d.from) {
          const l = { id: uid(), kind: 'flow', from: d.from, to, bend: 0 };
          st.links.push(l); st.selLink = l.id; st.sel = new Set(); commit();
        }
        renderAll(); break;
      }
      case 'marquee': {
        clearMarquee();
        const a = toWorld(Math.min(d.x, e.clientX), Math.min(d.y, e.clientY)), b = toWorld(Math.max(d.x, e.clientX), Math.max(d.y, e.clientY));
        const hit = st.items.filter(i => i.x < b.x && i.x + i.w > a.x && i.y < b.y && i.y + i.h > a.y).map(i => i.id);
        st.sel = new Set([...d.base, ...hit]); st.selLink = null; renderAll(); break;
      }
    }
  };
  cv.addEventListener('pointerup', finish);
  cv.addEventListener('pointercancel', finish);

  function tapEmpty(e) {                         // a tap on empty paper: clear the selection; two quick taps start a note
    const now = Date.now(), near = Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
    st.sel = new Set(); st.selLink = null;
    if (now - lastTap.t < 380 && near) { const w = toWorld(e.clientX, e.clientY); lastTap = { t: 0, x: 0, y: 0 }; addText(w.x - 10, w.y - 16); return; }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    renderAll();
  }
  cv.addEventListener('dblclick', e => {         // double-click on a note edits it (on empty paper, tapEmpty has already begun a note)
    if (isChrome(e.target)) return;
    const it = hitItem(e.target);
    if (it && it.type === 'text' && !st.editing) { st.sel = new Set([it.id]); startEdit(it.id); }
  });

  function measureOne(it) { const el = els.get(it.id); if (el) { it.h = el.offsetHeight; } }
  function bendFor(a, b, hpt) {                 // where the handle is -> how far the arrow bows (inverse of geom)
    const ac = [a.x + a.w / 2, a.y + a.h / 2], bc = [b.x + b.w / 2, b.y + b.h / 2];
    const dx = bc[0] - ac[0], dy = bc[1] - ac[1], len2 = dx * dx + dy * dy;
    if (!len2) return 0;
    const m0 = [(ac[0] + bc[0]) / 2, (ac[1] + bc[1]) / 2];
    const p1 = edgePt(a, hpt, a.free ? 0 : PAD), p2 = edgePt(b, hpt, b.free ? 0 : PAD);
    const c = [2 * hpt[0] - (p1[0] + p2[0]) / 2, 2 * hpt[1] - (p1[1] + p2[1]) / 2];
    return clamp(((c[0] - m0[0]) * -dy + (c[1] - m0[1]) * dx) / len2, -2, 2);
  }
  function drawGhost(x0, y0, x1, y1) {
    let g = uiLayer.querySelector('.ghost');
    if (!g) { uiLayer.insertAdjacentHTML('beforeend', `<svg class="it shape ghost" viewBox="0 0 100 100" preserveAspectRatio="none"><path d="${ds.SHAPES.blob[0]}" fill="url(#cv-hatch)" stroke="var(--action)" stroke-dasharray="6 5" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>`); g = uiLayer.querySelector('.ghost'); }
    Object.assign(g.style, { left: Math.min(x0, x1) + 'px', top: Math.min(y0, y1) + 'px', width: Math.abs(x1 - x0) + 'px', height: Math.abs(y1 - y0) + 'px' });
  }
  const clearGhost = () => uiLayer.querySelector('.ghost')?.remove();
  function drawMarquee(x0, y0, x1, y1) {
    let m = cv.querySelector('.marquee'); const r = cv.getBoundingClientRect();
    if (!m) { m = document.createElement('div'); m.className = 'marquee'; cv.appendChild(m); }
    Object.assign(m.style, { left: Math.min(x0, x1) - r.left + 'px', top: Math.min(y0, y1) - r.top + 'px', width: Math.abs(x1 - x0) + 'px', height: Math.abs(y1 - y0) + 'px' });
  }
  const clearMarquee = () => cv.querySelector('.marquee')?.remove();

  // pinch: two fingers pan and zoom together
  function startPinch() {
    drag = null; clearGhost(); clearMarquee(); st.preview = null;
    const [a, b] = [...pointers.values()];
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, v0: { ...st.view }, c0: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
  }
  function movePinch() {
    const [a, b] = [...pointers.values()]; if (!b) return;
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, c = [(a.x + b.x) / 2, (a.y + b.y) / 2], r = cv.getBoundingClientRect();
    const z = clamp(pinch.v0.z * d / pinch.d0, MIN_Z, MAX_Z), k = z / pinch.v0.z, px = pinch.c0[0] - r.left, py = pinch.c0[1] - r.top;
    st.view = { x: c[0] - r.left - (px - pinch.v0.x) * k, y: c[1] - r.top - (py - pinch.v0.y) * k, z };
    applyView();
  }

  // wheel: scroll pans, pinch or ctrl/cmd + scroll zooms
  cv.addEventListener('wheel', e => {
    if (isChrome(e.target) && e.target.closest('.cv-sense')) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, clamp(Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01)), 0.8, 1.25));  // a mouse-wheel notch must not leap
    else setView({ ...st.view, x: st.view.x - e.deltaX, y: st.view.y - e.deltaY });
  }, { passive: false });

  // ---------------------------------------------------------------------------------------------- toolbar, tools, keys
  function setTool(t) {
    if (t === 'photo') return addPhoto();
    if (st.editing) endEdit();
    st.tool = t; st.preview = null;
    if (t !== 'select') { st.sel = new Set(); st.selLink = null; }
    renderAll();
  }
  host.querySelector('.cv-tools').addEventListener('click', e => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
  $('#cv-undo').onclick = undo; $('#cv-redo').onclick = redo;
  $('#cv-zin').onclick = () => { const r = cv.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25); };
  $('#cv-zout').onclick = () => { const r = cv.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8); };
  $('#cv-pct').onclick = () => { const r = cv.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / st.view.z); };
  $('#cv-fit').onclick = () => fitTo(boundsOf());
  $('.cv-title').onchange = e => { st.title = e.target.value.trim() || 'Untitled notebook'; e.target.value = st.title; st.version++; scheduleSave(300); };
  $('.cv-title').onkeydown = e => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); };
  $('#cv-sense-btn').onclick = () => toggleSense();
  $('#cv-share').onclick = openShare;
  $('#cv-more').onclick = openMenu;

  function toggleSense(open = !st.senseOpen) {
    st.senseOpen = open; st.version++; scheduleSave(500);
    if (open) renderSense();
    renderItems(); renderLinks(); renderChrome();
  }
  drawer.addEventListener('click', e => {
    if (e.target.closest('#cv-sense-x')) return toggleSense(false);
    if (e.target.closest('#cv-narrate')) return narrateNow();
    const row = e.target.closest('[data-ids]');
    if (row) reveal(row.dataset.ids.split(' '));
  });
  drawer.addEventListener('mouseover', e => { const r = e.target.closest('[data-ids]'); setHl(r ? r.dataset.ids.split(' ') : []); });
  drawer.addEventListener('mouseleave', () => setHl([]));
  function setHl(ids) { st.hl = new Set(ids); els.forEach((el, id) => el.classList.toggle('hl', st.hl.has(id))); }
  function reveal(ids) {
    const its = ids.filter(byId);
    if (!its.length) return;
    st.sel = new Set(its); st.selLink = null;
    fitTo(boundsOf(its), { maxZ: 1.1, margin: 130 }); renderAll();
  }
  async function narrateNow() {
    await flush();
    const r = await guarded('Asking Gemini for a summary…', '', () => send('POST', `/notebooks/${st.id}/narrate`));
    if (r) { st.narration = r.narration; renderSense(); }
  }

  // floating toolbar actions
  floatEl.addEventListener('click', e => {
    const l = st.selLink && st.links.find(x => x.id === st.selLink);
    const its = selItems();
    const texts = its.filter(i => i.type === 'text');
    const shapes = its.filter(i => i.type === 'shape');
    const imgs = its.filter(i => i.type === 'image');

    const kind = e.target.closest('[data-kind]');
    const heads = e.target.closest('[data-heads]');
    const arrowStroke = e.target.closest('[data-arrow-stroke]');
    const flip = e.target.closest('[data-flip]');
    const textSize = e.target.closest('[data-text-size]');
    const align = e.target.closest('[data-align]');
    const shape = e.target.closest('[data-shape]');
    const fill = e.target.closest('[data-fill]');
    const shapeStroke = e.target.closest('[data-shape-stroke]');
    const color = e.target.closest('[data-color]');
    const rotateImg = e.target.closest('[data-rotate-img]');
    const resetAspect = e.target.closest('[data-reset-aspect]');
    const toggleZ = e.target.closest('[data-toggle-z]');
    const duplicate = e.target.closest('[data-duplicate]');
    const flag = e.target.closest('[data-flag]');
    const rm = e.target.closest('[data-remove]');

    if (kind && l) {
      l.kind = kind.dataset.kind;
      commit(); renderAll();
      if (l.kind === 'connector') floatEl.querySelector('.word')?.focus();
    } else if (heads && l) {
      l.heads = heads.dataset.heads;
      commit(); renderAll();
    } else if (arrowStroke && l) {
      l.stroke = arrowStroke.dataset.arrowStroke;
      commit(); renderAll();
    } else if (flip && l) {
      const tmp = l.from; l.from = l.to; l.to = tmp;
      l.bend = -(l.bend || 0);
      commit(); renderAll();
    } else if (textSize && texts.length) {
      const s = textSize.dataset.textSize;
      texts.forEach(t => { if (s === 'body') delete t.size; else t.size = s; });
      measure(); commit(); renderAll();
    } else if (align && texts.length) {
      const a = align.dataset.align;
      texts.forEach(t => { if (a === 'left') delete t.align; else t.align = a; });
      commit(); renderAll();
    } else if (shape && shapes.length) {
      const s = shape.dataset.shape;
      shapes.forEach(sh => { if (s === 'blob') delete sh.shape; else sh.shape = s; });
      commit(); renderAll();
    } else if (fill && shapes.length) {
      const f = fill.dataset.fill;
      shapes.forEach(sh => { if (f === 'hatch') delete sh.fill; else sh.fill = f; });
      commit(); renderAll();
    } else if (shapeStroke && shapes.length) {
      const s = shapeStroke.dataset.shapeStroke;
      shapes.forEach(sh => { if (s === 'dashed') delete sh.stroke; else sh.stroke = s; });
      commit(); renderAll();
    } else if (color) {
      const c = color.dataset.color;
      if (l) {
        if (c === 'default') delete l.color; else l.color = c;
      } else if (texts.length) {
        texts.forEach(t => { if (c === 'default') delete t.color; else t.color = c; });
      } else if (shapes.length) {
        shapes.forEach(sh => { if (c === 'default') delete sh.color; else sh.color = c; });
      }
      commit(); renderAll();
    } else if (rotateImg && imgs.length) {
      imgs.forEach(im => {
        const tmp = im.w; im.w = im.h; im.h = tmp;
        im.rot = (((im.rot || 0) + 1) % 4);
      });
      commit(); renderAll();
    } else if (resetAspect && imgs.length) {
      imgs.forEach(im => {
        const el = els.get(im.id);
        if (el?.naturalWidth && el?.naturalHeight) {
          const isRot = (im.rot || 0) % 2 === 1;
          const natRatio = el.naturalWidth / el.naturalHeight;
          const targetRatio = isRot ? (1 / natRatio) : natRatio;
          im.h = Math.max(30, Math.round(im.w / targetRatio));
        }
      });
      commit(); renderAll();
    } else if (toggleZ && imgs.length) {
      const toFront = !imgs.some(i => i.z_order === 'front');
      imgs.forEach(im => { im.z_order = toFront ? 'front' : 'back'; });
      commit(); renderAll();
    } else if (duplicate) {
      duplicateSelection();
    } else if (flag) {
      const f = flag.dataset.flag;
      if (l) l[f] = !l[f];
      else { const ts = texts, on = !ts.every(i => i[f]); ts.forEach(i => { i[f] = on; }); }
      commit(); renderAll();
    } else if (rm) {
      removeSelection();
    }
  });
  floatEl.addEventListener('input', e => {
    if (!e.target.classList.contains('word')) return;
    const l = st.links.find(x => x.id === st.selLink); if (!l) return;
    const v = e.target.value; if (v.trim()) l.label = v; else { delete l.label; delete l.underline; delete l.caps; }
    renderLinks(); st.version++; setStatus('dirty'); scheduleSave(900);
  });
  floatEl.addEventListener('change', e => { if (e.target.classList.contains('word')) { commit(); renderAll(); } });
  floatEl.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') { e.target.blur?.(); cv.focus(); } e.stopPropagation(); });

  function duplicateSelection() {
    const its = selItems();
    if (!its.length) return;
    const newIds = new Set();
    const idMap = new Map();
    for (const it of its) {
      const clone = JSON.parse(JSON.stringify(it));
      clone.id = uid();
      clone.x += 24;
      clone.y += 24;
      st.items.push(clone);
      newIds.add(clone.id);
      idMap.set(it.id, clone.id);
    }
    if (its.length > 1) {
      const origIds = new Set(its.map(i => i.id));
      for (const l of st.links) {
        if (origIds.has(l.from) && origIds.has(l.to)) {
          const cl = JSON.parse(JSON.stringify(l));
          cl.id = uid();
          cl.from = idMap.get(l.from);
          cl.to = idMap.get(l.to);
          st.links.push(cl);
        }
      }
    }
    st.sel = newIds;
    st.selLink = null;
    commit();
    renderAll();
  }

  function removeSelection() {
    if (st.selLink) { st.links = st.links.filter(l => l.id !== st.selLink); st.selLink = null; }
    if (st.sel.size) {
      const gone = new Set(st.sel);
      st.items = st.items.filter(i => !gone.has(i.id)); st.links = st.links.filter(l => !gone.has(l.from) && !gone.has(l.to)); st.sel = new Set();
    }
    commit(); renderAll();
  }
  function nudge(dx, dy) { selItems().forEach(i => { i.x += dx; i.y += dy; }); commit(); renderAll(); }

  const typing = t => t.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]');
  function onKey(e) {
    if (destroyed) return;
    if (e.key === 'Escape') {
      if (st.editing) { endEdit(); cv.focus(); return; }
      if (document.querySelector('.nw-sheet')) return;
      if (st.tool !== 'select') setTool('select'); else { st.sel = new Set(); st.selLink = null; renderAll(); }
      return;
    }
    if (typing(e.target)) return;
    if (document.querySelector('.nw-sheet')) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (mod && e.key.toLowerCase() === 'd' && st.sel.size) { e.preventDefault(); duplicateSelection(); }
    else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); st.sel = new Set(st.items.filter(i => i.type !== 'image').map(i => i.id)); st.selLink = null; renderAll(); }
    else if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); const ts = selItems().filter(i => i.type === 'text'); const on = !ts.every(i => i.underline); ts.forEach(i => { i.underline = on; }); commit(); renderAll(); }
    else if (e.key === ' ') { e.preventDefault(); st.spaceDown = true; }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && (st.sel.size || st.selLink)) { e.preventDefault(); removeSelection(); }
    else if (e.key === 'Enter' && st.sel.size === 1 && byId([...st.sel][0])?.type === 'text') { e.preventDefault(); startEdit([...st.sel][0]); }
    else if (e.key.startsWith('Arrow') && st.sel.size) { e.preventDefault(); const s = e.shiftKey ? 10 : 1; nudge(e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0); }
    else if (!mod && { v: 'select', t: 'text', a: 'arrow', s: 'shape', p: 'photo' }[e.key.toLowerCase()]) setTool({ v: 'select', t: 'text', a: 'arrow', s: 'shape', p: 'photo' }[e.key.toLowerCase()]);
    else if (!mod && e.key.toLowerCase() === 'f') fitTo(boundsOf());
    else if (!mod && (e.key === '+' || e.key === '=')) $('#cv-zin').click();
    else if (!mod && e.key === '-') $('#cv-zout').click();
  }
  const onKeyUp = e => { if (e.key === ' ') st.spaceDown = false; };
  document.addEventListener('keydown', onKey); document.addEventListener('keyup', onKeyUp);

  // typing in a note
  fore.addEventListener('input', e => {
    const el = e.target.closest('.it.text'); if (!el || el.dataset.id !== st.editing) return;
    const it = byId(st.editing); it.text = el.innerText; measure(); schedule(); st.version++; setStatus('dirty'); scheduleSave(900);
  });
  fore.addEventListener('paste', e => { if (!st.editing) return; e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text')); });
  fore.addEventListener('focusout', e => { const el = e.target.closest?.('.it.text'); if (el && el.dataset.id === st.editing && !e.relatedTarget?.closest?.('.cv-float')) setTimeout(() => { if (st.editing === el.dataset.id && document.activeElement !== el) endEdit(); }, 0); });

  // ---------------------------------------------------------------------------------------------- photos, sharing, notebook menu
  function viewCentre() { const r = cv.getBoundingClientRect(); return toWorld(r.left + r.width * 0.3, r.top + r.height * 0.3); }
  function adopt(r, ids) {
    st.rev = r.rev; st.items = r.items; st.links = r.links; st.sense = r.sense; st.senseHtml = r.sense_html;
    st.savedVersion = st.version; st.past.push(st.last); st.last = snap(); st.future = [];
    renderSense(); renderAll();
    if (ids?.length) fitTo(boundsOf(ids.filter(byId)), { maxZ: 0.9, margin: 100 });
  }
  async function addPhoto() {
    const notes = await ctx.api('/notes').catch(() => []);
    const pages = notes.slice(0, 8);
    const r = await sheet({ title: 'Add a <em>photo</em>', body: `<p class="lead" style="font-size:var(--t-body)">${ctx.cloud ? 'A new photo lands on the page by itself. To bring its words in too, add it under Pages first, then bring it in from here.' : 'The photo lands on the page with its words beside it, ready to move and fix.'}${pages.length ? ' Or bring in a page you have already read.' : ''}</p>`,
      buttons: [{ id: 'new', label: 'Choose a photo', variant: 'primary', icon: 'image' }, ...pages.map(p => ({ id: 'page:' + p.id, label: `${p.title}  ·  ${ctx.fmtDate(p.created)}`, variant: 'soft' }))] });
    if (!r.id) return;
    await flush();
    const at = viewCentre();
    if (r.id === 'new') {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
      input.onchange = async () => {
        const f = input.files[0]; if (!f) return;
        const out = await guarded(ctx.cloud ? 'Putting the photo on the page…' : 'Reading your handwriting…', ctx.cloud ? '' : 'Finding the page first, then the words.', () =>
          ctx.api(`/notebooks/${st.id}/photo?x=${Math.round(at.x)}&y=${Math.round(at.y)}`, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f }));
        if (out) { adopt(out, out.added); toast(ctx.cloud ? 'Added.' : 'Added. Its words are beside it.', { mood: 'joyful' }); }
      };
      input.click();
    } else {
      const out = await guarded('Putting the page on the canvas…', '', () => send('POST', `/notebooks/${st.id}/import`, { note_id: r.id.slice(5), at: { x: Math.round(at.x), y: Math.round(at.y) } }));
      if (out) { adopt(out, out.added); toast('Added. Its words are beside it.', { mood: 'joyful' }); }
    }
  }
  async function openShare() {
    const r = await sheet({ title: 'Share this<br><em>notebook</em>', body: `<p class="lead" style="font-size:var(--t-body)">The page file opens in any browser, with no internet and nothing to install. It has the notebook laid out as you drew it, then every thread, to-do and loose note.</p>`,
      buttons: [{ id: 'html', label: 'Download the page', variant: 'primary', icon: 'share' }, { id: 'copy', label: 'Copy as Markdown', variant: 'secondary' }, { id: 'md', label: 'Download Markdown', variant: 'soft' }] });
    if (!r.id) return;
    await flush();
    const download = p => (ctx.download ? ctx.download(p) : void (location.href = '/api' + p));
    if (r.id === 'html') download(`/notebooks/${st.id}/share.html`);
    else if (r.id === 'md') download(`/notebooks/${st.id}/share.md`);
    else { try { await navigator.clipboard.writeText(await ctx.api(`/notebooks/${st.id}/share.md`)); toast('Copied. Paste it into a message.', { mood: 'joyful' }); } catch { download(`/notebooks/${st.id}/share.md`); toast("The clipboard wasn't available, so the file is downloading instead.", { icon: 'info' }); } }
  }
  async function openMenu() {
    const colors = ['sky', 'blush', 'mint', 'violet', 'tangerine', 'berry'];
    const r = await sheet({ title: 'This <em>notebook</em>', body: `<p class="hint" style="margin:0">Its colour, on the notebooks page</p>
        <div class="swatches" role="radiogroup" aria-label="Colour">${colors.map(c => `<button type="button" class="swatch" role="radio" data-color="${c}" aria-label="${c}" aria-checked="${c === st.color}" style="--sw:var(--${c})"></button>`).join('')}</div>`,
      buttons: [{ id: 'delete', label: 'Delete notebook', variant: 'pop', color: 'tomato' }, { id: 'done', label: 'Done', variant: 'soft' }],
      onMount: el => el.querySelectorAll('.swatch').forEach(b => b.onclick = () => { st.color = b.dataset.color; el.querySelectorAll('.swatch').forEach(x => x.setAttribute('aria-checked', x === b)); st.version++; scheduleSave(300); }) });
    if (r.id === 'delete' && await ask({ title: 'Delete this <em>notebook?</em>', body: 'This removes everything on it, photos included.', yes: 'Delete notebook', danger: true })) {
      destroyed = true; clearTimeout(st.timer);
      const ok = await guarded('Deleting…', '', () => send('DELETE', `/notebooks/${st.id}`));
      if (ok) { toast('Notebook deleted.', { icon: 'trash-2' }); go('#/notebooks'); } else destroyed = false;
    }
  }

  // ---------------------------------------------------------------------------------------------- go
  function hideOnLeave() { if (document.visibilityState === 'hidden' && st.version !== st.savedVersion && !st.saving) save(); }
  document.addEventListener('visibilitychange', hideOnLeave);
  const onResize = () => { applyView(); };
  window.addEventListener('resize', onResize);

  drawer.style.transition = 'none';           // a drawer that was open when you left is simply there, not sliding in
  requestAnimationFrame(() => requestAnimationFrame(() => { drawer.style.transition = ''; }));
  st.last = snap();
  renderSense();
  renderItems();
  if (nb.items.length && nb.view && nb.view.z > 0 && (nb.view.x || nb.view.y)) applyView(); else fitTo(boundsOf(), { fly: false, save: false }) || applyView();
  applyView();
  renderAll();
  requestAnimationFrame(() => { if (measure()) { st.version++; renderLinks(); scheduleSave(900); } });
  cv.focus({ preventScroll: true });

  return {
    el: cv, state: st,
    async destroy() {
      await flush(); destroyed = true;
      document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('visibilitychange', hideOnLeave); window.removeEventListener('resize', onResize);
      host.innerHTML = '';
    },
  };
}
