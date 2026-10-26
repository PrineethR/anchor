"""What the app has learned about how you write.

One JSON file (notes/profile.json) holds three kinds of knowledge:

  - shorthand and action cues: things you set yourself (seeded: a lone "7" is your
    curl for "of"; a line starting "Add" or "Looking into" is a to-do)
  - reading fixes: when you correct a reading, the wrong -> right word pair is kept
    under that note, so saving a note twice counts once and deleting it forgets it
  - vocabulary: the words in your corrected notes and labeled pages. A reading that
    is close to one of your words (and not just an inflection of it) is snapped to it.

`apply` rewrites the text of a page with all of that and says what it changed, so
the UI can show it. It touches nothing but element text. Stdlib only.
"""

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
from collections import Counter
from difflib import SequenceMatcher, get_close_matches
from os.path import commonprefix
from pathlib import Path

SEED = {
    "version": 1,
    "shorthand": {"7": "of"},
    "action_cues": ["add", "looking into", "todo", "to do", "follow up", "ask", "email", "call", "send", "check"],
    "notes": {},
    "labeled": {},
}

SNAP_CUTOFF = 0.8   # difflib ratio a reading must reach to be snapped to one of your words
SNAP_MIN_LEN = 5    # shorter words are too easy to confuse
EDGES = re.compile(r"^(\W*)(.*?)(\W*)$", re.S)


def cores(text: str) -> list[str]:
    """Whitespace-separated chunks of `text` with punctuation trimmed off both ends."""
    return [c for c in (EDGES.match(ch).group(2) for ch in text.split()) if c]


def words(text: str) -> list[str]:
    """Lowercase alphabetic words of 3+ letters, for the vocabulary."""
    return [w.lower() for w in re.findall(r"[^\W\d_]+", text) if len(w) >= 3]


def match_case(src: str, new: str) -> str:
    if len(src) > 1 and src.isupper():
        return new.upper()
    if src[:1].isupper():
        return new[:1].upper() + new[1:]
    return new


def diff_pairs(before: str, after: str) -> tuple[dict[str, str], dict[str, str]]:
    """What a correction taught: ({misread word: right word}, {misread phrase: right phrase}).

    Words are paired when the edit replaces the same number of words, as in
    "perpueral units" -> "peripheral units". Anything else is kept as a whole phrase.
    A change of capitals alone teaches nothing.
    """
    a, b = cores(before), cores(after)
    al, bl = [w.lower() for w in a], [w.lower() for w in b]
    if al == bl:
        return {}, {}
    fixes: dict[str, str] = {}
    mismatched = False
    for op, i0, i1, j0, j1 in SequenceMatcher(None, al, bl, autojunk=False).get_opcodes():
        if op == "equal":
            continue
        if op == "replace" and i1 - i0 == j1 - j0:
            for k in range(i1 - i0):
                fixes[al[i0 + k]] = b[j0 + k]
        else:
            mismatched = True
    phrases = {}
    if mismatched and 0 < len(a) <= 8:
        phrases[" ".join(al)] = " ".join(b)
    return fixes, phrases


