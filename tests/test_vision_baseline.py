import json
import tempfile
import unittest

from baselines.vision import expand_shorthand, is_caps, merge_stacked, split_arrows, to_page
from harness.schema import load_page, validate


def line(text, x, y, w, h, conf=1.0):
    return {"text": text, "confidence": conf, "box": [x, y, w, h]}


def texts(groups):
    return [" ".join(l["text"] for l in g) for g in groups]


class SplitArrowsTests(unittest.TestCase):
    def test_split_at_arrow_with_proportional_boxes(self):
        # 22 chars over 220 px: 10 px per char.
        out = split_arrows([line("CRITQUE → 7 trantition", 0, 5, 220, 20)])
        self.assertEqual([o["text"] for o in out], ["CRITQUE", "7 trantition"])
        self.assertEqual(out[0]["box"], [0, 5, 70, 20])
        self.assertEqual(out[1]["box"], [100, 5, 120, 20])

    def test_edge_glyphs_trimmed(self):
        out = split_arrows([line("→ framework.", 0, 0, 120, 20), line("GAPS -", 0, 50, 60, 20), line("• telling", 0, 90, 90, 20)])
        self.assertEqual([o["text"] for o in out], ["framework.", "GAPS", "telling"])
        self.assertEqual(out[0]["box"][0], 20)

    def test_glyph_only_lines_dropped(self):
        self.assertEqual(split_arrows([line("→", 0, 0, 10, 10), line(" - ", 0, 0, 10, 10)]), [])

    def test_ascii_arrow(self):
        self.assertEqual([o["text"] for o in split_arrows([line("a -> b", 0, 0, 60, 10)])], ["a", "b"])


class MergeTests(unittest.TestCase):
    def test_stacked_lines_merge(self):
        g = merge_stacked([line("Garcia", 80, 72, 62, 30), line("Add", 46, 20, 68, 30), line("Luis", 92, 46, 44, 30)])
        self.assertEqual(texts(g), ["Add Luis Garcia"])

    def test_side_by_side_lines_stay_apart(self):
        g = merge_stacked([line("tangible", 0, 0, 100, 30), line("intangible", 200, 5, 120, 30)])
        self.assertEqual(len(g), 2)

    def test_far_below_stays_apart(self):
        g = merge_stacked([line("PhDs", 0, 0, 60, 30), line("Garcia", 0, 60, 60, 30)])
        self.assertEqual(len(g), 2)

    def test_offset_to_the_right_stays_apart(self):
        # Like 'Transition' with 'curiosity' tucked below and to its right.
        g = merge_stacked([line("Transition", 49, 38, 86, 29), line("curiosity", 98, 66, 120, 34)])
        self.assertEqual(len(g), 2)

    def test_lower_line_joins_the_group_it_sits_under(self):
        g = merge_stacked([line("left", 0, 0, 80, 30), line("right", 400, 0, 80, 30), line("under", 405, 35, 70, 30)])
        self.assertEqual(sorted(texts(g)), ["left", "right under"])


class ShorthandTests(unittest.TestCase):
    def test_lone_seven_becomes_of(self):
        out = expand_shorthand([line("7 trantition", 0, 0, 10, 10), line("mindset 7 partue.", 0, 0, 10, 10)])
        self.assertEqual([o["text"] for o in out], ["of trantition", "mindset of partue."])

    def test_seven_inside_a_token_is_left_alone(self):
        out = expand_shorthand([line("tangibe 7, intangible", 0, 0, 10, 10), line("page 17", 0, 0, 10, 10)])
        self.assertEqual([o["text"] for o in out], ["tangibe 7, intangible", "page 17"])

    def test_box_and_confidence_kept(self):
        self.assertEqual(expand_shorthand([line("7", 1, 2, 3, 4, 0.5)]), [line("of", 1, 2, 3, 4, 0.5)])


class PageTests(unittest.TestCase):
    def test_caps(self):
        self.assertTrue(is_caps("GAPS"))
        self.assertTrue(is_caps("X RANSTON"))
        self.assertFalse(is_caps("PhDS"))
        self.assertFalse(is_caps("A"))

    def test_to_page_is_valid_and_unions_boxes(self):
        groups = [[line("mindset", 116, 422, 81, 43, 0.9), line("of posture", 122, 432, 136, 72, 0.5)], [line("GAPS", 850, 244, 62, 22)]]
        page = to_page(groups, "page-x", (1188, 840))
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(page, f)
        self.assertEqual(validate(load_page(f.name), gold=False), [])
        t1, t2 = page["elements"]
        self.assertEqual((t1["text"], t1["bbox"], t1["confidence"]), ("mindset of posture", [116, 422, 142, 82], 0.5))
        self.assertTrue(t2["caps"])
        self.assertEqual(page["links"], [])


if __name__ == "__main__":
    unittest.main()
