"""Photo in, page structure out: Anchor's engine as the make-sense app uses it.

  1. `make_flat`  find the page in the photo (markers, else the sheet's edges, else the whole
                  photo), shrink it, and turn it upright by trying the four quarter turns
                  through local OCR and keeping the one that reads the most text
  2. `read`       Gemini when GEMINI_API_KEY is set (with your checked pages as examples and
                  a paragraph about how you write), else local Apple Vision: text only, no arrows

No recognizer is new here: both readers are the baselines, so their scores in reports/ still
describe what this reads like. What this adds is the photo handling around them. Needs OpenCV.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

from anchor.flatten import MIN_MARKERS, find_markers, find_sheet, flatten_by_markers
from baselines import gemini, vision

MAX_SIDE = 2400     # longest side of the working image, px
MIN_SHEET = 0.4     # a detected sheet smaller than this share of the photo is probably not the page


class EngineError(RuntimeError):
    pass


def decode(data: bytes) -> np.ndarray:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None and shutil.which("sips"):  # HEIC and other formats OpenCV can't open (macOS)
        with tempfile.TemporaryDirectory() as d:
            src, dst = Path(d, "in"), Path(d, "out.jpg")
            src.write_bytes(data)
            subprocess.run(["sips", "-s", "format", "jpeg", str(src), "--out", str(dst)], capture_output=True)
            if dst.exists():
                img = cv2.imread(str(dst))
    if img is None:
        raise EngineError("That file isn't a photo this app can open. Try a JPG or PNG.")
    return img


def shrink(img: np.ndarray, side: int = MAX_SIDE) -> np.ndarray:
    s = side / max(img.shape[:2])
    return cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else img


def turn(img: np.ndarray, quarters: int) -> np.ndarray:
    for _ in range(quarters % 4):
        img = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    return img


def prepare(img: np.ndarray, crop: bool = True) -> tuple[np.ndarray, str]:
    """The page cut out of the photo, and how: "markers", "edges" or "whole photo"."""
    img = shrink(img)
    markers = find_markers(img)
    if len(markers) >= MIN_MARKERS:
        return flatten_by_markers(img, markers)[0], "markers"
    if not crop:
        return img, "whole photo"
    try:
        q = find_sheet(img)
    except (ValueError, cv2.error):
        return img, "whole photo"
    tl, tr, br, bl = q
    w = int(max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl)))
    h = int(max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr)))
    share = cv2.contourArea(q) / (img.shape[0] * img.shape[1])
    if share < MIN_SHEET or min(w, h) < 300 or not 0.4 < w / h < 2.5:
        return img, "whole photo"
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float32)
    return cv2.warpPerspective(img, cv2.getPerspectiveTransform(q, dst), (w, h)), "edges"


def vision_ready() -> bool:
    return sys.platform == "darwin" and (vision.BINARY.exists() or shutil.which("swiftc") is not None)


def _chars(raw: dict) -> int:
    return sum(c.isalnum() for line in raw["lines"] for c in line["text"])


def _wide_chars(raw: dict) -> int:
    """Characters in lines whose box is wider than tall: text running left to right in this frame."""
    return sum(len(l["text"]) for l in raw["lines"] if l["box"][2] >= l["box"][3])


def orient(img: np.ndarray) -> tuple[int, dict, bool]:
    """(quarter turns clockwise to try, the OCR of the image so turned, sure).

    Vision reads text at any angle but reports each line's box in the image's own frame, so
    lines that come back wider than tall are running along the page. That tells sideways from
    along-the-page. It cannot tell upright from upside down: those read the same. So when the
    photo is sideways the two turns that fix it are a coin flip, and `sure` is False."""
    vision.ensure_binary()

    def ocr_at(n: int) -> dict:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d, "page.jpg")
            cv2.imwrite(str(p), turn(img, n))
            return vision.ocr(p)

    with ThreadPoolExecutor(4) as ex:
        raws = list(ex.map(ocr_at, range(4)))
    top = max(_wide_chars(r) for r in raws)
    along = [n for n in range(4) if _wide_chars(raws[n]) >= 0.8 * top] or [0]
    if 0 in along:
        return 0, raws[0], True
    best = max(along, key=lambda n: _chars(raws[n]))
    return best, raws[best], len(along) == 1


def make_flat(data: bytes, flat: Path, crop: bool = True) -> dict:
    """Write the upright page to `flat`. Returns {"how", "turns", "sure", "ocr"}; ocr is the
    reading made while orienting (reused by `read`), or None."""
    page, how = prepare(decode(data), crop)
    turns, raw, sure = 0, None, True
    if how != "markers" and vision_ready():  # markers already fix orientation
        turns, raw, sure = orient(page)
    cv2.imwrite(str(flat), turn(page, turns), [cv2.IMWRITE_JPEG_QUALITY, 92])
    return {"how": how, "turns": turns, "sure": sure, "ocr": raw}


def rotate_flat(flat: Path) -> None:
    cv2.imwrite(str(flat), turn(cv2.imread(str(flat)), 1), [cv2.IMWRITE_JPEG_QUALITY, 92])


def gemini_key() -> str | None:
    return os.environ.get("GEMINI_API_KEY") or None


def gemini_model() -> str:
    return os.environ.get("GEMINI_MODEL", gemini.DEFAULT_MODEL)


def read(flat: Path, page_id: str, profile, *, ocr: dict | None = None, examples=()) -> tuple[dict, str, list[str]]:
    """(page in the harness schema, "gemini" | "vision", notes to show the user)."""
    notes: list[str] = []
    key = gemini_key()
    if key:
        try:
            text = gemini.call_gemini(flat, gemini_model(), key, prompt=gemini.PROMPT + "\n" + profile.hints(),
                                      examples=examples)
            page, dropped = gemini.to_page(json.loads(text), page_id)
            return to_pixels(page, flat), "gemini", dropped
        except (RuntimeError, ValueError, KeyError, OSError) as e:
            notes.append(f"Gemini didn't answer ({e}), so Apple Vision read the page instead.")
    if not vision_ready():
        raise EngineError("No reader is set up. Add a GEMINI_API_KEY and restart, or run this on a Mac with the Xcode command line tools.")
    try:
        raw = ocr or vision.ocr(flat)
    except (subprocess.CalledProcessError, OSError, ValueError) as e:
        raise EngineError(f"Apple Vision couldn't read the page ({e}).") from None
    groups = vision.merge_stacked(vision.split_arrows(raw["lines"]))
    return vision.to_page(groups, page_id, (raw["width"], raw["height"])), "vision", notes


def to_pixels(page: dict, flat: Path) -> dict:
    """Gemini's boxes are on a 1000x1000 grid whatever the image's shape; the app needs the
    page's real aspect, so rescale to the pixels of the image that was read."""
    h, w = cv2.imread(str(flat)).shape[:2]
    sx, sy = w / page["page_size"][0], h / page["page_size"][1]
    for e in page["elements"]:
        x, y, bw, bh = e["bbox"]
        e["bbox"] = [round(x * sx, 1), round(y * sy, 1), round(bw * sx, 1), round(bh * sy, 1)]
    page["page_size"] = [w, h]
    return page


def pick_examples(notes_dir: Path, labeled_dir: Path, n: int = 1) -> list[tuple[Path, dict]]:
    """Up to n checked pages, as (image, answer) pairs for Gemini: your newest confirmed notes
    first, then your hand-labeled pages."""
    out: list[tuple[Path, dict]] = []
    for m in sorted(notes_dir.glob("*/meta.json"), reverse=True):
        if len(out) >= n:
            return out
        if json.loads(m.read_text()).get("confirmed") and (m.parent / "flat.jpg").exists():
            out.append((m.parent / "flat.jpg", gemini.from_page(json.loads((m.parent / "page.json").read_text()))))
    for j in sorted(labeled_dir.glob("*.json")):
        if len(out) >= n:
            break
        if j.with_suffix(".jpg").exists():
            out.append((j.with_suffix(".jpg"), gemini.from_page(json.loads(j.read_text()))))
    return out
