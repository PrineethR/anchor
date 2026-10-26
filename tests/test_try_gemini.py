"""The one-command Gemini test: it explains itself without a key, and with an answer in hand it prints the comparison."""

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from baselines import gemini, try_gemini

ROOT = Path(__file__).resolve().parent.parent
GOLD = json.loads((ROOT / "data/labeled/page-01.json").read_text())


def run(argv, key="test-key", answer=None):
    env = {"GEMINI_API_KEY": key} if key else {}
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env, clear=False), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        if not key:
            os.environ["GEMINI_API_KEY"] = ""
        with mock.patch.object(gemini, "call_gemini", return_value=json.dumps(answer) if answer is not None else "{}"):
            code = try_gemini.main(argv)
    return code, out.getvalue(), err.getvalue()


class TryGeminiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.argv = ["--out", f"{self.tmp.name}/answer", "--reports", f"{self.tmp.name}/reports"]

    def test_without_a_key_it_says_how_to_get_one_and_sends_nothing(self):
        with mock.patch.object(gemini, "post") as post:
            code, out, err = run(self.argv, key=None)
        self.assertEqual(code, 1)
        self.assertIn("aistudio.google.com/apikey", err)
        self.assertIn("read -rs GEMINI_API_KEY", err)
        post.assert_not_called()

    def test_a_perfect_answer_scores_perfectly_beside_the_vision_column(self):
        code, out, err = run(self.argv, answer=gemini.from_page(GOLD))
        self.assertEqual(code, 0, err)
        self.assertIn("Sending the sample page", out)
        row = lambda what: next(l for l in out.splitlines() if l.startswith(what))
        self.assertIn("0%", row("arrows found"))          # Apple Vision found none
        self.assertIn("100%", row("arrows found"))        # this answer found all
        self.assertIn("100%", row("words and phrases found"))
        self.assertTrue((Path(self.tmp.name) / "answer" / "raw" / "page-01.json").exists())
        self.assertTrue((Path(self.tmp.name) / "reports" / "report.md").exists())

    def test_an_answer_with_no_arrows_shows_as_no_arrows(self):
        raw = gemini.from_page(GOLD)
        raw["links"] = []
        code, out, err = run(self.argv, answer=raw)
        self.assertEqual(code, 0, err)
        found = next(l for l in out.splitlines() if l.startswith("arrows found"))
        self.assertEqual(found.split()[-1], "0%")

    def test_a_refused_model_points_at_the_model_list(self):
        with mock.patch.object(gemini, "call_gemini", side_effect=RuntimeError("404: model not found")):
            out, err = io.StringIO(), io.StringIO()
            with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "k"}), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = try_gemini.main(self.argv)
        self.assertEqual(code, 1)
        self.assertIn("--list-models", err.getvalue())

    def test_what_a_page_costs_is_worked_out_from_the_tokens_google_reports(self):
        usage = {"promptTokenCount": 2000, "candidatesTokenCount": 1000, "thoughtsTokenCount": 3000}
        self.assertAlmostEqual(try_gemini.cost("gemini-2.5-flash", usage), (2000 * 0.30 + 4000 * 2.50) / 1e6)   # thinking is billed as output
        self.assertIsNone(try_gemini.cost("a-model-nobody-priced", usage))
        self.assertIsNone(try_gemini.cost("gemini-2.5-flash", {}))

    def test_thinking_is_a_budget_for_older_models_and_a_level_for_newer_ones(self):
        self.assertEqual(try_gemini.thinking_config("0"), {"thinkingBudget": 0})
        self.assertEqual(try_gemini.thinking_config("1024"), {"thinkingBudget": 1024})
        self.assertEqual(try_gemini.thinking_config("low"), {"thinkingLevel": "low"})

    def test_the_options_reach_the_request(self):
        sent = {}
        with mock.patch.object(gemini, "call_gemini", side_effect=lambda *a, **k: (sent.update(gemini.build_body(a[0])), json.dumps(gemini.from_page(GOLD)))[1]), \
                mock.patch.dict(os.environ, {"GEMINI_API_KEY": "k"}), contextlib.redirect_stdout(io.StringIO()):
            try_gemini.main(self.argv + ["--thinking", "low", "--resolution", "high"])
        self.assertEqual(sent["generationConfig"]["thinkingConfig"], {"thinkingLevel": "low"})
        self.assertEqual(sent["generationConfig"]["mediaResolution"], "MEDIA_RESOLUTION_HIGH")
        gemini.GEN_CONFIG.clear()

    def test_the_model_list_shows_only_models_that_can_read_a_page(self):
        body = json.dumps({"models": [{"name": "models/gemini-x-pro", "supportedGenerationMethods": ["generateContent"]},
                                      {"name": "models/embedding-y", "supportedGenerationMethods": ["embedContent"]}]}).encode()
        fake = mock.MagicMock()
        fake.__enter__.return_value = io.BytesIO(body)
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "k"}), mock.patch("urllib.request.urlopen", return_value=fake), contextlib.redirect_stdout(out):
            code = try_gemini.main(["--list-models"])
        self.assertEqual(code, 0)
        self.assertIn("gemini-x-pro", out.getvalue())
        self.assertNotIn("embedding-y", out.getvalue())


if __name__ == "__main__":
    unittest.main()