class Profile:
    def __init__(self, data: dict | None = None, path: Path | None = None):
        self.data = data if data is not None else copy.deepcopy(SEED)
        self.path = path
        self._agg = None

    # --- storage -----------------------------------------------------------------

    @classmethod
    def load(cls, path: str | Path) -> "Profile":
        path = Path(path)
        data = copy.deepcopy(SEED)
        if path.exists():
            data.update(json.loads(path.read_text()))
        return cls(data, path)

    def save(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(self.data, f, indent=1, ensure_ascii=False)
        os.replace(tmp, self.path)

    # --- what it knows -----------------------------------------------------------

    def _maps(self):
        """(shorthand, fixes, phrases, vocab) with learned parts merged across notes."""
        if self._agg is None:
            fixes: dict[str, Counter] = {}
            phrases: dict[str, Counter] = {}
            vocab: Counter = Counter()
            for n in self.data["notes"].values():
                for raw, to in n.get("fixes", {}).items():
                    fixes.setdefault(raw, Counter())[to] += 1
                for raw, to in n.get("phrases", {}).items():
                    phrases.setdefault(raw, Counter())[to] += 1
                vocab.update(n.get("words", []))
            for n in self.data["labeled"].values():
                vocab.update(n.get("words", []))
            shorthand = {k.lower(): v for k, v in self.data["shorthand"].items()}
            best = lambda m: {k: c.most_common(1)[0][0] for k, c in m.items()}
            for to in best(fixes).values():
                vocab.update(words(to))
            self._agg = (shorthand, best(fixes), best(phrases), vocab)
        return self._agg

    def vocab(self) -> Counter:
        return self._maps()[3]

    def learned_fixes(self) -> list[dict]:
        """Every learned word fix with how many notes taught it, for the profile screen."""
        counts: Counter = Counter()
        for n in self.data["notes"].values():
            counts.update(n.get("fixes", {}).keys())
        fixes = self._maps()[1]
        return [{"raw": k, "to": v, "notes": counts[k]} for k, v in sorted(fixes.items())]

    def set_shorthand(self, shorthand: dict[str, str]) -> None:
        self.data["shorthand"] = {k.strip(): v.strip() for k, v in shorthand.items() if k.strip() and v.strip()}
        self._agg = None

    def set_cues(self, cues: list[str]) -> None:
        seen, out = set(), []
        for c in cues:
            c = " ".join(c.lower().split())
            if c and c not in seen:
                seen.add(c)
                out.append(c)
        self.data["action_cues"] = out

    def forget_fix(self, raw: str) -> None:
        for n in self.data["notes"].values():
            n.get("fixes", {}).pop(raw, None)
        self._agg = None

    # --- learning ----------------------------------------------------------------

    def learn_note(self, note_id: str, engine_page: dict, shown_page: dict, page: dict, confirmed: bool = False) -> dict:
        """Record what the corrections in `page` taught. Replaces anything this note taught
        before, so saving repeatedly never double-counts.

        `engine_page` is what the reader produced, `shown_page` what you were first shown (the
        reading after your profile had rewritten it). A line counts as yours only if it differs
        from `shown_page`; for those, the pair learned is engine reading -> your text. Words you
        typed or edited always join the vocabulary. Words you left alone join only when you say
        the whole page is right (`confirmed`); otherwise they may be misreadings."""
        raw = {e["id"]: e.get("text", "") for e in engine_page["elements"] if e.get("type") == "text"}
        shown = {e["id"]: e.get("text", "") for e in shown_page["elements"] if e.get("type") == "text"}
        fixes: dict[str, str] = {}
        phrases: dict[str, str] = {}
        vocab: list[str] = []
        for e in page["elements"]:
            if e.get("type") != "text":
                continue
            edited = e["id"] not in shown or shown[e["id"]] != e["text"]
            if edited or confirmed:
                vocab += words(e.get("text", ""))
            if edited and e["id"] in raw:
                f, ph = diff_pairs(raw[e["id"]], e["text"])
                fixes.update(f)
                phrases.update(ph)
        self.data["notes"][note_id] = {"words": sorted(set(vocab)), "fixes": fixes, "phrases": phrases,
                                       "confirmed": confirmed}
        self._agg = None
        return {"fixes": len(fixes), "phrases": len(phrases), "words": len(set(vocab))}

    def forget_note(self, note_id: str) -> None:
        self.data["notes"].pop(note_id, None)
        self._agg = None

    def learn_labeled(self, folder: str | Path) -> int:
        """Take the vocabulary of hand-labeled pages (data/labeled/*.json) as written by you."""
        n = 0
        for f in sorted(Path(folder).glob("*.json")):
            raw = json.loads(f.read_text())
            vocab = [w for e in raw.get("elements", []) if e.get("type") == "text" for w in words(e.get("text", ""))]
            for link in raw.get("links", []):
                vocab += words(link.get("label", ""))
            self.data["labeled"][f.stem] = {"words": sorted(set(vocab))}
            n += 1
        self._agg = None
        return n

    # --- using it ----------------------------------------------------------------

    def _snap(self, core: str, vocab: Counter, fixes: dict) -> str | None:
        low = core.lower()
        if len(low) < SNAP_MIN_LEN or not low.isalpha() or low in vocab or low in fixes:
            return None
        cands = [w for w in vocab if len(w) >= SNAP_MIN_LEN]
        for cand in get_close_matches(low, cands, n=3, cutoff=SNAP_CUTOFF):
            # A reading that differs only in its last letter or two is more likely a real inflection
            # (transitions, curiosities) than a misreading, so leave it.
            if cand != low and len(commonprefix([low, cand])) < min(len(low), len(cand)) - 1:
                return match_case(core, cand)
        return None

    def rewrite(self, text: str) -> tuple[str, str | None]:
        """(new text, why) where why is "shorthand", "fix", "vocab" or None when unchanged."""
        shorthand, fixes, phrases, vocab = self._maps()
        key = " ".join(w.lower() for w in cores(text))
        if key in phrases and phrases[key] != text:
            return phrases[key], "fix"
        out, why = [], None
        for chunk in re.split(r"(\s+)", text):
            if not chunk or chunk.isspace():
                out.append(chunk)
                continue
            lead, core, trail = EDGES.match(chunk).groups()
            low = core.lower()
            if chunk.lower() in shorthand:
                out.append(shorthand[chunk.lower()])
                why = why or "shorthand"
            elif low in fixes:
                if fixes[low] != core:
                    why = why or "fix"
                out.append(lead + fixes[low] + trail)
            elif (snap := self._snap(core, vocab, fixes)):
                out.append(lead + snap + trail)
                why = why or "vocab"
            else:
                out.append(chunk)
        new = "".join(out)
        return new, (why if new != text else None)

    def apply(self, page: dict) -> tuple[dict, list[dict]]:
        """A copy of `page` with its text read through the profile, and a list of the changes."""
        out = copy.deepcopy(page)
        changes = []
        for e in out["elements"]:
            if e.get("type") != "text":
                continue
            new, why = self.rewrite(e["text"])
            if why:
                changes.append({"id": e["id"], "from": e["text"], "to": new, "why": why})
                e["text"] = new
        return out, changes

    def hints(self) -> str:
        """A paragraph for the reading model: how this writer works."""
        vocab = [w for w, _ in self.vocab().most_common(40) if len(w) >= 4]
        lines = ["About this writer:"]
        for k, v in self.data["shorthand"].items():
            lines.append(f'- A lone "{k}" is their shorthand for "{v}".')
        if vocab:
            lines.append("- Words they write often: " + ", ".join(vocab[:30]) + ".")
        fixes = self.learned_fixes()
        if fixes:
            lines.append("- Easy to misread: " + "; ".join(f'"{f["raw"]}" is really "{f["to"]}"' for f in fixes[:15]) + ".")
        if self.data["action_cues"]:
            lines.append("- A line starting with " + " or ".join(f'"{c}"' for c in self.data["action_cues"][:4]) + " is a to-do.")
        lines.append("- Underline marks a key term; ALL CAPS marks emphasis.")
        return "\n".join(lines)


def style_stats(pages: list[dict]) -> dict:
    """How you mark up a page, counted over the given pages (note pages in the schema)."""
    text = [e for p in pages for e in p["elements"] if e.get("type") == "text"]
    links = [l for p in pages for l in p.get("links", [])]
    n = len(text)
    labels = [l for l in links if l.get("label")]
    return {
        "pages": len(pages),
        "text_nodes": n,
        "words_per_node": round(sum(len(e["text"].split()) for e in text) / n, 1) if n else 0,
        "underline_rate": round(sum(bool(e.get("underline")) for e in text) / n, 2) if n else 0,
        "caps_rate": round(sum(bool(e.get("caps")) for e in text) / n, 2) if n else 0,
        "links_per_page": round(len(links) / len(pages), 1) if pages else 0,
        "link_kinds": dict(Counter(l["kind"] for l in links)),
        "connector_words": [l["label"] for l in labels][:12],
    }
