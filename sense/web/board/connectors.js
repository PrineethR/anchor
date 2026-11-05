// Connectors: from an object's edge (or a free point) to another's, drawn straight, with right angles, or curved.
// A connector is glued to its objects by id, so the path is worked out from where they are now, every time they move.

import { sidePoint, facing, center, polyDist } from './geom.js';

const STUB = 26;

/** Where one end sits and which way it leaves, given the other end's rough position `toward`. */
export function resolveEnd(end, byId, toward) {
  if (end && end.id) {
    const o = byId(end.id);
    if (o && o.type !== 'connector') {
      const side = !end.side || end.side === 'auto' ? facing(o, toward.x, toward.y) : end.side;
      const p = sidePoint(o, side, end.t ?? 0.5);
      return { x: p.x, y: p.y, dx: p.nx, dy: p.ny, glued: o, side };
    }
  }
  const p = end && end.x !== undefined ? end : { x: 0, y: 0 };
  return { x: p.x, y: p.y, dx: 0, dy: 0, glued: null };
}

/** The anchor's rough position, used to choose a side when the end is "auto". */
function rough(end, byId) {
  if (end && end.id) { const o = byId(end.id); if (o) return center(o); }
  return { x: end && end.x || 0, y: end && end.y || 0 };
}

/** Both ends, resolved. */
export function ends(c, byId) {
  const ra = rough(c.from, byId), rb = rough(c.to, byId);
  const a = resolveEnd(c.from, byId, rb), b = resolveEnd(c.to, byId, ra);
  // A free end leaves along the axis the other end lies on.
  const free = (e, o) => {
    if (e.glued) return;
    const dx = o.x - e.x, dy = o.y - e.y;
    if (Math.abs(dx) > Math.abs(dy)) { e.dx = Math.sign(dx) || 1; e.dy = 0; } else { e.dx = 0; e.dy = Math.sign(dy) || 1; }
  };
  free(a, b); free(b, a);
  return { a, b };
}

const simplify = pts => {
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = out[out.length - 1], q = pts[i], r = pts[i + 1];
    if ((p.x === q.x && q.x === r.x) || (p.y === q.y && q.y === r.y)) continue;
    if (p.x === q.x && p.y === q.y) continue;
    out.push(q);
  }
  out.push(pts[pts.length - 1]);
  return out;
};

function elbow(a, b) {
  const P = (x, y) => ({ x, y });
  const ah = a.dx !== 0, bh = b.dx !== 0;
  const a1 = P(a.x + a.dx * STUB, a.y + a.dy * STUB), b1 = P(b.x + b.dx * STUB, b.y + b.dy * STUB);
  let pts;
  if (ah && bh) {
    if (a.dx * b.dx < 0 && (b.x - a.x) * a.dx > STUB * 0.5) { const mx = (a.x + b.x) / 2; pts = [a, P(mx, a.y), P(mx, b.y), b]; }
    else if (a.dx * b.dx > 0) { const x = a.dx > 0 ? Math.max(a1.x, b1.x) : Math.min(a1.x, b1.x); pts = [a, P(x, a.y), P(x, b.y), b]; }
    else { const my = (a.y + b.y) / 2 === a.y ? a.y + 60 : (a.y + b.y) / 2; pts = [a, a1, P(a1.x, my), P(b1.x, my), b1, b]; }
  } else if (!ah && !bh) {
    if (a.dy * b.dy < 0 && (b.y - a.y) * a.dy > STUB * 0.5) { const my = (a.y + b.y) / 2; pts = [a, P(a.x, my), P(b.x, my), b]; }
    else if (a.dy * b.dy > 0) { const y = a.dy > 0 ? Math.max(a1.y, b1.y) : Math.min(a1.y, b1.y); pts = [a, P(a.x, y), P(b.x, y), b]; }
    else { const mx = (a.x + b.x) / 2 === a.x ? a.x + 60 : (a.x + b.x) / 2; pts = [a, a1, P(mx, a1.y), P(mx, b1.y), b1, b]; }
  } else if (ah) {
    // leaves sideways, arrives from above or below
    if ((b.x - a.x) * a.dx > 0 && (a.y - b.y) * b.dy > 0) pts = [a, P(b.x, a.y), b];
    else pts = [a, a1, P(a1.x, b1.y), b1, b];
  } else {
    if ((b.y - a.y) * a.dy > 0 && (a.x - b.x) * b.dx > 0) pts = [a, P(a.x, b.y), b];
    else pts = [a, a1, P(b1.x, a1.y), b1, b];
  }
  return simplify(pts);
}

function curve(a, b) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const k = Math.max(40, Math.min(d * 0.45, 220));
  return { p0: a, c0: { x: a.x + a.dx * k, y: a.y + a.dy * k }, c1: { x: b.x + b.dx * k, y: b.y + b.dy * k }, p1: b };
}

const bez = (c, t) => {
  const u = 1 - t;
  return { x: u * u * u * c.p0.x + 3 * u * u * t * c.c0.x + 3 * u * t * t * c.c1.x + t * t * t * c.p1.x,
    y: u * u * u * c.p0.y + 3 * u * u * t * c.c0.y + 3 * u * t * t * c.c1.y + t * t * t * c.p1.y };
};

