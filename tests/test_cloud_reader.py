"""The website's Gemini reader, run in node against a pretend Google: what it sends, how it fails, what it keeps."""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from baselines import gemini
from baselines.try_gemini import PRICES

ROOT = Path(__file__).resolve().parent.parent
GOLD = json.loads((ROOT / "data/labeled/page-01.json").read_text())


def answer(raw, usage=None):
    return {"candidates": [{"content": {"parts": [{"text": json.dumps(raw)}]}}],
            "usageMetadata": usage or {"promptTokenCount": 1536, "candidatesTokenCount": 2343, "thoughtsTokenCount": 0}}


def fixtures():
    good = gemini.from_page(GOLD)
    sideways = {**gemini.from_page(GOLD), "page_rotation": "90"}
    upside = {**gemini.from_page(GOLD), "page_rotation": "180"}
    odd = {"page_rotation": "0", "elements": [
        {"id": "a", "type": "text", "text": "  one ", "box_2d": [900, 800, 100, 100]},      # corners the wrong way round
        {"id": "a", "type": "text", "text": "same id", "box_2d": [0, 0, 50, 50]},          # a repeated id
        {"id": "b", "type": "text", "text": "   ", "box_2d": [0, 0, 5, 5]},                # nothing written
        {"id": "c", "type": "text", "text": "off the page", "box_2d": [-50, 990, 2000, 4000]},
        {"id": "d", "type": "text", "text": "bad box", "box_2d": [1, 2, 3]},
        {"id": "e", "type": "scribble", "box_2d": [1, 2, 30, 40]},
        {"id": "s", "type": "shape", "box_2d": [10, 10, 400, 400], "contains": ["a", "s", "nope"]}],
        "links": [{"id": "l1", "kind": "flow", "from": "a", "to": "a_"}, {"id": "l2", "kind": "flow", "from": "a", "to": "ghost"},
                  {"id": "l3", "kind": "connector", "from": "s", "to": "a", "label": " TO ", "caps": True, "from_alt": "a_", "confidence": 0.4}]}
    return {"good": answer(good), "sideways": answer(sideways), "upsideDown": answer(upside), "odd": answer(odd)}


