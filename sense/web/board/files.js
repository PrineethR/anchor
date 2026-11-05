// Pictures, files and links: paste them, drop them, or pick them. Pictures and files are stored beside the board;
// a pasted address becomes a card whose title, icon and preview are fetched by this Mac.

import { newId } from './doc.js';

const IMG = /^image\/(png|jpe?g|gif|webp|avif|bmp|svg\+xml)$/i;
const URL_RE = /^https?:\/\/[^\s]+$/i;
const MAX_W = 520;

export async function upload(ed, file, { keep = false } = {}) {
  const q = new URLSearchParams({ name: file.name || 'pasted', mime: file.type || '', keep: keep ? '1' : '0' });
  const r = await fetch(`/api/board/${ed.doc.id}/assets?${q}`, { method: 'POST', headers: { 'X-Makesense': '1', 'Content-Type': 'application/octet-stream' }, body: file });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || 'The file could not be kept.');
  return body;
}

function natural(file) {
  return new Promise(res => {
    const u = URL.createObjectURL(file), im = new Image();
    im.onload = () => { res({ w: im.naturalWidth || 320, h: im.naturalHeight || 240 }); URL.revokeObjectURL(u); };
    im.onerror = () => { res({ w: 320, h: 240 }); URL.revokeObjectURL(u); };
    im.src = u;
  });
}

/** Add pictures and files at a world point, in a tidy row. Returns the new objects. */
export async function importFiles(ed, files, at) {
  const out = [];
  let x = at.x, y = at.y, rowH = 0;
  const made = [];
  for (const f of files) {
    try {
      if (IMG.test(f.type)) {
        const [a, n] = await Promise.all([upload(ed, f), natural(f)]);
        const s = Math.min(1, MAX_W / n.w), w = Math.round(n.w * s), h = Math.round(n.h * s);
        made.push({ id: newId(), type: 'image', src: a.src, name: f.name || 'Picture', w, h });
      } else {
        const a = await upload(ed, f, { keep: true });
        made.push({ id: newId(), type: 'file', src: a.src, name: a.name, size: a.size, mime: a.mime, w: 280, h: 84 });
      }
    } catch (err) { ed.ctx.toast(err.message, { icon: 'info' }); }
  }
  if (!made.length) return out;
  const width = ed.cam.visible().w * 0.8;
  const startX = x;
  for (const o of made) {
    if (x > startX && x + o.w > startX + width) { x = startX; y += rowH + 24; rowH = 0; }
    o.x = x; o.y = y; x += o.w + 24; rowH = Math.max(rowH, o.h);
  }
  ed.doc.tx(made.length > 1 ? 'Add files' : made[0].type === 'image' ? 'Add picture' : 'Add file', () => {
    for (const o of made) { ed.doc.add(o); ed.adopt(o); }
    ed.select(made.map(o => o.id));
  });
  return made;
}

/** A pasted address becomes a card at once; its title, icon and preview arrive a moment later. */
export async function importLink(ed, url, at) {
  const o = { id: newId(), type: 'link', url, title: url.length < 70 ? url : new URL(url).hostname, host: hostOf(url), desc: '', w: 300, h: 96, x: at.x - 150, y: at.y - 48 };
  ed.doc.tx('Add link', () => { ed.doc.add(o); ed.adopt(o); ed.select([o.id]); });
  try {
    const r = await ed.ctx.send('POST', `/board/${ed.doc.id}/link`, { url });
    if (!ed.doc.map.has(o.id)) return o;
    const f = { title: r.title || o.title, host: r.host || o.host, desc: r.desc || '' };
    if (r.favicon) f.favicon = r.favicon;
    if (r.thumb) { f.thumb = r.thumb; f.h = 232; }
    else if (r.ok) f.h = 110;
    ed.doc.patch(o.id, f);
  } catch { /* offline or blocked: the plain card stays */ }
  return o;
}
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** One entry point for a paste or a drop: files first, then an address, then text. */
export async function take(ed, data, at, { drop = false } = {}) {
  const files = [...(data.files || [])];
  if (files.length) { await importFiles(ed, files, at); return true; }
  const uri = (data.getData('text/uri-list') || '').split('\n').map(s => s.trim()).find(s => URL_RE.test(s));
  const text = (data.getData('text/plain') || '').trim();
  if (uri) { await importLink(ed, uri, at); return true; }
  if (URL_RE.test(text)) { await importLink(ed, text, at); return true; }
  if (text && !drop) {
    const o = ed.add('text', { x: at.x - 120, y: at.y - 18, text, w: Math.min(420, Math.max(200, text.length * 9)) }, { select: true });
    ed.doc.tx('Fit text', () => ed.doc.patch(o.id, { h: heightOf(ed, o.id) }));
    return true;
  }
  if (text && drop) { ed.add('sticky', { x: at.x - 93, y: at.y - 93, text }, {}); return true; }
  return false;
}
import * as T from './text.js';
const heightOf = (ed, id) => T.textHeight(ed.doc.map.get(id));

/** Wire paste and drag-and-drop onto the board. Returns a function that removes them. */
export function attach(ed, root) {
  const onPaste = async e => {
    if (ed.destroyed || (ed.te && ed.te.open_)) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')) return;
    e.preventDefault();
    const cd = e.clipboardData, at = ed.pointer || ed.viewCenter();
    const text = cd.getData('text/plain');
    if (!cd.files.length) {
      const p = ed.clipped(text);
      if (p) { await ed.place(p, p.board === ed.doc.id && !ed.pointer ? null : at); return; }
    }
    if (!(await take(ed, cd, at))) ed.ctx.toast('Nothing on the clipboard can go on a board.', { icon: 'info' });
  };
  const over = e => { if (e.dataTransfer && [...e.dataTransfer.types].some(t => t === 'Files' || t === 'text/uri-list' || t === 'text/plain')) { e.preventDefault(); root.classList.add('dropping'); } };
  const leave = e => { if (!root.contains(e.relatedTarget)) root.classList.remove('dropping'); };
  const drop = async e => {
    root.classList.remove('dropping');
    if (!e.dataTransfer) return;
    e.preventDefault();
    const r = ed.cv.getBoundingClientRect(), at = ed.cam.toWorld(e.clientX - r.left, e.clientY - r.top);
    if (!(await take(ed, e.dataTransfer, at, { drop: true }))) ed.ctx.toast('That can\'t go on a board.', { icon: 'info' });
  };
  document.addEventListener('paste', onPaste);
  root.addEventListener('dragover', over); root.addEventListener('dragleave', leave); root.addEventListener('drop', drop);
  return () => { document.removeEventListener('paste', onPaste); root.removeEventListener('dragover', over); root.removeEventListener('dragleave', leave); root.removeEventListener('drop', drop); };
}

/** Open a file card's file with whatever opens it on this Mac. */
export async function openFile(ed, o) {
  try {
    const r = await ed.ctx.send('POST', `/board/${ed.doc.id}/open`, { src: o.src });
    ed.ctx.toast(r.revealed ? 'Shown in Finder (it could run code, so it was not opened).' : 'Opened.', { icon: 'check' });
  } catch (err) { ed.ctx.toast(err.message, { icon: 'info' }); }
}
