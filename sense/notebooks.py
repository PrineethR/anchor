"""Notebooks: an infinite canvas per notebook, for notes and thoughts written anywhere.

This sits beside the photo pages and replaces nothing: it only reads from the same engine. A
notebook is items (text, shapes, photos) and links (arrows), in the same shape the page schema
uses, so `meaning.make_sense` reasons about a canvas exactly as it does about a photographed page.

    items   {"id", "type": "text" | "shape" | "image", "x", "y", "w", "h", ...}   world pixels, top-left
              text: "text", "underline", "caps", "fixed"     image: "src" (a file in the notebook's assets/)
    links   {"id", "kind": "flow" | "hook" | "connector", "from", "to", "label", "caps", "underline", "bend"}
              an end is an item id, or {"x", "y"} for an arrow drawn out into empty paper

An arrow with a free end is drawn but is not a connection, so it does not join threads.

Stored as notes/notebooks/<id>/notebook.json with a revision number, so a second tab cannot silently
overwrite the first. Stdlib only.
"""

from __future__ import annotations

import json
import math
import os
import re
import secrets
import shutil
import tempfile
import threading
from datetime import datetime
from pathlib import Path

from . import engine, meaning, narrate, share

ID = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{4}$")
ITEM_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
ASSET = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
COLORS = ("sky", "blush", "mint", "violet", "tangerine", "berry")  # cover colours; sun stays "you underlined this"
ITEM_COLORS = ("sky", "blush", "mint", "violet", "tangerine", "berry", "sun")
TEXT_SIZES = ("body", "heading", "title")
SHAPE_KINDS = ("blob", "box", "circle")
SHAPE_FILLS = ("hatch", "tint", "outline")
SHAPE_STROKES = ("dashed", "solid", "dotted")
LINK_HEADS = ("forward", "both", "none")
LINK_STROKES = ("solid", "dashed", "dotted")
KINDS = {"flow", "hook", "connector"}
MAX_ITEMS = 3000
MAX_TEXT = 5000
BOUND = 1_000_000
TEXT_W = 320        # a text item wraps at this width unless you drag it wider or narrower
IMPORT_W = 640      # a photographed page lands this wide on the canvas
TYPED_SCALE = 1.5   # its words are laid out this much larger than the photo, because typed words need more room than handwriting
GAP = 100           # and its retyped items sit this far to the right of it
PAD = 40            # margin around everything when a canvas is handed to make_sense


class NotFound(LookupError):
    pass


class Conflict(ValueError):
    """The notebook changed since this copy was loaded (another tab)."""


def _num(v, lo: float = -BOUND, hi: float = BOUND, default: float = 0.0) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return min(hi, max(lo, f)) if math.isfinite(f) else default


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def clean_items(raw) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > MAX_ITEMS:
        raise ValueError("That notebook has too many things on it to keep.")
    out, seen = [], set()
    for i in raw:
        if not isinstance(i, dict) or i.get("type") not in ("text", "shape", "image"):
            raise ValueError("Something on the canvas isn't text, a shape or a photo.")
        iid = str(i.get("id", ""))
        if not ITEM_ID.match(iid) or iid in seen:
            raise ValueError("Every item on the canvas needs its own id.")
        seen.add(iid)
        item = {"id": iid, "type": i["type"], "x": _num(i.get("x")), "y": _num(i.get("y")),
                "w": _num(i.get("w"), 0, BOUND), "h": _num(i.get("h"), 0, BOUND)}
        if i["type"] == "text":
            item.update(text=str(i.get("text", ""))[:MAX_TEXT], underline=bool(i.get("underline")), caps=bool(i.get("caps")),
                        fixed=bool(i.get("fixed")))  # fixed: you dragged its width; otherwise it sizes to its words
            if i.get("size") in TEXT_SIZES:
                item["size"] = i["size"]
            if i.get("color") in ITEM_COLORS:
                item["color"] = i["color"]
            if i.get("align") in ("left", "center"):
                item["align"] = i["align"]
        if i["type"] == "shape":
            if i.get("shape") in SHAPE_KINDS:
                item["shape"] = i["shape"]
            if i.get("fill") in SHAPE_FILLS:
                item["fill"] = i["fill"]
            if i.get("stroke") in SHAPE_STROKES:
                item["stroke"] = i["stroke"]
            if i.get("color") in ITEM_COLORS:
                item["color"] = i["color"]
        if i["type"] == "image":
            src = str(i.get("src", ""))
            if not ASSET.match(src):
                raise ValueError("A photo on the canvas points at a file that isn't allowed.")
            item["src"] = src
            if i.get("rot") in (0, 1, 2, 3, "0", "1", "2", "3"):
                item["rot"] = int(i["rot"]) % 4
            if i.get("z_order") in ("back", "front"):
                item["z_order"] = i["z_order"]
        out.append(item)
    return out


