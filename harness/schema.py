"""Page-structure format shared by hand labels (gold) and pipeline output (pred).

One JSON file per page. Coordinates may be in any unit (flattened-A4 mm, or
pixels of the flattened image); `page_size` declares the extent and everything
is normalized to [0,1] before scoring, so gold and pred may use different units.

{
  "page_id": "page-01",
  "page_size": [210, 297],                 # width, height in the file's units
  "elements": [
    {"id": "t1", "type": "text", "bbox": [x, y, w, h], "text": "Belief",
     "underline": true, "caps": false, "confidence": 0.9},
    {"id": "s1", "type": "shape", "bbox": [x, y, w, h], "contains": ["t1", "t2"]}
  ],
  "links": [
    {"id": "l1", "kind": "flow" | "hook" | "connector",
     "from": "t1", "to": "t2",              # gold: plain id
     "label": "to",                          # connector word, else omitted
     "caps": false, "underline": false,      # emphasis on the connector word
     "confidence": 0.8}
  ]
}

In predictions, "from"/"to" may also be ranked candidate lists for ambiguous
ends:  "to": [{"id": "t2", "confidence": 0.6}, {"id": "t3", "confidence": 0.3}]
The first entry is the top-1 answer; scoring also reports top-2 accuracy.

Element types: "text" (a word/phrase unit), "shape" (closed shape = hub/container),
"doodle" (illustration ink: kept for position, never read as text).
Underlines are an attribute of the text they mark, not separate elements.
Arrows are links, not elements.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

ELEMENT_TYPES = {"text", "shape", "doodle"}
LINK_KINDS = {"flow", "hook", "connector"}


@dataclass
class Element:
    id: str
    type: str
    bbox: tuple[float, float, float, float]  # normalized x, y, w, h
    text: str = ""
    underline: bool = False
    caps: bool = False
    contains: list[str] = field(default_factory=list)
    confidence: float | None = None


@dataclass
class Link:
    id: str
    kind: str
    src: list[tuple[str, float | None]]  # ranked candidates; gold has exactly one
    dst: list[tuple[str, float | None]]
    label: str = ""
    caps: bool = False
    underline: bool = False
    confidence: float | None = None


@dataclass
class Page:
    page_id: str
    elements: dict[str, Element]
    links: list[Link]


def _candidates(v) -> list[tuple[str, float | None]]:
    if isinstance(v, str):
        return [(v, None)]
    if isinstance(v, list):
        return [(c["id"], c.get("confidence")) for c in v]
    raise ValueError(f"bad link endpoint: {v!r}")


def load_page(path: str | Path) -> Page:
    return parse_page(json.loads(Path(path).read_text()), Path(path).stem)


def parse_page(raw: dict, default_id: str = "page") -> Page:
    pw, ph = raw["page_size"]
    elements = {}
    for e in raw.get("elements", []):
        x, y, w, h = e["bbox"]
        elements[e["id"]] = Element(
            id=e["id"],
            type=e["type"],
            bbox=(x / pw, y / ph, w / pw, h / ph),
            text=e.get("text", ""),
            underline=bool(e.get("underline", False)),
            caps=bool(e.get("caps", False)),
            contains=list(e.get("contains", [])),
            confidence=e.get("confidence"),
        )
    links = [
        Link(
            id=l.get("id", f"l{i}"),
            kind=l["kind"],
            src=_candidates(l["from"]),
            dst=_candidates(l["to"]),
            label=l.get("label", ""),
            caps=bool(l.get("caps", False)),
            underline=bool(l.get("underline", False)),
            confidence=l.get("confidence"),
        )
        for i, l in enumerate(raw.get("links", []))
    ]
    return Page(raw.get("page_id", default_id), elements, links)


def validate(page: Page, gold: bool) -> list[str]:
    """Return a list of problems; empty means the file is usable."""
    errs = []
    ids = page.elements
    for e in ids.values():
        if e.type not in ELEMENT_TYPES:
            errs.append(f"{e.id}: unknown type {e.type!r}")
        x, y, w, h = e.bbox
        if w <= 0 or h <= 0 or x < -0.01 or y < -0.01 or x + w > 1.01 or y + h > 1.01:
            errs.append(f"{e.id}: bbox outside page or empty")
        if e.type == "text" and not e.text.strip():
            errs.append(f"{e.id}: text element with no text")
        for c in e.contains:
            if c not in ids:
                errs.append(f"{e.id}: contains unknown id {c!r}")
    for l in page.links:
        if l.kind not in LINK_KINDS:
            errs.append(f"{l.id}: unknown kind {l.kind!r}")
        for end in (l.src, l.dst):
            if gold and len(end) != 1:
                errs.append(f"{l.id}: gold endpoints must be a single id")
            for cid, _ in end:
                if cid not in ids:
                    errs.append(f"{l.id}: endpoint {cid!r} not an element")
        if l.kind == "connector" and gold and not l.label:
            errs.append(f"{l.id}: connector link needs a label")
        if (l.caps or l.underline) and not l.label:
            errs.append(f"{l.id}: caps/underline set on a link with no label")
    return errs
