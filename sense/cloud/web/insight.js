// "Make sense of this page": a short summary, how the ideas fit together, what is still open and what to do next, written by Gemini
// from the page's typed words (never the photo), with every point tied to the ideas it came from.
//
// Gemini is trusted with the thinking, not with the facts: each point must name the ideas it comes from by id, an id that is not on
// the page is thrown away, and a point left with none is dropped. The to-dos you wrote yourself are listed from the page, not by the
// model, so the model's own suggestions can never be mistaken for them.
import { answerText, callModels, costUsd, ReaderError, setup } from './reader.js';
import { strip } from './pyish.js';

export const INSTRUCTIONS = `\
Below is one person's page of handwritten notes, already typed up and structured. You have only these words: it is not a photo.

How to read it
- THREADS are ideas the person joined with arrows. Indentation follows the arrows. "-> " leads to the next idea. A word in brackets in "-(word)->" is the word they wrote on that arrow. "aside:" marks a short side note. "(see above)" means the arrow points back to an idea already listed.
- LOOSE NOTES are ideas no arrow touches, grouped by how close they sit on the page.
- Each idea starts with an id in square brackets, like [t4]. (UNDERLINED) and (CAPITALS) mark what they stressed. [to-do] marks a line they wrote as something to do.

What to write
- summary: 2 or 3 plain sentences on what the page is about and how the ideas connect.
- how_it_fits: 2 to 5 short points that put the arrows into words: a chain of ideas, a group, what leads to what, and why when a word on an arrow says so.
- open_questions: up to 4 things the page leaves open: a question they wrote, an idea that stops with nothing after it, two ideas that seem to pull against each other. Leave the list empty if there is nothing.
- suggested_next_steps: up to 4 concrete things they could do next that follow from the page. Do not repeat a [to-do] they already wrote. Each must be something a person could actually do.

Rules
- Use only what is on the page. Do not add facts, names, dates or outside knowledge.
- Every point in how_it_fits, open_questions and suggested_next_steps lists in "cites" the ids of the ideas it comes from, at least one. A point without an id is thrown away.
- If a word looks like a misreading, leave it out rather than guess.
- Write plainly, in sentence case, with no jargon and no praise.
`;

const _str = { type: 'STRING' };
const point = { type: 'OBJECT', properties: { text: _str, cites: { type: 'ARRAY', items: _str } }, required: ['text', 'cites'], propertyOrdering: ['text', 'cites'] };
export const SCHEMA = {
  type: 'OBJECT',
  properties: { summary: _str, how_it_fits: { type: 'ARRAY', items: point }, open_questions: { type: 'ARRAY', items: point }, suggested_next_steps: { type: 'ARRAY', items: point } },
  required: ['summary', 'how_it_fits', 'open_questions', 'suggested_next_steps'],
  propertyOrdering: ['summary', 'how_it_fits', 'open_questions', 'suggested_next_steps'],
};
const CAPS = { fits: 5, questions: 4, steps: 4 };
const MAX_TEXT = 320;

/** The page's meaning (what meaning.js found) as the text Gemini reads, and which element ids each idea's id stands for. */
export function outline(sense) {
  const known = new Map(), lines = [];
  const mark = it => {
    known.set(it.id, it.ids);
    return `[${it.id}] ${it.text}${it.underline ? ' (UNDERLINED)' : ''}${it.caps ? ' (CAPITALS)' : ''}${it.action ? ' [to-do]' : ''}`;
  };
  const via = v => (!v ? '' : v.kind === 'hook' ? 'aside: ' : v.label ? `-(${v.label})-> ` : '-> ');
  const walk = (it, depth) => { lines.push('  '.repeat(depth) + via(it.via) + mark(it) + (it.ref ? ' (see above)' : '')); it.children.forEach(c => walk(c, depth + 1)); };
  if (sense.threads.length) {
    lines.push('THREADS');
    sense.threads.forEach((t, i) => { lines.push(`Thread ${i + 1}`); t.roots.forEach(r => walk(r, 1)); });
  }
  if (sense.loose.length) {
    lines.push('LOOSE NOTES');
    sense.loose.forEach((g, i) => { lines.push(`Group ${i + 1}`); g.items.forEach(it => lines.push('  ' + mark(it))); });
  }
  return { text: lines.join('\n'), known, empty: !sense.threads.length && !sense.loose.length };
}

