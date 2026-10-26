"""Make sense of a page: its arrows become threads, the rest becomes loose notes.

Input is a page in the harness schema (what the engine reads, or what you corrected it
to). Output is plain data the UI and the share file both draw from:

  threads    connected ideas as nested outlines, one per group of arrows. A connector word
             rides on its arrow ("Transition -TRY TO-> core"); a hook is an aside to its parent.
  loose      text no arrow touches, grouped by how close it sits ("Add Luis Garcia / PhDs in HCI")
  key_terms  what you underlined or wrote in capitals
  actions    lines that start with one of your to-do cues
  summary    one honest sentence of counts, not an interpretation

A shape and the words inside it are one node: an arrow from the circle and an arrow into
its word both land on the same idea. Stdlib only.
"""

from __future__ import annotations

import math
import re
import statistics

BAND = 0.1        # reading order: rows are bands this fraction of the page height tall
NEAR = 1.2        # loose text within this many median line heights of each other is one note
MAX_DEPTH = 40    # an outline never nests deeper than this; past it a node is shown as a reference


def _band_key(box, ph):
    x, y, w, h = box
    return (int(y / (BAND * ph)), x)


def _reading_order(items: list[dict], tol: float) -> list[dict]:
    """Top to bottom, left to right within a row. A row is items whose vertical centres are within `tol`."""
    rows: list[list[dict]] = []
    for it in sorted(items, key=lambda i: i["box"][1] + i["box"][3] / 2):
        cy = it["box"][1] + it["box"][3] / 2
        if rows and abs(cy - rows[-1][0]["box"][1] - rows[-1][0]["box"][3] / 2) <= tol:
            rows[-1].append(it)
        else:
            rows.append([it])
    return [it for row in rows for it in sorted(row, key=lambda i: i["box"][0])]


