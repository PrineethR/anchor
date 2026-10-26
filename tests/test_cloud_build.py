"""The website's build: it works from any folder of a domain, and the real build never points at the emulator."""

import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from sense.cloud import build

ROOT = Path(__file__).resolve().parent.parent


@unittest.skipUnless(shutil.which("node") and shutil.which("npm"), "needs node")
class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls.tmp.name, "anchor", "app")
        cls.files = build.build(cls.out)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def text(self, rel):
        return (self.out / rel).read_text()

    def test_nothing_it_loads_is_addressed_from_the_domain_root(self):
        """`/static/x` would mean prineethr.com/static/x, not prineethr.com/anchor/app/static/x."""
        bad = re.compile(r"""(?:["'`(]|from\s+['"])/(?:static|web|cloud|icons|config|theme|export-css|sw\.js|manifest)""")
        for rel in ["index.html", "manifest.webmanifest", "sw.js", *(p.name and f"cloud/{p.name}" for p in (self.out / "cloud").glob("*.js"))]:
            hits = bad.findall(self.text(rel))
            self.assertEqual(hits, [], f"{rel} reaches for the domain root")
        self.assertNotIn('"/', self.text("manifest.webmanifest").replace('"/*', ""))

    def test_everything_the_page_names_is_in_the_build(self):
        html = self.text("index.html")
        refs = re.findall(r'(?:href|src)="([^"#:${}]+)"', html) + re.findall(r"from '\./([^']+)'", html)   # not the ones the page builds while it runs
        self.assertIn("static/noteworthy.css", refs)
        for ref in refs:
            self.assertTrue((self.out / ref).is_file(), f"index.html names {ref}, which is not in the build")
        for ref in json.loads(self.text("manifest.webmanifest"))["icons"]:
            self.assertTrue((self.out / ref["src"]).is_file())
        names = re.search(r"const FILES = (\[.*?\]);", self.text("sw.js"), re.S).group(1)
        for f in json.loads(names):
            self.assertTrue(f == "" or (self.out / f).is_file(), f"the service worker keeps {f!r}, which is not in the build")

    def test_the_page_is_finished_and_left_alone_by_jekyll(self):
        html = self.text("index.html")
        self.assertNotIn("__CLOUD", html)
        self.assertNotIn("/*__", html)
        self.assertIn('src="cloud/boot.js"', html)
        self.assertTrue((self.out / ".nojekyll").exists())

    def test_the_real_build_points_at_the_real_project_and_never_the_emulator(self):
        cfg = json.loads(self.text("config.json"))
        self.assertIsNone(cfg["emulator"])
        self.assertEqual(cfg["firebase"]["projectId"], "anchor-notes-prineeth")
        self.assertNotIn("__signInAs", self.text("cloud/boot.js").split("if (cfg.emulator)")[0])   # the test sign-in exists only behind the emulator switch

    def test_the_manifest_meets_what_browsers_ask_of_an_installable_app(self):
        import cv2
        from urllib.parse import urljoin
        m = json.loads(self.text("manifest.webmanifest"))
        base = "https://prineethr.com/anchor/app/manifest.webmanifest"
        scope = urljoin(base, m["scope"])
        self.assertEqual(scope, "https://prineethr.com/anchor/app/")
        self.assertTrue(urljoin(base, m["start_url"]).startswith(scope))
        self.assertTrue(m["name"] and m["short_name"] and m["id"])
        self.assertIn(m["display"], ("standalone", "fullscreen", "minimal-ui"))
        sizes = {}
        for icon in m["icons"]:
            img = cv2.imread(str(self.out / icon["src"]))
            self.assertIsNotNone(img, icon["src"])
            self.assertEqual(f"{img.shape[1]}x{img.shape[0]}", icon["sizes"], "the manifest tells the truth about each icon's size")
            sizes.setdefault(icon.get("purpose", "any"), set()).add(img.shape[0])
        self.assertTrue({192, 512} <= sizes["any"], "an icon at 192 and one at 512")
        self.assertIn(512, sizes["maskable"], "a maskable icon, so a phone's round or squircle crop does not clip the mark")
        for sc in m["shortcuts"]:
            self.assertTrue(urljoin(base, sc["url"]).startswith(scope))
        t = m["share_target"]
        self.assertTrue(urljoin(base, t["action"]).startswith(scope))
        self.assertEqual((t["method"], t["enctype"]), ("POST", "multipart/form-data"))
        self.assertEqual(t["params"]["files"][0]["accept"], ["image/*"])
        self.assertIn(f'new URL(\'{t["action"]}\', SCOPE)', self.text("sw.js"), "the service worker answers the address the manifest names")

    def test_the_page_names_its_icons_and_colours_for_light_and_dark(self):
        html = self.text("index.html")
        for needle in ('rel="manifest"', 'rel="apple-touch-icon"', 'rel="icon"', 'name="apple-mobile-web-app-capable"',
                       'name="theme-color" media="(prefers-color-scheme: dark)"', 'name="theme-color" media="(prefers-color-scheme: light)"', "viewport-fit=cover"):
            self.assertIn(needle, html)
        for ref in re.findall(r'<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"', html):
            self.assertTrue((self.out / ref).is_file(), ref)

    def test_a_relative_output_folder_gets_the_whole_site(self):
        """`--out app` from the repository root once lost the Firebase bundle: the bundler runs from another folder."""
        import os
        here = os.getcwd()
        with tempfile.TemporaryDirectory() as td:
            os.chdir(td)
            try:
                build.build(Path("app"))
                self.assertGreater((Path(td) / "app" / "cloud" / "lib" / "firebase.js").stat().st_size, 100_000)
            finally:
                os.chdir(here)

    def test_the_local_app_still_serves_the_same_page_from_its_own_root(self):
        from sense import app
        html = app.render_ui()
        self.assertIn('href="static/noteworthy.css"', html)
        self.assertNotIn("cloud/boot.js", html)
        self.assertNotIn("manifest.webmanifest", html)


if __name__ == "__main__":
    unittest.main()
