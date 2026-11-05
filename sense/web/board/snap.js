// Snapping: while you drag or resize, edges and centres line up with neighbours and a guide shows what matched.

const SNAP_PX = 7;   // screen pixels

function candidates(ed, ignore) {
  const view = ed.cam.visible(400 / ed.cam.z);
  const out = [];
  for (const o of ed.doc.list()) {
    if (ignore.has(o.id) || o.type === 'connector' || ed.v.hidden.has(o.id)) continue;
    if (o.x > view.x + view.w || o.x + o.w < view.x || o.y > view.y + view.h || o.y + o.h < view.y) continue;
    out.push(o);
  }
  return out;
}

const keysX = r => [r.x, r.x + r.w / 2, r.x + r.w];
const keysY = r => [r.y, r.y + r.h / 2, r.y + r.h];

/** Shift a moving box so its edges/centres meet a neighbour's. Returns the shift and the guide lines to draw. */
export function snapMove(ed, bb, ignore) {
  const th = SNAP_PX / ed.cam.z, cs = candidates(ed, ignore);
  let bestX = null, bestY = null;
  const mx = keysX(bb), my = keysY(bb);
  for (const c of cs) {
    for (const cx of keysX(c)) for (const m of mx) { const d = cx - m; if (Math.abs(d) <= th && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: cx }; }
    for (const cy of keysY(c)) for (const m of my) { const d = cy - m; if (Math.abs(d) <= th && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: cy }; }
  }
  const dx = bestX ? bestX.d : 0, dy = bestY ? bestY.d : 0;
  const moved = { x: bb.x + dx, y: bb.y + dy, w: bb.w, h: bb.h };
  return { dx, dy, guides: guidesFor(cs, moved, bestX, bestY) };
}

function guidesFor(cs, moved, bx, by) {
  const guides = [];
  if (bx) {
    let y0 = moved.y, y1 = moved.y + moved.h;
    for (const c of cs) if (keysX(c).some(k => Math.abs(k - bx.at) < 0.5)) { y0 = Math.min(y0, c.y); y1 = Math.max(y1, c.y + c.h); }
    guides.push({ x: bx.at, y0, y1 });
  }
  if (by) {
    let x0 = moved.x, x1 = moved.x + moved.w;
    for (const c of cs) if (keysY(c).some(k => Math.abs(k - by.at) < 0.5)) { x0 = Math.min(x0, c.x); x1 = Math.max(x1, c.x + c.w); }
    guides.push({ y: by.at, x0, x1 });
  }
  return guides;
}

/** Snap the edges being dragged in a resize. `edges` says which of the box's sides move: {l, r, t, b}. */
export function snapEdges(ed, box, edges, ignore) {
  const th = SNAP_PX / ed.cam.z, cs = candidates(ed, ignore);
  let bestX = null, bestY = null;
  const xs = [], ys = [];
  if (edges.l) xs.push(box.x); if (edges.r) xs.push(box.x + box.w);
  if (edges.t) ys.push(box.y); if (edges.b) ys.push(box.y + box.h);
  for (const c of cs) {
    for (const cx of keysX(c)) for (const m of xs) { const d = cx - m; if (Math.abs(d) <= th && (!bestX || Math.abs(d) < Math.abs(bestX.d))) bestX = { d, at: cx }; }
    for (const cy of keysY(c)) for (const m of ys) { const d = cy - m; if (Math.abs(d) <= th && (!bestY || Math.abs(d) < Math.abs(bestY.d))) bestY = { d, at: cy }; }
  }
  return { dx: bestX ? bestX.d : 0, dy: bestY ? bestY.d : 0, guides: guidesFor(cs, box, bestX, bestY) };
}
