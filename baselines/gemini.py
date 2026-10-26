"""Gemini-only baseline: one flattened page in, one prediction JSON out.

No pipeline at all. The whole flattened image goes to Gemini with a description
of the page format, and the answer is written to data/baselines/gemini in the harness
schema. Its scores tell us how much of the job a single model call already does,
so the pipeline work can target what it gets wrong.

    export GEMINI_API_KEY=...
    python -m baselines.gemini                  # every data/labeled/*.jpg
    python -m baselines.gemini --only page-01 --force
    python -m harness.run --pred data/baselines/gemini --out reports/gemini

Boxes come back in Gemini's native box_2d convention ([ymin, xmin, ymax, xmax]
on a 0-1000 grid), which it localizes best in, and are written with
page_size [1000, 1000]; the harness normalizes, so this matches gold in pixels.
Raw responses are kept in <out>/raw/ for reading misses. Stdlib only.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from harness.schema import load_page, validate

DEFAULT_MODEL = "gemini-2.5-pro"
API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GRID = 1000

GEN_CONFIG: dict = {}      # extra generationConfig for a run: {"thinkingConfig": {...}, "mediaResolution": "..."}, set by baselines.try_gemini
LAST_USAGE: dict = {}      # the token counts Google reported for the most recent request

PROMPT = """\
This is a photo of a handwritten concept map on a sheet of paper, already
flattened to the page. Turn it into structure.

ELEMENTS
- "text": one element per node you would put in a graph. A multi-word phrase
  that belongs together ("mindset of posture", "the idea of transitions") is ONE
  element, even across line breaks. Transcribe exactly as written; keep case.
  underline: true if any part of it is underlined.
  caps: true if it is written in capitals for emphasis (not just a capital first letter).
- "shape": a closed drawn shape (circle, box, blob) that acts as a hub or container.
  contains: ids of the elements inside it.
- "doodle": an illustration or stray drawing that is not words. Box it; never
  transcribe it as text. A drawn letter-like mark sitting next to a word may be a doodle.

LINKS (every arrow)
- from -> to in the direction the ARROWHEAD points. An arrow may point at a shape.
- kind:
  "flow": an ordinary arrow from concept to concept.
  "hook": a short curled arrow meaning "belongs to / elaborates".
  "connector": an arrow with a word or phrase written on or along it
     ("A --to--> B"). Put that word in label, set caps/underline on the link if
     the word has them, and do NOT also add the word as a text element.
- If an endpoint is ambiguous, put your second choice in from_alt / to_alt.
- confidence: 0-1, how sure you are of both endpoints.

Ignore anything that is not ink on the sheet (sticky notes, desk, objects).
box_2d is [ymin, xmin, ymax, xmax] on a 0-1000 grid over the whole image, tight
around the ink. Ids are short and unique, e.g. t1, s1, d1, l1.

ROTATION
- page_rotation: a phone photo may be sideways or upside down. Say how many degrees
  clockwise the photo would have to be turned for the writing to read upright, left
  to right: "0", "90", "180" or "270". Keep every box_2d exactly where the ink is in
  the photo as given; do not rotate the boxes yourself.
