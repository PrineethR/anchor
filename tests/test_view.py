import json
import tempfile
import unittest
from pathlib import Path

from harness.view import HTML, build, error_refs

EXAMPLE = Path(__file__).parent.parent / "examples" / "gold-example.json"


class ErrorRefsTests(unittest.TestCase):
    def test_gold_ids_found_quoted_text_ignored(self):
        r = error_refs("misread t1: 't2' -> 'recall'", {"t1", "t2", "t5"}, set())
        self.assertEqual(r["gold"], ["t1"])

    def test_link_and_pred_ids(self):
        r = error_refs("spurious link pred:p3->t2 (flow)", {"t2"}, {"p3"})
        self.assertEqual((r["gold"], r["pred"]), (["t2"], ["p3"]))


class BuildTests(unittest.TestCase):
    def test_build_scores_each_source(self):
        with tempfile.TemporaryDirectory() as d:
            gold, perfect, empty = Path(d, "gold"), Path(d, "perfect"), Path(d, "empty")
            for p in (gold, perfect, empty):
                p.mkdir()
            (gold / "page-x.json").write_text(EXAMPLE.read_text())
            (perfect / "page-x.json").write_text(EXAMPLE.read_text())
            data = build(gold, {"perfect": perfect, "empty": empty})
        self.assertEqual(data["sources"], ["perfect", "empty"])
        self.assertEqual(data["summary"]["perfect"]["text"]["detection_f1"], 1.0)
        self.assertEqual(data["with_preds"], {"perfect": 1, "empty": 0})
        page = data["pages"][0]
        self.assertIsNone(page["image"])
        self.assertEqual(page["preds"]["perfect"]["errors"], [])
        self.assertEqual(page["preds"]["perfect"]["match"]["t1"], "t1")
        self.assertFalse(page["preds"]["empty"]["present"])
        self.assertTrue(any(e["gold"] == ["t1"] for e in page["preds"]["empty"]["errors"]))
        json.dumps(data)  # embeddable

    def test_template_has_one_data_slot(self):
        self.assertEqual(HTML.count("__DATA__"), 1)


if __name__ == "__main__":
    unittest.main()
