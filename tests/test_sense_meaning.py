import json
import unittest
from pathlib import Path

from sense.meaning import cue_of, make_sense

GOLD = Path(__file__).resolve().parent.parent / "data" / "labeled" / "page-01.json"
CUES = ["add", "looking into"]


def el(i, text, x, y, w=60, h=20, **kw):
    return {"id": i, "type": "text", "bbox": [x, y, w, h], "text": text, **kw}


def link(i, a, b, kind="flow", **kw):
    return {"id": i, "kind": kind, "from": a, "to": b, **kw}


def page(elements, links=()):
    return {"page_size": [1000, 1000], "elements": elements, "links": list(links)}


def flat(items):
    out = []
    for it in items:
        out.append((it["text"], it["ref"]))
        out += flat(it["children"])
    return out


@unittest.skipUnless(GOLD.exists(), "needs data/labeled/page-01.json")
class GoldPageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = make_sense(json.loads(GOLD.read_text()), CUES)

    def test_threads_follow_the_arrows_in_reading_order(self):
        roots = [t["roots"][0]["text"] for t in self.s["threads"]]
        self.assertEqual(roots, ["Transition", "tangible", "the idea of transitions", "Looking into EU.", "a connecting thread."])

    def test_the_hub_and_its_word_are_one_idea(self):
        top = self.s["threads"][0]["roots"][0]
        kids = {c["text"]: c for c in top["children"]}
        self.assertEqual(kids["curiosity"]["via"]["kind"], "hook")
        core = kids["core"]
        self.assertEqual(core["via"]["label"], "TRY TO")
        self.assertIn("core_shape", core["ids"])
        self.assertEqual(sorted(c["text"] for c in core["children"]), ["mindset of posture.", "peripheral units"])
        self.assertNotIn("core_shape", [t for t, _ in flat(self.s["threads"][0]["roots"])])  # not listed twice

    def test_loose_text_is_grouped_by_nearness(self):
        groups = [[i["text"] for i in g["items"]] for g in self.s["loose"]]
        self.assertEqual(groups, [["the way we think about design & society."], ["Add Luis Garcia", "PhDs in HCI"]])

    def test_todos_come_from_your_cues(self):
        self.assertEqual([a["text"] for a in self.s["actions"]], ["Looking into EU.", "Add Luis Garcia"])

    def test_key_terms_include_emphasized_connector_words(self):
        terms = {k["text"]: k for k in self.s["key_terms"]}
        self.assertEqual(terms["GAPS"]["kind"], "caps")
        self.assertEqual(terms["peripheral units"]["kind"], "underline")
        self.assertTrue(terms["TRY TO"]["connector"])

    def test_counts(self):
        self.assertEqual(self.s["stats"], {"text": 22, "shapes": 1, "doodles": 1, "links": 14, "threads": 5, "loose": 2})
        self.assertEqual(self.s["title"], "Transition")
        self.assertIn("5 threads", self.s["summary"])
        self.assertIn("2 to-dos", self.s["summary"])


class EdgeCaseTests(unittest.TestCase):
    def test_empty_page(self):
        s = make_sense(page([]), CUES)
        self.assertEqual((s["threads"], s["loose"]), ([], []))
        self.assertEqual(s["title"], "Untitled page")
        self.assertIn("No readable text", s["summary"])

    def test_cycle_with_no_root_still_makes_one_thread(self):
        s = make_sense(page([el("a", "A", 0, 0), el("b", "B", 100, 0), el("c", "C", 200, 0)],
                            [link("1", "a", "b"), link("2", "b", "c"), link("3", "c", "a")]), CUES)
        self.assertEqual(len(s["threads"]), 1)
        self.assertEqual(flat(s["threads"][0]["roots"]), [("A", False), ("B", False), ("C", False), ("A", True)])

    def test_a_node_reached_twice_is_shown_once_and_referenced_after(self):
        s = make_sense(page([el("a", "A", 0, 0), el("b", "B", 0, 300), el("c", "C", 300, 150)],
                            [link("1", "a", "c"), link("2", "b", "c")]), CUES)
        self.assertEqual(flat(s["threads"][0]["roots"]), [("A", False), ("C", False), ("B", False), ("C", True)])

    def test_a_root_unreachable_from_the_first_is_still_listed(self):
        # R -> X, and a cycle Y <-> Z that also points at X: Y and Z have no root of their own
        s = make_sense(page([el("r", "R", 0, 0), el("x", "X", 0, 300), el("y", "Y", 300, 0), el("z", "Z", 300, 300)],
                            [link("1", "r", "x"), link("2", "y", "z"), link("3", "z", "y"), link("4", "y", "x")]), CUES)
        names = {t for t, ref in flat(s["threads"][0]["roots"]) if not ref}
        self.assertEqual(names, {"R", "X", "Y", "Z"})

    def test_bad_links_are_ignored_and_ranked_endpoints_use_the_first(self):
        s = make_sense(page([el("a", "A", 0, 0), el("b", "B", 0, 300), el("c", "C", 300, 300)],
                            [link("1", "a", "ghost"), link("2", "a", "a"),
                             link("3", "a", [{"id": "b", "confidence": .6}, {"id": "c", "confidence": .4}])]), CUES)
        self.assertEqual(flat(s["threads"][0]["roots"]), [("A", False), ("B", False)])
        self.assertEqual(s["stats"]["links"], 1)

    def test_a_shape_with_no_words_is_still_a_node(self):
        pg = page([{"id": "s", "type": "shape", "bbox": [0, 0, 200, 200], "contains": []}, el("a", "A", 400, 0)],
                  [link("1", "s", "a")])
        self.assertEqual(flat(make_sense(pg, CUES)["threads"][0]["roots"]), [("(drawn shape)", False), ("A", False)])

    def test_stacked_lines_of_one_paragraph_read_top_to_bottom_then_left_to_right(self):
        pg = page([el("c", "third", 0, 60, 80, 20), el("a", "first", 0, 0, 80, 20), el("b", "second", 0, 30, 80, 20),
                   el("d", "far away", 800, 800)])
        groups = [[i["text"] for i in g["items"]] for g in make_sense(pg, CUES)["loose"]]
        self.assertEqual(groups, [["first", "second", "third"], ["far away"]])

    def test_cue_needs_a_whole_word_at_the_start(self):
        self.assertEqual(cue_of("Add Luis", CUES), "add")
        self.assertEqual(cue_of("  Looking into EU.", CUES), "looking into")
        self.assertEqual(cue_of("Add.? Luis", CUES), "add")
        self.assertIsNone(cue_of("Address book", CUES))
        self.assertIsNone(cue_of("Don't add", CUES))

    def test_very_deep_chain_does_not_blow_the_stack(self):
        n = 200
        els = [el(f"n{i}", f"N{i}", (i % 10) * 90, (i // 10) * 40, 60, 20) for i in range(n)]
        s = make_sense(page(els, [link(f"l{i}", f"n{i}", f"n{i + 1}") for i in range(n - 1)]), CUES)
        self.assertEqual(s["stats"]["threads"], 1)


if __name__ == "__main__":
    unittest.main()
