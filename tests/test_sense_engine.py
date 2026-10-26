import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

from anchor.flatten import PX_PER_MM
from anchor.template import PAGE_MM
from baselines import gemini, vision
from sense import engine
from sense.profile import Profile
from tests.test_capture import photo, sheet


def desk_photo(sheet_corners=((120, 90), (880, 120), (860, 640), (100, 600)), size=(1000, 700)):
    """A white sheet on a coloured desk, no markers."""
    img = np.full((size[1], size[0], 3), (70, 95, 120), np.uint8)
    cv2.fillConvexPoly(img, np.int32(sheet_corners), (245, 245, 245))
    return img


class PrepareTests(unittest.TestCase):
    def test_marked_sheet_is_flattened_by_its_markers(self):
        flat, how = engine.prepare(photo(sheet()))
        self.assertEqual(how, "markers")
        self.assertEqual(flat.shape[:2], (PAGE_MM[1] * PX_PER_MM, PAGE_MM[0] * PX_PER_MM))

    def test_unmarked_sheet_is_cut_out_by_its_edges_keeping_its_shape(self):
        flat, how = engine.prepare(desk_photo())
        self.assertEqual(how, "edges")
        h, w = flat.shape[:2]
        self.assertTrue(600 < w < 800 and 450 < h < 600, (w, h))
        self.assertGreater(flat.mean(), 200)  # the sheet, not the desk

    def test_crop_off_keeps_the_whole_photo(self):
        flat, how = engine.prepare(desk_photo(), crop=False)
        self.assertEqual((how, flat.shape[:2]), ("whole photo", (700, 1000)))

    def test_no_sheet_found_falls_back_to_the_whole_photo(self):
        flat, how = engine.prepare(np.full((600, 800, 3), (90, 110, 130), np.uint8))
        self.assertEqual((how, flat.shape[:2]), ("whole photo", (600, 800)))

    def test_a_small_bright_patch_is_not_taken_for_the_page(self):
        img = desk_photo(((400, 300), (520, 300), (520, 380), (400, 380)))
        self.assertEqual(engine.prepare(img)[1], "whole photo")

    def test_big_photos_are_shrunk(self):
        big = np.full((3000, 4000, 3), (90, 110, 130), np.uint8)
        self.assertEqual(max(engine.prepare(big)[0].shape[:2]), engine.MAX_SIDE)

    def test_decode_refuses_things_that_are_not_images(self):
        with mock.patch.object(engine.shutil, "which", return_value=None):
            with self.assertRaises(engine.EngineError):
                engine.decode(b"not an image")

    def test_turn(self):
        img = np.zeros((2, 4, 3), np.uint8)
        self.assertEqual(engine.turn(img, 1).shape[:2], (4, 2))
        self.assertEqual(engine.turn(img, 4).shape[:2], (2, 4))


class OrientTests(unittest.TestCase):
    """vision.ocr is faked: it finds which way the test image was turned from where a white block ended up."""

    def img(self):
        img = np.zeros((40, 80, 3), np.uint8)
        img[:12, :12] = 255  # top-left marker
        return img

    def fake_ocr(self, table):
        def ocr(path):
            im = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
            ys, xs = np.nonzero(im > 128)
            top, left = ys.mean() < im.shape[0] / 2, xs.mean() < im.shape[1] / 2
            n = {(True, True): 0, (True, False): 1, (False, False): 2, (False, True): 3}[(top, left)]
            return {"width": im.shape[1], "height": im.shape[0], "lines": table[n]}
        return ocr

    def line(self, text, wide):
        return {"text": text, "confidence": 1, "box": [0, 0, 50, 10] if wide else [0, 0, 10, 50]}

    def orient_with(self, table):
        with mock.patch.object(vision, "ensure_binary"), mock.patch.object(vision, "ocr", self.fake_ocr(table)):
            return engine.orient(self.img())

    def test_upright_photo_stays_and_is_sure(self):
        turns, raw, sure = self.orient_with({0: [self.line("hello world", True)], 1: [self.line("hello world", False)],
                                     2: [self.line("hello world", True)], 3: [self.line("hello world", False)]})
        self.assertEqual((turns, sure), (0, True))

    def test_sideways_photo_is_turned_but_not_sure_which_way(self):
        # lines come back wide after turn 1 or 3, indistinguishable by text; the one with more text wins
        turns, raw, sure = self.orient_with({0: [self.line("abc", False)], 1: [self.line("abcdefg", True)],
                                     2: [self.line("abc", False)], 3: [self.line("abcdefgh", True)]})
        self.assertEqual((turns, sure), (3, False))
        self.assertEqual(raw["lines"][0]["text"], "abcdefgh")

    def test_only_one_way_is_wide_means_sure(self):
        turns, _, sure = self.orient_with({0: [self.line("a", False)], 1: [self.line("abc", True)],
                                   2: [self.line("a", False)], 3: [self.line("abc", False)]})
        self.assertEqual((turns, sure), (1, True))

    def test_nothing_read_stays_put(self):
        self.assertEqual(self.orient_with({n: [] for n in range(4)})[0], 0)


