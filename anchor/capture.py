"""Grab frames from a camera and save flattened stills of the page.

Sources:
  --camera N   a camera OpenCV can open. 0 is usually the built-in one; an iPhone
               on Continuity Camera shows up as another index (`probe` lists them).
  --url URL    a still-image endpoint, e.g. an ESP32-S3 running the esp32
               CameraWebServer example: http://<board-ip>/capture

    python -m anchor.capture probe
    python -m anchor.capture snap --camera 1
    python -m anchor.capture watch --url http://192.168.1.50/capture

`watch` saves a still each time the page settles (nothing moving for --settle
seconds) with new ink on it. It skips a settle while a hand or object is still on
the sheet, or when fewer than 3 markers are visible. Each capture goes to
captures/<session>/ as NNN.jpg (flattened), NNN.raw.jpg (camera frame) and
NNN.new.png (white = ink added since the previous capture).

Needs the printed template (python -m anchor.template). On macOS the terminal
running this needs camera access the first time.
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from .flatten import MIN_MARKERS, PX_PER_MM, find_markers, flatten, flatten_by_markers
from .template import MARKER_MM, marker_origin_mm

MOTION_WIDTH = 320      # px; motion is judged on a small blurred copy of the frame
MOTION_DELTA = 20       # grey levels a pixel must change by to count as moving
MOTION_FRAC = 0.002     # fraction of moving pixels that means "something is moving"
MIN_NEW_INK = 150       # new ink pixels (flattened, 4 px/mm) for a settle to be worth saving
OBJECT_MIN_MM2 = 150    # a dark or coloured blob this big after removing pen strokes is a hand/object
STROKE_MM = 2           # strokes thinner than this are ink, not objects
EDGE_MM = 4             # ignore this band at the sheet edge, where desk can show past a curled page


class Camera:
    def __init__(self, index: int, size: tuple[int, int] | None):
        self.cap = cv2.VideoCapture(index, cv2.CAP_AVFOUNDATION if sys.platform == "darwin" else cv2.CAP_ANY)
        if size:
            self.cap.set(cv2.CAP_PROP_FRAME_WIDTH, size[0])
            self.cap.set(cv2.CAP_PROP_FRAME_HEIGHT, size[1])
        if not self.cap.isOpened():
            raise SystemExit(f"camera {index} did not open (try `probe`, and check camera access for this terminal)")

    def read(self) -> np.ndarray | None:
        ok, frame = self.cap.read()
        return frame if ok else None

    def close(self):
        self.cap.release()


class StillURL:
    """Fetches one JPEG per read, e.g. from an ESP32 camera's /capture endpoint."""

    def __init__(self, url: str):
        self.url, self.failing = url, False

    def read(self) -> np.ndarray | None:
        try:
            with urllib.request.urlopen(self.url, timeout=10) as r:
                frame = cv2.imdecode(np.frombuffer(r.read(), np.uint8), cv2.IMREAD_COLOR)
            self.failing = False
            return frame
        except OSError as e:
            if not self.failing:
                print(f"camera at {self.url} not answering: {e}", file=sys.stderr)
            self.failing = True
            time.sleep(1)
            return None

    def close(self):
        pass


def _ignore_mask(shape) -> np.ndarray:
    """True over the printed markers (plus a little margin) and the sheet's edge band in a flattened page."""
    mask = np.zeros(shape[:2], bool)
    e = EDGE_MM * PX_PER_MM
    mask[:e], mask[-e:], mask[:, :e], mask[:, -e:] = True, True, True, True
    pad = 2
    for corner in ("tl", "tr", "br", "bl"):
        x, y = marker_origin_mm(corner)
        x0, y0 = int((x - pad) * PX_PER_MM), int((y - pad) * PX_PER_MM)
        side = int((MARKER_MM + 2 * pad) * PX_PER_MM)
        mask[max(0, y0):y0 + side, max(0, x0):x0 + side] = True
    return mask


def ink_mask(flat: np.ndarray) -> np.ndarray:
    """Pen ink in a flattened page as a uint8 mask (255 = ink), markers and edge band excluded."""
    gray = cv2.cvtColor(flat, cv2.COLOR_BGR2GRAY)
    ink = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    ink[_ignore_mask(flat.shape)] = 0
    return ink


def object_on_page(flat: np.ndarray) -> bool:
    """A hand, pen or other object lying on the sheet: a large dark or coloured blob, not thin strokes."""
    hsv = cv2.cvtColor(flat, cv2.COLOR_BGR2HSV)
    blob = (((hsv[..., 1] > 60) | (hsv[..., 2] < 90)) & ~_ignore_mask(flat.shape)).astype(np.uint8)
    k = STROKE_MM * PX_PER_MM + 1
    blob = cv2.morphologyEx(blob, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    n, _, stats, _ = cv2.connectedComponentsWithStats(blob)
    return n > 1 and stats[1:, cv2.CC_STAT_AREA].max() >= OBJECT_MIN_MM2 * PX_PER_MM ** 2


class Watcher:
    """Feed it frames; it reports once per settle whether the page is worth capturing.

    feed() returns None while things move or after the current settle was handled,
    else a dict: {"action": "capture", "flat", "new_ink", "new_px"} or {"action": "skip", "reason"}.
    """

    def __init__(self, settle_s: float = 1.5):
        self.settle_s = settle_s
        self.prev_small = None
        self.still_since = None
        self.handled = False
        self.last_ink = None

    def _moving(self, frame: np.ndarray) -> bool:
        h, w = frame.shape[:2]
        small = cv2.resize(frame, (MOTION_WIDTH, max(1, round(h * MOTION_WIDTH / w))), interpolation=cv2.INTER_AREA)
        small = cv2.GaussianBlur(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), (5, 5), 0)
        moving = self.prev_small is None or (cv2.absdiff(small, self.prev_small) > MOTION_DELTA).mean() > MOTION_FRAC
        self.prev_small = small
        return moving

    def feed(self, frame: np.ndarray, t: float) -> dict | None:
        if self._moving(frame):
            self.still_since, self.handled = None, False
            return None
        if self.still_since is None:
            self.still_since = t
        if self.handled or t - self.still_since < self.settle_s:
            return None
        self.handled = True

        markers = find_markers(frame)
        if len(markers) < MIN_MARKERS:
            return {"action": "skip", "reason": f"only {len(markers)} markers visible"}
        flat, _ = flatten_by_markers(frame, markers)
        if object_on_page(flat):
            return {"action": "skip", "reason": "hand or object on the page"}
        ink = ink_mask(flat)
        if self.last_ink is None:
            new = ink
        else:
            new = cv2.bitwise_and(ink, cv2.bitwise_not(cv2.dilate(self.last_ink, np.ones((5, 5), np.uint8))))
        new_px = int(np.count_nonzero(new))
        if self.last_ink is not None and new_px < MIN_NEW_INK:
            return {"action": "skip", "reason": f"no new ink ({new_px} px)"}
        self.last_ink = ink
        return {"action": "capture", "flat": flat, "new_ink": new, "new_px": new_px}


