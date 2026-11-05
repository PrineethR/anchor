// Templates: six that ship with the Board (templates.json) and the ones you save from a selection.

import { esc } from './ui.js';
import { stickyHex } from './palette.js';
import * as G from './geom.js';

let builtin = null;

async function load(ed) {
  if (!builtin) {
    try { builtin = await (await fetch('web/board/templates.json')).json(); } catch { builtin = []; }
  }
  return builtin;
}

/** A small picture of a template: its stickies as coloured blocks, frames and shapes as outlines. Content colours only. */
function thumb(objects) {
  const nodes = objects.filter(o => o.type !== 'connector');
  const b = G.union(nodes);
  if (!b) return '';
  const W = 200, H = 120, s = Math.min((W - 16) / b.w, (H - 16) / b.h), ox = (W - b.w * s) / 2 - b.x * s, oy = (H - b.h * s) / 2 - b.y * s;
  const r = o => `x="${(ox + o.x * s).toFixed(1)}" y="${(oy + o.y * s).toFixed(1)}" width="${Math.max(1.5, o.w * s).toFixed(1)}" height="${Math.max(1.5, o.h * s).toFixed(1)}"`;
  const parts = nodes.map(o => o.type === 'frame' ? `<rect ${r(o)} rx="2" fill="none" stroke="var(--line)" stroke-width="1"/>`
    : o.type === 'sticky' ? `<rect ${r(o)} rx="1.5" fill="${stickyHex(o.color)}"/>`
    : o.type === 'text' ? `<rect ${r(o)} rx="1" fill="var(--fg-3)" opacity=".35"/>`
    : `<rect ${r(o)} rx="3" fill="var(--bg-muted)" stroke="var(--line)" stroke-width=".8"/>`);
  return `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">${parts.join('')}</svg>`;
}

export async function open(ed, anchor) {
  const [mine, shipped] = await Promise.all([ed.ctx.api('/board/templates').then(r => r.templates).catch(() => []), load(ed)]);
  const n = ed.v.sel.size, ic = ed.ui.ic;
  const card = (id, name, blurb, art, extra = '') => `<div class="bd-tpl"><button class="bd-tpl-open" data-tpl="${id}" aria-label="Insert ${esc(name)}"><span class="art">${art}</span><b>${esc(name)}</b>${blurb ? `<span>${esc(blurb)}</span>` : ''}</button>${extra}</div>`;
  ed.ui.popup(anchor, `
    <div class="bd-templates">
      <h2 class="bd-h">Templates</h2>
      <div class="bd-tpl-grid">${shipped.map(t => card(t.id, t.name, t.blurb, thumb(t.objects))).join('')}</div>
      ${mine.length ? `<h3 class="bd-h">Yours</h3><div class="bd-tpl-grid">${mine.map(t => card('mine:' + t.id, t.name, `${t.count} objects`, t.thumb,
        `<button class="nw-ib nw-ib--soft nw-ib--sm del" data-del="${t.id}" aria-label="Delete ${esc(t.name)}" title="Delete this template">${ic('x', { size: 14, sw: 1.8 })}</button>`)).join('')}</div>` : ''}
      <div class="bd-tpl-save">
        <label class="nw-field"><span class="nw-field__box"><input type="text" placeholder="${n ? 'Name for the selection' : 'Select something to save it as a template'}" ${n ? '' : 'disabled'} maxlength="80" aria-label="Template name"></span></label>
        <button class="nw-btn nw-btn--soft" data-save type="button" ${n ? '' : 'disabled'}>${ic('bookmark', { size: 18, cls: 'nw-btn__icon' })}<span>Save selection as template</span></button>
      </div>
    </div>`, el => {
    el.querySelectorAll('[data-tpl]').forEach(b => b.addEventListener('click', async () => {
      ed.ui.closePop();
      const id = b.dataset.tpl;
      try {
        const t = id.startsWith('mine:') ? await ed.ctx.api(`/board/templates/${id.slice(5)}`) : shipped.find(x => x.id === id);
        const objs = await ed.place({ kind: 'anchor-board', board: ed.doc.id, objects: t.objects, template: id.startsWith('mine:') ? id.slice(5) : undefined }, ed.viewCenter());
        ed.cam.flyTo(ed.cam.framing(G.union(objs.filter(o => o.type !== 'connector').map(o => ed.boxOf(o))), 90, 1));
      } catch (e) { ed.ctx.oops(e); }
    }));
    el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      try { await ed.ctx.send('DELETE', `/board/templates/${b.dataset.del}`); ed.ui.closePop(); open(ed, anchor); } catch (e) { ed.ctx.oops(e); }
    }));
    const save = el.querySelector('[data-save]'), name = el.querySelector('.bd-tpl-save input');
    const go = async () => {
      if (!n) return;
      try {
        const objects = ed.clipboardSet();
        const t = await ed.ctx.send('POST', '/board/templates', { name: name.value.trim() || 'My template', objects, from_board: ed.doc.id });
        ed.ctx.toast(`Saved “${t.name}”.`, { icon: 'check' });
        ed.ui.closePop();
      } catch (e) { ed.ctx.oops(e); }
    };
    save.addEventListener('click', go);
    name.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  }, { cls: 'wide' });
}