def _end(v, ids: set[str]):
    if isinstance(v, dict) and "x" in v and "y" in v:
        return {"x": _num(v["x"]), "y": _num(v["y"])}
    if isinstance(v, str) and v in ids:
        return v
    return None  # the item it pointed at is gone


def clean_links(raw, ids: set[str]) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > MAX_ITEMS:
        raise ValueError("That notebook has too many arrows to keep.")
    out, seen = [], set()
    for l in raw:
        if not isinstance(l, dict) or l.get("kind") not in KINDS:
            raise ValueError("An arrow on the canvas isn't a known kind.")
        lid = str(l.get("id", ""))
        if not ITEM_ID.match(lid) or lid in seen:
            raise ValueError("Every arrow needs its own id.")
        seen.add(lid)
        a, b = _end(l.get("from"), ids), _end(l.get("to"), ids)
        if a is None or b is None or a == b:
            continue
        link = {"id": lid, "kind": l["kind"], "from": a, "to": b, "bend": _num(l.get("bend"), -2, 2)}
        if l.get("heads") in LINK_HEADS:
            link["heads"] = l["heads"]
        if l.get("stroke") in LINK_STROKES:
            link["stroke"] = l["stroke"]
        if l.get("color") in ITEM_COLORS:
            link["color"] = l["color"]
        label = str(l.get("label") or "").strip()[:200]
        if label:
            link.update(label=label, caps=bool(l.get("caps")), underline=bool(l.get("underline")))
        out.append(link)
    return out


def blank(nid: str, title: str, color: str) -> dict:
    return {"id": nid, "title": title, "color": color, "created": _now(), "updated": _now(), "rev": 1,
            "view": {"x": 0.0, "y": 0.0, "z": 1.0}, "sense_open": False, "items": [], "links": [], "narration": None}


# --- the canvas as a page -----------------------------------------------------------------------

def _size(i: dict) -> tuple[float, float]:
    """A text item's box. Measured by the browser; guessed from its text until then."""
    if i["type"] != "text":
        return max(i["w"], 20.0), max(i["h"], 20.0)
    lines = i["text"].split("\n") or [""]
    w = i["w"] or min(TEXT_W, max(40.0, 9.5 * max(len(l) for l in lines)))
    return max(w, 20.0), max(i["h"] or 26.0 * len(lines), 20.0)


def to_page(nb: dict, with_free: bool = False) -> dict:
    """The canvas as a page in the harness schema: bounds become page_size, coordinates shift to start at 0.

    Photos are left out (they are reference, not notes). Arrows with a free end are left out unless
    `with_free`, which is for drawing the notebook, never for making sense of it."""
    texts = [i for i in nb["items"] if i["type"] == "text" and i["text"].strip()]
    shapes = [i for i in nb["items"] if i["type"] == "shape"]
    keep = texts + shapes
    if not keep:
        return {"page_id": nb["id"], "page_size": [1000.0, 700.0], "elements": [], "links": []}
    boxes = {i["id"]: (i["x"], i["y"], *_size(i)) for i in keep}
    ox = min(b[0] for b in boxes.values()) - PAD
    oy = min(b[1] for b in boxes.values()) - PAD
    W = max(b[0] + b[2] for b in boxes.values()) - ox + PAD
    H = max(b[1] + b[3] for b in boxes.values()) - oy + PAD
    elements = []
    for i in keep:
        x, y, w, h = boxes[i["id"]]
        e = {"id": i["id"], "type": i["type"], "bbox": [x - ox, y - oy, w, h]}
        if i["type"] == "text":
            e.update(text=i["text"].strip(), underline=i["underline"], caps=i["caps"])
        else:
            e["contains"] = [t["id"] for t in texts
                             if x <= boxes[t["id"]][0] + boxes[t["id"]][2] / 2 <= x + w and y <= boxes[t["id"]][1] + boxes[t["id"]][3] / 2 <= y + h]
        elements.append(e)
    links = []
    for l in nb["links"]:
        ends = [l["from"], l["to"]]
        free = [e for e in ends if isinstance(e, dict)]
        if (free and not with_free) or any(isinstance(e, str) and e not in boxes for e in ends):
            continue
        out = {"id": l["id"], "kind": l["kind"], "bend": l.get("bend", 0),
               "from": {"x": l["from"]["x"] - ox, "y": l["from"]["y"] - oy} if isinstance(l["from"], dict) else l["from"],
               "to": {"x": l["to"]["x"] - ox, "y": l["to"]["y"] - oy} if isinstance(l["to"], dict) else l["to"]}
        if l.get("label"):
            out.update(label=l["label"], caps=l.get("caps", False), underline=l.get("underline", False))
        links.append(out)
    return {"page_id": nb["id"], "page_size": [W, H], "elements": elements, "links": links}


