// Make sense of a page: its arrows become threads, the rest becomes loose notes.
// A port of sense/meaning.py, line for line; tests/test_cloud_parity.py holds the two to the same answers.
import { cmpKey, cpLen, cpSlice, isWord, median, plural, stripLeadingNonWord, trimNonWord } from './pyish.js';

const BAND = 0.1;       // reading order: rows are bands this fraction of the page height tall
const NEAR = 1.2;       // loose text within this many median line heights of each other is one note
const MAX_DEPTH = 40;   // an outline never nests deeper than this; past it a node is shown as a reference

const bandKey = (box, ph) => [Math.trunc(box[1] / (BAND * ph)), box[0]];

function readingOrder(items, tol) {
  const rows = [];
  const cy = i => i.box[1] + i.box[3] / 2;
  for (const it of [...items].sort((a, b) => cy(a) - cy(b))) {
    if (rows.length && Math.abs(cy(it) - cy(rows[rows.length - 1][0])) <= tol) rows[rows.length - 1].push(it);
    else rows.push([it]);
  }
  return rows.flatMap(row => [...row].sort((a, b) => a.box[0] - b.box[0]));
}

function gap(a, b) {
  const [ax, ay, aw, ah] = a, [bx, by, bw, bh] = b;
  const dx = Math.max(0, Math.max(ax, bx) - Math.min(ax + aw, bx + bw));
  const dy = Math.max(0, Math.max(ay, by) - Math.min(ay + ah, by + bh));
  return Math.hypot(dx, dy);
}

class Sets {
  constructor(keys) { this.p = new Map(); for (const k of keys) this.p.set(k, k); }
  find(k) {
    while (this.p.get(k) !== k) { this.p.set(k, this.p.get(this.p.get(k))); k = this.p.get(k); }
    return k;
  }
  union(a, b) { this.p.set(this.find(a), this.find(b)); }
}

/** The to-do cue `text` starts with ("add" for "Add Luis Garcia"), or null. */
export function cueOf(text, cues) {
  const lead = stripLeadingNonWord(text).toLowerCase();
  for (const cue of [...cues].sort((a, b) => cpLen(b) - cpLen(a))) {
    if (!lead.startsWith(cue)) continue;
    const prev = Array.from(cue).pop(), next = Array.from(lead.slice(cue.length))[0];
    if (isWord(prev) !== isWord(next)) return cue;   // \b
  }
  return null;
}

const minBy = (xs, key) => xs.reduce((best, x) => (cmpKey(key(x), key(best)) < 0 ? x : best));
const viaOf = v => v && { kind: v.kind, label: v.label, caps: v.caps, underline: v.underline };

