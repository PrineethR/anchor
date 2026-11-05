// Getting a board out: PNG, SVG and PDF for the whole board, a selection or one frame, and the board as JSON. The same
// drawing code as the screen makes the PNG and PDF; svg.js writes the SVG. Exports use the light theme whatever the screen is
// showing, so a dark-mode board still prints on paper.

import { Renderer, readTheme } from './render.js';
import { jpegToPdf } from './pdf.js';
import * as G from './geom.js';
import { esc } from './ui.js';

const MAX_SIDE = 8192;

/** The light theme's colours, read without the page ever showing it. */
export function lightTheme() {
  const html = document.documentElement, was = html.getAttribute('data-theme');
  html.setAttribute('data-theme', 'light');
  const t = readTheme();
  was === null ? html.removeAttribute('data-theme') : html.setAttribute('data-theme', was);
  return t;
}

/** Which objects a spec means: ids, one frame, or everything. A frame brings what is in it; connectors between them come too. */
export function pick(ed, spec = {}) {
  const doc = ed.doc;
  let ids;
  if (spec.frame) { const f = doc.map.get(spec.frame); if (!f) throw new Error('That frame is gone.'); ids = new Set([f.id, ...ed.childrenOf(f.id).map(c => c.id)]); }
  else if (spec.ids && spec.ids.length) {
    ids = new Set(spec.ids.filter(i => doc.map.has(i)));
    for (const i of [...ids]) { const o = doc.map.get(i); if (o.type === 'frame') for (const c of ed.childrenOf(i)) ids.add(c.id); }
  } else ids = null;
  let objs = doc.list().filter(o => !ed.v.hidden.has(o.id) && (!ids || ids.has(o.id)));
  if (ids) objs = objs.concat(doc.list().filter(o => o.type === 'connector' && !ids.has(o.id) && !ed.v.hidden.has(o.id) && (!o.from.id || ids.has(o.from.id)) && (!o.to.id || ids.has(o.to.id)) && (o.from.id || o.to.id)));
  if (!objs.length) throw new Error('There is nothing to export.');
  return objs;
}

export function boundsFor(ed, objs, spec = {}) {
  let b = G.union(objs.map(o => ed.boxOf(o)));
  const pad = spec.padding ?? 40;
  if (objs.some(o => o.type === 'frame')) b = G.union([b, ...objs.filter(o => o.type === 'frame').map(f => ({ x: f.x, y: f.y - 40, w: f.w, h: 40 }))]);
  return G.grow(b, pad);
}

/** The picture of some objects on an offscreen canvas. */
export async function drawCanvas(ed, spec = {}) {
  const objs = pick(ed, spec);
  const b = boundsFor(ed, objs, spec);
  const want = spec.scale || 2, max = spec.max || MAX_SIDE;
  const s = Math.max(0.02, Math.min(want, max / Math.max(b.w, b.h)));
  const cv = document.createElement('canvas');
  const set = new Set(objs.map(o => o.id));
  const fake = {
    doc: { map: ed.doc.map, order: ed.doc.order.filter(i => set.has(i)), geoVer: ed.doc.geoVer, indexOf: i => ed.doc.indexOf(i) },
    cam: { x: b.x, y: b.y, z: s, w: b.w * s, h: b.h * s, visible: (m = 0) => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m }), step: () => false },
    v: { sel: new Set(), hover: null, tool: 'select', editing: null, guides: [], marquee: null, hidden: new Set(), hl: new Set(), stroke: null, connDraft: null, eraser: null, quick: null },
    assetUrl: src => ed.assetUrl(src), boxOf: o => ed.boxOf(o), mm: ed.mm, r: null,
  };
  const r = new Renderer(cv, fake);
  r.noGrid = true;
  r.theme = lightTheme();
  fake.r = r;
  r.resize(b.w * s, b.h * s, 1);
  cv.width = Math.max(1, Math.round(b.w * s)); cv.height = Math.max(1, Math.round(b.h * s));
  await r.preload(objs.flatMap(o => ['src', 'favicon', 'thumb'].map(k => o[k]).filter(Boolean)));
  r.draw(performance.now());
  return { canvas: cv, bounds: b, scale: s, objects: objs };
}

const blob = (cv, type = 'image/png', q) => new Promise((ok, no) => cv.toBlob(b => (b ? ok(b) : no(new Error('The picture was too large to make.'))), type, q));
const slug = s => (s || 'board').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'board';

