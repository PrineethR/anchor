"""The make-sense app: a local web page for turning a photo of a notebook page into notes
you can read, correct, and send to someone.

    .venv/bin/python -m sense.app                    # http://127.0.0.1:8765
    .venv/bin/python -m sense.app --host 0.0.0.0     # also reachable from your phone on the same Wi-Fi

Everything stays on this Mac. Photos and notes live in notes/<id>/; what the app has learned
about your writing is notes/profile.json. Gemini is used only if GEMINI_API_KEY is set.
There is no sign-in, so only use --host 0.0.0.0 on a network you trust.
"""

from __future__ import annotations

import argparse
import json
import re
import secrets
import shutil
import sys
import threading
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from harness.schema import parse_page, validate
from . import canvas, engine, firestore_sync, meaning, narrate, notebooks, share, theme
from .profile import Profile, style_stats

ROOT = Path(__file__).resolve().parent.parent
UI = Path(__file__).with_name("ui.html")
WEB = Path(__file__).with_name("web")  # the notebooks canvas: its own files, so it can be switched off or removed whole
ID = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{4}$")
MAX_UPLOAD = 40 * 1024 * 1024
MAX_JSON = 5 * 1024 * 1024
MAX_ELEMENTS = 500


class NotFound(LookupError):
    pass


def _read(path: Path):
    return json.loads(path.read_text())


def _write(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, indent=1, ensure_ascii=False))


def clean_page(raw: dict, page_id: str) -> dict:
    """Keep only the fields the format knows, and refuse a page that does not validate."""
    if not isinstance(raw, dict) or not isinstance(raw.get("elements"), list):
        raise ValueError("That page is missing its list of elements.")
    if len(raw["elements"]) > MAX_ELEMENTS or len(raw.get("links", [])) > MAX_ELEMENTS:
        raise ValueError("That page has too many elements to keep.")
    ids = [e.get("id") for e in raw["elements"]]
    if len(set(ids)) != len(ids) or not all(isinstance(i, str) and i for i in ids):
        raise ValueError("Every element needs its own id.")
    elements = []
    for e in raw["elements"]:
        out = {"id": e["id"], "type": e["type"], "bbox": [float(v) for v in e["bbox"]]}
        if e["type"] == "text":
            out.update(text=str(e.get("text", "")).strip(), underline=bool(e.get("underline")), caps=bool(e.get("caps")))
        if e["type"] == "shape":
            out["contains"] = [c for c in e.get("contains", []) if c in ids and c != e["id"]]
        elements.append(out)
    links = []
    for i, l in enumerate(raw.get("links", [])):
        out = {"id": str(l.get("id") or f"l{i + 1}"), "kind": l["kind"], "from": l["from"], "to": l["to"]}
        label = str(l.get("label") or "").strip()
        if label:
            out.update(label=label, caps=bool(l.get("caps")), underline=bool(l.get("underline")))
        links.append(out)
    page = {"page_id": page_id, "page_size": [float(v) for v in raw["page_size"]], "elements": elements, "links": links}
    errs = validate(parse_page(page, page_id), gold=False)
    if errs:
        raise ValueError("; ".join(errs[:5]))
    return page


def thread_of(sense: dict) -> dict[str, int]:
    """Element id -> number of the thread it belongs to, for colouring the retyped page."""
    return {i: n for n, t in enumerate(sense["threads"]) for i in t["ids"]}


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:48] or "notes"


