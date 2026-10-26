import json
import tempfile
import unittest
from pathlib import Path

from sense.profile import Profile, diff_pairs, style_stats


def page(*texts):
    return {"page_size": [100, 100], "links": [],
            "elements": [{"id": f"t{i}", "type": "text", "bbox": [0, i, 10, 5], "text": t} for i, t in enumerate(texts)]}


class DiffPairsTests(unittest.TestCase):
    def test_same_count_replacement_pairs_words(self):
        self.assertEqual(diff_pairs("perpueral units", "peripheral units"), ({"perpueral": "peripheral"}, {}))

    def test_capitals_and_punctuation_alone_teach_nothing(self):
        self.assertEqual(diff_pairs("framework,", "Framework."), ({}, {}))

    def test_different_word_count_is_kept_as_a_phrase(self):
        self.assertEqual(diff_pairs("connechn wread", "a connecting thread"),
                         ({}, {"connechn wread": "a connecting thread"}))


class LearnTests(unittest.TestCase):
    def test_edited_line_teaches_raw_to_final_and_joins_vocab(self):
        p = Profile()
        raw = page("Franthon", "Ocore")
        p.learn_note("n1", raw, raw, page("Transition", "Ocore"))
        self.assertEqual(p.learned_fixes(), [{"raw": "franthon", "to": "Transition", "notes": 1}])
        self.assertIn("transition", p.vocab())
        self.assertNotIn("ocore", p.vocab())  # left alone, not confirmed: might be a misreading

    def test_lines_the_profile_rewrote_are_not_counted_as_yours(self):
        p = Profile()
        raw, shown = page("7 taestan"), page("of taestan")
        p.learn_note("n1", raw, shown, shown)
        self.assertEqual(p.learned_fixes(), [])
        self.assertNotIn("taestan", p.vocab())

    def test_edit_over_a_profile_rewrite_learns_from_the_raw_reading(self):
        p = Profile()
        raw, shown = page("travishon"), page("transition")
        p.learn_note("n1", raw, shown, page("transitions"))
        self.assertEqual(p.learned_fixes()[0]["raw"], "travishon")
        self.assertEqual(p.learned_fixes()[0]["to"], "transitions")

    def test_confirming_the_page_learns_the_words_you_left_alone(self):
        p = Profile()
        raw = page("mindset of posture")
        p.learn_note("n1", raw, raw, raw, confirmed=True)
        self.assertIn("mindset", p.vocab())
        self.assertIn("posture", p.vocab())

    def test_saving_twice_counts_once_and_deleting_forgets(self):
        p = Profile()
        raw = page("Franthon")
        for _ in range(3):
            p.learn_note("n1", raw, raw, page("Transition"))
        self.assertEqual(p.learned_fixes()[0]["notes"], 1)
        self.assertEqual(p.vocab()["transition"], 2)  # once as a word, once as a fix target
        p.forget_note("n1")
        self.assertEqual(p.learned_fixes(), [])

    def test_two_notes_teaching_the_same_fix_count_twice(self):
        p = Profile()
        for n in ("n1", "n2"):
            raw = page("Franthon")
            p.learn_note(n, raw, raw, page("Transition"))
        self.assertEqual(p.learned_fixes()[0]["notes"], 2)


