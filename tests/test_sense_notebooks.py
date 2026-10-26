"""Notebooks: the infinite canvas, kept beside the photo pages."""

import copy
import json
import math
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from sense import app, canvas, meaning, notebooks
from sense.notebooks import Conflict, clean_items, clean_links, thumb_svg, to_page
from tests.test_sense_app import AppTest, RAW


def text(i, s, x, y, w=120, h=30, **kw):
    return {"id": i, "type": "text", "x": x, "y": y, "w": w, "h": h, "text": s, "underline": False, "caps": False, **kw}


def link(i, a, b, kind="flow", **kw):
    return {"id": i, "kind": kind, "from": a, "to": b, "bend": 0, **kw}


def nb(items, links=()):
    return {"id": "20260101-000000-abcd", "title": "T", "created": "2026-01-01T00:00:00", "items": items, "links": list(links)}


class CleanTests(unittest.TestCase):
    def test_keeps_only_known_fields_and_bounds_numbers(self):
        out = clean_items([{**text("a", "hi", 1e12, float("nan")), "evil": "<script>", "w": -5}])[0]
        self.assertEqual((out["x"], out["y"], out["w"]), (notebooks.BOUND, 0.0, 0.0))
        self.assertNotIn("evil", out)

    def test_refuses_what_is_not_text_shape_or_photo_and_duplicate_ids(self):
        with self.assertRaises(ValueError):
            clean_items([{"id": "a", "type": "script"}])
        with self.assertRaises(ValueError):
            clean_items([text("a", "x", 0, 0), text("a", "y", 0, 0)])
        with self.assertRaises(ValueError):
            clean_items([text("../x", "x", 0, 0)])
        with self.assertRaises(ValueError):
            clean_items([{"id": "p", "type": "image", "x": 0, "y": 0, "src": "../../etc/passwd"}])

    def test_arrows_to_a_deleted_item_go_with_it_and_free_ends_survive(self):
        links = clean_links([link("1", "a", "gone"), link("2", "a", {"x": 50, "y": 60}), link("3", "a", "a"), link("4", "a", "b", bend=9)],
                            {"a", "b"})
        self.assertEqual([l["id"] for l in links], ["2", "4"])
        self.assertEqual(links[0]["to"], {"x": 50.0, "y": 60.0})
        self.assertEqual(links[1]["bend"], 2)  # clamped

    def test_a_word_only_travels_with_an_arrow_that_has_one(self):
        l = clean_links([link("1", "a", "b", "connector", label=" TO ", caps=True)], {"a", "b"})[0]
        self.assertEqual((l["label"], l["caps"]), ("TO", True))
        self.assertNotIn("label", clean_links([link("1", "a", "b")], {"a", "b"})[0])


class ToPageTests(unittest.TestCase):
    def test_bounds_become_the_page_and_coordinates_start_at_zero(self):
        page = to_page(nb([text("a", "left", 1000, 500), text("b", "right", 1400, 700)]))
        self.assertEqual(page["elements"][0]["bbox"][:2], [notebooks.PAD, notebooks.PAD])
        self.assertEqual(page["page_size"], [520 + 2 * notebooks.PAD, 230 + 2 * notebooks.PAD])

    def test_photos_are_reference_not_notes(self):
        page = to_page(nb([text("a", "x", 0, 0), {"id": "p", "type": "image", "x": 0, "y": 0, "w": 100, "h": 100, "src": "a.jpg"}]))
        self.assertEqual([e["id"] for e in page["elements"]], ["a"])

    def test_a_shape_contains_the_words_whose_centres_sit_inside_it(self):
        shape = {"id": "s", "type": "shape", "x": 0, "y": 0, "w": 200, "h": 200}
        page = to_page(nb([shape, text("in", "in", 40, 40), text("out", "out", 400, 400)]))
        self.assertEqual([e for e in page["elements"] if e["id"] == "s"][0]["contains"], ["in"])

    def test_free_arrows_are_drawn_but_never_a_connection(self):
        n = nb([text("a", "a", 0, 0), text("b", "b", 300, 0)], [link("1", "a", "b"), link("2", "a", {"x": 500, "y": 80})])
        self.assertEqual([l["id"] for l in to_page(n)["links"]], ["1"])
        drawn = to_page(n, with_free=True)["links"]
        self.assertEqual([l["id"] for l in drawn], ["1", "2"])
        self.assertIsInstance(drawn[1]["to"], dict)

    def test_empty_notebook_is_a_valid_empty_page(self):
        self.assertEqual(to_page(nb([]))["elements"], [])

    def test_unmeasured_text_gets_a_sensible_box(self):
        page = to_page(nb([text("a", "a fairly long thought here", 0, 0, w=0, h=0)]))
        w, h = page["elements"][0]["bbox"][2:]
        self.assertTrue(40 <= w <= notebooks.TEXT_W and h >= 20)


