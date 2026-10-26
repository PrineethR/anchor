"""Asynchronous background sync from Anchor's local notes and notebooks to Cloud Firestore.

Allows notes, semantic threads, notebooks, and handwriting profiles to be accessed
from anywhere while keeping local processing instant and decoupled from network latency.
Uses standard library urllib and JSON so there are no extra external dependencies.

SUPERSEDED by sense/cloud (the website and the Mac worker). This one writes to top-level collections with no sign-in, which only
works while the database is open to everyone; the project's rules now allow only the signed-in owner under users/{uid}/, so these
writes are refused. It is off by default (`--sync` to turn it on) and has no API key built in (set FIRESTORE_API_KEY).
"""

from __future__ import annotations

import base64
import json
import logging
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger("anchor.sync")

DEFAULT_PROJECT = "anchor-notes-prineeth"
DEFAULT_DATABASE = "(default)"


def py_to_fs(val: Any) -> dict[str, Any]:
    """Convert native Python types into Firestore REST API value representations."""
    if val is None:
        return {"nullValue": None}
    if isinstance(val, bool):
        return {"booleanValue": val}
    if isinstance(val, int):
        return {"integerValue": str(val)}
    if isinstance(val, float):
        return {"doubleValue": float(val)}
    if isinstance(val, str):
        return {"stringValue": val}
    if isinstance(val, (list, tuple)):
        return {"arrayValue": {"values": [py_to_fs(v) for v in val]}}
    if isinstance(val, dict):
        return {"mapValue": {"fields": {str(k): py_to_fs(v) for k, v in val.items()}}}
    if isinstance(val, bytes):
        return {"stringValue": base64.b64encode(val).decode("ascii")}
    return {"stringValue": str(val)}


def fs_to_py(fs_val: dict[str, Any]) -> Any:
    """Convert Firestore REST API value representations back to native Python types."""
    if not isinstance(fs_val, dict):
        return fs_val
    if "nullValue" in fs_val:
        return None
    if "booleanValue" in fs_val:
        return fs_val["booleanValue"]
    if "integerValue" in fs_val:
        return int(fs_val["integerValue"])
    if "doubleValue" in fs_val:
        return float(fs_val["doubleValue"])
    if "stringValue" in fs_val:
        return fs_val["stringValue"]
    if "arrayValue" in fs_val:
        return [fs_to_py(v) for v in fs_val["arrayValue"].get("values", [])]
    if "mapValue" in fs_val:
        return {k: fs_to_py(v) for k, v in fs_val["mapValue"].get("fields", {}).items()}
    return None


class FirestoreClient:
    """Lightweight Firestore REST API client using standard library urllib."""

    def __init__(self, project_id: str | None = None, api_key: str | None = None,
                 database: str = DEFAULT_DATABASE, timeout: float = 15.0):
        self.project_id = project_id or os.getenv("FIRESTORE_PROJECT_ID", DEFAULT_PROJECT)
        self.api_key = api_key or os.getenv("FIRESTORE_API_KEY", "")
        self.database = database
        self.timeout = timeout
        self.base_url = (
            f"https://firestore.googleapis.com/v1/projects/{self.project_id}"
            f"/databases/{self.database}/documents"
        )

    def _url(self, collection: str, doc_id: str | None = None) -> str:
        url = f"{self.base_url}/{collection}"
        if doc_id:
            url += f"/{doc_id}"
        if self.api_key:
            url += f"?key={self.api_key}"
        return url

    def set_document(self, collection: str, doc_id: str, data: dict[str, Any]) -> dict[str, Any]:
        """Create or update a document via PATCH with full document replacement."""
        url = self._url(collection, doc_id)
        payload = {"fields": {k: py_to_fs(v) for k, v in data.items()}}
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json"}, method="PATCH"
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def get_document(self, collection: str, doc_id: str) -> dict[str, Any] | None:
        """Fetch a document by collection and document ID. Returns None if 404."""
        url = self._url(collection, doc_id)
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                res = json.loads(resp.read().decode("utf-8"))
                return {k: fs_to_py(v) for k, v in res.get("fields", {}).items()}
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    def delete_document(self, collection: str, doc_id: str) -> bool:
        """Delete a document by collection and document ID."""
        url = self._url(collection, doc_id)
        req = urllib.request.Request(url, method="DELETE")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status in (200, 204)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return True
            raise

    def list_documents(self, collection: str) -> list[dict[str, Any]]:
        """List documents in a collection."""
        url = self._url(collection)
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                docs = []
                for doc in data.get("documents", []):
                    name = doc.get("name", "")
                    doc_id = name.split("/")[-1]
                    fields = {k: fs_to_py(v) for k, v in doc.get("fields", {}).items()}
                    docs.append({"id": doc_id, **fields})
                return docs
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return []
            raise


