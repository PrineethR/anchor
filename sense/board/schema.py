"""What a Board object is. Stdlib only, no I/O: the rules every writer (the browser, an import) goes through.

A board is plain JSON: notes/boards/<id>/board.json, with an assets/ folder beside it.

    {"format": "anchor-board", "version": 1, "id", "title", "created", "updated", "rev",
     "view": {"x", "y", "z"},            where the screen was: world point at the top-left, and the zoom
     "objects": [ ... ]}                 in z-order, back to front

Every object has "id", "type", "x", "y", "w", "h" (world pixels, top-left) and may have
"locked", "parent" (the frame it sits in) and "group" (a group id).

    sticky     text, color (a key of STICKY), text_style
    text       text, text_style, fill, minh (the least height, if you pulled it taller)
    shape      shape (SHAPES), text, text_style, fill, stroke, stroke_width, dash
    connector  from / to  ({"id", "side", "t"} glued to an object, or {"x", "y"} free), shape (CONNECTORS),
               start_head / end_head (HEADS), color, width, dash, label, text_style
    draw       tool (pen | highlighter), color, width, points [x, y, pressure, ...] relative to x, y
    image      src (assets/<file>), name
    file       src, name, size, mime
    link       url, title, desc, host, favicon, thumb (assets)
    frame      title, fill
    node       a mind-map node: text, text_style, fill, mm {"parent", "collapsed", "side"}

text_style: {"size": number | "auto", "bold", "italic", "underline", "align": left | center | right, "font": one of FONTS, "color": "#rrggbb" | null}
"""

from __future__ import annotations

import math
import re

FORMAT = "anchor-board"
VERSION = 1

# \Z, not $: a "$" also matches just before a trailing newline, and none of these may end in one.
ID = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{4}\Z")
OBJ_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}\Z")
ASSET = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ ()+,-]{0,119}\Z")
HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\Z")

TYPES = ("sticky", "text", "shape", "connector", "draw", "image", "file", "link", "frame", "node")
# Miro's sticky-note colours (the names are Miro's; the values are close to what it draws). Kept in step with web/board/palette.js.
STICKY = {
    "gray": "#E6E6E6", "light_yellow": "#FFF9B1", "yellow": "#F5D128", "orange": "#FF9D48", "light_green": "#D5F692",
    "green": "#C9DF56", "dark_green": "#93D275", "cyan": "#67C6C0", "light_pink": "#FFCEE0", "pink": "#F16C7F",
    "violet": "#CA91D8", "red": "#F24726", "light_blue": "#A6CCF5", "blue": "#2D9BF0", "dark_blue": "#5B7CE6", "black": "#1A1A1A",
}
SHAPES = ("rect", "round", "ellipse", "diamond", "triangle", "hexagon", "cylinder", "arrow")
CONNECTORS = ("straight", "elbow", "curved")
HEADS = ("none", "arrow", "triangle", "diamond", "circle", "bar")
DASHES = ("solid", "dashed", "dotted")
SIDES = ("auto", "t", "r", "b", "l")
ALIGNS = ("left", "center", "right")
TOOLS = ("pen", "highlighter")

MAX_OBJECTS = 20000
MAX_TEXT = 10000
MAX_POINTS = 60000
BOUND = 5_000_000
DEFAULT_SIZE = {
    "sticky": (180, 180), "text": (240, 40), "shape": (160, 110), "frame": (640, 420), "node": (160, 48),
    "image": (320, 240), "file": (240, 76), "link": (300, 220), "draw": (10, 10), "connector": (0, 0),
}


