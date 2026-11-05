// Where you are looking: a world point at the top-left of the screen and a zoom. screen = (world - origin) * zoom.

export const MIN_Z = 0.02, MAX_Z = 4;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ease = t => 1 - Math.pow(1 - t, 3);

export class Camera {
  constructor(view) {
    this.x = view?.x || 0; this.y = view?.y || 0; this.z = clamp(view?.z || 1, MIN_Z, MAX_Z);
    this.w = 800; this.h = 600;
    this.anim = null;
    this.onChange = () => {};
  }
  resize(w, h) { this.w = w; this.h = h; this.onChange(); }
  toWorld(sx, sy) { return { x: sx / this.z + this.x, y: sy / this.z + this.y }; }
  toScreen(wx, wy) { return { x: (wx - this.x) * this.z, y: (wy - this.y) * this.z }; }
  /** The world rectangle on screen. */
  visible(margin = 0) { return { x: this.x - margin, y: this.y - margin, w: this.w / this.z + 2 * margin, h: this.h / this.z + 2 * margin }; }
  view() { return { x: this.x, y: this.y, z: this.z }; }

  panBy(dx, dy) { this.stop(); this.x -= dx / this.z; this.y -= dy / this.z; this.onChange(); }
  /** Zoom by `factor`, keeping the world point under screen (sx, sy) where it is. */
  zoomAt(sx, sy, factor) {
    this.stop();
    const z = clamp(this.z * factor, MIN_Z, MAX_Z);
    const wx = sx / this.z + this.x, wy = sy / this.z + this.y;
    this.z = z; this.x = wx - sx / z; this.y = wy - sy / z;
    this.onChange();
  }
  setZoom(z, sx = this.w / 2, sy = this.h / 2) { this.zoomAt(sx, sy, clamp(z, MIN_Z, MAX_Z) / this.z); }

  /** The view that shows `r` (world) with `pad` screen pixels around it. */
  framing(r, pad = 72, maxZ = 1.5) {
    const z = clamp(Math.min((this.w - 2 * pad) / Math.max(r.w, 1), (this.h - 2 * pad) / Math.max(r.h, 1)), MIN_Z, maxZ);
    return { x: r.x + r.w / 2 - this.w / 2 / z, y: r.y + r.h / 2 - this.h / 2 / z, z };
  }

  stop() { this.anim = null; }
  /** Glide to a view. */
  flyTo(v, ms = 320) {
    const from = this.view(), t0 = performance.now();
    this.anim = { from, to: v, t0, ms };
  }
  /** Called every frame; returns true while still moving. */
  step(now) {
    const a = this.anim;
    if (!a) return false;
    const t = Math.min(1, (now - a.t0) / a.ms), k = ease(t);
    // Interpolate the zoom on a log scale so a long fly feels even.
    const z = Math.exp(Math.log(a.from.z) + (Math.log(a.to.z) - Math.log(a.from.z)) * k);
    // Keep the centre moving linearly in world space.
    const cx0 = a.from.x + this.w / 2 / a.from.z, cy0 = a.from.y + this.h / 2 / a.from.z;
    const cx1 = a.to.x + this.w / 2 / a.to.z, cy1 = a.to.y + this.h / 2 / a.to.z;
    const cx = cx0 + (cx1 - cx0) * k, cy = cy0 + (cy1 - cy0) * k;
    this.z = z; this.x = cx - this.w / 2 / z; this.y = cy - this.h / 2 / z;
    if (t >= 1) this.anim = null;
    this.onChange();
    return t < 1;
  }
}
