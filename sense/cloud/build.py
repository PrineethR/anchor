"""Build the website into public/ (what Firebase Hosting serves).

    .venv/bin/python -m sense.cloud.build               # for the real project (sense/cloud/web-config.json)
    .venv/bin/python -m sense.cloud.build --emulator    # for the local emulators: a made-up project, no real sign-in

The site is the same ui.html the Mac app serves, the same design system and canvas, plus sense/cloud/web/ (the Firestore backend,
sign-in, and the reading engine's JavaScript port) and the Firebase SDK bundled into one file. No Python runs in the browser.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

from baselines import gemini, try_gemini

from .. import app, canvas, share, theme

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
WEB = HERE / "web"
SENSE = HERE.parent
EMULATOR = {"auth": "127.0.0.1:9099", "firestore": "127.0.0.1:8080"}
EMULATOR_APP = {"apiKey": "demo-key", "authDomain": "localhost", "projectId": "demo-anchor-notes"}


def hexbgr(h: str) -> tuple[int, int, int]:
    return int(h[5:7], 16), int(h[3:5], 16), int(h[1:3], 16)


def draw_icon(size: int, inset: float = 1.0) -> bytes:
    """The app's mark for a phone's home screen: a tiny concept map (three ideas, two arrows) in the design system's colours.

    `inset` shrinks the drawing toward the middle and leaves the paper to the edges: a maskable icon may be cropped to a circle
    by the phone, so everything that matters has to sit in its middle 80 %."""
    k = size / 512 * inset
    mid = size / 2
    s = lambda v: max(1, int(round(v * k)))
    at = lambda x, y: (int(round(mid + (x - 256) * k)), int(round(mid + (y - 256) * k)))
    paper, ink, sky, sun, mint, blush = (hexbgr(c) for c in ("#FBF7F0", "#1D1C1A", "#3DB1F5", "#FFC91C", "#20A95C", "#F7A6CB"))
    img = np.full((size, size, 3), paper, np.uint8)
    a, b, c = at(150, 160), at(370, 200), at(250, 360)
    for p, q in ((a, b), (b, c)):
        d = np.array(q, float) - np.array(p, float)
        d /= np.hypot(*d)
        start, end = (np.array(p) + d * s(62)).astype(int), (np.array(q) - d * s(70)).astype(int)
        cv2.arrowedLine(img, tuple(start), tuple(end), ink, s(10), cv2.LINE_AA, tipLength=0.22)
    for centre, colour, r in ((a, sky, 52), (b, blush, 52), (c, mint, 52)):
        cv2.circle(img, centre, s(r), colour, -1, cv2.LINE_AA)
        cv2.circle(img, centre, s(r), ink, s(8), cv2.LINE_AA)
    cv2.line(img, at(120, 450), at(392, 450), sun, s(22), cv2.LINE_AA)   # what you underlined
    return cv2.imencode(".png", img)[1].tobytes()


def manifest() -> dict:
    """What a phone or desktop needs to install the site as an app. Every address is relative, so it works from any folder."""
    icon = lambda f, size, purpose="any": {"src": f"icons/{f}", "sizes": f"{size}x{size}", "type": "image/png", "purpose": purpose}
    return {
        "id": "./", "name": "Make sense", "short_name": "Make sense", "lang": "en", "dir": "ltr",
        "description": "Turn photos of your handwritten notebook pages into notes you can read, and think on an endless canvas. Works offline.",
        "start_url": "./", "scope": "./", "display": "standalone", "display_override": ["standalone", "minimal-ui"], "orientation": "any",
        "background_color": "#FBF7F0", "theme_color": "#FBF7F0", "categories": ["productivity", "education"],
        "icons": [icon("icon-192.png", 192), icon("icon-512.png", 512), icon("icon-maskable-512.png", 512, "maskable")],
        "shortcuts": [
            {"name": "Notebooks", "short_name": "Notebooks", "description": "Open your endless pages", "url": "./#/notebooks", "icons": [icon("icon-192.png", 192)]},
            {"name": "Your pages", "short_name": "Pages", "description": "Add a photo or open a page", "url": "./#/", "icons": [icon("icon-192.png", 192)]}],
        # Share a photo to the app from the gallery or camera (Android and desktop Chrome): sw.js keeps it, the app asks before adding it.
        "share_target": {"action": "share-target", "method": "POST", "enctype": "multipart/form-data",
                         "params": {"files": [{"name": "photos", "accept": ["image/*"]}]}},
    }


def bundle_firebase(dest: Path) -> None:
    esbuild = HERE / "node_modules" / ".bin" / "esbuild"
    if not esbuild.exists():
        subprocess.run(["npm", "install", "--no-audit", "--no-fund", "--loglevel=error"], cwd=HERE, check=True)
    dest.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(esbuild), "src/firebase-entry.js", "--bundle", "--format=esm", "--minify", "--target=es2022",
                    "--legal-comments=none", f"--outfile={dest}"], cwd=HERE, check=True, capture_output=True)


def write(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode() if isinstance(data, str) else data)


def build(out: Path, emulator: bool = False, config: Path | None = None) -> list[str]:
    out = out.resolve()   # esbuild runs from another folder
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    firebase = EMULATOR_APP if emulator else json.loads((config or HERE / "web-config.json").read_text())

    write(out / "index.html", app.render_ui(cloud=True))
    write(out / "static" / "noteworthy.css", theme.stylesheet())
    write(out / "static" / "ds.js", (theme.STATIC / "ds.js").read_bytes())
    for font in (theme.STATIC / "fonts").glob("*.woff2"):
        write(out / "static" / "fonts" / font.name, font.read_bytes())
    for name in ("canvas.js", "canvas.css"):
        write(out / "web" / name, (SENSE / "web" / name).read_bytes())
    for js in sorted(WEB.glob("*.js")):
        if not js.name.startswith("sw."):
            write(out / "cloud" / js.name, js.read_bytes())
    bundle_firebase(out / "cloud" / "lib" / "firebase.js")

    for name, px, inset in (("apple-touch-icon.png", 180, 1.0), ("icon-192.png", 192, 1.0), ("icon-512.png", 512, 1.0),
                            ("icon-maskable-512.png", 512, 0.74), ("favicon-32.png", 32, 1.0)):
        write(out / "icons" / name, draw_icon(px, inset))
    write(out / "manifest.webmanifest", json.dumps(manifest(), indent=1))
    # The website reads handwriting with the same instructions, answer shape and prices as the Python (one source for each).
    write(out / "reader.json", json.dumps({"prompt": gemini.PROMPT, "schema": gemini.RESPONSE_SCHEMA, "prices": try_gemini.PRICES, "grid": gemini.GRID}))
    write(out / "config.json", json.dumps({"firebase": firebase, "emulator": EMULATOR if emulator else None}))
    write(out / "theme.json", json.dumps({"threadMarks": [m["svg"] for m in theme._prerendered()["thread_shapes"]], "signOff": theme.sign_off()}))
    write(out / "export-css.json", json.dumps({"themeCss": theme.stylesheet(embed_fonts=True), "shareCss": share.CSS, "canvasCss": canvas.CSS}))

    write(out / ".nojekyll", "")   # GitHub Pages: serve these files as they are
    files = sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file() and p.name != ".nojekyll")
    version = hashlib.sha256(b"".join((out / f).read_bytes() for f in files)).hexdigest()[:12]
    shell = [""] + [f for f in files if f != "index.html"]   # paths from the site's own folder; "" is the page
    write(out / "sw.js", (WEB / "sw.template.js").read_text().replace("__VERSION__", version).replace("__FILES__", json.dumps(shell)))
    return files + ["sw.js"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "public"))
    ap.add_argument("--emulator", action="store_true", help="point at the local Firebase emulators and a made-up project")
    ap.add_argument("--config", help="the web app's Firebase settings (apiKey, authDomain, projectId)")
    a = ap.parse_args(argv)
    files = build(Path(a.out), a.emulator, Path(a.config) if a.config else None)
    print(f"Built {len(files)} files into {a.out}" + ("  (emulator build: never deploy this one)" if a.emulator else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
