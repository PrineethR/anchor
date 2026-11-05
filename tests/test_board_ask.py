"""Ask Claude on the Board: the request to Claude Code (a scripted stand-in), turning its answer into notes, the rules, the usage log."""
import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sense.board import ask, schema
from tests.test_board import ApiCase, sticky

ANSWER = {"notes": [{"id": "a", "text": "Try a free week", "color": "pink"}, {"id": "b", "text": "Ask five users"}, {"text": "  "}, {"id": "c", "text": "Bad colour", "color": "plaid"}],
          "links": [{"from": "a", "to": "b", "label": "then"}, {"from": "a", "to": "s1"}, {"from": "a", "to": "nope"}, {"from": "a", "to": "a"}], "say": "Added two ideas."}


def fake(tmp, reply=None, result=None, code=0, stderr=""):
    """A `claude` that records how it was run and prints what Claude Code would."""
    out = result or {"type": "result", "is_error": False, "result": reply if reply is not None else json.dumps(ANSWER),
                     "usage": {"input_tokens": 100, "cache_read_input_tokens": 900, "output_tokens": 50}, "total_cost_usd": 0.0123}
    p = Path(tmp, "claude")
    p.write_text(f"#!/usr/bin/env python3\nimport sys, json, os\njson.dump({{'argv': sys.argv[1:], 'stdin': sys.stdin.read(), 'env': {{k: v for k, v in os.environ.items() if k.startswith('ANTHROPIC')}}}}, open({str(Path(tmp, 'seen.json'))!r}, 'w'))\n"
                 f"sys.stderr.write({stderr!r})\nprint(json.dumps({out!r}))\nsys.exit({code})\n")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


class ConversionTests(unittest.TestCase):
    def test_notes_become_stickies_and_links_become_arrows(self):
        objs = ask.to_objects(ANSWER, {"s1"})
        stickies = [o for o in objs if o["type"] == "sticky"]
        arrows = [o for o in objs if o["type"] == "connector"]
        self.assertEqual([s["text"] for s in stickies], ["Try a free week", "Ask five users", "Bad colour"])   # the empty one is dropped
        self.assertEqual([s["color"] for s in stickies], ["pink", "light_yellow", "light_yellow"])
        self.assertEqual(len(arrows), 2)                                                      # a to b, and a to the existing s1; unknown and self links are dropped
        self.assertEqual({a["to"]["id"] for a in arrows} - {stickies[1]["id"]}, {"s1"})
        self.assertEqual(arrows[0]["label"], "then")

    def test_garbage_in_the_answer_never_breaks_it(self):
        self.assertEqual(ask.to_objects({"notes": "x", "links": 3}, set()), [])
        self.assertEqual(len([o for o in ask.to_objects({"notes": [{"text": str(i)} for i in range(40)]}, set())]), ask.MAX_NOTES)

    def test_the_reply_can_have_a_fence_or_words_around_it(self):
        self.assertEqual(ask.parse('Sure!\n```json\n{"notes": []}\n```')["notes"], [])
        for bad in ("", "no json here", "{broken", "[1, 2]"):
            with self.assertRaises(ValueError):
                ask.parse(bad)

    def test_the_board_is_sent_short_and_selection_limits_it(self):
        board = {"objects": [sticky("a", text="x" * 500), sticky("b", text="two"), {"id": "c", "type": "connector", "from": {"id": "a"}, "to": {"id": "b"}, "label": "l"}]}
        full = json.loads(ask.condense(board, []))
        self.assertEqual((len(full), len(full[0]["text"]), full[2]["arrow"]), (3, 200, ["a", "b"]))
        self.assertEqual([o["id"] for o in json.loads(ask.condense(board, ["b"]))], ["b", "c"])


