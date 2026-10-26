"""The Mac worker, against the local Firestore emulator, with the reading engine faked (so it needs no Vision).

Skipped unless the emulator is up. Run with:
    npx firebase-tools emulators:exec --only firestore --project demo-anchor-notes ".venv/bin/python -m unittest tests.test_cloud_worker"
"""

import copy
import json
import os
import tempfile
import time
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import cv2
import numpy as np

from sense import app, engine, notebooks
from sense.cloud import worker
from sense.cloud.client import EmulatorAuth, Firestore
from tests.test_sense_app import RAW, fake_make_flat, fake_read

EMULATOR = bool(os.environ.get("FIRESTORE_EMULATOR_HOST"))
PROJECT = "demo-anchor-notes"


def jpeg(w=200, h=100) -> bytes:
    return cv2.imencode(".jpg", np.full((h, w, 3), 255, np.uint8))[1].tobytes()


def queued(pid, **kw):
    return {"id": pid, "title": "", "created": "2026-03-01T10:00:00", "status": "queued", "error": None, "source": None, "how": "", "turns": 0,
            "sure": True, "crop": True, "confirmed": False, "edited": False, "engineNotes": [], "changes": [], "pageJson": None, "threads": 0,
            "loose": 0, "actions": 0, "thumb": b"x", "photoRev": 1, "rev": 0, "learnedRev": 0, "request": None, "doneRequest": None,
            "deleted": False, "updatedAt": datetime.now(timezone.utc), **kw}


