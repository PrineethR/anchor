import copy
import json
import tempfile
import unittest
from pathlib import Path

from harness.schema import load_page, validate
from harness.score import score_page, summarize

GOLD = Path(__file__).parent.parent / "examples" / "gold-example.json"


def page_from(raw: dict):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(raw, f)
    return load_page(f.name)


def summary(raw_pred: dict) -> dict:
    return summarize([score_page(load_page(GOLD), page_from(raw_pred))])


class ScoreTests(unittest.TestCase):
    def setUp(self):
        self.raw = json.loads(GOLD.read_text())

    def test_gold_is_valid(self):
        self.assertEqual(validate(load_page(GOLD), gold=True), [])

    def test_perfect_prediction(self):
        s = summary(self.raw)
        self.assertEqual(s["text"]["detection_f1"], 1.0)
        self.assertEqual(s["text"]["cer_end_to_end"], 0.0)
        self.assertEqual(s["links"]["top1_f1"], 1.0)
        self.assertEqual(s["links"]["kind_accuracy"], 1.0)
        self.assertEqual(s["links"]["connector_label_accuracy"], 1.0)
        self.assertEqual(s["emphasis"]["underline_f1"], 1.0)
        self.assertEqual(s["emphasis"]["caps_f1"], 1.0)
        self.assertEqual(s["emphasis"]["container_jaccard"], 1.0)

    def test_units_and_ids_are_irrelevant(self):
        # Pred in pixels of a 2100x2970 image, with different ids: still perfect.
        p = copy.deepcopy(self.raw)
        p["page_size"] = [2100, 2970]
        ren = {e["id"]: "p" + e["id"] for e in p["elements"]}
        for e in p["elements"]:
            e["id"] = ren[e["id"]]
            e["bbox"] = [v * 10 for v in e["bbox"]]
            e["contains"] = [ren[c] for c in e.get("contains", [])]
        for l in p["links"]:
            l["from"], l["to"] = ren[l["from"]], ren[l["to"]]
        self.assertEqual(summary(p)["links"]["top1_f1"], 1.0)

    def test_loose_boxes_still_match(self):
        p = copy.deepcopy(self.raw)
        p["elements"][0]["bbox"] = [30, 33, 15, 5]  # small box inside the gold one
        self.assertEqual(summary(p)["text"]["detection_f1"], 1.0)

    def test_misread_and_missed_text(self):
        p = copy.deepcopy(self.raw)
        p["elements"][0]["text"] = "Atention"            # 1 edit of 9
        del p["elements"][2]                             # drop "limited span"
        p["links"] = [l for l in p["links"] if l["id"] != "l2"]
        s = summary(p)
        self.assertAlmostEqual(s["text"]["detection_r"], 4 / 5)
        self.assertAlmostEqual(s["text"]["cer_matched"], 1 / 29)  # Attention+MEMORY+encoding+recall = 29 chars
        self.assertAlmostEqual(s["text"]["cer_end_to_end"], (1 + 12) / 41)

    def test_reversed_link(self):
        p = copy.deepcopy(self.raw)
        p["links"][0]["from"], p["links"][0]["to"] = "t2", "t1"
        s = summary(p)
        self.assertEqual(s["links"]["reversed"], 1)
        self.assertAlmostEqual(s["links"]["top1_r"], 3 / 4)

    def test_ambiguous_end_counts_in_top2(self):
        p = copy.deepcopy(self.raw)
        p["links"][1]["to"] = [{"id": "t2", "confidence": 0.55}, {"id": "t1", "confidence": 0.4}]
        s = summary(p)
        self.assertAlmostEqual(s["links"]["top1_r"], 3 / 4)
        self.assertEqual(s["links"]["top2_recall"], 1.0)

    def test_kind_and_label(self):
        p = copy.deepcopy(self.raw)
        p["links"][1]["kind"] = "flow"
        p["links"][2]["label"] = "of"
        s = summary(p)
        self.assertEqual(s["links"]["top1_f1"], 1.0)
        self.assertAlmostEqual(s["links"]["kind_accuracy"], 3 / 4)
        self.assertEqual(s["links"]["connector_label_accuracy"], 0.0)

    def test_emphasis_channels(self):
        p = copy.deepcopy(self.raw)
        p["elements"][0]["underline"] = False   # missed underline
        p["elements"][3]["caps"] = True          # false CAPS
        p["elements"][5]["contains"] = ["t4"]    # shape lost a member
        s = summary(p)["emphasis"]
        self.assertEqual(s["underline_r"], 0.0)
        self.assertAlmostEqual(s["caps_p"], 1 / 2)
        self.assertAlmostEqual(s["container_jaccard"], 1 / 2)

    def test_connector_emphasis(self):
        g = copy.deepcopy(self.raw)
        g["links"][2].update(caps=True, underline=True)    # the "to" connector
        p = copy.deepcopy(self.raw)
        p["links"][2]["caps"] = True                        # caps right, underline missed
        p["links"][0].update(label="x", caps=True)          # caps on a flow link: false positive
        s = summarize([score_page(page_from(g), page_from(p))])["emphasis"]
        self.assertAlmostEqual(s["caps_p"], 2 / 3)          # MEMORY, "to" right; flow link wrong
        self.assertEqual(s["caps_r"], 1.0)
        self.assertAlmostEqual(s["underline_r"], 1 / 2)     # Attention found, "to" missed
        # A missed connector loses its emphasis too.
        p2 = copy.deepcopy(self.raw)
        del p2["links"][2]
        s2 = summarize([score_page(page_from(g), page_from(p2))])["emphasis"]
        self.assertAlmostEqual(s2["caps_r"], 1 / 2)

    def test_doodle_read_as_text(self):
        g = copy.deepcopy(self.raw)
        g["elements"].append({"id": "d1", "type": "doodle", "bbox": [180, 200, 15, 15]})
        p = copy.deepcopy(self.raw)
        p["elements"].append({"id": "x", "type": "text", "bbox": [181, 201, 13, 13], "text": "O"})
        s = summarize([score_page(page_from(g), page_from(p))])
        self.assertEqual(s["doodles"]["read_as_text"], 1)
        self.assertEqual(s["doodles"]["f1"], 0.0)
        self.assertLess(s["text"]["detection_p"], 1.0)

    def test_empty_prediction(self):
        s = summary({"page_id": "x", "page_size": [210, 297]})
        self.assertEqual(s["text"]["detection_r"], 0.0)
        self.assertEqual(s["text"]["cer_end_to_end"], 1.0)
        self.assertEqual(s["links"]["top1_r"], 0.0)


if __name__ == "__main__":
    unittest.main()
