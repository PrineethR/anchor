"""Assemble the vendored Noteworthy design system files in this folder.

The app does not invent any look of its own: everything here is the Noteworthy design
system, copied. Run this to refresh the copies after the system changes.

    python3 sense/static/build.py --system <the system's project/ folder> --fonts <a folder holding its fonts/> \
        --noteworthy ~/Desktop/Prototypes/noteworthy

    --system      the design system artifact's `project/` folder (tokens/, components/)
    --fonts       a folder with the five .woff2 files (the system's `project/fonts/`)
    --noteworthy  the Noteworthy app repo, for ds.js (its plain-JS port of the system) and the
                  illustration and motion rules in its style.css

Writes next to this file:
    noteworthy.tokens.css       fonts, colour (light and dark), type, space, shape, base rules
    noteworthy.components.css   the CSS of Button, IconButton, Chip, Segmented, Switch, Checkbox,
                                Input, Card, Sheet, Toast, Badge, TabBar and Tile, verbatim
    noteworthy.motion.css       the rules ds.js's shapes, moods, backdrops and scenes need
    ds.js                       the plain-JS port, unchanged
    fonts/*.woff2               Newsreader, Figtree, JetBrains Mono
    icons.json                  the system's 50 Lucide glyphs
    icons-extra.json            more glyphs from the same Lucide release (EXTRA_ICONS below), for the canvas tools:
                                fetched with `--fetch-icons` (needs the network once)
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
LUCIDE = "0.460.0"  # the release the system's own icons were taken from
EXTRA_ICONS = ["type", "undo-2", "redo-2", "mouse-pointer-2", "hand", "move-up-right", "maximize", "rotate-cw", "copy", "pencil", "square-dashed", "camera", "download", "wifi-off", "refresh-cw"]
COMPONENT_FILES = ["core/Button", "core/IconButton", "forms/Chip", "forms/Segmented", "forms/Switch", "forms/Input",
                   "surfaces/Card", "surfaces/Sheet", "surfaces/Tile", "feedback/Toast", "feedback/Badge", "navigation/TabBar"]


def tokens_css(system: Path) -> str:
    parts = [(system / "tokens" / n).read_text() for n in ("fonts.css", "colors.css", "typography.css", "space.css", "shape.css")]
    css = "\n".join(parts).replace("url('../fonts/", "url('fonts/")
    # bundle.css holds the rules that are not tokens (type scale, motion, element defaults); its
    # legacy aliases are for the old Noteworthy build and are left out.
    bundle = (system / "components" / "bundle.css").read_text()
    bundle = bundle.split("/* Aliases for token names used by the earlier Noteworthy build")[0]
    return "/* Noteworthy design system: tokens and base rules. Vendored; see SOURCE.md. */\n" + css + "\n" + bundle


def components_css(system: Path) -> str:
    out = ["/* Noteworthy design system: component CSS, verbatim from components/*.jsx. Vendored; see SOURCE.md. */"]
    for name in COMPONENT_FILES:
        src = (system / "components" / f"{name}.jsx").read_text()
        m = re.search(r"const CSS = `\n?(.*?)`;", src, re.S)
        out.append(f"/* {name.split('/')[1]} */\n{m.group(1).strip()}")
    return "\n".join(out) + "\n"


def motion_css(repo: Path) -> str:
    css = (repo / "style.css").read_text().split("\n")
    start = next(i for i, l in enumerate(css) if "STORY — ILLUSTRATION & MOTION" in l)
    start = next(i for i in range(start, len(css)) if css[i].startswith(":root{"))
    end = next(i for i, l in enumerate(css) if l.startswith(".nwi--still .nwi-a-draw"))
    block = "\n".join(css[start:end + 1])
    block = re.sub(r"\.nw-label\{.*?\}\n", "", block, flags=re.S)  # already in the base rules
    head = "/* Noteworthy design system: what ds.js's shapes, moods, backdrops and scenes need.\n   Copied from the Noteworthy app's style.css (ILLUSTRATION & MOTION). Vendored; see SOURCE.md. */\n"
    return head + block + "\n"


def fetch_extra_icons() -> None:
    """Glyphs the system's fifty don't include, from the same Lucide release, stored as inner SVG markup."""
    out = {}
    for name in EXTRA_ICONS:  # curl, because python.org builds of Python often lack the macOS root certificates
        svg = subprocess.run(["curl", "-fsSL", "-m", "20", f"https://unpkg.com/lucide-static@{LUCIDE}/icons/{name}.svg"],
                             capture_output=True, text=True, check=True).stdout
        inner = re.search(r"<svg[^>]*>(.*)</svg>", svg, re.S).group(1)
        out[name] = re.sub(r"\s+", " ", inner).strip()
    (HERE / "icons-extra.json").write_text(json.dumps(out, indent=1))
    print(f"fetched {len(out)} glyphs from lucide-static@{LUCIDE}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--system", type=Path)
    ap.add_argument("--fonts", type=Path)
    ap.add_argument("--noteworthy", type=Path)
    ap.add_argument("--fetch-icons", action="store_true", help="only fetch the extra glyphs")
    a = ap.parse_args()
    if a.fetch_icons:
        return fetch_extra_icons()
    if not (a.system and a.fonts and a.noteworthy):
        ap.error("--system, --fonts and --noteworthy are required (or use --fetch-icons)")

    (HERE / "noteworthy.tokens.css").write_text(tokens_css(a.system))
    (HERE / "noteworthy.components.css").write_text(components_css(a.system))
    (HERE / "noteworthy.motion.css").write_text(motion_css(a.noteworthy))
    shutil.copy(a.noteworthy / "ds.js", HERE / "ds.js")
    (HERE / "fonts").mkdir(exist_ok=True)
    for f in a.fonts.glob("*.woff2"):
        shutil.copy(f, HERE / "fonts" / f.name)
    src = (a.system / "components" / "core" / "Icon.jsx").read_text()
    line = next(l for l in src.split("\n") if l.startswith("const DATA = "))
    (HERE / "icons.json").write_text(json.dumps(json.loads(line[len("const DATA = "):].rstrip(";")), indent=1))
    commit = subprocess.run(["git", "-C", str(a.noteworthy), "log", "-1", "--format=%h"], capture_output=True, text=True).stdout.strip()
    print(f"built from system {a.system} and Noteworthy@{commit or '?'}")


if __name__ == "__main__":
    main()
