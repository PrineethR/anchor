"""Find the sheet in a photo and warp it to a flat A4 image.

Sheets printed from the template (anchor/template.py) are found by their
ArUco corner markers: any 3 of the 4 are enough, and the output is upright
whichever way the sheet faced the camera. --rot is ignored for them.

Unmarked pages fall back to the biggest bright quadrilateral on a darker
background. Orientation can't be inferred then, so pass --rot (quarter turns
clockwise) to make the text upright.

    python -m anchor.flatten photo.jpg out.jpg
    python -m anchor.flatten samples/page-01.jpg out.jpg --rot 3
"""

from __future__ import annotations

import argparse

import cv2
import numpy as np

from .template import CORNER_IDS, DICTIONARY, PAGE_MM, marker_corners_mm

PX_PER_MM = 4
A4 = (210, 297)  # portrait mm
MIN_MARKERS = 3

_detector = None


def find_markers(img: np.ndarray) -> dict[int, np.ndarray]:
    """{template marker id: its 4 corners in image coords}, for the template's markers that are visible."""
    global _detector
    if _detector is None:
        params = cv2.aruco.DetectorParameters()
        params.cornerRefinementMethod = cv2.aruco.CORNER_REFINE_SUBPIX
        _detector = cv2.aruco.ArucoDetector(cv2.aruco.getPredefinedDictionary(DICTIONARY), params)
    gray = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    corners, ids, _ = _detector.detectMarkers(gray)
    found = {}
    for c, mid in zip(corners, [] if ids is None else ids.ravel()):
        if int(mid) in CORNER_IDS.values() and int(mid) not in found:
            found[int(mid)] = c.reshape(4, 2)
    return found


def flatten_by_markers(img: np.ndarray, markers: dict[int, np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
    """Warp so every visible marker corner lands where the template prints it. Returns (flat, homography)."""
    ref = marker_corners_mm()
    ids = sorted(markers)
    src = np.concatenate([markers[i] for i in ids])
    dst = np.concatenate([ref[i] for i in ids]) * PX_PER_MM
    M, _ = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    size = (PAGE_MM[0] * PX_PER_MM, PAGE_MM[1] * PX_PER_MM)
    return cv2.warpPerspective(img, M, size), M


def find_sheet(img: np.ndarray) -> np.ndarray:
    """Return the 4 sheet corners as float32 [tl, tr, br, bl] in image coords."""
    # Paper is unsaturated; beige desks and leather are tinted. Brightness alone
    # fails because the sheet is unevenly lit (page-01's top end is in shadow),
    # so saturation does the separating and brightness only rejects black objects.
    hsv = cv2.cvtColor(cv2.GaussianBlur(img, (7, 7), 0), cv2.COLOR_BGR2HSV)
    mask = ((hsv[..., 2] > 140) & (hsv[..., 1] < 32)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((9, 9), np.uint8))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    c = max(contours, key=cv2.contourArea)
    quad = cv2.approxPolyDP(cv2.convexHull(c), 0.02 * cv2.arcLength(c, True), True)
    if len(quad) != 4:
        quad = cv2.boxPoints(cv2.minAreaRect(c))  # fall back to a rotated rectangle
    pts = quad.reshape(4, 2).astype(np.float32)
    s, d = pts.sum(1), np.diff(pts, axis=1).ravel()
    return np.array([pts[s.argmin()], pts[d.argmin()], pts[s.argmax()], pts[d.argmax()]], np.float32)


def flatten(img: np.ndarray, rot: int = 0) -> tuple[np.ndarray, np.ndarray, str]:
    """Warp to A4 at PX_PER_MM: by markers when at least MIN_MARKERS are visible,
    else by the sheet's edges and then `rot` quarter turns clockwise.

    Returns (flat image, 3x3 homography photo->flat-before-rotation, "markers" | "edges")."""
    markers = find_markers(img)
    if len(markers) >= MIN_MARKERS:
        return *flatten_by_markers(img, markers), "markers"
    corners = find_sheet(img)
    w_img = np.linalg.norm(corners[1] - corners[0])
    h_img = np.linalg.norm(corners[3] - corners[0])
    short, long_ = A4[0] * PX_PER_MM, A4[1] * PX_PER_MM
    W, H = (short, long_) if h_img >= w_img else (long_, short)
    dst = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], np.float32)
    M = cv2.getPerspectiveTransform(corners, dst)
    flat = cv2.warpPerspective(img, M, (W, H))
    for _ in range(rot % 4):
        flat = cv2.rotate(flat, cv2.ROTATE_90_CLOCKWISE)
    return flat, M, "edges"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--rot", type=int, default=0, help="unmarked pages only: quarter turns clockwise after warping")
    a = ap.parse_args()
    flat, _, how = flatten(cv2.imread(a.src), a.rot)
    cv2.imwrite(a.dst, flat)
    print(f"{a.dst}: {flat.shape[1]}x{flat.shape[0]} px ({PX_PER_MM} px/mm, by {how})")


if __name__ == "__main__":
    main()
