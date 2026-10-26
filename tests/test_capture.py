"""Marker flattening and the settle watcher, on synthetic photos of the template."""

import unittest

import cv2
import numpy as np

from anchor.capture import Watcher, ink_mask, object_on_page
from anchor.flatten import PX_PER_MM, find_markers, flatten
from anchor.template import PAGE_MM, pdf_bytes, render

SRC_PX_PER_MM = 6
PHOTO = (1600, 1200)
# Where the sheet's corners land in the photo: tilted, perspective, not filling the frame.
SHEET_IN_PHOTO = np.float32([[180, 160], [1450, 110], [1500, 1050], [130, 1000]])


def sheet(ink_boxes_mm=()):
    """The template at SRC_PX_PER_MM with filled ink squares at (x, y, side) mm."""
    img = render(SRC_PX_PER_MM)
    for x, y, s in ink_boxes_mm:
        p = SRC_PX_PER_MM
        cv2.rectangle(img, (int(x * p), int(y * p)), (int((x + s) * p), int((y + s) * p)), (40, 40, 40), 2)
    return img


def photo(page, upside_down=False, hand_at=None, cover=None, noise_seed=0):
    """Place the sheet on a desk with perspective; optionally a hand blob, or a patch over one corner."""
    if upside_down:
        page = cv2.rotate(page, cv2.ROTATE_180)
    h, w = page.shape[:2]
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), SHEET_IN_PHOTO)
    out = cv2.warpPerspective(page, M, PHOTO, borderValue=(70, 95, 120))
    if hand_at is not None:
        cv2.ellipse(out, hand_at, (160, 90), 20, 0, 360, (120, 150, 210), -1)  # skin-ish BGR
    if cover is not None:
        cv2.rectangle(out, cover[0], cover[1], (70, 95, 120), -1)
    noise = np.random.default_rng(noise_seed).normal(0, 2, out.shape)
    return np.clip(out + noise, 0, 255).astype(np.uint8)


def ink_centre_mm(flat, near_mm, r_mm=20):
    """Centre of the ink within r_mm of near_mm (other ink, like a covering patch, is ignored)."""
    ys, xs = np.nonzero(ink_mask(flat))
    keep = np.hypot(xs / PX_PER_MM - near_mm[0], ys / PX_PER_MM - near_mm[1]) < r_mm
    return xs[keep].mean() / PX_PER_MM, ys[keep].mean() / PX_PER_MM


class TemplateTests(unittest.TestCase):
    def test_pdf_is_a4_landscape(self):
        pdf = pdf_bytes()
        self.assertTrue(pdf.startswith(b"%PDF-1.4") and pdf.rstrip().endswith(b"%%EOF"))
        self.assertIn(b"/MediaBox [0 0 841.890 595.276]", pdf)

    def test_render_has_all_four_markers(self):
        self.assertEqual(sorted(find_markers(render(4))), [0, 1, 2, 3])


class FlattenTests(unittest.TestCase):
    def check(self, img, n_markers):
        self.assertEqual(len(find_markers(img)), n_markers)
        flat, _, how = flatten(img)
        self.assertEqual(how, "markers")
        self.assertEqual(flat.shape[:2], (PAGE_MM[1] * PX_PER_MM, PAGE_MM[0] * PX_PER_MM))
        x, y = ink_centre_mm(flat, (155, 85))
        self.assertAlmostEqual(x, 155, delta=1.0)  # square at (150, 80) mm, side 10
        self.assertAlmostEqual(y, 85, delta=1.0)

    def test_perspective_photo(self):
        self.check(photo(sheet([(150, 80, 10)])), 4)

    def test_upside_down_sheet_comes_out_upright(self):
        self.check(photo(sheet([(150, 80, 10)]), upside_down=True), 4)

    def test_three_markers_are_enough(self):
        self.check(photo(sheet([(150, 80, 10)]), cover=((1350, 950), (1600, 1200))), 3)


class WatcherTests(unittest.TestCase):
    def run_frames(self, w, frames, t0, dt=0.1):
        events = [w.feed(f, t0 + i * dt) for i, f in enumerate(frames)]
        return [e for e in events if e is not None], t0 + len(frames) * dt

    def test_capture_cycle(self):
        w = Watcher(settle_s=1.0)
        written = photo(sheet([(200, 120, 15)]), noise_seed=2)

        # Page sits still: one capture of the blank page, then nothing more.
        ev, t = self.run_frames(w, [photo(sheet(), noise_seed=i) for i in range(25)], 0)
        self.assertEqual([e["action"] for e in ev], ["capture"])

        # A hand moves over the page, then rests on it: settled, but skipped.
        moving = [photo(sheet(), hand_at=(600 + 40 * i, 500), noise_seed=i) for i in range(5)]
        resting = [photo(sheet([(200, 120, 15)]), hand_at=(900, 700), noise_seed=i) for i in range(15)]
        ev, t = self.run_frames(w, moving + resting, t)
        self.assertEqual([(e["action"], e.get("reason")) for e in ev], [("skip", "hand or object on the page")])

        # Hand lifts: the new ink is captured, located where it was written.
        ev, t = self.run_frames(w, [written] + [photo(sheet([(200, 120, 15)]), noise_seed=i) for i in range(15)], t)
        self.assertEqual([e["action"] for e in ev], ["capture"])
        ys, xs = np.nonzero(ev[0]["new_ink"])
        self.assertAlmostEqual(xs.mean() / PX_PER_MM, 207.5, delta=1.5)
        self.assertAlmostEqual(ys.mean() / PX_PER_MM, 127.5, delta=1.5)

        # Something moves and settles again with no new ink: skipped as no change.
        passing = photo(sheet([(200, 120, 15)]), hand_at=(700, 600))
        ev, _ = self.run_frames(w, [passing] + [photo(sheet([(200, 120, 15)]), noise_seed=i) for i in range(15)], t)
        self.assertEqual(ev[0]["action"], "skip")
        self.assertTrue(ev[0]["reason"].startswith("no new ink"))

    def test_covered_markers_skip(self):
        w = Watcher(settle_s=0.5)
        covered = photo(sheet(), cover=((0, 0), (1600, 300)))  # top two markers hidden
        ev, _ = self.run_frames(w, [covered] * 10, 0)
        self.assertEqual(ev, [{"action": "skip", "reason": "only 2 markers visible"}])

    def test_object_detector_ignores_pen_strokes(self):
        flat, _, _ = flatten(photo(sheet([(150, 80, 10), (60, 60, 30)])))
        self.assertFalse(object_on_page(flat))


if __name__ == "__main__":
    unittest.main()
