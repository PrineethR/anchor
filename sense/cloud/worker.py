"""The Mac's half of the website: reads the photos you add from your phone, and keeps both sides in step.

    .venv/bin/python -m sense.cloud.worker --email you@gmail.com --key-file ~/.config/anchor/service-account.json
    caffeinate -i .venv/bin/python -m sense.cloud.worker ...          # keeps the Mac from idling to sleep while it runs

or inside the local app (one process, one profile):  .venv/bin/python -m sense.app --cloud you@gmail.com

Every ~15 seconds it:
  * says it is awake (users/{uid}/state/mac), so the site can tell you whether a photo will be read soon;
  * reads each page the site marked `queued` with the same engine and profile the local app uses, and writes the result back;
  * learns from pages and corrections you made on the site (the profile lives here, as it always did), and applies the
    profile changes you asked for there;
  * brings notebooks and pages in both directions, so what you do here appears on the site and what you do there appears here.

Kept in notes/.cloud-state.json: where it got to, and what each side looked like when they last agreed.
If both sides changed the same page since, the site's version wins and yours is saved next to it as page.local-backup.json;
for a notebook, yours is kept as a second notebook ("... (Mac copy)"). Nothing is dropped.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import shutil
import socket
import sys
import threading
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from .. import app, engine, meaning, notebooks
from .client import Firestore, FirestoreError, ServiceAccountAuth, default_auth

DEFAULT_PROJECT = "anchor-notes-prineeth"
LIMIT = 900 * 1024                      # a Firestore document holds 1 MiB; the photo gets most of it
EPOCH = datetime(2000, 1, 1, tzinfo=timezone.utc)
HEARTBEAT_EVERY = 60


class WorkerError(RuntimeError):
    pass


def fit_jpeg(data: bytes) -> tuple[bytes, int, int]:
    """The photo as JPEG bytes under the limit, and its size. Untouched if it already fits."""
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("That isn't a photo I can open.")
    h, w = img.shape[:2]
    if len(data) <= LIMIT:
        return data, w, h
    scale = 1.0
    for _ in range(8):
        cur = img if scale == 1.0 else cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        for q in (82, 72, 62, 52):
            ok, buf = cv2.imencode(".jpg", cur, [cv2.IMWRITE_JPEG_QUALITY, q])
            if ok and len(buf) <= LIMIT:
                return buf.tobytes(), cur.shape[1], cur.shape[0]
        scale *= 0.85
    raise ValueError("That photo is too detailed to store.")


def make_thumb(data: bytes, side: int = 220) -> bytes:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    k = min(1.0, side / max(img.shape[:2]))
    small = cv2.resize(img, (max(1, int(img.shape[1] * k)), max(1, int(img.shape[0] * k))), interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 70])[1].tobytes()


def _read(path: Path):
    return json.loads(path.read_text())


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class State:
    """What got done last time: kept in a file so a restart picks up where it stopped."""

    def __init__(self, path: Path):
        self.path = path
        self.d = {"cursor": {"pages": EPOCH.isoformat(), "notebooks": EPOCH.isoformat()}, "pages": {}, "notebooks": {}}
        if path.exists():
            self.d.update(json.loads(path.read_text()))

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.d, indent=1))
        os.replace(tmp, self.path)

    def cursor(self, name: str) -> datetime:
        return datetime.fromisoformat(self.d["cursor"][name])

    def advance(self, name: str, to: datetime) -> None:
        if to > self.cursor(name):
            self.d["cursor"][name] = to.isoformat()


def take_lock(home: Path):
    """Only one thing at a time may keep this notes folder in step with the cloud (and own its profile)."""
    f = open(home / ".cloud-worker.lock", "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        raise WorkerError(f"Another cloud worker is already running on {home}. Stop it first (or use that one).") from None
    f.write(str(os.getpid()))
    f.flush()
    return f


class Worker:
    def __init__(self, store: app.Store, nbs: notebooks.Notebooks, fs: Firestore, uid: str, log=print):
        self.store, self.nbs, self.fs, self.uid, self.log = store, nbs, fs, uid, log
        self.state = State(store.home / ".cloud-state.json")
        self.profile_dirty = True
        self._beat = 0.0
        self._stop = threading.Event()

    def p(self, *parts: str) -> str:
        return "/".join(("users", self.uid, *parts))

    # --- pages ---------------------------------------------------------------------------------------------------------

    def fingerprint(self, pid: str) -> str:
        d = self.store.home / pid
        meta = _read(d / "meta.json")
        h = hashlib.sha1((d / "page.json").read_bytes())
        h.update(json.dumps([meta.get("title"), bool(meta.get("confirmed")), bool(meta.get("edited"))]).encode())
        return h.hexdigest()

    def page_doc(self, pid: str, existing: dict | None, request: dict | None = None) -> tuple[dict, bytes]:
        """The cloud copy of a local page, and its photo."""
        d = self.store.dir(pid)
        meta, page = _read(d / "meta.json"), _read(d / "page.json")
        sense = meaning.make_sense(page, self.store.profile.data["action_cues"])
        flat, w, h = fit_jpeg((d / "flat.jpg").read_bytes())
        sha = hashlib.sha1(flat).hexdigest()
        ex = existing or {}
        rev = int(ex.get("rev") or 0) + 1
        doc = {"id": pid, "title": (ex.get("title") or meta.get("title") or sense["title"]) if request else meta.get("title") or sense["title"],
               "created": meta["created"], "status": "ready", "error": None, "source": meta.get("source", "vision"), "how": meta.get("how", ""),
               "turns": int(meta.get("turns", 0)), "sure": bool(meta.get("sure", True)), "crop": bool(meta.get("crop", True)),
               "confirmed": bool(meta.get("confirmed")), "edited": bool(meta.get("edited")), "engineNotes": list(meta.get("engine_notes") or []),
               "changes": [{"from": c["from"], "to": c["to"]} for c in meta.get("changes") or []], "pageJson": json.dumps(page),
               "threads": sense["stats"]["threads"], "loose": sense["stats"]["loose"], "actions": len(sense["actions"]),
               "thumb": make_thumb(flat), "photoRev": int(ex.get("photoRev") or 0) + (0 if ex.get("flatSha") == sha else 1), "flatSha": sha,
               "rev": rev, "learnedRev": rev, "request": None, "doneRequest": (request or {}).get("id") or ex.get("doneRequest"), "deleted": False}
        doc["_flat"] = (flat, w, h)
        return doc, flat

    def publish_page(self, pid: str, request: dict | None = None) -> None:
        existing = self.fs.get(self.p("pages", pid))
        doc, flat = self.page_doc(pid, existing, request)
        _, w, h = doc.pop("_flat")
        if not existing or existing.get("flatSha") != doc["flatSha"] or request:
            self.fs.set(self.p("pages", pid, "files", "flat"), {"bytes": flat, "type": "image/jpeg", "w": w, "h": h, "rev": doc["photoRev"]})
        self.fs.set(self.p("pages", pid), doc)
        self.state.d["pages"][pid] = {"fp": self.fingerprint(pid), "rev": doc["rev"]}
        self.profile_dirty = True

    def fail(self, pid: str, message: str) -> None:
        self.fs.update(self.p("pages", pid), {"status": "failed", "error": message, "request": None})
        self.log(f"  could not read {pid}: {message}")

    def read_page(self, doc: dict) -> None:
        pid, request = doc["_id"], doc.get("request")
        self.log(f"Reading {pid}" + (" again" if request else "") + "…")
        try:
            if (self.store.home / pid).is_dir():          # a re-read, or a retry after the cloud write failed
                if request:
                    self.store.reread(pid, rotate=bool(request.get("rotate")), crop=request.get("crop"))
            else:
                photo = self.fs.get(self.p("pages", pid, "files", "flat"))
                if not photo:
                    return self.fail(pid, "The photo didn't arrive. Add it again.")
                self.store.create(photo["bytes"], nid=pid)
            if doc.get("title"):
                self.store.save(pid, {"title": doc["title"]})
            self.publish_page(pid, request or {"id": None})
            self.log(f"  done: {self.store.get(pid)['title']}")
        except (engine.EngineError, ValueError) as e:
            self.fail(pid, str(e))
        except Exception as e:  # noqa: BLE001: one bad photo must not stop the rest
            traceback.print_exc()
            self.fail(pid, f"The Mac hit a problem reading this ({type(e).__name__}).")

    def pull_page(self, doc: dict) -> None:
        """A page that is on the site but not on this Mac (a fresh folder): bring it home."""
        pid = doc["_id"]
        photo = self.fs.get(self.p("pages", pid, "files", "flat"))
        if not photo or not doc.get("pageJson"):
            return
        d = self.store.home / pid
        d.mkdir(exist_ok=True)
        page = json.loads(doc["pageJson"])
        (d / "original").write_bytes(photo["bytes"])
        (d / "flat.jpg").write_bytes(photo["bytes"])
        for name in ("engine.json", "shown.json", "page.json"):
            (d / name).write_text(json.dumps(page, indent=1, ensure_ascii=False))
        meta = {"id": pid, "created": doc["created"], "how": doc.get("how", ""), "turns": doc.get("turns", 0), "sure": doc.get("sure", True),
                "crop": doc.get("crop", True), "title": doc.get("title", ""), "source": doc.get("source") or "vision",
                "engine_notes": doc.get("engineNotes", []), "changes": doc.get("changes", []), "confirmed": bool(doc.get("confirmed")),
                "edited": bool(doc.get("edited")), "narration": None}
        (d / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
        self.state.d["pages"][pid] = {"fp": self.fingerprint(pid), "rev": doc.get("rev", 0)}
        self.log(f"Brought {pid} home from the site.")

    def learn_page(self, doc: dict) -> None:
        """Take in edits made on the site: new words, a checked tick, a title. This is where the profile learns from them."""
        pid, rev = doc["_id"], int(doc.get("rev") or 0)
        d = self.store.home / pid
        if not d.is_dir():
            return self.pull_page(doc)
        st = self.state.d["pages"].get(pid)
        local_fp = self.fingerprint(pid)
        cloud_page = json.loads(doc["pageJson"])
        local_page = _read(d / "page.json")
        meta = _read(d / "meta.json")
        same = cloud_page == local_page and bool(doc.get("confirmed")) == bool(meta.get("confirmed")) and (doc.get("title") or meta.get("title")) == meta.get("title")
        if same:
            if int(doc.get("learnedRev") or 0) < rev:
                self.fs.update(self.p("pages", pid), {"learnedRev": rev})
            self.state.d["pages"][pid] = {"fp": local_fp, "rev": rev}
            return
        if st and st["rev"] == rev:
            return   # nothing new on the site: the difference is a change made here, which `push_local_pages` sends
        if st and st["fp"] != local_fp:   # changed on both sides since they last agreed: the site wins, yours is kept beside it
            (d / "page.local-backup.json").write_text(json.dumps(local_page, indent=1, ensure_ascii=False))
            self.log(f"  {pid} changed here and on the site; kept the site's, and yours as page.local-backup.json")
        body = {"confirmed": bool(doc.get("confirmed"))}
        if doc.get("title"):
            body["title"] = doc["title"]
        if cloud_page != local_page:
            body["page"] = cloud_page
        self.store.save(pid, body)
        self.fs.update(self.p("pages", pid), {"learnedRev": rev})
        self.state.d["pages"][pid] = {"fp": self.fingerprint(pid), "rev": rev}
        self.profile_dirty = True
        self.log(f"Learned from your edits to {pid}.")

    def delete_local_page(self, pid: str) -> None:
        if (self.store.home / pid).is_dir():
            self.store.delete(pid)
            self.profile_dirty = True
            self.log(f"Deleted {pid} here (you deleted it on the site).")
        self.state.d["pages"].pop(pid, None)
        self.fs.delete(self.p("pages", pid))

    def handle_page(self, doc: dict) -> None:
        if doc.get("deleted"):
            return self.delete_local_page(doc["_id"])
        status = doc.get("status", "ready")
        if status == "queued":
            self.read_page(doc)
        elif status == "ready" and doc.get("pageJson"):
            self.learn_page(doc)

    def push_local_pages(self) -> None:
        mine = self.state.d["pages"]
        here = {d.name for d in self.store.home.iterdir() if d.is_dir() and app.ID.match(d.name) and (d / "page.json").exists()}
        for pid in sorted(here):
            fp = self.fingerprint(pid)
            st = mine.get(pid)
            if st and st["fp"] == fp:
                continue
            existing = self.fs.get(self.p("pages", pid))
            if existing and existing.get("deleted"):
                continue
            if existing and not st:                      # it is there already (state was lost): record it, don't overwrite
                mine[pid] = {"fp": fp, "rev": existing.get("rev", 0)}
                continue
            if existing and st and int(existing.get("rev") or 0) != st["rev"]:
                continue                                 # the site changed it too: `learn_page` settles that first
            self.publish_page(pid)
            self.log(f"Sent {pid} to the site.")
        for pid in sorted(set(mine) - here):             # deleted here: take it off the site too
            self.fs.delete(self.p("pages", pid, "files", "flat"))
            self.fs.delete(self.p("pages", pid))
            mine.pop(pid)
            self.log(f"Removed {pid} from the site (you deleted it here).")

    # --- notebooks -----------------------------------------------------------------------------------------------------

    def _nb_dir(self, nid: str) -> Path:
        return self.nbs.root / nid

    def pull_notebook(self, meta: dict, local: dict | None) -> None:
        nid = meta["_id"]
        body = self.fs.get(self.p("notebooks", nid, "parts", "body")) or {"itemsJson": "[]", "linksJson": "[]"}
        view = meta.get("view") or {}
        nb = {"id": nid, "title": meta.get("title") or "Untitled notebook", "color": meta.get("color", "sky"), "created": meta.get("created") or _now(),
              "updated": meta.get("updated") or _now(), "rev": (local["rev"] + 1) if local else 1,
              "view": {"x": float(view.get("x", 0)), "y": float(view.get("y", 0)), "z": float(view.get("z", 1))},
              "sense_open": bool(meta.get("senseOpen")), "items": json.loads(body["itemsJson"]), "links": json.loads(body["linksJson"]),
              "narration": (local or {}).get("narration")}
        with self.nbs.lock:
            self.nbs._write(nb)
            assets = self._nb_dir(nid) / "assets"
            for f in self.fs.list(self.p("notebooks", nid, "files")):
                if notebooks.ASSET.match(f["_id"]) and not (assets / f["_id"]).exists():
                    assets.mkdir(exist_ok=True)
                    (assets / f["_id"]).write_bytes(f["bytes"])
        self.state.d["notebooks"][nid] = {"local_rev": nb["rev"], "cloud_rev": int(meta.get("rev") or 0)}
        self.log(f"Brought notebook “{nb['title']}” home from the site.")

    def handle_notebook(self, meta: dict) -> None:
        nid = meta["_id"]
        if meta.get("deleted"):
            if (self._nb_dir(nid)).is_dir():
                with self.nbs.lock:
                    shutil.rmtree(self._nb_dir(nid))
                self.log(f"Deleted notebook {nid} here (you deleted it on the site).")
            self.state.d["notebooks"].pop(nid, None)
            for f in self.fs.list(self.p("notebooks", nid, "files")):
                self.fs.delete(self.p("notebooks", nid, "files", f["_id"]))
            self.fs.delete(self.p("notebooks", nid))
            return
        st = self.state.d["notebooks"].get(nid)
        cloud_rev = int(meta.get("rev") or 0)
        have = (self._nb_dir(nid) / "notebook.json").is_file()
        local = self.nbs._load(nid) if have else None
        if st and st["cloud_rev"] == cloud_rev:
            return
        if local and not st:                       # both exist and state was lost: believe the site, it is the one that moves
            self.state.d["notebooks"][nid] = {"local_rev": local["rev"], "cloud_rev": cloud_rev}
            return
        if local and st and local["rev"] != st["local_rev"]:       # changed on both sides: keep this Mac's as a copy
            copy = dict(local, id=f"{datetime.now():%Y%m%d-%H%M%S}-{os.urandom(2).hex()}", title=f"{local['title']} (Mac copy)", rev=1)
            with self.nbs.lock:
                self.nbs._write(copy)
                src = self._nb_dir(nid) / "assets"
                if src.is_dir():
                    shutil.copytree(src, self._nb_dir(copy["id"]) / "assets", dirs_exist_ok=True)
            self.log(f"  notebook “{local['title']}” changed here and on the site; kept this Mac's as “{copy['title']}”")
        self.pull_notebook(meta, local)

    def push_local_notebooks(self) -> None:
        mine = self.state.d["notebooks"]
        here = {d.name for d in self.nbs.root.iterdir() if d.is_dir() and notebooks.ID.match(d.name) and (d / "notebook.json").is_file()}
        for nid in sorted(here):
            nb = self.nbs._load(nid)
            st = mine.get(nid)
            if st and st["local_rev"] == nb["rev"]:
                continue
            cloud = self.fs.get(self.p("notebooks", nid))
            if cloud and cloud.get("deleted"):
                continue
            if cloud and not st:
                mine[nid] = {"local_rev": nb["rev"], "cloud_rev": int(cloud.get("rev") or 0)}
                continue
            if cloud and st and int(cloud.get("rev") or 0) != st["cloud_rev"]:
                continue                           # the site changed it too: `handle_notebook` settles that first
            sense = self.nbs.sense_of(nb)
            new_rev = int((cloud or {}).get("rev") or 0) + 1
            meta = {"id": nid, "title": nb["title"], "color": nb.get("color", "sky"), "created": nb["created"], "updated": nb["updated"], "rev": new_rev,
                    "view": nb.get("view") or {"x": 0.0, "y": 0.0, "z": 1.0}, "senseOpen": bool(nb.get("sense_open")),
                    "notes": sense["stats"]["text"], "threads": sense["stats"]["threads"], "loose": sense["stats"]["loose"],
                    "photos": sum(i["type"] == "image" for i in nb["items"]), "thumb": notebooks.thumb_svg(nb, sense), "deleted": False}
            have = {f["_id"] for f in self.fs.list(self.p("notebooks", nid, "files"))}
            assets = self._nb_dir(nid) / "assets"
            for a in sorted(assets.glob("*")) if assets.is_dir() else []:
                if a.name not in have and a.is_file():
                    data, _, _ = fit_jpeg(a.read_bytes())
                    self.fs.set(self.p("notebooks", nid, "files", a.name), {"bytes": data, "type": "image/jpeg"})
            self.fs.set(self.p("notebooks", nid, "parts", "body"), {"itemsJson": json.dumps(nb["items"]), "linksJson": json.dumps(nb["links"]), "rev": new_rev})
            self.fs.set(self.p("notebooks", nid), meta)
            mine[nid] = {"local_rev": nb["rev"], "cloud_rev": new_rev}
            self.log(f"Sent notebook “{nb['title']}” to the site.")
        for nid in sorted(set(mine) - here):
            for f in self.fs.list(self.p("notebooks", nid, "files")):
                self.fs.delete(self.p("notebooks", nid, "files", f["_id"]))
            self.fs.delete(self.p("notebooks", nid, "parts", "body"))
            self.fs.delete(self.p("notebooks", nid))
            mine.pop(nid)
            self.log(f"Removed notebook {nid} from the site (you deleted it here).")

    # --- profile -------------------------------------------------------------------------------------------------------

    def apply_profile_edits(self) -> None:
        edits = sorted(self.fs.list(self.p("profileEdits")), key=lambda e: e.get("at") or 0)
        for e in edits:
            body = {k: e[k] for k in ("shorthand", "action_cues", "forget") if k in e}
            self.store.profile_update(body)
            self.fs.delete(self.p("profileEdits", e["_id"]))
            self.profile_dirty = True
            self.log("Applied a profile change from the site.")

    def publish_profile(self) -> None:
        if self.profile_dirty:
            self.fs.set(self.p("profile", "default"), {"viewJson": json.dumps(self.store.profile_view()), "updatedAt": datetime.now(timezone.utc)})
            self.profile_dirty = False

    # --- the loop ------------------------------------------------------------------------------------------------------

    def heartbeat(self, force: bool = False) -> None:
        if force or time.time() - self._beat >= HEARTBEAT_EVERY:
            self.fs.touch(self.p("state", "mac"), {"host": socket.gethostname(), "version": 1}, "seen")
            self._beat = time.time()

    def changed(self, collection: str, name: str) -> list[dict]:
        docs = self.fs.query(self.p(), collection, "updatedAt", "GREATER_THAN_OR_EQUAL", self.state.cursor(name))
        docs = [d for d in docs if isinstance(d.get("updatedAt"), datetime)]
        return sorted(docs, key=lambda d: d["updatedAt"])

    def cycle(self) -> None:
        self.heartbeat()
        pages = self.changed("pages", "pages")
        for doc in pages:
            self.handle_page(doc)
            self.state.advance("pages", doc["updatedAt"])
        for meta in (nbs := self.changed("notebooks", "notebooks")):
            self.handle_notebook(meta)
            self.state.advance("notebooks", meta["updatedAt"])
        self.apply_profile_edits()
        self.push_local_pages()
        self.push_local_notebooks()
        self.publish_profile()
        self.state.save()

    def stop(self) -> None:
        self._stop.set()

    def run(self, interval: float = 15.0, once: bool = False) -> None:
        self.heartbeat(force=True)
        self.log(f"Watching the site for {self.uid}. Pages you add there get read here.")
        while not self._stop.is_set():
            try:
                self.cycle()
            except (FirestoreError, OSError) as e:    # no network, or Firestore hiccuped: try again next time
                self.log(f"  (will retry: {e})")
            except Exception:  # noqa: BLE001
                traceback.print_exc()
            if once:
                return
            self._stop.wait(interval)


def find_uid(fs: Firestore, email: str) -> str:
    users = fs.query("", "users", "email", "EQUAL", email)
    if not users:
        raise WorkerError(f"{email} hasn't signed in to the website yet. Open the site, sign in once, then start this again.")
    return users[0]["_id"]


def connect(email: str, key_file: str | None, project: str | None) -> tuple[Firestore, str]:
    auth = default_auth(key_file)
    project = project or getattr(auth, "project_id", None) or DEFAULT_PROJECT
    fs = Firestore(project, auth)
    return fs, find_uid(fs, email.lower())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--email", required=True, help="the Google account you sign in to the website with")
    ap.add_argument("--key-file", help="service-account key (or set ANCHOR_SERVICE_ACCOUNT); not needed with the emulator")
    ap.add_argument("--project", help=f"Firebase project id (default: the key's, else {DEFAULT_PROJECT})")
    ap.add_argument("--home", default=str(app.ROOT / "notes"))
    ap.add_argument("--interval", type=float, default=15.0, help="seconds between looks at the site")
    ap.add_argument("--once", action="store_true", help="do one round and stop")
    a = ap.parse_args(argv)
    home = Path(a.home)
    home.mkdir(parents=True, exist_ok=True)
    try:
        lock = take_lock(home)
        fs, uid = connect(a.email, a.key_file, a.project)
    except (WorkerError, RuntimeError) as e:
        print(e, file=sys.stderr)
        return 1
    store = app.Store(home)
    worker = Worker(store, notebooks.Notebooks(store), fs, uid)
    try:
        worker.run(a.interval, a.once)
    except KeyboardInterrupt:
        pass
    finally:
        lock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
