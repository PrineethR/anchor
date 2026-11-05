#!/usr/bin/env python3
"""A stand-in for `claude -p` for the browser tests: answers with three notes, the first linked to the first object on the board."""
import json
import sys

stdin = sys.stdin.read()
objs = json.loads(stdin.split("Board objects:\n", 1)[1]) if "Board objects:" in stdin else []
first = next((o["id"] for o in objs if "arrow" not in o), None)
reply = {"notes": [{"id": "a", "text": "A cheaper version"}, {"id": "b", "text": "Try it with five users", "color": "light_blue"}, {"id": "c", "text": "What if it were a game?"}],
         "links": ([{"from": first, "to": "a"}] if first else []) + [{"from": "a", "to": "b"}], "say": "Three ideas."}
print(json.dumps({"type": "result", "is_error": False, "result": json.dumps(reply), "usage": {"input_tokens": 50, "output_tokens": 40}, "total_cost_usd": 0.001}))
