// Draw what makeSense found: HTML for the app, a standalone file to send, Markdown to paste.
// A port of sense/share.py. Everything that comes from a Python module's own text (the design system's
// stylesheet, the thread markers) is handed in once with configure(): the build step writes it.
import { layout, renderHtml } from './layout.js';
import { esc, fmt } from './pyish.js';

let cfg = { threadMarks: [], signOff: '', themeCss: '', shareCss: '', canvasCss: '' };
/** { threadMarks: [svg...], signOff, themeCss (with the fonts inlined), shareCss, canvasCss } */
export function configure(c) { cfg = { ...cfg, ...c }; }

const ARROW = '<svg class="nw-icon via-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';

const threadMark = i => cfg.threadMarks[i % cfg.threadMarks.length];

function term(it) {
  let text = esc(it.text);
  if (it.underline) text = `<span class="kt">${text}</span>`;
  if (it.caps) text = `<span class="caps">${text}</span>`;
  const via = it.via;
  let lead = '';
  if (via) {
    if (via.kind === 'hook') lead = '<span class="via aside">aside</span>';
    else if (via.label) {
      let word = esc(via.label);
      if (via.caps) word = `<span class="caps">${word}</span>`;
      if (via.underline) word = `<span class="kt">${word}</span>`;
      lead = `<span class="via">${word}${ARROW}</span>`;
    }
  }
  const check = it.action ? '<span class="cb" aria-hidden="true"></span>' : '';
  const cls = 'row' + (it.action ? ' todo' : '') + (it.ref ? ' ref' : '');
  const tail = it.ref ? ' <span class="ref">(see above)</span>' : '';
  return `<span class="${cls}">${check}${lead}${text}${tail}</span>`;
}

const ul = items => `<ul>${items.map(i => `<li data-ids="${esc(i.ids.join(' '))}">${term(i)}${i.children.length ? ul(i.children) : ''}</li>`).join('')}</ul>`;