@unittest.skipUnless(shutil.which("node"), "needs node")
class ReaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"reader": {"prompt": gemini.PROMPT, "schema": gemini.RESPONSE_SCHEMA, "prices": PRICES, "grid": gemini.GRID}, **fixtures()}, f)
        try:
            run = subprocess.run(["node", str(ROOT / "tests/js/reader.mjs"), f.name], capture_output=True, text=True, cwd=ROOT)
        finally:
            Path(f.name).unlink()
        assert run.returncode == 0, run.stderr[-2000:]
        cls.out = json.loads(run.stdout.strip().splitlines()[-1])

    def test_without_a_key_it_asks_for_one_and_calls_nobody(self):
        r = self.out["nokey"]
        self.assertEqual((r["kind"], r["calls"]), ("nokey", []))
        self.assertFalse(self.out["hasKeyBefore"])

    def test_the_key_and_the_choice_are_kept_trimmed_and_forgettable(self):
        self.assertEqual(self.out["settings"], {"key": "AIza-test-key", "preset": "better"})
        self.assertTrue(self.out["hasKeyAfter"])
        self.assertEqual(self.out["badPreset"], "better")
        self.assertFalse(self.out["afterForget"])

    def test_it_sends_what_the_python_sends_plus_how_you_write(self):
        s = self.out["sent"]
        self.assertEqual(s["url"], "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent")
        self.assertEqual(s["key"], "k")          # in a header, never in the address
        self.assertEqual(s["thinking"], {"thinkingLevel": "low"})
        self.assertEqual(s["temp"], 0)
        self.assertTrue(s["endsWithHints"])
        self.assertEqual(s["image"], "image/jpeg")

    def test_a_good_answer_becomes_a_page_with_arrows_and_a_cost(self):
        r = self.out["good"]["ok"]
        self.assertEqual(r["rotation"], 0)
        self.assertEqual(len(r["page"]["links"]), len(GOLD["links"]))
        self.assertEqual(r["page"]["page_size"], [2000, 1000])
        self.assertEqual(r["model"], "gemini-3.6-flash")
        self.assertAlmostEqual(r["usd"], (1536 * 0.75 + 2343 * 3.75) / 1e6)
        self.assertTrue(all(isinstance(l["from"], str) and isinstance(l["to"], str) for l in r["page"]["links"]), "ends are plain ids")

    def test_a_model_this_key_cannot_use_falls_through_to_the_next(self):
        r = self.out["model_not_allowed_then_next"]
        self.assertEqual(r["calls"], ["gemini-3.6-flash", "gemini-3.8-flash"])
        self.assertIn("ok", r)
        self.assertEqual(r["ok"]["model"], "gemini-3.8-flash")

    def test_every_failure_says_what_to_do(self):
        o = self.out
        self.assertEqual(o["every_model_missing"]["kind"], "model")
        self.assertEqual(len(o["every_model_missing"]["calls"]), 3)
        self.assertEqual((o["bad_key"]["kind"], o["bad_key"]["calls"]), ("key", ["gemini-3.6-flash"]))
        self.assertIn("Settings", o["bad_key"]["error"])
        self.assertEqual(o["forbidden"]["kind"], "key")
        self.assertEqual((o["quota"]["kind"], len(o["quota"]["calls"])), ("quota", 1))   # no hammering a limit
        self.assertIn("billing", o["quota"]["error"])
        self.assertEqual(o["offline"]["kind"], "offline")
        self.assertEqual(o["too_slow"]["kind"], "timeout")
        self.assertEqual(o["not_json"]["kind"], "bad")

    def test_a_busy_google_is_asked_again(self):
        r = self.out["busy_then_ok"]
        self.assertEqual(r["calls"], ["gemini-3.6-flash", "gemini-3.6-flash"])
        self.assertIn("ok", r)

    def test_a_sideways_photo_is_turned_so_the_boxes_line_up_with_the_turned_photo(self):
        side, base = self.out["sideways"]["ok"], self.out["good"]["ok"]
        self.assertEqual(side["rotation"], 90)
        self.assertEqual(side["page"]["page_size"], [1000, 2000], "a quarter turn swaps width and height")
        self.assertEqual(len(side["page"]["elements"]), len(base["page"]["elements"]))
        a0, a1 = base["page"]["elements"][0]["bbox"], side["page"]["elements"][0]["bbox"]
        # (x, y, w, h) on 2000x1000 becomes (H - y - h, x, h, w) on 1000x2000, to one decimal place
        self.assertEqual([round(v, 1) for v in a1], [round(1000 - a0[1] - a0[3], 1), a0[0], a0[3], a0[2]])
        up = self.out["upside_down"]["ok"]
        self.assertEqual((up["rotation"], up["page"]["page_size"]), (180, [2000, 1000]))

    def test_odd_answers_keep_what_can_be_kept_and_drop_the_rest(self):
        page = self.out["odd_boxes"]["ok"]["page"]
        ids = [e["id"] for e in page["elements"]]
        self.assertEqual(ids, ["a", "a_", "c", "s"])
        self.assertEqual(page["elements"][0]["text"], "one")
        self.assertEqual(page["elements"][0]["bbox"], [100.0, 100.0, 700.0, 800.0], "corners given the wrong way round are put right")
        self.assertEqual(next(e for e in page["elements"] if e["id"] == "s")["contains"], ["a"])
        self.assertEqual([l["id"] for l in page["links"]], ["l1", "l3"], "an arrow into something that is not there is dropped")
        self.assertEqual(page["links"][1]["label"], "TO")
        self.assertNotIn("confidence", page["links"][1])
        self.assertTrue(self.out["odd_boxes"]["ok"]["notes"])

    def test_the_cheaper_choice_does_not_ask_for_thinking_and_uses_its_own_model(self):
        self.assertEqual(self.out["cheaperRequest"], {"model": "gemini-3.5-flash-lite", "thinking": None})

    def test_checking_a_key_reads_nothing_and_explains_a_refusal(self):
        self.assertEqual(self.out["checkOk"], {"ok": True})
        self.assertFalse(self.out["checkBad"]["ok"])
        self.assertIn("Settings", self.out["checkBad"]["message"])
        self.assertIn("connection", self.out["checkOffline"]["message"])

    def test_money(self):
        c = self.out["cost"]
        self.assertAlmostEqual(c["known"], (1536 * 0.75 + 2343 * 3.75) / 1e6)
        self.assertAlmostEqual(c["thinkingIsOutput"], 2000 * 3.75 / 1e6)
        self.assertAlmostEqual(c["unknown"], 1.5)          # a model nobody priced is assumed dear
        self.assertIsNone(c["none"])
        self.assertEqual(self.out["rupees"], ["about ₹0.9", "about ₹19", "under ₹0.1", ""])

    def test_rotate_on_a_page_already_read_turns_it_in_pixels(self):
        once, four = self.out["turnOnce"], self.out["turnFour"]
        self.assertEqual(once["page_size"], [100, 200])
        self.assertEqual(once["elements"][0]["bbox"], [75.0, 10.0, 5, 30])   # (x, y, w, h) -> (H - y - h, x, h, w)
        self.assertEqual(four["page_size"], [200, 100])
        self.assertEqual(four["elements"][0]["bbox"], [10.0, 20.0, 30, 5], "four quarter turns is where it started")


if __name__ == "__main__":
    unittest.main()
