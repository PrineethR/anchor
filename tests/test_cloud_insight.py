"""Make sense of a page, in node against a pretend Google: what Gemini reads, what is kept of what it says, and what the screen shows."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from baselines.try_gemini import PRICES

ROOT = Path(__file__).resolve().parent.parent


def item(i, text, ids=None, **kw):
    return {"id": i, "ids": ids or [i], "text": text, "underline": False, "caps": False, "action": False, "via": None, "ref": False, "children": [], **kw}


def via(kind="flow", label="", **kw):
    return {"kind": kind, "label": label, "caps": False, "underline": False, **kw}


# Transition -(TRY TO)-> core -> peripheral units (see above: points back) ; core aside: a thought ; a loose group with a to-do and a stressed word
SENSE = {
    "threads": [{"ids": ["t1", "t2", "t3", "t4"], "size": 4, "roots": [
        item("t1", "Transition", underline=True, children=[
            item("t2", "core", caps=True, via=via("connector", "TRY TO"), children=[
                item("t3", "peripheral units", via=via(), children=[item("t1", "Transition", via=via(), ref=True)]),
                item("t4", "a passing thought", via=via("hook"))])])]}],
    "loose": [{"items": [item("t5", "call the printer", action=True), item("t6", "proof by Friday")]}, {"items": [item("s1", "PLAY", ids=["s1", "t7", "t8"], caps=True)]}],
    "actions": [{"id": "t5", "text": "call the printer", "cue": "call"}],
}
ANSWER = {"candidates": [{"content": {"parts": [{"text": json.dumps({
    "summary": "A page about how the core connects to its edges.",
    "how_it_fits": [{"text": "Transition leads to the core, which you tied to it with TRY TO.", "cites": ["t1", "t2"]}, {"text": "An unsupported claim.", "cites": ["zz"]}],
    "open_questions": [{"text": "Where does peripheral units lead?", "cites": ["t3"]}],
    "suggested_next_steps": [{"text": "Call the printer", "cites": ["t5"]}, {"text": "Draft what peripheral units would connect to.", "cites": ["t3"]}]})}]}}],
    "usageMetadata": {"promptTokenCount": 1500, "candidatesTokenCount": 500, "thoughtsTokenCount": 0}}


@unittest.skipUnless(shutil.which("node"), "needs node")
class InsightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"sense": SENSE, "answer": ANSWER, "prices": PRICES}, f)
        try:
            run = subprocess.run(["node", str(ROOT / "tests/js/insight.mjs"), f.name], capture_output=True, text=True, cwd=ROOT)
        finally:
            Path(f.name).unlink()
        assert run.returncode == 0, run.stderr[-2000:]
        cls.out = json.loads(run.stdout.strip().splitlines()[-1])

    def test_the_outline_is_what_gemini_reads_with_an_id_on_every_idea(self):
        self.assertEqual(self.out["outline"].splitlines(), [
            "THREADS", "Thread 1",
            "  [t1] Transition (UNDERLINED)",
            "    -(TRY TO)-> [t2] core (CAPITALS)",
            "      -> [t3] peripheral units",
            "        -> [t1] Transition (see above)",
            "      aside: [t4] a passing thought",
            "LOOSE NOTES", "Group 1",
            "  [t5] call the printer [to-do]", "  [t6] proof by Friday",
            "Group 2", "  [s1] PLAY (CAPITALS)"])
        self.assertIn(["s1", ["s1", "t7", "t8"]], self.out["known"], "a shape stands for the words inside it")
        self.assertFalse(self.out["empty"])
        self.assertTrue(self.out["emptyPage"])

    def test_the_fingerprint_follows_the_words(self):
        self.assertTrue(self.out["keySame"])
        self.assertTrue(self.out["keyChanges"])

    def test_the_request_is_text_only_and_says_how_to_behave(self):
        r = self.out["request"]
        self.assertEqual(r["parts"], [["text"]], "no photo goes with it")
        self.assertIn("THE PAGE", r["text"])
        self.assertIn("About this writer", r["text"])
        self.assertIn("[t2] core", r["text"])
        self.assertTrue(r["instructionsHaveRules"])
        self.assertEqual(r["thinking"], {"thinkingLevel": "low"})
        self.assertIsNone(r["cheaperThinking"])
        self.assertEqual((r["temp"], r["mime"]), (0.2, "application/json"))
        self.assertEqual(r["schemaKeys"], ["summary", "how_it_fits", "open_questions", "suggested_next_steps"])
        self.assertFalse(r["noHintsLine"])

    def test_only_what_is_tied_to_the_page_is_kept(self):
        c = self.out["clean"]
        self.assertEqual(c["summary"], "A page about things.")
        self.assertEqual([p["text"][:8] for p in c["how_it_fits"]], ["a leads ", "xxxxxxxx"], "uncited, unknown and empty points are dropped")
        self.assertEqual(c["how_it_fits"][0]["cites"], ["a", "b"], "ids that are not on the page go, repeats collapse")
        self.assertTrue(c["how_it_fits"][1]["text"].endswith("…") and len(c["how_it_fits"][1]["text"]) == 320, "long text is clipped")
        self.assertEqual(c["open_questions"], [], "a list that is not a list is nothing")
        steps = [p["text"] for p in c["suggested_next_steps"]]
        self.assertNotIn("Call the printer", steps, "a to-do you wrote is not 'suggested' back to you")
        self.assertNotIn("Please call the printer about the proof", steps)
        self.assertIn("Ask Sam about it", steps)
        self.assertNotIn("ask", steps)
        self.assertEqual(len(steps), 4, "at most four suggestions")
        self.assertGreater(c["dropped"], 4)

    def test_junk_in_the_lists_does_not_break_it_and_no_summary_is_an_error(self):
        self.assertEqual(self.out["cleanTolerant"], {"summary": "s", "how_it_fits": [], "open_questions": [], "suggested_next_steps": [], "dropped": 3})
        self.assertIn("no summary", self.out["noSummary"])

    def test_a_good_answer_is_kept_with_its_fingerprint_and_cost(self):
        r = self.out["good"]["ok"]
        self.assertEqual(r["model"], "gemini-3.6-flash")
        self.assertAlmostEqual(r["usd"], (1500 * 0.75 + 500 * 3.75) / 1e6)
        self.assertEqual([p["text"][:10] for p in r["insight"]["how_it_fits"]], ["Transition"], "the unsupported claim is gone")
        self.assertEqual([p["text"] for p in r["insight"]["suggested_next_steps"]], ["Draft what peripheral units would connect to."])
        self.assertIn("generateContent", self.out["goodUrl"])
        self.assertTrue(self.out["goodBody"].endswith("[s1] PLAY (CAPITALS)"))

    def test_failures_say_what_to_do_and_an_empty_page_never_reaches_google(self):
        o = self.out
        self.assertEqual((o["nokey"]["kind"], o["nokey"]["calls"]), ("nokey", 0))
        self.assertIn("make sense of pages", o["nokey"]["error"])
        self.assertEqual((o["quota"]["kind"], o["quota"]["calls"]), ("quota", 1))
        self.assertEqual(o["offline"]["kind"], "offline")
        self.assertEqual(o["notJson"]["kind"], "bad")
        self.assertEqual(o["emptyPageError"]["calls"], 0)
        self.assertIn("nothing on this page", o["emptyPageError"]["error"])

    def test_a_summary_with_nothing_else_tied_to_the_page_is_still_a_summary(self):
        r = self.out["uncitedOnly"]["ok"]["insight"]
        self.assertEqual((r["summary"], r["how_it_fits"], r["dropped"]), ("Only a summary.", [], 1))

    def test_the_screen_gets_the_pages_own_ids_to_highlight_and_the_to_dos_you_wrote(self):
        v = self.out["view"]
        self.assertEqual(v["fits"], [{"text": "Transition leads to the core, which you tied to it with TRY TO.", "ids": ["t1", "t2"]}])
        self.assertEqual(v["written"], [{"text": "call the printer", "ids": ["t5"]}])
        self.assertFalse(v["stale"])
        self.assertTrue(self.out["viewStale"], "change the words and it says so")


if __name__ == "__main__":
    unittest.main()
