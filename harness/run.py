"""Score a directory of predictions against a directory of gold labels.

    python -m harness.run                      # data/labeled vs data/preds
    python -m harness.run --gold G --pred P --out reports/
    python -m harness.run --validate           # only check gold label files

Gold and pred files pair up by filename (page-01.json <-> page-01.json).
A page with no prediction file is scored as an empty prediction.
Writes report.json and report.md to --out and prints the summary.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from .schema import Page, load_page, validate
from .score import score_page, summarize


def fmt(v):
    if v is None:
        return "n/a"
    if isinstance(v, float):
        return f"{v:.3f}"
    return str(v)


def render_md(summary: dict, per_page: list, when: str) -> str:
    lines = [f"# Harness report — {when}", "", f"Pages: {summary['pages']}", ""]
    for section in ("text", "links", "emphasis", "doodles"):
        lines += [f"## {section.capitalize()}", "", "| metric | value |", "|---|---|"]
        lines += [f"| {k} | {fmt(v)} |" for k, v in summary[section].items()]
        lines.append("")
    lines += ["## Per page", "", "| page | text F1 | CER | link F1 | top-2 R | underline F1 | caps F1 |", "|---|---|---|---|---|---|---|"]
    for pid, sm, _ in per_page:
        lines.append(
            f"| {pid} | {fmt(sm['text']['detection_f1'])} | {fmt(sm['text']['cer_end_to_end'])} | "
            f"{fmt(sm['links']['top1_f1'])} | {fmt(sm['links']['top2_recall'])} | "
            f"{fmt(sm['emphasis']['underline_f1'])} | {fmt(sm['emphasis']['caps_f1'])} |"
        )
    lines += ["", "## Errors", ""]
    for pid, _, errs in per_page:
        if errs:
            lines.append(f"### {pid}")
            lines += [f"- {e}" for e in errs]
            lines.append("")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", default="data/labeled")
    ap.add_argument("--pred", default="data/preds")
    ap.add_argument("--out", default="reports")
    ap.add_argument("--validate", action="store_true")
    a = ap.parse_args(argv)

    gold_files = sorted(Path(a.gold).glob("*.json"))
    if not gold_files:
        print(f"no gold labels in {a.gold}", file=sys.stderr)
        return 1

    bad = 0
    golds = []
    for f in gold_files:
        page = load_page(f)
        errs = validate(page, gold=True)
        if errs:
            bad += 1
            print(f"{f.name}:", *[f"  {e}" for e in errs], sep="\n")
        golds.append((f, page))
    if a.validate or bad:
        print(f"{len(gold_files) - bad}/{len(gold_files)} gold files valid")
        return 1 if bad else 0

    scores, per_page = [], []
    for f, gold in golds:
        pf = Path(a.pred) / f.name
        if pf.exists():
            pred = load_page(pf)
            for e in validate(pred, gold=False):
                print(f"warning {pf.name}: {e}", file=sys.stderr)
        else:
            pred = Page(gold.page_id, {}, [])
        s = score_page(gold, pred)
        scores.append(s)
        per_page.append((gold.page_id, summarize([s]), s.errors))

    summary = summarize(scores)
    when = datetime.now().strftime("%Y-%m-%d %H:%M")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "report.json").write_text(json.dumps(
        {"when": when, "summary": summary, "pages": {p: {"summary": sm, "errors": e} for p, sm, e in per_page}},
        indent=2))
    (out / "report.md").write_text(render_md(summary, per_page, when))
    for section, vals in summary.items():
        if isinstance(vals, dict):
            print(f"{section:9s}", "  ".join(f"{k}={fmt(v)}" for k, v in vals.items()))
    print(f"\nwrote {out / 'report.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