class Store:
    """All the app's state and rules, with no HTTP in it."""

    def __init__(self, home: Path, labeled: Path | None = None, sync: firestore_sync.SyncWorker | None = None):
        self.home = home
        self.labeled = labeled or ROOT / "data" / "labeled"
        self.sync = sync
        self.home.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.profile = Profile.load(home / "profile.json")
        if self.labeled.exists() and self.profile.learn_labeled(self.labeled):
            self.profile.save()
        if self.sync and (home / "profile.json").exists():
            self.sync.schedule_profile(home / "profile.json")

    # --- notes -------------------------------------------------------------------

    def dir(self, nid: str) -> Path:
        if not ID.match(nid) or not (self.home / nid).is_dir():
            raise NotFound(nid)
        return self.home / nid

    def _view(self, nid: str) -> dict:
        d = self.dir(nid)
        meta, page = _read(d / "meta.json"), _read(d / "page.json")
        sense = meaning.make_sense(page, self.profile.data["action_cues"])
        lay = canvas.layout(page, thread_of(sense))
        return {**meta, "page": page, "layout": lay, "sense": sense, "sense_html": share.sense_html(sense, editable=True),
                "clean_html": canvas.render_html(lay), "can_narrate": bool(engine.gemini_key())}

    def get(self, nid: str) -> dict:
        return self._view(nid)

    def list(self) -> list[dict]:
        out = []
        for d in sorted((p for p in self.home.iterdir() if p.is_dir() and ID.match(p.name)), reverse=True):
            try:
                v = self._view(d.name)
            except (OSError, ValueError, KeyError):
                continue
            out.append({"id": v["id"], "title": v["title"], "created": v["created"], "source": v["source"],
                        "confirmed": v["confirmed"], "threads": v["sense"]["stats"]["threads"],
                        "loose": v["sense"]["stats"]["loose"], "actions": len(v["sense"]["actions"])})
        return out

    def _read_into(self, nid: str, d: Path, ocr: dict | None, meta: dict) -> None:
        """Read the flat page with the engine and reset everything that depends on the reading."""
        with self.lock:
            self.profile.forget_note(nid)  # a fresh reading starts without what this note taught before
        examples = engine.pick_examples(self.home, self.labeled) if engine.gemini_key() else []
        raw, source, notes = engine.read(d / "flat.jpg", nid, self.profile, ocr=ocr, examples=examples)
        page, changes = self.profile.apply(raw)
        with self.lock:
            _write(d / "engine.json", raw)
            _write(d / "shown.json", page)
            _write(d / "page.json", page)
            meta.update(source=source, engine_notes=notes, changes=changes, confirmed=False, edited=False, narration=None)
            _write(d / "meta.json", meta)
            self.profile.learn_note(nid, raw, page, page, False)
            self.profile.save()

    def create(self, data: bytes) -> dict:
        if not data:
            raise ValueError("That upload was empty. Choose the photo again.")
        nid = f"{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
        d = self.home / nid
        d.mkdir()
        try:
            (d / "original").write_bytes(data)
            flat = engine.make_flat(data, d / "flat.jpg")
            meta = {"id": nid, "created": datetime.now().isoformat(timespec="seconds"), "how": flat["how"],
                    "turns": flat["turns"], "sure": flat["sure"], "crop": True, "title": ""}
            self._read_into(nid, d, flat["ocr"], meta)
            meta["title"] = meaning.make_sense(_read(d / "page.json"), self.profile.data["action_cues"])["title"]
            _write(d / "meta.json", meta)
            if self.sync:
                self.sync.schedule_note(d)
                self.sync.schedule_profile(self.home / "profile.json")
        except Exception:
            shutil.rmtree(d, ignore_errors=True)
            with self.lock:
                self.profile.forget_note(nid)
            raise
        return self._view(nid)

    def preview(self, nid: str, page: dict) -> dict:
        """What this draft would look like, without saving or learning."""
        page = clean_page(page, nid)
        sense = meaning.make_sense(page, self.profile.data["action_cues"])
        lay = canvas.layout(page, thread_of(sense))
        return {"sense": sense, "sense_html": share.sense_html(sense, editable=True), "clean_html": canvas.render_html(lay),
                "layout": lay}

    def save(self, nid: str, body: dict) -> dict:
        d = self.dir(nid)
        with self.lock:
            meta = _read(d / "meta.json")
            if "page" in body:
                page = clean_page(body["page"], nid)
                _write(d / "page.json", page)
                meta["edited"] = True
                if meta.get("narration"):
                    meta["narration"]["stale"] = True
            if "confirmed" in body:
                meta["confirmed"] = bool(body["confirmed"])
            if "title" in body:
                meta["title"] = str(body["title"]).strip()[:120] or meta["title"]
            _write(d / "meta.json", meta)
            self.profile.learn_note(nid, _read(d / "engine.json"), _read(d / "shown.json"), _read(d / "page.json"),
                                    meta["confirmed"])
            self.profile.save()
            if self.sync:
                self.sync.schedule_note(d)
                self.sync.schedule_profile(self.home / "profile.json")
        return self._view(nid)

    def reread(self, nid: str, rotate: bool = False, crop: bool | None = None) -> dict:
        """Read the page again from the photo: turned a quarter, or with the page cut out differently.
        Throws away corrections."""
        d = self.dir(nid)
        meta = _read(d / "meta.json")
        ocr = None
        if crop is not None and crop != meta.get("crop", True):
            flat = engine.make_flat((d / "original").read_bytes(), d / "flat.jpg", crop)
            meta.update(crop=crop, how=flat["how"], turns=flat["turns"], sure=flat["sure"])
            ocr = flat["ocr"]
        elif rotate:
            engine.rotate_flat(d / "flat.jpg")
            meta.update(turns=(meta.get("turns", 0) + 1) % 4, sure=True)
        self._read_into(nid, d, ocr, meta)
        if self.sync:
            self.sync.schedule_note(d)
        return self._view(nid)

    def narrate(self, nid: str) -> dict:
        key = engine.gemini_key()
        if not key:
            raise ValueError("Add a GEMINI_API_KEY and restart to have Gemini write a summary.")
        v = self._view(nid)
        out = narrate.narrate(v, self.profile.hints(), engine.gemini_model(), key)
        with self.lock:
            d = self.dir(nid)
            meta = _read(d / "meta.json")
            meta["narration"] = {**out, "stale": False}
            _write(d / "meta.json", meta)
        return self._view(nid)

    def delete(self, nid: str) -> None:
        d = self.dir(nid)
        with self.lock:
            shutil.rmtree(d)
            self.profile.forget_note(nid)
            self.profile.save()
            if self.sync:
                self.sync.schedule_delete_note(nid)
                self.sync.schedule_profile(self.home / "profile.json")

    def photo(self, nid: str) -> bytes:
        return (self.dir(nid) / "flat.jpg").read_bytes()

    def export(self, nid: str, fmt: str, with_photo: bool = False) -> tuple[bytes, str, str]:
        v = self._view(nid)
        name = _slug(v["title"])
        if fmt == "md":
            return share.to_markdown(v).encode(), "text/markdown; charset=utf-8", f"{name}.md"
        photo = self.photo(nid) if with_photo else None
        return share.to_html(v, photo).encode(), "text/html; charset=utf-8", f"{name}.html"

    # --- profile -----------------------------------------------------------------

    def profile_view(self) -> dict:
        pages = []  # only pages you checked or corrected: a raw reading says little about how you write
        for d in self.home.iterdir():
            if d.is_dir() and ID.match(d.name) and (d / "meta.json").exists():
                meta = _read(d / "meta.json")
                if meta.get("confirmed") or meta.get("edited"):
                    pages.append(_read(d / "page.json"))
        n_notes = len(pages)
        if self.labeled.exists():
            pages += [_read(f) for f in sorted(self.labeled.glob("*.json"))]
        return {"shorthand": self.profile.data["shorthand"], "action_cues": self.profile.data["action_cues"],
                "fixes": self.profile.learned_fixes(), "vocab": self.profile.vocab().most_common(60),
                "stats": style_stats(pages), "sources": {"notes": n_notes, "labeled": len(pages) - n_notes}}

    def profile_update(self, body: dict) -> dict:
        with self.lock:
            if "shorthand" in body:
                self.profile.set_shorthand({str(k): str(v) for k, v in body["shorthand"].items()})
            if "action_cues" in body:
                self.profile.set_cues([str(c) for c in body["action_cues"]])
            for raw in body.get("forget", []):
                self.profile.forget_fix(str(raw))
            self.profile.save()
            if self.sync:
                self.sync.schedule_profile(self.home / "profile.json")
        return self.profile_view()

    def sync_all(self) -> int:
        """Schedule all existing local notes, notebooks, and profile to sync."""
        if not self.sync:
            return 0
        count = 0
        for d in self.home.iterdir():
            if d.is_dir() and ID.match(d.name) and (d / "page.json").exists():
                self.sync.schedule_note(d)
                count += 1
        nb_dir = self.home / "notebooks"
        if nb_dir.is_dir():
            for d in nb_dir.iterdir():
                if d.is_dir() and ID.match(d.name) and (d / "notebook.json").exists():
                    self.sync.schedule_notebook(d)
                    count += 1
        if (self.home / "profile.json").exists():
            self.sync.schedule_profile(self.home / "profile.json")
        return count

    def status(self) -> dict:
        st = {"gemini": bool(engine.gemini_key()), "vision": engine.vision_ready(),
              "labeled": len(list(self.labeled.glob("*.json"))) if self.labeled.exists() else 0}
        if self.sync:
            st["sync"] = self.sync.status()
        return st


