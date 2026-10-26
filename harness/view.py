"""Build a self-contained HTML viewer of gold labels, predictions and scores.

    python -m harness.view                  # writes reports/viewer.html
    python -m harness.view --source mine=path/to/preds

Sources are found automatically: every folder in data/baselines/ that holds
prediction JSON, plus data/preds/ (shown as "pipeline") when it has any. Each is
scored against data/labeled the same way harness.run does. The page shows a
score table across sources, then each labeled page with gold and prediction
drawn over the image and the list of misses; hovering a miss highlights it.
Images are embedded, so the file can be moved or shared on its own. Stdlib only.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from datetime import datetime
from pathlib import Path

from .schema import Page, load_page
from .score import match_elements, score_page, summarize


def page_dict(p: Page) -> dict:
    return {
        "elements": [
            {"id": e.id, "type": e.type, "bbox": e.bbox, "text": e.text, "underline": e.underline,
             "caps": e.caps, "contains": e.contains, "confidence": e.confidence}
            for e in p.elements.values()
        ],
        "links": [
            {"id": l.id, "kind": l.kind, "from": [c for c, _ in l.src], "to": [c for c, _ in l.dst],
             "label": l.label, "caps": l.caps, "underline": l.underline, "confidence": l.confidence}
            for l in p.links
        ],
    }


def error_refs(err: str, gold_ids: set[str], pred_ids: set[str]) -> dict:
    """The gold and pred element ids an error message names (quoted text is ignored)."""
    bare = re.sub(r"'[^']*'|\"[^\"]*\"", " ", err)
    gold, pred = [], []
    for prefix, tok in re.findall(r"(pred:)?([A-Za-z0-9_]+)", bare):
        if prefix and tok in pred_ids:
            pred.append(tok)
        elif not prefix and tok in gold_ids:
            gold.append(tok)
    return {"text": err, "gold": gold, "pred": pred}


def gold_to_pred(gold: Page, pred: Page) -> dict[str, str]:
    out = {}
    for t in ("text", "shape", "doodle"):
        out.update(match_elements([e for e in gold.elements.values() if e.type == t],
                                  [e for e in pred.elements.values() if e.type == t]))
    return out


def discover(baselines: Path, preds: Path) -> dict[str, Path]:
    found = {d.name: d for d in sorted(baselines.glob("*")) if d.is_dir() and any(d.glob("*.json"))}
    if any(preds.glob("*.json")):
        found["pipeline"] = preds
    return found


def build(gold_dir: Path, sources: dict[str, Path]) -> dict:
    pages, scores = [], {name: [] for name in sources}
    for gf in sorted(gold_dir.glob("*.json")):
        gold = load_page(gf)
        img = gf.with_suffix(".jpg")
        entry = {
            "id": gold.page_id,
            "image": "data:image/jpeg;base64," + base64.b64encode(img.read_bytes()).decode() if img.exists() else None,
            "gold": page_dict(gold),
            "preds": {},
        }
        for name, d in sources.items():
            pf = d / gf.name
            pred = load_page(pf) if pf.exists() else Page(gold.page_id, {}, [])
            s = score_page(gold, pred)
            scores[name].append(s)
            entry["preds"][name] = {
                **page_dict(pred),
                "present": pf.exists(),
                "summary": summarize([s]),
                "match": gold_to_pred(gold, pred),
                "errors": [error_refs(e, set(gold.elements), set(pred.elements)) for e in s.errors],
            }
        pages.append(entry)
    return {
        "when": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "gold_dir": str(gold_dir),
        "sources": list(sources),
        "summary": {name: summarize(sc) for name, sc in scores.items()},
        "with_preds": {name: sum(p["preds"][name]["present"] for p in pages) for name in sources},
        "pages": pages,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", default="data/labeled")
    ap.add_argument("--baselines", default="data/baselines")
    ap.add_argument("--preds", default="data/preds")
    ap.add_argument("--source", action="append", default=[], metavar="NAME=DIR", help="add a prediction folder")
    ap.add_argument("--out", default="reports/viewer.html")
    a = ap.parse_args(argv)

    gold_dir = Path(a.gold)
    if not any(gold_dir.glob("*.json")):
        print(f"no gold labels in {gold_dir}", file=sys.stderr)
        return 1
    sources = discover(Path(a.baselines), Path(a.preds))
    for spec in a.source:
        name, _, d = spec.partition("=")
        sources[name] = Path(d)
    data = build(gold_dir, sources)

    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data).replace("</", "<\\/")
    out.write_text(HTML.replace("__DATA__", payload))
    print(f"wrote {out}: {len(data['pages'])} pages, sources: {', '.join(data['sources']) or 'none'}")
    return 0


HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anchor Results</title>
<style>
:root {
  --bg: #f6f5f2; --panel: #ffffff; --ink: #1d1d1f; --muted: #6b6b70; --line: #e2e0db;
  --accent: #2f6fd6; --accent-ink: #ffffff; --best: #e9f3ea; --best-ink: #1f6b33;
  --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161618; --panel: #1f1f22; --ink: #ececef; --muted: #9a9aa2; --line: #333338;
    --accent: #5b8ff0; --accent-ink: #0d0d0f; --best: #1d3324; --best-ink: #8fd6a2;
  }
}
:root[data-theme="dark"] {
  --bg: #161618; --panel: #1f1f22; --ink: #ececef; --muted: #9a9aa2; --line: #333338;
  --accent: #5b8ff0; --accent-ink: #0d0d0f; --best: #1d3324; --best-ink: #8fd6a2;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
main { max-width: 1480px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin-bottom: 20px; }
h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 28px 0 10px; }
.meta { color: var(--muted); font-size: 13px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 7px 12px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
thead th { font-weight: 600; color: var(--muted); font-size: 12px; }
tbody tr:last-child td { border-bottom: 0; }
td.best { background: var(--best); color: var(--best-ink); font-weight: 600; }
td.group { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; padding-top: 14px; }
.controls { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; margin-bottom: 12px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--panel); }
.seg button { border: 0; background: none; color: var(--ink); padding: 6px 12px; font: inherit; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.seg button:disabled { color: var(--muted); cursor: default; }
.label { color: var(--muted); font-size: 12px; margin-right: 6px; }
.view { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; align-items: start; }
@media (max-width: 960px) { .view { grid-template-columns: 1fr; } }
.stage { position: relative; line-height: 0; padding: 8px; }
.stage img { width: 100%; height: auto; border-radius: 4px; }
.stage svg { position: absolute; inset: 8px; width: calc(100% - 16px); height: calc(100% - 16px); }
.legend { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 10px 12px; border-top: 1px solid var(--line);
  font-size: 12px; color: var(--muted); line-height: 1.3; }
.legend i { display: inline-block; width: 14px; height: 3px; vertical-align: middle; margin-right: 5px; border-radius: 2px; }
.side { padding: 14px; }
.side h3 { font-size: 13px; margin: 0 0 8px; }
.kv { display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; font-variant-numeric: tabular-nums; margin-bottom: 16px; }
.kv span:nth-child(odd) { color: var(--muted); }
ul.misses { list-style: none; margin: 0; padding: 0; max-height: 640px; overflow: auto; font-size: 13px; }
ul.misses li { padding: 6px 8px; border-radius: 6px; cursor: default; font-family: var(--mono); font-size: 12px; word-break: break-word; }
ul.misses li:hover, ul.misses li:focus { background: var(--bg); outline: none; }
.empty { color: var(--muted); font-size: 13px; }
svg .lbl { font: 600 13px -apple-system, system-ui, sans-serif; paint-order: stroke; stroke: #fff; stroke-width: 3.5px; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Anchor results</h1>
    <span class="meta" id="meta"></span>
  </header>

  <h2>Scores, all pages</h2>
  <div class="card scroll"><table id="scores"></table></div>

  <h2>Pages</h2>
  <div class="controls">
    <div><span class="label">Page</span><span class="seg" id="pages"></span></div>
    <div><span class="label">Prediction</span><span class="seg" id="sources"></span></div>
    <div><span class="label">Show</span><span class="seg" id="layers"></span></div>
  </div>
  <div class="view">
    <div class="card">
      <div class="stage"><img id="img" alt=""><svg id="svg"></svg></div>
      <div class="legend" id="legend"></div>
    </div>
    <div class="card side" id="side"></div>
  </div>
</main>

<script id="data" type="application/json">__DATA__</script>
<script>
const D = JSON.parse(document.getElementById("data").textContent);
const st = { page: 0, src: D.sources[0] ?? null, layer: D.sources.length ? "both" : "gold", hi: null };

const COLORS = { text: "#2f6fd6", underline: "#23964a", caps: "#e07b00", shape: "#8e44ad", doodle: "#808080",
                 flow: "#d63a3a", hook: "#c03ac0", connector: "#0b97a3", gold: "#2a2a2e", hi: "#ffcc00" };
const METRICS = [
  ["Text", [["text", "detection_f1", "Detection F1", 1], ["text", "cer_end_to_end", "CER, end to end", -1],
            ["text", "cer_matched", "CER, found nodes", -1], ["text", "exact_match_rate", "Exact matches", 1]]],
  ["Links", [["links", "top1_f1", "Top-1 F1", 1], ["links", "top2_recall", "Top-2 recall", 1],
             ["links", "reversed", "Reversed", -1], ["links", "kind_accuracy", "Kind accuracy", 1],
             ["links", "connector_label_accuracy", "Connector label accuracy", 1]]],
  ["Emphasis", [["emphasis", "underline_f1", "Underline F1", 1], ["emphasis", "caps_f1", "Caps F1", 1],
                ["emphasis", "shape_f1", "Shape F1", 1], ["emphasis", "container_jaccard", "Container Jaccard", 1]]],
  ["Doodles", [["doodles", "f1", "Doodle F1", 1], ["doodles", "read_as_text", "Read as text", -1]]],
];

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Counts (reversed links, doodles read as text) are whole numbers; everything else is a rate.
const COUNTS = new Set(["reversed", "read_as_text"]);
const fmt = (v, key) => v == null ? "–" : COUNTS.has(key) ? String(v) : v.toFixed(3);

function seg(el, items, current, onPick) {
  el.innerHTML = items.map(([value, label, disabled]) =>
    `<button type="button" data-v="${esc(value)}" aria-pressed="${value === current}" ${disabled ? "disabled" : ""}>${esc(label)}</button>`).join("");
  el.querySelectorAll("button").forEach(b => b.onclick = () => onPick(b.dataset.v));
}

function renderScores() {
  const t = document.getElementById("scores");
  if (!D.sources.length) { t.innerHTML = `<tbody><tr><td class="empty">No predictions yet. Run a baseline, e.g. python3 -m baselines.vision</td></tr></tbody>`; return; }
  let h = `<thead><tr><th>Metric</th>${D.sources.map(s => `<th>${esc(s)}<br><span class="meta">${D.with_preds[s]}/${D.pages.length} pages</span></th>`).join("")}</tr></thead><tbody>`;
  for (const [group, rows] of METRICS) {
    h += `<tr><td class="group" colspan="${D.sources.length + 1}">${group}</td></tr>`;
    for (const [sec, key, name, dir] of rows) {
      const vals = D.sources.map(s => D.summary[s][sec][key]);
      const known = vals.filter(v => v != null);
      const best = known.length > 1 ? (dir > 0 ? Math.max(...known) : Math.min(...known)) : null;
      const unique = best != null && known.filter(v => v === best).length === 1;
      h += `<tr><td>${name}</td>${vals.map(v => `<td class="${unique && v === best ? "best" : ""}">${fmt(v, key)}</td>`).join("")}</tr>`;
    }
  }
  t.innerHTML = h + "</tbody>";
}

function colorOf(e) {
  if (e.type === "shape") return COLORS.shape;
  if (e.type === "doodle") return COLORS.doodle;
  return e.underline ? COLORS.underline : e.caps ? COLORS.caps : COLORS.text;
}

// Where the segment from a box's centre toward `p` leaves the box.
function exitPoint(b, p) {
  const c = [b[0] + b[2] / 2, b[1] + b[3] / 2], dx = p[0] - c[0], dy = p[1] - c[1];
  const t = Math.min(dx ? b[2] / 2 / Math.abs(dx) : Infinity, dy ? b[3] / 2 / Math.abs(dy) : Infinity);
  return t >= 1 ? c : [c[0] + dx * t, c[1] + dy * t];
}

function drawLayer(data, W, H, ghost, hiIds) {
  const box = {};
  let shapes = "", texts = "", links = "";
  for (const e of data.elements) {
    const b = [e.bbox[0] * W, e.bbox[1] * H, e.bbox[2] * W, e.bbox[3] * H];
    box[e.id] = b;
    const hi = hiIds.has(e.id);
    const tip = `${e.id} · ${e.type}${e.text ? ` · "${e.text}"` : ""}${e.underline ? " · underline" : ""}${e.caps ? " · caps" : ""}${e.confidence != null ? ` · conf ${e.confidence}` : ""}`;
    const stroke = hi ? COLORS.hi : ghost ? COLORS.gold : colorOf(e);
    const dash = ghost && !hi ? `stroke-dasharray="6 4"` : "";
    const width = hi ? 5 : ghost ? 1.5 : 2.5;
    const r = `<rect x="${b[0]}" y="${b[1]}" width="${b[2]}" height="${b[3]}" rx="3" fill="${hi ? "rgba(255,204,0,.18)" : "none"}" stroke="${stroke}" stroke-width="${width}" ${dash} pointer-events="all"><title>${esc(tip)}</title></rect>`;
    if (e.type === "shape") shapes += r; else texts += r;
    if (!ghost && e.text) texts += `<text class="lbl" x="${b[0]}" y="${Math.max(13, b[1] - 5)}" fill="${colorOf(e)}" pointer-events="none">${esc(e.text)}</text>`;
  }
  for (const l of data.links) {
    const s = box[l.from[0]], d = box[l.to[0]];
    if (!s || !d) continue;
    const a = exitPoint(s, [d[0] + d[2] / 2, d[1] + d[3] / 2]), z = exitPoint(d, [s[0] + s[2] / 2, s[1] + s[3] / 2]);
    const col = ghost ? COLORS.gold : COLORS[l.kind] || "#000";
    const dash = ghost ? `stroke-dasharray="6 4"` : "";
    const tip = `${l.from[0]} → ${l.to[0]} (${l.kind})${l.label ? ` "${l.label}"` : ""}${l.confidence != null ? ` · conf ${l.confidence}` : ""}`;
    links += `<line x1="${a[0]}" y1="${a[1]}" x2="${z[0]}" y2="${z[1]}" stroke="${col}" stroke-width="${ghost ? 1.5 : 2.5}" ${dash} marker-end="url(#ah-${ghost ? "gold" : l.kind})"><title>${esc(tip)}</title></line>`;
    if (!ghost && l.label) {
      const tag = l.label + (l.caps ? " [C]" : "") + (l.underline ? " [U]" : "");
      links += `<text class="lbl" x="${(a[0] + z[0]) / 2 + 6}" y="${(a[1] + z[1]) / 2 - 6}" fill="${col}" pointer-events="none">${esc(tag)}</text>`;
    }
    // Second-choice endpoints, thin and dashed.
    if (!ghost) for (const [f, t] of [[l.from[1], l.to[0]], [l.from[0], l.to[1]]]) {
      if (f == null || t == null || !box[f] || !box[t]) continue;
      const p = exitPoint(box[f], [box[t][0] + box[t][2] / 2, box[t][1] + box[t][3] / 2]);
      const q = exitPoint(box[t], [box[f][0] + box[f][2] / 2, box[f][1] + box[f][3] / 2]);
      links += `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${col}" stroke-width="1.2" stroke-dasharray="3 4"><title>2nd choice: ${esc(f)} → ${esc(t)}</title></line>`;
    }
  }
  return shapes + links + texts;
}

function renderStage() {
  const pg = D.pages[st.page], img = document.getElementById("img"), svg = document.getElementById("svg");
  const draw = () => {
    const W = img.naturalWidth || 1000, H = img.naturalHeight || 700;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const pred = st.src ? pg.preds[st.src] : null;
    const hiGold = new Set(st.hi ? st.hi.gold : []);
    const hiPred = new Set(st.hi ? [...st.hi.pred, ...st.hi.gold.map(g => pred && pred.match[g]).filter(Boolean)] : []);
    const marker = (id, c) => `<marker id="ah-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`;
    let out = `<defs>${["flow", "hook", "connector", "gold"].map(k => marker(k, COLORS[k])).join("")}</defs>`;
    if (st.layer === "gold") out += drawLayer(pg.gold, W, H, false, hiGold);
    else if (st.layer === "pred" && pred) out += drawLayer(pred, W, H, false, hiPred);
    else if (st.layer === "both") out += drawLayer(pg.gold, W, H, true, hiGold) + (pred ? drawLayer(pred, W, H, false, hiPred) : "");
    svg.innerHTML = out;
  };
  if (img.dataset.page !== pg.id) {
    img.dataset.page = pg.id;
    img.onload = draw;
    img.src = pg.image || "";
    img.alt = `Flattened photo of ${pg.id}`;
    if (!pg.image) draw();
  } else draw();
}

function renderLegend() {
  const items = [["Text", COLORS.text], ["Underlined", COLORS.underline], ["Caps", COLORS.caps], ["Shape", COLORS.shape],
                 ["Doodle", COLORS.doodle], ["Flow", COLORS.flow], ["Hook", COLORS.hook], ["Connector", COLORS.connector]];
  let h = items.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join("");
  if (st.layer === "both") h += `<span><i style="background:repeating-linear-gradient(90deg,${COLORS.gold} 0 5px,transparent 5px 8px)"></i>Gold (dashed)</span>`;
  document.getElementById("legend").innerHTML = h;
}

function renderSide() {
  const side = document.getElementById("side"), pg = D.pages[st.page];
  if (!st.src) { side.innerHTML = `<h3>${esc(pg.id)}</h3><p class="empty">No predictions to compare yet. Showing the gold labels.</p>`; return; }
  const p = pg.preds[st.src], s = p.summary;
  const kv = [["Text detection F1", s.text.detection_f1], ["CER, end to end", s.text.cer_end_to_end],
              ["Link top-1 F1", s.links.top1_f1], ["Link top-2 recall", s.links.top2_recall],
              ["Underline F1", s.emphasis.underline_f1], ["Caps F1", s.emphasis.caps_f1]];
  let h = `<h3>${esc(pg.id)} · ${esc(st.src)}</h3>`;
  if (!p.present) h += `<p class="empty">No prediction file for this page; scored as empty.</p>`;
  h += `<div class="kv">${kv.map(([k, v]) => `<span>${k}</span><span>${fmt(v)}</span>`).join("")}</div>`;
  h += `<h3>Misses (${p.errors.length})</h3>`;
  h += p.errors.length ? `<ul class="misses">${p.errors.map((e, i) => `<li tabindex="0" data-i="${i}">${esc(e.text)}</li>`).join("")}</ul>` : `<p class="empty">None.</p>`;
  side.innerHTML = h;
  side.querySelectorAll("li").forEach(li => {
    const on = () => { st.hi = p.errors[+li.dataset.i]; renderStage(); };
    const off = () => { st.hi = null; renderStage(); };
    li.onmouseenter = on; li.onfocus = on; li.onmouseleave = off; li.onblur = off;
  });
}

function render() {
  seg(document.getElementById("pages"), D.pages.map((p, i) => [String(i), p.id]), String(st.page), v => { st.page = +v; render(); });
  seg(document.getElementById("sources"), D.sources.length ? D.sources.map(s => [s, s]) : [["", "none", true]], st.src ?? "", v => { st.src = v; render(); });
  seg(document.getElementById("layers"), [["gold", "Gold"], ["pred", "Prediction", !st.src], ["both", "Both", !st.src]], st.layer, v => { st.layer = v; render(); });
  renderLegend(); renderSide(); renderStage();
}

document.getElementById("meta").textContent = `${D.pages.length} labeled page${D.pages.length === 1 ? "" : "s"} in ${D.gold_dir} · built ${D.when}`;
renderScores();
render();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    sys.exit(main())