def open_source(a) -> Camera | StillURL:
    if a.url:
        return StillURL(a.url)
    size = tuple(int(v) for v in a.size.split("x")) if a.size else None
    return Camera(a.camera, size)


def ink_box_mm(mask: np.ndarray) -> str:
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return "-"
    x0, y0, x1, y1 = (v / PX_PER_MM for v in (xs.min(), ys.min(), xs.max(), ys.max()))
    return f"x {x0:.0f}-{x1:.0f} mm, y {y0:.0f}-{y1:.0f} mm"


def cmd_probe(_a) -> int:
    found = 0
    for i in range(6):
        cap = cv2.VideoCapture(i, cv2.CAP_AVFOUNDATION if sys.platform == "darwin" else cv2.CAP_ANY)
        ok, frame = cap.read() if cap.isOpened() else (False, None)
        cap.release()
        if ok:
            found += 1
            print(f"camera {i}: {frame.shape[1]}x{frame.shape[0]}")
    if not found:
        print("no cameras opened (check camera access for this terminal)")
    return 0 if found else 1


def cmd_snap(a) -> int:
    src = open_source(a)
    frame = None
    # Let exposure and focus settle and drain stale buffered frames. A still
    # endpoint only needs a second fetch: an ESP32 may hand back a buffered old frame first.
    for _ in range(2 if a.url else a.warmup):
        f = src.read()
        if f is not None:
            frame = f
    src.close()
    if frame is None:
        print("no frame from camera", file=sys.stderr)
        return 1
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    stem = out / datetime.now().strftime("snap-%Y%m%d-%H%M%S")
    cv2.imwrite(f"{stem}.raw.jpg", frame)
    markers = find_markers(frame)
    if len(markers) < MIN_MARKERS and not a.allow_edges:
        print(f"{stem}.raw.jpg: only {len(markers)} markers visible, not flattened (--allow-edges to try the sheet's edges)")
        return 1
    flat, _, how = flatten(frame)
    cv2.imwrite(f"{stem}.jpg", flat, [cv2.IMWRITE_JPEG_QUALITY, 95])
    print(f"{stem}.jpg: {frame.shape[1]}x{frame.shape[0]} frame, {len(markers)} markers, flattened by {how}")
    return 0


def cmd_watch(a) -> int:
    src = open_source(a)
    out = Path(a.out) / datetime.now().strftime("%Y-%m-%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    w = Watcher(a.settle)
    n = 0
    print(f"watching; captures go to {out}/  (ctrl-C to stop)")
    try:
        while True:
            frame = src.read()
            if frame is None:
                continue
            ev = w.feed(frame, time.monotonic())
            if ev is None:
                continue
            stamp = datetime.now().strftime("%H:%M:%S")
            if ev["action"] == "skip":
                print(f"{stamp}  settled, not saved: {ev['reason']}")
                continue
            stem = out / f"{n:03d}"
            cv2.imwrite(f"{stem}.jpg", ev["flat"], [cv2.IMWRITE_JPEG_QUALITY, 95])
            cv2.imwrite(f"{stem}.raw.jpg", frame)
            cv2.imwrite(f"{stem}.new.png", ev["new_ink"])
            print(f"{stamp}  {stem.name}: {ev['new_px']} new ink px, {ink_box_mm(ev['new_ink'])}")
            n += 1
    except KeyboardInterrupt:
        print(f"\n{n} captures in {out}")
    finally:
        src.close()
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe", help="list cameras OpenCV can open")
    for name, helptext in (("snap", "save one flattened still"), ("watch", "save a still each time the page settles")):
        p = sub.add_parser(name, help=helptext)
        src = p.add_mutually_exclusive_group()
        src.add_argument("--camera", type=int, default=0)
        src.add_argument("--url", help="still-image endpoint, e.g. http://<esp32-ip>/capture")
        p.add_argument("--size", default="1920x1080", help="requested camera resolution (cameras pick the nearest)")
        p.add_argument("--out", default="captures")
        if name == "snap":
            p.add_argument("--warmup", type=int, default=15, help="frames to read before keeping one")
            p.add_argument("--allow-edges", action="store_true", help="flatten by the sheet's edges if markers are hidden")
        else:
            p.add_argument("--settle", type=float, default=1.5, help="seconds without motion that count as settled")
    a = ap.parse_args(argv)
    return {"probe": cmd_probe, "snap": cmd_snap, "watch": cmd_watch}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
