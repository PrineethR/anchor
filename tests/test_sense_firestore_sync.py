"""Unit tests for sense/firestore_sync.py."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sense import firestore_sync


class FirestoreConversionTest(unittest.TestCase):
    def test_primitive_conversions(self):
        self.assertEqual(firestore_sync.py_to_fs(None), {"nullValue": None})
        self.assertEqual(firestore_sync.py_to_fs(True), {"booleanValue": True})
        self.assertEqual(firestore_sync.py_to_fs(False), {"booleanValue": False})
        self.assertEqual(firestore_sync.py_to_fs(42), {"integerValue": "42"})
        self.assertEqual(firestore_sync.py_to_fs(3.14), {"doubleValue": 3.14})
        self.assertEqual(firestore_sync.py_to_fs("anchor"), {"stringValue": "anchor"})

    def test_roundtrip_complex_structure(self):
        original = {
            "title": "Transition Page",
            "page_size": [210.0, 297.0],
            "confirmed": True,
            "elements": [
                {"id": "t1", "type": "text", "bbox": [10.0, 20.0, 30.0, 40.0], "text": "hello"},
                {"id": "s1", "type": "shape", "contains": ["t1"]},
            ],
            "links": [
                {"id": "l1", "from": "t1", "to": "s1", "kind": "flow", "label": "goes to"}
            ],
            "metadata": {
                "source": "gemini",
                "notes": None,
                "count": 1,
            }
        }
        encoded = firestore_sync.py_to_fs(original)
        self.assertIn("mapValue", encoded)
        decoded = firestore_sync.fs_to_py(encoded)
        self.assertEqual(decoded, original)


class FirestoreClientTest(unittest.TestCase):
    def setUp(self):
        self.client = firestore_sync.FirestoreClient(project_id="test-proj", api_key="test-key")

    @mock.patch("urllib.request.urlopen")
    def test_set_document(self, mock_urlopen):
        mock_resp = mock.MagicMock()
        mock_resp.read.return_value = json.dumps({"name": "doc1", "fields": {}}).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        res = self.client.set_document("pages", "p1", {"title": "Test"})
        self.assertEqual(res["name"], "doc1")
        mock_urlopen.assert_called_once()
        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.get_method(), "PATCH")
        self.assertIn("pages/p1?key=test-key", req.full_url)

    @mock.patch("urllib.request.urlopen")
    def test_get_document(self, mock_urlopen):
        mock_resp = mock.MagicMock()
        mock_resp.read.return_value = json.dumps({
            "fields": {
                "title": {"stringValue": "Read Note"},
                "confirmed": {"booleanValue": True}
            }
        }).encode("utf-8")
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        doc = self.client.get_document("pages", "p1")
        self.assertEqual(doc, {"title": "Read Note", "confirmed": True})

    @mock.patch("urllib.request.urlopen")
    def test_delete_document(self, mock_urlopen):
        mock_resp = mock.MagicMock()
        mock_resp.status = 200
        mock_resp.__enter__.return_value = mock_resp
        mock_urlopen.return_value = mock_resp

        self.assertTrue(self.client.delete_document("pages", "p1"))


class SyncWorkerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.mock_client = mock.MagicMock(spec=firestore_sync.FirestoreClient)
        self.worker = firestore_sync.SyncWorker(client=self.mock_client, slow_interval=0.01)

    def test_sync_note_dispatched(self):
        note_dir = Path(self.tmp.name) / "20261026-100000-abcd"
        note_dir.mkdir()
        (note_dir / "meta.json").write_text(json.dumps({"title": "Sync Test", "created": "2026-10-26"}))
        (note_dir / "page.json").write_text(json.dumps({"elements": [], "links": []}))
        (note_dir / "flat.jpg").write_bytes(b"fake jpeg data")

        self.worker.start()
        self.worker.schedule_note(note_dir)
        self.worker._queue.join()
        self.worker.stop(wait=True)

        self.mock_client.set_document.assert_called_once()
        args = self.mock_client.set_document.call_args[0]
        self.assertEqual(args[0], "pages")
        self.assertEqual(args[1], "20261026-100000-abcd")
        self.assertEqual(args[2]["title"], "Sync Test")
        self.assertIn("flat_jpeg_b64", args[2])

        status = self.worker.status()
        self.assertEqual(status["synced"], 1)
        self.assertEqual(status["failed"], 0)

    def test_sync_profile_dispatched(self):
        prof_file = Path(self.tmp.name) / "profile.json"
        prof_file.write_text(json.dumps({"action_cues": ["todo", "fix"], "shorthand": {"7": "of"}}))

        self.worker.start()
        self.worker.schedule_profile(prof_file)
        self.worker._queue.join()
        self.worker.stop(wait=True)

        self.mock_client.set_document.assert_called_once()
        args = self.mock_client.set_document.call_args[0]
        self.assertEqual(args[0], "profiles")
        self.assertEqual(args[1], "default")
        self.assertEqual(args[2]["action_cues"], ["todo", "fix"])
        self.assertEqual(args[2]["shorthand"], {"7": "of"})


class StoreSyncIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name, "notes")
        self.mock_worker = mock.MagicMock(spec=firestore_sync.SyncWorker)
        self.mock_worker.status.return_value = {"pending": 0, "synced": 5}

        from sense import app, engine, notebooks
        self.app = app
        self.engine = engine
        self.notebooks = notebooks

        p1 = mock.patch.object(engine, "make_flat", lambda data, flat, crop=True: {
            "how": "edges", "turns": 0, "sure": True, "ocr": None
        })
        p1.start()
        self.addCleanup(p1.stop)

        raw_page = {
            "page_id": "x", "page_size": [200, 100], "links": [],
            "elements": [{"id": "t1", "type": "text", "bbox": [10, 10, 40, 10], "text": "Testing"}]
        }
        p2 = mock.patch.object(engine, "read", lambda flat, page_id, prof, ocr=None, examples=(): (raw_page, "vision", []))
        p2.start()
        self.addCleanup(p2.stop)

        self.store = app.Store(self.home, sync=self.mock_worker)
        self.nbs = notebooks.Notebooks(self.store)

    def test_store_create_and_delete_schedules_sync(self):
        v = self.store.create(b"fake image bytes")
        nid = v["id"]
        self.mock_worker.schedule_note.assert_called()
        self.mock_worker.schedule_profile.assert_called()

        self.store.save(nid, {"confirmed": True})
        self.mock_worker.schedule_note.assert_called()

        self.store.delete(nid)
        self.mock_worker.schedule_delete_note.assert_called_with(nid)

    def test_notebook_create_and_save_schedules_sync(self):
        nb = self.nbs.create("Ideas")
        self.mock_worker.schedule_notebook.assert_called()

        self.nbs.save(nb["id"], {"rev": nb["rev"], "title": "Updated Ideas"})
        self.mock_worker.schedule_notebook.assert_called()

        self.nbs.delete(nb["id"])
        self.mock_worker.schedule_delete_notebook.assert_called_with(nb["id"])

    def test_sync_all(self):
        v = self.store.create(b"fake image bytes")
        nb = self.nbs.create("Ideas")
        self.mock_worker.reset_mock()

        count = self.store.sync_all()
        self.assertEqual(count, 2)
        self.mock_worker.schedule_note.assert_called()
        self.mock_worker.schedule_notebook.assert_called()
        self.mock_worker.schedule_profile.assert_called()

    def test_store_status_includes_sync(self):
        st = self.store.status()
        self.assertIn("sync", st)
        self.assertEqual(st["sync"]["synced"], 5)


if __name__ == "__main__":
    unittest.main()