def thread_of(sense: dict) -> dict[str, int]:
    return {i: n for n, t in enumerate(sense["threads"]) for i in t["ids"]}


def thumb_svg(nb: dict, sense: dict) -> str:
    """A small picture of the notebook: its notes as tinted blocks, its shapes dashed, its arrows as lines."""
    items = [i for i in nb["items"] if i["type"] in ("text", "shape", "image")]
    if not items:
        return ""
    sizes = {i["id"]: _size(i) for i in items}
    minx, miny = min(i["x"] for i in items), min(i["y"] for i in items)
    maxx = max(i["x"] + sizes[i["id"]][0] for i in items)
    maxy = max(i["y"] + sizes[i["id"]][1] for i in items)
    vw, vh = 240, 150
    s = min((vw - 24) / max(maxx - minx, 1), (vh - 24) / max(maxy - miny, 1), 1.0)
    ox, oy = (vw - (maxx - minx) * s) / 2 - minx * s, (vh - (maxy - miny) * s) / 2 - miny * s
    tint = thread_of(sense)
    centre = {i["id"]: (ox + (i["x"] + sizes[i["id"]][0] / 2) * s, oy + (i["y"] + sizes[i["id"]][1] / 2) * s) for i in items}
    out = [f'<svg viewBox="0 0 {vw} {vh}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">']
    for i in items:  # photos and shapes first, so notes sit on them
        w, h = sizes[i["id"]]
        x, y, w, h = ox + i["x"] * s, oy + i["y"] * s, w * s, h * s
        if i["type"] == "image":
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="3" fill="var(--bg-muted)" opacity=".7"/>')
        elif i["type"] == "shape":
            out.append(f'<ellipse cx="{x + w / 2:.1f}" cy="{y + h / 2:.1f}" rx="{w / 2:.1f}" ry="{h / 2:.1f}" fill="none" '
                       f'stroke="var(--line-strong)" stroke-dasharray="3 3" opacity=".6"/>')
    for l in nb["links"]:
        if isinstance(l["from"], str) and isinstance(l["to"], str) and l["from"] in centre and l["to"] in centre:
            (x1, y1), (x2, y2) = centre[l["from"]], centre[l["to"]]
            out.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="var(--fg-3)" stroke-width="1"/>')
    for i in items:
        if i["type"] != "text":
            continue
        w, h = sizes[i["id"]]
        w, h = max(w * s, 10), max(h * s, 6)
        x, y = ox + i["x"] * s, oy + i["y"] * s
        n = tint.get(i["id"])
        fill = f"var(--{['sky', 'blush', 'mint', 'violet', 'tangerine', 'berry'][n % 6]}-soft)" if n is not None else "var(--bg-sunken)"
        out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="3" fill="{fill}"/>'
                   f'<rect x="{x + w * .12:.1f}" y="{y + h / 2 - .75:.1f}" width="{w * .76:.1f}" height="1.5" rx=".75" fill="var(--fg-3)"/>')
    out.append("</svg>")
    return "".join(out)