def render_ui() -> str:
    icons = {**json.loads((theme.STATIC / "icons.json").read_text()), **json.loads((theme.STATIC / "icons-extra.json").read_text())}
    return (UI.read_text().replace("/*__CANVAS_CSS__*/", canvas.CSS).replace("/*__SHARE_CSS__*/", share.CSS)
            .replace("/*__ICONS__*/{}", json.dumps(icons)))


class Handler(BaseHTTPRequestHandler):
    store: Store
    nbs: "notebooks.Notebooks | None" = None   # None when run with --no-notebooks
    loopback_only = True

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.command} {self.path.split('?')[0]} -> {args[1] if len(args) > 1 else ''}\n")

    # --- plumbing ----------------------------------------------------------------

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        extra = extra or {}
        if "Cache-Control" not in extra:
            self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, status: int = 200) -> None:
        self._send(status, json.dumps(obj).encode(), "application/json")

    def _body(self, limit: int) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError(f"That is over the {limit // (1024 * 1024)} MB limit. Try a smaller photo.")
        return self.rfile.read(n)

    def _guard(self) -> bool:
        """Refuse requests a web page on another site could be making on your behalf."""
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
        if self.loopback_only and host not in ("localhost", "127.0.0.1", "::1"):
            self._json({"error": "unexpected Host header"}, 403)
            return False
        if self.command != "GET" and self.headers.get("X-Makesense") != "1":
            self._json({"error": "missing X-Makesense header"}, 403)
            return False
        return True

    def _route(self, method: str) -> None:
        if not self._guard():
            return
        url = urlparse(self.path)
        q = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        try:
            self._dispatch(method, parts, q)
        except (NotFound, notebooks.NotFound):
            self._json({"error": "That page isn't here any more."}, 404)
        except notebooks.Conflict as e:
            self._json({"error": str(e)}, 409)
        except engine.EngineError as e:
            self._json({"error": str(e)}, 422)
        except (ValueError, KeyError, TypeError) as e:
            self._json({"error": str(e) if isinstance(e, ValueError) else f"That request didn't look right ({type(e).__name__}: {e})."}, 400)
        except Exception as e:  # keep the server up; the UI shows the message
            self._json({"error": f"Something went wrong on this Mac ({type(e).__name__}: {e})."}, 500)

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")

    def do_DELETE(self):
        self._route("DELETE")

    # --- routes ------------------------------------------------------------------

    def _static(self, rel: str) -> None:
        """The vendored design system. Only these names are served, whatever the request says."""
        day = {"Cache-Control": "max-age=86400"}
        if rel == "noteworthy.css":
            return self._send(200, theme.stylesheet().encode(), "text/css; charset=utf-8")
        if rel == "ds.js":
            return self._send(200, (theme.STATIC / "ds.js").read_bytes(), "text/javascript; charset=utf-8", day)
        m = re.fullmatch(r"fonts/([A-Za-z]+-(?:normal|italic))\.woff2", rel)
        if m and (theme.STATIC / "fonts" / f"{m.group(1)}.woff2").is_file():
            return self._send(200, (theme.STATIC / "fonts" / f"{m.group(1)}.woff2").read_bytes(), "font/woff2", day)
        raise NotFound(rel)

    def _web(self, rel: str) -> None:
        types = {"canvas.js": "text/javascript; charset=utf-8", "canvas.css": "text/css; charset=utf-8"}
        if rel not in types or self.nbs is None:
            raise NotFound(rel)
        self._send(200, (WEB / rel).read_bytes(), types[rel])

    def _notebooks(self, method: str, r: list[str], q: dict) -> None:
        """/api/notebooks/...: the canvas. Everything here is separate from the photo pages."""
        nb = self.nbs
        if nb is None:
            raise NotFound("notebooks")
        if not r:
            if method == "GET":
                return self._json(nb.list())
            if method == "POST":
                body = json.loads(self._body(MAX_JSON) or b"{}")
                return self._json(nb.create(str(body.get("title", ""))), 201)
        else:
            nid, rest = r[0], r[1:]
            if not rest:
                if method == "GET":
                    return self._json(nb.get(nid))
                if method == "PUT":
                    return self._json(nb.save(nid, json.loads(self._body(MAX_JSON * 4))))
                if method == "DELETE":
                    nb.delete(nid)
                    return self._json({"ok": True})
            if rest[0] == "assets" and len(rest) == 2 and method == "GET":
                return self._send(200, nb.asset(nid, rest[1]), "image/jpeg", {"Cache-Control": "max-age=86400"})
            at = {"x": q["x"][0], "y": q["y"][0]} if "x" in q and "y" in q else None
            if rest == ["import"] and method == "POST":
                b = json.loads(self._body(MAX_JSON))
                return self._json(nb.import_note(nid, str(b["note_id"]), b.get("at")))
            if rest == ["photo"] and method == "POST":
                return self._json(nb.add_photo(nid, self._body(MAX_UPLOAD), at), 201)
            if rest == ["narrate"] and method == "POST":
                return self._json(nb.narrate(nid))
            if rest in (["share.html"], ["share.md"]) and method == "GET":
                body, ctype, name = nb.export(nid, rest[0].split(".")[1])
                return self._send(200, body, ctype, {"Content-Disposition": f'attachment; filename="{name}"'})
        raise NotFound(self.path)

    def _dispatch(self, method: str, parts: list[str], q: dict) -> None:
        s = self.store
        if not parts and method == "GET":
            return self._send(200, render_ui().encode(), "text/html; charset=utf-8")
        if parts and parts[0] == "static" and method == "GET":
            return self._static("/".join(parts[1:]))
        if parts and parts[0] == "web" and method == "GET" and len(parts) == 2:
            return self._web(parts[1])
        if not parts or parts[0] != "api":
            raise NotFound(self.path)
        r = parts[1:]
        if r == ["sync"]:
            if method == "GET":
                return self._json(s.sync.status() if s.sync else {"enabled": False})
            if method == "POST":
                count = s.sync_all()
                return self._json({"scheduled": count, "status": s.sync.status() if s.sync else {"enabled": False}})
        if r == ["status"] and method == "GET":
            return self._json({**s.status(), "notebooks": self.nbs is not None})
        if r and r[0] == "notebooks":
            return self._notebooks(method, r[1:], q)
        if r == ["profile"]:
            if method == "GET":
                return self._json(s.profile_view())
            if method == "PUT":
                return self._json(s.profile_update(json.loads(self._body(MAX_JSON))))
        if r == ["notes"]:
            if method == "GET":
                return self._json(s.list())
            if method == "POST":
                return self._json(s.create(self._body(MAX_UPLOAD)), 201)
        if len(r) >= 2 and r[0] == "notes":
            nid, rest = r[1], r[2:]
            if not rest:
                if method == "GET":
                    return self._json(s.get(nid))
                if method == "PUT":
                    return self._json(s.save(nid, json.loads(self._body(MAX_JSON))))
                if method == "DELETE":
                    s.delete(nid)
                    return self._json({"ok": True})
            if rest == ["photo"] and method == "GET":
                return self._send(200, s.photo(nid), "image/jpeg")
            if rest == ["sense"] and method == "POST":
                return self._json(s.preview(nid, json.loads(self._body(MAX_JSON))["page"]))
            if rest == ["reread"] and method == "POST":
                b = json.loads(self._body(MAX_JSON) or b"{}")
                return self._json(s.reread(nid, rotate=bool(b.get("rotate")), crop=b.get("crop")))
            if rest == ["narrate"] and method == "POST":
                return self._json(s.narrate(nid))
            if rest in (["share.html"], ["share.md"]) and method == "GET":
                body, ctype, name = s.export(nid, rest[0].split(".")[1], with_photo=q.get("photo") == ["1"])
                return self._send(200, body, ctype, {"Content-Disposition": f'attachment; filename="{name}"'})
        raise NotFound(self.path)


