"""Score a predicted page structure against a hand-labeled one.

Three headline areas, as specified:
  text      - did we find each text element, and read it right (CER)
  links     - right endpoints (top-1 and top-2), right direction, kind, label
  emphasis  - underline / CAPS on text and on connector words, closed shapes and
              what they contain

Elements are matched gold<->pred greedily by bbox IoU (highest first). A pair
also matches when IoU is low but the pred centre lies inside the gold box,
because handwriting boxes are loose and annotators draw them differently.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .schema import Element, Page

IOU_MIN = 0.3


def iou(a, b) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def _centre_inside(inner, outer) -> bool:
    cx, cy = inner[0] + inner[2] / 2, inner[1] + inner[3] / 2
    return outer[0] <= cx <= outer[0] + outer[2] and outer[1] <= cy <= outer[1] + outer[3]


def match_elements(gold: list[Element], pred: list[Element]) -> dict[str, str]:
    """Return {gold_id: pred_id} for one element type."""
    pairs = []
    for g in gold:
        for p in pred:
            s = iou(g.bbox, p.bbox)
            if s >= IOU_MIN or _centre_inside(p.bbox, g.bbox):
                pairs.append((s, g.id, p.id))
    pairs.sort(reverse=True)
    out, used = {}, set()
    for _, gid, pid in pairs:
        if gid not in out and pid not in used:
            out[gid] = pid
            used.add(pid)
    return out


def edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _norm(s: str) -> str:
    return " ".join(s.split()).casefold()


@dataclass
class Counts:
    tp: int = 0
    fp: int = 0
    fn: int = 0

    def add(self, other: "Counts"):
        self.tp += other.tp
        self.fp += other.fp
        self.fn += other.fn

    @property
    def p(self):
        return self.tp / (self.tp + self.fp) if self.tp + self.fp else 1.0

    @property
    def r(self):
        return self.tp / (self.tp + self.fn) if self.tp + self.fn else 1.0

    @property
    def f1(self):
        return 2 * self.p * self.r / (self.p + self.r) if self.p + self.r else 0.0


@dataclass
class PageScore:
    page_id: str
    # text
    text_det: Counts = field(default_factory=Counts)
    char_edits: int = 0          # on matched elements, case-insensitive
    char_total: int = 0          # gold chars on matched elements
    char_total_all: int = 0      # gold chars on all gold text (unmatched = all wrong)
    exact_words: int = 0
    # links
    links_top1: Counts = field(default_factory=Counts)
    links_top2_hits: int = 0
    links_gold: int = 0
    links_reversed: int = 0
    kind_correct: int = 0
    kind_total: int = 0
    label_correct: int = 0
    label_total: int = 0
    conf_right: list = field(default_factory=list)
    conf_wrong: list = field(default_factory=list)
    # emphasis
    underline: Counts = field(default_factory=Counts)
    caps: Counts = field(default_factory=Counts)
    shapes: Counts = field(default_factory=Counts)
    contains_jaccard: list = field(default_factory=list)
    doodles: Counts = field(default_factory=Counts)
    doodles_as_text: int = 0
    errors: list = field(default_factory=list)  # human-readable misses for the report


def _flag_counts(gold_flag: bool, pred_flag: bool | None) -> Counts:
    """pred_flag None means the element was not detected: a gold positive is a miss."""
    c = Counts()
    if gold_flag and pred_flag:
        c.tp = 1
    elif gold_flag:
        c.fn = 1
    elif pred_flag:
        c.fp = 1
    return c


def score_page(gold: Page, pred: Page) -> PageScore:
    s = PageScore(gold.page_id)
    by_type = lambda page, t: [e for e in page.elements.values() if e.type == t]

    g_text, p_text = by_type(gold, "text"), by_type(pred, "text")
    g_shape, p_shape = by_type(gold, "shape"), by_type(pred, "shape")
    g_doodle, p_doodle = by_type(gold, "doodle"), by_type(pred, "doodle")
    m = match_elements(g_text, p_text)
    m.update(match_elements(g_shape, p_shape))
    m.update(match_elements(g_doodle, p_doodle))
    inv = {p: g for g, p in m.items()}

    # --- text -------------------------------------------------------------
    s.text_det = Counts(tp=sum(g.id in m for g in g_text), fn=sum(g.id not in m for g in g_text))
    s.text_det.fp = len(p_text) - s.text_det.tp
    for g in g_text:
        gt = _norm(g.text)
        s.char_total_all += len(gt)
        if g.id not in m:
            s.errors.append(f"missed text {g.id} {g.text!r}")
            s.underline.add(_flag_counts(g.underline, None))
            s.caps.add(_flag_counts(g.caps, None))
            continue
        p = pred.elements[m[g.id]]
        pt = _norm(p.text)
        d = edit_distance(gt, pt)
        s.char_edits += d
        s.char_total += len(gt)
        s.exact_words += d == 0
        if d:
            s.errors.append(f"misread {g.id}: {g.text!r} -> {p.text!r}")
        s.underline.add(_flag_counts(g.underline, p.underline))
        s.caps.add(_flag_counts(g.caps, p.caps))
        if g.underline != p.underline:
            s.errors.append(f"underline {g.id} {g.text!r}: gold={g.underline} pred={p.underline}")
        if g.caps != p.caps:
            s.errors.append(f"caps {g.id} {g.text!r}: gold={g.caps} pred={p.caps}")
    for p in p_text:
        if p.id not in inv:
            s.underline.add(_flag_counts(False, p.underline))
            s.caps.add(_flag_counts(False, p.caps))

    # --- doodles: found as doodles, and not hallucinated into text ----------
    s.doodles = Counts(tp=sum(g.id in m for g in g_doodle), fn=sum(g.id not in m for g in g_doodle))
    s.doodles.fp = len(p_doodle) - s.doodles.tp
    unmatched_text = [p for p in p_text if p.id not in inv]
    for g in g_doodle:
        read = [p for p in unmatched_text if iou(g.bbox, p.bbox) >= IOU_MIN or _centre_inside(p.bbox, g.bbox)]
        s.doodles_as_text += bool(read)
        if read:
            s.errors.append(f"doodle {g.id} read as text {read[0].text!r}")

    # --- shapes / containers ----------------------------------------------
    s.shapes = Counts(tp=sum(g.id in m for g in g_shape), fn=sum(g.id not in m for g in g_shape))
    s.shapes.fp = len(p_shape) - s.shapes.tp
    for g in g_shape:
        if g.id not in m:
            s.errors.append(f"missed shape {g.id}")
            continue
        gset = set(g.contains)
        pset = {inv.get(c, f"pred:{c}") for c in pred.elements[m[g.id]].contains}
        j = len(gset & pset) / len(gset | pset) if gset | pset else 1.0
        s.contains_jaccard.append(j)
        if j < 1:
            s.errors.append(f"shape {g.id} contents: gold={sorted(gset)} pred={sorted(pset)}")

    # --- links ------------------------------------------------------------
    # Translate pred endpoints into gold ids; unmatched pred elements can never be right.
    def to_gold(cands):
        return [(inv.get(pid, f"pred:{pid}"), c) for pid, c in cands]

    pred_links = [(l, to_gold(l.src), to_gold(l.dst)) for l in pred.links]
    used = set()
    s.links_gold = len(gold.links)
    for gl in gold.links:
        gs, gd = gl.src[0][0], gl.dst[0][0]
        name = f"{gs}->{gd} ({gl.kind})"
        hit = None
        for i, (pl, ps, pd) in enumerate(pred_links):
            if i not in used and ps[0][0] == gs and pd[0][0] == gd:
                hit = i
                break
        if hit is None:
            # top-2: an ambiguous end that listed the right target second still counts here
            top2 = any(
                i not in used and gs in [c for c, _ in ps[:2]] and gd in [c for c, _ in pd[:2]]
                for i, (_, ps, pd) in enumerate(pred_links)
            )
            s.links_top2_hits += top2
            rev = any(ps[0][0] == gd and pd[0][0] == gs for _, ps, pd in pred_links)
            s.links_reversed += rev
            s.links_top1.fn += 1
            s.underline.add(_flag_counts(gl.underline, None))
            s.caps.add(_flag_counts(gl.caps, None))
            s.errors.append(f"missed link {name}" + (" (reversed)" if rev else "") + (" (in top-2)" if top2 else ""))
            continue
        used.add(hit)
        pl = pred_links[hit][0]
        s.links_top1.tp += 1
        s.underline.add(_flag_counts(gl.underline, pl.underline))
        s.caps.add(_flag_counts(gl.caps, pl.caps))
        if gl.underline != pl.underline:
            s.errors.append(f"underline on link {name} {gl.label!r}: gold={gl.underline} pred={pl.underline}")
        if gl.caps != pl.caps:
            s.errors.append(f"caps on link {name} {gl.label!r}: gold={gl.caps} pred={pl.caps}")
        s.links_top2_hits += 1
        s.kind_total += 1
        s.kind_correct += pl.kind == gl.kind
        if pl.kind != gl.kind:
            s.errors.append(f"link kind {name}: pred {pl.kind}")
        if gl.kind == "connector":
            s.label_total += 1
            ok = _norm(pl.label) == _norm(gl.label)
            s.label_correct += ok
            if not ok:
                s.errors.append(f"link label {name}: {gl.label!r} -> {pl.label!r}")
        if pl.confidence is not None:
            s.conf_right.append(pl.confidence)
    for i, (pl, ps, pd) in enumerate(pred_links):
        if i not in used:
            s.links_top1.fp += 1
            s.underline.add(_flag_counts(False, pl.underline))
            s.caps.add(_flag_counts(False, pl.caps))
            if pl.confidence is not None:
                s.conf_wrong.append(pl.confidence)
            s.errors.append(f"spurious link {ps[0][0]}->{pd[0][0]} ({pl.kind})")
    return s


def summarize(scores: list[PageScore]) -> dict:
    """Micro-averaged totals across pages."""
    td, lk, ul, cp, sh, dd = Counts(), Counts(), Counts(), Counts(), Counts(), Counts()
    doodles_as_text = 0
    agg = dict(char_edits=0, char_total=0, char_total_all=0, exact=0, top2=0, gold_links=0,
               rev=0, kc=0, kt=0, lc=0, lt=0)
    cr, cw, jac = [], [], []
    for s in scores:
        td.add(s.text_det); lk.add(s.links_top1); ul.add(s.underline); cp.add(s.caps); sh.add(s.shapes); dd.add(s.doodles)
        doodles_as_text += s.doodles_as_text
        agg["char_edits"] += s.char_edits; agg["char_total"] += s.char_total
        agg["char_total_all"] += s.char_total_all; agg["exact"] += s.exact_words
        agg["top2"] += s.links_top2_hits; agg["gold_links"] += s.links_gold; agg["rev"] += s.links_reversed
        agg["kc"] += s.kind_correct; agg["kt"] += s.kind_total
        agg["lc"] += s.label_correct; agg["lt"] += s.label_total
        cr += s.conf_right; cw += s.conf_wrong; jac += s.contains_jaccard

    ratio = lambda a, b: a / b if b else None
    mean = lambda xs: sum(xs) / len(xs) if xs else None
    unmatched_chars = agg["char_total_all"] - agg["char_total"]
    return {
        "pages": len(scores),
        "text": {
            "detection_p": td.p, "detection_r": td.r, "detection_f1": td.f1,
            "cer_matched": ratio(agg["char_edits"], agg["char_total"]),
            "cer_end_to_end": ratio(agg["char_edits"] + unmatched_chars, agg["char_total_all"]),
            "exact_match_rate": ratio(agg["exact"], td.tp + td.fn),
        },
        "links": {
            "top1_p": lk.p, "top1_r": lk.r, "top1_f1": lk.f1,
            "top2_recall": ratio(agg["top2"], agg["gold_links"]),
            "reversed": agg["rev"],
            "kind_accuracy": ratio(agg["kc"], agg["kt"]),
            "connector_label_accuracy": ratio(agg["lc"], agg["lt"]),
            "mean_conf_correct": mean(cr), "mean_conf_wrong": mean(cw),
        },
        "emphasis": {
            "underline_p": ul.p, "underline_r": ul.r, "underline_f1": ul.f1,
            "caps_p": cp.p, "caps_r": cp.r, "caps_f1": cp.f1,
            "shape_f1": sh.f1, "container_jaccard": mean(jac),
        },
        "doodles": {"gold": dd.tp + dd.fn, "f1": dd.f1, "read_as_text": doodles_as_text},
    }
