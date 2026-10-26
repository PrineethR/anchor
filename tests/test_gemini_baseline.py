import json
import tempfile
import unittest
from pathlib import Path

from baselines.gemini import to_page
from harness.schema import load_page, validate

# A canned answer in Gemini's shape: box_2d is [ymin, xmin, ymax, xmax] on 0-1000.
RAW = {
    "elements": [
        {"id": "t1", "type": "text", "box_2d": [100, 50, 150, 200], "text": " Transition ", "underline": False},
        {"id": "t2", "type": "text", "box_2d": [300, 100, 350, 250], "text": "core", "caps": True},
        {"id": "t3", "type": "text", "box_2d": [600, 100, 650, 250], "text": "   "},
        {"id": "s1", "type": "shape", "box_2d": [250, 60, 450, 300], "contains": ["t2", "ghost", "s1"]},
        {"id": "d1", "type": "doodle", "box_2d": [1200, -5, 280, 90]},
        {"id": "t2", "type": "text", "box_2d": [700, 700, 750, 800], "text": "dup id"},
        {"id": "bad", "type": "text", "box_2d": [1, 2, 3], "text": "x"},
    ],
    "links": [
        {"id": "l1", "kind": "connector", "from": "t1", "to": "t2", "label": "TRY TO",
         "caps": True, "underline": True, "confidence": 0.8},
        {"id": "l2", "kind": "flow", "from": "s1", "to": "t2", "to_alt": "t1", "confidence": 0.6},
        {"id": "l3", "kind": "flow", "from": "t1", "to": "t3"},
        {"id": "l4", "kind": "hook", "from": "t1", "to": "t2", "caps": True},
    ],
}


def load(page: dict):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(page, f)
    return load_page(f.name)


class ToPageTests(unittest.TestCase):
    def setUp(self):
        self.page, self.notes = to_page(RAW, "page-x")
        self.els = {e["id"]: e for e in self.page["elements"]}
        self.links = {l["id"]: l for l in self.page["links"]}

    def test_output_is_valid_prediction(self):
        self.assertEqual(validate(load(self.page), gold=False), [])

    def test_box_2d_becomes_xywh(self):
        self.assertEqual(self.page["page_size"], [1000, 1000])
        self.assertEqual(self.els["t1"]["bbox"], [50, 100, 150, 50])
        self.assertEqual(self.els["t1"]["text"], "Transition")

    def test_swapped_and_out_of_range_box_is_clamped(self):
        self.assertEqual(self.els["d1"]["bbox"], [0, 280, 90, 720])

    def test_bad_and_empty_elements_dropped(self):
        self.assertNotIn("t3", self.els)
        self.assertNotIn("bad", self.els)
        self.assertEqual(len(self.notes), 3)  # t3, bad, l3

    def test_duplicate_ids_kept_apart(self):
        self.assertEqual(self.els["t2_"]["text"], "dup id")

    def test_contains_filtered_to_known_other_ids(self):
        self.assertEqual(self.els["s1"]["contains"], ["t2"])

    def test_connector_label_and_emphasis(self):
        l1 = self.links["l1"]
        self.assertEqual((l1["label"], l1["caps"], l1["underline"]), ("TRY TO", True, True))

    def test_alt_endpoint_becomes_ranked_candidates(self):
        self.assertEqual(self.links["l2"]["to"], [{"id": "t2", "confidence": 0.6}, {"id": "t1", "confidence": 0.4}])
        self.assertEqual(self.links["l2"]["from"], "s1")

    def test_link_to_dropped_element_is_dropped(self):
        self.assertNotIn("l3", self.links)

    def test_emphasis_without_label_is_not_kept(self):
        self.assertNotIn("caps", self.links["l4"])


if __name__ == "__main__":
    unittest.main()


class BodyAndFromPageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.img = Path(self.tmp.name, "p.jpg")
        self.img.write_bytes(b"new-page")

    def test_without_examples_the_request_is_the_baselines(self):
        from baselines.gemini import PROMPT, build_body
        parts = build_body(self.img)["contents"][0]["parts"]
        self.assertEqual(len(parts), 2)
        self.assertIn("inline_data", parts[0])
        self.assertEqual(parts[1], {"text": PROMPT})

    def test_examples_come_first_each_followed_by_its_answer(self):
        from baselines.gemini import build_body
        ex = Path(self.tmp.name, "ex.jpg")
        ex.write_bytes(b"example")
        parts = build_body(self.img, "PROMPT", [(ex, {"elements": [], "links": []})])["contents"][0]["parts"]
        self.assertEqual(len(parts), 5)
        self.assertTrue(parts[0]["text"].startswith("PROMPT"))
        self.assertIn("inline_data", parts[1])
        self.assertIn('"elements"', parts[2]["text"])
        self.assertEqual(parts[4]["inline_data"]["data"], __import__("base64").b64encode(b"new-page").decode())

    def test_from_page_is_the_inverse_of_to_page(self):
        from baselines.gemini import from_page
        gold = {"page_size": [1188, 840], "elements": [
            {"id": "t1", "type": "text", "bbox": [48, 38, 90, 24], "text": "Transition", "underline": True},
            {"id": "t2", "type": "text", "bbox": [116, 214, 56, 32], "text": "core", "caps": True},
            {"id": "s1", "type": "shape", "bbox": [72, 180, 150, 142], "contains": ["t2"]},
            {"id": "d1", "type": "doodle", "bbox": [95, 216, 22, 30]}],
            "links": [{"id": "l1", "kind": "connector", "from": "t1", "to": "t2", "label": "TRY TO", "caps": True},
                      {"id": "l2", "kind": "flow", "from": "s1", "to": [{"id": "t1", "confidence": .6}, {"id": "t2", "confidence": .4}]}]}
        back, notes = to_page(from_page(gold), "x")
        self.assertEqual(notes, [])
        got = {e["id"]: e for e in back["elements"]}
        for e in gold["elements"]:
            want = [e["bbox"][0] / 1188, e["bbox"][1] / 840, e["bbox"][2] / 1188, e["bbox"][3] / 840]
            have = [v / 1000 for v in got[e["id"]]["bbox"]]
            for w, h in zip(want, have):
                self.assertAlmostEqual(w, h, delta=0.002)
        self.assertEqual((got["t1"]["text"], got["t1"]["underline"], got["t2"]["caps"]), ("Transition", True, True))
        self.assertEqual(got["s1"]["contains"], ["t2"])
        links = {l["id"]: l for l in back["links"]}
        self.assertEqual((links["l1"]["label"], links["l1"]["caps"]), ("TRY TO", True))
        self.assertEqual([c["id"] for c in links["l2"]["to"]], ["t1", "t2"])

    def test_post_returns_the_first_answers_text(self):
        import json as _json
        from unittest import mock
        from baselines import gemini

        class Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return _json.dumps({"candidates": [{"content": {"parts": [{"text": "{\"a\":"}, {"text": "1}"}]}}]}).encode()

        with mock.patch.object(gemini.urllib.request, "urlopen", return_value=Resp()) as op:
            self.assertEqual(gemini.post({"x": 1}, "m", "key"), '{"a":1}')
        req = op.call_args.args[0]
        self.assertEqual(req.get_header("X-goog-api-key"), "key")
        self.assertIn("/models/m:generateContent", req.full_url)
