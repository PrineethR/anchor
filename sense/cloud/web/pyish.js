// The few Python behaviours the ports have to match exactly, so the browser and the Mac print the same thing.

/**
 * `f"{x:.{d}f}"`. JS and Python both round to the nearest digit of the number's exact value; they differ only on an exact tie
 * (0.25 to one place), where Python rounds to even and JS rounds up. -0 keeps its sign in Python.
 */
export function fmt(x, d) {
  if (Object.is(x, -0)) return '-' + (0).toFixed(d);
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x.toFixed(d);
  const exact = x.toFixed(Math.min(100, d + 40));   // the exact decimal value, as far as it matters
  const dot = exact.indexOf('.');
  if (!/^50*$/.test(exact.slice(dot + 1 + d))) return x.toFixed(d);
  const head = exact.slice(0, d === 0 ? dot : dot + 1 + d);   // sign, whole part, first d decimals
  const digits = head.replace(/[-.]/g, '');
  if (+digits[digits.length - 1] % 2 === 0) return head;       // already even: dropping the 5 is the rounding
  const s = (BigInt(digits) + 1n).toString().padStart(d + 1, '0');
  return (x < 0 ? '-' : '') + (d ? s.slice(0, -d) + '.' + s.slice(-d) : s);
}

/** `html.escape(s)`. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[c]));
}

/** `str.strip()` (Unicode whitespace). */
export const strip = s => s.replace(/^\s+|\s+$/gu, '');

export const cpLen = s => { let n = 0; for (const _ of s) n++; return n; };
export const cpSlice = (s, a, b) => Array.from(s).slice(a, b).join('');

const WORD = /[\p{L}\p{N}_]/u;
/** Python's `\w` for one character. */
export const isWord = ch => !!ch && WORD.test(ch);
/** `re.sub(r"^\W+", "", s)` */
export const stripLeadingNonWord = s => s.replace(/^[^\p{L}\p{N}_]+/u, '');
/** `re.sub(r"^\W+|\W+$", "", s)` */
export const trimNonWord = s => s.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '');

/** Compare two [a, b] keys like Python tuples. */
export const cmpKey = (p, q) => (p[0] - q[0]) || (p[1] - q[1]);

/** `float(v)` falling back to `dflt` when Python would raise or give a non-finite number. */
export function num(v, lo = -1_000_000, hi = 1_000_000, dflt = 0.0) {
  let f;
  if (typeof v === 'number') f = v;
  else if (typeof v === 'boolean') f = +v;
  else if (typeof v === 'string' && v.trim() !== '' && !/[_]/.test(v)) f = Number(v.trim());
  else return dflt;
  return Number.isFinite(f) ? Math.min(hi, Math.max(lo, f)) : dflt;
}

/** `repr(str)` for the common cases. */
export function pyRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, '\\\\').replace(q === "'" ? /'/g : /"/g, '\\' + q).replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r') + q;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** statistics.median */
export function median(xs) {
  const a = [...xs].sort((p, q) => p - q), n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}