/** The route of a connector: its drawing instructions, a polyline for hit tests and labels, and the end directions for arrowheads. */
export function route(c, byId) {
  const { a, b } = ends(c, byId);
  if (c.shape === 'curved') {
    const bz = curve(a, b);
    const pts = []; for (let i = 0; i <= 24; i++) pts.push(bez(bz, i / 24));
    return { kind: 'curve', bz, pts, a, b, tail: dirOf(pts[1], pts[0]), tip: dirOf(pts[pts.length - 2], pts[pts.length - 1]) };
  }
  const pts = c.shape === 'elbow' ? elbow(a, b) : [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  const n = pts.length;
  return { kind: 'poly', pts, a, b, tail: dirOf(pts[1], pts[0]), tip: dirOf(pts[n - 2], pts[n - 1]) };
}
const dirOf = (from, to) => { const l = Math.hypot(to.x - from.x, to.y - from.y) || 1; return { x: (to.x - from.x) / l, y: (to.y - from.y) / l }; };

export function bounds(r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of r.pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The point halfway along the route, for a label. */
export function midpoint(r) {
  const pts = r.pts;
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + l >= total / 2) { const t = (total / 2 - acc) / (l || 1); return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }; }
    acc += l;
  }
  return pts[0];
}

export const near = (r, px, py) => polyDist(px, py, r.pts);

// --- drawing ---------------------------------------------------------------------------------------

const HEAD_LEN = w => 9 + w * 2.6;

/** How far the line should stop short of its end so a filled head does not poke through. */
const inset = (head, w) => head === 'triangle' || head === 'diamond' ? HEAD_LEN(w) * 0.9 : head === 'arrow' ? 0 : head === 'circle' ? HEAD_LEN(w) * 0.5 : 0;

export function strokePath(c, r, w, headA, headB) {
  const p = new Path2D();
  const sa = inset(headA, w), sb = inset(headB, w);
  if (r.kind === 'curve') {
    const { p0, c0, c1, p1 } = r.bz;
    const s = { x: p0.x - r.tail.x * sa, y: p0.y - r.tail.y * sa }, e = { x: p1.x - r.tip.x * sb, y: p1.y - r.tip.y * sb };
    p.moveTo(s.x, s.y); p.bezierCurveTo(c0.x, c0.y, c1.x, c1.y, e.x, e.y);
    return p;
  }
  const pts = r.pts.map(q => ({ ...q }));
  pts[0].x -= r.tail.x * sa; pts[0].y -= r.tail.y * sa;
  const n = pts.length - 1;
  pts[n].x -= r.tip.x * sb; pts[n].y -= r.tip.y * sb;
  const R = c.shape === 'elbow' ? 10 : 0;
  p.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], q = pts[i], b = pts[i + 1];
    const l1 = Math.hypot(q.x - a.x, q.y - a.y), l2 = Math.hypot(b.x - q.x, b.y - q.y);
    const rr = Math.min(R, l1 / 2, l2 / 2);
    if (rr > 0.5) p.arcTo(q.x, q.y, q.x + (b.x - q.x) / l2 * rr, q.y + (b.y - q.y) / l2 * rr, rr); else p.lineTo(q.x, q.y);
  }
  p.lineTo(pts[n].x, pts[n].y);
  return p;
}

/** Draw one arrowhead whose tip is at (x, y), pointing along (dx, dy). */
export function head(ctx, kind, x, y, dx, dy, w) {
  if (kind === 'none') return;
  const L = HEAD_LEN(w), nx = -dy, ny = dx;
  ctx.beginPath();
  if (kind === 'arrow') {
    ctx.moveTo(x - dx * L + nx * L * 0.5, y - dy * L + ny * L * 0.5); ctx.lineTo(x, y); ctx.lineTo(x - dx * L - nx * L * 0.5, y - dy * L - ny * L * 0.5);
    ctx.stroke();
    return;
  }
  if (kind === 'triangle') {
    ctx.moveTo(x, y); ctx.lineTo(x - dx * L + nx * L * 0.45, y - dy * L + ny * L * 0.45); ctx.lineTo(x - dx * L - nx * L * 0.45, y - dy * L - ny * L * 0.45); ctx.closePath();
    ctx.fill();
  } else if (kind === 'diamond') {
    ctx.moveTo(x, y); ctx.lineTo(x - dx * L * 0.5 + nx * L * 0.38, y - dy * L * 0.5 + ny * L * 0.38); ctx.lineTo(x - dx * L, y - dy * L);
    ctx.lineTo(x - dx * L * 0.5 - nx * L * 0.38, y - dy * L * 0.5 - ny * L * 0.38); ctx.closePath();
    ctx.fill();
  } else if (kind === 'circle') {
    ctx.arc(x - dx * L * 0.45, y - dy * L * 0.45, L * 0.45, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'bar') {
    ctx.moveTo(x + nx * L * 0.5, y + ny * L * 0.5); ctx.lineTo(x - nx * L * 0.5, y - ny * L * 0.5);
    ctx.stroke();
  }
}
