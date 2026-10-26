"""The app wears the Noteworthy design system: vendored files, one stylesheet, nothing invented."""

import re
import unittest
from pathlib import Path

from sense import canvas, share, theme
from sense.meaning import make_sense

ROOT = Path(__file__).resolve().parent.parent / "sense"


def el(i, text, x, y):
    return {"id": i, "type": "text", "bbox": [x, y, 80, 30], "text": text}


PAGE = {"page_size": [1000, 500], "elements": [el("a", "A", 50, 50), el("b", "B", 300, 50), el("c", "C", 50, 300), el("d", "D", 300, 300)],
        "links": [{"id": "l1", "kind": "flow", "from": "a", "to": "b"}, {"id": "l2", "kind": "connector", "from": "c", "to": "d", "label": "to"}]}


class StylesheetTests(unittest.TestCase):
    def test_it_is_the_systems_tokens_and_components(self):
        css = theme.stylesheet()
        for needle in ("--paper-1:#FBF7F0", "--cobalt:#2063E8", "--highlight:var(--sun)", ".nw-btn--primary", ".nw-sheet", ".nw-seg__opt",
                       ".nw-card--dashed", ".nw-tile--group", ".nw-tabs__item", ".nwi-a-bob"):
            self.assertIn(needle, css)

    def test_dark_follows_the_device_with_the_systems_own_dark_values(self):
        css = theme.stylesheet()
        self.assertEqual(css.count("@media (prefers-color-scheme: dark)"), 1)
        dark = css.split("@media (prefers-color-scheme: dark)")[1]
        self.assertIn(':root:not([data-theme="light"])', dark)
        self.assertIn("--bg-canvas: #141312", dark.replace("--bg-canvas:#141312", "--bg-canvas: #141312"))

    def test_standalone_files_inline_the_four_fonts_they_use(self):
        css = theme.stylesheet(embed_fonts=True)
        self.assertNotIn("url('fonts/", css)
        self.assertEqual(css.count("data:font/woff2;base64,"), 4)
        self.assertNotIn("JetBrainsMono", css)  # the font file is for code only; nothing here is code

    def test_linked_fonts_stay_linked_for_the_app(self):
        css = theme.stylesheet()
        self.assertEqual(len(re.findall(r"url\('fonts/[A-Za-z-]+\.woff2'\)", css)), 5)

    def test_thread_marks_are_the_systems_shapes_and_cycle(self):
        marks = [theme.thread_mark(i) for i in range(6)]
        self.assertEqual(len(set(marks)), 6)
        self.assertTrue(all(m.startswith("<svg") and "nw-shape" in m for m in marks))
        self.assertEqual(theme.thread_mark(6), marks[0])
        self.assertNotIn("sun", " ".join(theme.THREAD_COLORS))  # sun means "you underlined this"
        self.assertIn(".th5{", theme.thread_css())


class ThreadColourTests(unittest.TestCase):
    def setUp(self):
        self.sense = make_sense(PAGE, [])
        self.thread_of = {i: n for n, t in enumerate(self.sense["threads"]) for i in t["ids"]}

    def test_each_thread_lists_its_elements(self):
        self.assertEqual([t["ids"] for t in self.sense["threads"]], [["a", "b"], ["c", "d"]])

    def test_words_and_arrows_wear_their_threads_colour(self):
        lay = canvas.layout(PAGE, self.thread_of)
        html = canvas.render_html(lay)
        self.assertIn('class="box th0"', html)
        self.assertIn('class="box th1"', html)
        self.assertIn('class="alabel th1"', html)
        self.assertEqual([a["thread"] for a in lay["arrows"]], [0, 1])

    def test_cards_carry_the_colour_and_the_shape(self):
        html = share.sense_html(self.sense)
        self.assertIn("nw-card nw-card--raised thread th0", html)
        self.assertIn("nw-card nw-card--raised thread th1", html)
        self.assertIn(theme.thread_mark(0), html)
        self.assertIn(theme.thread_mark(1), html)

    def test_a_thread_card_knows_all_its_elements_so_a_click_can_take_you_there(self):
        html = share.sense_html(self.sense)
        self.assertIn('thread th0" data-ids="a b"', html)
        self.assertIn('thread th1" data-ids="c d"', html)

    def test_words_on_no_thread_sit_on_paper(self):
        page = {**PAGE, "links": []}
        html = canvas.render_html(canvas.layout(page, {}))
        self.assertNotIn(" th0", html)


class NothingInventedTests(unittest.TestCase):
    """The app's own CSS says colour and type only through the system's tokens."""

    def css_of(self):
        ui = (ROOT / "ui.html").read_text()
        style = ui.split("<style>")[1].split("</style>")[0]
        return {"ui.html": style, "share.CSS": share.CSS, "canvas.CSS": canvas.CSS,
                "web/canvas.css": (ROOT / "web" / "canvas.css").read_text(),
                "share.py page": (ROOT / "share.py").read_text().split("<style>{css}")[1].split("</style>")[0]}

    def test_no_raw_colours(self):
        for name, css in self.css_of().items():
            css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
            self.assertEqual(re.findall(r"#[0-9a-fA-F]{3,8}\b", css), [], name)
            self.assertEqual(re.findall(r"\brgba?\(", css), [], name)

    def test_the_editors_script_has_no_raw_colours_either(self):
        js = re.sub(r"//[^\n]*", "", (ROOT / "web" / "canvas.js").read_text())
        self.assertEqual(re.findall(r"#[0-9a-fA-F]{3,8}\b", js), [])
        self.assertEqual(re.findall(r"\brgba?\(", js), [])
        self.assertNotRegex(js, r"font-family\s*:\s*['\"]?(Georgia|Helvetica|Arial)")

    def test_no_font_names_outside_the_tokens(self):
        for name, css in self.css_of().items():
            for decl in re.findall(r"font(?:-family)?\s*:[^;}]*", css):
                for fam in ("Georgia", "Helvetica", "Arial", "system-ui", "monospace", "Times", "Courier", "Menlo", "Palatino"):
                    self.assertNotIn(fam, decl, f"{name}: {decl}")

    def test_no_emoji_or_symbols_as_icons_in_the_ui(self):
        ui = (ROOT / "ui.html").read_text() + share.CSS + canvas.CSS
        self.assertEqual(re.findall(r"[←-⇿☀-➿⬀-⯿\U0001F300-\U0001FAFF]", ui), [])


if __name__ == "__main__":
    unittest.main()