export function save(data, name, type) {
  const b = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function nameFor(ed, spec, ext) {
  const f = spec.frame && ed.doc.map.get(spec.frame);
  return `${slug(ed.doc.title)}${f ? '-' + slug(f.title) : spec.ids && spec.ids.length ? '-selection' : ''}.${ext}`;
}

export async function png(ed, spec = {}) {
  try {
    const { canvas } = await drawCanvas(ed, spec);
    save(await blob(canvas), nameFor(ed, spec, 'png'));
    ed.ctx.toast('PNG saved.', { icon: 'download' });
  } catch (e) { ed.ctx.oops(e); }
}

export async function pdf(ed, spec = {}) {
  try {
    const { canvas, bounds, scale } = await drawCanvas(ed, { ...spec, max: 6000, scale: 2 });
    const jpeg = new Uint8Array(await (await blob(canvas, 'image/jpeg', 0.92)).arrayBuffer());
    const k = Math.min(0.75, 14000 / Math.max(bounds.w, bounds.h));   // one board pixel is 0.75 pt: 96 to the inch
    save(jpegToPdf(jpeg, canvas.width, canvas.height, bounds.w * k, bounds.h * k), nameFor(ed, spec, 'pdf'), 'application/pdf');
    ed.ctx.toast('PDF saved.', { icon: 'download' });
  } catch (e) { ed.ctx.oops(e); }
}

async function dataUris(ed, objs) {
  const out = new Map();
  for (const name of new Set(objs.flatMap(o => ['src', 'favicon', 'thumb'].map(k => o[k]).filter(Boolean)))) {
    try {
      const r = await fetch(ed.assetUrl(name));
      if (!r.ok) continue;
      const b = await r.blob();
      out.set(name, await new Promise(ok => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); }));
    } catch { /* a missing picture is left out */ }
  }
  return out;
}

export async function svg(ed, spec = {}) {
  try {
    const { toSVG } = await import('./svg.js');
    const objs = pick(ed, spec);
    const text = toSVG(objs, { assets: await dataUris(ed, objs), theme: lightTheme(), padding: 40, background: true });
    save(text, nameFor(ed, spec, 'svg'), 'image/svg+xml');
    ed.ctx.toast('SVG saved.', { icon: 'download' });
  } catch (e) { ed.ctx.oops(e); }
}

export function json(ed) { location.href = `/api/board/${ed.doc.id}/export.json`; }

// --- the panel -------------------------------------------------------------------------------------

export function open(ed, anchor) {
  const n = [...ed.v.sel].filter(i => ed.doc.map.has(i)).length;
  const frames = ed.doc.list().filter(o => o.type === 'frame');
  const ic = ed.ui.ic;
  ed.ui.popup(anchor, `
    <div class="bd-export">
      <h2 class="bd-h">Export</h2>
      <fieldset class="bd-scope-pick"><legend class="nw-label">What</legend>
        <label><input type="radio" name="what" value="all" ${n ? '' : 'checked'}> Whole board</label>
        <label class="${n ? '' : 'off'}"><input type="radio" name="what" value="sel" ${n ? 'checked' : 'disabled'}> Selection${n ? ` (${n})` : ''}</label>
        ${frames.length ? `<label><input type="radio" name="what" value="frame"> A frame <select aria-label="Frame">${frames.map(f => `<option value="${f.id}">${esc(f.title || 'Untitled frame')}</option>`).join('')}</select></label>` : ''}
      </fieldset>
      <div class="bd-fmt">
        <button class="nw-btn nw-btn--secondary" data-f="png" type="button">${ic('image', { size: 18, cls: 'nw-btn__icon' })}<span>PNG</span></button>
        <button class="nw-btn nw-btn--secondary" data-f="svg" type="button">${ic('frame', { size: 18, cls: 'nw-btn__icon' })}<span>SVG</span></button>
        <button class="nw-btn nw-btn--secondary" data-f="pdf" type="button">${ic('file', { size: 18, cls: 'nw-btn__icon' })}<span>PDF</span></button>
      </div>
      <p class="hint">PNG and PDF are pictures; SVG keeps shapes and words editable elsewhere. Exports use the light theme.</p>
      <button class="nw-btn nw-btn--soft nw-btn--block" data-f="json" type="button">${ic('download', { size: 18, cls: 'nw-btn__icon' })}<span>The whole board as JSON</span></button>
    </div>`, el => {
    const spec = () => {
      const w = el.querySelector('input[name=what]:checked').value;
      return w === 'sel' ? { ids: [...ed.v.sel] } : w === 'frame' ? { frame: el.querySelector('select').value } : {};
    };
    el.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => {
      const f = b.dataset.f;
      if (f === 'json') { json(ed); ed.ui.closePop(); return; }
      const s = spec(); ed.ui.closePop();
      ({ png, svg, pdf })[f](ed, s);
    }));
    const sel = el.querySelector('select');
    if (sel) sel.addEventListener('focus', () => { el.querySelector('input[value=frame]').checked = true; });
  });
}