class MakeSenseOnACanvasTests(unittest.TestCase):
    def sense(self, n):
        return meaning.make_sense(to_page(n), ["add"], noun="notebook")

    def test_arrows_between_notes_make_a_thread_and_the_rest_is_loose(self):
        s = self.sense(nb([text("a", "idea", 0, 0), text("b", "so what", 300, 0), text("c", "stray thought", 2000, 1500)],
                         [link("1", "a", "b", "connector", label="because")]))
        self.assertEqual(s["stats"]["threads"], 1)
        self.assertEqual(s["threads"][0]["roots"][0]["children"][0]["via"]["label"], "because")
        self.assertEqual([g["items"][0]["text"] for g in s["loose"]], ["stray thought"])
        self.assertTrue(s["summary"].startswith("This notebook has"))

    def test_an_arrow_that_points_at_nothing_is_not_a_connection(self):
        s = self.sense(nb([text("a", "idea", 0, 0), text("b", "elsewhere", 300, 0)], [link("1", "a", {"x": 300, "y": 10})]))
        self.assertEqual((s["stats"]["threads"], s["stats"]["loose"]), (0, 2))

    def test_a_circle_around_words_makes_them_one_idea(self):
        shape = {"id": "s", "type": "shape", "x": 0, "y": 0, "w": 400, "h": 200}
        s = self.sense(nb([shape, text("a", "core", 40, 40), text("b", "next", 600, 40)], [link("1", "s", "b")]))
        self.assertEqual(s["threads"][0]["roots"][0]["text"], "core")

    def test_your_cues_find_the_to_dos(self):
        s = self.sense(nb([text("a", "Add Luis to the list", 0, 0)]))
        self.assertEqual([a["text"] for a in s["actions"]], ["Add Luis to the list"])


class ThumbTests(unittest.TestCase):
    def test_a_picture_of_the_notebook_tinted_by_thread(self):
        n = nb([text("a", "idea", 0, 0), text("b", "so", 300, 0), text("c", "alone", 3000, 2000)], [link("1", "a", "b")])
        svg = thumb_svg(n, meaning.make_sense(to_page(n), []))
        self.assertIn("var(--sky-soft)", svg)       # the thread
        self.assertIn("var(--bg-sunken)", svg)      # the loose note
        self.assertIn("<line", svg)
        self.assertEqual(thumb_svg(nb([]), meaning.make_sense(to_page(nb([])), [])), "")


class RetypedNotebookTests(unittest.TestCase):
    def test_true_scale_with_curved_and_free_arrows(self):
        n = nb([text("a", "idea", 100, 100), text("b", "so", 500, 100)],
               [link("1", "a", "b", bend=0.3), link("2", "b", {"x": 900, "y": 300})])
        page = to_page(n, with_free=True)
        lay = canvas.layout(page, {}, normalize=False)
        self.assertTrue(lay["px"])
        self.assertEqual(lay["w"], page["page_size"][0])
        curved, free = lay["arrows"]
        self.assertIsNotNone(curved["cx"])
        self.assertIsNone(free["cx"])
        self.assertEqual((free["x2"], free["to"]), (page["links"][1]["to"]["x"], None))  # ends on the paper, no padding
        html = canvas.render_html(lay)
        self.assertIn('class="canvas px"', html)
        self.assertIn("<path", html)
        self.assertEqual(html.count("<line"), 1)

    def test_a_bent_arrow_bows_to_the_right_of_where_it_points(self):
        lay = canvas.layout({"page_size": [1000, 500], "elements": [], "links": [
            {"id": "l", "kind": "flow", "from": {"x": 100, "y": 250}, "to": {"x": 500, "y": 250}, "bend": 0.25}]}, {}, normalize=False)
        a = lay["arrows"][0]
        self.assertEqual((a["cx"], a["cy"]), (300, 350))  # pointing right, "right of travel" is down the screen
        self.assertEqual((a["mx"], a["my"]), (300, 300))


