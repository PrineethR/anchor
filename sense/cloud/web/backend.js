// The website's "server": what sense/app.py does for the local app, done in the browser against Firestore.
//
// The UI talks to it with the same api('/notes/...') calls it makes to the Python server, and gets the same shapes back.
// Everything you own lives under users/{uid}/ (see firestore.rules):
//
//   pages/{id}                  a photographed page: title, status (queued | ready | failed), pageJson, counts, a small thumb
//   pages/{id}/files/flat       its photo (JPEG bytes, under 1 MiB)
//   notebooks/{id}              a notebook's small part: title, colour, rev, counts, a thumbnail picture
//   notebooks/{id}/parts/body   its items and arrows (JSON)
//   notebooks/{id}/files/{name} its photos
//   profile/default             what the Mac has learned about your writing (written by the Mac only)
//   profileEdits/{id}           changes you asked for on the site, for the Mac to apply
//   state/mac                   when the Mac last said it was awake
//
// A photo you add waits as `queued` until the Mac reads it (sense/cloud/worker.py). Everything already read is yours to
// open, and notebooks are yours to write, whether the Mac is on or not; Firestore keeps a copy on this device for offline.
import * as F from './lib/firebase.js';
import { cleanPage } from './pageclean.js';
import { layout, renderHtml } from './layout.js';
import { makeSense } from './meaning.js';
import { blank, cleanItems, cleanLinks, COLORS, importPage, thumbSvg, threadOf, toPage } from './notebook.js';
import { preparePhoto } from './photo.js';
import { configure, senseHtml, toHtml, toMarkdown } from './render.js';

const MAC_FRESH_MS = 180_000;                       // the Mac says it is awake every minute
const DEFAULT_CUES = ['add', 'looking into', 'todo', 'to do', 'follow up', 'ask', 'email', 'call', 'send', 'check'];
const EMPTY_STATS = { pages: 0, text_nodes: 0, words_per_node: 0, underline_rate: 0, caps_rate: 0, links_per_page: 0, link_kinds: {}, connector_words: [] };
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const MAX_BODY = 900 * 1024;