export function makeSense(page, cues = [], noun = 'page') {
  const [, ph] = page.page_size;
  const els = new Map(page.elements.map(e => [e.id, e]));
  const texts = page.elements.filter(e => e.type === 'text');
  const medianH = texts.length ? median(texts.map(e => e.bbox[3])) : 0.04 * ph;

  // Fold each shape and the words inside it into one node.
  const alias = new Map();
  for (const s of page.elements) {
    if (s.type !== 'shape') continue;
    for (const c of s.contains || []) if (els.has(c) && els.get(c).type === 'text') alias.set(c, s.id);
  }
  const nodes = new Map();
  for (const e of page.elements) {
    if (e.type === 'text' && !alias.has(e.id)) {
      nodes.set(e.id, { id: e.id, ids: [e.id], text: e.text, box: e.bbox, underline: !!e.underline, caps: !!e.caps });
    } else if (e.type === 'shape') {
      const inside = readingOrder((e.contains || []).filter(c => els.has(c) && els.get(c).type === 'text')
        .map(c => ({ ...els.get(c), box: els.get(c).bbox })), medianH * 0.6);
      nodes.set(e.id, { id: e.id, ids: [e.id, ...inside.map(m => m.id)], text: inside.map(m => m.text).join(' ') || '(drawn shape)',
        box: e.bbox, underline: inside.some(m => m.underline), caps: inside.some(m => m.caps) });
    }
  }

  const end = v => {
    let cid = typeof v === 'string' ? v : (Array.isArray(v) && v[0] ? v[0].id : undefined);
    if (cid === undefined) return null;
    cid = alias.has(cid) ? alias.get(cid) : cid;
    return nodes.has(cid) ? cid : null;
  };
  const edges = [], seen = new Set();
  for (const l of page.links || []) {
    const a = end(l.from), b = end(l.to);
    if (a && b && a !== b && !seen.has(a + '\u0000' + b)) {
      seen.add(a + '\u0000' + b);
      edges.push({ from: a, to: b, kind: l.kind, label: l.label || '', caps: !!l.caps, underline: !!l.underline, link: l.id });
    }
  }

  const order = n => bandKey(nodes.get(n).box, ph);
  const outEdges = new Map([...nodes.keys()].map(n => [n, []]));
  const indeg = new Map([...nodes.keys()].map(n => [n, 0]));
  const comp = new Sets(nodes.keys());
  for (const e of edges) {
    outEdges.get(e.from).push(e);
    indeg.set(e.to, indeg.get(e.to) + 1);
    comp.union(e.from, e.to);
  }

  const itemRef = (m, via) => {
    const info = nodes.get(m);
    return { id: m, ids: info.ids, text: info.text, underline: info.underline, caps: info.caps, action: false, via: viaOf(via), ref: true, children: [] };
  };
  const item = (n, via, visited, depth = 0) => {
    const info = nodes.get(n);
    const it = { id: n, ids: info.ids, text: info.text, underline: info.underline, caps: info.caps,
      action: Boolean(cueOf(info.text, cues)), via: viaOf(via), ref: false, children: [] };
    visited.add(n);
    for (const e of [...outEdges.get(n)].sort((p, q) => cmpKey(order(p.to), order(q.to)))) {
      const m = e.to;
      it.children.push(visited.has(m) || depth >= MAX_DEPTH ? itemRef(m, e) : item(m, e, visited, depth + 1));
    }
    return it;
  };

  const groups = new Map();
  for (const n of nodes.keys()) {
    const r = comp.find(n);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(n);
  }

  const threads = [], looseNodes = [];
  for (const members of groups.values()) {
    if (members.length === 1 && !outEdges.get(members[0]).length && indeg.get(members[0]) === 0) { looseNodes.push(members[0]); continue; }
    const visited = new Set();
    let roots = members.filter(n => indeg.get(n) === 0).sort((p, q) => cmpKey(order(p), order(q)));
    if (!roots.length) roots = [minBy(members, order)];
    const items = roots.map(r => item(r, null, visited));
    for (const n of members.filter(n => !visited.has(n)).sort((p, q) => cmpKey(order(p), order(q)))) {  // a cycle no root reaches
      if (!visited.has(n)) items.push(item(n, null, visited));
    }
    const ids = [...new Set(members.flatMap(n => nodes.get(n).ids))].sort();
    threads.push({ roots: items, size: members.length, _key: members.map(order).reduce((a, b) => (cmpKey(b, a) < 0 ? b : a)), ids });
  }
  threads.sort((a, b) => cmpKey(a._key, b._key));
  threads.forEach(t => delete t._key);

  // Loose text: single-linkage on how near the boxes sit.
  const looseSets = new Sets(looseNodes);
  looseNodes.forEach((a, i) => {
    for (const b of looseNodes.slice(i + 1)) if (gap(nodes.get(a).box, nodes.get(b).box) <= NEAR * medianH) looseSets.union(a, b);
  });
  const looseGroups = new Map();
  for (const n of looseNodes) {
    const r = looseSets.find(n);
    if (!looseGroups.has(r)) looseGroups.set(r, []);
    looseGroups.get(r).push(nodes.get(n));
  }
  const loose = [];
  for (const members of looseGroups.values()) {
    const ordered = readingOrder(members, medianH * 0.6);
    loose.push({ items: ordered.map(m => ({ id: m.id, ids: m.ids, text: m.text, underline: m.underline, caps: m.caps, action: Boolean(cueOf(m.text, cues)) })),
      _key: bandKey(ordered[0].box, ph) });
  }
  loose.sort((a, b) => cmpKey(a._key, b._key));
  loose.forEach(g => delete g._key);

  const sorted = [...nodes.keys()].sort((p, q) => cmpKey(order(p), order(q)));
  const emphasis = x => (x.underline && x.caps ? 'both' : x.underline ? 'underline' : 'caps');
  const keyTerms = [], seenTerms = new Set();
  for (const n of sorted) {
    const info = nodes.get(n);
    if ((info.underline || info.caps) && !seenTerms.has(info.text.toLowerCase())) {
      seenTerms.add(info.text.toLowerCase());
      keyTerms.push({ id: n, text: info.text, kind: emphasis(info) });
    }
  }
  for (const e of edges) {
    if (e.label && (e.caps || e.underline) && !seenTerms.has(e.label.toLowerCase())) {
      seenTerms.add(e.label.toLowerCase());
      keyTerms.push({ id: e.link, text: e.label, kind: emphasis(e), connector: true });
    }
  }

  const actions = [];
  for (const n of sorted) {
    const cue = cueOf(nodes.get(n).text, cues);
    if (cue) actions.push({ id: n, text: nodes.get(n).text, cue });
  }

  const stats = { text: texts.length, shapes: page.elements.filter(e => e.type === 'shape').length,
    doodles: page.elements.filter(e => e.type === 'doodle').length, links: edges.length, threads: threads.length, loose: loose.length };
  const sense = { stats, threads, loose, key_terms: keyTerms, actions };
  sense.title = title(sense);
  sense.summary = summary(sense, noun);
  return sense;
}

function title(sense) {
  const first = sense.threads.length ? sense.threads[0].roots[0].text : (sense.loose.length ? sense.loose[0].items[0].text : '');
  const t = trimNonWord(first);
  return (cpLen(t) > 60 ? cpSlice(t, 0, 58) + '…' : t) || 'Untitled page';
}

function summary(sense, noun = 'page') {
  const t = sense.threads.length, l = sense.loose.length, a = sense.actions.length;
  if (!t && !l) return `No readable text found on this ${noun}.`;
  const parts = [];
  if (t) {
    const starts = sense.threads.flatMap(th => th.roots.slice(0, 1).map(r => r.text.replace(/^[ .]+|[ .]+$/g, '')));
    const shown = starts.slice(0, 3).map(s => `“${s}”`).join(', ') + (starts.length > 3 ? ` + ${starts.length - 3} more` : '');
    parts.push(`${plural(t, 'thread')} of connected ideas (from ${shown})`);
  }
  if (l) parts.push(plural(l, 'loose note'));
  let text = `This ${noun} has ` + parts.join(' and ') + '.';
  if (a) text += ` ${plural(a, 'to-do')} spotted.`;
  return text;
}
