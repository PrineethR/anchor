"""Try the Gemini reader on the sample page and set its scores beside Apple Vision's.

    read -rs GEMINI_API_KEY && export GEMINI_API_KEY      # paste the key, press Return; it is not shown or saved
    .venv/bin/python -m baselines.try_gemini               # sends data/labeled/page-01.jpg, the public sample page, to Google
    .venv/bin/python -m baselines.try_gemini --list-models # which models your key may use
    .venv/bin/python -m baselines.try_gemini --model gemini-2.5-flash

Only the sample page is sent, never your own notes. Gemini's answer is scored against the hand-made labels in
data/labeled/page-01.json by the same harness that scored Apple Vision (reports/vision), so the two columns are comparable.
Stdlib only.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

from harness import run as harness_run

from . import gemini

# (section, metric, what it means, higher is better)
ROWS = [
    ("text", "detection_f1", "words and phrases found", True),
    ("text", "cer_end_to_end", "letters wrong (share of the page's letters)", False),
    ("links", "top1_r", "arrows found", True),
    ("links", "top1_p", "arrows it drew that are real", True),
    ("links", "top1_f1", "arrows overall (F1)", True),
    ("links", "reversed", "arrows pointing the wrong way", False),
    ("emphasis", "underline_f1", "underlines", True),
    ("emphasis", "caps_f1", "words in capitals", True),
    ("emphasis", "shape_f1", "circles and boxes", True),
]
# USD per 1M tokens, paid tier, as Google's pricing page stated on 2026-10-26 (input for images, output including thinking).
# Introductory prices are used where one is running; they change, so treat the cost line as an estimate and check ai.google.dev/gemini-api/docs/pricing.
PRICES = {
    "gemini-2.5-flash-lite": (0.10, 0.40), "gemini-3.1-flash-lite": (0.25, 1.50), "gemini-3.5-flash-lite": (0.30, 2.50),
    "gemini-2.5-flash": (0.30, 2.50), "gemini-3-flash-preview": (0.50, 3.00), "gemini-3.6-flash": (0.75, 3.75), "gemini-3.8-flash": (0.75, 3.75),
    "gemini-2.5-pro": (1.25, 10.00), "gemini-3.1-pro-preview": (2.00, 12.00), "gemini-4-argon": (2.00, 10.00),
}


def cost(model: str, usage: dict) -> float | None:
    """Estimated dollars for one request at list price, or None if the model's price is not known here."""
    if model not in PRICES or not usage:
        return None
    price_in, price_out = PRICES[model]
    out_tokens = usage.get("candidatesTokenCount", 0) + usage.get("thoughtsTokenCount", 0)   # thinking is billed as output
    return (usage.get("promptTokenCount", 0) * price_in + out_tokens * price_out) / 1_000_000


thinking_config = gemini.thinking_config


GET_A_KEY = """\
No Gemini key found. To get one:
  1. Open https://aistudio.google.com/apikey and sign in with a Google account.
  2. Press "Create API key" (choose or create a project when it asks).
  3. In Terminal, in the project folder:   read -rs GEMINI_API_KEY && export GEMINI_API_KEY
     then paste the key and press Return (nothing shows as you paste; it lasts until you close that Terminal window).
  4. Run this again.
Nothing is sent anywhere until you do."""


def list_models(key: str) -> int:
    url = f"https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key={key}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            models = json.load(r).get("models", [])
    except urllib.error.HTTPError as e:
        print(f"Google answered {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
        return 1
    names = sorted(m["name"].removeprefix("models/") for m in models if "generateContent" in m.get("supportedGenerationMethods", []))
    print("Models this key can use for reading a page:\n  " + "\n  ".join(names))
    print("\nTry one with:  .venv/bin/python -m baselines.try_gemini --model NAME")
    return 0


def cell(v) -> str:
    return "n/a" if v is None else (f"{v:.0%}" if isinstance(v, float) else str(v))


def table(vision: dict, mine: dict) -> str:
    lines = [f"{'':46s} {'Apple Vision':>12s} {'Gemini':>8s}", "-" * 68]
    for section, metric, what, _ in ROWS:
        cells = []
        for scores in (vision, mine):
            v = scores.get(section, {}).get(metric)
            if metric == "top1_p" and not scores.get("links", {}).get("top1_r"):
                v = None   # the harness calls "none drawn" 100% precise; to a reader that is not a score
            cells.append(cell(v))
        lines.append(f"{what:46s} {cells[0]:>12s} {cells[1]:>8s}")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=os.environ.get("GEMINI_MODEL", gemini.DEFAULT_MODEL))
    ap.add_argument("--list-models", action="store_true")
    ap.add_argument("--thinking", help="how much the model may think before answering: 0 or a token budget (2.5 models), or minimal/low/medium/high (3 and later). Thinking is billed as output")
    ap.add_argument("--resolution", choices=["low", "medium", "high"], help="how many tokens the photo costs (Gemini 3 and later: about 280, 560, 1120)")
    ap.add_argument("--pages", default="data/labeled", help="where the sample page photo is")
    ap.add_argument("--gold", default="data/labeled", help="its hand-made labels")
    ap.add_argument("--out", default="data/baselines/gemini", help="where Gemini's answer is written")
    ap.add_argument("--reports", default="reports/gemini")
    ap.add_argument("--vision", default="reports/vision/report.json", help="the Apple Vision scores to set it beside")
    a = ap.parse_args(argv)

    key = gemini.get_key()
    if not key:
        print(GET_A_KEY, file=sys.stderr)
        return 1
    if a.list_models:
        return list_models(key)

    gemini.GEN_CONFIG.clear()
    if a.thinking is not None:
        gemini.GEN_CONFIG["thinkingConfig"] = thinking_config(a.thinking)
    if a.resolution:
        gemini.GEN_CONFIG["mediaResolution"] = f"MEDIA_RESOLUTION_{a.resolution.upper()}"
    print(f"Sending the sample page ({a.pages}/page-01.jpg, not your notes) to Google, model {a.model}…")
    if gemini.main(["--pages", a.pages, "--out", a.out, "--model", a.model, "--only", "page-01", "--force"]):
        print("\nIt did not work. If the message above says the model was not found or is not allowed, "
              "run with --list-models to see which your key can use.", file=sys.stderr)
        return 1
    with contextlib.redirect_stdout(io.StringIO()):
        harness_run.main(["--gold", a.gold, "--pred", a.out, "--out", a.reports])
    mine = json.loads((Path(a.reports) / "report.json").read_text())["summary"]
    vision = json.loads(Path(a.vision).read_text())["summary"] if Path(a.vision).exists() else {}
    print("\n" + table(vision, mine))
    u = gemini.LAST_USAGE
    if u:
        dollars = cost(a.model, u)
        print(f"\nOne page used {u.get('promptTokenCount', 0):,} tokens in and {u.get('candidatesTokenCount', 0):,} out"
              f" (+ {u.get('thoughtsTokenCount', 0):,} thinking)" + (f", about ${dollars:.4f} at list price (free on the free tier)." if dollars is not None else "."))
    print(f"\nGemini's raw answer: {a.out}/raw/page-01.json      Its misses, one by one: {a.reports}/report.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