"""

_BOOL = {"type": "BOOLEAN"}
_STR = {"type": "STRING"}
RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "page_rotation": {"type": "STRING", "enum": ["0", "90", "180", "270"]},
        "elements": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "id": _STR,
                    "type": {"type": "STRING", "enum": ["text", "shape", "doodle"]},
                    "box_2d": {"type": "ARRAY", "items": {"type": "INTEGER"}},
                    "text": _STR,
                    "underline": _BOOL,
                    "caps": _BOOL,
                    "contains": {"type": "ARRAY", "items": _STR},
                },
                "required": ["id", "type", "box_2d"],
                "propertyOrdering": ["id", "type", "box_2d", "text", "underline", "caps", "contains"],
            },
        },
        "links": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "id": _STR,
                    "kind": {"type": "STRING", "enum": ["flow", "hook", "connector"]},
                    "from": _STR,
                    "to": _STR,
                    "from_alt": _STR,
                    "to_alt": _STR,
                    "label": _STR,
                    "caps": _BOOL,
                    "underline": _BOOL,
                    "confidence": {"type": "NUMBER"},
                },
                "required": ["id", "kind", "from", "to"],
                "propertyOrdering": ["id", "kind", "from", "to", "from_alt", "to_alt",
                                     "label", "caps", "underline", "confidence"],
            },
        },
    },
    "required": ["elements", "links"],
    "propertyOrdering": ["page_rotation", "elements", "links"],
}


def _image_part(image: Path) -> dict:
    return {"inline_data": {"mime_type": "image/jpeg", "data": base64.b64encode(image.read_bytes()).decode()}}


def build_body(image: Path, prompt: str = PROMPT, examples=()) -> dict:
    """The request for one page. `examples` are (image path, answer dict) pairs: pages this
    writer has already checked, shown first so the model reads the new page the same way.
    With none, the request is exactly the baseline's."""
    if examples:
        parts = [{"text": prompt + "\n\nHere are pages by the same writer that have already been checked. "
                                   "Each is followed by the correct answer."}]
        for img, answer in examples:
            parts += [_image_part(img), {"text": "Correct answer for the page above:\n" + json.dumps(answer)}]
        parts += [{"text": "Now read this page the same way."}, _image_part(image)]
    else:
        parts = [_image_part(image), {"text": prompt}]
    return {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": RESPONSE_SCHEMA,
            **GEN_CONFIG,
        },
    }


def call_gemini(image: Path, model: str, key: str, retries: int = 3, prompt: str = PROMPT, examples=()) -> str:
    """Return the model's JSON text for one page image."""
    return post(build_body(image, prompt, examples), model, key, retries)


def post(body: dict, model: str, key: str, retries: int = 3) -> str:
    """Send one generateContent request and return the text of the first answer."""
    req = urllib.request.Request(
        API.format(model=model),
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
    )
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                resp = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:500]
            if e.code in (429, 500, 503) and attempt < retries - 1:
                time.sleep(5 * 2 ** attempt)
                continue
            raise RuntimeError(f"Gemini HTTP {e.code}: {detail}") from None
    LAST_USAGE.clear()
    LAST_USAGE.update(resp.get("usageMetadata") or {})
    cands = resp.get("candidates") or []
    if not cands:
        raise RuntimeError(f"no candidates: {json.dumps(resp.get('promptFeedback', resp))[:500]}")
    return "".join(p.get("text", "") for p in cands[0].get("content", {}).get("parts", []))


def from_page(page: dict) -> dict:
    """The inverse of to_page: a page in the harness schema as Gemini's answer shape."""
    pw, ph = page["page_size"]
    g = lambda v, total: max(0, min(GRID, round(GRID * v / total)))
    elements = []
    for e in page["elements"]:
        x, y, w, h = e["bbox"]
        out = {"id": e["id"], "type": e["type"], "box_2d": [g(y, ph), g(x, pw), g(y + h, ph), g(x + w, pw)]}
        if e["type"] == "text":
            out.update(text=e["text"], underline=bool(e.get("underline")), caps=bool(e.get("caps")))
        if e["type"] == "shape":
            out["contains"] = list(e.get("contains", []))
        elements.append(out)
    links = []
    for l in page.get("links", []):
        out = {"id": l["id"], "kind": l["kind"]}
        for end in ("from", "to"):
            v = l[end]
            ids = [v] if isinstance(v, str) else [c["id"] for c in v]
            out[end] = ids[0]
            if len(ids) > 1:
                out[f"{end}_alt"] = ids[1]
        if l.get("label"):
            out.update(label=l["label"], caps=bool(l.get("caps")), underline=bool(l.get("underline")))
        links.append(out)
    return {"elements": elements, "links": links}


def _bbox(box_2d) -> list[int] | None:
    if not isinstance(box_2d, list) or len(box_2d) != 4:
        return None
    y0, x0, y1, x1 = (min(GRID, max(0, int(v))) for v in box_2d)
    y0, y1 = sorted((y0, y1))
    x0, x1 = sorted((x0, x1))
    return [x0, y0, max(1, x1 - x0), max(1, y1 - y0)]