def make_server(home: Path, host: str = "127.0.0.1", port: int = 8765, labeled: Path | None = None,
                with_notebooks: bool = True, with_sync: bool = False) -> ThreadingHTTPServer:
    sync_worker = None
    if with_sync:
        sync_worker = firestore_sync.SyncWorker()
        sync_worker.start()
    store = Store(home, labeled, sync=sync_worker)
    handler = type("BoundHandler", (Handler,), {
        "store": store,
        "nbs": notebooks.Notebooks(store) if with_notebooks else None,
        "loopback_only": host in ("127.0.0.1", "localhost", "::1"),
    })
    return ThreadingHTTPServer((host, port), handler)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--home", default=str(ROOT / "notes"), help="where photos, notes and the profile are kept")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-labeled", action="store_true", help="don't learn vocabulary from data/labeled")
    ap.add_argument("--no-notebooks", action="store_true", help="run without the notebooks canvas: only the photo pages")
    ap.add_argument("--sync", dest="sync", action="store_true", default=True, help="sync notes and notebooks to Cloud Firestore in background")
    ap.add_argument("--no-sync", dest="sync", action="store_false", help="disable background sync to Cloud Firestore")
    a = ap.parse_args(argv)
    labeled = ROOT / "data" / "no-labeled" if a.no_labeled else None
    server = make_server(Path(a.home), a.host, a.port, labeled, with_notebooks=not a.no_notebooks, with_sync=a.sync)
    st = server.RequestHandlerClass.store.status()
    reader = "Gemini" if st["gemini"] else "Apple Vision (text only, no arrows)" if st["vision"] else "NONE: set GEMINI_API_KEY"
    sync_desc = f"  ·  sync to Firestore ({firestore_sync.DEFAULT_PROJECT}) ON" if a.sync else ""
    print(f"Make sense on http://{a.host}:{a.port}  ·  notes in {a.home}  ·  reading with {reader}{sync_desc}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
