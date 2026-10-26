"""The page retyped: every box where you wrote it, every arrow where you drew it.

`layout` turns a page into plain geometry (units: 1000 across, height by aspect). The UI
draws its photo overlay from that, and `render_html` draws the same geometry as a clean
copy that needs no script, so it can sit inside a shared file.

Looks follow the Noteworthy design system: words are set in Newsreader on the soft wash of
the colour of the thread they belong to (words on no thread sit on paper-2), what you
underlined carries the system's highlight, arrows are plain ink, and a shape you drew is a
dashed, hatched field, like the map fields in the system's own illustrations.
"""

from __future__ import annotations

import math
from html import escape

W = 1000
PAD = 6  # how far an arrow stops short of a box, in layout units

CSS = """
.canvas { position: relative; container-type: inline-size; min-width: 640px; background: var(--bg-surface);
  border-radius: var(--radius-xl); overflow: hidden; --hl: color-mix(in srgb, var(--highlight) 78%, transparent); }
.canvas svg { position: absolute; inset: 0; width: 100%; height: 100%; }
.canvas .wire { stroke: var(--fg-2); stroke-width: 1.6; fill: none; stroke-linecap: round; }
.canvas .wire.hook { stroke-dasharray: 4 4; }
.canvas .ah { fill: var(--fg-2); }
.canvas .blob { position: absolute; border: var(--stroke) dashed var(--line-strong); color: var(--ink-300);
  background: var(--pattern-hatch); border-radius: 46% 54% 50% 50% / 52% 46% 54% 48%; }
.canvas .box { position: absolute; transform: translate(-50%, -50%); text-align: center; padding: .1em .5em; border-radius: .7em;
  font: var(--w-regular) 1.9cqw/1.25 var(--font-serif); color: var(--fg-1); background: var(--ts, var(--bg-sunken)); }
.canvas .box.u { background: linear-gradient(transparent 62%, var(--hl) 62%, var(--hl) 90%, transparent 90%), var(--ts, var(--bg-sunken)); }
.canvas .box.c { font: var(--w-semibold) 1.45cqw/1.25 var(--font-sans); text-transform: uppercase; letter-spacing: .04em; }
.canvas .alabel { position: absolute; transform: translate(-50%, -50%); font: var(--w-semibold) 1.3cqw/1 var(--font-sans);
  color: var(--ti, var(--fg-2)); background: var(--bg-surface); padding: .25em .6em; border-radius: var(--radius-pill);
  border: 1px solid var(--line-soft); white-space: nowrap; }
.canvas.px { min-width: 0; border-radius: 0; }
.canvas.px .box { font-size: 18px; line-height: 1.3; }
.canvas.px .box.c { font-size: 14px; }
.canvas.px .alabel { font-size: 13px; }
.canvas.px .wire { stroke-width: 1.75; }
.canvas .alabel.u { background: linear-gradient(transparent 60%, var(--hl) 60%, var(--hl) 92%, transparent 92%), var(--bg-surface); }
.canvas .alabel.c { text-transform: uppercase; letter-spacing: .04em; }
"""


def _edge(box, toward, pad):
    """Where the line from the centre of `box` to `toward` leaves it, pushed out by `pad`."""
    cx, cy = box["x"] + box["w"] / 2, box["y"] + box["h"] / 2
    dx, dy = toward[0] - cx, toward[1] - cy
    norm = math.hypot(dx, dy) or 1.0
    t = min((box["w"] / 2) / abs(dx) if dx else math.inf, (box["h"] / 2) / abs(dy) if dy else math.inf)
    if t > 1:  # the target's centre is inside this box: leave from the centre
        t = 0
    return cx + dx * t + dx / norm * pad, cy + dy * t + dy / norm * pad


def _end(v, boxes, k):
    """The box an arrow end sits on, or a zero-size box for an end drawn on empty paper ({"x", "y"})."""
    if isinstance(v, dict):
        return {"x": v["x"] * k, "y": v["y"] * k, "w": 0, "h": 0, "thread": None, "free": True}
    return boxes.get(v if isinstance(v, str) else v[0]["id"])


