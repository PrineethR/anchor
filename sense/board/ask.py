"""Ask Claude: one request to Claude Code in headless mode, on the login already on this Mac (your subscription, not an API key).

Claude gets the board as JSON and your request, and answers with new sticky notes and arrows as JSON. It never edits or
deletes what is there: the answer is only things to add. The browser places them in empty space as one undo step.
Every run is logged to boards/.usage.jsonl so the cost of using it can be seen over a few days.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timedelta
from pathlib import Path

from . import schema

MODELS = {"haiku": "Haiku: fastest, cheapest", "sonnet": "Sonnet: balanced", "opus": "Opus: strongest, slowest"}
DEFAULT_MODEL = "haiku"
TIMEOUT = 180
MAX_OBJECTS = 300          # objects sent to the model
MAX_NOTES = 12
# Variables that would make Claude Code bill an API account instead of using the logged-in subscription.
BILLING_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY")

SYSTEM = (
    "You help on a sticky-note whiteboard. Reply with ONE JSON object and nothing else (no prose, no code fences): "
    '{"notes":[{"id":"a","text":"...","color":"light_yellow"}],"links":[{"from":"a","to":"b","label":""}],"say":"one short sentence"}. '
    f"'notes' are NEW sticky notes: at most {MAX_NOTES}, each under 25 words; 'color' is optional, one of: {', '.join(schema.STICKY)}. "
    "'links' are arrows; 'from' and 'to' are the id of a new note or of an object already on the board. "
    "Only add. Never change, move or delete anything that is already there. Do not repeat what is on the board."
)


def find_claude() -> str | None:
    env = os.environ.get("ANCHOR_CLAUDE_BIN")
    if env:
        return env
    home = Path.home()
    for c in (shutil.which("claude"), home / ".claude/local/claude", home / ".local/bin/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"):
        if c and Path(c).is_file():
            return str(c)
    return None


def condense(board: dict, selected: list[str]) -> str:
    """The board as a small piece of JSON: what each thing says and where it is."""
    objs = board["objects"]
    sel = set(selected)
    if sel:
        objs = [o for o in objs if o["id"] in sel or o["type"] == "connector"]
    out = []
    for o in objs[:MAX_OBJECTS]:
        if o["type"] == "connector":
            a, b = (o.get("from") or {}).get("id"), (o.get("to") or {}).get("id")
            if a and b:
                out.append({"id": o["id"], "arrow": [a, b], **({"label": o["label"]} if o.get("label") else {})})
            continue
        item = {"id": o["id"], "type": o["type"], "x": round(o["x"]), "y": round(o["y"])}
        t = o.get("text") or o.get("title") or o.get("name") or o.get("url") or ""
        if t:
            item["text"] = t[:200]
        out.append(item)
    return json.dumps(out, ensure_ascii=False, separators=(",", ":"))


def child_env() -> dict:
    env = {k: v for k, v in os.environ.items() if k not in BILLING_VARS}   # ANTHROPIC_BASE_URL stays: the Claude app signs in through it
    env["NO_COLOR"] = "1"
    return env


def run_claude(prompt: str, model: str, claude: str | None = None) -> dict:
    """Run Claude Code once. Returns its JSON result (text, usage, cost). Raises ValueError with a readable message."""
    claude = claude or find_claude()
    if not claude:
        raise ValueError("Claude Code isn't installed on this Mac. Install it, then run `claude auth login` once in a terminal.")
    cmd = [claude, "-p", "--model", model, "--output-format", "json", "--tools", "", "--no-session-persistence",
           "--setting-sources", "", "--append-system-prompt", SYSTEM]
    try:
        with tempfile.TemporaryDirectory() as cwd:
            p = subprocess.run(cmd, input=prompt, capture_output=True, text=True, timeout=TIMEOUT, env=child_env(), cwd=cwd)
    except subprocess.TimeoutExpired:
        raise ValueError(f"Claude took longer than {TIMEOUT} seconds, so I stopped it.")
    except OSError as e:
        raise ValueError(f"Claude Code couldn't be started ({e}).")
    try:
        res = json.loads(p.stdout)
    except ValueError:
        res = None
    if not isinstance(res, dict):
        raise ValueError(_why((p.stderr or p.stdout or "no answer").strip()))
    if res.get("is_error") or p.returncode:
        raise ValueError(_why(str(res.get("result") or p.stderr or "it failed")))
    return res


def _why(text: str) -> str:
    if re.search(r"auth|log ?in|sign|expired|credential|401", text, re.I):
        return "Claude Code isn't signed in on this Mac. Run `claude auth login` in a terminal, then try again."
    return f"Claude said: {text[:300]}"


def parse(text: str) -> dict:
    """The JSON object in a reply, even if it came with a code fence or a sentence around it."""
    a, b = text.find("{"), text.rfind("}")
    try:
        data = json.loads(text[a:b + 1]) if a >= 0 < b else None
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise ValueError("Claude's answer wasn't something I could place on the board. Try again, or ask more simply.")
    return data


def to_objects(data: dict, known: set[str]) -> list[dict]:
    """New stickies in a small grid at the origin, and arrows between them or to existing things. The browser moves the grid."""
    notes, links = (data.get(k) if isinstance(data.get(k), list) else [] for k in ("notes", "links"))
    notes = [n for n in notes if isinstance(n, dict) and str(n.get("text", "")).strip()][:MAX_NOTES]
    ids: dict[str, str] = {}
    objs: list[dict] = []
    for i, n in enumerate(notes):
        oid = "ai" + secrets.token_hex(4)
        ids[str(n.get("id", i))] = oid
        color = n.get("color") if isinstance(n.get("color"), str) and n["color"] in schema.STICKY else "light_yellow"
        objs.append({"id": oid, "type": "sticky", "x": (i % 4) * 210, "y": (i // 4) * 210, "w": 180, "h": 180, "text": str(n["text"]).strip()[:300], "color": color})
    for link in links[:30]:
        if not isinstance(link, dict):
            continue
        a, b = (ids.get(str(link.get(k))) or (link.get(k) if link.get(k) in known else None) for k in ("from", "to"))
        if a and b and a != b:
            objs.append({"id": "ai" + secrets.token_hex(4), "type": "connector", "from": {"id": a, "side": "auto"}, "to": {"id": b, "side": "auto"},
                         "shape": "curved", "label": str(link.get("label") or "")[:60]})
    return schema.clean_objects(objs)


def ask(boards, bid: str, prompt: str, model: str, selected: list, claude: str | None = None) -> dict:
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("Say what you'd like Claude to do.")
    if model not in MODELS:
        model = DEFAULT_MODEL
    board = boards.load(bid)
    sel = [s for s in selected if isinstance(s, str)][:500]
    known = {o["id"] for o in board["objects"]}
    full = f"{prompt[:2000]}\n\n{'Only these objects are selected; work on them.' if sel else 'No selection; work on the whole board.'}\nBoard objects:\n{condense(board, sel)}"
    t0 = time.time()
    res = run_claude(full, model, claude)
    data = parse(str(res.get("result") or ""))
    objs = to_objects(data, known)
    use = res.get("usage") or {}
    entry = {"t": datetime.now().isoformat(timespec="seconds"), "board": bid, "model": model, "prompt": prompt[:2000], "say": str(data.get("say") or "")[:300],
             "in": int(use.get("input_tokens") or 0) + int(use.get("cache_creation_input_tokens") or 0) + int(use.get("cache_read_input_tokens") or 0),
             "out": int(use.get("output_tokens") or 0), "cost": round(float(res.get("total_cost_usd") or 0), 5), "secs": round(time.time() - t0, 1), "notes": sum(o["type"] == "sticky" for o in objs)}
    log_run(boards.root, entry)
    return {"objects": objs, "say": str(data.get("say") or "")[:300], "usage": entry}


# --- the usage log -----------------------------------------------------------------------------

def log_run(root: Path, entry: dict) -> None:
    try:
        with open(root / ".usage.jsonl", "a") as f:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")
    except OSError:
        pass


def history(root: Path, limit: int = 100) -> list[dict]:
    """Past requests, newest first."""
    return _runs(root)[-limit:][::-1]


def _runs(root: Path) -> list[dict]:
    runs = []
    try:
        for line in (root / ".usage.jsonl").read_text().splitlines():
            try:
                runs.append(json.loads(line))
            except ValueError:
                pass
    except OSError:
        pass
    return runs


def usage(root: Path) -> dict:
    runs = _runs(root)

    def total(rs):
        return {"runs": len(rs), "in": sum(r.get("in", 0) for r in rs), "out": sum(r.get("out", 0) for r in rs), "cost": round(sum(r.get("cost", 0) for r in rs), 4)}
    now = datetime.now()
    day, week = now.strftime("%Y-%m-%d"), (now - timedelta(days=7)).isoformat()
    return {"models": MODELS, "default": DEFAULT_MODEL, "today": total([r for r in runs if str(r.get("t", "")).startswith(day)]),
            "week": total([r for r in runs if str(r.get("t", "")) >= week]), "last": runs[-5:][::-1]}
