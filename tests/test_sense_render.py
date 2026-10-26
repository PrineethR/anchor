import re
import unittest
from datetime import datetime

from sense import canvas, share
from sense.meaning import make_sense


def el(i, text, x, y, w=100, h=40, **kw):
    return {"id": i, "type": "text", "bbox": [x, y, w, h], "text": text, **kw}


PAGE = {
    "page_size": [1000, 500],
    "elements": [
        el("a", "Transition <b>one</b>", 100, 100, underline=True),
        el("b", "core", 500, 100, caps=True),
        {"id": "s", "type": "shape", "bbox": [450, 60, 200, 120], "contains": ["b"]},
        el("c", "Add Luis", 100, 400),
        el("d", "loose", 700, 400),
    ],
    "links": [
        {"id": "l1", "kind": "connector", "from": "a", "to": "b", "label": "TRY TO", "caps": True, "underline": True},
        {"id": "l2", "kind": "hook", "from": "a", "to": "ghost"},
    ],
}


def note(narration=None):
    sense = make_sense(PAGE, ["add"])
    return {"title": "Notes <script>alert(1)</script>", "created": datetime(2026, 10, 25, 12).isoformat(),
            "page": PAGE, "sense": sense, "narration": narration}


class CanvasTests(unittest.TestCase):
    def setUp(self):
        self.lay = canvas.layout(PAGE)

    def test_layout_is_1000_across_with_the_pages_aspect(self):
        self.assertEqual((self.lay["w"], self.lay["h"]), (1000, 500))

    def test_arrow_to_a_missing_element_is_dropped(self):
        self.assertEqual([a["id"] for a in self.lay["arrows"]], ["l1"])

    def test_arrows_leave_one_box_and_stop_short_of_the_next(self):
        a = self.lay["arrows"][0]
        boxes = {b["id"]: b for b in self.lay["boxes"]}
        inside = lambda b, x, y: b["x"] <= x <= b["x"] + b["w"] and b["y"] <= y <= b["y"] + b["h"]
        self.assertFalse(inside(boxes["a"], a["x1"], a["y1"]))
        self.assertFalse(inside(boxes["b"], a["x2"], a["y2"]))
        self.assertGreater(a["x1"], boxes["a"]["x"] + boxes["a"]["w"] - 1)  # leaves a's right edge
        self.assertLess(a["x2"], boxes["b"]["x"] + 1)                       # arrives at b's left edge

    def test_html_escapes_text_and_marks_what_you_marked(self):
        html = canvas.render_html(self.lay)
        self.assertNotIn("<b>one</b>", html)
        self.assertIn("&lt;b&gt;one&lt;/b&gt;", html)
        self.assertIn('class="box u"', html)
        self.assertIn('class="box c"', html)
        self.assertIn('class="alabel u c"', html)
        self.assertEqual(html.count("<line"), 1)
        self.assertEqual(html.count('class="blob"'), 1)

    def test_a_target_inside_the_source_box_leaves_from_the_centre(self):
        lay = canvas.layout({"page_size": [100, 100], "links": [{"id": "l", "kind": "flow", "from": "s", "to": "t"}],
                             "elements": [{"id": "s", "type": "shape", "bbox": [0, 0, 100, 100], "contains": ["t"]},
                                          el("t", "in", 40, 40, 20, 20)]})
        a = lay["arrows"][0]
        self.assertEqual((a["x1"], a["y1"]), (500, 500))  # the shape's centre (layout is 1000 across)


class ShareTests(unittest.TestCase):
    def test_page_is_standalone_and_has_no_live_markup_from_your_text(self):
        html = share.to_html(note())
        self.assertNotIn("<script", html.lower())
        self.assertIn("Notes &lt;script&gt;alert(1)&lt;/script&gt;", html)
        self.assertIn("25 Oct 2026", html)
        self.assertNotRegex(html, r"(src|href)=\"https?://")  # nothing fetched from anywhere

    def test_photo_is_embedded_only_when_given(self):
        self.assertNotIn("data:image", share.to_html(note()))
        with_photo = share.to_html(note(), b"\xff\xd8photo")
        self.assertRegex(with_photo, r"data:image/jpeg;base64,/9hwaG90bw==")

    def test_sections_appear_only_when_they_have_content(self):
        html = share.sense_html(make_sense({"page_size": [10, 10], "elements": [], "links": []}))
        self.assertNotIn("To-dos", html)
        self.assertNotIn("Loose notes", html)
        self.assertIn("No arrows were found", html)

    def test_outline_marks_your_emphasis_and_the_word_on_the_arrow(self):
        html = share.sense_html(note()["sense"])
        self.assertRegex(html, r'<span class="via"><span class="kt"><span class="caps">TRY TO</span></span><svg class="nw-icon via-arrow"')
        self.assertIn("To-dos", html)
        self.assertIn('class="row todo"', html)

    def test_narration_replaces_the_counting_summary(self):
        text = share.to_html(note({"title": "T", "summary": "A real summary."}))
        self.assertIn("A real summary.", text)
        self.assertNotIn("This page has", text)

    def test_markdown(self):
        md = share.to_markdown(note())
        self.assertTrue(md.startswith("# Notes <script>alert(1)</script>\n"))  # plain text, not HTML
        self.assertIn("- [ ] Add Luis", md)
        self.assertIn("_TRY TO_ → core", md)
        self.assertIn("## Loose notes", md)
        self.assertTrue(md.endswith("\n") and not md.endswith("\n\n"))


if __name__ == "__main__":
    unittest.main()