class ApplyTests(unittest.TestCase):
    def test_shorthand_only_matches_a_lone_mark(self):
        p = Profile()
        out, changes = p.apply(page("7 core", "7, core", "17"))
        self.assertEqual([e["text"] for e in out["elements"]], ["of core", "7, core", "17"])
        self.assertEqual(changes, [{"id": "t0", "from": "7 core", "to": "of core", "why": "shorthand"}])

    def test_learned_fix_keeps_surrounding_punctuation(self):
        p = Profile()
        raw = page("Franthon")
        p.learn_note("n1", raw, raw, page("Transition"))
        out, changes = p.apply(page("Franthon.", "(franthon)"))
        self.assertEqual([e["text"] for e in out["elements"]], ["Transition.", "(Transition)"])
        self.assertEqual({c["why"] for c in changes}, {"fix"})

    def test_learned_phrase_fix(self):
        p = Profile()
        raw = page("connechn wread")
        p.learn_note("n1", raw, raw, page("a connecting thread"))
        out, _ = p.apply(page("Connechn wread."))
        self.assertEqual(out["elements"][0]["text"], "a connecting thread")

    def test_snaps_a_near_miss_to_a_word_you_use(self):
        p = Profile()
        p.learn_note("n1", page("x"), page("x"), page("curiosity about posture"))
        out, changes = p.apply(page("Curiosty", "poshure here"))
        self.assertEqual(out["elements"][0]["text"], "Curiosity")
        self.assertEqual(out["elements"][1]["text"], "posture here")
        self.assertEqual({c["why"] for c in changes}, {"vocab"})

    def test_does_not_snap_inflections_short_words_or_unrelated_words(self):
        p = Profile()
        p.learn_note("n1", page("x"), page("x"), page("curiosity transition core posture"))
        out, changes = p.apply(page("transitions curiosities", "cure", "something entirely different", "posturs"))
        self.assertEqual([e["text"] for e in out["elements"]],
                         ["transitions curiosities", "cure", "something entirely different", "posturs"])
        self.assertEqual(changes, [])

    def test_does_not_touch_anything_but_text(self):
        p = Profile()
        pg = page("7")
        pg["links"] = [{"id": "l1", "kind": "flow", "from": "t0", "to": "t0", "label": "7"}]
        out, _ = p.apply(pg)
        self.assertEqual(out["links"][0]["label"], "7")
        self.assertEqual(pg["elements"][0]["text"], "7")  # input untouched


class StorageAndHintsTests(unittest.TestCase):
    def test_round_trip_and_labeled_vocabulary(self):
        with tempfile.TemporaryDirectory() as d:
            labeled = Path(d, "labeled")
            labeled.mkdir()
            (labeled / "page-01.json").write_text(json.dumps({
                "elements": [{"id": "a", "type": "text", "text": "peripheral units"}],
                "links": [{"label": "TRY TO"}]}))
            p = Profile.load(Path(d, "profile.json"))
            self.assertEqual(p.learn_labeled(labeled), 1)
            p.set_shorthand({"~": "approximately"})
            p.save()
            q = Profile.load(Path(d, "profile.json"))
            self.assertIn("peripheral", q.vocab())
            self.assertEqual(q.rewrite("~ ten")[0], "approximately ten")
            self.assertEqual(q.rewrite("7")[0], "7")  # seeded shorthand replaced, not merged

    def test_cues_are_normalized_and_deduplicated(self):
        p = Profile()
        p.set_cues(["  Add ", "add", "Looking  into", ""])
        self.assertEqual(p.data["action_cues"], ["add", "looking into"])

    def test_forgetting_a_fix(self):
        p = Profile()
        raw = page("Franthon")
        p.learn_note("n1", raw, raw, page("Transition"))
        p.forget_fix("franthon")
        self.assertEqual(p.apply(page("Franthon"))[0]["elements"][0]["text"], "Franthon")

    def test_hints_describe_the_writer(self):
        p = Profile()
        raw = page("Franthon", "x")
        p.learn_note("n1", raw, raw, page("Transition", "curiosity"))
        text = p.hints()
        self.assertIn('"7" is their shorthand for "of"', text)
        self.assertIn("transition", text)
        self.assertIn('"franthon" is really "Transition"', text)


class StyleStatsTests(unittest.TestCase):
    def test_counts(self):
        pg = page("one two", "three")
        pg["elements"][0]["underline"] = True
        pg["links"] = [{"id": "l", "kind": "connector", "from": "t0", "to": "t1", "label": "to"}]
        s = style_stats([pg])
        self.assertEqual((s["pages"], s["text_nodes"], s["underline_rate"], s["words_per_node"]), (1, 2, 0.5, 1.5))
        self.assertEqual(s["link_kinds"], {"connector": 1})
        self.assertEqual(s["connector_words"], ["to"])

    def test_no_pages(self):
        self.assertEqual(style_stats([])["links_per_page"], 0)


if __name__ == "__main__":
    unittest.main()
