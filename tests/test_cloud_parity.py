"""The browser's copy of the reading engine gives the same answers as the Python original.

The cloud site has no Python in it, so meaning/canvas/share/notebooks logic is ported to JavaScript (sense/cloud/web/).
This computes a few hundred cases with the Python and has node run the port on the same inputs.
Skipped when node is not installed.
"""

import json
import random
import secrets
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from harness.schema import parse_page, validate
from sense import app, canvas, meaning, notebooks, share, theme
from sense.notebooks import clean_items, clean_links, thumb_svg, to_page

ROOT = Path(__file__).resolve().parent.parent
WORDS = ["Belief", "core", "Add Luis Garcia", "PhDs in HCI", "café", "日本語", "R&D", "a<b>c", 'say "hi"', "it's", "TRY TO", "buy milk",
         "→ next", "email Sam", "x", "Transition", "the user's goal", "naïve", "call Jo", "co-design", "10", "a  b", "Ünïcode", "¿qué?"]
CUES = ["add", "todo", "call", "email", "->", "buy", "→"]
SIZES = [[1000, 500], [210, 297], [1654.5, 2339.25], [800.5, 600.25], [640, 480]]


def num(r, hi):
    k = r.random()
    return float(r.randint(0, int(hi))) if k < 0.4 else r.randint(0, int(hi) * 4) / 4 if k < 0.7 else r.random() * hi


def random_page(r: random.Random, free_ends=False):
    pw, ph = r.choice(SIZES)
    n = r.randint(0, 40)
    els = []
    numeric_ids = r.random() < 0.3                       # ids like "7" and "10" test that order is by insertion, not by number
    for i in range(n):
        eid = str(i + 1) if numeric_ids else f"{r.choice('tsdu')}{i}"
        kind = r.choices(["text", "shape", "doodle"], [70, 15, 15])[0]
        w, h = max(1.0, num(r, pw / 5)), max(1.0, num(r, ph / 12))
        x, y = min(num(r, pw), pw - w), min(num(r, ph), ph - h)
        e = {"id": eid, "type": kind, "bbox": [x, y, w, h]}
        if kind == "text":
            e.update(text=r.choice(WORDS), underline=r.random() < 0.25, caps=r.random() < 0.2)
        els.append(e)
    ids = [e["id"] for e in els]
    for e in els:
        if e["type"] == "shape":
            e["contains"] = [c for c in r.sample(ids, min(len(ids), r.randint(0, 4)))] + (["nope"] if r.random() < 0.1 else [])
    links = []
    for k in range(r.randint(0, 30) if ids else 0):
        def end():
            v = r.random()
            if v < 0.05:
                return "missing"
            if free_ends and v < 0.2:
                return {"x": num(r, pw), "y": num(r, ph)}
            c = r.choice(ids)
            return [{"id": c, "confidence": 0.7}] if v > 0.93 else c
        l = {"id": f"l{k}", "kind": r.choice(["flow", "flow", "hook", "connector"]), "from": end(), "to": end()}
        if r.random() < 0.4:
            l.update(label=r.choice(WORDS), caps=r.random() < 0.3, underline=r.random() < 0.3)
        if r.random() < 0.3:
            l["bend"] = r.choice([0, 0.15, -0.2, 0.5, 0.0])
        links.append(l)
    return {"page_id": "p", "page_size": [pw, ph], "elements": els, "links": links}


def attempt(fn, *a):
    try:
        return {"ok": fn(*a)}
    except Exception as e:  # noqa: BLE001: the port has to refuse the same inputs
        return {"error": str(e)}


def thread_of(sense):
    return {i: n for n, t in enumerate(sense["threads"]) for i in t["ids"]}


def random_notebook(r: random.Random):
    items, ids = [], []
    for i in range(r.randint(0, 25)):
        iid = f"i{i}"
        ids.append(iid)
        kind = r.choices(["text", "shape", "image"], [70, 15, 15])[0]
        it = {"id": iid, "type": kind, "x": num(r, 3000) - 500, "y": num(r, 2000) - 300, "w": r.choice([0, 0, 120, 200.5]), "h": r.choice([0, 30, 60.25])}
        if kind == "text":
            it.update(text=r.choice(WORDS + ["  ", "line one\nline two is longer", ""]), underline=r.random() < 0.2, caps=r.random() < 0.2, fixed=r.random() < 0.3)
        if kind == "image":
            it["src"] = "20260101-000000-abcd.jpg"
        if kind == "shape":
            it.update(w=max(it["w"], 150.0), h=max(it["h"], 100.0))
        items.append(it)
    links = []
    for k in range(r.randint(0, 20) if ids else 0):
        def end():
            v = r.random()
            return {"x": num(r, 3000), "y": num(r, 2000)} if v < 0.15 else "gone" if v < 0.2 else r.choice(ids)
        l = {"id": f"a{k}", "kind": r.choice(["flow", "hook", "connector"]), "from": end(), "to": end(), "bend": r.choice([0, 0.2, -0.3, 1.5, 3])}
        if r.random() < 0.4:
            l.update(label=r.choice(WORDS + [" padded "]), caps=r.random() < 0.3, underline=r.random() < 0.3)
        links.append(l)
    return {"id": "20260101-000000-abcd", "title": "T", "created": "2026-01-01T09:30:00", "items": items, "links": links}


