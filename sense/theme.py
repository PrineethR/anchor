"""The Noteworthy design system, as the app and the shared files use it.

The files in static/ are the system, copied (see static/SOURCE.md). This module only puts them
together: one stylesheet, a dark theme that follows the device (the system sets dark with
`data-theme="dark"`; a standalone page has no script to set it, so the same rules are repeated
under `prefers-color-scheme`), and, for a file that must stand alone, the fonts inlined.
"""

from __future__ import annotations

import base64
import json
import re
from pathlib import Path

STATIC = Path(__file__).with_name("static")
PARTS = {"tokens": "noteworthy.tokens.css", "components": "noteworthy.components.css", "motion": "noteworthy.motion.css"}
FONTS_SHARED = ("Newsreader-normal", "Newsreader-italic", "Figtree-normal", "Figtree-italic")  # JetBrains Mono is for code only

# One shape and colour per thread of ideas, in the order static/prerender.mjs renders them. Sun is
# left out of the cycle on purpose: it means "you underlined this".
THREAD_COLORS = ("sky", "blush", "mint", "violet", "tangerine", "berry")

_pre = None


def _prerendered() -> dict:
    global _pre
    if _pre is None:
        _pre = json.loads((STATIC / "prerendered.json").read_text())
    return _pre


def thread_mark(i: int) -> str:
    """The design system's own shape for thread number i, as inline SVG."""
    marks = _prerendered()["thread_shapes"]
    return marks[i % len(marks)]["svg"]


def sign_off() -> str:
    return _prerendered()["sign_off"]


def thread_css() -> str:
    """.th0 .. .th5: the colours a thread paints its card, its marker and its words on the retyped page with."""
    return "\n".join(f".th{i}{{--tc:var(--{c});--ts:var(--{c}-soft);--ti:var(--{c}-ink)}}" for i, c in enumerate(THREAD_COLORS))


def _dark_media(css: str) -> str:
    """Repeat each `:root[data-theme="dark"]{...}` block so it also applies when the device is dark."""
    blocks = re.findall(r':root\[data-theme="dark"\]\{.*?\n\}', css, re.S)
    inner = "\n".join(b.replace(':root[data-theme="dark"]', ':root:not([data-theme="light"])') for b in blocks)
    return f"@media (prefers-color-scheme: dark){{\n{inner}\n}}\n"


def _inline_fonts(css: str) -> str:
    def face(m: re.Match) -> str:
        name = m.group(1)
        if name not in FONTS_SHARED:
            return ""
        data = base64.b64encode((STATIC / "fonts" / f"{name}.woff2").read_bytes()).decode()
        return m.group(0).replace(f"url('fonts/{name}.woff2')", f"url(data:font/woff2;base64,{data})")

    return re.sub(r"@font-face\{[^}]*?url\('fonts/([A-Za-z-]+)\.woff2'\)[^}]*\}\n?", face, css)


def stylesheet(embed_fonts: bool = False, parts: tuple[str, ...] = ("tokens", "components", "motion")) -> str:
    out = []
    for p in parts:
        css = (STATIC / PARTS[p]).read_text()
        out.append(_inline_fonts(css) if embed_fonts else css)
        if p == "tokens":
            out.append(_dark_media(css))
    out.append(thread_css())
    return "\n".join(out)
