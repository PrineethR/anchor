"""The Firestore security rules, run against the local emulator.

Skipped unless the emulator is up (it sets FIRESTORE_EMULATOR_HOST). Run the lot with:

    npx firebase-tools emulators:exec --only firestore --project demo-anchor-notes \
        ".venv/bin/python -m unittest tests.test_cloud_rules"
"""

import os
import unittest
import uuid

from sense.cloud.client import EmulatorAuth, Firestore, FirestoreError, UserAuth

PROJECT = "demo-anchor-notes"
EMULATOR = bool(os.environ.get("FIRESTORE_EMULATOR_HOST"))
U = "me" + uuid.uuid4().hex[:8]   # a fresh person each run, so what an earlier run left in the emulator cannot matter


def as_user(uid, email="me@example.com", **kw):
    return Firestore(PROJECT, UserAuth(uid, email, **kw))


@unittest.skipUnless(EMULATOR, "needs the Firestore emulator")
class RulesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.admin = Firestore(PROJECT, EmulatorAuth())
        cls.admin.set("allowed/me@example.com", {"ok": True})
        cls.admin.set(f"users/{U}/pages/p1", {"title": "Mine"})
        cls.admin.set("users/other1/pages/p1", {"title": "Theirs"})
        cls.admin.set(f"users/{U}/profile/default", {"fixes": []})
        cls.admin.set(f"users/{U}/state/mac", {"seen": 1})

    def denied(self, fn):
        with self.assertRaises(FirestoreError) as cm:
            fn()
        self.assertEqual(cm.exception.status, 403, cm.exception)

    def test_nobody_signed_out_gets_anything(self):
        anon = Firestore(PROJECT, UserAuth("nobody"))  # a token with no email, not a verified account
        self.denied(lambda: anon.get(f"users/{U}/pages/p1"))
        self.denied(lambda: anon.set(f"users/{U}/pages/p2", {"title": "x"}))
        self.denied(lambda: anon.list(f"users/{U}/pages"))

    def test_you_can_read_and_write_your_own_pages(self):
        me = as_user(U)
        self.assertEqual(me.get(f"users/{U}/pages/p1")["title"], "Mine")
        me.set(f"users/{U}/pages/p2", {"title": "New"})
        me.update(f"users/{U}/pages/p2", {"title": "Renamed"})
        self.assertEqual(me.get(f"users/{U}/pages/p2")["title"], "Renamed")
        self.assertEqual({d["_id"] for d in me.list(f"users/{U}/pages")} >= {"p1", "p2"}, True)
        me.set(f"users/{U}/pages/p2/files/flat", {"bytes": b"\xff\xd8"})
        me.set(f"users/{U}/notebooks/n1", {"title": "A notebook", "rev": 1})
        me.delete(f"users/{U}/pages/p2")

    def test_you_cannot_touch_somebody_elses(self):
        me = as_user(U)
        self.denied(lambda: me.get("users/other1/pages/p1"))
        self.denied(lambda: me.list("users/other1/pages"))
        self.denied(lambda: me.set("users/other1/pages/p9", {"title": "planted"}))
        self.denied(lambda: me.delete("users/other1/pages/p1"))

    def test_a_signed_in_stranger_who_is_not_on_the_list_gets_nothing(self):
        stranger = as_user(U, "stranger@example.com")  # same uid path, wrong email
        self.denied(lambda: stranger.get(f"users/{U}/pages/p1"))
        self.denied(lambda: stranger.set(f"users/{U}/pages/p3", {"title": "x"}))

    def test_an_unverified_email_is_not_enough(self):
        unverified = as_user(U, "me@example.com", verified=False)
        self.denied(lambda: unverified.get(f"users/{U}/pages/p1"))

    def test_the_list_matches_email_case_insensitively(self):
        shouty = as_user(U, "Me@Example.com")
        self.assertEqual(shouty.get(f"users/{U}/pages/p1")["title"], "Mine")

    def test_a_notebook_only_moves_forward_one_revision_at_a_time(self):
        me = as_user(U)
        me.set(f"users/{U}/notebooks/n9", {"title": "Book", "rev": 1})
        me.set(f"users/{U}/notebooks/n9", {"title": "Book", "rev": 2})                    # the next revision: fine
        self.denied(lambda: me.set(f"users/{U}/notebooks/n9", {"title": "Stale", "rev": 2}))   # a device that missed rev 2
        self.denied(lambda: me.set(f"users/{U}/notebooks/n9", {"title": "Skip", "rev": 9}))
        self.assertEqual(me.get(f"users/{U}/notebooks/n9")["title"], "Book")
        self.denied(lambda: me.set(f"users/{U}/notebooks/n10", {"title": "Born at 5", "rev": 5}))
        me.set(f"users/{U}/notebooks/n9/parts/body", {"itemsJson": "[]", "rev": 2})        # its parts follow the small part
        me.set(f"users/{U}/notebooks/n9/files/p.jpg", {"bytes": b"x"})
        me.delete(f"users/{U}/notebooks/n9")

    def test_nobody_can_edit_the_allow_list(self):
        me = as_user(U)
        self.denied(lambda: me.set("allowed/stranger@example.com", {"ok": True}))
        self.denied(lambda: me.delete("allowed/me@example.com"))
        self.denied(lambda: me.list("allowed"))
        self.assertEqual(me.get("allowed/me@example.com"), {"ok": True})        # you can ask about yourself
        self.denied(lambda: me.get("allowed/stranger@example.com"))             # and only yourself

    def test_what_the_mac_writes_is_read_only_from_the_site(self):
        me = as_user(U)
        self.assertEqual(me.get(f"users/{U}/profile/default"), {"fixes": []})
        self.assertEqual(me.get(f"users/{U}/state/mac"), {"seen": 1})
        self.denied(lambda: me.set(f"users/{U}/profile/default", {"fixes": ["x"]}))
        self.denied(lambda: me.set(f"users/{U}/state/mac", {"seen": 2}))
        me.set(f"users/{U}/profileEdits/e1", {"forget": ["x"]})  # but you can ask for a change

    def test_your_top_document_only_says_who_you_are(self):
        me = as_user(U)
        me.set(f"users/{U}", {"email": "me@example.com"})
        self.denied(lambda: me.set(f"users/{U}", {"email": "someone@else.com"}))
        self.denied(lambda: me.set(f"users/{U}", {"email": "me@example.com", "admin": True}))
        self.denied(lambda: me.delete(f"users/{U}"))

    def test_no_collection_outside_the_plan_is_open(self):
        me = as_user(U)
        self.denied(lambda: me.set(f"users/{U}/stuff/x", {"a": 1}))
        self.denied(lambda: me.set("elsewhere/x", {"a": 1}))
        self.denied(lambda: me.get("elsewhere/x"))


if __name__ == "__main__":
    unittest.main()