def _gap(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    dx = max(0, max(ax, bx) - min(ax + aw, bx + bw))
    dy = max(0, max(ay, by) - min(ay + ah, by + bh))
    return math.hypot(dx, dy)


class _Sets:
    def __init__(self, keys):
        self.p = {k: k for k in keys}

    def find(self, k):
        while self.p[k] != k:
            self.p[k] = self.p[self.p[k]]
            k = self.p[k]
        return k

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def cue_of(text: str, cues) -> str | None:
    """The to-do cue `text` starts with ("add" for "Add Luis Garcia"), or None."""
    lead = re.sub(r"^\W+", "", text).lower()
    for cue in sorted(cues, key=len, reverse=True):
        if re.match(rf"{re.escape(cue)}\b", lead):
            return cue
    return None


def make_sense(page: dict, cues=(), noun: str = "page") -> dict:
    pw, ph = page["page_size"]
    els = {e["id"]: e for e in page["elements"]}
    texts = [e for e in page["elements"] if e["type"] == "text"]
    median_h = statistics.median(e["bbox"][3] for e in texts) if texts else 0.04 * ph

    # Fold each shape and the words inside it into one node.
    alias = {}
    for s in page["elements"]:
        if s["type"] == "shape":
            for c in s.get("contains", []):
                if c in els and els[c]["type"] == "text":
                    alias[c] = s["id"]
    nodes: dict[str, dict] = {}
    for e in page["elements"]:
        if e["type"] == "text" and e["id"] not in alias:
            nodes[e["id"]] = {"id": e["id"], "ids": [e["id"]], "text": e["text"], "box": e["bbox"],
                              "underline": bool(e.get("underline")), "caps": bool(e.get("caps"))}
        elif e["type"] == "shape":
            inside = _reading_order([{**els[c], "box": els[c]["bbox"]} for c in e.get("contains", [])
                                     if c in els and els[c]["type"] == "text"], median_h * 0.6)
            nodes[e["id"]] = {"id": e["id"], "ids": [e["id"]] + [m["id"] for m in inside],
                              "text": " ".join(m["text"] for m in inside) or "(drawn shape)",
                              "box": e["bbox"],
                              "underline": any(m.get("underline") for m in inside),
                              "caps": any(m.get("caps") for m in inside)}

    def end(v):
        cid = v if isinstance(v, str) else v[0]["id"]
        cid = alias.get(cid, cid)
        return cid if cid in nodes else None

    edges, seen = [], set()
    for l in page.get("links", []):
        a, b = end(l["from"]), end(l["to"])
        if a and b and a != b and (a, b) not in seen:
            seen.add((a, b))
            edges.append({"from": a, "to": b, "kind": l["kind"], "label": l.get("label", ""),
                          "caps": bool(l.get("caps")), "underline": bool(l.get("underline")), "link": l["id"]})

    order = lambda n: _band_key(nodes[n]["box"], ph)
    out_edges: dict[str, list[dict]] = {n: [] for n in nodes}
    indeg = {n: 0 for n in nodes}
    comp = _Sets(nodes)
    for e in edges:
        out_edges[e["from"]].append(e)
        indeg[e["to"]] += 1
        comp.union(e["from"], e["to"])

    def item(n, via, visited, depth=0):
        info = nodes[n]
        it = {"id": n, "ids": info["ids"], "text": info["text"], "underline": info["underline"], "caps": info["caps"],
              "action": bool(cue_of(info["text"], cues)), "via": via and {k: via[k] for k in ("kind", "label", "caps", "underline")},
              "ref": False, "children": []}
        visited.add(n)
        for e in sorted(out_edges[n], key=lambda e: order(e["to"])):
            m = e["to"]
            if m in visited or depth >= MAX_DEPTH:
                ref = item_ref(m, e)
                it["children"].append(ref)
            else:
                it["children"].append(item(m, e, visited, depth + 1))
        return it

    def item_ref(m, via):
        info = nodes[m]
        return {"id": m, "ids": info["ids"], "text": info["text"], "underline": info["underline"], "caps": info["caps"],
                "action": False, "via": {k: via[k] for k in ("kind", "label", "caps", "underline")},
                "ref": True, "children": []}

    groups: dict[str, list[str]] = {}
    for n in nodes:
        groups.setdefault(comp.find(n), []).append(n)

    threads, loose_nodes = [], []
    for members in groups.values():
        if len(members) == 1 and not out_edges[members[0]] and indeg[members[0]] == 0:
            loose_nodes.append(members[0])
            continue
        visited: set[str] = set()
        roots = sorted((n for n in members if indeg[n] == 0), key=order) or [min(members, key=order)]
        items = [item(r, None, visited) for r in roots]
        for n in sorted((n for n in members if n not in visited), key=order):  # a cycle no root reaches
            if n not in visited:
                items.append(item(n, None, visited))
        threads.append({"roots": items, "size": len(members), "_key": min(order(n) for n in members),
                        "ids": sorted({i for n in members for i in nodes[n]["ids"]})})
    threads.sort(key=lambda t: t["_key"])
    for t in threads:
        del t["_key"]

    # Loose text: single-linkage on how near the boxes sit.
    loose_sets = _Sets(loose_nodes)
    for i, a in enumerate(loose_nodes):
        for b in loose_nodes[i + 1:]:
            if _gap(nodes[a]["box"], nodes[b]["box"]) <= NEAR * median_h:
                loose_sets.union(a, b)
    loose_groups: dict[str, list[dict]] = {}
    for n in loose_nodes:
        loose_groups.setdefault(loose_sets.find(n), []).append(nodes[n])
    loose = []
    for members in loose_groups.values():
        ordered = _reading_order(members, median_h * 0.6)
        loose.append({"items": [{"id": m["id"], "ids": m["ids"], "text": m["text"], "underline": m["underline"],
                                 "caps": m["caps"], "action": bool(cue_of(m["text"], cues))} for m in ordered],
                      "_key": _band_key(ordered[0]["box"], ph)})
    loose.sort(key=lambda g: g["_key"])
    for g in loose:
        del g["_key"]

    key_terms, seen_terms = [], set()
    for n in sorted(nodes, key=order):
        info = nodes[n]
        if (info["underline"] or info["caps"]) and info["text"].lower() not in seen_terms:
            seen_terms.add(info["text"].lower())
            key_terms.append({"id": n, "text": info["text"], "kind": _emphasis(info)})
    for e in edges:
        if e["label"] and (e["caps"] or e["underline"]) and e["label"].lower() not in seen_terms:
            seen_terms.add(e["label"].lower())
            key_terms.append({"id": e["link"], "text": e["label"], "kind": _emphasis(e), "connector": True})

    actions = []
    for n in sorted(nodes, key=order):
        cue = cue_of(nodes[n]["text"], cues)
        if cue:
            actions.append({"id": n, "text": nodes[n]["text"], "cue": cue})

    stats = {"text": len(texts), "shapes": sum(e["type"] == "shape" for e in page["elements"]),
             "doodles": sum(e["type"] == "doodle" for e in page["elements"]), "links": len(edges),
             "threads": len(threads), "loose": len(loose)}
    sense = {"stats": stats, "threads": threads, "loose": loose, "key_terms": key_terms, "actions": actions}
    sense["title"] = _title(sense)
    sense["summary"] = _summary(sense, noun)
    return sense


def _emphasis(x: dict) -> str:
    return "both" if x["underline"] and x["caps"] else "underline" if x["underline"] else "caps"


def _title(sense: dict) -> str:
    first = sense["threads"][0]["roots"][0]["text"] if sense["threads"] else (
        sense["loose"][0]["items"][0]["text"] if sense["loose"] else "")
    first = re.sub(r"^\W+|\W+$", "", first)
    return (first[:58] + "…" if len(first) > 60 else first) or "Untitled page"


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def _summary(sense: dict, noun: str = "page") -> str:
    t, l, a = len(sense["threads"]), len(sense["loose"]), len(sense["actions"])
    if not t and not l:
        return f"No readable text found on this {noun}."
    parts = []
    if t:
        starts = [r["text"].strip(" .") for th in sense["threads"] for r in th["roots"][:1]]
        shown = ", ".join(f"“{s}”" for s in starts[:3]) + (f" + {len(starts) - 3} more" if len(starts) > 3 else "")
        parts.append(f"{_plural(t, 'thread')} of connected ideas (from {shown})")
    if l:
        parts.append(_plural(l, "loose note"))
    text = f"This {noun} has " + " and ".join(parts) + "."
    if a:
        text += f" {_plural(a, 'to-do')} spotted."
    return text