class Notebooks:
    """All notebooks, kept under notes/notebooks/. Needs the app's Store for the profile and the photo engine."""

    def __init__(self, store):
        self.store = store
        self.root = store.home / "notebooks"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    # --- storage -----------------------------------------------------------------------------

    def dir(self, nid: str) -> Path:
        if not ID.match(nid) or not (self.root / nid / "notebook.json").is_file():
            raise NotFound(nid)
        return self.root / nid

    def _load(self, nid: str) -> dict:
        return json.loads((self.dir(nid) / "notebook.json").read_text())

    def _write(self, nb: dict) -> None:
        d = self.root / nb["id"]
        d.mkdir(exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(nb, f, ensure_ascii=False)
        os.replace(tmp, d / "notebook.json")

    def sense_of(self, nb: dict, noun: str = "notebook") -> dict:
        return meaning.make_sense(to_page(nb), self.store.profile.data["action_cues"], noun=noun)

    def _view(self, nb: dict) -> dict:
        sense = self.sense_of(nb)
        return {**nb, "sense": sense, "sense_html": share.sense_html(sense, empty="No arrows yet. Draw one between two notes."),
                "can_narrate": bool(engine.gemini_key())}

    # --- notebooks ---------------------------------------------------------------------------

    def list(self) -> list[dict]:
        out = []
        for d in sorted((p for p in self.root.iterdir() if p.is_dir() and ID.match(p.name)), reverse=True):
            try:
                nb = json.loads((d / "notebook.json").read_text())
            except (OSError, ValueError):
                continue
            sense = self.sense_of(nb)
            out.append({"id": nb["id"], "title": nb["title"], "color": nb.get("color", "sky"), "updated": nb["updated"],
                        "notes": sense["stats"]["text"], "threads": sense["stats"]["threads"], "loose": sense["stats"]["loose"],
                        "photos": sum(i["type"] == "image" for i in nb["items"]), "thumb": thumb_svg(nb, sense)})
        out.sort(key=lambda n: n["updated"], reverse=True)
        return out

    def create(self, title: str = "") -> dict:
        with self.lock:
            nid = f"{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
            used = [json.loads((d / "notebook.json").read_text()).get("color") for d in self.root.iterdir()
                    if (d / "notebook.json").is_file()]
            color = next((c for c in COLORS if c not in used), COLORS[len(used) % len(COLORS)])
            nb = blank(nid, (title or "").strip()[:120] or "Untitled notebook", color)
            self._write(nb)
            if getattr(self.store, "sync", None):
                self.store.sync.schedule_notebook(self.dir(nb["id"]))
        return self._view(nb)

    def get(self, nid: str) -> dict:
        return self._view(self._load(nid))

    def save(self, nid: str, body: dict) -> dict:
        """Apply a change. `rev` must be the revision the client last saw; anything else is a Conflict."""
        with self.lock:
            nb = self._load(nid)
            if body.get("rev") != nb["rev"]:
                raise Conflict("This notebook changed in another tab. Reload to see the latest.")
            if "items" in body:
                nb["items"] = clean_items(body["items"])
                nb["links"] = clean_links(body.get("links", nb["links"]), {i["id"] for i in nb["items"]})
            elif "links" in body:
                nb["links"] = clean_links(body["links"], {i["id"] for i in nb["items"]})
            if "title" in body:
                nb["title"] = str(body["title"]).strip()[:120] or nb["title"]
            if body.get("color") in COLORS:
                nb["color"] = body["color"]
            if isinstance(body.get("view"), dict):
                nb["view"] = {"x": _num(body["view"].get("x")), "y": _num(body["view"].get("y")), "z": _num(body["view"].get("z"), 0.05, 8, 1.0)}
            if "sense_open" in body:
                nb["sense_open"] = bool(body["sense_open"])
            if "items" in body or "links" in body:
                nb["narration"] = {**nb["narration"], "stale": True} if nb.get("narration") else None
            nb["rev"] += 1
            nb["updated"] = _now()
            self._write(nb)
            if getattr(self.store, "sync", None):
                self.store.sync.schedule_notebook(self.dir(nb["id"]))
        sense = self.sense_of(nb)
        return {"rev": nb["rev"], "updated": nb["updated"], "sense": sense,
                "sense_html": share.sense_html(sense, empty="No arrows yet. Draw one between two notes.")}

    def delete(self, nid: str) -> None:
        with self.lock:
            shutil.rmtree(self.dir(nid))
            if getattr(self.store, "sync", None):
                self.store.sync.schedule_delete_notebook(nid)

    # --- photos ------------------------------------------------------------------------------

    def asset(self, nid: str, name: str) -> bytes:
        if not ASSET.match(name) or not (self.dir(nid) / "assets" / name).is_file():
            raise NotFound(name)
        return (self.dir(nid) / "assets" / name).read_bytes()

    def _free_spot(self, nb: dict) -> tuple[float, float]:
        if not nb["items"]:
            return 0.0, 0.0
        return max(i["x"] + _size(i)[0] for i in nb["items"]) + 160, min(i["y"] for i in nb["items"])

    def import_note(self, nid: str, note_id: str, at: dict | None = None) -> dict:
        """Put a photographed page on the canvas: the photo, and beside it the words it was read as,
        at the same positions, as ordinary items you can move and fix."""
        d = self.store.dir(note_id)  # raises the app's NotFound if there is no such page
        page = json.loads((d / "page.json").read_text())
        with self.lock:
            nb = self._load(nid)
            pw, ph = page["page_size"]
            s = IMPORT_W / pw
            ox, oy = (_num(at.get("x")), _num(at.get("y"))) if at else self._free_spot(nb)
            asset = f"{note_id}.jpg"
            (self.dir(nid) / "assets").mkdir(exist_ok=True)
            shutil.copy(d / "flat.jpg", self.dir(nid) / "assets" / asset)
            used = {i["id"] for i in nb["items"]} | {l["id"] for l in nb["links"]}

            def fresh(prefix: str) -> str:
                while True:
                    cand = f"{prefix}{secrets.token_hex(3)}"
                    if cand not in used:
                        used.add(cand)
                        return cand

            ids = {}
            items = [{"id": fresh("p"), "type": "image", "x": ox, "y": oy, "w": float(IMPORT_W), "h": ph * s, "src": asset}]
            cx = ox + IMPORT_W + GAP
            si = s * TYPED_SCALE
            for e in page["elements"]:
                if e["type"] not in ("text", "shape"):
                    continue
                x, y, w, h = e["bbox"]
                item = {"id": fresh("n"), "type": e["type"], "x": cx + x * si, "y": oy + y * si, "w": max(60.0, w * si * 1.15), "h": h * si}
                if e["type"] == "text":
                    item.update(text=e["text"], underline=bool(e.get("underline")), caps=bool(e.get("caps")))
                ids[e["id"]] = item["id"]
                items.append(item)
            links = []
            for l in page["links"]:
                a = ids.get(l["from"] if isinstance(l["from"], str) else l["from"][0]["id"])
                b = ids.get(l["to"] if isinstance(l["to"], str) else l["to"][0]["id"])
                if a and b:
                    link = {"id": fresh("a"), "kind": l["kind"], "from": a, "to": b, "bend": 0}
                    if l.get("label"):
                        link.update(label=l["label"], caps=bool(l.get("caps")), underline=bool(l.get("underline")))
                    links.append(link)
            nb["items"] = clean_items(nb["items"] + items)
            nb["links"] = clean_links(nb["links"] + links, {i["id"] for i in nb["items"]})
            nb["rev"] += 1
            nb["updated"] = _now()
            self._write(nb)
        return self._view(nb) | {"added": [i["id"] for i in items]}

    def add_photo(self, nid: str, data: bytes, at: dict | None = None) -> dict:
        """Read a new photo with the engine (it also appears under Pages) and put it on the canvas."""
        self.dir(nid)  # fail early if the notebook is gone
        note = self.store.create(data)
        return self.import_note(nid, note["id"], at)

    # --- sharing -----------------------------------------------------------------------------

    def _note_of(self, nb: dict, sense: dict) -> dict:
        return {"title": nb["title"], "created": nb["created"], "page": to_page(nb, with_free=True), "sense": sense,
                "narration": nb.get("narration"), "px": True,
                "voice": {"kicker": "From a notebook", "section": "The notebook, <em>laid out</em>", "md": "From a notebook",
                          "footer": "Written on an endless page, then made sense of."}}

    def export(self, nid: str, fmt: str) -> tuple[bytes, str, str]:
        nb = self._load(nid)
        note = self._note_of(nb, self.sense_of(nb))
        slug = re.sub(r"[^a-z0-9]+", "-", nb["title"].lower()).strip("-")[:48] or "notebook"
        if fmt == "md":
            return share.to_markdown(note).encode(), "text/markdown; charset=utf-8", f"{slug}.md"
        return share.to_html(note, None).encode(), "text/html; charset=utf-8", f"{slug}.html"

    def narrate(self, nid: str) -> dict:
        key = engine.gemini_key()
        if not key:
            raise ValueError("Add a GEMINI_API_KEY and restart to have Gemini write a summary.")
        nb = self._load(nid)
        note = self._note_of(nb, self.sense_of(nb))
        out = narrate.narrate({**note, "narration": None}, self.store.profile.hints(), engine.gemini_model(), key)
        with self.lock:
            nb = self._load(nid)
            nb["narration"] = {**out, "stale": False}
            self._write(nb)
        return self._view(nb)
