"""The Board's server side: the object schema, the store on disk, link cards, the live hub and the HTTP API.

The editor (sense/web/board) is covered in the browser by tests/e2e/board.mjs; templates.json by test_board_templates.py.
Everything here runs against a throwaway home directory and 127.0.0.1 only. Nothing is launched, nothing leaves the machine.
"""
import base64
import http.client
import http.server
import io
import itertools
import json
import os
import re
import socket
import subprocess
import tempfile
import threading
import shutil
import types
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from unittest import mock

from sense import app
from sense.board import api, hub, links, schema, store
from sense.board.store import Boards, NotFound

ROOT = Path(__file__).resolve().parent.parent
GHOST = "20200101-000000-aaaa"   # a well-formed id nobody made
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 24


def sticky(i, **kw):
    return {"id": i, "type": "sticky", "x": 0, "y": 0, **kw}


def box(i, kind="shape", **kw):
    return {"id": i, "type": kind, "x": 0, "y": 0, "w": 100, "h": 60, **kw}


def wire(i, a, b, **kw):
    return {"id": i, "type": "connector", "from": a, "to": b, **kw}


def clock():
    """A `now()` that ticks one second per call, so ordering by time is deterministic."""
    n = itertools.count()

    def now():
        k = next(n)
        return f"2026-01-01T{k // 3600:02d}:{k // 60 % 60:02d}:{k % 60:02d}"
    return now


def ids(objs):
    return [o["id"] for o in objs]


# --- schema ----------------------------------------------------------------------------------------------------------

BASE = {"id", "type", "x", "y", "w", "h"}
FLAGS = {"locked", "parent", "group"}
FIELDS = {
    "sticky": {"text", "text_style", "color"}, "text": {"text", "text_style", "fill", "minh"},
    "shape": {"text", "text_style", "fill", "shape", "stroke", "stroke_width", "dash"},
    "frame": {"fill", "title"}, "node": {"text", "text_style", "fill", "mm"},
    "connector": {"from", "to", "shape", "start_head", "end_head", "color", "width", "dash", "label", "text_style"},
    "draw": {"tool", "color", "width", "points"},
    "image": {"src", "name", "size", "mime"}, "file": {"src", "name", "size", "mime"},
    "link": {"url", "title", "desc", "host"},
}
# Every field of every type at once, plus some that no type has: what is left says what the type owns.
SINK = {"id": "o1", "x": 1, "y": 2, "w": 30, "h": 40, "locked": True, "parent": "f1", "group": "g1", "by": "someone", "minh": 90,
        "text": "t", "text_style": {"bold": True}, "color": "red", "fill": "#112233", "stroke": "#445566", "stroke_width": 3,
        "shape": "ellipse", "dash": "dashed", "title": "ti", "mm": {"parent": "p", "side": "left"}, "from": {"x": 1, "y": 1},
        "to": {"x": 2, "y": 2}, "start_head": "bar", "end_head": "bar", "width": 3, "label": "l", "tool": "pen", "points": [1, 2, 3],
        "src": "a.png", "name": "n", "size": 5, "mime": "image/png", "url": "https://example.com", "desc": "d", "host": "h",
        "favicon": "../bad", "thumb": "bad/er", "evil": 1, "onclick": "x()", "__proto__": {"a": 1}}


class CleanObjectTests(unittest.TestCase):
    def test_each_type_gets_its_defaults(self):
        expect = {
            "sticky": {"w": 180, "h": 180, "text": "", "color": "light_yellow"},
            "text": {"w": 240, "h": 40, "text": "", "fill": None},
            "shape": {"w": 160, "h": 110, "text": "", "fill": None, "shape": "rect", "stroke": None, "stroke_width": 2, "dash": "solid"},
            "frame": {"w": 640, "h": 420, "fill": None, "title": ""},
            "node": {"w": 160, "h": 48, "text": "", "fill": None, "mm": {"parent": "", "collapsed": False, "side": "right"}},
            "connector": {"w": 0, "h": 0, "from": {"x": 0, "y": 0}, "to": {"x": 9, "y": 9}, "shape": "straight", "start_head": "none",
                          "end_head": "arrow", "color": None, "width": 2, "dash": "solid", "label": ""},
            "draw": {"w": 10, "h": 10, "tool": "pen", "color": "#1A1A1A", "width": 4, "points": []},
            "image": {"w": 320, "h": 240, "src": "a.png", "name": "", "size": 0, "mime": ""},
            "file": {"w": 240, "h": 76, "src": "a.pdf", "name": "", "size": 0, "mime": ""},
            "link": {"w": 300, "h": 220, "url": "https://example.com", "title": "", "desc": "", "host": ""},
        }
        needs = {"connector": {"from": {"x": 0, "y": 0}, "to": {"x": 9, "y": 9}}, "draw": {"points": []}, "image": {"src": "a.png"},
                 "file": {"src": "a.pdf"}, "link": {"url": "https://example.com"}}
        self.assertEqual(set(expect), set(schema.TYPES))
        for t, want in expect.items():
            with self.subTest(type=t):
                self.assertEqual(schema.clean_object({"id": "o", "type": t, **needs.get(t, {})}),
                                 {"id": "o", "type": t, "x": 0, "y": 0, **want})

    def test_unknown_fields_are_dropped_and_each_type_keeps_only_its_own(self):
        for t, own in FIELDS.items():
            with self.subTest(type=t):
                self.assertEqual(set(schema.clean_object({**SINK, "type": t})), BASE | FLAGS | own)

    def test_a_bad_type_is_refused(self):
        for raw in (None, "sticky", [], 5, {"id": "a"}, {"id": "a", "type": "banana"}, {"id": "a", "type": None}, {"id": "a", "type": ["sticky"]}):
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, "known kind"):
                schema.clean_object(raw)

    def test_a_bad_id_is_refused(self):
        for bad in (None, 5, "", "a b", "a/b", "../x", "x" * 41, "é", "a\nb", ["a"]):
            with self.subTest(id=bad), self.assertRaisesRegex(ValueError, "id"):
                schema.clean_object({"type": "sticky", "id": bad})
        self.assertEqual(schema.clean_object({"type": "sticky", "id": "x" * 40, "text": "ok"})["id"], "x" * 40)
        self.assertEqual(schema.clean_object({"type": "sticky", "id": "A_b-9"})["id"], "A_b-9")

    def test_a_connector_needs_two_usable_ends(self):
        free, glued = {"x": 1, "y": 2}, {"id": "a"}
        for a, b in ((None, free), (free, None), ({"x": 1}, free), (free, {"y": 1}), ({"id": "bad id"}, free), (free, {"id": 5}), ("a", "b"), ([], {})):
            with self.subTest(a=a, b=b), self.assertRaisesRegex(ValueError, "two ends"):
                schema.clean_object(wire("c", a, b))
        self.assertEqual(schema.clean_object(wire("c", glued, free))["from"], {"id": "a", "side": "auto"})

    def test_connector_ends_are_normalised(self):
        c = schema.clean_object(wire("c", {"id": "a", "side": "zzz", "t": 9}, {"id": "b", "side": "l", "t": -3}))
        self.assertEqual((c["from"], c["to"]), ({"id": "a", "side": "auto", "t": 1.0}, {"id": "b", "side": "l", "t": 0.0}))
        c = schema.clean_object(wire("c", {"x": "12.346", "y": "bad"}, {"id": "b", "x": 5, "y": 5}))
        self.assertEqual(c["from"], {"x": 12.35, "y": 0.0})
        self.assertEqual(c["to"], {"id": "b", "side": "auto"})   # an id wins over a point

    def test_connector_options_fall_back(self):
        c = schema.clean_object(wire("c", {"x": 0, "y": 0}, {"x": 1, "y": 1}, shape="zig", start_head="x", end_head="y", dash="z", color="red", auto="mm"))
        self.assertEqual((c["shape"], c["start_head"], c["end_head"], c["dash"], c["color"], c["auto"]), ("straight", "none", "arrow", "solid", None, "mm"))
        self.assertNotIn("auto", schema.clean_object(wire("c", {"x": 0, "y": 0}, {"x": 1, "y": 1}, auto="other")))

    def test_a_drawing_is_a_list_of_triples(self):
        draw = lambda pts: {"id": "d", "type": "draw", "points": pts}
        for bad in (None, "abc", {}, [1], [1, 2], [1, 2, 3, 4], [1] * 5):
            with self.subTest(points=bad), self.assertRaisesRegex(ValueError, "triples"):
                schema.clean_object(draw(bad))
        self.assertEqual(schema.clean_object(draw([]))["points"], [])
        self.assertEqual(schema.clean_object(draw([1, 2, 0.5, "x", None, 9e99]))["points"], [1, 2, 0.5, 0, 0, schema.BOUND])
        self.assertEqual(len(schema.clean_object(draw([0] * schema.MAX_POINTS))["points"]), schema.MAX_POINTS)
        with self.assertRaisesRegex(ValueError, "triples"):
            schema.clean_object(draw([0] * (schema.MAX_POINTS + 3)))

    def test_a_link_needs_an_http_or_https_address(self):
        link = lambda url: {"id": "l", "type": "link", "url": url}
        for bad in ("", None, "javascript:alert(1)", "ftp://example.com", "file:///etc/passwd", "data:text/html,x", "//example.com",
                    "example.com", " https://example.com", "httpx://example.com", "http:/example.com"):
            with self.subTest(url=bad), self.assertRaisesRegex(ValueError, "http"):
                schema.clean_object(link(bad))
        for good in ("http://example.com", "https://example.com/a?b=1#c", "HTTP://EXAMPLE.COM"):
            self.assertEqual(schema.clean_object(link(good))["url"], good)

    def test_a_picture_or_file_must_point_at_a_plain_asset_name(self):
        for t in ("image", "file"):
            for bad in (None, "", "../x.png", "a/b.png", "/etc/passwd", ".hidden", "a\\b.png", "x" * 121, "a%2fb.png", "a\nb.png", 5):
                with self.subTest(type=t, src=bad), self.assertRaisesRegex(ValueError, "isn't allowed"):
                    schema.clean_object({"id": "i", "type": t, "src": bad})
            for good in ("abc123.png", "my pic (1).png", "a+b,c-d_e.pdf", "x" * 120):
                self.assertEqual(schema.clean_object({"id": "i", "type": t, "src": good})["src"], good)

    def test_link_pictures_are_dropped_when_not_allowed_but_the_link_stays(self):
        o = schema.clean_object({"id": "l", "type": "link", "url": "https://e.com", "favicon": "../f.png", "thumb": "t.png"})
        self.assertNotIn("favicon", o)
        self.assertEqual(o["thumb"], "t.png")

    def test_text_and_numbers_are_capped(self):
        long = lambda n: "x" * (n + 50)
        self.assertEqual(len(schema.clean_object(sticky("s", text=long(schema.MAX_TEXT)))["text"]), schema.MAX_TEXT)
        self.assertEqual(len(schema.clean_object({"id": "f", "type": "frame", "title": long(200)})["title"]), 200)
        self.assertEqual(len(schema.clean_object(wire("c", {"x": 0, "y": 0}, {"x": 1, "y": 1}, label=long(500)))["label"]), 500)
        link = schema.clean_object({"id": "l", "type": "link", "url": "https://" + long(2000), "title": long(300), "desc": long(600), "host": long(255)})
        self.assertEqual((len(link["url"]), len(link["title"]), len(link["desc"]), len(link["host"])), (2000, 300, 600, 255))
        img = schema.clean_object({"id": "i", "type": "image", "src": "a.png", "name": long(255), "mime": long(255), "size": 10 ** 18})
        self.assertEqual((len(img["name"]), len(img["mime"]), img["size"]), (255, 255, 2 ** 40))
        for size in (-5, "abc", None, float("nan")):
            self.assertEqual(schema.clean_object({"id": "i", "type": "image", "src": "a.png", "size": size})["size"], 0)
        self.assertEqual(schema.clean_object(sticky("s", text=5))["text"], "5")
        self.assertEqual(schema.clean_object(sticky("s", text=None))["text"], "")

    def test_positions_and_sizes_are_clamped_and_rounded(self):
        B = schema.BOUND
        o = schema.clean_object(sticky("s", x=1e12, y=-1e12, w=1e12, h=1.23456))
        self.assertEqual((o["x"], o["y"], o["w"], o["h"]), (B, -B, B, 4.0))
        o = schema.clean_object(sticky("s", x="abc", y=float("inf"), w=float("nan"), h=None))
        self.assertEqual((o["x"], o["y"], o["w"], o["h"]), (0, 0, 180, 180))   # not numbers: the defaults
        self.assertEqual(schema.clean_object(sticky("s", x=1.005, y=2.499))["y"], 2.5)
        for kind in ("sticky", "text", "frame", "shape", "image"):
            extra = {"src": "a.png"} if kind == "image" else {}
            o = schema.clean_object({"id": "o", "type": kind, "w": 0, "h": -50, **extra})
            self.assertEqual((o["w"], o["h"]), (4.0, 4.0), kind)   # something you can still grab
        c = schema.clean_object(wire("c", {"x": 0, "y": 0}, {"x": 1, "y": 1}, w=0, h=0))
        self.assertEqual((c["w"], c["h"]), (0, 0))   # a connector's box is only a record
        self.assertEqual(schema.clean_object({"id": "d", "type": "draw", "points": [], "w": 0, "h": 0})["w"], 0)

    def test_widths_and_sizes_have_limits(self):
        shape = lambda **kw: schema.clean_object({"id": "s", "type": "shape", **kw})
        self.assertEqual((shape(stroke_width=100)["stroke_width"], shape(stroke_width=-5)["stroke_width"], shape(stroke_width="x")["stroke_width"]), (40, 0, 2))
        wid = lambda w: schema.clean_object(wire("c", {"x": 0, "y": 0}, {"x": 1, "y": 1}, width=w))["width"]
        self.assertEqual((wid(0), wid(100), wid("x")), (0.5, 40, 2))
        pen = lambda w: schema.clean_object({"id": "d", "type": "draw", "points": [], "width": w})["width"]
        self.assertEqual((pen(0), pen(1000)), (0.5, 200))
        size = lambda s: schema.clean_object(sticky("s", text_style={"size": s})).get("text_style")
        self.assertEqual((size(1), size(1000), size("auto"), size(14.5)), ({"size": 6}, {"size": 400}, {"size": "auto"}, {"size": 14.5}))
        self.assertEqual(size(float("nan")), {"size": 16})
        for bad in (True, "big", None, [], {}):
            self.assertIsNone(size(bad), bad)

    def test_fills_and_strokes_must_be_hex_colours(self):
        fill = lambda v: schema.clean_object({"id": "s", "type": "shape", "fill": v, "stroke": v})
        for good in ("#abc", "#AABBCC", "#aabbccdd"):
            self.assertEqual((fill(good)["fill"], fill(good)["stroke"]), (good, good))
        for bad in ("red", "abc", "#ab", "#abcd", "#abcde", "#ggg", "#abc;x", "url(#a)", "rgb(0,0,0)", "", None, 5):
            self.assertEqual((fill(bad)["fill"], fill(bad)["stroke"]), (None, None), bad)

    def test_text_style_is_cleaned(self):
        ts = lambda raw: schema.clean_object(sticky("s", text_style=raw)).get("text_style")
        self.assertEqual(ts({"bold": 1, "italic": 0, "underline": "x", "align": "center", "color": "#123456"}),
                         {"bold": True, "italic": False, "underline": True, "align": "center", "color": "#123456"})
        self.assertEqual(ts({"align": "justify", "color": "blue"}), {"color": None})   # a bad colour is "none", a bad align is dropped
        for empty in (None, {}, [], "bold", {"align": "nope"}, {"size": "huge"}):
            self.assertIsNone(ts(empty), empty)

    def test_flags_keep_only_valid_references(self):
        o = schema.clean_object(sticky("s", locked=1, parent="bad id", group="g", by="someone"))
        self.assertEqual((o["locked"], o["group"], "parent" in o, "by" in o), (True, "g", False, False))
        self.assertNotIn("locked", schema.clean_object(sticky("s", locked=0)))
        self.assertNotIn("locked", schema.clean_object(sticky("s", locked="")))

    def test_sticky_colour_must_be_a_known_name(self):
        for bad in ("nope", "#F5D128", None, 5, "RED"):
            self.assertEqual(schema.clean_object(sticky("s", color=bad))["color"], "light_yellow", bad)
        for k in schema.STICKY:
            self.assertEqual(schema.clean_object(sticky("s", color=k))["color"], k)

    def test_shape_options_fall_back(self):
        o = schema.clean_object({"id": "s", "type": "shape", "shape": "blob", "dash": "wavy"})
        self.assertEqual((o["shape"], o["dash"]), ("rect", "solid"))
        for s in schema.SHAPES:
            self.assertEqual(schema.clean_object({"id": "s", "type": "shape", "shape": s})["shape"], s)

    def test_a_mind_map_node_keeps_a_valid_parent_and_side(self):
        node = lambda mm: schema.clean_object({"id": "n", "type": "node", "mm": mm})["mm"]
        self.assertEqual(node({"parent": "root", "collapsed": 1, "side": "left"}), {"parent": "root", "collapsed": True, "side": "left"})
        self.assertEqual(node({"parent": "bad id", "side": "up"}), {"parent": "", "collapsed": False, "side": "right"})
        for junk in (None, "x", [], 5):
            self.assertEqual(node(junk), {"parent": "", "collapsed": False, "side": "right"})

    def test_clean_objects_checks_the_whole_list(self):
        with self.assertRaisesRegex(ValueError, "share an id"):
            schema.clean_objects([sticky("a"), sticky("b"), sticky("a")])
        for bad in (None, {}, "abc", 5):
            with self.assertRaisesRegex(ValueError, "too many"):
                schema.clean_objects(bad)
        with mock.patch.object(schema, "MAX_OBJECTS", 3):
            self.assertEqual(len(schema.clean_objects([sticky(f"s{i}") for i in range(3)])), 3)
            with self.assertRaisesRegex(ValueError, "too many"):
                schema.clean_objects([sticky(f"s{i}") for i in range(4)])
        out = schema.clean_objects([sticky("b"), sticky("a")])
        self.assertEqual(ids(out), ["b", "a"])   # the order is the z-order: kept


