// Ask Claude: pick a model, say what you want (or pick a starter), and the new notes land in empty space as one undo step.

import * as G from './geom.js';

const STARTERS = [
  ['Expand', 'Add new ideas that build on these notes.'],
  ['Challenge', 'Add questions and counterpoints that poke holes in these notes.'],
  ['Summarize', 'Add one note that sums up the main themes, with arrows to the notes it covers.'],
  ['Group', 'Add one note per theme, with arrows to the notes that belong to it.'],
];
const k = n => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
const usd = c => '$' + (c < 0.01 ? c.toFixed(3) : c.toFixed(2));

export async function open(ed, anchor) {
  const { esc } = ed.ctx, ic = ed.ui.ic;
  const n = [...ed.v.sel].filter(i => ed.doc.map.has(i)).length;
  const info = await ed.ctx.api('/board/usage').catch(() => ({ models: { haiku: 'Haiku' }, default: 'haiku', today: { runs: 0, in: 0, out: 0, cost: 0 }, week: { runs: 0, in: 0, out: 0, cost: 0 }, last: [] }));
  const model = info.models[ed.pref.askModel] ? ed.pref.askModel : info.default;
  const line = (label, t) => `${label}: ${t.runs} run${t.runs === 1 ? '' : 's'}, ${k(t.in)} in / ${k(t.out)} out${t.cost ? `, about ${usd(t.cost)} at API prices` : ''}`;
  ed.ui.popup(anchor, `
    <div class="bd-ask">
      <div class="bd-ask-head"><h2 class="bd-h">Ask Claude</h2>
        <button class="nw-ib nw-ib--soft nw-ib--sm" type="button" data-hist aria-label="Past requests" title="Past requests">${ic('history', { size: 18, sw: 1.6 })}</button></div>
      <p class="bd-scope">${n ? `About the ${n} selected` : 'About the whole board'}. It only adds notes; it never changes yours.</p>
      <div class="bd-starters">${STARTERS.map(([t, p], i) => `<button class="bd-btn-text" type="button" data-s="${i}">${esc(t)}</button>`).join('')}</div>
      <textarea rows="3" placeholder="What should Claude add?" aria-label="What should Claude add?"></textarea>
      <div class="bd-ask-foot">
        <select aria-label="Model">${Object.entries(info.models).map(([id, name]) => `<option value="${id}"${id === model ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>
        <button class="nw-btn nw-btn--primary" type="button" data-go>${ic('sparkles', { size: 18, cls: 'nw-btn__icon' })}<span>Ask</span></button>
      </div>
      <p class="hint" data-msg role="status"></p>
      <p class="hint" data-use>${esc(line('Today', info.today))}<br>${esc(line('Last 7 days', info.week))}</p>
    </div>`, el => {
    const main = el.querySelector('.bd-ask'), when = t => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    el.querySelector('[data-hist]').addEventListener('click', async () => {
      const runs = (await ed.ctx.api('/board/history').catch(() => ({ runs: [] }))).runs;
      const back = main.innerHTML;
      main.innerHTML = `<div class="bd-ask-head"><h2 class="bd-h">Past requests</h2><button class="nw-ib nw-ib--soft nw-ib--sm" type="button" data-back aria-label="Back" title="Back">${ic('arrow-left', { size: 18, sw: 1.6 })}</button></div>
        ${runs.length ? `<ol class="bd-past">${runs.map((r, i) => `<li><button type="button" data-run="${i}"><b>${esc(r.prompt)}</b>
          <span>${esc(when(r.t))} · ${esc(r.model)} · ${r.notes} note${r.notes === 1 ? '' : 's'} · ${k(r.in)} in / ${k(r.out)} out${r.board === ed.doc.id ? ' · this board' : ''}</span>${r.say ? `<span>${esc(r.say)}</span>` : ''}</button></li>`).join('')}</ol>` : '<p class="hint">Nothing yet. Requests you send will be listed here.</p>'}
        <p class="hint">Click one to use its request again.</p>`;
      el.style.top = Math.max(60, Math.min(parseFloat(el.style.top), ed.ui.root.getBoundingClientRect().height - el.offsetHeight - 12)) + 'px';   // the list is taller than the panel was
      main.querySelector('[data-back]').addEventListener('click', () => { ed.ui.closePop(); open(ed, anchor); });
      main.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => { ed.ui.closePop(); open(ed, anchor).then(() => { const t = document.querySelector('.bd-ask textarea'); if (t) { t.value = runs[b.dataset.run].prompt; t.focus(); } }); }));
    });
    const box = el.querySelector('textarea'), go = el.querySelector('[data-go]'), msg = el.querySelector('[data-msg]');
    el.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => { box.value = STARTERS[b.dataset.s][1]; box.focus(); }));
    const ask = async () => {
      const prompt = box.value.trim();
      if (!prompt) { msg.textContent = 'Say what you would like Claude to do, or pick a starter.'; box.focus(); return; }
      const m = el.querySelector('select').value;
      ed.savePref({ askModel: m });
      go.disabled = true; msg.textContent = 'Claude is thinking. This takes 5 to 30 seconds.';
      try {
        await ed.sync.flush(true);
        const out = await ed.ctx.send('POST', `/board/${ed.doc.id}/ask`, { prompt, model: m, selected: [...ed.v.sel] });
        const added = place(ed, out.objects);
        const u = out.usage;
        msg.textContent = `${added ? `Added ${added} note${added === 1 ? '' : 's'}. ` : 'Nothing to add. '}${out.say} (${m}, ${k(u.in)} in / ${k(u.out)} out, ${u.secs}s)`.trim();
        if (added) { go.disabled = false; box.select(); }
      } catch (e) { msg.textContent = e.message || 'That did not work.'; }
      go.disabled = false;
    };
    go.addEventListener('click', ask);
    box.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); } });
    box.focus();
  });
}

/** Put the new objects where nothing is: beside the selection if there is room, else beside everything. One undo step. */
function place(ed, objs) {
  const stickies = objs.filter(o => o.type !== 'connector');
  if (!stickies.length) return 0;
  const w = Math.max(...stickies.map(o => o.x + o.w)), h = Math.max(...stickies.map(o => o.y + o.h));
  const others = ed.doc.list().filter(o => o.type !== 'connector' && o.type !== 'frame');
  const free = (x, y) => !others.some(o => o.x < x + w + 24 && o.x + o.w > x - 24 && o.y < y + h + 24 && o.y + o.h > y - 24);
  const sel = G.union(ed.selected().filter(o => o.type !== 'connector').map(o => ed.boxOf(o)));
  const all = G.union(others.map(o => ed.boxOf(o)));
  const spots = [];
  if (sel) spots.push([sel.x + sel.w + 60, sel.y], [sel.x, sel.y + sel.h + 60]);
  if (all) spots.push([all.x + all.w + 60, all.y], [all.x, all.y + all.h + 60]);
  else { const c = ed.cam.toWorld(ed.cam.w / 2, ed.cam.h / 2); spots.push([c.x - w / 2, c.y - h / 2]); }
  const [dx, dy] = spots.find(([x, y]) => free(x, y)) || [all.x + all.w + 60, all.y];
  ed.doc.tx('Ask Claude', () => { for (const o of objs) ed.doc.add(o.type === 'connector' ? o : { ...o, x: o.x + dx, y: o.y + dy }); });
  ed.select(stickies.map(o => o.id));
  const b = G.union(stickies.map(o => ed.boxOf(ed.doc.map.get(o.id))));
  const v = ed.cam.visible();
  if (b.x < v.x || b.y < v.y || b.x + b.w > v.x + v.w || b.y + b.h > v.y + v.h) ed.cam.flyTo(ed.cam.framing(G.union([b, ...(sel ? [sel] : [])]), 120, 1));
  return stickies.length;
}
