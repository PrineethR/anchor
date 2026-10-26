"""Local OCR baseline: Apple Vision text recognition, text elements only.

Answers "how good is the text reading before any arrow work". No links, no
shapes, no doodles, no underline. Small steps on top of raw OCR, each generic
rather than tuned to a page except the shorthand table:

  1. strip arrow / bullet glyphs Vision reads from arrow ink, and split a line
     where it read an arrow between two words ("CRITQUE -> 7 trantition")
  2. merge lines stacked under each other into one phrase element, since gold
     labels one element per node and nodes wrap across lines (--no-merge: off)
  3. caps: true when every letter is uppercase (at least two letters)
  4. expand the author's shorthand: a lone "7" is the curl they write for "of"
     (--no-shorthand: off)

    python -m baselines.vision                  # every data/labeled/*.jpg
    python -m harness.run --pred data/baselines/vision --out reports/vision

The Swift helper (baselines/vision_ocr.swift) is compiled to build/vision-ocr on
first use. Needs macOS with Xcode command line tools.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

from harness.schema import load_page, validate

ROOT = Path(__file__).resolve().parent.parent
SWIFT_SRC = Path(__file__).with_name("vision_ocr.swift")
BINARY = ROOT / "build" / "vision-ocr"
ARROW = re.compile(r"\s*(?:→|->|—>|–>|=>|⟶)\s*")
EDGE_JUNK = "→•·*-–—>=⟶ "

# Whole-word readings of the author's handwritten shorthand. Only a lone token
# matches, so "7," or "17" are left alone.
SHORTHAND = {"7": "of"}

# Stacking rule, in units of the smaller line height.
MIN_DROP = 0.5   # lower line's centre must be at least this far below the upper's
MAX_GAP = 0.8    # and its top at most this far below the upper's bottom
X_SLACK = 0.5    # its x-centre may sit this far outside the group's span


def ensure_binary() -> Path:
    if not BINARY.exists() or BINARY.stat().st_mtime < SWIFT_SRC.stat().st_mtime:
        BINARY.parent.mkdir(exist_ok=True)
        subprocess.run(["swiftc", "-O", str(SWIFT_SRC), "-o", str(BINARY)], check=True)
    return BINARY


def ocr(image: Path, correction: bool = True) -> dict:
    """{"width", "height", "lines": [{"text", "confidence", "box": [x, y, w, h] in px, top-left origin}]}."""
    cmd = [str(ensure_binary()), str(image)] + ([] if correction else ["--no-correction"])
    return json.loads(subprocess.run(cmd, check=True, capture_output=True, text=True).stdout)


def split_arrows(lines: list[dict]) -> list[dict]:
    """Split lines at arrow glyphs and trim glyphs at the ends; drop pieces with no letters or digits.

    A split piece gets the slice of the line's box proportional to its character span.
    """
    out = []
    for ln in lines:
        text, (x, y, w, h) = ln["text"], ln["box"]
        pos = 0
        for part in ARROW.split(text):
            start = text.index(part, pos) if part else pos
            pos = start + len(part)
            clean = part.strip(EDGE_JUNK)
            if not any(c.isalnum() for c in clean):
                continue
            a = start + part.index(clean)
            b = a + len(clean)
            out.append({"text": clean, "confidence": ln["confidence"],
                         "box": [x + w * a / len(text), y, w * (b - a) / len(text), h]})
    return out


def _stacks_under(upper: dict, span: tuple[float, float], lower: dict) -> float | None:
    """Return the vertical gap if `lower` reads as the next line of a group ending in `upper`, else None."""
    ux, uy, uw, uh = upper["box"]
    lx, ly, lw, lh = lower["box"]
    h = min(uh, lh)
    gap = ly - (uy + uh)
    if (ly + lh / 2) - (uy + uh / 2) < MIN_DROP * h or gap > MAX_GAP * h:
        return None
    cx = lx + lw / 2
    if not span[0] - X_SLACK * lh <= cx <= span[1] + X_SLACK * lh:
        return None
    return gap


def merge_stacked(lines: list[dict]) -> list[list[dict]]:
    """Group lines that sit directly under each other into phrases, top to bottom."""
    groups: list[list[dict]] = []
    for ln in sorted(lines, key=lambda l: l["box"][1]):
        best, best_gap = None, None
        for g in groups:
            span = (min(l["box"][0] for l in g), max(l["box"][0] + l["box"][2] for l in g))
            gap = _stacks_under(g[-1], span, ln)
            if gap is not None and (best_gap is None or gap < best_gap):
                best, best_gap = g, gap
        if best is None:
            groups.append([ln])
        else:
            best.append(ln)
    return groups


def expand_shorthand(lines: list[dict]) -> list[dict]:
    return [dict(l, text=" ".join(SHORTHAND.get(w, w) for w in l["text"].split())) for l in lines]


def is_caps(text: str) -> bool:
    letters = [c for c in text if c.isalpha()]
    return len(letters) >= 2 and all(c.isupper() for c in letters)


def to_page(groups: list[list[dict]], page_id: str, size: tuple[float, float]) -> dict:
    elements = []
    for i, g in enumerate(groups, 1):
        x0 = min(l["box"][0] for l in g)
        y0 = min(l["box"][1] for l in g)
        x1 = max(l["box"][0] + l["box"][2] for l in g)
        y1 = max(l["box"][1] + l["box"][3] for l in g)
        text = " ".join(l["text"] for l in g)
        elements.append({
            "id": f"t{i}", "type": "text",
            "bbox": [round(v, 1) for v in (x0, y0, x1 - x0, y1 - y0)],
            "text": text, "caps": is_caps(text),
            "confidence": round(min(l["confidence"] for l in g), 3),
        })
    return {"page_id": page_id, "page_size": list(size), "elements": elements, "links": []}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pages", default="data/labeled", help="dir of flattened page-NN.jpg")
    ap.add_argument("--out", default="data/baselines/vision")
    ap.add_argument("--only", nargs="*", help="page ids to run, e.g. page-01")
    ap.add_argument("--no-merge", action="store_true", help="one element per Vision line")
    ap.add_argument("--no-correction", action="store_true", help="turn off Vision's language correction")
    ap.add_argument("--no-shorthand", action="store_true", help="don't expand shorthand (7 -> of)")
    a = ap.parse_args(argv)

    images = sorted(Path(a.pages).glob("*.jpg"))
    if a.only:
        images = [p for p in images if p.stem in a.only]
    if not images:
        print(f"no page images in {a.pages}", file=sys.stderr)
        return 1

    out = Path(a.out)
    (out / "raw").mkdir(parents=True, exist_ok=True)
    for img in images:
        raw = ocr(img, correction=not a.no_correction)
        (out / "raw" / f"{img.stem}.json").write_text(json.dumps(raw, indent=1))
        lines = raw["lines"]
        pieces = split_arrows(lines)
        if not a.no_shorthand:
            pieces = expand_shorthand(pieces)
        groups = [[p] for p in pieces] if a.no_merge else merge_stacked(pieces)
        dest = out / f"{img.stem}.json"
        dest.write_text(json.dumps(to_page(groups, img.stem, (raw["width"], raw["height"])), indent=2))
        for e in validate(load_page(dest), gold=False):
            print(f"  {img.stem}: {e}", file=sys.stderr)
        print(f"{img.stem}: {len(lines)} lines -> {len(groups)} text elements")
    return 0


if __name__ == "__main__":
    sys.exit(main())