class PaletteTests(unittest.TestCase):
    """The browser draws stickies from palette.js, the server thumbnails them from schema.STICKY: one palette, two copies."""

    JS = (ROOT / "sense" / "web" / "board" / "palette.js").read_text()

    def test_sticky_colours_match_the_editors_palette_exactly(self):
        block = re.search(r"export const STICKY = \{(.*?)\};", self.JS, re.S)
        self.assertTrue(block, "palette.js no longer exports STICKY in the shape this test reads")
        js = re.findall(r"(\w+):\s*'(#[0-9A-Fa-f]{6})'", block.group(1))
        self.assertEqual(len(js), 16)
        self.assertEqual([(k, v.lower()) for k, v in js], [(k, v.lower()) for k, v in schema.STICKY.items()])   # same names, colours, order (the order is the picker's)

    def test_the_default_sticky_colour_matches(self):
        js = re.search(r"STICKY_DEFAULT = '(\w+)'", self.JS).group(1)
        self.assertEqual(js, schema.clean_object(sticky("s", color="nope"))["color"])
        self.assertIn(js, schema.STICKY)


class TidyTests(unittest.TestCase):
    def tidy(self, *objs):
        return {o["id"]: o for o in schema.tidy(schema.clean_objects(list(objs)))}

    def test_a_parent_must_be_a_frame_that_exists_and_not_the_object_itself(self):
        out = self.tidy(box("f", "frame"), sticky("in", parent="f"), sticky("gone", parent="nothing"), sticky("onsticky", parent="in"),
                        {**box("self", "frame"), "parent": "self"})
        self.assertEqual(out["in"]["parent"], "f")
        for i in ("gone", "onsticky", "self"):
            self.assertNotIn("parent", out[i], i)

    def test_a_group_of_one_is_not_a_group(self):
        out = self.tidy(sticky("a", group="g1"), sticky("b", group="g1"), sticky("c", group="g2"))
        self.assertEqual((out["a"]["group"], out["b"]["group"]), ("g1", "g1"))
        self.assertNotIn("group", out["c"])

    def test_a_mind_map_parent_that_is_gone_is_cleared(self):
        node = lambda i, parent: {"id": i, "type": "node", "mm": {"parent": parent}}
        out = self.tidy(node("root", ""), node("kid", "root"), node("orphan", "deleted"))
        self.assertEqual((out["kid"]["mm"]["parent"], out["orphan"]["mm"]["parent"]), ("root", ""))

    def test_a_connector_to_a_missing_object_keeps_a_free_end_where_the_box_says(self):
        c = {**wire("c", {"id": "gone"}, {"id": "also-gone"}), "x": 10, "y": 20, "w": 100, "h": 50}
        out = self.tidy(sticky("a"), c)["c"]
        self.assertEqual((out["from"], out["to"]), ({"x": 10, "y": 20}, {"x": 110, "y": 70}))

    def test_a_connector_to_a_present_object_is_left_alone(self):
        out = self.tidy(sticky("a"), sticky("b"), wire("c", {"id": "a", "side": "r"}, {"id": "b", "t": 0.25}), wire("d", {"x": 1, "y": 2}, {"id": "gone"}))
        self.assertEqual((out["c"]["from"], out["c"]["to"]), ({"id": "a", "side": "r"}, {"id": "b", "side": "auto", "t": 0.25}))
        self.assertEqual(out["d"]["from"], {"x": 1, "y": 2})
        self.assertNotIn("id", out["d"]["to"])

    def test_it_changes_the_list_in_place_and_returns_it(self):
        objs = schema.clean_objects([sticky("a", group="g")])
        self.assertIs(schema.tidy(objs), objs)
        self.assertNotIn("group", objs[0])


# --- the store -------------------------------------------------------------------------------------------------------

class StoreCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        self.bs = Boards(self.home)

    def file(self, bid, *rest):
        return self.home / "boards" / bid / Path(*rest)

    def make(self, title="T", objects=None):
        return self.bs.create(title, objects)

    def asset(self, bid, name, data=b"data"):
        a = self.bs.add_asset(bid, data, name, "", keep_name=True)
        return a["src"]


class BoardsListTests(StoreCase):
    def test_create_writes_one_folder_with_a_board_file(self):
        b = self.make("  Roadmap  ")
        self.assertRegex(b["id"], schema.ID)
        self.assertEqual((b["title"], b["rev"], b["format"], b["version"], b["objects"], b["view"]),
                         ("Roadmap", 1, "anchor-board", 1, [], {"x": 0.0, "y": 0.0, "z": 1.0}))
        self.assertEqual(json.loads(self.file(b["id"], "board.json").read_text()), b)
        self.assertEqual(self.bs.load(b["id"]), b)

    def test_create_titles(self):
        self.assertEqual([self.make(t)["title"] for t in ("", "   ", None)], ["Untitled board"] * 3)
        self.assertEqual(len(self.make("x" * 300)["title"]), 120)

    def test_create_with_objects_cleans_and_tidies_them(self):
        b = self.make("T", [sticky("a", group="solo", junk=1), wire("c", {"id": "a"}, {"id": "nowhere"})])
        self.assertNotIn("group", b["objects"][0])
        self.assertNotIn("junk", b["objects"][0])
        self.assertNotIn("id", b["objects"][1]["to"])

    def test_create_with_a_bad_object_writes_nothing(self):
        with self.assertRaises(ValueError):
            self.make("T", [sticky("a"), {"id": "b", "type": "nope"}])
        self.assertEqual(self.bs.list(), [])
        self.assertEqual([p for p in (self.home / "boards").iterdir() if p.name[0] != "."], [])

    def test_list_is_newest_first_and_each_row_is_a_summary(self):
        with mock.patch.object(store, "now", clock()):
            a, b = self.make("first"), self.make("second", [box("f", "frame"), sticky("s")])
            self.bs.save(a["id"], {"upsert": [sticky("x")]})    # touched last: now the newest
        rows = self.bs.list()
        self.assertEqual([r["title"] for r in rows], ["first", "second"])
        self.assertEqual(set(rows[1]), {"id", "title", "created", "updated", "rev", "objects", "frames", "thumb"})
        self.assertEqual((rows[1]["objects"], rows[1]["frames"], rows[1]["rev"]), (2, 1, 1))
        self.assertEqual((rows[0]["objects"], rows[0]["rev"]), (1, 2))
        self.assertTrue(rows[1]["thumb"].startswith("<svg"))
        self.make("empty")
        self.assertEqual([r["thumb"] for r in self.bs.list("empty")], [""])      # nothing to draw yet

    def test_search_matches_part_of_a_title_ignoring_case(self):
        for t in ("Q3 Roadmap", "Retro notes", "roadmap archive"):
            self.make(t)
        self.assertEqual(sorted(r["title"] for r in self.bs.list("ROADMAP")), ["Q3 Roadmap", "roadmap archive"])
        self.assertEqual([r["title"] for r in self.bs.list("  retro ")], ["Retro notes"])
        self.assertEqual(self.bs.list("zzz"), [])
        self.assertEqual(len(self.bs.list("")), 3)
        self.assertEqual(self.bs.list("notes archive"), [])   # a phrase, not words

    def test_list_skips_what_is_not_a_board(self):
        good = self.make("good")
        bad = self.make("bad")
        self.file(bad["id"], "board.json").write_text("{not json")
        (self.home / "boards" / "stray-folder").mkdir()
        (self.home / "boards" / "readme.txt").write_text("hi")
        self.make("trashed")
        self.bs.delete(self.bs.list("trashed")[0]["id"])
        self.assertEqual([r["id"] for r in self.bs.list()], [good["id"]])

    def test_rename(self):
        b = self.make("old")
        out = self.bs.rename(b["id"], "  New name ")
        self.assertEqual((self.bs.load(b["id"])["title"], out["rev"]), ("New name", 2))
        self.bs.rename(b["id"], "   ")   # blank: keeps what it had
        self.assertEqual(self.bs.load(b["id"])["title"], "New name")
        self.bs.rename(b["id"], "y" * 500)
        self.assertEqual(len(self.bs.load(b["id"])["title"]), 120)


