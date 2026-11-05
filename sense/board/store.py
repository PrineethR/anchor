"""Boards on disk: notes/boards/<id>/board.json and notes/boards/<id>/assets/. Stdlib only.

The same convention as notebooks (notes/notebooks/<id>/notebook.json): one folder per board, written
atomically, a revision number that goes up with every change. A deleted board moves to
notes/boards/.trash/ and can be put back. Templates the user saves live in notes/boards/.templates/.
"""

from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import secrets
import shutil
import tempfile
import threading
from datetime import datetime
from pathlib import Path

from . import schema
from .schema import ASSET, ID


class NotFound(LookupError):
    pass


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def new_id() -> str:
    return f"{datetime.now():%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"


def blank(bid: str, title: str) -> dict:
    return {"format": schema.FORMAT, "version": schema.VERSION, "id": bid, "title": title, "created": now(), "updated": now(),
            "rev": 1, "view": {"x": 0.0, "y": 0.0, "z": 1.0}, "objects": []}


def safe_name(name: str, fallback: str = "file") -> str:
    """A file name that is allowed in assets/ and still reads like the original."""
    name = os.path.basename(str(name or "")).strip()
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    stem = re.sub(r"[^A-Za-z0-9._ ()+,-]+", "-", stem).strip(" .-")[:80] or fallback
    ext = re.sub(r"[^A-Za-z0-9]+", "", ext)[:10].lower()
    out = f"{stem}.{ext}" if ext else stem
    return out if ASSET.match(out) else f"{fallback}.{ext}" if ext else fallback


