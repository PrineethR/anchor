"""The Board's built-in templates (sense/web/board/templates.json): plain data, so the checks are about shape and layout."""
import json
import unittest
from pathlib import Path

from sense.board import schema

PATH = Path(__file__).resolve().parent.parent / "sense" / "web" / "board" / "templates.json"
EXPECTED = [
    ("brainstorm", "Brainstorm"), ("matrix", "2×2 matrix"), ("kanban", "Kanban board"),
    ("journey", "User journey map"), ("empathy", "Empathy map"), ("retro", "Retrospective"),
]
SWATCHES = {"#FFFFFF", "#E6E6E6", "#8F8A81", "#1A1A1A", "#F24726", "#FF9D48", "#F5D128", "#93D275", "#67C6C0", "#2D9BF0", "#5B7CE6", "#CA91D8", "#F16C7F"}
MAX_TEXT = 200


def load():
    return json.loads(PATH.read_text(encoding="utf-8"))


def boxed(objs):
    return [o for o in objs if o["type"] != "connector"]


def inside(c, f):
    return c["x"] >= f["x"] and c["y"] >= f["y"] and c["x"] + c["w"] <= f["x"] + f["w"] and c["y"] + c["h"] <= f["y"] + f["h"]


def overlap(a, b):
    return a["x"] < b["x"] + b["w"] and b["x"] < a["x"] + a["w"] and a["y"] < b["y"] + b["h"] and b["y"] < a["y"] + a["h"]