def to_page(raw: dict, page_id: str) -> tuple[dict, list[str]]:
    """Convert Gemini's answer to the harness schema. Returns (page, notes on what was dropped)."""
    notes = []
    elements, seen = [], set()
    for e in raw.get("elements", []):
        bbox = _bbox(e.get("box_2d"))
        eid = str(e.get("id") or f"e{len(elements) + 1}")
        if bbox is None:
            notes.append(f"dropped element {eid}: bad box_2d {e.get('box_2d')!r}")
            continue
        if e.get("type") == "text" and not str(e.get("text", "")).strip():
            notes.append(f"dropped element {eid}: text with no text")
            continue
        while eid in seen:
            eid += "_"
        seen.add(eid)
        out = {"id": eid, "type": e["type"], "bbox": bbox}
        if e["type"] == "text":
            out.update(text=e["text"].strip(), underline=bool(e.get("underline")), caps=bool(e.get("caps")))
        if e["type"] == "shape":
            out["contains"] = list(e.get("contains") or [])
        elements.append(out)
    for out in elements:
        if "contains" in out:
            out["contains"] = [c for c in out["contains"] if c in seen and c != out["id"]]

    links = []
    for i, l in enumerate(raw.get("links", []), 1):
        lid = str(l.get("id") or f"l{i}")
        if l.get("from") not in seen or l.get("to") not in seen:
            notes.append(f"dropped link {lid}: endpoint {l.get('from')!r} -> {l.get('to')!r} is not an element")
            continue
        conf = l.get("confidence")
        link = {"id": lid, "kind": l["kind"]}
        for end in ("from", "to"):
            top, alt = l[end], l.get(f"{end}_alt")
            if alt in seen and alt != top:
                # Ranked candidates, so the harness can score top-2.
                link[end] = [{"id": top, "confidence": conf},
                             {"id": alt, "confidence": None if conf is None else round(1 - conf, 3)}]
            else:
                link[end] = top
        label = str(l.get("label") or "").strip()
        if label:
            link.update(label=label, caps=bool(l.get("caps")), underline=bool(l.get("underline")))
        if conf is not None:
            link["confidence"] = conf
        links.append(link)

    return {"page_id": page_id, "page_size": [GRID, GRID], "elements": elements, "links": links}, notes


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", default="data/labeled", help="dir of flattened page-NN.jpg")
    ap.add_argument("--out", default="data/baselines/gemini")
    ap.add_argument("--model", default=os.environ.get("GEMINI_MODEL", DEFAULT_MODEL))
    ap.add_argument("--only", nargs="*", help="page ids to run, e.g. page-01")
    ap.add_argument("--force", action="store_true", help="re-run pages that already have a prediction")
    a = ap.parse_args(argv)

    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        print("set GEMINI_API_KEY", file=sys.stderr)
        return 1

    images = sorted(Path(a.pages).glob("*.jpg"))
    if a.only:
        images = [p for p in images if p.stem in a.only]
    if not images:
        print(f"no page images in {a.pages}", file=sys.stderr)
        return 1

    out = Path(a.out)
    (out / "raw").mkdir(parents=True, exist_ok=True)
    failed = 0
    for img in images:
        dest = out / f"{img.stem}.json"
        if dest.exists() and not a.force:
            print(f"{img.stem}: exists, skipping (--force to re-run)")
            continue
        t0 = time.time()
        try:
            text = call_gemini(img, a.model, key)
            (out / "raw" / f"{img.stem}.json").write_text(text)
            page, notes = to_page(json.loads(text), img.stem)
        except (RuntimeError, json.JSONDecodeError, KeyError) as e:
            failed += 1
            print(f"{img.stem}: FAILED {e}", file=sys.stderr)
            continue
        dest.write_text(json.dumps(page, indent=2))
        for n in notes + validate(load_page(dest), gold=False):
            print(f"  {img.stem}: {n}", file=sys.stderr)
        print(f"{img.stem}: {len(page['elements'])} elements, {len(page['links'])} links "
              f"({time.time() - t0:.0f}s, {a.model})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