def num(v, lo: float = -BOUND, hi: float = BOUND, default: float = 0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return round(min(hi, max(lo, f)), 2) if math.isfinite(f) else default


def text(v, limit: int = MAX_TEXT) -> str:
    return str(v if v is not None else "")[:limit]


def color(v):
    return v if isinstance(v, str) and HEX.match(v) else None


FONTS = ("ui", "serif", "mono", "georgia", "helvetica", "rounded", "slab", "marker", "hand", "impact")


def text_style(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    out = {}
    size = raw.get("size")
    if size == "auto":
        out["size"] = "auto"
    elif isinstance(size, (int, float)) and not isinstance(size, bool):
        out["size"] = num(size, 6, 400, 16)
    for k in ("bold", "italic", "underline"):
        if k in raw:
            out[k] = bool(raw[k])
    if raw.get("font") in FONTS:
        out["font"] = raw["font"]
    if raw.get("align") in ALIGNS:
        out["align"] = raw["align"]
    if "color" in raw:
        out["color"] = color(raw["color"])
    return out or None


def end(raw):
    """One end of a connector: glued to an object, or a free point on the canvas."""
    if not isinstance(raw, dict):
        return None
    if isinstance(raw.get("id"), str) and OBJ_ID.match(raw["id"]):
        out = {"id": raw["id"], "side": raw.get("side") if raw.get("side") in SIDES else "auto"}
        if "t" in raw:
            out["t"] = num(raw["t"], 0, 1, 0.5)
        return out
    if "x" in raw and "y" in raw:
        return {"x": num(raw["x"]), "y": num(raw["y"])}
    return None


def clean_object(raw) -> dict:
    """The canonical form of one object. Unknown fields are dropped; a malformed object raises ValueError."""
    if not isinstance(raw, dict) or raw.get("type") not in TYPES:
        raise ValueError("Something on the board isn't a known kind of object.")
    oid = raw.get("id")
    if not isinstance(oid, str) or not OBJ_ID.match(oid):
        raise ValueError("Every object on the board needs its own id.")
    t = raw["type"]
    dw, dh = DEFAULT_SIZE[t]
    o = {"id": oid, "type": t, "x": num(raw.get("x")), "y": num(raw.get("y")),
         "w": num(raw.get("w", dw), 0, BOUND, dw), "h": num(raw.get("h", dh), 0, BOUND, dh)}
    if t not in ("connector", "draw"):
        o["w"], o["h"] = max(o["w"], 4.0), max(o["h"], 4.0)
    if raw.get("locked"):
        o["locked"] = True
    for k in ("parent", "group"):
        if isinstance(raw.get(k), str) and OBJ_ID.match(raw[k]):
            o[k] = raw[k]
    if t in ("sticky", "text", "shape", "node"):
        o["text"] = text(raw.get("text"))
        ts = text_style(raw.get("text_style"))
        if ts:
            o["text_style"] = ts
    if t == "text" and num(raw.get("minh"), 0, BOUND, 0.0) > 0:
        o["minh"] = num(raw.get("minh"), 0, BOUND, 0.0)     # a text box you pulled taller: its height never goes below this
    if t == "sticky":
        o["color"] = raw["color"] if isinstance(raw.get("color"), str) and raw["color"] in STICKY else "light_yellow"
    if t in ("text", "shape", "node", "frame"):
        o["fill"] = color(raw.get("fill"))
    if t == "shape":
        o["shape"] = raw.get("shape") if raw.get("shape") in SHAPES else "rect"
        o["stroke"] = color(raw.get("stroke")) if "stroke" in raw else None
        o["stroke_width"] = num(raw.get("stroke_width", 2), 0, 40, 2)
        o["dash"] = raw.get("dash") if raw.get("dash") in DASHES else "solid"
    if t == "frame":
        o["title"] = text(raw.get("title"), 200)
    if t == "node":
        mm = raw.get("mm") if isinstance(raw.get("mm"), dict) else {}
        o["mm"] = {"parent": mm["parent"] if isinstance(mm.get("parent"), str) and OBJ_ID.match(mm["parent"]) else "",
                   "collapsed": bool(mm.get("collapsed")), "side": "left" if mm.get("side") == "left" else "right"}
    if t == "connector":
        a, b = end(raw.get("from")), end(raw.get("to"))
        if a is None or b is None:
            raise ValueError("A connector needs two ends.")
        o.update({"from": a, "to": b, "shape": raw.get("shape") if raw.get("shape") in CONNECTORS else "straight",
                  "start_head": raw.get("start_head") if raw.get("start_head") in HEADS else "none",
                  "end_head": raw.get("end_head") if raw.get("end_head") in HEADS else "arrow",
                  "color": color(raw.get("color")), "width": num(raw.get("width", 2), 0.5, 40, 2),
                  "dash": raw.get("dash") if raw.get("dash") in DASHES else "solid", "label": text(raw.get("label"), 500)})
        ts = text_style(raw.get("text_style"))
        if ts:
            o["text_style"] = ts
        if raw.get("auto") == "mm":
            o["auto"] = "mm"
    if t == "draw":
        pts = raw.get("points")
        if not isinstance(pts, list) or len(pts) > MAX_POINTS or len(pts) % 3:
            raise ValueError("A drawing has to be a list of x, y, pressure triples.")
        o.update({"tool": raw.get("tool") if raw.get("tool") in TOOLS else "pen", "color": color(raw.get("color")) or "#1A1A1A",
                  "width": num(raw.get("width", 4), 0.5, 200, 4), "points": [num(v, -BOUND, BOUND, 0.0) for v in pts]})
    if t in ("image", "file", "link"):
        for k in (("src", "name", "size", "mime") if t != "link" else ("favicon", "thumb")):
            v = raw.get(k)
            if k in ("src", "favicon", "thumb"):
                if isinstance(v, str) and ASSET.match(v):
                    o[k] = v
                elif k == "src":
                    raise ValueError("A picture or file on the board points at a file that isn't allowed.")
            elif k == "size":
                o[k] = int(num(v, 0, 2**40, 0))
            else:
                o[k] = text(v, 255)
    if t == "link":
        url = text(raw.get("url"), 2000)
        if not re.match(r"^https?://", url, re.I):
            raise ValueError("A link card needs an http or https address.")
        o.update(url=url, title=text(raw.get("title"), 300), desc=text(raw.get("desc"), 600), host=text(raw.get("host"), 255))
    return o


def clean_objects(raw) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > MAX_OBJECTS:
        raise ValueError("That board has too many things on it to keep.")
    out, seen = [], set()
    for r in raw:
        o = clean_object(r)
        if o["id"] in seen:
            raise ValueError("Two things on the board share an id.")
        seen.add(o["id"])
        out.append(o)
    return out


def tidy(objects: list[dict]) -> list[dict]:
    """References that point at nothing are removed: a frame that is gone, a group of one, a mind-map parent that isn't there.
    A connector whose glued object is gone keeps the end where that object was (its last x, y), so it isn't thrown away."""
    ids = {o["id"] for o in objects}
    frames = {o["id"] for o in objects if o["type"] == "frame"}
    groups: dict[str, int] = {}
    for o in objects:
        if o.get("group"):
            groups[o["group"]] = groups.get(o["group"], 0) + 1
    for o in objects:
        if o.get("parent") and (o["parent"] not in frames or o["parent"] == o["id"]):
            del o["parent"]
        if o.get("group") and groups[o["group"]] < 2:
            del o["group"]
        if o["type"] == "node" and o["mm"]["parent"] and o["mm"]["parent"] not in ids:
            o["mm"]["parent"] = ""
        if o["type"] == "connector":
            for k in ("from", "to"):
                if "id" in o[k] and o[k]["id"] not in ids:
                    o[k] = {"x": o["x"] if k == "from" else o["x"] + o["w"], "y": o["y"] if k == "from" else o["y"] + o["h"]}
    return objects


def bbox(objs: list[dict]) -> tuple[float, float, float, float] | None:
    if not objs:
        return None
    x0 = min(o["x"] for o in objs)
    y0 = min(o["y"] for o in objs)
    x1 = max(o["x"] + o["w"] for o in objs)
    y1 = max(o["y"] + o["h"] for o in objs)
    return x0, y0, x1 - x0, y1 - y0