class SyncWorker:
    """Background sync worker queue that uploads notes, notebooks, and profile slowly."""

    def __init__(self, client: FirestoreClient | None = None, slow_interval: float = 1.0):
        self.client = client or FirestoreClient()
        self.slow_interval = slow_interval
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._thread: threading.Thread | None = None
        self._running = False
        self._lock = threading.Lock()
        self.stats = {
            "pending": 0,
            "synced": 0,
            "failed": 0,
            "last_synced_at": None,
            "last_error": None,
        }

    def start(self) -> None:
        """Start the background worker thread."""
        with self._lock:
            if self._running:
                return
            self._running = True
            self._thread = threading.Thread(target=self._run, daemon=True, name="AnchorFirestoreSync")
            self._thread.start()

    def stop(self, wait: bool = False) -> None:
        """Stop the background worker thread."""
        with self._lock:
            self._running = False
        if wait and self._thread and self._thread.is_alive():
            self._thread.join(timeout=3.0)

    def schedule_note(self, note_dir: Path) -> None:
        """Schedule a note folder to be synced."""
        self._enqueue(("note", Path(note_dir)))

    def schedule_delete_note(self, nid: str) -> None:
        """Schedule deletion of a note in Firestore."""
        self._enqueue(("delete_note", str(nid)))

    def schedule_notebook(self, notebook_dir: Path) -> None:
        """Schedule a notebook folder to be synced."""
        self._enqueue(("notebook", Path(notebook_dir)))

    def schedule_delete_notebook(self, nid: str) -> None:
        """Schedule deletion of a notebook in Firestore."""
        self._enqueue(("delete_notebook", str(nid)))

    def schedule_profile(self, profile_file: Path) -> None:
        """Schedule profile.json to be synced."""
        self._enqueue(("profile", Path(profile_file)))

    def _enqueue(self, item: tuple[str, Any]) -> None:
        self._queue.put(item)
        with self._lock:
            self.stats["pending"] = self._queue.qsize()

    def status(self) -> dict[str, Any]:
        """Return the current sync status."""
        with self._lock:
            return dict(self.stats, pending=self._queue.qsize())

    def _run(self) -> None:
        while self._running:
            try:
                task, target = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue

            success = False
            for attempt in range(3):
                if not self._running:
                    break
                try:
                    self._dispatch(task, target)
                    success = True
                    break
                except Exception as ex:
                    LOGGER.warning("Sync failed for %s (%s), attempt %d: %s", task, target, attempt + 1, ex)
                    with self._lock:
                        self.stats["last_error"] = str(ex)
                    time.sleep(1.0 * (2 ** attempt))

            with self._lock:
                if success:
                    self.stats["synced"] += 1
                    self.stats["last_synced_at"] = datetime.now(timezone.utc).isoformat()
                    self.stats["last_error"] = None
                else:
                    self.stats["failed"] += 1
                self.stats["pending"] = self._queue.qsize()

            self._queue.task_done()
            if self.slow_interval > 0:
                time.sleep(self.slow_interval)

    def _dispatch(self, task: str, target: Any) -> None:
        if task == "note":
            self._sync_note(target)
        elif task == "delete_note":
            self.client.delete_document("pages", target)
        elif task == "notebook":
            self._sync_notebook(target)
        elif task == "delete_notebook":
            self.client.delete_document("notebooks", target)
        elif task == "profile":
            self._sync_profile(target)

    def _sync_note(self, note_dir: Path) -> None:
        if not note_dir.is_dir():
            return
        nid = note_dir.name
        meta_file = note_dir / "meta.json"
        page_file = note_dir / "page.json"
        if not meta_file.exists() or not page_file.exists():
            return

        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        page = json.loads(page_file.read_text(encoding="utf-8"))

        doc: dict[str, Any] = {
            "id": nid,
            "title": meta.get("title", ""),
            "created": meta.get("created", ""),
            "confirmed": bool(meta.get("confirmed", False)),
            "edited": bool(meta.get("edited", False)),
            "source": meta.get("source", "vision"),
            "how": meta.get("how", ""),
            "sure": bool(meta.get("sure", True)),
            "page": page,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }

        # Include base64 flat image if present and under ~800KB
        flat_img = note_dir / "flat.jpg"
        if flat_img.exists() and flat_img.stat().st_size < 800 * 1024:
            doc["flat_jpeg_b64"] = base64.b64encode(flat_img.read_bytes()).decode("ascii")

        self.client.set_document("pages", nid, doc)

    def _sync_notebook(self, notebook_dir: Path) -> None:
        if not notebook_dir.is_dir():
            return
        nid = notebook_dir.name
        nb_file = notebook_dir / "notebook.json"
        if not nb_file.exists():
            return

        nb = json.loads(nb_file.read_text(encoding="utf-8"))
        doc = {
            "id": nid,
            "title": nb.get("title", "Untitled"),
            "revision": int(nb.get("revision", 1)),
            "color": nb.get("color", "sky"),
            "items": nb.get("items", []),
            "links": nb.get("links", []),
            "created": nb.get("created", ""),
            "updated": nb.get("updated", ""),
            "bounds": nb.get("bounds"),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        self.client.set_document("notebooks", nid, doc)

    def _sync_profile(self, profile_file: Path) -> None:
        if not profile_file.exists():
            return
        data = json.loads(profile_file.read_text(encoding="utf-8"))
        doc = {
            "action_cues": data.get("action_cues", []),
            "shorthand": data.get("shorthand", {}),
            "corrections": data.get("corrections", {}),
            "vocab": data.get("vocab", {}),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        self.client.set_document("profiles", "default", doc)