RAW_PAGE = {"elements": [
    {"id": "t1", "type": "text", "box_2d": [100, 50, 200, 450], "text": "core"},
    {"id": "t2", "type": "text", "box_2d": [500, 500, 600, 900], "text": "next"}],
    "links": [{"id": "l1", "kind": "flow", "from": "t1", "to": "t2"}]}


class ReadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.flat = Path(self.tmp.name, "flat.jpg")
        cv2.imwrite(str(self.flat), np.full((100, 200, 3), 255, np.uint8))  # 200 wide, 100 tall
        self.addCleanup(self.tmp.cleanup)

    def env(self, key):
        return mock.patch.dict(os.environ, {"GEMINI_API_KEY": key} if key else {}, clear=False)

    def test_gemini_page_is_rescaled_to_the_images_real_shape(self):
        with self.env("k"), mock.patch.object(gemini, "call_gemini", return_value=json.dumps(RAW_PAGE)) as call:
            page, source, notes = engine.read(self.flat, "p", Profile())
        self.assertEqual((source, page["page_size"]), ("gemini", [200, 100]))
        self.assertEqual(page["elements"][0]["bbox"], [10.0, 10.0, 80.0, 10.0])  # x=50/1000*200, y=100/1000*100
        self.assertEqual(len(page["links"]), 1)
        self.assertIn("About this writer", call.call_args.kwargs["prompt"])  # the profile rides along

    def test_gemini_failure_falls_back_to_local_ocr_and_says_so(self):
        raw = {"width": 200, "height": 100, "lines": [{"text": "hello", "confidence": 1, "box": [10, 10, 50, 12]}]}
        with self.env("k"), mock.patch.object(gemini, "call_gemini", side_effect=RuntimeError("HTTP 429")), \
                mock.patch.object(engine, "vision_ready", return_value=True), mock.patch.object(vision, "ocr", return_value=raw):
            page, source, notes = engine.read(self.flat, "p", Profile())
        self.assertEqual(source, "vision")
        self.assertEqual(page["elements"][0]["text"], "hello")
        self.assertIn("HTTP 429", notes[0])

    def test_without_a_key_it_uses_the_orientation_pass_reading_instead_of_reading_twice(self):
        raw = {"width": 200, "height": 100, "lines": [{"text": "hi", "confidence": 1, "box": [0, 0, 20, 10]}]}
        with self.env(None), mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}), \
                mock.patch.object(engine, "vision_ready", return_value=True), \
                mock.patch.object(vision, "ocr", side_effect=AssertionError("read twice")):
            page, source, _ = engine.read(self.flat, "p", Profile(), ocr=raw)
        self.assertEqual((source, page["elements"][0]["text"]), ("vision", "hi"))

    def test_no_reader_at_all_is_an_error_that_says_what_to_do(self):
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": ""}), mock.patch.object(engine, "vision_ready", return_value=False):
            with self.assertRaisesRegex(engine.EngineError, "GEMINI_API_KEY"):
                engine.read(self.flat, "p", Profile())


class PickExamplesTests(unittest.TestCase):
    def test_confirmed_notes_come_first_then_labeled_pages(self):
        with tempfile.TemporaryDirectory() as d:
            notes, labeled = Path(d, "notes"), Path(d, "labeled")
            page = {"page_size": [200, 100], "links": [], "elements": [{"id": "a", "type": "text", "bbox": [0, 0, 20, 10], "text": "x"}]}
            for nid, confirmed in (("20260101-000000-aaaa", True), ("20260102-000000-bbbb", False), ("20260103-000000-cccc", True)):
                (notes / nid).mkdir(parents=True)
                (notes / nid / "meta.json").write_text(json.dumps({"confirmed": confirmed}))
                (notes / nid / "page.json").write_text(json.dumps(page))
                (notes / nid / "flat.jpg").write_bytes(b"jpg")
            labeled.mkdir()
            (labeled / "page-01.json").write_text(json.dumps(page))
            (labeled / "page-01.jpg").write_bytes(b"jpg")
            got = engine.pick_examples(notes, labeled, n=3)
            self.assertEqual([p.parent.name for p, _ in got[:2]], ["20260103-000000-cccc", "20260101-000000-aaaa"])
            self.assertEqual(got[2][0].name, "page-01.jpg")
            self.assertEqual(got[0][1]["elements"][0]["box_2d"], [0, 0, 100, 100])
            self.assertEqual(len(engine.pick_examples(notes, labeled, n=1)), 1)
            self.assertEqual(engine.pick_examples(Path(d, "none"), Path(d, "none"), n=2), [])


if __name__ == "__main__":
    unittest.main()