class BoardsLifecycleTests(StoreCase):
    def test_duplicate_copies_the_board_and_its_files_independently(self):
        b = self.make("Plan", [sticky("a", text="hi"), box("i", "image", src="pic.png")])
        self.asset(b["id"], "pic.png", PNG)
        self.bs.save(b["id"], {"view": {"x": 5, "y": 6, "z": 2}})
        orig = self.bs.load(b["id"])
        d = self.bs.duplicate(b["id"])
        self.assertNotEqual(d["id"], b["id"])
        self.assertEqual((d["title"], d["rev"]), ("Plan (copy)", 1))
        self.assertEqual((d["objects"], d["view"]), (orig["objects"], orig["view"]))
        self.assertEqual(self.bs.load(d["id"]), d)
        self.assertEqual(self.file(d["id"], "assets", "pic.png").read_bytes(), PNG)
        self.file(d["id"], "assets", "pic.png").write_bytes(b"changed")     # the copy is its own
        self.assertEqual(self.file(b["id"], "assets", "pic.png").read_bytes(), PNG)
        self.bs.save(d["id"], {"delete": ["a"]})
        self.assertEqual(ids(self.bs.load(b["id"])["objects"]), ["a", "i"])
        self.assertEqual(self.bs.load(b["id"])["rev"], orig["rev"])
        self.assertEqual(self.bs.duplicate(d["id"])["title"], "Plan (copy) (copy)")

    def test_duplicate_keeps_titles_within_the_limit_and_works_without_assets(self):
        b = self.make("z" * 120)
        d = self.bs.duplicate(b["id"])
        self.assertEqual(len(d["title"]), 120)
        self.assertFalse(self.file(d["id"], "assets").exists())
        with self.assertRaises(NotFound):
            self.bs.duplicate(GHOST)

    def test_delete_goes_to_the_trash_and_restore_brings_everything_back(self):
        b = self.make("keep me", [sticky("a")])
        self.asset(b["id"], "f.txt", b"abc")
        self.bs.delete(b["id"])
        self.assertEqual(self.bs.list(), [])
        with self.assertRaises(NotFound):
            self.bs.load(b["id"])
        t = self.bs.trashed()
        self.assertEqual([(r["id"], r["title"]) for r in t], [(b["id"], "keep me")])
        self.assertRegex(t[0]["trashed"], r"^\d{4}-\d\d-\d\dT")
        self.assertTrue((self.home / "boards" / ".trash" / b["id"] / "assets" / "f.txt").is_file())   # nothing is erased
        back = self.bs.restore(b["id"])
        self.assertEqual(back, b)
        self.assertEqual(self.file(b["id"], "assets", "f.txt").read_bytes(), b"abc")
        self.assertFalse(self.file(b["id"], "trashed.json").exists())
        self.assertEqual((self.bs.trashed(), [r["id"] for r in self.bs.list()]), ([], [b["id"]]))

    def test_the_trash_lists_the_latest_first(self):
        with mock.patch.object(store, "now", clock()):
            a, b = self.make("a"), self.make("b")
            self.bs.delete(a["id"])
            self.bs.delete(b["id"])
        self.assertEqual([r["title"] for r in self.bs.trashed()], ["b", "a"])

    def test_only_a_trashed_board_can_be_restored_or_purged(self):
        b = self.make()
        for fn in (self.bs.restore, self.bs.purge):
            with self.assertRaises(NotFound):
                fn(b["id"])
        self.assertEqual(len(self.bs.list()), 1)    # purge on a live board must not touch it
        self.bs.delete(b["id"])
        with self.assertRaises(NotFound):
            self.bs.delete(b["id"])

    def test_purge_erases_for_good(self):
        b = self.make()
        self.asset(b["id"], "f.txt")
        self.bs.delete(b["id"])
        self.bs.purge(b["id"])
        self.assertFalse((self.home / "boards" / ".trash" / b["id"]).exists())
        self.assertEqual(self.bs.trashed(), [])
        with self.assertRaises(NotFound):
            self.bs.restore(b["id"])

    def test_restore_refuses_to_overwrite_a_board_with_the_same_id(self):
        b = self.make("one")
        self.bs.delete(b["id"])
        self.bs.restore(b["id"])
        self.bs.delete(b["id"])
        shutil.copytree(self.home / "boards" / ".trash" / b["id"], self.file(b["id"]))   # same id came back some other way
        with self.assertRaisesRegex(ValueError, "already there"):
            self.bs.restore(b["id"])
        self.assertEqual(len(self.bs.trashed()), 1)

    def test_a_second_delete_of_the_same_id_replaces_the_trashed_copy(self):
        b = self.make("v1")
        self.bs.delete(b["id"])
        shutil.copytree(self.home / "boards" / ".trash" / b["id"], self.file(b["id"]))
        self.bs.rename(b["id"], "v2")
        self.bs.delete(b["id"])
        self.assertEqual([r["title"] for r in self.bs.trashed()], ["v2"])

    def test_bad_ids_never_reach_the_disk(self):
        for bad in ("../x", "..", "", "20200101-000000-AAAA", "x" * 30, "20200101-000000-aaaa/..", GHOST):
            for fn in (self.bs.load, self.bs.duplicate, self.bs.delete, self.bs.export, lambda i: self.bs.save(i, {}), self.bs.asset_dir):
                with self.subTest(id=bad), self.assertRaises(NotFound):
                    fn(bad)


class SaveTests(StoreCase):
    def setUp(self):
        super().setUp()
        self.b = self.make("T")
        self.id = self.b["id"]

    def objs(self):
        return self.bs.load(self.id)["objects"]

    def test_upsert_adds_to_the_end_and_replaces_in_place(self):
        out = self.bs.save(self.id, {"upsert": [sticky("a", text="1"), sticky("b")]})
        self.bs.save(self.id, {"upsert": [sticky("c")]})
        self.assertEqual(ids(self.objs()), ["a", "b", "c"])
        self.bs.save(self.id, {"upsert": [sticky("a", text="changed")]})
        self.assertEqual(ids(self.objs()), ["a", "b", "c"])    # same z position
        self.assertEqual(self.objs()[0]["text"], "changed")
        self.assertEqual(ids(out["upsert"]), ["a", "b"])

    def test_what_comes_back_is_what_was_kept_and_what_was_removed(self):
        self.bs.save(self.id, {"upsert": [sticky("a")]})
        out = self.bs.save(self.id, {"upsert": [sticky("n", text="x" * 20000, junk=1)], "delete": ["a", "never-there", 5, None]})
        self.assertEqual(out["delete"], ["a"])
        self.assertEqual(len(out["upsert"][0]["text"]), schema.MAX_TEXT)
        self.assertNotIn("junk", out["upsert"][0])
        self.assertEqual(set(out), {"rev", "updated", "upsert", "delete"})

    def test_delete_removes_and_tidies_what_pointed_at_it(self):
        self.bs.save(self.id, {"upsert": [box("f", "frame", x=0, y=0), sticky("in", parent="f"), sticky("a", x=40, y=50), wire("c", {"id": "a"}, {"id": "in"}, x=1, y=2, w=3, h=4)]})
        self.bs.save(self.id, {"delete": ["f", "a"]})
        left = {o["id"]: o for o in self.objs()}
        self.assertEqual(set(left), {"in", "c"})
        self.assertNotIn("parent", left["in"])
        self.assertEqual((left["c"]["from"], left["c"]["to"]), ({"x": 1, "y": 2}, {"id": "in", "side": "auto"}))

    def test_order_sets_the_z_order(self):
        self.bs.save(self.id, {"upsert": [sticky("a"), sticky("b"), sticky("c"), sticky("d")]})
        self.bs.save(self.id, {"order": ["c", "a", "ghost", "b", 7]})   # unknown and non-string ids are ignored; d was not named
        self.assertEqual(ids(self.objs()), ["c", "a", "b", "d"])
        self.bs.save(self.id, {"order": []})
        self.assertEqual(ids(self.objs()), ["c", "a", "b", "d"])
        self.bs.save(self.id, {"order": "dcba"})    # not a list: ignored
        self.assertEqual(ids(self.objs()), ["c", "a", "b", "d"])

    def test_order_applies_after_the_upserts_in_the_same_patch(self):
        self.bs.save(self.id, {"upsert": [sticky("a"), sticky("b")]})
        self.bs.save(self.id, {"upsert": [sticky("c")], "order": ["c", "b", "a"]})
        self.assertEqual(ids(self.objs()), ["c", "b", "a"])

    def test_rev_goes_up_by_one_with_every_save_and_updated_moves(self):
        with mock.patch.object(store, "now", clock()):
            bid = self.make("clocked")["id"]
            revs = [self.bs.save(bid, p)["rev"] for p in ({}, {"title": "x"}, {"upsert": [sticky("a")]}, {"delete": ["a"]})]
            b = self.bs.load(bid)
        self.assertEqual(revs, [2, 3, 4, 5])
        self.assertEqual(b["rev"], 5)
        self.assertGreater(b["updated"], b["created"])

    def test_view_is_stored_and_clamped(self):
        self.bs.save(self.id, {"view": {"x": 123.456, "y": -9, "z": 2.5}})
        self.assertEqual(self.bs.load(self.id)["view"], {"x": 123.46, "y": -9, "z": 2.5})
        for z, want in ((0, 0.02), (100, 4), ("x", 1.0), (None, 1.0)):
            self.bs.save(self.id, {"view": {"x": 0, "y": 0, "z": z}})
            self.assertEqual(self.bs.load(self.id)["view"]["z"], want, z)
        self.bs.save(self.id, {"view": {}})
        self.assertEqual(self.bs.load(self.id)["view"], {"x": 0.0, "y": 0.0, "z": 1.0})
        self.bs.save(self.id, {"view": {"x": 7, "y": 8, "z": 1}})
        self.bs.save(self.id, {"view": "left"})     # not a dict: the last view stays
        self.assertEqual(self.bs.load(self.id)["view"], {"x": 7, "y": 8, "z": 1})

    def test_title(self):
        self.bs.save(self.id, {"title": "  Spaced  "})
        self.assertEqual(self.bs.load(self.id)["title"], "Spaced")
        self.bs.save(self.id, {"title": ""})
        self.assertEqual(self.bs.load(self.id)["title"], "Spaced")
        self.bs.save(self.id, {"title": "t" * 200})
        self.assertEqual(len(self.bs.load(self.id)["title"]), 120)
        self.bs.save(self.id, {"title": 42})
        self.assertEqual(self.bs.load(self.id)["title"], "42")

    def test_a_patch_with_a_bad_object_changes_nothing(self):
        self.bs.save(self.id, {"upsert": [sticky("a")]})
        before = (self.file(self.id, "board.json").read_bytes(), self.bs.load(self.id)["rev"])
        for patch in ({"upsert": [sticky("b"), {"id": "bad", "type": "nope"}]}, {"upsert": [sticky("b"), {"id": "l", "type": "link", "url": "javascript:x"}]},
                      {"upsert": "not a list", "title": "should not stick"}, {"upsert": [None], "delete": ["a"], "view": {"z": 3}}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.bs.save(self.id, patch)
        self.assertEqual((self.file(self.id, "board.json").read_bytes(), self.bs.load(self.id)["rev"]), before)

    def test_the_object_limit_applies_to_what_the_board_would_hold(self):
        with mock.patch.object(schema, "MAX_OBJECTS", 3):
            self.bs.save(self.id, {"upsert": [sticky("a"), sticky("b"), sticky("c")]})
            with self.assertRaisesRegex(ValueError, "too many"):
                self.bs.save(self.id, {"upsert": [sticky("d")]})
            self.bs.save(self.id, {"upsert": [sticky("d")], "delete": ["a"]})   # a delete in the same patch makes room
        self.assertEqual(ids(self.objs()), ["b", "c", "d"])

    def test_save_on_a_trashed_or_missing_board_is_not_found(self):
        self.bs.delete(self.id)
        with self.assertRaises(NotFound):
            self.bs.save(self.id, {"title": "x"})
        with self.assertRaises(NotFound):
            self.bs.save(GHOST, {"title": "x"})

    def test_a_board_file_that_cannot_be_read_says_so(self):
        self.file(self.id, "board.json").write_text('{"format": "anch')
        with self.assertRaisesRegex(ValueError, "can't be read"):
            self.bs.load(self.id)

    def test_saves_from_several_threads_do_not_lose_each_other(self):
        def worker(tag):
            for i in range(15):
                self.bs.save(self.id, {"upsert": [sticky(f"{tag}{i}")]})
        threads = [threading.Thread(target=worker, args=(t,)) for t in "abcd"]
        [t.start() for t in threads]
        [t.join() for t in threads]
        b = self.bs.load(self.id)
        self.assertEqual((len(b["objects"]), b["rev"]), (60, 61))


class WriteTests(StoreCase):
    def test_a_board_is_written_to_a_temp_file_in_its_folder_and_renamed_into_place(self):
        b = self.make()
        real, seen = os.replace, []

        def spy(src, dst):
            seen.append((Path(src), Path(dst), Path(src).exists()))
            real(src, dst)
        with mock.patch.object(store.os, "replace", spy):
            self.bs.save(b["id"], {"title": "x"})
        (src, dst, existed), = seen
        self.assertEqual((src.parent, dst), (dst.parent, self.file(b["id"], "board.json")))
        self.assertNotEqual(src, dst)
        self.assertTrue(existed)
        self.assertFalse(src.exists())

    def test_a_write_that_dies_halfway_leaves_the_old_board_whole(self):
        b = self.make("keep", [sticky("a")])
        path = self.file(b["id"], "board.json")
        before = path.read_bytes()

        def torn(obj, f, **kw):
            f.write('{"format": "anch')
            raise OSError("disk full")
        with mock.patch.object(store.json, "dump", torn), self.assertRaises(OSError):
            self.bs.save(b["id"], {"title": "new", "upsert": [sticky("z")]})
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.bs.load(b["id"])["title"], "keep")


class AssetTests(StoreCase):
    def setUp(self):
        super().setUp()
        self.id = self.make()["id"]

    def test_a_picture_gets_a_random_name_and_keeps_its_extension(self):
        a = self.bs.add_asset(self.id, PNG, "My Pic.PNG", "image/png")
        self.assertRegex(a["src"], r"^[0-9a-f]{10}\.png$")
        self.assertEqual((a["name"], a["size"], a["mime"]), ("My Pic.png", len(PNG), "image/png"))
        b = self.bs.add_asset(self.id, PNG, "My Pic.PNG", "image/png")
        self.assertNotEqual(a["src"], b["src"])
        self.assertEqual(self.bs.asset_path(self.id, a["src"]).read_bytes(), PNG)

    def test_no_extension_borrows_one_from_the_mime_type(self):
        self.assertTrue(self.bs.add_asset(self.id, JPEG, "", "image/jpeg")["src"].endswith(".jpg"))
        self.assertTrue(self.bs.add_asset(self.id, PNG, "pasted", "image/png; charset=x")["src"].endswith(".png"))
        bare = self.bs.add_asset(self.id, b"x", "pasted", "")
        self.assertRegex(bare["src"], r"^[0-9a-f]{10}$")
        self.assertEqual(bare["mime"], "application/octet-stream")
        self.assertEqual(self.bs.add_asset(self.id, b"x", "doc.pdf", "")["mime"], "application/pdf")

    def test_a_file_keeps_its_name_and_a_clash_is_numbered(self):
        names = [self.bs.add_asset(self.id, bytes([i]), "Report.pdf", "", keep_name=True)["src"] for i in range(3)]
        self.assertEqual(names, ["Report.pdf", "Report (2).pdf", "Report (3).pdf"])
        self.assertEqual([self.bs.asset_path(self.id, n).read_bytes() for n in names], [b"\x00", b"\x01", b"\x02"])

    def test_uploads_cannot_choose_where_they_land(self):
        a = self.bs.add_asset(self.id, b"x", "../../../evil.sh", "", keep_name=True)
        self.assertEqual(a["src"], "evil.sh")
        self.assertEqual(sorted(p.name for p in (self.home / "boards").rglob("evil.sh")), ["evil.sh"])
        self.assertEqual((self.home / "boards" / self.id / "assets" / "evil.sh").read_bytes(), b"x")
        self.assertFalse((self.home / "evil.sh").exists())

    def test_safe_name(self):
        cases = {"report.pdf": "report.pdf", "My File.PDF": "My File.pdf", "../../etc/passwd": "passwd", "a/b/c.png": "c.png", "": "file", None: "file",
                 "...": "file", "名前.png": "file.png", ".bashrc": "file.bashrc", "x.p!n#g": "x.png", "tab\tname.txt": "tab-name.txt",
                 "a.b.c": "a.b.c", "-lead.txt": "lead.txt", "a" * 200 + ".txt": "a" * 80 + ".txt", "x." + "e" * 30: "x." + "e" * 10, "back\\slash.png": "back-slash.png"}
        for raw, want in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(store.safe_name(raw), want)

    def test_safe_name_always_gives_a_name_an_object_may_point_at(self):
        nasty = ["", " ", ".", "..", "../..", "~", "$(rm -rf)", "a;b|c&d", "CON", "x" * 500, "\x00", "a\x00b.png", "%2e%2e%2f", "\n", "éééé.éé", "a..b", "." * 50 + ".x", "(", "+++", ",,,.png"]
        for raw in nasty:
            with self.subTest(raw=raw):
                out = store.safe_name(raw)
                self.assertRegex(out, schema.ASSET)
                self.assertNotIn("/", out)

    def test_asset_path_serves_only_plain_names_that_exist_in_the_boards_own_folder(self):
        a = self.asset(self.id, "real.txt")
        self.assertEqual(self.bs.asset_path(self.id, a).name, "real.txt")
        secret = self.file(self.id, "board.json")
        self.assertTrue(secret.is_file())      # one folder up: must stay out of reach
        other = self.make("other")["id"]
        self.asset(other, "theirs.txt")
        for bad in ("../board.json", "..%2fboard.json", "%2e%2e%2fboard.json", "..\\board.json", "board.json", "missing.txt", "", ".", "..", "a/b", "/etc/passwd",
                    "assets/real.txt", f"../../{other}/assets/theirs.txt", "theirs.txt", "real.txt\x00.png", "real.txt/", " real.txt"):
            with self.subTest(name=bad), self.assertRaises(NotFound):
                self.bs.asset_path(self.id, bad)

    def test_a_file_whose_name_is_not_a_plain_asset_name_is_never_served_even_if_it_is_there(self):
        folder = self.bs.asset_dir(self.id, create=True)
        for odd in ("odd$name.txt", "semi;colon.txt", "tab\tname.txt", "-dash-first.txt"):
            (folder / odd).write_text("x")
            with self.subTest(name=odd), self.assertRaises(NotFound):
                self.bs.asset_path(self.id, odd)

    def test_asset_path_of_a_missing_board_is_not_found(self):
        with self.assertRaises(NotFound):
            self.bs.asset_path(GHOST, "a.png")


