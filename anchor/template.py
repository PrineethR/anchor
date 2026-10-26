"""The printable capture sheet: A4 landscape with an ArUco marker in each corner.

The markers give the page's position and orientation in any photo, so
flattening needs no edge finding and no --rot. Each corner has its own id, so a
sheet photographed upside down or sideways still comes out upright.

    python -m anchor.template                   # templates/anchor-a4.pdf
    python -m anchor.template --png out.png     # also a raster preview

Print at 100% ("actual size"). A scaled print still flattens correctly; the
page just comes out a few percent larger or smaller.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import cv2
import numpy as np

PAGE_MM = (297, 210)        # A4 landscape, width x height
MARKER_MM = 20              # printed side of each marker, black border included
MARGIN_MM = 10              # page edge to marker; clear of most printers' unprintable band
DICTIONARY = cv2.aruco.DICT_4X4_50
CELLS = 6                   # 4x4 data bits plus a 1-cell black border each side
CORNER_IDS = {"tl": 0, "tr": 1, "br": 2, "bl": 3}


def marker_origin_mm(corner: str) -> tuple[float, float]:
    """Top-left of the marker at `corner`, in page mm from the top-left."""
    W, H = PAGE_MM
    x = MARGIN_MM if corner in ("tl", "bl") else W - MARGIN_MM - MARKER_MM
    y = MARGIN_MM if corner in ("tl", "tr") else H - MARGIN_MM - MARKER_MM
    return x, y


def marker_corners_mm() -> dict[int, np.ndarray]:
    """{marker id: its 4 corners in page mm}, in ArUco's order (tl, tr, br, bl of the upright marker)."""
    out = {}
    for corner, mid in CORNER_IDS.items():
        x, y = marker_origin_mm(corner)
        s = MARKER_MM
        out[mid] = np.array([[x, y], [x + s, y], [x + s, y + s], [x, y + s]], np.float32)
    return out


def marker_bits(mid: int) -> np.ndarray:
    """CELLS x CELLS bool array, True = black."""
    d = cv2.aruco.getPredefinedDictionary(DICTIONARY)
    return cv2.aruco.generateImageMarker(d, mid, CELLS, borderBits=1) == 0


def render(px_per_mm: float) -> np.ndarray:
    """The template as a BGR image, white page with black markers."""
    W, H = PAGE_MM
    img = np.full((round(H * px_per_mm), round(W * px_per_mm), 3), 255, np.uint8)
    for corner, mid in CORNER_IDS.items():
        x, y = marker_origin_mm(corner)
        side = round(MARKER_MM * px_per_mm)
        tile = cv2.resize(marker_bits(mid).astype(np.uint8), (side, side), interpolation=cv2.INTER_NEAREST)
        x0, y0 = round(x * px_per_mm), round(y * px_per_mm)
        img[y0:y0 + side, x0:x0 + side][tile == 1] = 0
    return img


def pdf_bytes() -> bytes:
    """A one-page vector PDF of the template, sized exactly A4 landscape."""
    pt = 72 / 25.4
    W, H = PAGE_MM
    cell = MARKER_MM / CELLS
    ops = ["0 g"]
    for corner, mid in CORNER_IDS.items():
        x0, y0 = marker_origin_mm(corner)
        for r, row in enumerate(marker_bits(mid)):
            c = 0
            while c < CELLS:  # one rectangle per horizontal run of black cells
                if not row[c]:
                    c += 1
                    continue
                start = c
                while c < CELLS and row[c]:
                    c += 1
                x, y = x0 + start * cell, y0 + r * cell
                # PDF's origin is bottom-left; overlap rows slightly so no seam shows.
                ops.append(f"{x * pt:.3f} {(H - y - cell) * pt - 0.05:.3f} {(c - start) * cell * pt:.3f} {cell * pt + 0.1:.3f} re")
    ops.append("f")
    content = "\n".join(ops).encode()

    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W * pt:.3f} {H * pt:.3f}] /Contents 4 0 R >>".encode(),
        b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    out += b"".join(b"%010d 00000 n \n" % o for o in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="templates/anchor-a4.pdf")
    ap.add_argument("--png", help="also write a raster preview here")
    a = ap.parse_args()
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(pdf_bytes())
    print(f"{out}: A4 landscape, {MARKER_MM} mm markers {CORNER_IDS}, print at 100%")
    if a.png:
        cv2.imwrite(a.png, render(4))
        print(a.png)


if __name__ == "__main__":
    main()
