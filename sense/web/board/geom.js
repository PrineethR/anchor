// Rectangles, shape outlines, and where a connector can attach. Pure geometry: no document, no canvas state.

export const box = o => ({ x: o.x, y: o.y, w: o.w, h: o.h });
export const right = r => r.x + r.w;
export const bottom = r => r.y + r.h;
export const hit = (r, x, y, m = 0) => x >= r.x - m && x <= r.x + r.w + m && y >= r.y - m && y <= r.y + r.h + m;
export const touches = (a, b) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
export const inside = (inner, outer) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
export const center = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
export const grow = (r, m) => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m });

export function union(rs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rs) { if (r.x < x0) x0 = r.x; if (r.y < y0) y0 = r.y; if (r.x + r.w > x1) x1 = r.x + r.w; if (r.y + r.h > y1) y1 = r.y + r.h; }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export const SHAPES = ['rect', 'round', 'ellipse', 'diamond', 'triangle', 'hexagon', 'cylinder', 'arrow'];
export const SHAPE_NAMES = { rect: 'Rectangle', round: 'Rounded rectangle', ellipse: 'Ellipse', diamond: 'Diamond', triangle: 'Triangle', hexagon: 'Hexagon', cylinder: 'Cylinder', arrow: 'Arrow' };
export const SHAPE_KEYS = { rect: 'r', round: 'u', ellipse: 'o', diamond: 'd', triangle: 'g', hexagon: 'x', cylinder: 'c', arrow: 'a' };

const cyl = (w, h) => Math.min(h * 0.18, w * 0.25);
export const radius = (w, h) => Math.min(Math.min(w, h) * 0.22, 28);

/** Trace the outline of a shape into a canvas context or Path2D. */
export function trace(p, kind, x, y, w, h) {
  switch (kind) {
    case 'round': p.roundRect(x, y, w, h, radius(w, h)); break;
    case 'ellipse': p.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'diamond': poly(p, [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]]); break;
    case 'triangle': poly(p, [[x + w / 2, y], [x + w, y + h], [x, y + h]]); break;
    case 'hexagon': { const k = Math.min(w * 0.25, h * 0.5); poly(p, [[x + k, y], [x + w - k, y], [x + w, y + h / 2], [x + w - k, y + h], [x + k, y + h], [x, y + h / 2]]); break; }
    case 'cylinder': {
      const ry = cyl(w, h);
      p.moveTo(x, y + ry);
      p.ellipse(x + w / 2, y + ry, w / 2, ry, 0, Math.PI, Math.PI * 2);
      p.lineTo(x + w, y + h - ry);
      p.ellipse(x + w / 2, y + h - ry, w / 2, ry, 0, 0, Math.PI);
      p.closePath();
      break;
    }
    case 'arrow': poly(p, [[x, y + h * 0.3], [x + w * 0.6, y + h * 0.3], [x + w * 0.6, y], [x + w, y + h / 2], [x + w * 0.6, y + h], [x + w * 0.6, y + h * 0.7], [x, y + h * 0.7]]); break;
    default: p.rect(x, y, w, h);
  }
}
function poly(p, pts) { p.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) p.lineTo(pts[i][0], pts[i][1]); p.closePath(); }

/** The rim of a cylinder's lid, drawn on top as a stroke. */
export function lid(p, x, y, w, h) { const ry = cyl(w, h); p.moveTo(x, y + ry); p.ellipse(x + w / 2, y + ry, w / 2, ry, 0, Math.PI, 0, true); }