export function senseHtml(sense, editable = false, empty = null) {
  const out = ['<div class="sense">', '<h3>Threads</h3>'];
  sense.threads.forEach((t, i) => out.push(`<section class="nw-card nw-card--raised thread th${i % 6}" data-ids="${esc(t.ids.join(' '))}">` +
    `<span class="thread-mark">${threadMark(i)}</span>${ul(t.roots)}</section>`));
  if (!sense.threads.length) {
    out.push('<p class="empty">' + (empty || (editable ? 'No arrows yet. Draw them in with Fix readings.' : 'No arrows were found on this page.')) + '</p>');
  }
  if (sense.actions.length) {
    out.push('<h3>To-dos</h3><div class="nw-card nw-card--sunken"><ul class="todos">');
    for (const a of sense.actions) out.push(`<li data-ids="${esc(a.id)}"><span class="cb" aria-hidden="true"></span><span>${esc(a.text)}</span></li>`);
    out.push('</ul></div>');
  }
  if (sense.key_terms.length) {
    out.push('<h3>Key terms</h3><ul class="tags">');
    for (const k of sense.key_terms) {
      const marks = k.kind === 'caps' || k.kind === 'both';
      out.push(`<li class="tag${marks ? ' caps-t' : ''}" data-ids="${esc(k.id)}"><span class="dot${k.kind === 'underline' || k.kind === 'both' ? ' hl' : ''}"></span>${esc(k.text)}</li>`);
    }
    out.push('</ul>');
  }
  if (sense.loose.length) {
    out.push('<h3>Loose notes</h3>');
    for (const g of sense.loose) {
      const rows = g.items.map(i => `<div data-ids="${esc(i.ids.join(' '))}">${term(i)}</div>`).join('');
      out.push(`<div class="nw-card nw-card--sunken nw-card--sm note-group">${rows}</div>`);
    }
  }
  out.push('</div>');
  return out.join('');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function when(iso, full) {
  const [, y, m, d] = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const name = MONTHS[+m - 1];
  return `${+d} ${full ? name : name.slice(0, 3)} ${y}`;
}

/** A standalone page. `photoB64` is the page photo as base64 JPEG, or null. */
export function toHtml(note, photoB64 = null) {
  const { sense, page } = note;
  const date = when(note.created, false);
  const photoHtml = photoB64 ? `<details class="photo"><summary>See the photo</summary><img alt="The handwritten page" src="data:image/jpeg;base64,${photoB64}"></details>` : '';
  const summary = esc((note.narration && note.narration.summary) || sense.summary);
  const px = !!note.px;
  const voice = { kicker: 'Typed up from handwriting', section: 'The page, <em>retyped</em>',
    footer: 'A machine read the handwriting and the writer checked it, so a word or two may still be off.', ...(note.voice || {}) };
  const threadOf = {};
  sense.threads.forEach((t, n) => t.ids.forEach(i => { threadOf[i] = n; }));
  const lay = layout(page, threadOf, !px);
  let drawing = renderHtml(lay);
  if (px) {
    const s = Math.max(Math.min(1.0, 840 / lay.w), 0.45);
    drawing = `<div style="width:${fmt(lay.w * s, 0)}px;height:${fmt(lay.h * s, 0)}px"><div style="width:${fmt(lay.w, 0)}px;` +
      `transform:scale(${fmt(s, 3)});transform-origin:0 0">${drawing}</div></div>`;
  }
  const css = cfg.themeCss + cfg.shareCss + cfg.canvasCss;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(note.title)}</title>
<style>${css}
body { background: var(--bg-canvas); }
main { max-width: 56rem; margin: 0 auto; padding: var(--s-7) var(--gutter) var(--s-8); }
.doc-head h1 { font: var(--w-regular) var(--t-h1)/var(--lh-tight) var(--font-display); letter-spacing: var(--ls-display); margin: var(--s-3) 0 var(--s-4); }
.lead { font: var(--w-regular) var(--t-lead)/var(--lh-body) var(--font-body); color: var(--fg-1); max-width: 34rem; margin: 0; }
section.page { margin: var(--s-7) 0 var(--s-6); }
section.page h2 { font: var(--w-regular) var(--t-h2)/var(--lh-tight) var(--font-display); margin: 0 0 var(--s-3); }
.frame { background: var(--bg-surface); border-radius: var(--radius-2xl); padding: 8px; box-shadow: var(--shadow-1); }
.frame .scroll { overflow-x: auto; border-radius: var(--radius-xl); }
.frame .canvas { background: var(--bg-canvas); }
.frame.big .scroll { max-height: 75vh; overflow: auto; }
details.photo { margin: var(--s-6) 0 0; }
details.photo summary { cursor: pointer; font: var(--w-medium) var(--t-ui)/1.3 var(--font-ui); color: var(--fg-2); }
details.photo img { display: block; max-width: 100%; margin-top: var(--s-3); border-radius: var(--radius-xl); box-shadow: var(--shadow-1); }
footer { display: flex; gap: var(--s-4); align-items: center; margin-top: var(--s-8); padding-top: var(--s-5); border-top: 1px solid var(--line-soft);
  color: var(--fg-2); font: var(--w-regular) var(--t-sm)/1.45 var(--font-ui); }
footer svg { flex: none; }
.wordmark { font: var(--w-regular) 1.1em/1 var(--font-serif); letter-spacing: var(--ls-display); color: var(--fg-1); }
.wordmark em { font-style: italic; }
@media print { body { background: var(--paper-0); } .frame .scroll { overflow: visible; } }
</style></head><body><main>
<header class="doc-head">
<p class="nw-label">${voice.kicker} · ${date}</p>
<h1>${esc(note.title)}</h1>
<p class="lead">${summary}</p>
</header>
<section class="page"><h2>${voice.section}</h2><div class="frame${px ? ' big' : ''}"><div class="scroll">${drawing}</div></div></section>
${senseHtml(sense)}
${photoHtml}
<footer>${cfg.signOff}<p>Typed up with <span class="wordmark">Make <em>sense</em></span>. ${voice.footer}</p></footer>
</main></body></html>`;
}

function mdItem(it, depth) {
  let text = it.text;
  if (it.underline) text = `**${text}**`;
  const via = it.via;
  let lead = '';
  if (via) lead = via.kind === 'hook' ? '(aside) ' : (via.label ? `_${via.label}_ → ` : '');
  const box = it.action ? '[ ] ' : '';
  const ref = it.ref ? ' _(see above)_' : '';
  const lines = ['  '.repeat(depth) + `- ${box}${lead}${text}${ref}`];
  for (const c of it.children) lines.push(...mdItem(c, depth + 1));
  return lines;
}

export function toMarkdown(note) {
  const { sense } = note;
  const date = when(note.created, true);
  const summary = (note.narration && note.narration.summary) || sense.summary;
  const kicker = (note.voice && note.voice.md) || 'Typed up from handwritten notes';
  const out = [`# ${note.title}`, `_${kicker} on ${date}_`, '', summary, ''];
  if (sense.threads.length) {
    out.push('## Threads', '');
    for (const t of sense.threads) { for (const r of t.roots) out.push(...mdItem(r, 0)); out.push(''); }
  }
  if (sense.actions.length) out.push('## To-dos', '', ...sense.actions.map(a => `- [ ] ${a.text}`), '');
  if (sense.key_terms.length) out.push('## Key terms', '', sense.key_terms.map(k => k.text).join(', '), '');
  if (sense.loose.length) {
    out.push('## Loose notes', '');
    for (const g of sense.loose) { out.push(`- ${g.items[0].text}`); for (const i of g.items.slice(1)) out.push(`  ${i.text}`); }
    out.push('');
  }
  return out.join('\n').replace(/\s+$/, '') + '\n';
}
