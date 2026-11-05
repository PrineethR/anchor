"""The Board's HTTP surface: /api/board/... and the editor's files at /web/board/.

app.py hands every such request here and nothing else; the Board lives in this package so it can be removed whole.
"""

from __future__ import annotations

import json
import mimetypes
import queue
import re
import secrets
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote

from . import ask, links, schema
from .hub import Hub
from .store import Boards, NotFound

WEB = Path(__file__).resolve().parent.parent / "web" / "board"
MAX_JSON = 64 * 1024 * 1024
MAX_ASSET = 250 * 1024 * 1024
MAX_IMPORT = 600 * 1024 * 1024
# Files that run when opened. A card for one of these shows it in Finder instead of launching it.
RUNS_CODE = {".app", ".command", ".tool", ".sh", ".bash", ".zsh", ".csh", ".ksh", ".fish", ".pkg", ".mpkg", ".dmg", ".terminal", ".workflow", ".scpt",
             ".scptd", ".applescript", ".action", ".prefpane", ".saver", ".jar", ".jnlp", ".exe", ".msi", ".bat", ".cmd", ".com", ".lnk", ".ps1",
             ".vbs", ".wsf", ".py", ".pyw", ".pl", ".rb", ".php", ".js", ".mjs", ".html", ".htm", ".xhtml", ".svg", ".webloc", ".url", ".inetloc",
             ".fileloc", ".docm", ".xlsm", ".pptm", ".app.zip"}
# What an uploaded file may do when it is opened in a tab: nothing. A page or picture from a board never runs script here.
SANDBOX = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:"
WEB_TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json"}