class CopyAssetsTests(StoreCase):
    def setUp(self):
        super().setUp()
        self.a, self.b = self.make("a")["id"], self.make("b")["id"]

    def test_files_are_copied_across_boards_under_the_same_name_when_free(self):
        n1 = self.asset(self.a, "one.png", b"1")
        n2 = self.asset(self.a, "two.png", b"2")
        out = self.bs.copy_assets(self.b, [n1, n2, "nothing.png"], from_board=self.a)
        self.assertEqual(out, {"one.png": "one.png", "two.png": "two.png"})
        self.assertEqual(self.bs.asset_path(self.b, "two.png").read_bytes(), b"2")
        self.assertEqual(self.bs.asset_path(self.a, "two.png").read_bytes(), b"2")   # a copy, not a move

    def test_the_same_file_twice_is_not_duplicated(self):
        self.asset(self.a, "one.png", b"same")
        self.bs.copy_assets(self.b, ["one.png"], from_board=self.a)
        self.assertEqual(self.bs.copy_assets(self.b, ["one.png"], from_board=self.a), {"one.png": "one.png"})
        self.assertEqual(sorted(p.name for p in self.file(self.b, "assets").iterdir()), ["one.png"])

    def test_a_different_file_with_the_same_name_is_kept_beside_it_under_a_new_name(self):
        self.asset(self.a, "one.png", b"from a")
        self.asset(self.b, "one.png", b"already in b")
        out = self.bs.copy_assets(self.b, ["one.png"], from_board=self.a)
        self.assertNotEqual(out["one.png"], "one.png")
        self.assertRegex(out["one.png"], schema.ASSET)
        self.assertTrue(out["one.png"].endswith("-one.png"))
        self.assertEqual(self.bs.asset_path(self.b, "one.png").read_bytes(), b"already in b")     # nothing overwritten
        self.assertEqual(self.bs.asset_path(self.b, out["one.png"]).read_bytes(), b"from a")

    def test_names_that_are_not_plain_asset_names_are_skipped(self):
        self.asset(self.a, "ok.png", b"x")
        (self.home / "boards" / self.a / "secret.txt").write_text("keep out")
        out = self.bs.copy_assets(self.b, ["../secret.txt", "..\\x", "a/../ok.png", "", None, 5, ["ok.png"], "ok.png"], from_board=self.a)
        self.assertEqual(out, {"ok.png": "ok.png"})
        self.assertEqual([p.name for p in self.file(self.b, "assets").iterdir()], ["ok.png"])

    def test_copy_from_a_template(self):
        self.asset(self.a, "pic.png", b"png")
        t = self.bs.template_save("t", [box("i", "image", src="pic.png")], from_board=self.a)
        self.assertEqual(self.bs.copy_assets(self.b, ["pic.png", "other.png"], from_template=t["id"]), {"pic.png": "pic.png"})
        self.assertEqual(self.bs.asset_path(self.b, "pic.png").read_bytes(), b"png")

    def test_a_template_or_board_that_is_not_there_is_not_found(self):
        for bad in ("../x", "..", "20200101-000000-AAAA"):
            with self.subTest(template=bad), self.assertRaises(NotFound):
                self.bs.copy_assets(self.b, ["pic.png"], from_template=bad)
        self.assertEqual(self.bs.copy_assets(self.b, ["pic.png"], from_template=GHOST), {})      # well formed but empty: nothing to copy
        with self.assertRaises(NotFound):
            self.bs.copy_assets(self.b, ["pic.png"], from_board=GHOST)
        with self.assertRaises(NotFound):
            self.bs.copy_assets(GHOST, ["pic.png"], from_board=self.a)


class ExportImportTests(StoreCase):
    def build(self):
        b = self.make("Plan")
        img = self.bs.add_asset(b["id"], PNG + b"image", "pic.png", "image/png")["src"]
        fav = self.bs.add_asset(b["id"], PNG + b"fav", "f.png", "image/png")["src"]
        thumb = self.bs.add_asset(b["id"], JPEG + b"thumb", "t.jpg", "image/jpeg")["src"]
        doc = self.bs.add_asset(b["id"], b"%PDF contract", "contract.pdf", "application/pdf", keep_name=True)["src"]
        self.bs.add_asset(b["id"], b"nobody uses me", "orphan.png", "image/png")
        self.bs.save(b["id"], {"title": "Plan", "view": {"x": 10, "y": -20, "z": 2},
                               "upsert": [box("f", "frame", x=0, y=0, w=800, h=600), sticky("s", parent="f", text="héllo ✓"), box("i", "image", src=img),
                                          box("d", "file", src=doc, name="contract.pdf", size=13, mime="application/pdf"),
                                          {"id": "l", "type": "link", "url": "https://example.com", "title": "Ex", "favicon": fav, "thumb": thumb},
                                          wire("c", {"id": "s", "side": "r"}, {"id": "i"}, label="why"),
                                          {"id": "p", "type": "draw", "points": [0, 0, 0.5, 5, 5, 0.5]}]})
        return self.bs.load(b["id"]), {"pic": img, "fav": fav, "thumb": thumb, "doc": doc}

    def test_export_inlines_exactly_the_files_the_board_uses(self):
        board, a = self.build()
        doc = self.bs.export(board["id"])
        self.assertEqual({k: v for k, v in doc.items() if k != "assets"}, board)
        self.assertEqual(set(doc["assets"]), set(a.values()))      # the orphan stays behind
        for name, b64 in doc["assets"].items():
            self.assertEqual(base64.b64decode(b64), self.bs.asset_path(board["id"], name).read_bytes())
        json.dumps(doc)    # it is a plain JSON document

    def test_import_makes_a_new_board_with_the_same_contents(self):
        board, a = self.build()
        doc = json.loads(json.dumps(self.bs.export(board["id"])))
        new = self.bs.import_(doc)
        self.assertNotEqual(new["id"], board["id"])
        got = self.bs.load(new["id"])
        self.assertEqual(got, new)
        self.assertEqual((got["title"], got["rev"], got["view"]), ("Plan", 1, board["view"]))
        self.assertEqual(got["objects"], board["objects"])
        for name in a.values():
            self.assertEqual(self.bs.asset_path(new["id"], name).read_bytes(), self.bs.asset_path(board["id"], name).read_bytes(), name)
        with self.assertRaises(NotFound):
            self.bs.asset_path(new["id"], "orphan.png")
        self.assertEqual(len(self.bs.list()), 2)
        self.assertEqual(self.bs.load(board["id"]), board)    # the original is untouched

    def test_import_refuses_what_is_not_a_board_and_writes_nothing(self):
        good = {"format": "anchor-board", "objects": []}
        for bad in (None, [], "x", {}, {**good, "format": "other"}, {**good, "objects": "no"}, {"format": "anchor-board"},
                    {**good, "objects": [sticky("a"), sticky("a")]}, {**good, "objects": [{"id": "x", "type": "nope"}]}):
            with self.subTest(doc=bad), self.assertRaises(ValueError):
                self.bs.import_(bad)
        self.assertEqual(self.bs.list(), [])

    def test_import_defaults_and_cleans_the_header(self):
        new = self.bs.import_({"format": "anchor-board", "objects": [sticky("a", group="solo")], "title": "", "view": {"z": 99},
                               "rev": 40, "id": GHOST})
        self.assertEqual((new["title"], new["view"]["z"], new["rev"]), ("Imported board", 4, 1))
        self.assertNotEqual(new["id"], GHOST)
        self.assertNotIn("group", new["objects"][0])
        self.assertEqual(len(self.bs.import_({"format": "anchor-board", "objects": [], "title": "t" * 300})["title"]), 120)

    def test_import_ignores_files_it_cannot_trust(self):
        ok = base64.b64encode(b"fine").decode()
        new = self.bs.import_({"format": "anchor-board", "objects": [], "assets": {
            "good.png": ok, "../evil.png": ok, "sub/evil.png": ok, "/abs.png": ok, "bad base64.png": "!!!not base64!!!", "number.png": 5, "": ok, ".hidden": ok}})
        names = sorted(p.name for p in self.file(new["id"], "assets").iterdir())
        self.assertEqual(names, ["good.png"])
        self.assertEqual(list((self.home).rglob("evil.png")) + list(self.home.rglob("abs.png")), [])


class TemplateStoreTests(StoreCase):
    def test_save_list_get_delete(self):
        src = self.make("src")["id"]
        pic = self.bs.add_asset(src, PNG, "p.png", "image/png")["src"]
        self.bs.add_asset(src, PNG, "unused.png", "image/png")
        with mock.patch.object(store, "new_id", side_effect=["20260101-000001-aaaa", "20260101-000002-bbbb"]):
            t1 = self.bs.template_save("  First  ", [box("a", "image", src=pic), sticky("b")], from_board=src)
            t2 = self.bs.template_save("", [sticky("c")])
        self.assertEqual((t1["id"], t1["name"], ids(t1["objects"])), ("20260101-000001-aaaa", "First", ["a", "b"]))
        self.assertEqual(t2["name"], "Untitled template")
        rows = self.bs.template_list()
        self.assertEqual([(r["name"], r["count"]) for r in rows], [("Untitled template", 1), ("First", 2)])     # newest first
        self.assertEqual(set(rows[0]), {"id", "name", "count", "thumb"})
        self.assertTrue(rows[1]["thumb"].startswith("<svg"))
        self.assertEqual(self.bs.template_get(t1["id"]), t1)
        self.assertEqual(sorted(p.name for p in (self.home / "boards" / ".templates" / t1["id"] / "assets").iterdir()), [pic])     # only what it uses
        self.bs.template_delete(t1["id"])
        self.assertEqual([r["name"] for r in self.bs.template_list()], ["Untitled template"])
        self.assertFalse((self.home / "boards" / ".templates" / t1["id"]).exists())
        with self.assertRaises(NotFound):
            self.bs.template_get(t1["id"])
        with self.assertRaises(NotFound):
            self.bs.template_delete(t1["id"])

    def test_a_template_stands_on_its_own(self):
        src = self.make("src")["id"]
        pic = self.bs.add_asset(src, PNG, "p.png", "image/png")["src"]
        t = self.bs.template_save("t", [box("a", "image", src=pic)], from_board=src)
        self.bs.delete(src)
        self.bs.purge(src)
        dst = self.make("dst")["id"]
        self.assertEqual(self.bs.copy_assets(dst, [pic], from_template=t["id"]), {pic: pic})
        self.assertEqual(self.bs.asset_path(dst, pic).read_bytes(), PNG)

    def test_save_is_cleaned_like_any_other_write(self):
        t = self.bs.template_save("t", [sticky("a", group="solo", junk=1), wire("c", {"id": "a"}, {"id": "outside"}, x=3, y=4, w=5, h=6)])
        self.assertNotIn("junk", t["objects"][0])
        self.assertNotIn("group", t["objects"][0])
        self.assertEqual(t["objects"][1]["to"], {"x": 8, "y": 10})     # a wire to something that was not selected becomes a free end
        self.assertEqual(self.bs.template_get(t["id"]), t)
        self.assertEqual(len(self.bs.template_save("n" * 200, [sticky("a")])["name"]), 80)

    def test_an_empty_or_invalid_selection_saves_nothing(self):
        for bad, msg in (([], "Select something"), ([{"id": "a", "type": "nope"}], "known kind"), ([sticky("a"), sticky("a")], "share an id")):
            with self.subTest(objects=bad), self.assertRaisesRegex(ValueError, msg):
                self.bs.template_save("t", bad)
        self.assertEqual(self.bs.template_list(), [])
        self.assertEqual(list(self.bs.templates.iterdir()), [])

    def test_missing_files_are_left_out_rather_than_failing(self):
        src = self.make("src")["id"]
        t = self.bs.template_save("t", [box("a", "image", src="gone.png")], from_board=src)
        self.assertEqual(self.bs.template_get(t["id"])["objects"][0]["src"], "gone.png")
        self.assertEqual(list((self.home / "boards" / ".templates" / t["id"] / "assets").iterdir()), [])

    def test_bad_template_ids_are_not_found(self):
        for bad in ("../x", "..", "", GHOST, "20200101-000000-AAAA", "x"):
            for fn in (self.bs.template_get, self.bs.template_delete):
                with self.subTest(id=bad), self.assertRaises(NotFound):
                    fn(bad)

    def test_the_list_skips_a_broken_template(self):
        ok = self.bs.template_save("ok", [sticky("a")])
        broken = self.home / "boards" / ".templates" / "20260101-000009-dead"
        broken.mkdir()
        (broken / "template.json").write_text("{nope")
        (self.home / "boards" / ".templates" / "stray").mkdir()
        self.assertEqual([r["id"] for r in self.bs.template_list()], [ok["id"]])