@unittest.skipUnless(EMULATOR, "needs the Firestore emulator")
class WorkerTests(unittest.TestCase):
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
        self.uid = "u" + uuid.uuid4().hex[:10]
        self.fs = Firestore(PROJECT, EmulatorAuth())
        self.fs.set(f"users/{self.uid}", {"email": f"{self.uid}@example.com"})
        self.home = Path(self.tmp.name, "notes")
        self.store = app.Store(self.home, labeled=Path(self.tmp.name, "none"))
        self.nbs = notebooks.Notebooks(self.store)
        self.w = worker.Worker(self.store, self.nbs, self.fs, self.uid, log=lambda *a: None)

    def p(self, *parts):
        return "/".join(("users", self.uid, *parts))

    def add_from_phone(self, pid="20260301-100000-aaaa", **kw):
        self.fs.set(self.p("pages", pid), queued(pid, **kw))
        self.fs.set(self.p("pages", pid, "files", "flat"), {"bytes": jpeg(), "type": "image/jpeg", "w": 200, "h": 100, "rev": 1})
        return pid

    # --- a photo from the phone ---------------------------------------------------------------------------------------

    def test_a_queued_photo_is_read_and_comes_back_ready(self):
        pid = self.add_from_phone()
        self.w.cycle()
        doc = self.fs.get(self.p("pages", pid))
        self.assertEqual(doc["status"], "ready")
        self.assertEqual(json.loads(doc["pageJson"])["elements"][0]["text"], "Franthon")
        self.assertTrue(doc["title"])
        self.assertEqual((doc["rev"], doc["learnedRev"]), (1, 1))
        self.assertGreater(len(doc["thumb"]), 100)
        self.assertEqual(self.fs.get(self.p("pages", pid, "files", "flat"))["rev"], doc["photoRev"])
        self.assertTrue((self.home / pid / "page.json").exists(), "the page lives on the Mac under the same id")
        self.assertEqual(self.fs.get(self.p("state", "mac"))["version"], 1)
        self.assertIn("seen", self.fs.get(self.p("state", "mac")))

    def test_a_title_you_typed_while_it_waited_is_kept(self):
        pid = self.add_from_phone(title="My own name")
        self.w.cycle()
        self.assertEqual(self.fs.get(self.p("pages", pid))["title"], "My own name")

    def test_a_photo_the_engine_cannot_read_is_marked_failed_with_the_reason(self):
        pid = self.add_from_phone()
        with mock.patch.object(engine, "make_flat", side_effect=engine.EngineError("That doesn't look like a page.")):
            self.w.cycle()
        doc = self.fs.get(self.p("pages", pid))
        self.assertEqual((doc["status"], doc["error"]), ("failed", "That doesn't look like a page."))
        self.assertFalse((self.home / pid).exists())
        n = self.w.state.d["cursor"]["pages"]
        self.w.cycle()  # a failed page is not picked up again by itself
        self.assertEqual(self.fs.get(self.p("pages", pid))["status"], "failed")

    def test_try_again_reads_it_once_more(self):
        pid = self.add_from_phone()
        self.w.cycle()
        self.fs.update(self.p("pages", pid), {"status": "queued", "request": {"id": "r1", "rotate": True, "crop": None},
                                              "updatedAt": datetime.now(timezone.utc)})
        with mock.patch.object(engine, "rotate_flat") as rot:
            self.w.cycle()
        rot.assert_called_once()
        doc = self.fs.get(self.p("pages", pid))
        self.assertEqual((doc["status"], doc["doneRequest"], doc["request"]), ("ready", "r1", None))
        self.assertEqual(doc["rev"], 2)

    # --- what you do on the site -----------------------------------------------------------------------------------------

    def test_words_you_fix_on_the_site_teach_the_profile_here(self):
        pid = self.add_from_phone()
        self.w.cycle()
        doc = self.fs.get(self.p("pages", pid))
        page = json.loads(doc["pageJson"])
        next(e for e in page["elements"] if e["id"] == "t1")["text"] = "Transition"
        self.fs.update(self.p("pages", pid), {"pageJson": json.dumps(page), "edited": True, "confirmed": True, "rev": 2,
                                              "updatedAt": datetime.now(timezone.utc)})
        self.w.cycle()
        self.assertEqual(self.fs.get(self.p("pages", pid))["learnedRev"], 2)
        self.assertEqual(json.loads((self.home / pid / "page.json").read_text())["elements"][0]["text"], "Transition")
        self.assertTrue(json.loads((self.home / pid / "meta.json").read_text())["confirmed"])
        self.assertIn(("franthon", "transition"), [(f["raw"].lower(), f["to"].lower()) for f in self.store.profile.learned_fixes()])
        view = json.loads(self.fs.get(self.p("profile", "default"))["viewJson"])
        self.assertIn("transition", [w for w, _ in view["vocab"]])

    def test_a_profile_change_asked_for_on_the_site_is_applied_then_cleared(self):
        self.fs.set(self.p("profileEdits", "e1"), {"at": 1, "shorthand": {"w/": "with"}, "action_cues": ["Buy", " ring  up "]})
        self.w.cycle()
        self.assertEqual(self.store.profile.data["shorthand"], {"w/": "with"})
        self.assertEqual(self.store.profile.data["action_cues"], ["buy", "ring up"])
        self.assertEqual(self.fs.list(self.p("profileEdits")), [])
        view = json.loads(self.fs.get(self.p("profile", "default"))["viewJson"])
        self.assertEqual(view["action_cues"], ["buy", "ring up"])

    def test_a_page_deleted_on_the_site_is_deleted_here_and_the_marker_is_removed(self):
        pid = self.add_from_phone()
        self.w.cycle()
        self.fs.set(self.p("pages", pid), {"id": pid, "deleted": True, "status": "deleted", "pageJson": None, "updatedAt": datetime.now(timezone.utc)})
        self.w.cycle()
        self.assertFalse((self.home / pid).exists())
        self.assertIsNone(self.fs.get(self.p("pages", pid)))

    # --- what you did here -----------------------------------------------------------------------------------------------

    def test_a_page_read_on_this_mac_appears_on_the_site(self):
        note = self.store.create(jpeg())
        self.w.cycle()
        doc = self.fs.get(self.p("pages", note["id"]))
        self.assertEqual((doc["status"], doc["title"]), ("ready", note["title"]))
        self.assertEqual(self.fs.get(self.p("pages", note["id"], "files", "flat"))["type"], "image/jpeg")
        self.w.cycle()
        self.assertEqual(self.fs.get(self.p("pages", note["id"]))["rev"], doc["rev"], "nothing changed, so nothing is sent again")

    def test_a_correction_made_here_reaches_the_site(self):
        note = self.store.create(jpeg())
        self.w.cycle()
        page = copy.deepcopy(note["page"])
        page["elements"][1]["text"] = "Core"
        self.store.save(note["id"], {"page": page, "confirmed": True})
        self.w.cycle()
        doc = self.fs.get(self.p("pages", note["id"]))
        self.assertIn("Core", doc["pageJson"])
        self.assertTrue(doc["confirmed"])
        self.assertEqual(doc["rev"], doc["learnedRev"])

    def test_a_page_deleted_here_disappears_from_the_site(self):
        note = self.store.create(jpeg())
        self.w.cycle()
        self.store.delete(note["id"])
        self.w.cycle()
        self.assertIsNone(self.fs.get(self.p("pages", note["id"])))
        self.assertIsNone(self.fs.get(self.p("pages", note["id"], "files", "flat")))

    def test_pages_on_the_site_but_not_here_come_home(self):
        pid = self.add_from_phone()
        self.w.cycle()
        import shutil
        shutil.rmtree(self.home / pid)                     # a fresh Mac, or a wiped folder
        self.w.state.d["pages"].clear()
        self.fs.update(self.p("pages", pid), {"updatedAt": datetime.now(timezone.utc)})
        self.w.cycle()
        self.assertTrue((self.home / pid / "page.json").exists())
        self.assertTrue((self.home / pid / "flat.jpg").exists())

    # --- notebooks ---------------------------------------------------------------------------------------------------------

    def test_a_notebook_goes_up_and_a_change_on_the_site_comes_down(self):
        nb = self.nbs.create("Ideas")
        self.nbs.save(nb["id"], {"rev": nb["rev"], "items": [{"id": "a", "type": "text", "x": 1, "y": 2, "w": 0, "h": 0, "text": "one"}], "links": []})
        self.w.cycle()
        meta = self.fs.get(self.p("notebooks", nb["id"]))
        body = self.fs.get(self.p("notebooks", nb["id"], "parts", "body"))
        self.assertEqual((meta["title"], meta["notes"], meta["rev"], body["rev"]), ("Ideas", 1, 1, 1))
        self.assertIn("<svg", meta["thumb"])
        self.assertEqual(json.loads(body["itemsJson"])[0]["text"], "one")
        items = json.loads(body["itemsJson"]) + [{"id": "b", "type": "text", "x": 5, "y": 5, "w": 0, "h": 0, "text": "two"}]
        self.fs.set(self.p("notebooks", nb["id"], "parts", "body"), {"itemsJson": json.dumps(items), "linksJson": "[]", "rev": 2})
        self.fs.update(self.p("notebooks", nb["id"]), {"rev": 2, "title": "Ideas, renamed", "updatedAt": datetime.now(timezone.utc)})
        self.w.cycle()
        here = self.nbs._load(nb["id"])
        self.assertEqual((here["title"], [i["id"] for i in here["items"]]), ("Ideas, renamed", ["a", "b"]))
        self.assertGreater(here["rev"], nb["rev"], "an open tab on this Mac sees a newer revision and reloads")

    def test_a_notebook_photo_travels_both_ways(self):
        nb = self.nbs.create("Photos")
        assets = self.nbs.root / nb["id"] / "assets"
        assets.mkdir()
        (assets / "x.jpg").write_bytes(jpeg())
        self.nbs.save(nb["id"], {"rev": nb["rev"], "items": [{"id": "p1", "type": "image", "x": 0, "y": 0, "w": 100, "h": 50, "src": "x.jpg"}]})
        self.w.cycle()
        self.assertEqual(self.fs.get(self.p("notebooks", nb["id"], "files", "x.jpg"))["type"], "image/jpeg")
        import shutil
        shutil.rmtree(self.home / "notebooks" / nb["id"])  # the site's copy is the one that remains
        self.w.state.d["notebooks"].clear()
        self.fs.update(self.p("notebooks", nb["id"]), {"updatedAt": datetime.now(timezone.utc)})
        self.w.cycle()
        self.assertTrue((self.home / "notebooks" / nb["id"] / "assets" / "x.jpg").exists())

    def test_a_notebook_deleted_on_the_site_goes_here_and_the_other_way(self):
        gone = self.nbs.create("Gone")["id"]
        kept = self.nbs.create("Kept")["id"]
        self.w.cycle()
        self.fs.set(self.p("notebooks", gone), {"id": gone, "deleted": True, "title": "", "rev": 9, "updatedAt": datetime.now(timezone.utc)})
        self.nbs.delete(kept)                              # and one deleted here
        self.w.cycle()
        self.assertFalse((self.home / "notebooks" / gone).exists())
        self.assertIsNone(self.fs.get(self.p("notebooks", gone)))
        self.assertIsNone(self.fs.get(self.p("notebooks", kept)))

    def test_a_notebook_changed_on_both_sides_keeps_this_macs_version_as_a_copy(self):
        nb = self.nbs.create("Both")
        self.w.cycle()
        self.nbs.save(nb["id"], {"rev": nb["rev"], "items": [{"id": "mac", "type": "text", "x": 0, "y": 0, "w": 0, "h": 0, "text": "typed on the Mac"}]})
        body = {"itemsJson": json.dumps([{"id": "web", "type": "text", "x": 0, "y": 0, "w": 0, "h": 0, "text": "typed on the site"}]), "linksJson": "[]", "rev": 2}
        self.fs.set(self.p("notebooks", nb["id"], "parts", "body"), body)
        self.fs.update(self.p("notebooks", nb["id"]), {"rev": 2, "updatedAt": datetime.now(timezone.utc)})
        self.w.cycle()
        titles = {self.nbs._load(d.name)["title"]: self.nbs._load(d.name) for d in self.nbs.root.iterdir() if d.is_dir()}
        self.assertEqual([i["id"] for i in titles["Both"]["items"]], ["web"])
        self.assertEqual([i["id"] for i in titles["Both (Mac copy)"]["items"]], ["mac"])

    def test_state_survives_a_restart_so_nothing_is_done_twice(self):
        self.add_from_phone()
        self.w.cycle()
        again = worker.Worker(self.store, self.nbs, self.fs, self.uid, log=lambda *a: None)
        with mock.patch.object(engine, "read", side_effect=AssertionError("read again")):
            again.cycle()

    def test_only_one_worker_may_hold_a_folder(self):
        first = worker.take_lock(self.home)
        self.addCleanup(first.close)
        with self.assertRaises(worker.WorkerError):
            worker.take_lock(self.home)

    def test_the_mac_is_found_by_the_email_you_signed_in_with(self):
        self.assertEqual(worker.find_uid(self.fs, f"{self.uid}@example.com"), self.uid)
        with self.assertRaises(worker.WorkerError):
            worker.find_uid(self.fs, "nobody-has-signed-in@example.com")


class PhotoSizeTests(unittest.TestCase):
    def test_a_big_photo_is_shrunk_under_the_limit_and_a_small_one_is_untouched(self):
        rng = np.random.default_rng(1)
        noisy = cv2.imencode(".jpg", rng.integers(0, 255, (2400, 3200, 3), dtype=np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 95])[1].tobytes()
        self.assertGreater(len(noisy), worker.LIMIT)
        out, w, h = worker.fit_jpeg(noisy)
        self.assertLessEqual(len(out), worker.LIMIT)
        self.assertEqual(out[:2], b"\xff\xd8")
        small = jpeg()
        self.assertEqual(worker.fit_jpeg(small)[0], small)
        self.assertLess(len(worker.make_thumb(noisy)), 40_000)


if __name__ == "__main__":
    unittest.main()