class BoardApp:
    def __init__(self, home: Path):
        self.boards = Boards(home)
        self.hub = Hub()

    # --- plumbing ------------------------------------------------------------------------------

    def _body(self, h, limit: int) -> bytes:
        n = int(h.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError(f"That is over the {limit // (1024 * 1024)} MB limit.")
        return h.rfile.read(n) if n else b""

    def _json_in(self, h, limit: int = MAX_JSON) -> dict:
        raw = self._body(h, limit)
        if not raw:
            return {}
        out = json.loads(raw)
        if not isinstance(out, dict):
            raise ValueError("That request didn't look right.")
        return out

    def static(self, h, name: str) -> None:
        """The editor's own files (web/board/*.js, *.css). Only plain file names in that folder."""
        p = WEB / name
        if not re.fullmatch(r"[A-Za-z0-9_-]+\.(js|css|json)", name) or not p.is_file():
            return h._json({"error": "That page isn't here any more."}, 404)
        h._send(200, p.read_bytes(), WEB_TYPES[p.suffix])

    def handle(self, h, method: str, r: list[str], q: dict) -> None:
        try:
            self._route(h, method, r, q)
        except NotFound:
            h._json({"error": "That board isn't here any more."}, 404)
        except (ValueError, KeyError, TypeError) as e:
            h._json({"error": str(e) if isinstance(e, ValueError) else f"That request didn't look right ({type(e).__name__}: {e})."}, 400)

    # --- routes --------------------------------------------------------------------------------

    def _route(self, h, method: str, r: list[str], q: dict) -> None:
        bs = self.boards
        if not r:
            if method == "GET":
                return h._json({"boards": bs.list((q.get("q") or [""])[0]), "trash": len(bs.trashed())})
            if method == "POST":
                body = self._json_in(h)
                return h._json(bs.create(str(body.get("title", ""))), 201)
            raise NotFound("board")
        if r == ["trash"] and method == "GET":
            return h._json({"boards": bs.trashed()})
        if r == ["import"] and method == "POST":
            return h._json(bs.import_(self._json_in(h, MAX_IMPORT)), 201)
        if r == ["history"] and method == "GET":
            return h._json({"runs": ask.history(bs.root)})
        if r == ["usage"] and method == "GET":
            return h._json(ask.usage(bs.root))
        if r[0] == "templates":
            return self._templates(h, method, r[1:])
        bid, rest = r[0], r[1:]
        if not rest:
            if method == "GET":
                return h._json(bs.load(bid))
            if method == "PUT":
                body = self._json_in(h)
                out = bs.save(bid, body)
                self.hub.publish(bid, "patch", {"rev": out["rev"], "upsert": out["upsert"], "delete": out["delete"],
                                                "order": body.get("order") if isinstance(body.get("order"), list) else None,
                                                "title": body.get("title")}, exclude=body.get("client"))
                return h._json({"rev": out["rev"], "updated": out["updated"]})
            if method == "DELETE":
                bs.delete(bid)
                return h._json({"ok": True})
        if rest == ["duplicate"] and method == "POST":
            return h._json(bs.duplicate(bid), 201)
        if rest == ["restore"] and method == "POST":
            return h._json(bs.restore(bid))
        if rest == ["purge"] and method == "POST":
            bs.purge(bid)
            return h._json({"ok": True})
        if rest == ["export.json"] and method == "GET":
            body = bs.export(bid)
            name = re.sub(r"[^a-z0-9]+", "-", body["title"].lower()).strip("-")[:48] or "board"
            return h._send(200, json.dumps(body, ensure_ascii=False).encode(), "application/json",
                           {"Content-Disposition": f'attachment; filename="{name}.board.json"'})
        if rest == ["events"] and method == "GET":
            bs.dir(bid)
            return self._events(h, bid, (q.get("client") or [secrets.token_hex(4)])[0])
        if rest[:1] == ["assets"]:
            return self._assets(h, method, bid, rest[1:], q)
        if rest == ["link"] and method == "POST":
            url = str(self._json_in(h).get("url", ""))
            bs.dir(bid)

            def keep(data: bytes, name: str, mime: str) -> str:
                return bs.add_asset(bid, data, name, mime)["src"]
            return h._json(links.fetch(url, keep))
        if rest == ["ask"] and method == "POST":
            b = self._json_in(h)
            bs.dir(bid)
            return h._json(ask.ask(bs, bid, str(b.get("prompt", "")), str(b.get("model", "")), b.get("selected") if isinstance(b.get("selected"), list) else []))
        if rest == ["open"] and method == "POST":
            return h._json(self._open(bid, str(self._json_in(h).get("src", ""))))
        raise NotFound(h.path)

    # --- pieces --------------------------------------------------------------------------------

    def _events(self, h, bid: str, cid: str) -> None:
        h.send_response(200)
        h.send_header("Content-Type", "text/event-stream")
        h.send_header("Cache-Control", "no-store")
        h.send_header("X-Accel-Buffering", "no")
        h.send_header("X-Content-Type-Options", "nosniff")
        h.end_headers()
        tab = self.hub.subscribe(bid, cid)
        try:
            h.wfile.write(f"event: hello\ndata: {json.dumps({'client': cid})}\n\n".encode())
            h.wfile.flush()
            while True:
                try:
                    msg = tab.get(timeout=15)
                except queue.Empty:
                    msg = ": ping\n\n"
                h.wfile.write(msg.encode())
                h.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.hub.unsubscribe(bid, cid, tab)

    def _assets(self, h, method: str, bid: str, rest: list[str], q: dict) -> None:
        bs = self.boards
        if method == "POST" and not rest:
            name = (q.get("name") or [""])[0]
            mime = (q.get("mime") or [h.headers.get("Content-Type", "")])[0]
            keep = (q.get("keep") or ["0"])[0] == "1"
            bs.dir(bid)
            return h._json(bs.add_asset(bid, self._body(h, MAX_ASSET), name, mime, keep_name=keep), 201)
        if method == "POST" and rest == ["copy"]:
            b = self._json_in(h)
            out = bs.copy_assets(bid, [str(s) for s in b.get("srcs", [])], b.get("from_board"), b.get("from_template"))
            return h._json({"map": out})
        if method == "GET" and len(rest) == 1:
            p = bs.asset_path(bid, unquote(rest[0]))
            ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            return h._send(200, p.read_bytes(), ctype, {"Cache-Control": "max-age=3600", "Content-Security-Policy": SANDBOX})
        raise NotFound(h.path)

    def _open(self, bid: str, src: str) -> dict:
        """Open a file card's file with whatever opens it on this Mac. Programs and web pages are shown in Finder instead."""
        p = self.boards.asset_path(bid, src)
        if sys.platform != "darwin":
            raise ValueError("Opening files from a board is set up for macOS.")
        risky = p.suffix.lower() in RUNS_CODE or p.name.lower().endswith(".app.zip") or (p.stat().st_mode & 0o111)
        subprocess.Popen(["/usr/bin/open", "-R", str(p)] if risky else ["/usr/bin/open", str(p)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"ok": True, "revealed": bool(risky)}

    def _templates(self, h, method: str, rest: list[str]) -> None:
        bs = self.boards
        if not rest:
            if method == "GET":
                return h._json({"templates": bs.template_list()})
            if method == "POST":
                b = self._json_in(h)
                return h._json(bs.template_save(str(b.get("name", "")), b.get("objects") or [], b.get("from_board")), 201)
        elif len(rest) == 1:
            if method == "GET":
                return h._json(bs.template_get(rest[0]))
            if method == "DELETE":
                bs.template_delete(rest[0])
                return h._json({"ok": True})
        elif len(rest) == 3 and rest[1] == "assets" and method == "GET":
            tid, name = rest[0], unquote(rest[2])
            bs.template_get(tid)
            p = bs.templates / tid / "assets" / name
            if not schema.ASSET.fullmatch(name) or not p.is_file():
                raise NotFound(name)
            return h._send(200, p.read_bytes(), mimetypes.guess_type(p.name)[0] or "application/octet-stream",
                           {"Cache-Control": "max-age=3600", "Content-Security-Policy": SANDBOX})
        raise NotFound("templates")