export class ApiError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const notFound = () => new ApiError("That page isn't here any more.", 404);
const pad = (n, w = 2) => String(n).padStart(w, '0');
const nowIso = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
function newId() {
  const d = new Date(), r = crypto.getRandomValues(new Uint8Array(2));
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${[...r].map(b => pad(b.toString(16))).join('')}`;
}
const slug = (text, dflt) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || dflt;
const b64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
const isNetwork = e => ['unavailable', 'deadline-exceeded', 'cancelled'].includes(e?.code) || /offline/i.test(e?.message || '');

export function createBackend({ db, user, onSignOut }) {
  const uid = user.uid;
  const P = {
    pages: () => F.collection(db, 'users', uid, 'pages'),
    page: id => F.doc(db, 'users', uid, 'pages', id),
    pageFiles: id => F.collection(db, 'users', uid, 'pages', id, 'files'),
    file: (id, name) => F.doc(db, 'users', uid, 'pages', id, 'files', name),
    nbs: () => F.collection(db, 'users', uid, 'notebooks'),
    nb: id => F.doc(db, 'users', uid, 'notebooks', id),
    body: id => F.doc(db, 'users', uid, 'notebooks', id, 'parts', 'body'),
    nbFiles: id => F.collection(db, 'users', uid, 'notebooks', id, 'files'),
    nbFile: (id, name) => F.doc(db, 'users', uid, 'notebooks', id, 'files', name),
    profile: () => F.doc(db, 'users', uid, 'profile', 'default'),
    edits: () => F.collection(db, 'users', uid, 'profileEdits'),
    edit: id => F.doc(db, 'users', uid, 'profileEdits', id),
    mac: () => F.doc(db, 'users', uid, 'state', 'mac'),
  };

  // ---- live copies of the small documents ------------------------------------------------------------------------------
  const S = { pages: new Map(), nbs: new Map(), profile: null, edits: [], mac: null };
  const link = {}, unsent = new Set();   // per collection: is the server reachable, is something waiting to be sent; and which pages are not yet on the server
  const ready = {}, readyWaiters = {}, subs = new Set(), unsubs = [];
  const emit = kind => subs.forEach(s => s.kinds.includes(kind) && s.cb(kind));
  const whenReady = name => ready[name] ? Promise.resolve() : Promise.race([new Promise(r => { (readyWaiters[name] ||= []).push(r); }), new Promise(r => setTimeout(r, 6000))]);
  const markReady = name => { ready[name] = true; (readyWaiters[name] || []).forEach(r => r()); };
  const netState = () => ({ online: navigator.onLine !== false, connected: !link.pages?.fromCache, pending: Object.values(link).some(l => l.pending) });
  let lastNet = '';
  const emitNet = () => { const j = JSON.stringify(netState()); if (j !== lastNet) { lastNet = j; emit('net'); } };
  window.addEventListener('online', emitNet); window.addEventListener('offline', emitNet);
  const listenCollection = (name, ref, map) => unsubs.push(F.onSnapshot(ref, { includeMetadataChanges: true }, snap => {
    snap.docChanges({ includeMetadataChanges: true }).forEach(ch => {
      if (ch.type === 'removed') { map.delete(ch.doc.id); unsent.delete(ch.doc.id); return; }
      map.set(ch.doc.id, ch.doc.data());
      if (name === 'pages') (ch.doc.metadata.hasPendingWrites ? unsent.add(ch.doc.id) : unsent.delete(ch.doc.id));
    });
    link[name] = { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites };
    markReady(name); emit(name); emitNet();
  }, err => { console.warn(name, err); markReady(name); emit('error'); }));
  listenCollection('pages', P.pages(), S.pages);
  listenCollection('notebooks', P.nbs(), S.nbs);
  unsubs.push(F.onSnapshot(P.profile(), s => { S.profile = s.exists() ? s.data() : null; markReady('profile'); emit('profile'); }, () => markReady('profile')));
  unsubs.push(F.onSnapshot(P.edits(), s => { S.edits = s.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.at || 0) - (b.at || 0)); markReady('edits'); emit('profile'); }, () => markReady('edits')));
  unsubs.push(F.onSnapshot(P.mac(), s => { S.mac = s.exists() ? s.data() : null; markReady('mac'); emit('mac'); }, () => markReady('mac')));
  const tick = setInterval(() => emit('mac'), 30_000);

  const live = m => [...m.values()].filter(d => !d.deleted);
  const macState = () => {
    const seen = S.mac?.seen?.toMillis?.() ?? null;
    return { online: seen !== null && Date.now() - seen < MAC_FRESH_MS, seen: seen === null ? null : new Date(seen).toISOString(), host: S.mac?.host || null };
  };
  /** Write and carry on: online it waits briefly so a refusal reaches you; offline Firestore keeps the write and sends it later. */
  const soft = promise => Promise.race([promise, new Promise(r => setTimeout(r, navigator.onLine ? 8000 : 0))]);

  // ---- your writing profile (kept by the Mac), with what you asked for since laid over it ---------------------------------
  function profileView() {
    let v = { shorthand: { 7: 'of' }, action_cues: [...DEFAULT_CUES], fixes: [], vocab: [], stats: EMPTY_STATS, sources: { notes: 0, labeled: 0 } };
    if (S.profile?.viewJson) { try { v = { ...v, ...JSON.parse(S.profile.viewJson) }; } catch { /* a bad copy: show the defaults */ } }
    for (const e of S.edits) {
      if (e.shorthand) v.shorthand = Object.fromEntries(Object.entries(e.shorthand).map(([k, x]) => [k.trim(), String(x).trim()]).filter(([k, x]) => k && x));
      if (e.action_cues) v.action_cues = cleanCues(e.action_cues);
      if (e.forget?.length) v.fixes = v.fixes.filter(f => !e.forget.includes(f.raw));
    }
    return { ...v, learned: !!S.profile, pending: S.edits.length };
  }
  const cleanCues = cues => { const seen = new Set(), out = []; for (const c of cues) { const x = String(c).toLowerCase().split(/\s+/).filter(Boolean).join(' '); if (x && !seen.has(x)) { seen.add(x); out.push(x); } } return out; };
  const cues = () => profileView().action_cues;

  // ---- photos ----------------------------------------------------------------------------------------------------------
  const urls = new Map();
  const urlFor = (key, make) => { if (!urls.has(key)) urls.set(key, make()); return urls.get(key); };
  const blobUrl = (u8, type = 'image/jpeg') => URL.createObjectURL(new Blob([u8], { type }));
  const dropUrls = prefix => [...urls.keys()].filter(k => k.startsWith(prefix)).forEach(k => { URL.revokeObjectURL(urls.get(k)); urls.delete(k); });
  /** A photo document: from this device if it has the current one, else from the server. `rev` is the revision wanted (none: any copy will do). */
  async function fileDoc(ref, rev) {
    try {
      const c = await F.getDocFromCache(ref);
      if (c.exists() && (rev === undefined || c.data().rev === rev || navigator.onLine === false)) return c.data();
    } catch { /* not kept on this device */ }
    const s = await F.getDoc(ref);
    return s.exists() ? s.data() : null;
  }
  const thumbUrl = d => (d?.thumb ? urlFor(`t:${d.id}:${d.photoRev || 0}`, () => blobUrl(d.thumb.toUint8Array())) : BLANK);
  const flatUrl = async id => {
    const d = S.pages.get(id);
    const key = `f:${id}:${d?.photoRev || 0}`;
    if (urls.has(key)) return urls.get(key);
    const f = await fileDoc(P.file(id, 'flat'), d?.photoRev || 0);
    if (!f) throw notFound();
    return urlFor(key, () => blobUrl(f.bytes.toUint8Array(), f.type));
  };
  const assetUrl = async (nid, name) => {
    const key = `a:${nid}:${name}`;
    if (urls.has(key)) return urls.get(key);
    const f = await fileDoc(P.nbFile(nid, name));
    if (!f) throw new ApiError('That photo is missing.', 404);
    return urlFor(key, () => blobUrl(f.bytes.toUint8Array(), f.type));
  };
  /** Attributes for an <img> of a page's photo: the small copy right away, the full one swapped in when it arrives. */
  const photoAttr = (id, v = '', full = true) => `src="${thumbUrl(S.pages.get(id))}"${full ? ` data-cloud-photo="${id}"` : ''}`;
  const hydrate = root => (root.querySelectorAll ? root.querySelectorAll('img[data-cloud-photo]:not([data-cloud-done])') : []).forEach(img => {
    img.dataset.cloudDone = '1';
    flatUrl(img.dataset.cloudPhoto).then(u => { img.src = u; }).catch(() => { delete img.dataset.cloudDone; });
  });
  const watcher = new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && (n.matches?.('img[data-cloud-photo]') ? hydrate(n.parentNode) : hydrate(n)))));
  watcher.observe(document.body, { childList: true, subtree: true });

  // ---- pages -----------------------------------------------------------------------------------------------------------
  function noteView(d) {
    const base = { id: d.id, title: d.title || 'Untitled page', created: d.created, how: d.how || '', turns: d.turns || 0, sure: d.sure !== false, crop: d.crop !== false,
      source: d.source || 'vision', confirmed: !!d.confirmed, edited: !!d.edited, engine_notes: d.engineNotes || [], changes: d.changes || [],
      narration: null, can_narrate: false, status: d.status || 'ready', error: d.error || null, rev: d.rev || 0, unsent: unsent.has(d.id) };
    if (!d.pageJson) return { ...base, page: null, layout: null, sense: null, sense_html: '', clean_html: '' };
    const page = JSON.parse(d.pageJson);
    const sense = makeSense(page, cues());
    const lay = layout(page, threadOf(sense));
    return { ...base, page, layout: lay, sense, sense_html: senseHtml(sense, true), clean_html: renderHtml(lay) };
  }
  const pageDoc = async id => { await whenReady('pages'); const d = S.pages.get(id); if (!d || d.deleted) throw notFound(); return d; };

  async function listNotes() {
    await whenReady('pages');
    return live(S.pages).sort((a, b) => (a.id < b.id ? 1 : -1)).map(d => ({ id: d.id, title: d.title || 'Untitled page', created: d.created, source: d.source || 'vision',
      confirmed: !!d.confirmed, threads: d.threads || 0, loose: d.loose || 0, actions: d.actions || 0, status: d.status || 'ready', error: d.error || null, unsent: unsent.has(d.id) }));
  }

  async function createNote(blob) {
    if (!blob || !blob.size) throw new ApiError('That upload was empty. Choose the photo again.');
    const { full, thumb, w, h } = await preparePhoto(blob);
    const id = newId();
    const doc = { id, title: '', created: nowIso(), status: 'queued', error: null, source: null, how: '', turns: 0, sure: true, crop: true, confirmed: false, edited: false,
      engineNotes: [], changes: [], pageJson: null, threads: 0, loose: 0, actions: 0, thumb: F.Bytes.fromUint8Array(thumb), photoRev: 1, rev: 0, learnedRev: 0,
      request: null, doneRequest: null, deleted: false, updatedAt: F.serverTimestamp() };
    const b = F.writeBatch(db);
    b.set(P.page(id), doc);
    b.set(P.file(id, 'flat'), { bytes: F.Bytes.fromUint8Array(full), type: 'image/jpeg', w, h, rev: 1 });
    S.pages.set(id, doc); unsent.add(id); emit('pages');
    await soft(b.commit());
    return noteView(doc);
  }

  async function saveNote(id, body) {
    const d = await pageDoc(id);
    const patch = {};
    if (body.page) {
      if (!d.pageJson) throw new ApiError("That page hasn't been read yet. Your Mac reads it when it is on.");
      const page = cleanPage(body.page, id), sense = makeSense(page, cues());
      Object.assign(patch, { pageJson: JSON.stringify(page), edited: true, threads: sense.stats.threads, loose: sense.stats.loose, actions: sense.actions.length });
    }
    if ('confirmed' in body) patch.confirmed = !!body.confirmed;
    if ('title' in body) patch.title = String(body.title).trim().slice(0, 120) || d.title;
    if (body.page || 'confirmed' in body) patch.rev = (d.rev || 0) + 1;   // the Mac learns from anything that changed the words
    patch.updatedAt = F.serverTimestamp();
    const next = { ...d, ...patch };
    S.pages.set(id, next); emit('pages');
    await soft(F.updateDoc(P.page(id), patch));
    return noteView(next);
  }

  async function previewNote(id, page) {
    await pageDoc(id);
    const clean = cleanPage(page, id), sense = makeSense(clean, cues()), lay = layout(clean, threadOf(sense));
    return { sense, sense_html: senseHtml(sense, true), clean_html: renderHtml(lay), layout: lay };
  }

  async function rereadNote(id, { rotate, crop }) {
    const d = await pageDoc(id);
    const patch = { status: 'queued', error: null, request: { id: newId(), rotate: !!rotate, crop: crop === undefined || crop === null ? null : !!crop }, updatedAt: F.serverTimestamp() };
    S.pages.set(id, { ...d, ...patch }); emit('pages');
    await soft(F.updateDoc(P.page(id), patch));
    return noteView({ ...d, ...patch });
  }

  async function removeAll(colRef) {
    const s = await F.getDocs(colRef);
    const b = F.writeBatch(db);
    s.docs.forEach(x => b.delete(x.ref));
    if (s.size) await soft(b.commit());
  }
  async function deleteNote(id) {
    const d = await pageDoc(id);
    // The photo and the words go now. A bare marker stays so the Mac, when it next wakes, deletes its own copy too.
    S.pages.set(id, { ...d, deleted: true }); emit('pages'); dropUrls(`t:${id}:`); dropUrls(`f:${id}:`);
    const b = F.writeBatch(db);
    b.set(P.page(id), { id, deleted: true, status: 'deleted', pageJson: null, thumb: null, title: '', updatedAt: F.serverTimestamp() });
    b.delete(P.file(id, 'flat'));
    await soft(b.commit());
    return { ok: true };
  }

  const shareCss = { ready: null };
  async function exportNote(id, fmt, withPhoto) {
    const d = await pageDoc(id);
    if (!d.pageJson) throw new ApiError("That page hasn't been read yet.");
    const v = noteView(d), name = slug(v.title, 'notes');
    if (fmt === 'md') return { body: toMarkdown(v), type: 'text/markdown; charset=utf-8', filename: `${name}.md` };
    await ensureShareCss();
    let photo = null;
    if (withPhoto) { const f = await fileDoc(P.file(id, 'flat'), d.photoRev || 0); photo = f && b64(f.bytes.toUint8Array()); }
    return { body: toHtml(v, photo), type: 'text/html; charset=utf-8', filename: `${name}.html` };
  }
  async function ensureShareCss() {
    shareCss.ready ||= fetch('export-css.json').then(r => r.json()).then(configure);
    return shareCss.ready;
  }

  // ---- notebooks -------------------------------------------------------------------------------------------------------
  const nbMeta = async id => { await whenReady('notebooks'); const m = S.nbs.get(id); if (!m || m.deleted) throw notFound(); return m; };
  async function nbBody(id) {
    let snap;
    try { snap = await F.getDocFromCache(P.body(id)); if (!snap.exists() || (navigator.onLine !== false && snap.data().rev !== S.nbs.get(id)?.rev)) snap = null; } catch { snap = null; }
    if (!snap) snap = await F.getDoc(P.body(id));
    const b = snap.exists() ? snap.data() : { itemsJson: '[]', linksJson: '[]' };
    return { items: JSON.parse(b.itemsJson), links: JSON.parse(b.linksJson) };
  }
  const nbOf = (m, b) => ({ id: m.id, title: m.title, color: m.color, created: m.created, updated: m.updated, rev: m.rev, view: m.view || { x: 0, y: 0, z: 1 },
    sense_open: !!m.senseOpen, items: b.items, links: b.links, narration: null });
  const NB_EMPTY = 'No arrows yet. Draw one between two notes.';
  function nbSenseParts(nb) {
    const sense = makeSense(toPage(nb), cues(), 'notebook');
    return { sense, sense_html: senseHtml(sense, false, NB_EMPTY) };
  }
  async function listNotebooks() {
    await whenReady('notebooks');
    return live(S.nbs).sort((a, b) => (a.updated < b.updated ? 1 : -1)).map(m => ({ id: m.id, title: m.title, color: m.color || 'sky', updated: m.updated,
      notes: m.notes || 0, threads: m.threads || 0, loose: m.loose || 0, photos: m.photos || 0, thumb: m.thumb || '' }));
  }
  async function getNotebook(id) {
    const m = await nbMeta(id), nb = nbOf(m, await nbBody(id));
    return { ...nb, ...nbSenseParts(nb), can_narrate: false };
  }
  /** meta + body documents for this notebook, and the answer the canvas wants back */
  function packNotebook(nb) {
    const { sense, sense_html } = nbSenseParts(nb);
    const itemsJson = JSON.stringify(nb.items), linksJson = JSON.stringify(nb.links);
    if (itemsJson.length + linksJson.length > MAX_BODY) throw new ApiError('This notebook has grown too big to keep in one piece. Move some of it into a new notebook.');
    const meta = { id: nb.id, title: nb.title, color: nb.color, created: nb.created, updated: nb.updated, rev: nb.rev, view: nb.view, senseOpen: !!nb.sense_open,
      notes: sense.stats.text, threads: sense.stats.threads, loose: sense.stats.loose, photos: nb.items.filter(i => i.type === 'image').length,
      thumb: thumbSvg(nb, sense), deleted: false, updatedAt: F.serverTimestamp() };
    return { meta, body: { itemsJson, linksJson, rev: nb.rev }, answer: { rev: nb.rev, updated: nb.updated, sense, sense_html } };
  }
  async function createNotebook(title) {
    await whenReady('notebooks');
    const used = live(S.nbs).map(m => m.color);
    const color = COLORS.find(c => !used.includes(c)) || COLORS[used.length % COLORS.length];
    const nb = blank(newId(), String(title || '').trim().slice(0, 120) || 'Untitled notebook', color, nowIso());
    const { meta, body } = packNotebook(nb);
    const b = F.writeBatch(db);
    b.set(P.nb(nb.id), meta); b.set(P.body(nb.id), body);
    S.nbs.set(nb.id, meta); emit('notebooks');
    await soft(b.commit());
    return { ...nb, ...nbSenseParts(nb), can_narrate: false };
  }

  /** Apply a change the way sense/notebooks.py does: `rev` must be the revision the canvas last saw. Online it is checked
   *  against the server; offline it is checked against this device's copy and sent when the connection returns. */
  async function saveNotebook(id, body) {
    const compute = (m, b) => {
      if (body.rev !== m.rev) throw new ApiError('This notebook changed in another tab. Reload to see the latest.', 409);
      const nb = nbOf(m, b);
      if ('items' in body) { nb.items = cleanItems(body.items); nb.links = cleanLinks(body.links ?? nb.links, new Set(nb.items.map(i => i.id))); }
      else if ('links' in body) nb.links = cleanLinks(body.links, new Set(nb.items.map(i => i.id)));
      if ('title' in body) nb.title = String(body.title).trim().slice(0, 120) || nb.title;
      if (COLORS.includes(body.color)) nb.color = body.color;
      if (body.view && typeof body.view === 'object') {
        const num = (v, lo, hi, d) => { const f = typeof v === 'number' ? v : Number.NaN; return Number.isFinite(f) ? Math.min(hi, Math.max(lo, f)) : d; };
        nb.view = { x: num(body.view.x, -1e6, 1e6, 0), y: num(body.view.y, -1e6, 1e6, 0), z: num(body.view.z, 0.05, 8, 1) };
      }
      if ('sense_open' in body) nb.sense_open = !!body.sense_open;
      nb.rev += 1; nb.updated = nowIso();
      return packNotebook(nb);
    };
    const m0 = await nbMeta(id);
    let packed;
    if (navigator.onLine !== false) {
      try {
        packed = await F.runTransaction(db, async tx => {
          const ms = await tx.get(P.nb(id));
          if (!ms.exists() || ms.data().deleted) throw notFound();
          const bs = await tx.get(P.body(id));
          const b = bs.exists() ? { items: JSON.parse(bs.data().itemsJson), links: JSON.parse(bs.data().linksJson) } : { items: [], links: [] };
          const out = compute(ms.data(), b);
          tx.set(P.nb(id), out.meta); tx.set(P.body(id), out.body);
          return out;
        });
      } catch (e) { if (!isNetwork(e)) throw e; }
    }
    if (!packed) {
      packed = compute(m0, await nbBody(id));
      const b = F.writeBatch(db), sent = packed;
      b.set(P.nb(id), sent.meta); b.set(P.body(id), sent.body);
      // Sent whenever the connection returns. If this notebook moved on meanwhile, the rules refuse the stale save; keep it as a copy.
      b.commit().catch(e => (e?.code === 'permission-denied' ? rescueNotebook(sent, id) : console.warn('notebook save', e)));
    }
    S.nbs.set(id, packed.meta); emit('notebooks');
    return packed.answer;
  }

  /** A save made offline that the server refused because the notebook changed elsewhere: nothing you wrote is dropped. */
  async function rescueNotebook(sent, fromId) {
    try {
      const items = JSON.parse(sent.body.itemsJson), links = JSON.parse(sent.body.linksJson);
      const nb = blank(newId(), `${sent.meta.title} (offline edits)`.slice(0, 120), sent.meta.color, nowIso());
      Object.assign(nb, { items, links, view: sent.meta.view });
      const out = packNotebook(nb), b = F.writeBatch(db);
      b.set(P.nb(nb.id), out.meta); b.set(P.body(nb.id), out.body);
      for (const it of items) if (it.type === 'image') { const f = await fileDoc(P.nbFile(fromId, it.src)); if (f) b.set(P.nbFile(nb.id, it.src), f); }
      await b.commit();
      window.dispatchEvent(new CustomEvent('ms:notice', { detail: { message: `“${sent.meta.title}” changed on another device while this one was offline. What you wrote here is kept as a separate notebook.`, href: `#/nb/${nb.id}` } }));
    } catch (e) { console.warn('could not keep offline edits', e); }
  }

  async function deleteNotebook(id) {
    const m = await nbMeta(id);
    const held = await nbBody(id).catch(() => ({ items: [] }));
    S.nbs.set(id, { ...m, deleted: true }); emit('notebooks'); dropUrls(`a:${id}:`);
    const b = F.writeBatch(db);
    b.set(P.nb(id), { id, deleted: true, title: '', updated: nowIso(), rev: (m.rev || 0) + 1, updatedAt: F.serverTimestamp() });
    b.delete(P.body(id));
    held.items.filter(i => i.type === 'image').forEach(i => b.delete(P.nbFile(id, i.src)));
    await soft(b.commit());
    await removeAll(P.nbFiles(id)).catch(() => {});   // and any photo that was taken off the canvas earlier
    return { ok: true };
  }

  async function putAsset(nid, name, u8) {
    await soft(F.setDoc(P.nbFile(nid, name), { bytes: F.Bytes.fromUint8Array(u8), type: 'image/jpeg' }));
  }
  async function adopt(nid, items, links, added) {
    const m = await nbMeta(nid), cur = nbOf(m, await nbBody(nid));
    const all = cleanItems([...cur.items, ...items]);
    await saveNotebook(nid, { rev: m.rev, items: all, links: [...cur.links, ...links] });
    return { ...(await getNotebook(nid)), added };
  }
  async function importIntoNotebook(nid, { note_id: noteId, at }) {
    const d = await pageDoc(noteId);
    if (!d.pageJson) throw new ApiError("That page hasn't been read yet. Try again once your Mac has read it.");
    const m = await nbMeta(nid), cur = nbOf(m, await nbBody(nid));
    const used = new Set([...cur.items.map(i => i.id), ...cur.links.map(l => l.id)]);
    const fresh = prefix => { for (;;) { const c = prefix + [...crypto.getRandomValues(new Uint8Array(3))].map(b => pad(b.toString(16))).join(''); if (!used.has(c)) { used.add(c); return c; } } };
    const imp = importPage(cur, JSON.parse(d.pageJson), noteId, at, fresh);
    const f = await fileDoc(P.file(noteId, 'flat'), d.photoRev || 0);
    if (!f) throw notFound();
    await putAsset(nid, imp.asset, f.bytes.toUint8Array());
    return adopt(nid, imp.items, imp.links, imp.items.map(i => i.id));
  }
  async function addPhotoToNotebook(nid, blob, at) {
    const m = await nbMeta(nid), cur = nbOf(m, await nbBody(nid));
    const { full, w, h } = await preparePhoto(blob, { side: 1600 });
    const asset = `${newId()}.jpg`;
    const [x, y] = at ? [Number(at.x) || 0, Number(at.y) || 0] : cur.items.length ? [Math.max(...cur.items.map(i => i.x + i.w)) + 160, Math.min(...cur.items.map(i => i.y))] : [0, 0];
    const id = 'p' + [...crypto.getRandomValues(new Uint8Array(3))].map(b => pad(b.toString(16))).join('');
    await putAsset(nid, asset, full);
    return adopt(nid, [{ id, type: 'image', x, y, w: 640, h: Math.round(640 * h / w), src: asset }], [], [id]);
  }
  async function exportNotebook(id, fmt) {
    const nb = await getNotebook(id), name = slug(nb.title, 'notebook');
    const note = { title: nb.title, created: nb.created, page: toPage(nb, true), sense: nb.sense, narration: null, px: true,
      voice: { kicker: 'From a notebook', section: 'The notebook, <em>laid out</em>', md: 'From a notebook', footer: 'Written on an endless page, then made sense of.' } };
    if (fmt === 'md') return { body: toMarkdown(note), type: 'text/markdown; charset=utf-8', filename: `${name}.md` };
    await ensureShareCss();
    return { body: toHtml(note, null), type: 'text/html; charset=utf-8', filename: `${name}.html` };
  }

  // ---- profile ---------------------------------------------------------------------------------------------------------
  async function updateProfile(body) {
    const e = { at: Date.now() };
    if ('shorthand' in body) e.shorthand = Object.fromEntries(Object.entries(body.shorthand).map(([k, v]) => [String(k), String(v)]));
    if ('action_cues' in body) e.action_cues = body.action_cues.map(String);
    if (body.forget?.length) e.forget = body.forget.map(String);
    const id = newId();
    S.edits = [...S.edits, { id, ...e }]; emit('profile');
    await soft(F.setDoc(P.edit(id), e));
    return profileView();
  }

  // ---- the router ------------------------------------------------------------------------------------------------------
  async function api(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const url = new URL(path, 'http://x'), q = url.searchParams;
    const r = url.pathname.split('/').filter(Boolean);
    const json = () => (typeof opts.body === 'string' ? JSON.parse(opts.body || '{}') : opts.body || {});
    try {
      if (r[0] === 'status' && method === 'GET') {
        await whenReady('mac'); await whenReady('pages');
        return { gemini: false, vision: false, labeled: 0, notebooks: true, cloud: { email: user.email, mac: macState(), waiting: live(S.pages).filter(d => d.status === 'queued').length } };
      }
      if (r[0] === 'profile') {
        await whenReady('profile'); await whenReady('edits');
        if (method === 'GET') return profileView();
        if (method === 'PUT') return await updateProfile(json());
      }
      if (r[0] === 'notes') {
        if (r.length === 1) { if (method === 'GET') return await listNotes(); if (method === 'POST') return await createNote(opts.body); }
        const id = r[1], rest = r.slice(2);
        if (!rest.length) {
          if (method === 'GET') return noteView(await pageDoc(id));
          if (method === 'PUT') return await saveNote(id, json());
          if (method === 'DELETE') return await deleteNote(id);
        }
        if (rest[0] === 'sense' && method === 'POST') return await previewNote(id, json().page);
        if (rest[0] === 'reread' && method === 'POST') return await rereadNote(id, json());
        if (rest[0] === 'narrate') throw new ApiError('Summaries need a Gemini key on your Mac, and the website does not use one.');
        if ((rest[0] === 'share.html' || rest[0] === 'share.md') && method === 'GET') return await exportNote(id, rest[0].slice(6), q.get('photo') === '1');
      }
      if (r[0] === 'notebooks') {
        if (r.length === 1) { if (method === 'GET') return await listNotebooks(); if (method === 'POST') return await createNotebook(json().title); }
        const id = r[1], rest = r.slice(2);
        if (!rest.length) {
          if (method === 'GET') return await getNotebook(id);
          if (method === 'PUT') return await saveNotebook(id, json());
          if (method === 'DELETE') return await deleteNotebook(id);
        }
        if (rest[0] === 'import' && method === 'POST') return await importIntoNotebook(id, json());
        if (rest[0] === 'photo' && method === 'POST') return await addPhotoToNotebook(id, opts.body, q.has('x') ? { x: q.get('x'), y: q.get('y') } : null);
        if (rest[0] === 'narrate') throw new ApiError('Summaries need a Gemini key on your Mac, and the website does not use one.');
        if ((rest[0] === 'share.html' || rest[0] === 'share.md') && method === 'GET') return await exportNotebook(id, rest[0].slice(6));
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e?.code === 'permission-denied') throw new ApiError('Your account no longer has access. Sign in again.', 403);
      if (e?.code === 'unavailable') throw new ApiError("You're offline, and this needs a connection.", 503);
      if (e?.message === 'Failed to fetch') throw new ApiError("You're offline, and this needs a connection.", 503);
      throw e;
    }
    throw new ApiError(`No such route: ${method} ${path}`, 404);
  }
  // fetch-like routes return text for .md and a file for .html; the UI never reads the html through api()
  const wrapped = async (path, opts) => { const out = await api(path, opts); return out && out.body !== undefined && out.filename ? (path.includes('.md') ? out.body : out) : out; };

  function download(path) {
    return api(path).then(out => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([out.body], { type: out.type }));
      a.download = out.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    });
  }

  return {
    api: wrapped, download, photoAttr, assetUrl, hydrate: () => hydrate(document),
    subscribe(kinds, cb) { const s = { kinds, cb }; subs.add(s); return () => subs.delete(s); },
    account: { email: user.email, signOut: async () => { unsubs.forEach(u => u()); clearInterval(tick); watcher.disconnect(); await onSignOut(); } },
    macState, net: netState,
    // for tests and the console
    _state: S, _db: db, _paths: P, _nbBody: nbBody,
  };
}