def layout(page: dict, thread_of: dict | None = None, normalize: bool = True) -> dict:
    """Geometry for a page. `thread_of` maps an element id to the number of the thread it belongs to.

    normalize=True scales to 1000 across (the photo overlay and the single-page share file).
    normalize=False keeps the page's own units, so one unit is one pixel at zoom 1 (a notebook).
    An arrow end may be {"x", "y"} (drawn on empty paper); a link may carry `bend`, how far its
    middle bows to the right of the way it points (down the screen when it points right), as a share of its length."""
    thread_of = thread_of or {}
    pw, ph = page["page_size"]
    k = W / pw if normalize else 1.0
    boxes = {}
    for e in page["elements"]:
        x, y, w, h = (v * k for v in e["bbox"])
        boxes[e["id"]] = {"id": e["id"], "type": e["type"], "x": x, "y": y, "w": w, "h": h, "thread": thread_of.get(e["id"]),
                          "text": e.get("text", ""), "underline": bool(e.get("underline")), "caps": bool(e.get("caps"))}
    arrows = []
    for l in page.get("links", []):
        a, b = _end(l["from"], boxes, k), _end(l["to"], boxes, k)
        if a is None or b is None or a is b:
            continue
        ac, bc = (a["x"] + a["w"] / 2, a["y"] + a["h"] / 2), (b["x"] + b["w"] / 2, b["y"] + b["h"] / 2)
        dx, dy = bc[0] - ac[0], bc[1] - ac[1]
        length = math.hypot(dx, dy)
        bend = float(l.get("bend") or 0)
        c = ((ac[0] + bc[0]) / 2 - dy * bend, (ac[1] + bc[1]) / 2 + dx * bend) if bend and length else None
        x1, y1 = _edge(a, c or bc, 0 if a.get("free") else PAD)
        x2, y2 = _edge(b, c or ac, 0 if b.get("free") else PAD)
        mid = ((x1 + 2 * c[0] + x2) / 4, (y1 + 2 * c[1] + y2) / 4) if c else ((x1 + x2) / 2, (y1 + y2) / 2)
        arrows.append({"id": l["id"], "kind": l["kind"], "from": a.get("id"), "to": b.get("id"), "label": l.get("label", ""),
                       "x1": x1, "y1": y1, "x2": x2, "y2": y2, "mx": mid[0], "my": mid[1],
                       "cx": c[0] if c else None, "cy": c[1] if c else None, "bend": bend if c else 0,
                       "thread": a["thread"] if a["thread"] is not None else b["thread"],
                       "caps": bool(l.get("caps")), "underline": bool(l.get("underline"))})
    return {"w": W if normalize else pw, "h": ph * k, "px": not normalize, "boxes": list(boxes.values()), "arrows": arrows}


def _th(n) -> str:
    return "" if n is None else f" th{n % 6}"


def render_html(lay: dict) -> str:
    w, h = lay["w"], lay["h"]
    pct = lambda v, total: f"{100 * v / total:.2f}%"
    px = lay.get("px")
    max_w = (lambda b: f"{max(b['w'] * 1.15, 80):.0f}px") if px else (lambda b: f"{max(b['w'] * 1.2, 120) / w * 100:.1f}%")
    size = f"width:{w:.0f}px;height:{h:.0f}px" if px else f"aspect-ratio:{w:.0f}/{h:.0f}"
    out = [f'<div class="canvas{" px" if px else ""}" style="{size}">',
           f'<svg viewBox="0 0 {w:.0f} {h:.0f}" preserveAspectRatio="none" aria-hidden="true">',
           '<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" '
           'orient="auto-start-reverse"><path class="ah" d="M0 0 10 5 0 10z"/></marker></defs>']
    for a in lay["arrows"]:
        if a["cx"] is None:
            out.append(f'<line class="wire {escape(a["kind"])}" x1="{a["x1"]:.1f}" y1="{a["y1"]:.1f}" '
                       f'x2="{a["x2"]:.1f}" y2="{a["y2"]:.1f}" marker-end="url(#ah)"/>')
        else:
            out.append(f'<path class="wire {escape(a["kind"])}" d="M{a["x1"]:.1f} {a["y1"]:.1f}Q{a["cx"]:.1f} {a["cy"]:.1f} '
                       f'{a["x2"]:.1f} {a["y2"]:.1f}" marker-end="url(#ah)"/>')
    out.append("</svg>")
    for b in lay["boxes"]:
        if b["type"] == "shape":
            out.append(f'<div class="blob" style="left:{pct(b["x"], w)};top:{pct(b["y"], h)};'
                       f'width:{pct(b["w"], w)};height:{pct(b["h"], h)}"></div>')
    for b in lay["boxes"]:
        if b["type"] != "text":
            continue
        cls = "box" + _th(b["thread"]) + (" u" if b["underline"] else "") + (" c" if b["caps"] else "")
        out.append(f'<div class="{cls}" data-id="{escape(b["id"])}" style="left:{pct(b["x"] + b["w"] / 2, w)};'
                   f'top:{pct(b["y"] + b["h"] / 2, h)};max-width:{max_w(b)}">'
                   f'{escape(b["text"])}</div>')
    for a in lay["arrows"]:
        if a["label"]:
            cls = "alabel" + _th(a["thread"]) + (" u" if a["underline"] else "") + (" c" if a["caps"] else "")
            out.append(f'<div class="{cls}" style="left:{pct(a["mx"], w)};top:{pct(a["my"], h)}">{escape(a["label"])}</div>')
    out.append("</div>")
    return "".join(out)