class CountingHex:
    """secrets.token_hex that returns 000001, 000002, ... so the port can reproduce the ids."""

    def __init__(self):
        self.n = 0

    def __call__(self, nbytes=3):
        self.n += 1
        return f"{self.n:0{nbytes * 2}x}"


def build_cases():
    r = random.Random(2026)
    cases = []

    def add(name, op, args, expect, **kw):
        cases.append({"name": name, "op": op, "args": args, "expect": expect, **kw})

    cue_sets = [[], ["add"], CUES, ["add", "add to", "-> do"]]
    for i in range(70):
        page = random_page(r)
        cues = r.choice(cue_sets)
        noun = r.choice(["page", "notebook"])
        sense = meaning.make_sense(page, cues, noun)
        add(f"sense {i}", "makeSense", [page, cues, noun], {"ok": sense})
        t = thread_of(sense)
        for norm in (True, False):
            lay = canvas.layout(page, t, norm)
            add(f"layout {i} {norm}", "layout", [page, t, norm], {"ok": lay})
            add(f"render {i} {norm}", "renderHtml", [page, t, norm], {"ok": canvas.render_html(lay)})
        add(f"sense html {i}", "senseHtml", [sense, i % 2 == 0, None if i % 3 else "Nothing <here>"], {"ok": share.sense_html(sense, i % 2 == 0, None if i % 3 else "Nothing <here>")})
        note = {"title": r.choice(WORDS), "created": "2026-03-05T10:20:30", "page": page, "sense": sense,
                "narration": {"summary": "A <b>summary</b> & more"} if i % 5 == 0 else None}
        if i % 4 == 0:
            note.update(px=True, voice={"kicker": "From a notebook", "section": "The notebook, <em>laid out</em>", "md": "From a notebook", "footer": "Written on an endless page."})
        add(f"markdown {i}", "toMarkdown", [note], {"ok": share.to_markdown(note)})
        add(f"html {i}", "toHtml", [note, None if i % 3 else "QUJD"], {"ok": share.to_html(note, None if i % 3 else b"ABC")})
    for i in range(25):                                    # arrows with free ends and bends, as a notebook draws them
        page = random_page(r, free_ends=True)
        t = {} if i % 2 else thread_of(meaning.make_sense({**page, "links": [l for l in page["links"] if not any(isinstance(l[k], dict) for k in ("from", "to"))]}))
        for norm in (True, False):
            lay = canvas.layout(page, t, norm)
            add(f"free layout {i} {norm}", "layout", [page, t, norm], {"ok": lay})
            add(f"free render {i} {norm}", "renderHtml", [page, t, norm], {"ok": canvas.render_html(lay)})
    # the empty page and the one with a single word
    for name, page in {"empty": {"page_size": [1000, 700], "elements": [], "links": []},
                       "one": {"page_size": [100, 100], "elements": [{"id": "a", "type": "text", "bbox": [1, 1, 5, 5], "text": "  hello  "}], "links": []}}.items():
        add(name, "makeSense", [page, [], "page"], {"ok": meaning.make_sense(page, [], "page")})
    # cycles, self links, a shape and its word both ends
    cyc = {"page_size": [1000, 500], "elements": [
        {"id": "a", "type": "text", "bbox": [10, 10, 80, 30], "text": "A"}, {"id": "b", "type": "text", "bbox": [200, 10, 80, 30], "text": "B"},
        {"id": "c", "type": "text", "bbox": [400, 10, 80, 30], "text": "C", "underline": True},
        {"id": "s", "type": "shape", "bbox": [380, 0, 150, 60], "contains": ["c"]}],
        "links": [{"id": "1", "kind": "flow", "from": "a", "to": "b"}, {"id": "2", "kind": "flow", "from": "b", "to": "a"},
                  {"id": "3", "kind": "connector", "from": "b", "to": "c", "label": "to", "caps": True}, {"id": "4", "kind": "hook", "from": "s", "to": "a"}]}
    add("cycle", "makeSense", [cyc, ["a"], "page"], {"ok": meaning.make_sense(cyc, ["a"], "page")})

    # cleaning what the editor sends
    pages_in = [random_page(r) for _ in range(30)]
    for i, p in enumerate(pages_in):
        for e in p["elements"]:
            if e["type"] == "text" and r.random() < 0.1:
                e["text"] = "   "
            if r.random() < 0.05:
                e["bbox"][2] = 0
        for l in p["links"]:
            if isinstance(l["from"], list):
                l["from"] = l["from"][0]["id"]
            if isinstance(l["to"], list):
                l["to"] = l["to"][0]["id"]
        add(f"clean page {i}", "cleanPage", [p, "pid"], attempt(app.clean_page, p, "pid"))
    for i, bad in enumerate([{}, {"elements": "x"}, {"elements": [{"id": "a", "type": "text", "bbox": [1, 1, 1, 1], "text": "x"}] * 2, "page_size": [10, 10]},
                             {"elements": [{"id": "a", "type": "blob", "bbox": [1, 1, 1, 1]}], "page_size": [10, 10]},
                             {"elements": [{"id": "a", "type": "text", "bbox": [1, 1, 1, 1], "text": "x"}], "page_size": [10, 10], "links": [{"kind": "flow", "from": "a", "to": "zz"}]},
                             {"elements": [{"id": "a", "type": "text", "bbox": [1, 1, 1, 1], "text": "x"}], "page_size": [10, 10], "links": [{"kind": "wavy", "from": "a", "to": "a"}]}]):
        add(f"clean page bad {i}", "cleanPage", [bad, "pid"], attempt(app.clean_page, bad, "pid"))

    # notebooks
    for i in range(40):
        nb = random_notebook(r)
        clean = attempt(clean_items, nb["items"])
        add(f"clean items {i}", "cleanItems", [nb["items"]], clean)
        if "ok" in clean:
            items = clean["ok"]
            idset = {x["id"] for x in items}
            links = attempt(clean_links, nb["links"], idset)
            add(f"clean links {i}", "cleanLinks", [nb["links"], sorted(idset)], links)
            nb = {**nb, "items": items, "links": links["ok"]}
            for free in (False, True):
                add(f"to page {i} {free}", "toPage", [nb, free], {"ok": to_page(nb, free)})
            sense = meaning.make_sense(to_page(nb), [], "notebook")
            add(f"thumb {i}", "thumbSvg", [nb, sense], {"ok": thumb_svg(nb, sense)})
    for i, junk in enumerate([[{"id": "a", "type": "script"}], [{"id": "../x", "type": "text"}], [{"id": "p", "type": "image", "src": "../../x"}],
                              [{"id": "a", "type": "text", "x": "12", "y": "abc", "w": None, "h": True, "text": 5}], "nope",
                              [{"id": "a", "type": "text", "x": 1e12, "y": float("inf") if False else -1e12, "text": "x" * 6000}]]):
        add(f"junk items {i}", "cleanItems", [junk], attempt(clean_items, junk))
    for i, junk in enumerate([[{"id": "1", "kind": "wavy", "from": "a", "to": "b"}], [{"id": "1", "kind": "flow", "from": "a", "to": "b", "bend": "0.4"}],
                              [{"id": "1", "kind": "flow", "from": {"x": "5", "y": 6}, "to": {"x": 5, "y": 6}}], "nope"]):
        add(f"junk links {i}", "cleanLinks", [junk, ["a", "b"]], attempt(clean_links, junk, {"a", "b"}))

    # putting a photographed page on a canvas
    with tempfile.TemporaryDirectory() as td, mock.patch.object(secrets, "token_hex", CountingHex()):
        home = Path(td)
        store = app.Store(home, labeled=home / "none")
        nbs = notebooks.Notebooks(store)
        for i in range(8):
            page = random_page(r)
            page["elements"] = [e for e in page["elements"] if e["type"] != "doodle"] or page["elements"]
            note_id = f"20260202-0000{i:02d}-{i:04x}"
            (home / note_id).mkdir()
            (home / note_id / "page.json").write_text(json.dumps(page))
            (home / note_id / "flat.jpg").write_bytes(b"jpg")
            nb = nbs.create(f"Book {i}")
            base = random_notebook(r) if i % 2 else None
            if base:
                base["id"] = nb["id"]
                nbs._write({**nb, "items": base["items"], "links": base["links"]})
                kept = notebooks.clean_items(base["items"])
                nbs._write({**nb, "items": kept, "links": notebooks.clean_links(base["links"], {x["id"] for x in kept})})
            before = nbs._load(nb["id"])
            secrets.token_hex.n = 0
            at = {"x": 40.5, "y": 10} if i % 3 == 0 else None
            got = nbs.import_note(nb["id"], note_id, at)
            add(f"import {i}", "importPage", [before, page, note_id, at],
                {"ok": {"items": got["items"], "links": got["links"], "asset": f"{note_id}.jpg"}})
    return cases