/** A short fingerprint of what the page says, kept with the insight: when it stops matching, the insight is out of date. */
export function inputKey(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(16) + ':' + text.length;
}

export function buildRequest(text, hints = '', preset) {
  const generationConfig = { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SCHEMA };
  if (preset?.thinking) generationConfig.thinkingConfig = { thinkingLevel: preset.thinking };
  return { contents: [{ role: 'user', parts: [{ text: INSTRUCTIONS + (hints ? '\n' + hints : '') + '\nTHE PAGE\n' + text }] }], generationConfig };
}

const norm = s => strip(String(s ?? '')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clip = s => { const cs = Array.from(s); return cs.length > MAX_TEXT ? cs.slice(0, MAX_TEXT - 1).join('') + '…' : s; };

/** Keep only what is tied to the page: cites that are not ideas on it are dropped, then any point left with none. */
export function cleanInsight(raw, known, written = new Set()) {
  const summary = clip(strip(String(raw?.summary ?? '')));
  if (!summary) throw new ReaderError("Gemini's answer had no summary. Try again.", 'bad');
  let dropped = 0;
  const points = (list, cap, skip) => {
    const out = [];
    for (const p of Array.isArray(list) ? list : []) {
      const text = clip(strip(String(p?.text ?? '')));
      const cites = [...new Set((Array.isArray(p?.cites) ? p.cites : []).map(String).filter(c => known.has(c)))];
      const n = norm(text);
      if (!text || !cites.length || (skip && [...skip].some(w => w && (n === w || (w.length >= 8 && n.includes(w)))))) { dropped++; continue; }
      if (out.length < cap) out.push({ text, cites }); else dropped++;
    }
    return out;
  };
  return { summary, how_it_fits: points(raw.how_it_fits, CAPS.fits), open_questions: points(raw.open_questions, CAPS.questions),
    suggested_next_steps: points(raw.suggested_next_steps, CAPS.steps, written), dropped };
}

/** Ask Gemini. Returns { insight, key, model, usage, usd }; `key` is the fingerprint to keep with it. */
export async function makeSenseOf(sense, hints = '') {
  const { text, known, empty } = outline(sense);
  if (empty) throw new ReaderError('There is nothing on this page to make sense of yet.', 'bad');
  const { key, preset } = setup('make sense of pages');
  const written = new Set(sense.actions.map(a => norm(a.text)));
  const { resp, model } = await callModels(buildRequest(text, hints, preset), preset, key);
  let raw;
  try { raw = JSON.parse(answerText(resp)); } catch { throw new ReaderError("Gemini's answer wasn't readable. Try again.", 'bad'); }
  const usage = resp.usageMetadata || null;
  return { insight: cleanInsight(raw, known, written), key: inputKey(text), model, usage, usd: costUsd(model, usage) };
}

/** What the page shows: the stored insight with each point's cites turned into the page's own element ids (for highlighting). */
export function view(stored, sense, atKey) {
  const { text, known } = outline(sense);
  const ids = cites => [...new Set(cites.flatMap(c => known.get(c) || []))];
  const withIds = list => (list || []).map(p => ({ text: p.text, ids: ids(p.cites || []) }));
  return { summary: stored.summary, fits: withIds(stored.how_it_fits), questions: withIds(stored.open_questions), suggested: withIds(stored.suggested_next_steps),
    written: sense.actions.map(a => ({ text: a.text, ids: ids([a.id]) })), stale: atKey !== inputKey(text) };
}
