// The boards list: make one, find one, rename, duplicate, delete (to a trash you can bring things back from), import.

const COLORS = ['sky', 'blush', 'mint', 'violet', 'tangerine', 'berry'];

export function mountBoards(host, ctx) {
  const { ds, ico, esc, send, api, toast, oops, sheet, ask, guarded, plural, fmtDate, go } = ctx;
  let q = '', trash = false, dead = false, timer = 0;

  const colorOf = id => COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];

  async function draw() {
    const data = await api('/board' + (trash ? '/trash' : q ? '?q=' + encodeURIComponent(q) : ''));
    if (dead) return;
    const list = data.boards, inTrash = data.trash ?? list.length;
    host.innerHTML = `
      <h1 class="page-h">${trash ? 'Boards you <em>threw away</em>' : 'Jam on<br><em>an endless board</em>'}</h1>
      <p class="lead">${trash ? 'Nothing here is gone yet. Put a board back, or delete it for good.' : 'Sticky notes, shapes, arrows and pictures on a canvas that never runs out.'}</p>
      <div class="bd-bar">
        ${trash ? '' : `<label class="nw-field"><span class="nw-field__box">${ico('search', { size: 20 })}<input id="bq" type="search" placeholder="Search by title" aria-label="Search boards by title" value="${esc(q)}" spellcheck="false"></span></label>`}
        <button class="nw-btn nw-btn--soft" id="bimport" type="button">${ico('download', { size: 20, cls: 'nw-btn__icon' })}<span>Import a board</span></button>
        <button class="nw-btn nw-btn--soft" id="btrash" type="button">${ico(trash ? 'arrow-left' : 'trash-2', { size: 20, cls: 'nw-btn__icon' })}<span>${trash ? 'Back to boards' : `Trash${inTrash ? ` (${inTrash})` : ''}`}</span></button>
        <input id="bfile" type="file" accept=".json,application/json" hidden>
      </div>
      <ul class="bd-cards">
        ${list.map(b => `<li class="bd-card">
          ${trash ? '' : `<a href="#/board/${b.id}" aria-label="Open ${esc(b.title)}">`}
            <span class="frame" style="--nw-c:var(--${colorOf(b.id)});--nw-oc:var(--ink-900)"><span class="nw-card nw-card--raised art">${b.thumb || `<span>${ds.mood({ mood: 'dreamy', size: 56 })}</span>`}</span></span>
            <span class="t">${esc(b.title)}</span>
            <span class="nw-label">${esc([trash ? 'Thrown away ' + fmtDate(b.trashed || b.updated) : fmtDate(b.updated), plural(b.objects, 'object'), b.frames ? plural(b.frames, 'frame') : ''].filter(Boolean).join(' · '))}</span>
          ${trash ? '' : '</a>'}
          <span class="acts">${trash
            ? `<button class="nw-ib nw-ib--soft" data-act="restore" data-id="${b.id}" aria-label="Put ${esc(b.title)} back" title="Put back">${ico('refresh-cw', { size: 18, sw: 1.6 })}</button>
               <button class="nw-ib nw-ib--soft" data-act="purge" data-id="${b.id}" aria-label="Delete ${esc(b.title)} for good" title="Delete for good">${ico('trash-2', { size: 18, sw: 1.6 })}</button>`
            : `<button class="nw-ib nw-ib--soft" data-act="rename" data-id="${b.id}" data-title="${esc(b.title)}" aria-label="Rename ${esc(b.title)}" title="Rename">${ico('pencil', { size: 18, sw: 1.6 })}</button>
               <button class="nw-ib nw-ib--soft" data-act="dup" data-id="${b.id}" aria-label="Duplicate ${esc(b.title)}" title="Duplicate">${ico('copy', { size: 18, sw: 1.6 })}</button>
               <button class="nw-ib nw-ib--soft" data-act="del" data-id="${b.id}" data-title="${esc(b.title)}" aria-label="Move ${esc(b.title)} to the trash" title="Move to the trash">${ico('trash-2', { size: 18, sw: 1.6 })}</button>`}</span>
        </li>`).join('')}
        ${trash ? '' : `<li><button class="nw-card nw-card--dashed bd-new" id="bnew" type="button">${ds.illustration('empty-notes', { size: 140, still: list.length > 0 })}
          <span class="nw-btn nw-btn--primary">${ico('plus', { size: 20, cls: 'nw-btn__icon' })}<span>${list.length ? 'New board' : 'Start a board'}</span></span></button></li>`}
      </ul>
      ${!list.length && (trash || q) ? `<p class="bd-empty">${trash ? 'The trash is empty.' : `No board is called anything like “${esc(q)}”.`}</p>` : ''}`;
    bind();
    if (q && document.activeElement !== host.querySelector('#bq')) { const i = host.querySelector('#bq'); if (i) { i.focus(); i.setSelectionRange(q.length, q.length); } }
  }

  async function create() {
    const b = await guarded('Opening a fresh board…', '', () => send('POST', '/board', {}));
    if (b) go('#/board/' + b.id);
  }

  function bind() {
    const $ = s => host.querySelector(s);
    const nb = $('#bnew'); if (nb) nb.onclick = create;
    $('#btrash').onclick = () => { trash = !trash; q = ''; draw().catch(oops); };
    const search = $('#bq');
    if (search) search.oninput = () => { q = search.value; clearTimeout(timer); timer = setTimeout(() => draw().catch(oops), 160); };
    const file = $('#bfile');
    $('#bimport').onclick = () => file.click();
    file.onchange = async () => {
      const f = file.files[0]; file.value = '';
      if (!f) return;
      const b = await guarded('Reading the board…', '', async () => {
        let doc;
        try { doc = JSON.parse(await f.text()); } catch { throw new Error("That file isn't an Anchor board."); }
        return send('POST', '/board/import', doc);
      });
      if (b) { toast('Imported.', { mood: 'joyful' }); go('#/board/' + b.id); }
    };
    host.querySelectorAll('[data-act]').forEach(btn => btn.onclick = async e => {
      e.preventDefault(); e.stopPropagation();
      const { act, id, title } = btn.dataset;
      try {
        if (act === 'rename') {
          const r = await sheet({ title: 'Rename <em>board</em>', body: `<label class="nw-field"><span class="nw-field__box"><input id="rn" value="${esc(title)}" maxlength="120" aria-label="Board title"></span></label>`,
            // preventDefault on Enter: else it lands on the button focus returns to, and reopens this dialog
            buttons: [{ id: 'ok', label: 'Rename', variant: 'primary' }], read: el => el.querySelector('#rn').value, onMount: el => { const i = el.querySelector('#rn'); i.focus(); i.select(); i.onkeydown = ev => { if (ev.key === 'Enter') { ev.preventDefault(); el.querySelector('[data-id=ok]').click(); } };} });
          if (r.id === 'ok' && r.data.trim()) { await send('PUT', '/board/' + id, { title: r.data.trim() }); toast('Renamed.', { icon: 'check' }); }
        } else if (act === 'dup') { await send('POST', `/board/${id}/duplicate`, {}); toast('Duplicated.', { icon: 'copy' }); }
        else if (act === 'del') {
          if (await ask({ title: 'Move to <em>the trash?</em>', body: `“${esc(title)}” goes to the trash. You can put it back from there.`, yes: 'Move to trash', danger: true })) { await send('DELETE', '/board/' + id); toast('Moved to the trash.', { icon: 'trash-2' }); }
        } else if (act === 'restore') { await send('POST', `/board/${id}/restore`, {}); toast('Put back.', { icon: 'check' }); }
        else if (act === 'purge') {
          if (await ask({ title: 'Delete <em>for good?</em>', body: 'This board and its pictures and files are erased. This cannot be undone.', yes: 'Delete for good', danger: true })) { await send('POST', `/board/${id}/purge`, {}); toast('Deleted for good.', { icon: 'trash-2' }); }
        }
      } catch (err) { oops(err); }
      draw().catch(oops);
    });
  }

  draw().catch(oops);
  return { destroy() { dead = true; clearTimeout(timer); host.innerHTML = ''; } };
}