/** Where text may sit inside a shape. */
export function textArea(kind, o) {
  const { x, y, w, h } = o;
  switch (kind) {
    case 'ellipse': return { x: x + w * 0.14, y: y + h * 0.14, w: w * 0.72, h: h * 0.72 };
    case 'diamond': return { x: x + w * 0.25, y: y + h * 0.25, w: w * 0.5, h: h * 0.5 };
    case 'triangle': return { x: x + w * 0.25, y: y + h * 0.42, w: w * 0.5, h: h * 0.5 };
    case 'hexagon': return { x: x + w * 0.14, y: y, w: w * 0.72, h };
    case 'cylinder': { const ry = cyl(w, h); return { x, y: y + ry * 1.4, w, h: h - ry * 2.2 }; }
    case 'arrow': return { x, y: y + h * 0.3, w: w * 0.6, h: h * 0.4 };
    default: return { x, y, w, h };
  }
}

const probe = document.createElement('canvas').getContext('2d');
/** Is the point inside the shape's outline? */
export function inShape(kind, o, px, py) {
  if (kind === 'rect') return true;
  const p = new Path2D();
  trace(p, kind, o.x, o.y, o.w, o.h);
  return probe.isPointInPath(p, px, py);
}

// --- connection points -----------------------------------------------------------------------------

export const NORMAL = { t: [0, -1], r: [1, 0], b: [0, 1], l: [-1, 0] };

/** A point on one side of an object (t is 0..1 along the side, 0.5 the middle) and the direction pointing out of it. */
export function sidePoint(o, side, t = 0.5) {
  const n = NORMAL[side];
  let x, y;
  if (side === 't') { x = o.x + o.w * t; y = o.y; } else if (side === 'b') { x = o.x + o.w * t; y = o.y + o.h; }
  else if (side === 'l') { x = o.x; y = o.y + o.h * t; } else { x = o.x + o.w; y = o.y + o.h * t; }
  if (o.type === 'shape') {
    if (o.shape === 'triangle' && (side === 'l' || side === 'r')) x = side === 'l' ? o.x + o.w * (0.5 - 0.5 * t) : o.x + o.w * (0.5 + 0.5 * t), y = o.y + o.h * t;
    if (o.shape === 'diamond' && (side === 'l' || side === 'r')) { x = side === 'l' ? o.x + o.w * (0.5 - 0.5 * (1 - Math.abs(2 * t - 1))) : o.x + o.w * (0.5 + 0.5 * (1 - Math.abs(2 * t - 1))); }
    if (o.shape === 'diamond' && (side === 't' || side === 'b')) { y = side === 't' ? o.y + o.h * (0.5 - 0.5 * (1 - Math.abs(2 * t - 1))) : o.y + o.h * (0.5 + 0.5 * (1 - Math.abs(2 * t - 1))); }
  }
  return { x, y, nx: n[0], ny: n[1] };
}

/** The side of `o` that faces the point (px, py). */
export function facing(o, px, py) {
  const c = center(o);
  const dx = (px - c.x) / Math.max(o.w, 1), dy = (py - c.y) / Math.max(o.h, 1);
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'r' : 'l') : (dy > 0 ? 'b' : 't');
}

/** The nearest side (and position along it) to a point, for dropping a connector end on an object. */
export function nearestSide(o, px, py) {
  const d = { t: Math.abs(py - o.y), b: Math.abs(py - (o.y + o.h)), l: Math.abs(px - o.x), r: Math.abs(px - (o.x + o.w)) };
  const inx = px >= o.x && px <= o.x + o.w, iny = py >= o.y && py <= o.y + o.h;
  let side = 't', best = Infinity;
  for (const s of ['t', 'r', 'b', 'l']) {
    const pen = (s === 't' || s === 'b') ? (inx ? 0 : 1e6) : (iny ? 0 : 1e6);
    if (d[s] + pen < best) { best = d[s] + pen; side = s; }
  }
  const t = (side === 't' || side === 'b') ? (px - o.x) / Math.max(o.w, 1) : (py - o.y) / Math.max(o.h, 1);
  const tc = Math.min(1, Math.max(0, t));
  return { side, t: Math.abs(tc - 0.5) < 0.08 ? 0.5 : tc };
}

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function segDist(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
export function polyDist(px, py, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, segDist(px, py, pts[i - 1], pts[i]));
  return best;
}
