import copy
import http.client
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

from sense import app, engine, narrate

RAW = {"page_id": "x", "page_size": [200, 100], "links": [], "elements": [
    {"id": "t1", "type": "text", "bbox": [10, 10, 40, 10], "text": "Franthon"},
    {"id": "t2", "type": "text", "bbox": [100, 10, 40, 10], "text": "Ocore"},
    {"id": "t3", "type": "text", "bbox": [10, 60, 60, 10], "text": "7 taestan"},
]}


def fake_make_flat(data, flat, crop=True):
    cv2.imwrite(str(flat), np.full((100, 200, 3), 255, np.uint8))
    return {"how": "edges" if crop else "whole photo", "turns": 0, "sure": True, "ocr": None}


def fake_read(flat, page_id, profile, ocr=None, examples=()):
    return copy.deepcopy(RAW), "vision", []


class AppTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for name, fn in (("make_flat", fake_make_flat), ("read", fake_read)):
            p = mock.patch.object(engine, name, fn)
            p.start()
            self.addCleanup(p.stop)
        for name, val in (("vision_ready", True), ("gemini_key", None)):
            p = mock.patch.object(engine, name, return_value=val)
            p.start()
            self.addCleanup(p.stop)
        quiet = mock.patch.object(app.Handler, "log_message", lambda *a: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        self.home = Path(self.tmp.name, "notes")
        self.server = app.make_server(self.home, "127.0.0.1", 0, labeled=Path(self.tmp.name, "labeled"))
        self.store = self.server.RequestHandlerClass.store
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def call(self, method, path, body=None, headers=None, raw=False):
        """(status, parsed JSON or bytes, response headers)."""
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        h = {"X-Makesense": "1", **(headers or {})}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                status, payload, hdrs = r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            status, payload, hdrs = e.code, e.read(), e.headers
            e.close()
        if not raw and "json" in (hdrs.get("Content-Type") or ""):
            payload = json.loads(payload)
        return status, payload, hdrs

    def upload(self):
        status, note, _ = self.call("POST", "/api/notes", b"jpegbytes", {"Content-Type": "image/jpeg"})
        self.assertEqual(status, 201, note)
        return note

    def corrected(self, note, **texts):
        page = copy.deepcopy(note["page"])
        for e in page["elements"]:
            if e["id"] in texts:
                e["text"] = texts[e["id"]]
        return page


class CreateAndViewTests(AppTest):
    def test_serves_the_page_with_its_styles_filled_in(self):
        status, html, hdrs = self.call("GET", "/", raw=True)
        self.assertEqual(status, 200)
        self.assertIn(b"Make sense", html)
        self.assertNotIn(b"__CANVAS_CSS__", html)
        self.assertIn(b".canvas .box", html)

    def test_upload_reads_the_page_and_applies_the_profile(self):
        note = self.upload()
        texts = {e["id"]: e["text"] for e in note["page"]["elements"]}
        self.assertEqual(texts["t3"], "of taestan")  # your seeded shorthand
        self.assertEqual(note["changes"], [{"id": "t3", "from": "7 taestan", "to": "of taestan", "why": "shorthand"}])
        self.assertEqual((note["source"], note["how"], note["confirmed"]), ("vision", "edges", False))
        self.assertTrue(note["sense_html"] and note["clean_html"] and note["layout"]["boxes"])
        d = self.home / note["id"]
        self.assertEqual(sorted(p.name for p in d.iterdir()),
                         ["engine.json", "flat.jpg", "meta.json", "original", "page.json", "shown.json"])
        self.assertEqual(json.loads((d / "engine.json").read_text())["elements"][2]["text"], "7 taestan")  # raw kept

    def test_list_and_photo(self):
        note = self.upload()
        status, rows, _ = self.call("GET", "/api/notes")
        self.assertEqual([r["id"] for r in rows], [note["id"]])
        self.assertEqual(rows[0]["loose"], 3)
        status, photo, hdrs = self.call("GET", f"/api/notes/{note['id']}/photo", raw=True)
        self.assertEqual((status, hdrs["Content-Type"]), (200, "image/jpeg"))
        self.assertTrue(photo.startswith(b"\xff\xd8"))

    def test_an_unreadable_upload_leaves_nothing_behind(self):
        with mock.patch.object(engine, "make_flat", side_effect=engine.EngineError("That file is not an image I can open.")):
            status, body, _ = self.call("POST", "/api/notes", b"junk")
        self.assertEqual((status, body["error"]), (422, "That file is not an image I can open."))
        self.assertEqual(list(self.home.glob("2*")), [])
        self.assertEqual(self.store.profile.data["notes"], {})

    def test_empty_and_oversized_uploads_are_refused(self):
        self.assertEqual(self.call("POST", "/api/notes", b"")[0], 400)
        with mock.patch.object(app, "MAX_UPLOAD", 3):
            status, body, _ = self.call("POST", "/api/notes", b"toolarge")
        self.assertEqual(status, 400)
        self.assertIn("Try a smaller photo", body["error"])


class GuardTests(AppTest):
    def test_writes_need_the_custom_header(self):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/notes", data=b"x", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(req)
        cm.exception.close()
        self.assertEqual(cm.exception.code, 403)

    def test_a_foreign_host_header_is_refused(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("GET", "/api/notes", headers={"Host": "evil.example", "X-Makesense": "1"})
        self.assertEqual(c.getresponse().status, 403)

    def test_ids_cannot_reach_other_files(self):
        for bad in ("..%2f..%2fetc%2fpasswd", "not-an-id", "20260101-000000-zzzz"):
            self.assertEqual(self.call("GET", f"/api/notes/{bad}")[0], 404, bad)
        self.assertEqual(self.call("GET", "/nope")[0], 404)


class EditAndLearnTests(AppTest):
    def test_saving_corrections_teaches_the_profile_and_the_next_page_benefits(self):
        note = self.upload()
        page = self.corrected(note, t1="Transition", t2="core")
        page["links"] = [{"id": "m1", "kind": "connector", "from": "t1", "to": "t2", "label": "TRY TO"}]
        status, saved, _ = self.call("PUT", f"/api/notes/{note['id']}", {"page": page})
        self.assertEqual(status, 200, saved)
        self.assertTrue(saved["edited"])
        self.assertEqual(saved["sense"]["threads"][0]["roots"][0]["children"][0]["via"]["label"], "TRY TO")
        profile = json.loads((self.home / "profile.json").read_text())
        self.assertEqual(profile["notes"][note["id"]]["fixes"], {"franthon": "Transition", "ocore": "core"})
        self.assertNotIn("taestan", profile["notes"][note["id"]]["words"])  # the profile's own rewrite is not yours
        second = self.upload()
        self.assertEqual([e["text"] for e in second["page"]["elements"]][:2], ["Transition", "core"])
        self.assertEqual({c["why"] for c in second["changes"]}, {"fix", "shorthand"})

    def test_saving_again_does_not_double_count(self):
        note = self.upload()
        page = self.corrected(note, t1="Transition")
        for _ in range(3):
            self.call("PUT", f"/api/notes/{note['id']}", {"page": page})
        _, prof, _ = self.call("GET", "/api/profile")
        self.assertEqual([f for f in prof["fixes"] if f["raw"] == "franthon"][0]["notes"], 1)

    def test_checking_the_page_learns_the_words_left_alone(self):
        note = self.upload()
        self.call("PUT", f"/api/notes/{note['id']}", {"confirmed": True})
        _, prof, _ = self.call("GET", "/api/profile")
        self.assertIn(["taestan", 1], prof["vocab"])

    def test_title_and_narration_staleness(self):
        note = self.upload()
        _, t, _ = self.call("PUT", f"/api/notes/{note['id']}", {"title": "  My page  "})
        self.assertEqual(t["title"], "My page")
        self.assertEqual(self.call("POST", f"/api/notes/{note['id']}/narrate")[0], 400)  # no key
        with mock.patch.object(engine, "gemini_key", return_value="k"), \
                mock.patch.object(narrate, "narrate", return_value={"title": "T", "summary": "S"}):
            _, n, _ = self.call("POST", f"/api/notes/{note['id']}/narrate")
        self.assertEqual(n["narration"], {"title": "T", "summary": "S", "stale": False})
        _, n, _ = self.call("PUT", f"/api/notes/{note['id']}", {"page": self.corrected(note, t1="Transition")})
        self.assertTrue(n["narration"]["stale"])

    def test_preview_shows_a_draft_without_saving_it(self):
        note = self.upload()
        page = self.corrected(note, t1="Draft only")
        status, prev, _ = self.call("POST", f"/api/notes/{note['id']}/sense", {"page": page})
        self.assertEqual(status, 200)
        self.assertIn("Draft only", prev["sense_html"])
        _, again, _ = self.call("GET", f"/api/notes/{note['id']}")
        self.assertNotIn("Draft only", again["sense_html"])

    def test_pages_that_do_not_validate_are_refused_with_a_reason(self):
        note = self.upload()
        bad_link = copy.deepcopy(note["page"])
        bad_link["links"] = [{"id": "x", "kind": "flow", "from": "t1", "to": "ghost"}]
        dup = copy.deepcopy(note["page"])
        dup["elements"][1]["id"] = "t1"
        blank = self.corrected(note, t1="   ")
        cases = {"endpoint": bad_link, "own id": dup, "no text": blank}
        for needle, page in cases.items():
            status, body, _ = self.call("PUT", f"/api/notes/{note['id']}", {"page": page})
            self.assertEqual(status, 400, needle)
            self.assertIn(needle, body["error"])
        _, same, _ = self.call("GET", f"/api/notes/{note['id']}")
        self.assertFalse(same["edited"])  # nothing was written

    def test_unknown_fields_in_a_saved_page_are_dropped(self):
        note = self.upload()
        page = copy.deepcopy(note["page"])
        page["elements"][0]["evil"] = "<script>"
        page["elements"][0]["confidence"] = 0.2
        _, saved, _ = self.call("PUT", f"/api/notes/{note['id']}", {"page": page})
        self.assertNotIn("evil", saved["page"]["elements"][0])
        self.assertNotIn("confidence", saved["page"]["elements"][0])


class RereadTests(AppTest):
    def test_rotating_reads_again_and_throws_away_corrections(self):
        note = self.upload()
        self.call("PUT", f"/api/notes/{note['id']}", {"page": self.corrected(note, t1="Transition")})
        before = cv2.imread(str(self.home / note["id"] / "flat.jpg")).shape[:2]
        status, n, _ = self.call("POST", f"/api/notes/{note['id']}/reread", {"rotate": True})
        self.assertEqual(status, 200, n)
        self.assertEqual((n["turns"], n["sure"], n["edited"]), (1, True, False))
        self.assertEqual(n["page"]["elements"][0]["text"], "Franthon")
        self.assertEqual(cv2.imread(str(self.home / note["id"] / "flat.jpg")).shape[:2], before[::-1])
        self.assertEqual(self.store.profile.data["notes"][note["id"]]["fixes"], {})  # what it taught is gone too

    def test_toggling_the_crop_cuts_the_page_out_again(self):
        note = self.upload()
        _, n, _ = self.call("POST", f"/api/notes/{note['id']}/reread", {"crop": False})
        self.assertEqual((n["how"], n["crop"]), ("whole photo", False))


class ShareTests(AppTest):
    def test_downloads(self):
        note = self.upload()
        self.call("PUT", f"/api/notes/{note['id']}", {"title": "Transition notes"})
        status, html, hdrs = self.call("GET", f"/api/notes/{note['id']}/share.html", raw=True)
        self.assertEqual(status, 200)
        self.assertEqual(hdrs["Content-Disposition"], 'attachment; filename="transition-notes.html"')
        self.assertNotIn(b"data:image", html)
        _, with_photo, _ = self.call("GET", f"/api/notes/{note['id']}/share.html?photo=1", raw=True)
        self.assertIn(b"data:image/jpeg;base64,", with_photo)
        status, md, hdrs = self.call("GET", f"/api/notes/{note['id']}/share.md", raw=True)
        self.assertTrue(md.startswith(b"# Transition notes"))
        self.assertIn("markdown", hdrs["Content-Type"])


class DeleteAndProfileTests(AppTest):
    def test_delete_removes_the_note_and_what_it_taught(self):
        note = self.upload()
        self.call("PUT", f"/api/notes/{note['id']}", {"page": self.corrected(note, t1="Transition")})
        self.assertEqual(self.call("DELETE", f"/api/notes/{note['id']}")[0], 200)
        self.assertEqual(self.call("GET", f"/api/notes/{note['id']}")[0], 404)
        self.assertFalse((self.home / note["id"]).exists())
        self.assertEqual(json.loads((self.home / "profile.json").read_text())["notes"], {})

    def test_profile_can_be_edited(self):
        note = self.upload()
        self.call("PUT", f"/api/notes/{note['id']}", {"page": self.corrected(note, t1="Transition")})
        status, prof, _ = self.call("PUT", "/api/profile", {"shorthand": {"~": "about"}, "action_cues": ["Ask ", "ask", "buy"],
                                                            "forget": ["franthon"]})
        self.assertEqual(status, 200)
        self.assertEqual((prof["shorthand"], prof["action_cues"], prof["fixes"]), ({"~": "about"}, ["ask", "buy"], []))
        self.assertEqual(prof["sources"], {"notes": 1, "labeled": 0})
        self.assertEqual(prof["stats"]["pages"], 1)

    def test_stats_ignore_pages_you_have_not_checked(self):
        self.upload()  # a raw reading: neither checked nor corrected
        _, prof, _ = self.call("GET", "/api/profile")
        self.assertEqual((prof["sources"]["notes"], prof["stats"]["pages"]), (0, 0))
        _, again, _ = self.call("GET", "/api/status")
        self.assertEqual((again["gemini"], again["vision"]), (False, True))


class StaticTests(AppTest):
    def test_the_design_system_is_served_from_an_allow_list(self):
        status, css, hdrs = self.call("GET", "/static/noteworthy.css", raw=True)
        self.assertEqual((status, hdrs["Content-Type"]), (200, "text/css; charset=utf-8"))
        self.assertIn(b"--paper-1:#FBF7F0", css)
        self.assertEqual(self.call("GET", "/static/ds.js", raw=True)[0], 200)
        status, font, hdrs = self.call("GET", "/static/fonts/Newsreader-normal.woff2", raw=True)
        self.assertEqual((status, hdrs["Content-Type"], hdrs["Cache-Control"]), (200, "font/woff2", "max-age=86400"))
        self.assertTrue(font.startswith(b"wOF2"))
        for bad in ("build.py", "SOURCE.md", "prerendered.json", "fonts/Missing-normal.woff2", "fonts/..%2fds.js", "..%2fapp.py", "fonts"):
            self.assertEqual(self.call("GET", f"/static/{bad}")[0], 404, bad)

    def test_the_page_links_the_system_and_has_its_icons_filled_in(self):
        _, html, _ = self.call("GET", "/", raw=True)
        html = html.decode()
        self.assertIn('href="/static/noteworthy.css"', html)
        self.assertIn("from '/static/ds.js'", html)
        for placeholder in ("__ICONS__", "__SHARE_CSS__", "__CANVAS_CSS__"):
            self.assertNotIn(placeholder, html)
        self.assertIn('"trash-2"', html)  # the system's other glyphs, beyond the ones ds.js carries

    def test_a_note_comes_back_coloured_by_thread(self):
        note = self.upload()
        page = self.corrected(note, t1="Transition", t2="core")
        page["links"] = [{"id": "m1", "kind": "flow", "from": "t1", "to": "t2"}]
        _, saved, _ = self.call("PUT", f"/api/notes/{note['id']}", {"page": page})
        self.assertIn('class="box th0"', saved["clean_html"])
        self.assertIn("nw-card nw-card--raised thread th0", saved["sense_html"])
        self.assertIn("No arrows yet. Draw them in with Fix readings.", self.upload()["sense_html"])

    def test_the_shared_file_carries_the_systems_fonts_and_nothing_from_the_network(self):
        note = self.upload()
        _, html, _ = self.call("GET", f"/api/notes/{note['id']}/share.html", raw=True)
        html = html.decode()
        self.assertEqual(html.count("data:font/woff2;base64,"), 4)
        self.assertNotIn("<script", html)
        self.assertNotRegex(html, r"(src|href)=\"https?://")
        self.assertIn('Make <em>sense</em>', html)


if __name__ == "__main__":
    unittest.main()
