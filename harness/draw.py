"""Draw a page-structure JSON over its flattened image, to check labels or output.

    python -m harness.draw data/labeled/page-01.json data/labeled/page-01.jpg out.png

Text boxes: green (underlined), orange (CAPS), blue otherwise. Shapes: purple. Doodles: grey.
Links: red = flow, magenta = hook, teal = connector (with its label).
Ranked candidates beyond top-1 are drawn dashed-thin.
"""

from __future__ import annotations

import sys

import cv2

from .schema import load_page

KIND_COLOR = {"flow": (40, 40, 220), "hook": (200, 40, 200), "connector": (160, 140, 0)}


def draw(page_json: str, image: str):
    page = load_page(page_json)
    img = cv2.imread(image)
    H, W = img.shape[:2]
    px = lambda b: (int(b[0] * W), int(b[1] * H), int(b[2] * W), int(b[3] * H))
    centre = {}
    for e in page.elements.values():
        x, y, w, h = px(e.bbox)
        centre[e.id] = (x + w // 2, y + h // 2)
        if e.type == "shape":
            col = (160, 50, 120)
        elif e.type == "doodle":
            col = (130, 130, 130)
        else:
            col = (40, 160, 40) if e.underline else (0, 140, 255) if e.caps else (200, 120, 30)
        cv2.rectangle(img, (x, y), (x + w, y + h), col, 2)
        tag = e.id + (" [conf %.2f]" % e.confidence if e.confidence is not None else "")
        cv2.putText(img, tag, (x, max(10, y - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.38, col, 1, cv2.LINE_AA)
    for l in page.links:
        col = KIND_COLOR.get(l.kind, (0, 0, 0))
        for rank_s, (sid, _) in enumerate(l.src[:2]):
            for rank_d, (did, _) in enumerate(l.dst[:2]):
                if sid not in centre or did not in centre:
                    continue
                thick = 2 if rank_s == rank_d == 0 else 1
                cv2.arrowedLine(img, centre[sid], centre[did], col, thick, cv2.LINE_AA, tipLength=0.04)
        if l.label and l.src[0][0] in centre and l.dst[0][0] in centre:
            (ax, ay), (bx, by) = centre[l.src[0][0]], centre[l.dst[0][0]]
            tag = l.label + (" [C]" if l.caps else "") + (" [U]" if l.underline else "")
            cv2.putText(img, tag, ((ax + bx) // 2, (ay + by) // 2 - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, col, 2, cv2.LINE_AA)
    return img


if __name__ == "__main__":
    cv2.imwrite(sys.argv[3], draw(sys.argv[1], sys.argv[2]))