class Boards:
    def __init__(self, home: Path):
        self.root = Path(home) / "boards"
        self.trash = self.root / ".trash"
        self.templates = self.root / ".templates"
        for d in (self.root, self.trash, self.templates):
            d.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    # --- storage -------------------------------------------------------------------------------

    def dir(self, bid: str, trashed: bool = False) -> Path:
        base = self.trash if trashed else self.root
        if not ID.match(bid) or not (base / bid / "board.json").is_file():
            raise NotFound(bid)
        return base / bid

    def load(self, bid: str) -> dict:
        try:
            return json.loads((self.dir(bid) / "board.json").read_text())
        except ValueError as e:
            raise ValueError(f"That board's file can't be read ({e}).")

    def _write(self, board: dict, base: Path | None = None) -> None:
        d = (base or self.root) / board["id"]
        d.mkdir(exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                json.dump(board, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, d / "board.json")
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def meta(self, board: dict) -> dict:
        counts: dict[str, int] = {}
        for o in board["objects"]:
            counts[o["type"]] = counts.get(o["type"], 0) + 1
        return {"id": board["id"], "title": board["title"], "created": board["created"], "updated": board["updated"],
                "rev": board["rev"], "objects": len(board["objects"]), "frames": counts.get("frame", 0),
                "thumb": thumb_svg(board)}

    # --- the list ------------------------------------------------------------------------------

    def list(self, q: str = "") -> list[dict]:
        out = []
        q = q.strip().lower()
        for d in self.root.iterdir():
            if not d.is_dir() or not ID.match(d.name):
                continue
            try:
                b = json.loads((d / "board.json").read_text())
            except (OSError, ValueError):
                continue
            if q and q not in b.get("title", "").lower():
                continue
            out.append(self.meta(b))
        out.sort(key=lambda m: m["updated"], reverse=True)
        return out

    def trashed(self) -> list[dict]:
        out = []
        for d in self.trash.iterdir():
            if d.is_dir() and ID.match(d.name) and (d / "board.json").is_file():
                try:
                    b = json.loads((d / "board.json").read_text())
                    when = json.loads((d / "trashed.json").read_text()).get("at", "") if (d / "trashed.json").is_file() else ""
                except (OSError, ValueError):
                    continue
                out.append({**self.meta(b), "trashed": when})
        out.sort(key=lambda m: m["trashed"], reverse=True)
        return out

    def create(self, title: str = "", objects: list[dict] | None = None) -> dict:
        with self.lock:
            b = blank(new_id(), (title or "").strip()[:120] or "Untitled board")
            if objects:
                b["objects"] = schema.tidy(schema.clean_objects(objects))
            self._write(b)
            return b

    def rename(self, bid: str, title: str) -> dict:
        return self.save(bid, {"title": title})

    def duplicate(self, bid: str) -> dict:
        with self.lock:
            src = self.load(bid)
            b = {**src, "id": new_id(), "title": f"{src['title']} (copy)"[:120], "created": now(), "updated": now(), "rev": 1}
            self._write(b)
            if (self.dir(bid) / "assets").is_dir():
                shutil.copytree(self.dir(bid) / "assets", self.root / b["id"] / "assets")
            return b

    def delete(self, bid: str) -> None:
        """To the trash: nothing is erased."""
        with self.lock:
            d = self.dir(bid)
            dest = self.trash / bid
            if dest.exists():
                shutil.rmtree(dest)
            shutil.move(str(d), str(dest))
            (dest / "trashed.json").write_text(json.dumps({"at": now()}))

    def restore(self, bid: str) -> dict:
        with self.lock:
            d = self.dir(bid, trashed=True)
            dest = self.root / bid
            if dest.exists():
                raise ValueError("A board with that id is already there.")
            shutil.move(str(d), str(dest))
            (dest / "trashed.json").unlink(missing_ok=True)
            return self.load(bid)

    def purge(self, bid: str) -> None:
        with self.lock:
            shutil.rmtree(self.dir(bid, trashed=True))

    # --- changes -------------------------------------------------------------------------------

    def save(self, bid: str, patch: dict) -> dict:
        """Apply a change: objects to add or replace, ids to remove, the z-order, the title, the view.
        Returns what was kept (cleaned) so a caller that wants it can see it."""
        with self.lock:
            b = self.load(bid)
            applied = self.apply(b, patch)
            self._write(b)
            return {"rev": b["rev"], "updated": b["updated"], **applied}

    def apply(self, b: dict, patch: dict) -> dict:
        """Change the loaded board `b` in place. The caller writes it."""
        by_id = {o["id"]: o for o in b["objects"]}
        order = [o["id"] for o in b["objects"]]
        gone = [i for i in (patch.get("delete") or []) if isinstance(i, str) and i in by_id]
        for i in gone:
            del by_id[i]
        order = [i for i in order if i in by_id]    # a deleted id that comes back in the same patch goes to the top, once
        placed = set(order)
        kept = []
        for raw in patch.get("upsert") or []:
            o = schema.clean_object(raw)
            if o["id"] not in placed:
                order.append(o["id"])
                placed.add(o["id"])
            by_id[o["id"]] = o
            kept.append(o)
        if len(by_id) > schema.MAX_OBJECTS:
            raise ValueError("That board has too many things on it to keep.")
        if isinstance(patch.get("order"), list):
            want = list(dict.fromkeys(i for i in patch["order"] if isinstance(i, str) and i in by_id))
            seen = set(want)
            order = want + [i for i in order if i not in seen]
        b["objects"] = schema.tidy([by_id[i] for i in order])
        if "title" in patch:
            b["title"] = str(patch["title"]).strip()[:120] or b["title"]
        if isinstance(patch.get("view"), dict):
            v = patch["view"]
            b["view"] = {"x": schema.num(v.get("x")), "y": schema.num(v.get("y")), "z": schema.num(v.get("z"), 0.02, 4, 1.0)}
        b["rev"] += 1
        b["updated"] = now()
        return {"upsert": kept, "delete": gone}

    # --- assets --------------------------------------------------------------------------------

    def asset_dir(self, bid: str, create: bool = False) -> Path:
        d = self.dir(bid) / "assets"
        if create:
            d.mkdir(exist_ok=True)
        return d

    def add_asset(self, bid: str, data: bytes, name: str = "", mime: str = "", keep_name: bool = False) -> dict:
        """Store a file beside the board. Pictures get a random name; other files keep theirs so the folder stays readable."""
        with self.lock:
            d = self.asset_dir(bid, create=True)
            orig = safe_name(name, "file")
            ext = Path(orig).suffix.lower()
            if not ext and mime:
                ext = (mimetypes.guess_extension(mime.split(";")[0].strip()) or "").replace(".jpe", ".jpg")
            if keep_name:
                stem, ext = Path(orig).stem, Path(orig).suffix
                final, n = orig, 1
                while (d / final).exists():
                    n += 1
                    final = safe_name(f"{stem} ({n}){ext}")
            else:
                final = f"{secrets.token_hex(5)}{ext}"
            (d / final).write_bytes(data)
            return {"src": final, "name": orig, "size": len(data), "mime": mime or mimetypes.guess_type(orig)[0] or "application/octet-stream"}

    def asset_path(self, bid: str, name: str) -> Path:
        if not ASSET.match(name) or not (self.dir(bid) / "assets" / name).is_file():
            raise NotFound(name)
        return self.dir(bid) / "assets" / name

    def copy_assets(self, dst: str, srcs: list[str], from_board: str | None = None, from_template: str | None = None) -> dict:
        """Copy files another board (or a template) holds into this board's assets, for paste across boards. Returns old name -> new name."""
        with self.lock:
            src_dir = (self.templates / from_template / "assets") if from_template else (self.dir(from_board) / "assets")
            if from_template and not ID.match(from_template):
                raise NotFound(from_template)
            out = {}
            d = self.asset_dir(dst, create=True)
            for name in srcs:
                if not isinstance(name, str) or not ASSET.match(name) or not (src_dir / name).is_file():
                    continue
                if (d / name).is_file() and (d / name).read_bytes() == (src_dir / name).read_bytes():
                    out[name] = name
                    continue
                final = name
                while (d / final).exists():
                    final = f"{secrets.token_hex(3)}-{name}"[:119]
                shutil.copyfile(src_dir / name, d / final)
                out[name] = final
            return out

    # --- export, import ------------------------------------------------------------------------

    def export(self, bid: str) -> dict:
        """The board and its files as one JSON document: assets are inlined as base64."""
        b = self.load(bid)
        assets = {}
        d = self.dir(bid) / "assets"
        used = {o.get(k) for o in b["objects"] for k in ("src", "favicon", "thumb") if o.get(k)}
        for name in sorted(used):
            if (d / name).is_file():
                assets[name] = base64.b64encode((d / name).read_bytes()).decode()
        return {**b, "assets": assets}

    def import_(self, doc: dict) -> dict:
        if not isinstance(doc, dict) or doc.get("format") != schema.FORMAT or not isinstance(doc.get("objects"), list):
            raise ValueError("That file isn't an Anchor board.")
        if not isinstance(doc.get("assets") or {}, dict):
            raise ValueError("That board file's pictures and files can't be read.")
        with self.lock:
            b = blank(new_id(), str(doc.get("title") or "Imported board")[:120])
            b["objects"] = schema.tidy(schema.clean_objects(doc["objects"]))
            if isinstance(doc.get("view"), dict):
                v = doc["view"]
                b["view"] = {"x": schema.num(v.get("x")), "y": schema.num(v.get("y")), "z": schema.num(v.get("z"), 0.02, 4, 1.0)}
            self._write(b)
            for name, data in (doc.get("assets") or {}).items():
                if isinstance(name, str) and ASSET.match(name):
                    try:
                        raw = base64.b64decode(data, validate=True)
                    except (ValueError, TypeError):
                        continue
                    self.asset_dir(b["id"], create=True)
                    (self.asset_dir(b["id"]) / name).write_bytes(raw)
            return b

    # --- templates the user saved --------------------------------------------------------------

    def template_list(self) -> list[dict]:
        out = []
        for d in sorted(self.templates.iterdir(), reverse=True):
            if d.is_dir() and ID.match(d.name) and (d / "template.json").is_file():
                try:
                    t = json.loads((d / "template.json").read_text())
                except (OSError, ValueError):
                    continue
                out.append({"id": t["id"], "name": t["name"], "count": len(t["objects"]), "thumb": thumb_svg(t)})
        return out

    def template_get(self, tid: str) -> dict:
        if not ID.match(tid) or not (self.templates / tid / "template.json").is_file():
            raise NotFound(tid)
        return json.loads((self.templates / tid / "template.json").read_text())

    def template_save(self, name: str, objects: list[dict], from_board: str | None = None) -> dict:
        """Keep a selection. Its pictures and files are copied in, so the template stands on its own."""
        with self.lock:
            objs = schema.clean_objects(objects)
            if not objs:
                raise ValueError("Select something to save as a template.")
            srcs = {o.get(k) for o in objs for k in ("src", "favicon", "thumb") if o.get(k)} if from_board else set()
            src_dir = self.dir(from_board) / "assets" if srcs else None    # looked up first: no such board, no half-made template
            tid = new_id()
            d = self.templates / tid
            d.mkdir()
            try:
                if src_dir:
                    (d / "assets").mkdir()
                    for n in srcs:
                        if (src_dir / n).is_file():
                            shutil.copyfile(src_dir / n, d / "assets" / n)
                t = {"id": tid, "name": (name or "").strip()[:80] or "Untitled template", "objects": schema.tidy(objs)}
                (d / "template.json").write_text(json.dumps(t, ensure_ascii=False, separators=(",", ":")))
            except BaseException:
                shutil.rmtree(d, ignore_errors=True)
                raise
            return t

    def template_delete(self, tid: str) -> None:
        with self.lock:
            self.template_get(tid)
            shutil.rmtree(self.templates / tid)


# --- a small picture of a board for the list ---------------------------------------------------

def thumb_svg(board: dict) -> str:
    """The board's objects as flat coloured blocks. Colours here are the stickies' own (content); the rest are tokens."""
    objs = [o for o in board.get("objects", []) if o["type"] != "connector"][:1500]
    if not objs:
        return ""
    box = schema.bbox(objs)
    x0, y0, bw, bh = box
    vw, vh = 240, 150
    s = min((vw - 24) / max(bw, 1), (vh - 24) / max(bh, 1))
    ox, oy = (vw - bw * s) / 2 - x0 * s, (vh - bh * s) / 2 - y0 * s
    out = [f'<svg viewBox="0 0 {vw} {vh}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">']
    for o in objs:
        x, y, w, h = ox + o["x"] * s, oy + o["y"] * s, max(o["w"] * s, 1.5), max(o["h"] * s, 1.5)
        t = o["type"]
        if t == "frame":
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="2" fill="none" stroke="var(--line)" stroke-width="1"/>')
        elif t == "sticky":
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="1.5" fill="{schema.STICKY.get(o["color"], "#FFF9B1")}"/>')
        elif t == "draw":
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="1.5" fill="var(--fg-3)" opacity=".35"/>')
        else:
            out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="1.5" fill="var(--bg-muted)" stroke="var(--line)" stroke-width=".6"/>')
    out.append("</svg>")
    return "".join(out)