class BoardTemplatesTest(unittest.TestCase):
    def setUp(self):
        self.templates = load()
        self.by_id = {t["id"]: t for t in self.templates}

    def frames(self, id):
        return {o["title"]: o for o in schema.clean_objects(self.by_id[id]["objects"]) if o["type"] == "frame"}

    # --- the list itself ------------------------------------------------------------------------

    def test_ids_names_and_order(self):
        self.assertEqual([(t["id"], t["name"]) for t in self.templates], EXPECTED)

    def test_each_template_has_exactly_the_expected_fields(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                self.assertEqual(set(t), {"id", "name", "blurb", "objects"})
                self.assertIsInstance(t["objects"], list)
                self.assertTrue(t["objects"])
                blurb = t["blurb"]
                self.assertTrue(blurb.endswith(".") and 0 < len(blurb) <= 100, blurb)
                self.assertEqual(blurb.count(". "), 0, "one sentence")
                self.assertTrue(blurb[0].isupper() and blurb.isascii(), "sentence case, no emoji")

    # --- every object is valid --------------------------------------------------------------------

    def test_validates_with_clean_objects_and_loses_nothing(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                self.assertEqual([o["id"] for o in cleaned], [o["id"] for o in t["objects"]])
                self.assertEqual([o["type"] for o in cleaned], [o["type"] for o in t["objects"]])
                for raw, o in zip(t["objects"], cleaned):
                    for k in ("parent", "text", "title", "color", "shape", "from", "to"):
                        if k in raw:
                            self.assertEqual(raw[k], o[k], f"{o['id']}.{k} was changed by clean_object")
                    for k in ("by", "locked", "group"):
                        self.assertNotIn(k, raw)

    def test_ids_are_unique_and_well_formed(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                ids = [o["id"] for o in t["objects"]]
                self.assertEqual(len(ids), len(set(ids)))
                for i in ids:
                    self.assertRegex(i, schema.OBJ_ID)

    def test_connector_ends_and_parents_point_at_real_objects(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                by = {o["id"]: o for o in cleaned}
                for o in cleaned:
                    if o["type"] == "connector":
                        for k in ("from", "to"):
                            if "id" in o[k]:
                                self.assertIn(o[k]["id"], by, f"{o['id']}.{k}")
                                self.assertNotEqual(by[o[k]["id"]]["type"], "connector")
                    if "parent" in o:
                        self.assertIn(o["parent"], by, f"{o['id']}.parent")
                        self.assertEqual(by[o["parent"]]["type"], "frame")

    def test_children_lie_fully_inside_their_frame(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                by = {o["id"]: o for o in cleaned}
                for o in cleaned:
                    if "parent" in o:
                        f = by[o["parent"]]
                        self.assertTrue(inside(o, f), f"{o['id']} sticks out of {f['id']}")
                        # at least 24 px of breathing room inside the frame
                        self.assertGreaterEqual(o["x"] - f["x"], 24)
                        self.assertGreaterEqual(o["y"] - f["y"], 24)
                        self.assertGreaterEqual(f["x"] + f["w"] - (o["x"] + o["w"]), 24)
                        self.assertGreaterEqual(f["y"] + f["h"] - (o["y"] + o["h"]), 24)

    def test_every_sticky_in_a_frame_is_a_child_of_it(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                frames = [o for o in cleaned if o["type"] == "frame"]
                for o in cleaned:
                    if o["type"] == "sticky":
                        homes = [f["id"] for f in frames if inside(o, f)]
                        self.assertEqual(o.get("parent"), homes[0] if homes else None, o["id"])

    # --- layout ---------------------------------------------------------------------------------

    def test_no_two_sticky_notes_overlap(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                notes = [o for o in cleaned if o["type"] == "sticky"]
                for i, a in enumerate(notes):
                    for b in notes[i + 1:]:
                        self.assertFalse(overlap(a, b), f"{a['id']} overlaps {b['id']}")

    def test_nothing_overlaps_except_children_inside_their_frame(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                objs = boxed(cleaned)
                for i, a in enumerate(objs):
                    for b in objs[i + 1:]:
                        if not overlap(a, b):
                            continue
                        ok = (a["type"] == "frame" and b.get("parent") == a["id"]) or (b["type"] == "frame" and a.get("parent") == b["id"])
                        self.assertTrue(ok, f"{a['id']} overlaps {b['id']}")

    def test_sticky_notes_are_square_and_a_normal_size(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                for o in cleaned:
                    if o["type"] == "sticky":
                        self.assertTrue(150 <= o["w"] <= 190 and o["w"] == o["h"], o["id"])
                        self.assertNotIn("text_style", o, "stickies fit their own text")
                        self.assertIn(o["color"], schema.STICKY)

    def test_text_boxes_have_a_readable_size(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                for o in cleaned:
                    if o["type"] == "text":
                        self.assertTrue(18 <= o["text_style"]["size"] <= 40, o["id"])
                        self.assertIn(o["text_style"].get("align"), ("left", "center"))
                        self.assertTrue(o["text"].strip(), o["id"])

    def test_each_template_fits_a_screenful_and_is_centred_on_the_origin(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                x, y, w, h = schema.bbox(boxed(cleaned))
                self.assertLessEqual(w, 2400)
                self.assertLessEqual(h, 1600)
                self.assertLessEqual(abs(x + w / 2), 60, "centre x")
                self.assertLessEqual(abs(y + h / 2), 60, "centre y")

    def test_text_is_short(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                for o in cleaned:
                    for k in ("text", "title", "label"):
                        self.assertLessEqual(len(o.get(k, "")), MAX_TEXT, f"{o['id']}.{k}")

    def test_only_swatch_colours_are_used(self):
        for t in self.templates:
            with self.subTest(template=t["id"]):
                cleaned = schema.clean_objects(t["objects"])
                for o in cleaned:
                    for k in ("fill", "stroke", "color"):
                        v = o.get(k)
                        if v is not None and o["type"] != "sticky":
                            self.assertIn(v.upper(), SWATCHES, f"{o['id']}.{k}")
                    self.assertTrue(o["type"] in ("sticky", "text", "shape", "frame", "connector"), o["id"])

    # --- what each template is ------------------------------------------------------------------

    def test_brainstorm_has_a_topic_with_spokes_to_its_notes(self):
        cleaned = schema.clean_objects(self.by_id["brainstorm"]["objects"])
        by = {o["id"]: o for o in cleaned}
        notes = [o for o in cleaned if o["type"] == "sticky"]
        self.assertTrue(6 <= len(notes) <= 8)
        self.assertGreaterEqual(len([o for o in notes if o["text"]]), 3)
        self.assertGreaterEqual(len({o["color"] for o in notes}), 3)
        topics = [o for o in cleaned if o["type"] == "shape" and o["shape"] == "ellipse"]
        self.assertEqual(len(topics), 1)
        spokes = {o["to"]["id"] for o in cleaned if o["type"] == "connector" and o["from"].get("id") == topics[0]["id"]}
        self.assertEqual(spokes, {n["id"] for n in notes})
        self.assertEqual(by[topics[0]["id"]]["text"], "Topic")

    def test_matrix_has_four_named_quadrants_axes_and_examples(self):
        cleaned = schema.clean_objects(self.by_id["matrix"]["objects"])
        frames = self.frames("matrix")
        self.assertEqual(set(frames), {"Quick wins", "Big bets", "Fill-ins", "Money pits"})
        xs, ys = {f["x"] for f in frames.values()}, {f["y"] for f in frames.values()}
        self.assertEqual((len(xs), len(ys)), (2, 2), "a 2×2 grid")
        self.assertEqual({(f["w"], f["h"]) for f in frames.values()}.__len__(), 1)
        self.assertLess(frames["Quick wins"]["x"], frames["Big bets"]["x"])
        self.assertLess(frames["Quick wins"]["y"], frames["Fill-ins"]["y"])
        for f in frames.values():
            kids = [o for o in cleaned if o.get("parent") == f["id"]]
            self.assertTrue(1 <= len(kids) <= 2, f["title"])
        texts = {o["text"] for o in cleaned if o["type"] == "text"}
        self.assertTrue({"Effort", "Impact", "Low effort", "High effort", "Low impact", "High impact"} <= texts)
        axes = [o for o in cleaned if o["type"] == "connector" and "id" not in o["from"] and "id" not in o["to"]]
        self.assertEqual(len(axes), 2)
        horizontal = [a for a in axes if a["from"]["y"] == a["to"]["y"]]
        vertical = [a for a in axes if a["from"]["x"] == a["to"]["x"]]
        self.assertEqual((len(horizontal), len(vertical)), (1, 1))
        self.assertLess(horizontal[0]["from"]["x"], horizontal[0]["to"]["x"], "effort grows to the right")
        self.assertGreater(vertical[0]["from"]["y"], vertical[0]["to"]["y"], "impact grows upwards")

    def test_kanban_columns_are_level_and_evenly_spaced(self):
        cleaned = schema.clean_objects(self.by_id["kanban"]["objects"])
        frames = sorted((o for o in cleaned if o["type"] == "frame"), key=lambda f: f["x"])
        self.assertIn(len(frames), (3, 4))
        self.assertEqual([f["title"] for f in frames][:3], ["To do", "Doing", "Done"])
        self.assertEqual(len({f["y"] for f in frames}), 1)
        self.assertEqual(len({f["h"] for f in frames}), 1)
        gutters = {b["x"] - (a["x"] + a["w"]) for a, b in zip(frames, frames[1:])}
        self.assertEqual(len(gutters), 1)
        self.assertTrue(24 <= gutters.pop() <= 48)
        count = {f["title"]: len([o for o in cleaned if o.get("parent") == f["id"]]) for f in frames}
        self.assertTrue(2 <= count["To do"] <= 3 and 1 <= count["Doing"] <= 2 and count["Done"] == 1, count)

    def test_journey_has_stages_across_the_top_and_lanes_beneath(self):
        cleaned = schema.clean_objects(self.by_id["journey"]["objects"])
        lanes = sorted((o for o in cleaned if o["type"] == "frame"), key=lambda f: f["y"])
        self.assertEqual([f["title"] for f in lanes], ["Actions", "Thoughts", "Feelings", "Pain points", "Opportunities"])
        self.assertEqual(len({(f["x"], f["w"], f["h"]) for f in lanes}), 1, "lanes line up")
        stages = sorted((o for o in cleaned if o["type"] == "shape"), key=lambda s: s["x"])
        self.assertEqual([s["text"] for s in stages], ["Awareness", "Consideration", "Purchase", "Onboarding", "Loyalty"])
        self.assertEqual(len({s["y"] for s in stages}), 1)
        self.assertEqual(len({s["w"] for s in stages}), 1)
        self.assertLess(max(s["y"] + s["h"] for s in stages), lanes[0]["y"], "stage row sits above the lanes")
        pitch = {b["x"] - a["x"] for a, b in zip(stages, stages[1:])}
        self.assertEqual(len(pitch), 1)
        # a sticky sits in the middle of the column of the stage above it
        for o in cleaned:
            if o["type"] == "sticky" and o.get("parent"):
                cx = o["x"] + o["w"] / 2
                col = [s for s in stages if s["x"] <= cx <= s["x"] + s["w"]]
                self.assertEqual(len(col), 1, o["id"])
                self.assertAlmostEqual(cx, col[0]["x"] + col[0]["w"] / 2, delta=1)
        for lane in lanes:
            self.assertTrue(any(o.get("parent") == lane["id"] for o in cleaned), lane["title"])
        persona = [o for o in cleaned if o["type"] in ("sticky", "text") and o["text"].startswith("Persona")]
        self.assertEqual(len(persona), 1)
        self.assertLess(persona[0]["y"], min(s["y"] for s in stages))
        self.assertLessEqual(persona[0]["x"], min(s["x"] for s in stages))
        flow = [o for o in cleaned if o["type"] == "connector"]
        self.assertEqual(len(flow), len(stages) - 1)

    def test_empathy_has_a_user_at_the_centre_and_six_frames(self):
        cleaned = schema.clean_objects(self.by_id["empathy"]["objects"])
        frames = self.frames("empathy")
        self.assertEqual(set(frames), {"Says", "Thinks", "Does", "Feels", "Pains", "Gains"})
        user = [o for o in cleaned if o["type"] == "shape"]
        self.assertEqual([u["text"] for u in user], ["User"])
        u = user[0]
        ucx, ucy = u["x"] + u["w"] / 2, u["y"] + u["h"] / 2
        top = [frames[k] for k in ("Says", "Thinks")]
        bottom = [frames[k] for k in ("Does", "Feels")]
        self.assertEqual(len({f["y"] for f in top}), 1)
        self.assertEqual(len({f["y"] for f in bottom}), 1)
        self.assertLess(top[0]["x"], ucx)
        self.assertGreater(top[1]["x"], ucx)
        self.assertLess(top[0]["y"] + top[0]["h"], ucy + u["h"] / 2 + 1)
        self.assertGreater(bottom[0]["y"], ucy - u["h"] / 2 - 1)
        for k in ("Pains", "Gains"):
            self.assertGreater(frames[k]["y"], bottom[0]["y"] + bottom[0]["h"])
        self.assertEqual(frames["Pains"]["x"], frames["Says"]["x"])
        self.assertEqual(frames["Gains"]["x"], frames["Thinks"]["x"])
        with_notes = [f for f in frames.values() if any(o.get("parent") == f["id"] for o in cleaned)]
        self.assertGreaterEqual(len(with_notes), 4)

    def test_retro_has_four_frames_a_title_and_examples_in_each(self):
        cleaned = schema.clean_objects(self.by_id["retro"]["objects"])
        frames = self.frames("retro")
        self.assertEqual(set(frames), {"Went well", "Didn't go well", "Ideas", "Action items"})
        titles = [o for o in cleaned if o["type"] == "text"]
        self.assertEqual(len(titles), 1)
        self.assertTrue(titles[0]["text"].startswith("Retro — "))
        self.assertLessEqual(titles[0]["y"] + titles[0]["h"], min(f["y"] for f in frames.values()) - 30, "room for the frame titles")
        colors = {}
        for name, f in frames.items():
            kids = [o for o in cleaned if o.get("parent") == f["id"]]
            self.assertTrue(1 <= len(kids) <= 2, name)
            colors[name] = {k["color"] for k in kids}
            self.assertEqual(len(colors[name]), 1, f"{name} notes share a colour")
        self.assertEqual(len({next(iter(c)) for c in colors.values()}), 4, "each frame has its own colour")


if __name__ == "__main__":
    unittest.main()