def config():
    marks = [m["svg"] for m in theme._prerendered()["thread_shapes"]]
    return {"threadMarks": marks, "signOff": theme.sign_off(), "themeCss": "/*theme*/", "shareCss": "/*share*/", "canvasCss": "/*canvas*/"}


@unittest.skipUnless(shutil.which("node"), "needs node")
class ParityTests(unittest.TestCase):
    def test_the_browser_port_agrees_with_python(self):
        with mock.patch.object(theme, "stylesheet", lambda **kw: "/*theme*/"), mock.patch.object(share, "CSS", "/*share*/"), \
                mock.patch.object(canvas, "CSS", "/*canvas*/"):
            cases = build_cases()
        self.assertGreater(len(cases), 500)
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"config": config(), "cases": cases}, f)
        try:
            out = subprocess.run(["node", str(ROOT / "tests/js/parity.mjs"), f.name], capture_output=True, text=True, cwd=ROOT)
        finally:
            Path(f.name).unlink()
        try:
            res = json.loads(out.stdout.strip().splitlines()[-1])
        except (ValueError, IndexError):
            self.fail(f"node said: {out.stdout[-800:]} {out.stderr[-1500:]}")
        self.assertEqual(res["failed"], 0, json.dumps(res["failures"], indent=1, ensure_ascii=False)[:4000])
        self.assertEqual(res["ran"], len(cases))

    def test_the_real_stylesheet_is_what_the_shared_file_carries(self):
        # one real export, so the fonts and the system's CSS are what the file embeds, in the order Python puts them
        css = theme.stylesheet(embed_fonts=True)
        page = {"page_size": [1000, 500], "elements": [{"id": "a", "type": "text", "bbox": [10, 10, 80, 30], "text": "Hi"}], "links": []}
        note = {"title": "T", "created": "2026-03-05T10:20:30", "page": page, "sense": meaning.make_sense(page)}
        want = share.to_html(note, None)
        cfg = {**config(), "themeCss": css, "shareCss": share.CSS, "canvasCss": canvas.CSS}
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"config": cfg, "cases": [{"name": "real css", "op": "toHtml", "args": [note, None], "expect": {"ok": want}}]}, f)
        try:
            out = subprocess.run(["node", str(ROOT / "tests/js/parity.mjs"), f.name], capture_output=True, text=True, cwd=ROOT)
        finally:
            Path(f.name).unlink()
        self.assertEqual(json.loads(out.stdout.strip().splitlines()[-1])["failed"], 0, out.stdout[-1500:])


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(shutil.which("node"), "needs node")
class ServiceWorkerTests(unittest.TestCase):
    """The offline shell. The real thing needs a browser that runs service workers; this runs its code against a fake cache."""

    def run_at(self, folder):
        return json.loads(subprocess.run(["node", str(ROOT / "tests/js/sw.mjs"), folder], capture_output=True, text=True, cwd=ROOT, check=True).stdout)

    def check(self, folder):
        out = self.run_at(folder)
        self.assertEqual(out["precached"], [folder, folder + "cloud/boot.js", folder + "config.json"])
        self.assertTrue(out["oldCacheDropped"])
        self.assertEqual(out["navigation"], "cached:" + folder, "opens from the device first, whatever the network is doing")
        self.assertEqual(out["asset"], f"cached:{folder}cloud/boot.js")
        self.assertEqual(out["otherSite"], "passed through", "Firebase and every other site are never answered from here")
        self.assertEqual(out["authHelper"], "passed through", "Firebase's own sign-in pages are never answered from here")
        self.assertEqual(out["post"], "passed through")
        self.assertIn(out["offlineShell"], ("cached:" + folder, "network:" + folder), "the page opens with no connection")
        self.assertIn("Offline", out["offlineUncached"])
        return out

    def test_it_keeps_the_site_and_only_the_site(self):
        self.check("/")

    def test_in_a_folder_of_a_shared_domain_it_leaves_the_rest_of_the_domain_alone(self):
        out = self.check("/anchor/app/")
        self.assertEqual(out["anotherPageOnTheDomain"], "passed through", "prineethr.com's other pages are not this site's to cache")