class NotebookAPITests(AppTest):
    def create(self, title="Ideas"):
        status, nb_, _ = self.call("POST", "/api/notebooks", {"title": title})
        self.assertEqual(status, 201, nb_)
        return nb_

    def save(self, nb_, **changes):
        return self.call("PUT", f"/api/notebooks/{nb_['id']}", {"rev": nb_["rev"], **changes})

    def test_create_list_get_delete(self):
        a, b = self.create("First"), self.create("Second")
        self.assertNotEqual(a["color"], b["color"])  # each notebook gets its own colour
        _, rows, _ = self.call("GET", "/api/notebooks")
        self.assertEqual({r["title"] for r in rows}, {"First", "Second"})
        self.assertEqual(self.call("GET", f"/api/notebooks/{a['id']}")[1]["items"], [])
        self.assertEqual(self.call("DELETE", f"/api/notebooks/{a['id']}")[0], 200)
        self.assertEqual(self.call("GET", f"/api/notebooks/{a['id']}")[0], 404)
        self.assertEqual(len(self.call("GET", "/api/notebooks")[1]), 1)

    def test_saving_returns_what_the_canvas_means(self):
        n = self.create()
        status, saved, _ = self.save(n, items=[text("a", "idea", 0, 0), text("b", "so", 300, 0)], links=[link("1", "a", "b")],
                                     title="Renamed", view={"x": 5, "y": 6, "z": 2})
        self.assertEqual(status, 200, saved)
        self.assertEqual((saved["rev"], saved["sense"]["stats"]["threads"]), (2, 1))
        self.assertIn("thread th0", saved["sense_html"])
        _, again, _ = self.call("GET", f"/api/notebooks/{n['id']}")
        self.assertEqual((again["title"], again["view"]["z"], len(again["items"])), ("Renamed", 2.0, 2))

    def test_a_stale_copy_cannot_overwrite_a_newer_one(self):
        n = self.create()
        self.assertEqual(self.save(n, title="One")[0], 200)
        status, body, _ = self.save(n, title="Two")  # still holds rev 1
        self.assertEqual(status, 409)
        self.assertIn("another tab", body["error"])
        self.assertEqual(self.call("GET", f"/api/notebooks/{n['id']}")[1]["title"], "One")

    def test_bad_saves_are_refused_with_a_reason_and_change_nothing(self):
        n = self.create()
        status, body, _ = self.save(n, items=[{"id": "x", "type": "script"}])
        self.assertEqual(status, 400)
        self.assertIn("isn't text", body["error"])
        self.assertEqual(self.call("GET", f"/api/notebooks/{n['id']}")[1]["rev"], 1)

    def test_path_tricks_and_missing_things_are_404(self):
        n = self.create()
        for path in ("/api/notebooks/..%2f..%2fetc", "/api/notebooks/20260101-000000-abcd", f"/api/notebooks/{n['id']}/assets/..%2fnotebook.json",
                     f"/api/notebooks/{n['id']}/assets/nothing.jpg"):
            self.assertEqual(self.call("GET", path)[0], 404, path)

    def test_a_photographed_page_lands_beside_its_photo_and_the_page_is_unchanged(self):
        note = self.upload()
        n = self.create()
        before = (self.home / note["id"] / "page.json").read_text()
        status, got, _ = self.call("POST", f"/api/notebooks/{n['id']}/import", {"note_id": note["id"]})
        self.assertEqual(status, 200, got)
        kinds = [i["type"] for i in got["items"]]
        self.assertEqual((kinds.count("image"), kinds.count("text")), (1, 3))
        photo = next(i for i in got["items"] if i["type"] == "image")
        words = [i for i in got["items"] if i["type"] == "text"]
        self.assertEqual(photo["w"], notebooks.IMPORT_W)
        self.assertGreater(min(w["x"] for w in words), photo["x"] + photo["w"])  # beside it, not on top
        self.assertEqual(sorted(w["text"] for w in words), sorted(e["text"] for e in note["page"]["elements"]))
        self.assertEqual(len(got["added"]), 4)
        _, img, hdrs = self.call("GET", f"/api/notebooks/{n['id']}/assets/{photo['src']}", raw=True)
        self.assertTrue(img.startswith(b"\xff\xd8"))
        self.assertEqual((self.home / note["id"] / "page.json").read_text(), before)  # the page itself is untouched

    def test_a_second_import_goes_to_free_space_and_keeps_the_first(self):
        note = self.upload()
        n = self.create()
        first = self.call("POST", f"/api/notebooks/{n['id']}/import", {"note_id": note["id"]})[1]
        second = self.call("POST", f"/api/notebooks/{n['id']}/import", {"note_id": note["id"]})[1]
        self.assertEqual(len(second["items"]), 2 * len(first["items"]))
        self.assertEqual(len({i["id"] for i in second["items"]}), len(second["items"]))
        old_right = max(i["x"] + i["w"] for i in first["items"])
        added = [i for i in second["items"] if i["id"] in second["added"]]
        self.assertGreater(min(i["x"] for i in added), old_right)

    def test_a_new_photo_is_read_by_the_engine_and_put_on_the_canvas(self):
        n = self.create()
        status, got, _ = self.call("POST", f"/api/notebooks/{n['id']}/photo?x=100&y=200", b"jpegbytes", {"Content-Type": "image/jpeg"})
        self.assertEqual(status, 201, got)
        photo = next(i for i in got["items"] if i["type"] == "image")
        self.assertEqual((photo["x"], photo["y"]), (100.0, 200.0))
        self.assertEqual(len(self.call("GET", "/api/notes")[1]), 1)  # it is also under Pages

    def test_export_is_a_standalone_page_at_true_scale(self):
        n = self.create("Big ideas")
        self.save(n, items=[text("a", "idea <b>one</b>", 0, 0), text("b", "so", 3000, 100)], links=[link("1", "a", "b", bend=0.2),
                                                                                                  link("2", "b", {"x": 3300, "y": 400})])
        status, html, hdrs = self.call("GET", f"/api/notebooks/{n['id']}/share.html", raw=True)
        html = html.decode()
        self.assertEqual((status, hdrs["Content-Disposition"]), (200, 'attachment; filename="big-ideas.html"'))
        self.assertIn('class="canvas px"', html)
        self.assertIn("From a notebook", html)
        self.assertNotIn("<script", html)
        self.assertNotIn("<b>one</b>", html)
        self.assertEqual(html.count("data:font/woff2;base64,"), 4)
        _, md, _ = self.call("GET", f"/api/notebooks/{n['id']}/share.md", raw=True)
        self.assertIn("From a notebook on", md.decode())

    def test_narration_needs_a_key_and_goes_stale_when_you_edit(self):
        n = self.create()
        self.assertEqual(self.call("POST", f"/api/notebooks/{n['id']}/narrate")[0], 400)
        with mock.patch.object(notebooks.engine, "gemini_key", return_value="k"), \
                mock.patch.object(notebooks.narrate, "narrate", return_value={"title": "T", "summary": "S"}):
            got = self.call("POST", f"/api/notebooks/{n['id']}/narrate")[1]
        self.assertEqual(got["narration"], {"title": "T", "summary": "S", "stale": False})
        after = self.call("PUT", f"/api/notebooks/{n['id']}", {"rev": 1, "items": [text("a", "x", 0, 0)]})[1]
        self.assertEqual(after["rev"], 2)
        self.assertTrue(self.call("GET", f"/api/notebooks/{n['id']}")[1]["narration"]["stale"])

    def test_the_server_says_notebooks_are_on(self):
        self.assertTrue(self.call("GET", "/api/status")[1]["notebooks"])