class ThumbTests(unittest.TestCase):
    def test_empty_board_has_no_thumb_and_a_sticky_shows_its_own_colour(self):
        self.assertEqual(store.thumb_svg({"objects": []}), "")
        self.assertEqual(store.thumb_svg({"objects": [{"id": "c", "type": "connector", "x": 0, "y": 0, "w": 5, "h": 5}]}), "")   # wires alone draw nothing
        svg = store.thumb_svg({"objects": [{"id": "s", "type": "sticky", "x": 0, "y": 0, "w": 100, "h": 100, "color": "pink"}]})
        self.assertIn(f'fill="{schema.STICKY["pink"]}"', svg)
        self.assertTrue(svg.startswith("<svg") and svg.endswith("</svg>"))

    def test_the_other_blocks_use_design_tokens_not_raw_colours(self):
        objs = [{"id": t, "type": t, "x": i * 50, "y": 0, "w": 40, "h": 40} for i, t in enumerate(("frame", "draw", "shape", "text", "image", "node"))]
        svg = store.thumb_svg({"objects": objs})
        self.assertEqual(re.findall(r"#[0-9a-fA-F]{3,8}\b", svg), [])
        self.assertIn("var(--line)", svg)
        self.assertEqual(svg.count("<rect"), 6)


# --- link cards ------------------------------------------------------------------------------------------------------

class Site:
    """A throwaway web server on 127.0.0.1. routes: path -> (status, content-type, body[, delay]). `hits` is what was asked for."""

    def __init__(self, routes):
        self.routes, self.hits = routes, []
        site = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                site.hits.append(self.path)
                status, ctype, body, *delay = site.routes.get(self.path.split("?")[0], (404, "text/plain", b"nothing here"))
                if delay:
                    threading.Event().wait(delay[0])
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except OSError:
                    pass

            def log_message(self, *a):
                pass
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()

    def url(self, path=""):
        return f"http://127.0.0.1:{self.server.server_address[1]}{path}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def html(head="", body="", ctype="text/html; charset=utf-8"):
    return 200, ctype, f"<!doctype html><html><head>{head}</head><body>{body}</body></html>".encode()


class Keep:
    """The `store` callback of links.fetch: remembers what was kept and hands out names."""

    def __init__(self):
        self.files = {}

    def __call__(self, data, name, mime):
        n = f"{name}-{len(self.files)}.kept"
        self.files[n] = (data, name, mime)
        return n

    def of(self, role):
        return [v for v in self.files.values() if v[1] == role]