class AskApiTests(ApiCase):
    def setUp(self):
        super().setUp()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def run_with(self, binary, bid, body):
        with mock.patch.dict(os.environ, {"ANCHOR_CLAUDE_BIN": binary, "ANTHROPIC_API_KEY": "sk-should-not-reach-claude", "ANTHROPIC_BASE_URL": "http://proxy.test"}):
            return self.call("POST", f"/api/board/{bid}/ask", body)

    def test_it_asks_claude_on_the_login_and_returns_new_things_to_place(self):
        bid = self.new("T", [sticky("s1", text="Existing idea")])
        s, out, _ = self.run_with(fake(self.tmp.name), bid, {"prompt": "Expand this", "model": "sonnet", "selected": ["s1"]})
        self.assertEqual(s, 200, out)
        self.assertEqual((len([o for o in out["objects"] if o["type"] == "sticky"]), out["say"]), (3, "Added two ideas."))
        self.assertEqual((out["usage"]["model"], out["usage"]["in"], out["usage"]["out"], out["usage"]["cost"]), ("sonnet", 1000, 50, 0.0123))
        seen = json.loads(Path(self.tmp.name, "seen.json").read_text())
        self.assertEqual(seen["argv"][seen["argv"].index("--model") + 1], "sonnet")
        self.assertIn("Expand this", seen["stdin"])
        self.assertIn("Existing idea", seen["stdin"])
        self.assertEqual(seen["env"], {"ANTHROPIC_BASE_URL": "http://proxy.test"})        # the API key is taken away, the app's own sign-in route stays
        self.assertEqual(schema.clean_objects(out["objects"]), out["objects"])           # what comes back is already valid board objects
        self.assertEqual([o["text"] for o in self.bs.load(bid)["objects"]], ["Existing idea"])   # the server changed nothing; the browser adds them

    def test_an_unknown_model_falls_back_to_the_cheap_one_and_an_empty_request_is_refused(self):
        bid = self.new()
        self.run_with(fake(self.tmp.name), bid, {"prompt": "hi", "model": "gpt-9"})
        argv = json.loads(Path(self.tmp.name, "seen.json").read_text())["argv"]
        self.assertEqual(argv[argv.index("--model") + 1], "haiku")
        s, out, _ = self.run_with(fake(self.tmp.name), bid, {"prompt": "  "})
        self.assertEqual(s, 400)

    def test_problems_come_back_as_plain_messages(self):
        bid = self.new()
        s, out, _ = self.run_with(fake(self.tmp.name, result={"is_error": True, "result": "Failed to authenticate: OAuth session expired"}), bid, {"prompt": "x"})
        self.assertEqual((s, "claude auth login" in out["error"]), (400, True))
        s, out, _ = self.run_with(fake(self.tmp.name, reply="I would rather chat."), bid, {"prompt": "x"})
        self.assertEqual((s, "place on the board" in out["error"]), (400, True))
        s, out, _ = self.run_with(str(Path(self.tmp.name, "missing")), bid, {"prompt": "x"})
        self.assertEqual(s, 400)

    def test_every_run_is_logged_and_summed(self):
        bid = self.new()
        self.run_with(fake(self.tmp.name), bid, {"prompt": "one"})
        self.run_with(fake(self.tmp.name), bid, {"prompt": "two", "model": "opus"})
        self.run_with(fake(self.tmp.name, reply="nope"), bid, {"prompt": "failed runs are not logged"})
        u = self.ok("GET", "/api/board/usage")
        self.assertEqual((u["today"]["runs"], u["today"]["in"], u["today"]["out"], u["week"]["runs"], [r["model"] for r in u["last"]]), (2, 2000, 100, 2, ["opus", "haiku"]))
        self.assertEqual(set(u["models"]), {"haiku", "sonnet", "opus"})
        self.assertEqual(self.bs.list(), self.bs.list())      # the log file does not show up as a board
        self.assertEqual(len(self.bs.list()), 1)

    def test_usage_is_empty_before_anything_is_asked(self):
        u = self.ok("GET", "/api/board/usage")
        self.assertEqual((u["today"]["runs"], u["last"]), (0, []))


if __name__ == "__main__":
    unittest.main()
