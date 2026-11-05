"""Link cards: fetch a page's title, favicon and thumbnail from this Mac, no third party in between.

Whatever goes wrong (offline, slow, not HTML, blocked) the answer is still a card: the address as its title, no pictures.
"""

from __future__ import annotations

import re
import urllib.error
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 AnchorBoard"
TIMEOUT = 6
MAX_HTML = 1_500_000
MAX_ICON = 300_000
MAX_THUMB = 3_000_000
IMAGE_MAGIC = ((b"\x89PNG", "image/png"), (b"\xff\xd8\xff", "image/jpeg"), (b"GIF8", "image/gif"), (b"RIFF", "image/webp"),
               (b"\x00\x00\x01\x00", "image/x-icon"), (b"<svg", "image/svg+xml"), (b"<?xml", "image/svg+xml"))


class _Head(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.meta: dict[str, str] = {}
        self.icons: list[tuple[int, str]] = []
        self._in_title = False
        self.done = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key and a.get("content") and key not in self.meta:
                self.meta[key] = a["content"].strip()
        elif tag == "link" and a.get("href"):
            rel = a.get("rel", "").lower().split()
            if "icon" in rel or "apple-touch-icon" in rel:
                m = re.match(r"(\d+)x\d+", a.get("sizes", ""))
                rank = (int(m.group(1)) if m else 16) if "apple-touch-icon" not in rel else 60
                self.icons.append((rank, a["href"]))

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.done = True

    def handle_data(self, data):
        if self._in_title and len(self.title) < 300:
            self.title += data


def _failed(e: Exception) -> None:
    """A 404 or 500 answer is an open connection until it is closed."""
    if isinstance(e, urllib.error.HTTPError):
        e.close()


def _get(url: str, limit: int) -> tuple[bytes, str, str, bool]:
    """The first `limit` bytes of `url`, its content type and charset, and whether there was more than that."""
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = r.read(limit + 1)
        more = len(data) > limit
        return data[:limit], (r.headers.get("Content-Type") or "").lower(), r.headers.get_content_charset() or "", more


def _image(url: str, limit: int) -> tuple[bytes, str] | None:
    """A picture no bigger than `limit`; one that is bigger is left out, not kept cut short."""
    try:
        data, ctype, _, more = _get(url, limit)
    except (urllib.error.URLError, OSError, ValueError) as e:
        _failed(e)
        return None
    if more:
        return None
    head = data[:64].lstrip()
    for magic, mime in IMAGE_MAGIC:
        if head.startswith(magic) and (magic != b"RIFF" or data[8:12] == b"WEBP"):
            return data, mime
    return None


def fetch(url: str, store) -> dict:
    """`store(data, name, mime)` keeps a file beside the board and returns its asset name. Never raises."""
    url = url.strip()
    p = urlparse(url)
    host = (p.hostname or "").removeprefix("www.")
    card = {"url": url, "host": host, "title": url if len(url) < 80 else host, "desc": "", "favicon": None, "thumb": None, "ok": False}
    if p.scheme not in ("http", "https") or not p.hostname:
        return card
    try:
        data, ctype, charset, _ = _get(url, MAX_HTML)
    except (urllib.error.URLError, OSError, ValueError) as e:
        _failed(e)
        return card
    head = data[:64].lstrip()
    if ctype.startswith("image/") or any(head.startswith(m) for m, _ in IMAGE_MAGIC[:4]):
        img = _image(url, MAX_THUMB)
        if img:
            card.update(ok=True, title=p.path.rsplit("/", 1)[-1] or host, thumb=store(img[0], "thumb", img[1]))
        return card
    try:
        text = data.decode(charset or "utf-8", errors="replace")
    except LookupError:
        text = data.decode("utf-8", errors="replace")
    h = _Head()
    try:
        h.feed(text[:400_000])
    except Exception:  # a broken page is still a card
        pass
    title = h.meta.get("og:title") or h.meta.get("twitter:title") or h.title.strip()
    title = re.sub(r"\s+", " ", title).strip()
    if title:
        card["title"] = title[:300]
    card["desc"] = re.sub(r"\s+", " ", h.meta.get("og:description") or h.meta.get("description") or "").strip()[:600]
    card["ok"] = True
    icons = [href for _, href in sorted(h.icons, key=lambda t: -t[0])] + ["/favicon.ico"]
    for href in icons[:3]:
        img = _image(urljoin(url, href), MAX_ICON)
        if img:
            card["favicon"] = store(img[0], "favicon", img[1])
            break
    thumb_url = h.meta.get("og:image") or h.meta.get("twitter:image") or h.meta.get("twitter:image:src")
    if thumb_url:
        img = _image(urljoin(url, thumb_url), MAX_THUMB)
        if img and img[1] != "image/svg+xml":
            card["thumb"] = store(img[0], "thumb", img[1])
    return card