def closed_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class LinkTests(unittest.TestCase):
    def serve(self, routes):
        site = Site(routes)
        self.addCleanup(site.close)
        return site

    def plain(self, card, url):
        self.assertEqual(card["url"], url)
        self.assertEqual((card["desc"], card["favicon"], card["thumb"]), ("", None, None))

    def test_a_page_gives_its_open_graph_title_description_icon_and_picture(self):
        fav, thumb = PNG + b"favicon", JPEG + b"thumbnail"
        site = self.serve({"/page": html('<title>Plain title</title><meta property="og:title" content="  The   real\n title ">'
                                         '<meta name="description" content="plain desc"><meta property="og:description" content="Open  graph\n desc">'
                                         '<link rel="shortcut icon" href="/img/icon.png"><meta property="og:image" content="/img/hero.jpg">'),
                           "/img/icon.png": (200, "image/png", fav), "/img/hero.jpg": (200, "image/jpeg", thumb)})
        keep = Keep()
        card = links.fetch(site.url("/page"), keep)
        self.assertEqual((card["ok"], card["title"], card["desc"], card["host"], card["url"]),
                         (True, "The real title", "Open graph desc", "127.0.0.1", site.url("/page")))
        self.assertEqual(keep.of("favicon"), [(fav, "favicon", "image/png")])
        self.assertEqual(keep.of("thumb"), [(thumb, "thumb", "image/jpeg")])
        self.assertEqual(set(card), {"url", "host", "title", "desc", "favicon", "thumb", "ok"})
        self.assertEqual(keep.files[card["favicon"]][0], fav)       # the name in the card is the file it kept
        self.assertEqual(keep.files[card["thumb"]][0], thumb)
        self.assertEqual(site.hits[0], "/page")

    def test_without_open_graph_it_falls_back_to_the_title_tag_and_meta_description(self):
        site = self.serve({"/a": html("<title> Just a title </title><meta name='description' content='about it'>"),
                           "/b": html("<meta name='twitter:title' content='Tweeted'><title>ignored</title>"), "/c": html("<h1>no head at all</h1>")})
        a, b, c = (links.fetch(site.url(p), Keep()) for p in ("/a", "/b", "/c"))
        self.assertEqual((a["title"], a["desc"], b["title"]), ("Just a title", "about it", "Tweeted"))
        self.assertEqual((c["title"], c["ok"]), (site.url("/c"), True))      # a page with no title is still a card, titled by its address

    def test_the_largest_icon_is_tried_first_and_a_missing_one_falls_through_to_the_next(self):
        big = PNG + b"big"
        site = self.serve({"/p": html('<link rel="icon" sizes="16x16" href="/s.png"><link rel="icon" sizes="64x64" href="/b.png">'
                                      '<link rel="apple-touch-icon" href="/a.png">'),
                           "/s.png": (200, "image/png", PNG + b"small"), "/b.png": (200, "image/png", big), "/a.png": (200, "image/png", PNG + b"apple")})
        keep = Keep()
        links.fetch(site.url("/p"), keep)
        self.assertEqual([v[0] for v in keep.of("favicon")], [big])
        self.assertEqual(site.hits, ["/p", "/b.png"])
        site.routes["/b.png"] = (404, "text/plain", b"gone")
        keep = Keep()
        links.fetch(site.url("/p"), keep)
        self.assertEqual([v[0] for v in keep.of("favicon")], [PNG + b"apple"])     # apple-touch-icon outranks the 16 px one

    def test_no_icon_tags_means_try_favicon_ico_at_the_root(self):
        ico = b"\x00\x00\x01\x00" + b"\x00" * 20
        site = self.serve({"/deep/page": html("<title>t</title>"), "/favicon.ico": (200, "image/x-icon", ico)})
        keep = Keep()
        card = links.fetch(site.url("/deep/page"), keep)
        self.assertEqual(keep.of("favicon"), [(ico, "favicon", "image/x-icon")])
        self.assertIsNotNone(card["favicon"])

    def test_an_icon_or_picture_that_is_not_really_an_image_is_not_kept(self):
        site = self.serve({"/p": html('<link rel="icon" href="/i.png"><meta property="og:image" content="/o.png">'),
                           "/i.png": (200, "image/png", b"<html>actually a web page</html>"), "/o.png": (200, "image/png", b"just text, honest")})
        keep = Keep()
        card = links.fetch(site.url("/p"), keep)
        self.assertEqual(keep.files, {})
        self.assertEqual((card["favicon"], card["thumb"], card["ok"]), (None, None, True))

    def test_an_svg_may_be_the_icon_but_never_the_preview_picture(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"></svg>'
        site = self.serve({"/p": html('<link rel="icon" href="/i.svg"><meta property="og:image" content="/o.svg">'), "/i.svg": (200, "image/svg+xml", svg),
                           "/o.svg": (200, "image/svg+xml", svg)})
        keep = Keep()
        card = links.fetch(site.url("/p"), keep)
        self.assertEqual([v[2] for v in keep.files.values()], ["image/svg+xml"])
        self.assertEqual((card["favicon"] is not None, card["thumb"]), (True, None))

    def test_picture_urls_may_be_absolute_or_relative_to_the_page(self):
        site = self.serve({"/dir/page": html('<meta property="og:image" content="hero.png">'), "/dir/hero.png": (200, "image/png", PNG + b"rel")})
        keep = Keep()
        links.fetch(site.url("/dir/page"), keep)
        self.assertEqual([v[0] for v in keep.of("thumb")], [PNG + b"rel"])
        site.routes["/dir/page"] = html(f'<meta property="og:image" content="{site.url("/elsewhere.png")}">')
        site.routes["/elsewhere.png"] = (200, "image/png", PNG + b"abs")
        keep = Keep()
        links.fetch(site.url("/dir/page"), keep)
        self.assertEqual([v[0] for v in keep.of("thumb")], [PNG + b"abs"])

    def test_a_link_straight_to_a_picture_becomes_a_picture_card(self):
        site = self.serve({"/photos/cat.png": (200, "image/png", PNG + b"cat"), "/mislabelled": (200, "text/plain", JPEG + b"jpeg"),
                           "/liar.png": (200, "image/png", b"this is not a picture")})
        keep = Keep()
        card = links.fetch(site.url("/photos/cat.png"), keep)
        self.assertEqual((card["ok"], card["title"], card["favicon"]), (True, "cat.png", None))
        self.assertEqual(keep.of("thumb"), [(PNG + b"cat", "thumb", "image/png")])
        self.assertEqual(card["thumb"], next(iter(keep.files)))
        keep = Keep()
        self.assertTrue(links.fetch(site.url("/mislabelled"), keep)["ok"])      # the bytes decide, not the label
        self.assertEqual(keep.of("thumb")[0][2], "image/jpeg")
        keep = Keep()
        card = links.fetch(site.url("/liar.png"), keep)       # the label says picture, the bytes say no
        self.assertEqual((card["ok"], card["thumb"], keep.files), (False, None, {}))
        self.assertEqual(card["title"], site.url("/liar.png"))

    def test_something_that_is_not_a_web_page_is_a_card_titled_by_its_address_with_no_pictures(self):
        site = self.serve({"/doc.pdf": (200, "application/pdf", b"%PDF-1.4\n%\xe2\xe3 not html at all"), "/data.json": (200, "application/json", b'{"og:image": "/x.png"}'),
                           "/bin": (200, "application/octet-stream", bytes(range(256)) * 4), "/x.png": (200, "image/png", PNG)})
        for path in ("/doc.pdf", "/data.json", "/bin"):
            with self.subTest(path=path):
                keep = Keep()
                card = links.fetch(site.url(path), keep)
                self.plain(card, site.url(path))
                self.assertEqual((card["title"], keep.files), (site.url(path), {}))
        self.assertNotIn("/x.png", site.hits)

    def test_a_long_address_is_titled_by_its_host(self):
        long = "http://127.0.0.1:%d/%s" % (closed_port(), "a" * 100)
        card = links.fetch(long, Keep())
        self.assertEqual((card["title"], card["host"], card["ok"]), ("127.0.0.1", "127.0.0.1", False))

    def test_a_refused_connection_is_a_plain_card_and_not_an_error(self):
        url = f"http://127.0.0.1:{closed_port()}/page"
        keep = Keep()
        card = links.fetch(url, keep)
        self.assertEqual(card, {"url": url, "host": "127.0.0.1", "title": url, "desc": "", "favicon": None, "thumb": None, "ok": False})
        self.assertEqual(keep.files, {})

    def test_an_error_status_is_a_plain_card_too(self):
        site = self.serve({"/gone": (404, "text/html", b"<title>Not found</title>"), "/boom": (500, "text/html", b"<title>Oops</title>")})
        for p in ("/gone", "/boom", "/never-routed"):
            card = links.fetch(site.url(p), Keep())
            self.assertEqual((card["ok"], card["title"]), (False, site.url(p)), p)

    def test_a_slow_site_is_given_up_on(self):
        site = self.serve({"/slow": html("<title>Eventually</title>") + (2.0,)})
        with mock.patch.object(links, "TIMEOUT", 0.3):
            card = links.fetch(site.url("/slow"), Keep())
        self.assertEqual((card["ok"], card["title"]), (False, site.url("/slow")))

    def test_only_http_and_https_are_ever_fetched(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        secret = Path(tmp.name, "secret.html")
        secret.write_text("<title>SECRET FROM DISK</title>")
        keep = Keep()
        for url in (secret.as_uri(), "ftp://example.com/x", "javascript:alert(1)", "data:text/html,<title>x</title>", "mailto:a@b.c", "gopher://x", "//example.com",
                    "example.com", "not a url", "", "   ", "http://", "https:///path"):
            with self.subTest(url=url), mock.patch.object(links, "_get", side_effect=AssertionError("went to the network")):
                card = links.fetch(url, keep)
                self.assertFalse(card["ok"])
                self.assertEqual((card["favicon"], card["thumb"], card["desc"]), (None, None, ""))
                self.assertNotIn("SECRET", json.dumps(card))
        self.assertEqual(keep.files, {})

    def test_the_address_is_trimmed_and_www_is_dropped_from_the_host(self):
        card = links.fetch("  ftp://www.example.com/x  ", Keep())
        self.assertEqual((card["url"], card["host"]), ("ftp://www.example.com/x", "example.com"))

    def test_the_declared_charset_is_used_and_a_bogus_one_does_not_break_it(self):
        latin = "<html><head><title>Café</title></head></html>".encode("latin-1")
        site = self.serve({"/latin": (200, "text/html; charset=iso-8859-1", latin), "/bogus": (200, "text/html; charset=klingon", b"<title>Plain</title>")})
        self.assertEqual(links.fetch(site.url("/latin"), Keep())["title"], "Café")
        card = links.fetch(site.url("/bogus"), Keep())
        self.assertEqual((card["title"], card["ok"]), ("Plain", True))

    def test_title_and_description_are_capped(self):
        site = self.serve({"/p": html(f'<meta property="og:title" content="{"t" * 500}"><meta property="og:description" content="{"d" * 900}">')})
        card = links.fetch(site.url("/p"), Keep())
        self.assertEqual((len(card["title"]), len(card["desc"])), (300, 600))

    def test_broken_markup_still_gives_a_card(self):
        site = self.serve({"/p": (200, "text/html", b"<html><head><title>Half a page<meta property='og:description' content='still here'<<<>>>")})
        card = links.fetch(site.url("/p"), Keep())
        self.assertTrue(card["ok"])


class HubTests(unittest.TestCase):
    def setUp(self):
        self.hub = hub.Hub()

    def test_publish_reaches_every_tab_on_that_board_but_not_the_sender_or_other_boards(self):
        a, b, c = self.hub.subscribe("b1", "tab-a"), self.hub.subscribe("b1", "tab-b"), self.hub.subscribe("b2", "tab-c")
        self.hub.publish("b1", "patch", {"rev": 2, "n": [1, 2]}, exclude="tab-a")
        self.assertEqual(b.get_nowait(), 'event: patch\ndata: {"rev":2,"n":[1,2]}\n\n')
        self.assertTrue(a.empty() and c.empty())
        self.hub.publish("b1", "patch", {})
        self.assertFalse(a.empty() or b.empty())
        self.hub.publish("nobody-here", "patch", {})     # no tabs: nothing to do, and no error

    def test_unsubscribe_and_viewer_count(self):
        self.assertEqual(self.hub.viewers("b1"), 0)
        self.hub.subscribe("b1", "x")
        self.hub.subscribe("b1", "y")
        self.assertEqual(self.hub.viewers("b1"), 2)
        self.hub.unsubscribe("b1", "x")
        self.hub.unsubscribe("b1", "x")
        self.hub.unsubscribe("never", "x")
        self.assertEqual(self.hub.viewers("b1"), 1)

    def test_a_reconnected_tab_stays_subscribed_when_its_old_connection_ends(self):
        old = self.hub.subscribe("b1", "tab")
        new = self.hub.subscribe("b1", "tab")        # the page reconnected with the same client id
        self.hub.unsubscribe("b1", "tab", old)       # the old stream finally fails a write
        self.assertEqual(self.hub.viewers("b1"), 1)
        self.hub.publish("b1", "patch", {"rev": 3})
        self.assertFalse(new.empty())
        self.hub.unsubscribe("b1", "tab", new)
        self.assertEqual(self.hub.viewers("b1"), 0)

# --- the HTTP API ----------------------------------------------------------------------------------------------------

class Stream:
    """A server-sent-events connection that reads one event at a time and times out instead of hanging."""

    def __init__(self, port, path, headers=None):
        self.conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        self.conn.request("GET", path, headers=headers or {})
        self.resp = self.conn.getresponse()

    def event(self):
        name = data = None
        while True:
            line = self.resp.fp.readline()
            if not line:
                raise EOFError("the stream closed")
            line = line.decode().rstrip("\n")
            if line.startswith("event: "):
                name = line[7:]
            elif line.startswith("data: "):
                data = json.loads(line[6:])
            elif line == "" and name:
                return name, data

    def close(self):
        self.conn.close()


class ApiCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        quiet = mock.patch.object(app.Handler, "log_message", lambda *a: None)
        quiet.start()
        self.addCleanup(quiet.stop)
        self.home = Path(tmp.name, "notes")
        self.server = app.make_server(self.home, "127.0.0.1", 0, labeled=Path(tmp.name, "labeled"), with_notebooks=False)
        self.board = self.server.RequestHandlerClass.board
        self.bs = self.board.boards
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def call(self, method, path, body=None, headers=None, guard=True, raw=False):
        """(status, parsed JSON or bytes, response headers). `guard=False` leaves off the header that real pages send."""
        data = body if isinstance(body, bytes) else (json.dumps(body).encode() if body is not None else None)
        h = {**({"X-Makesense": "1"} if guard else {}), **(headers or {})}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                status, payload, hdrs = r.status, r.read(), r.headers
        except urllib.error.HTTPError as e:
            status, payload, hdrs = e.code, e.read(), e.headers
            e.close()
        if not raw and "json" in (hdrs.get("Content-Type") or ""):
            payload = json.loads(payload)
        return status, payload, hdrs

    def ok(self, method, path, body=None, status=200, **kw):
        s, payload, h = self.call(method, path, body, **kw)
        self.assertEqual(s, status, payload)
        return payload

    def new(self, title="T", objects=None):
        b = self.ok("POST", "/api/board", {"title": title}, 201)
        if objects:
            self.ok("PUT", f"/api/board/{b['id']}", {"upsert": objects})
        return b["id"]

    def upload(self, bid, name, data=b"data", mime="", keep=False):
        q = urllib.parse.quote(name)
        return self.ok("POST", f"/api/board/{bid}/assets?name={q}&mime={mime}&keep={int(keep)}", data, 201, headers={"Content-Type": "application/octet-stream"})

    def stream(self, bid, client=None):
        s = Stream(self.port, f"/api/board/{bid}/events" + (f"?client={client}" if client else ""))
        self.addCleanup(s.close)
        return s


class ApiBoardTests(ApiCase):
    def test_create_list_get(self):
        b = self.ok("POST", "/api/board", {"title": "Roadmap"}, 201)
        self.assertEqual((b["title"], b["rev"], b["objects"], b["format"]), ("Roadmap", 1, [], "anchor-board"))
        self.assertEqual(self.ok("GET", f"/api/board/{b['id']}"), b)
        listing = self.ok("GET", "/api/board")
        self.assertEqual(([r["id"] for r in listing["boards"]], listing["trash"]), ([b["id"]], 0))
        self.assertEqual(self.ok("GET", "/api/board?q=ROAD")["boards"][0]["id"], b["id"])
        self.assertEqual(self.ok("GET", "/api/board?q=nope")["boards"], [])
        self.assertEqual(self.ok("POST", "/api/board", None, 201)["title"], "Untitled board")      # no body at all
        self.assertEqual(self.ok("POST", "/api/board", {"title": 123}, 201)["title"], "123")

    def test_put_applies_a_patch_and_answers_with_the_new_revision(self):
        bid = self.new()
        out = self.ok("PUT", f"/api/board/{bid}", {"upsert": [sticky("a", text="hi"), sticky("b")], "title": "Renamed", "view": {"x": 5, "y": 6, "z": 2}})
        self.assertEqual((set(out), out["rev"]), ({"rev", "updated"}, 2))
        b = self.ok("GET", f"/api/board/{bid}")
        self.assertEqual((b["title"], b["rev"], b["view"], ids(b["objects"])), ("Renamed", 2, {"x": 5, "y": 6, "z": 2}, ["a", "b"]))
        self.ok("PUT", f"/api/board/{bid}", {"delete": ["a"], "order": ["b"], "client": "me"})
        self.assertEqual(ids(self.ok("GET", f"/api/board/{bid}")["objects"]), ["b"])
        self.assertNotIn("client", self.ok("GET", f"/api/board/{bid}"))     # a body field that is not part of the board is not kept

    def test_a_bad_patch_is_a_400_with_a_reason_and_changes_nothing(self):
        bid = self.new(objects=[sticky("a")])
        before = self.ok("GET", f"/api/board/{bid}")
        for body in ({"upsert": [{"id": "z", "type": "bogus"}]}, {"upsert": [sticky("z"), {"id": "l", "type": "link", "url": "javascript:1"}]}, {"upsert": ["str"]}):
            s, out, _ = self.call("PUT", f"/api/board/{bid}", body)
            self.assertEqual(s, 400, body)
            self.assertTrue(out["error"])
        s, out, _ = self.call("PUT", f"/api/board/{bid}", b"{not json")
        self.assertEqual(s, 400)
        s, out, _ = self.call("PUT", f"/api/board/{bid}", b"[1, 2]")
        self.assertEqual((s, out["error"]), (400, "That request didn't look right."))
        self.assertEqual(self.ok("GET", f"/api/board/{bid}"), before)

    def test_delete_trash_restore_purge(self):
        bid = self.new("Doomed", [sticky("a")])
        self.assertEqual(self.ok("DELETE", f"/api/board/{bid}"), {"ok": True})
        self.assertEqual(self.call("GET", f"/api/board/{bid}")[0], 404)
        listing = self.ok("GET", "/api/board")
        self.assertEqual((listing["boards"], listing["trash"]), ([], 1))
        trash = self.ok("GET", "/api/board/trash")["boards"]
        self.assertEqual([(r["id"], r["title"]) for r in trash], [(bid, "Doomed")])
        back = self.ok("POST", f"/api/board/{bid}/restore")
        self.assertEqual((back["id"], ids(back["objects"])), (bid, ["a"]))
        self.assertEqual(self.ok("GET", f"/api/board/{bid}")["title"], "Doomed")
        self.assertEqual(self.call("POST", f"/api/board/{bid}/purge")[0], 404)      # a live board cannot be purged
        self.ok("DELETE", f"/api/board/{bid}")
        self.assertEqual(self.ok("POST", f"/api/board/{bid}/purge"), {"ok": True})
        self.assertEqual(self.ok("GET", "/api/board/trash")["boards"], [])
        self.assertEqual(self.call("POST", f"/api/board/{bid}/restore")[0], 404)

    def test_duplicate(self):
        bid = self.new("Orig", [sticky("a")])
        d = self.ok("POST", f"/api/board/{bid}/duplicate", None, 201)
        self.assertNotEqual(d["id"], bid)
        self.assertEqual((d["title"], d["rev"], ids(d["objects"])), ("Orig (copy)", 1, ["a"]))
        self.assertEqual(len(self.ok("GET", "/api/board")["boards"]), 2)

    def test_unknown_boards_and_bad_ids_are_404_on_every_route(self):
        bad = (GHOST, "nope", "..", "20200101-000000-AAAA", "%2e%2e", "20200101-000000-aaaa%2f..")
        routes = [("GET", ""), ("PUT", ""), ("DELETE", ""), ("POST", "/duplicate"), ("POST", "/restore"), ("POST", "/purge"), ("GET", "/export.json"),
                  ("GET", "/events"), ("POST", "/assets"), ("GET", "/assets/a.png"), ("POST", "/assets/copy"), ("POST", "/link"), ("POST", "/open")]
        for bid in bad:
            for method, tail in routes:
                with self.subTest(board=bid, route=f"{method} {tail}"):
                    body = {"url": "https://example.com", "src": "a.png", "srcs": [], "from_board": GHOST} if method == "POST" else ({"title": "x"} if method == "PUT" else None)
                    s, out, _ = self.call(method, f"/api/board/{bid}{tail}", body)
                    self.assertEqual(s, 404, out)
        self.assertEqual([p.name for p in (self.home / "boards").iterdir() if p.name[0] != "."], [])    # none of that made a folder

    def test_unknown_routes_on_a_real_board_are_404(self):
        bid = self.new()
        for method, tail in (("GET", "/nothing"), ("POST", ""), ("GET", "/duplicate"), ("GET", "/assets"), ("POST", "/assets/a/b"), ("GET", "/assets/a/b")):
            self.assertEqual(self.call(method, f"/api/board/{bid}{tail}", None if method == "GET" else {})[0], 404, f"{method} {tail}")

    def test_export_and_import_round_trip_through_the_api(self):
        bid = self.new("My Plan!")
        pic = self.upload(bid, "pic.png", PNG + b"x", "image/png")["src"]
        self.ok("PUT", f"/api/board/{bid}", {"upsert": [box("i", "image", src=pic), sticky("s", text="héllo")], "view": {"x": 1, "y": 2, "z": 3}})
        s, body, h = self.call("GET", f"/api/board/{bid}/export.json", raw=True)
        self.assertEqual(s, 200)
        self.assertEqual(h["Content-Disposition"], 'attachment; filename="my-plan.board.json"')
        self.assertIn("json", h["Content-Type"])
        doc = json.loads(body)
        self.assertEqual(base64.b64decode(doc["assets"][pic]), PNG + b"x")
        new = self.ok("POST", "/api/board/import", doc, 201)
        self.assertNotEqual(new["id"], bid)
        self.assertEqual((new["title"], new["view"], ids(new["objects"])), ("My Plan!", {"x": 1, "y": 2, "z": 3}, ["i", "s"]))
        s, got, _ = self.call("GET", f"/api/board/{new['id']}/assets/{pic}", raw=True)
        self.assertEqual((s, got), (200, PNG + b"x"))
        self.assertEqual(self.call("POST", "/api/board/import", {"format": "something else", "objects": []})[0], 400)
        self.assertEqual(self.call("POST", "/api/board/import", {"format": "anchor-board", "objects": [{"id": "x", "type": "nope"}]})[0], 400)
        self.assertEqual(len(self.ok("GET", "/api/board")["boards"]), 2)

    def test_export_file_names_are_plain_ascii_slugs(self):
        for title, slug in (("Café ☕ Plan", "caf-plan"), ("!!!", "board"), ("a" * 100, "a" * 48), ("Q3 / Q4", "q3-q4")):
            bid = self.new(title)
            h = self.call("GET", f"/api/board/{bid}/export.json", raw=True)[2]
            self.assertEqual(h["Content-Disposition"], f'attachment; filename="{slug}.board.json"', title)

    def test_the_trash_route_is_not_mistaken_for_a_board(self):
        self.assertEqual(self.ok("GET", "/api/board/trash"), {"boards": []})
        self.assertEqual(self.call("DELETE", "/api/board/trash")[0], 404)
        self.assertEqual(self.call("GET", "/api/board/import")[0], 404)


class ApiGuardTests(ApiCase):
    def test_every_write_needs_the_custom_header_and_nothing_happens_without_it(self):
        bid = self.new("Mine")
        before = self.ok("GET", f"/api/board/{bid}")
        writes = [("POST", "/api/board", {"title": "x"}), ("PUT", f"/api/board/{bid}", {"title": "hacked"}), ("DELETE", f"/api/board/{bid}", None),
                  ("POST", f"/api/board/{bid}/duplicate", None), ("POST", f"/api/board/{bid}/purge", None), ("POST", f"/api/board/{bid}/assets?name=x.png", b"x"),
                  ("POST", "/api/board/import", {"format": "anchor-board", "objects": []}), ("POST", f"/api/board/{bid}/open", {"src": "a"}),
                  ("POST", "/api/board/templates", {"name": "t", "objects": [sticky("a")]}), ("POST", f"/api/board/{bid}/link", {"url": "http://127.0.0.1:1/"})]
        with mock.patch.object(subprocess, "Popen") as popen:
            for method, path, body in writes:
                s, out, _ = self.call(method, path, body, guard=False)
                self.assertEqual((s, out), (403, {"error": "missing X-Makesense header"}), f"{method} {path}")
            self.assertEqual(self.call("DELETE", "/api/board/templates/" + GHOST, guard=False)[0], 403)
        popen.assert_not_called()
        self.assertEqual(self.ok("GET", f"/api/board/{bid}"), before)
        self.assertEqual(len(self.ok("GET", "/api/board")["boards"]), 1)
        self.assertEqual(self.ok("GET", "/api/board/templates"), {"templates": []})

    def test_reads_do_not_need_the_header(self):
        bid = self.new()
        for path in ("/api/board", f"/api/board/{bid}", "/api/board/trash", f"/api/board/{bid}/export.json", "/api/board/templates", "/web/board/palette.js"):
            self.assertEqual(self.call("GET", path, guard=False, raw=True)[0], 200, path)

    def test_a_host_header_that_is_not_this_machine_is_refused_even_for_reads(self):
        bid = self.new()
        for host in ("evil.example", "evil.example:8765", "localhost.evil.com", "127.0.0.1.evil.com:80", "192.168.1.5:8765", "0.0.0.0", ""):
            for path in ("/api/board", f"/api/board/{bid}", "/web/board/palette.js"):
                c = http.client.HTTPConnection("127.0.0.1", self.port)
                c.request("GET", path, headers={"Host": host, "X-Makesense": "1"})
                r = c.getresponse()
                body = r.read()
                c.close()
                self.assertEqual(r.status, 403, f"{host!r} {path}")
                self.assertEqual(json.loads(body), {"error": "unexpected Host header"})
        for host in (f"localhost:{self.port}", "127.0.0.1", f"127.0.0.1:{self.port}", f"[::1]:{self.port}", "localhost"):
            c = http.client.HTTPConnection("127.0.0.1", self.port)
            c.request("GET", "/api/board", headers={"Host": host})
            r = c.getresponse()
            r.read()
            c.close()
            self.assertEqual(r.status, 200, host)

    def test_a_write_from_a_foreign_host_is_refused_even_with_the_header(self):
        bid = self.new()
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("DELETE", f"/api/board/{bid}", headers={"Host": "evil.example", "X-Makesense": "1"})
        r = c.getresponse()
        r.read()
        c.close()
        self.assertEqual(r.status, 403)
        self.assertEqual(self.ok("GET", f"/api/board/{bid}")["id"], bid)


class ApiAssetTests(ApiCase):
    def test_upload_then_download(self):
        bid = self.new()
        a = self.upload(bid, "my pic.PNG", PNG + b"abc", "image/png")
        self.assertRegex(a["src"], r"^[0-9a-f]{10}\.png$")
        self.assertEqual((a["name"], a["size"], a["mime"]), ("my pic.png", len(PNG) + 3, "image/png"))
        s, body, h = self.call("GET", f"/api/board/{bid}/assets/{a['src']}", raw=True)
        self.assertEqual((s, body, h["Content-Type"]), (200, PNG + b"abc", "image/png"))
        self.assertEqual(h["X-Content-Type-Options"], "nosniff")
        self.assertEqual(h["Cache-Control"], "max-age=3600")

    def test_downloads_carry_a_sandbox_that_stops_scripts_whatever_the_file_is(self):
        bid = self.new()
        evil = b"<script>fetch('/api/board',{method:'DELETE'})</script>"
        for name, kind in (("page.html", "text/html"), ("pic.svg", "image/svg+xml"), ("pic.png", "image/png"), ("notes.txt", "text/plain"), ("x.js", None), ("x.unknown", None)):
            src = self.upload(bid, name, evil, "", keep=True)["src"]
            s, body, h = self.call("GET", f"/api/board/{bid}/assets/{src}", raw=True)
            csp = h["Content-Security-Policy"]
            with self.subTest(name=name):
                self.assertEqual((s, body), (200, evil))
                if kind:
                    self.assertEqual(h["Content-Type"].split(";")[0], kind)
                self.assertTrue(csp.startswith("sandbox"), csp)
                self.assertNotIn("allow-scripts", csp)
                self.assertIn("default-src 'none'", csp)
                self.assertEqual(h["X-Content-Type-Options"], "nosniff")

    def test_the_mime_comes_from_the_query_then_the_header(self):
        bid = self.new()
        self.assertEqual(self.ok("POST", f"/api/board/{bid}/assets?name=x", b"1", 201, headers={"Content-Type": "image/webp"})["mime"], "image/webp")
        self.assertEqual(self.upload(bid, "x", b"1", "image/avif")["mime"], "image/avif")

    def test_keeping_a_name_numbers_clashes(self):
        bid = self.new()
        names = [self.upload(bid, "Quote.pdf", bytes([i]), keep=True)["src"] for i in range(2)]
        self.assertEqual(names, ["Quote.pdf", "Quote (2).pdf"])
        self.assertEqual(self.call("GET", f"/api/board/{bid}/assets/Quote.pdf", raw=True)[:2], (200, b"\x00"))

    def test_an_upload_over_the_limit_is_refused_and_stores_nothing(self):
        bid = self.new()
        with mock.patch.object(api, "MAX_ASSET", 3):
            s, out, _ = self.call("POST", f"/api/board/{bid}/assets?name=big.png", b"too big")
        self.assertEqual(s, 400)
        self.assertIn("limit", out["error"])
        self.assertFalse((self.home / "boards" / bid / "assets").exists())

    def test_nothing_outside_the_assets_folder_can_be_downloaded(self):
        bid = self.new("secret board")
        self.upload(bid, "real.png", PNG, "image/png")
        other = self.new("other")
        self.upload(other, "theirs.txt", b"not yours", "", keep=True)
        for tail in ("board.json", "../board.json", "..%2fboard.json", "%2e%2e%2fboard.json", "..%5cboard.json", f"../../{other}/assets/theirs.txt",
                     f"..%2f..%2f{other}%2fassets%2ftheirs.txt", "theirs.txt", "%00", "real.png%00", ".", "..", "assets", "REAL.PNG/", "real.png/..%2fboard.json"):
            with self.subTest(tail=tail):
                s, body, _ = self.call("GET", f"/api/board/{bid}/assets/{tail}", raw=True)
                self.assertEqual(s, 404)
                self.assertNotIn(b"secret board", body)
                self.assertNotIn(b"not yours", body)

    def test_copy_between_boards(self):
        a, b = self.new("a"), self.new("b")
        src = self.upload(a, "pic.png", PNG + b"p", "image/png")["src"]
        out = self.ok("POST", f"/api/board/{b}/assets/copy", {"from_board": a, "srcs": [src, "../board.json", "ghost.png"]})
        self.assertEqual(out, {"map": {src: src}})
        self.assertEqual(self.call("GET", f"/api/board/{b}/assets/{src}", raw=True)[1], PNG + b"p")
        self.assertEqual(self.call("POST", f"/api/board/{b}/assets/copy", {"from_board": GHOST, "srcs": [src]})[0], 404)
        self.assertEqual(self.call("POST", f"/api/board/{b}/assets/copy", {"from_template": "../x", "srcs": [src]})[0], 404)

    def test_a_link_card_keeps_its_icon_and_picture_beside_the_board(self):
        site = Site({"/p": html('<title>Linked</title><link rel="icon" href="/i.png"><meta property="og:image" content="/h.png">'),
                     "/i.png": (200, "image/png", PNG + b"icon"), "/h.png": (200, "image/png", PNG + b"hero")})
        self.addCleanup(site.close)
        bid = self.new()
        card = self.ok("POST", f"/api/board/{bid}/link", {"url": site.url("/p")})
        self.assertEqual((card["ok"], card["title"]), (True, "Linked"))
        self.assertEqual(self.call("GET", f"/api/board/{bid}/assets/{card['favicon']}", raw=True)[1], PNG + b"icon")
        self.assertEqual(self.call("GET", f"/api/board/{bid}/assets/{card['thumb']}", raw=True)[1], PNG + b"hero")
        # the card can go straight onto the board
        self.ok("PUT", f"/api/board/{bid}", {"upsert": [{"id": "l", "type": "link", **{k: card[k] for k in ("url", "title", "desc", "host", "favicon", "thumb")}}]})

    def test_a_link_to_nowhere_still_answers_200_with_a_plain_card(self):
        bid = self.new()
        for url in (f"http://127.0.0.1:{closed_port()}/", "ftp://example.com/x", "javascript:alert(1)", "garbage"):
            card = self.ok("POST", f"/api/board/{bid}/link", {"url": url})
            self.assertFalse(card["ok"], url)
            self.assertEqual((card["favicon"], card["thumb"]), (None, None))
        self.assertFalse((self.home / "boards" / bid / "assets").exists())

    def test_a_link_to_an_unknown_board_never_goes_out_to_the_network(self):
        site = Site({"/p": html("<title>x</title>")})
        self.addCleanup(site.close)
        self.assertEqual(self.call("POST", f"/api/board/{GHOST}/link", {"url": site.url("/p")})[0], 404)
        self.assertEqual(site.hits, [])


class ApiOpenTests(ApiCase):
    """The Open button on a file card. Popen is replaced, so nothing here launches anything."""

    def setUp(self):
        super().setUp()
        self.bid = self.new()
        patches = [mock.patch.object(api.subprocess, "Popen"), mock.patch.object(api, "sys", types.SimpleNamespace(platform="darwin"))]
        self.popen = patches[0].start()
        patches[1].start()
        for p in patches:
            self.addCleanup(p.stop)

    def launch(self, name, data=b"x", mode=None):
        src = self.upload(self.bid, name, data, keep=True)["src"]
        if mode is not None:
            os.chmod(self.home / "boards" / self.bid / "assets" / src, mode)
        self.popen.reset_mock()
        out = self.ok("POST", f"/api/board/{self.bid}/open", {"src": src})
        return src, out, [c.args[0] for c in self.popen.call_args_list]

    def path(self, src):
        return str(self.home / "boards" / self.bid / "assets" / src)

    def test_an_ordinary_document_is_opened_with_the_system_opener(self):
        for name in ("Report.pdf", "photo.jpg", "notes.txt", "sheet.xlsx", "slides.key", "archive.zip", "no-extension"):
            src, out, calls = self.launch(name)
            with self.subTest(name=name):
                self.assertEqual(out, {"ok": True, "revealed": False})
                self.assertEqual(calls, [["/usr/bin/open", self.path(src)]])
        kw = self.popen.call_args.kwargs
        self.assertEqual((kw["stdout"], kw["stderr"]), (subprocess.DEVNULL, subprocess.DEVNULL))

    def test_anything_that_runs_code_is_shown_in_finder_instead_of_opened(self):
        for name in ("setup.command", "run.sh", "x.bash", "x.zsh", "Thing.app", "Installer.pkg", "Disk.dmg", "x.terminal", "x.workflow", "x.scpt", "x.action",
                     "x.jar", "evil.exe", "x.bat", "x.cmd", "x.py", "x.pl", "x.rb", "x.js", "x.mjs", "page.html", "page.htm", "pic.svg", "x.webloc", "x.url",
                     "x.inetloc", "x.fileloc", "Tool.app.zip", "UPPER.COMMAND", "Mixed.Sh", "invoice.pdf.command", "Other.APP.ZIP",
                     "x.mpkg", "x.tool", "x.pyw", "x.prefpane", "x.saver", "x.docm", "x.xlsm", "x.ps1", "x.vbs", "x.msi", "x.lnk", "x.jnlp"):
            src, out, calls = self.launch(name)
            with self.subTest(name=name):
                self.assertEqual(out, {"ok": True, "revealed": True})
                self.assertEqual(calls, [["/usr/bin/open", "-R", self.path(src)]])

    def test_a_file_with_the_executable_bit_is_revealed_whatever_it_is_called(self):
        _, out, calls = self.launch("looks-harmless.txt", mode=0o755)
        self.assertEqual((out["revealed"], calls[0][:2]), (True, ["/usr/bin/open", "-R"]))
        _, out, calls = self.launch("owner-only-exec", mode=0o700)
        self.assertEqual(out["revealed"], True)
        _, out, calls = self.launch("plain.txt", mode=0o644)
        self.assertEqual(out["revealed"], False)

    def test_only_files_in_this_boards_assets_can_be_opened(self):
        other = self.new("other")
        self.upload(other, "theirs.pdf", b"x", keep=True)
        self.upload(self.bid, "mine.pdf", b"x", keep=True)
        for src in ("../board.json", "board.json", "/etc/passwd", "../../../../etc/hosts", "..%2fboard.json", "theirs.pdf", "missing.pdf", "", "mine.pdf/", "mine.pdf\x00.txt",
                    f"../../{other}/assets/theirs.pdf"):
            self.popen.reset_mock()
            with self.subTest(src=src):
                self.assertEqual(self.call("POST", f"/api/board/{self.bid}/open", {"src": src})[0], 404)
                self.popen.assert_not_called()
        self.assertEqual(self.call("POST", f"/api/board/{self.bid}/open", {})[0], 404)
        self.popen.assert_not_called()

    def test_off_a_mac_it_says_so_and_launches_nothing(self):
        src = self.upload(self.bid, "a.pdf", b"x", keep=True)["src"]
        with mock.patch.object(api, "sys", types.SimpleNamespace(platform="linux")):
            s, out, _ = self.call("POST", f"/api/board/{self.bid}/open", {"src": src})
        self.assertEqual(s, 400)
        self.assertIn("macOS", out["error"])
        self.popen.assert_not_called()


class ApiEventTests(ApiCase):
    def test_a_viewer_hears_hello_then_other_clients_changes(self):
        bid = self.new()
        s = self.stream(bid, client="viewer")
        self.assertEqual(s.resp.status, 200)
        self.assertEqual(s.resp.getheader("Content-Type"), "text/event-stream")
        self.assertEqual(s.resp.getheader("Cache-Control"), "no-store")
        self.assertEqual(s.event(), ("hello", {"client": "viewer"}))
        self.ok("PUT", f"/api/board/{bid}", {"client": "someone-else", "upsert": [sticky("a", text="from afar")], "order": ["a"], "title": "Retitled"})
        name, data = s.event()
        self.assertEqual(name, "patch")
        self.assertEqual((data["rev"], ids(data["upsert"]), data["upsert"][0]["text"], data["delete"], data["order"], data["title"]), (2, ["a"], "from afar", [], ["a"], "Retitled"))

    def test_the_sender_does_not_hear_its_own_change_but_others_do(self):
        bid = self.new()
        mine, theirs = self.stream(bid, "mine"), self.stream(bid, "theirs")
        self.assertEqual((mine.event()[0], theirs.event()[0]), ("hello", "hello"))
        self.ok("PUT", f"/api/board/{bid}", {"client": "mine", "upsert": [sticky("first")]})
        self.ok("PUT", f"/api/board/{bid}", {"upsert": [sticky("second")], "delete": ["first"]})      # no client: everyone hears it
        t1, t2 = theirs.event(), theirs.event()
        self.assertEqual([(n, d["rev"]) for n, d in (t1, t2)], [("patch", 2), ("patch", 3)])
        name, data = mine.event()    # the first thing mine hears is the second change, not its own
        self.assertEqual((name, data["rev"], ids(data["upsert"]), data["delete"]), ("patch", 3, ["second"], ["first"]))

    def test_a_viewer_of_one_board_hears_nothing_from_another(self):
        a, b = self.new("a"), self.new("b")
        s = self.stream(a)
        self.assertEqual(s.event()[0], "hello")
        self.ok("PUT", f"/api/board/{b}", {"upsert": [sticky("elsewhere")]})
        self.ok("PUT", f"/api/board/{a}", {"upsert": [sticky("here")]})
        self.assertEqual(ids(s.event()[1]["upsert"]), ["here"])

    def test_a_client_id_is_made_up_when_none_is_given(self):
        bid = self.new()
        name, data = self.stream(bid).event()
        self.assertEqual(name, "hello")
        self.assertRegex(data["client"], r"^[0-9a-f]{8}$")

    def test_a_deleted_board_stops_being_watchable(self):
        bid = self.new()
        self.ok("DELETE", f"/api/board/{bid}")
        self.assertEqual(self.call("GET", f"/api/board/{bid}/events", raw=True)[0], 404)


class ApiTemplateTests(ApiCase):
    def test_save_list_get_delete(self):
        bid = self.new()
        pic = self.upload(bid, "p.png", PNG + b"tpl", "image/png")["src"]
        t = self.ok("POST", "/api/board/templates", {"name": "Kickoff", "objects": [box("i", "image", src=pic), sticky("s")], "from_board": bid}, 201)
        self.assertEqual((t["name"], ids(t["objects"])), ("Kickoff", ["i", "s"]))
        rows = self.ok("GET", "/api/board/templates")["templates"]
        self.assertEqual([(r["id"], r["name"], r["count"]) for r in rows], [(t["id"], "Kickoff", 2)])
        self.assertEqual(self.ok("GET", f"/api/board/templates/{t['id']}"), t)
        s, body, h = self.call("GET", f"/api/board/templates/{t['id']}/assets/{pic}", raw=True)
        self.assertEqual((s, body, h["Content-Type"]), (200, PNG + b"tpl", "image/png"))
        self.assertEqual(self.ok("DELETE", f"/api/board/templates/{t['id']}"), {"ok": True})
        self.assertEqual(self.call("GET", f"/api/board/templates/{t['id']}")[0], 404)
        self.assertEqual(self.call("GET", f"/api/board/templates/{t['id']}/assets/{pic}")[0], 404)
        self.assertEqual(self.ok("GET", "/api/board/templates"), {"templates": []})

    def test_the_templates_route_is_not_a_board(self):
        self.assertEqual(self.call("GET", "/api/board/templates")[0], 200)
        self.assertEqual(self.call("POST", "/api/board/templates/anything", {})[0], 404)

    def test_bad_requests(self):
        for body in ({"name": "x", "objects": []}, {"name": "x"}, {"name": "x", "objects": [{"id": "a", "type": "nope"}]}, {"name": "x", "objects": "str"}):
            self.assertEqual(self.call("POST", "/api/board/templates", body)[0], 400, body)
        self.assertEqual(self.ok("GET", "/api/board/templates"), {"templates": []})
        self.assertEqual(self.call("POST", "/api/board/templates", {"name": "x", "objects": [box("i", "image", src="a.png")], "from_board": GHOST})[0], 404)

    def test_unknown_and_malformed_ids_and_asset_names_are_404(self):
        t = self.ok("POST", "/api/board/templates", {"name": "t", "objects": [sticky("a")]}, 201)["id"]
        for tid in (GHOST, "nope", "..", "20200101-000000-AAAA"):
            for method, tail in (("GET", ""), ("DELETE", ""), ("GET", "/assets/a.png")):
                self.assertEqual(self.call(method, f"/api/board/templates/{tid}{tail}")[0], 404, f"{method} {tid}{tail}")
        for name in ("template.json", "../template.json", "..%2ftemplate.json", "%2e%2e%2ftemplate.json", "missing.png", "a/b"):
            self.assertEqual(self.call("GET", f"/api/board/templates/{t}/assets/{name}", raw=True)[0], 404, name)
        self.assertEqual(self.call("GET", f"/api/board/templates/{t}/nothing/a/b")[0], 404)
        folder = self.home / "boards" / ".templates" / t / "assets"
        folder.mkdir()
        (folder / "fine.png").write_bytes(PNG)
        (folder / "odd$name.png").write_bytes(PNG)      # there on disk, but not a name an object may use
        self.assertEqual(self.call("GET", f"/api/board/templates/{t}/assets/fine.png", raw=True)[0], 200)
        self.assertEqual(self.call("GET", f"/api/board/templates/{t}/assets/odd$name.png", raw=True)[0], 404)

    def test_a_template_can_be_pasted_into_another_board_with_its_files(self):
        a, b = self.new("a"), self.new("b")
        pic = self.upload(a, "p.png", PNG + b"tpl", "image/png")["src"]
        t = self.ok("POST", "/api/board/templates", {"name": "t", "objects": [box("i", "image", src=pic)], "from_board": a}, 201)
        self.assertEqual(self.ok("POST", f"/api/board/{b}/assets/copy", {"from_template": t["id"], "srcs": [pic]}), {"map": {pic: pic}})
        self.assertEqual(self.call("GET", f"/api/board/{b}/assets/{pic}", raw=True)[1], PNG + b"tpl")


class ApiStaticTests(ApiCase):
    TYPES = {".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json"}

    def test_every_editor_file_is_served_byte_for_byte_with_its_type(self):
        files = [p for p in api.WEB.iterdir() if p.suffix in self.TYPES]
        self.assertGreater(len(files), 20)
        for p in files:
            s, body, h = self.call("GET", f"/web/board/{p.name}", raw=True)
            with self.subTest(file=p.name):
                self.assertEqual((s, body, h["Content-Type"]), (200, p.read_bytes(), self.TYPES[p.suffix]))
                self.assertEqual(h["X-Content-Type-Options"], "nosniff")
        names = {p.name for p in files}
        self.assertTrue({"index.js", "editor.js", "board.css", "palette.js", "templates.json"} <= names)

    def test_only_plain_js_css_and_json_names_are_served(self):
        with tempfile.TemporaryDirectory() as d:
            web = Path(d, "web")
            web.mkdir()
            for name, text in (("ok.js", "1"), ("style.css", "2"), ("data.json", "{}"), ("secret.txt", "s"), ("page.html", "<p>"), ("run.py", "x = 1"),
                               (".hidden.js", "h"), ("two.dots.js", "t"), ("UPPER.JS", "u"), ("noext", "n"), ("sp ace.js", "sp")):
                (web / name).write_text(text)
            (web / "sub").mkdir()
            (web / "sub" / "inner.js").write_text("i")
            (web.parent / "outside.js").write_text("OUTSIDE")
            with mock.patch.object(api, "WEB", web):
                served = {n: self.call("GET", f"/web/board/{n}", raw=True)[0] for n in
                          ("ok.js", "style.css", "data.json", "secret.txt", "page.html", "run.py", ".hidden.js", "two.dots.js", "UPPER.JS", "noext", "sp%20ace.js", "sub", "sub%2finner.js",
                           "sub/inner.js", "..%2foutside.js", "%2e%2e%2foutside.js", "../outside.js", "..", ".", "", "ok.js%00.txt", "missing.js")}
        self.assertEqual({n for n, s in served.items() if s == 200}, {"ok.js", "style.css", "data.json"})

    def test_the_real_folders_other_files_and_parents_are_out_of_reach(self):
        for path in ("/web/board/", "/web/board", "/web/board/__init__.py", "/web/board/api.py", "/web/board/..%2fapp.py", "/web/board/%2e%2e%2f%2e%2e%2fapp.py",
                     "/web/board/../app.py", "/web/board/../../sense/app.py", "/web/board/..\\app.py", "/web/board/palette.js/../../app.py", "/web/board/PALETTE.JS",
                     "/web/board/palette.js.map", "/web/board/palette.js%00", "/web/board/palette", "/web/board/index.html", "/web/board/nope.js", "/web/boards/palette.js"):
            s, body, _ = self.call("GET", path, raw=True)
            with self.subTest(path=path):
                self.assertGreaterEqual(s, 400)      # (the exact status is FixedBugsTest's business; what matters here is that nothing is served)
                self.assertNotIn(b"class BoardApp", body)
                self.assertNotIn(b"import ", body[:200])

    def test_writes_to_the_editor_files_route_are_not_routes(self):
        for method in ("POST", "PUT", "DELETE"):
            self.assertEqual(self.call(method, "/web/board/palette.js", {})[0], 404, method)
        self.assertIn(b"STICKY", self.call("GET", "/web/board/palette.js", raw=True)[1])


# --- bugs that were found and fixed ------------------------------------------------------------------------------------
# Each of these failed before the fix; they stay so the same mistakes do not come back.


class FixedBugsTest(ApiCase):
    def test_a_delete_and_an_upsert_of_the_same_id_in_one_patch_leaves_one_object(self):
        bs = Boards(self.home / "gap")
        b = bs.create("T", [sticky("a"), sticky("b")])
        bs.save(b["id"], {"delete": ["a"], "upsert": [sticky("a", text="again")]})
        got = bs.load(b["id"])["objects"]
        self.assertEqual(sorted(ids(got)), ["a", "b"])
        self.assertEqual([o["text"] for o in got if o["id"] == "a"], ["again"])

    def test_a_method_the_board_list_does_not_take_is_a_404_not_a_crash(self):
        for method in ("PUT", "DELETE"):
            self.assertEqual(self.call(method, "/api/board", {})[0], 404, method)

    def test_an_editor_file_that_does_not_exist_is_a_404_not_a_500(self):
        for name in ("nope.js", "__init__.py", "x.css"):
            s, body, _ = self.call("GET", f"/web/board/{name}", raw=True)
            self.assertEqual(s, 404, body)

    def test_an_id_or_colour_with_a_trailing_newline_is_not_accepted(self):
        # the patterns end in $, which also matches just before a final newline
        with self.assertRaises(ValueError):
            schema.clean_object(sticky("a\n"))
        self.assertIsNone(schema.clean_object({"id": "s", "type": "shape", "fill": "#abc\n"})["fill"])
        self.assertFalse(schema.ASSET.match("pic.png\n"))

    def test_a_sticky_colour_that_is_not_a_string_falls_back_like_any_other_bad_colour(self):
        self.assertEqual(schema.clean_object(sticky("s", color=["red"]))["color"], "light_yellow")

    def test_a_site_error_page_is_closed_not_left_for_the_garbage_collector(self):
        err = urllib.error.HTTPError("http://example.test/", 404, "Not Found", {}, io.BytesIO(b"nope"))
        with mock.patch.object(links.urllib.request, "urlopen", side_effect=err):
            links.fetch("http://example.test/", Keep())
        self.assertTrue(err.fp.closed)

    def test_a_z_order_that_names_an_object_twice_must_not_put_it_on_the_board_twice(self):
        bs = Boards(self.home / "gap")
        b = bs.create("T", [sticky("a"), sticky("b"), sticky("c")])
        bs.save(b["id"], {"order": ["a", "a", "b"]})
        self.assertEqual(ids(bs.load(b["id"])["objects"]), ["a", "b", "c"])

    def test_a_file_name_with_a_space_can_be_fetched_by_the_url_the_editor_builds(self):
        bid = self.new()
        src = self.upload(bid, "Quarterly report.pdf", b"%PDF", keep=True)["src"]
        self.assertEqual(self.bs.asset_path(bid, src).read_bytes(), b"%PDF")     # it is stored, under that name
        url = "/api/board/%s/assets/%s" % (bid, urllib.parse.quote(src, safe=""))   # what editor.js assetUrl() does: encodeURIComponent
        self.assertEqual(self.call("GET", url, raw=True)[:2], (200, b"%PDF"))

    def test_a_failed_write_leaves_no_half_written_temp_file_behind(self):
        bs = Boards(self.home / "gap")
        b = bs.create("keep")
        with mock.patch.object(store.os, "replace", side_effect=OSError("disk full")), self.assertRaises(OSError):
            bs.save(b["id"], {"title": "new"})
        self.assertEqual(sorted(p.name for p in (self.home / "gap" / "boards" / b["id"]).iterdir()), ["board.json"])

    def test_an_import_whose_assets_are_not_a_mapping_is_a_400_not_a_crash(self):
        s, out, _ = self.call("POST", "/api/board/import", {"format": "anchor-board", "objects": [], "assets": ["not", "a", "mapping"]})
        self.assertEqual(s, 400)

    def test_a_template_for_a_board_that_is_not_there_leaves_no_folder_behind(self):
        bs = Boards(self.home / "gap")
        with self.assertRaises(NotFound):
            bs.template_save("t", [box("i", "image", src="a.png")], from_board=GHOST)
        self.assertEqual(list(bs.templates.iterdir()), [])

    def test_template_files_are_served_with_the_same_sandbox_as_board_files(self):
        bid = self.new()
        src = self.upload(bid, "page.html", b"<script>alert(1)</script>", keep=True)["src"]
        t = self.ok("POST", "/api/board/templates", {"name": "t", "objects": [box("f", "file", src=src)], "from_board": bid}, 201)
        s, _, h = self.call("GET", f"/api/board/templates/{t['id']}/assets/{src}", raw=True)
        self.assertEqual(s, 200)
        self.assertTrue((h.get("Content-Security-Policy") or "").startswith("sandbox"), h.get("Content-Security-Policy"))

    def test_a_picture_larger_than_the_limit_is_left_out_not_kept_cut_short(self):
        site = Site({"/p": html('<meta property="og:image" content="/big.png">'), "/big.png": (200, "image/png", PNG + b"\x01" * 400)})
        self.addCleanup(site.close)
        keep = Keep()
        with mock.patch.object(links, "MAX_THUMB", 100):
            links.fetch(site.url("/p"), keep)
        for data, _, _ in keep.of("thumb"):
            self.assertEqual(len(data), len(PNG) + 400, "a picture was kept cut off")


if __name__ == "__main__":
    unittest.main()