class WebFilesTests(AppTest):
    def test_the_canvas_files_are_served_from_an_allow_list(self):
        status, js, hdrs = self.call("GET", "/web/canvas.js", raw=True)
        self.assertEqual((status, hdrs["Content-Type"]), (200, "text/javascript; charset=utf-8"))
        self.assertIn(b"export function mountCanvas", js)
        self.assertEqual(self.call("GET", "/web/canvas.css", raw=True)[2]["Content-Type"], "text/css; charset=utf-8")
        for bad in ("notebooks.py", "..%2fapp.py", "canvas.js%2f..%2fapp.py", "ui.html", "canvas.js/x"):
            self.assertEqual(self.call("GET", f"/web/{bad}")[0], 404, bad)

    def test_the_page_offers_notebooks_only_as_an_added_section(self):
        _, html, _ = self.call("GET", "/", raw=True)
        html = html.decode()
        self.assertIn("HAS_NB", html)
        self.assertIn("'/web/canvas.js'", html)
        self.assertIn('"move-up-right"', html)          # the canvas tools' glyphs came with the page
        self.assertIn("NAV_BASE", html)                  # Your pages and How you write are still the base of the nav
        self.assertIn("if (h.startsWith('#/note/')) return notePage", html)  # the photo routes are as they were

    @unittest.skipUnless(__import__("shutil").which("node"), "needs node")
    def test_the_editor_is_valid_javascript(self):
        import subprocess
        r = subprocess.run(["node", "--experimental-default-type=module", "--check", str(Path(app.__file__).parent / "web" / "canvas.js")],
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


class PhotoFlowIsIndependentTests(unittest.TestCase):
    """Notebooks are a parallel section: nothing in the photo flow depends on them."""

    def test_no_photo_flow_module_imports_notebooks(self):
        root = Path(app.__file__).parent
        for name in ("profile", "engine", "meaning", "canvas", "share", "theme", "narrate"):
            src = (root / f"{name}.py").read_text()
            self.assertNotRegex(src, r"(from \. import [^\n]*\bnotebooks\b|import notebooks|sense\.notebooks)", name)

    def test_the_photo_store_knows_nothing_of_them(self):
        self.assertFalse([n for n in dir(app.Store) if "notebook" in n.lower()])

    def test_the_single_page_renderer_is_unchanged_by_the_canvas_options(self):
        page = {"page_size": [1000, 500], "elements": [{"id": "a", "type": "text", "bbox": [100, 100, 100, 40], "text": "hi"}], "links": []}
        lay = canvas.layout(page)
        self.assertEqual((lay["w"], lay["h"], lay["px"]), (1000, 500, False))
        html = canvas.render_html(lay)
        self.assertIn('class="canvas" style="aspect-ratio:1000/500"', html)
        self.assertIn("max-width:", html)
        self.assertNotIn("canvas px", html)


class WithoutNotebooksTests(unittest.TestCase):
    """--no-notebooks is the app exactly as it was: photo pages only."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        quiet = mock.patch.object(app.Handler, "log_message", lambda *a: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        self.server = app.make_server(Path(self.tmp.name, "notes"), "127.0.0.1", 0, Path(self.tmp.name, "x"), with_notebooks=False)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def get(self, path):
        import urllib.error
        import urllib.request
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", headers={"X-Makesense": "1"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read() or b"null") if "json" in r.headers.get("Content-Type", "") else r.read()
        except urllib.error.HTTPError as e:
            e.close()
            return e.code, None

    def test_no_notebook_routes_no_web_files_and_the_status_says_so(self):
        self.assertEqual(self.get("/api/status")[1]["notebooks"], False)
        for path in ("/api/notebooks", "/web/canvas.js", "/web/canvas.css"):
            self.assertEqual(self.get(path)[0], 404, path)
        self.assertEqual(self.get("/api/notes")[0], 200)  # the photo pages carry on
        self.assertFalse((Path(self.tmp.name, "notes", "notebooks")).exists())


if __name__ == "__main__":
    unittest.main()
