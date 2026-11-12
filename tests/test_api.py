import os
import tempfile
import unittest

os.environ["DB_PATH"] = tempfile.mktemp(suffix=".db")
os.environ["RECS_SETUP_CODE"] = "letmein"
os.environ["COOKIE_SECURE"] = "0"

from fastapi.testclient import TestClient  # noqa: E402

import main  # noqa: E402


def client(username="alice"):
    c = TestClient(main.app)
    r = c.post("/api/register", json={"username": username, "password": "password1", "code": "letmein"})
    assert r.status_code == 200, r.text
    return c


class AuthTest(unittest.TestCase):
    def test_everything_private_without_login(self):
        c = TestClient(main.app)
        for path in ("/api/state", "/api/geocode?q=x"):
            self.assertEqual(c.get(path).status_code, 401)
        self.assertEqual(c.post("/api/items", json={"client_id": "a", "title": "x"}).status_code, 401)

    def test_signup_needs_setup_code(self):
        c = TestClient(main.app)
        r = c.post("/api/register", json={"username": "eve", "password": "password1", "code": "nope"})
        self.assertEqual(r.status_code, 401)

    def test_login_logout(self):
        client("loginuser")
        c = TestClient(main.app)
        self.assertEqual(c.post("/api/login", json={"username": "loginuser", "password": "bad"}).status_code, 401)
        self.assertEqual(c.post("/api/login", json={"username": "LoginUser", "password": "password1"}).status_code, 200)
        self.assertEqual(c.get("/api/state").status_code, 200)
        c.post("/api/logout")
        self.assertEqual(c.get("/api/state").status_code, 401)


class ItemsTest(unittest.TestCase):
    def test_add_with_new_person_is_idempotent(self):
        c = client("items1")
        body = {"client_id": "c1", "title": "Red Rising", "type": "book", "person_name": "Jordan Lewis"}
        c.post("/api/items", json=body)
        s = c.post("/api/items", json=body).json()  # outbox resend
        self.assertEqual(len(s["items"]), 1)
        self.assertEqual(s["people"][0]["name"], "Jordan Lewis")
        self.assertEqual(s["items"][0]["person_id"], s["people"][0]["id"])
        # same name, different case -> same person
        s = c.post("/api/items", json={"client_id": "c2", "title": "Dune", "person_name": "jordan lewis"}).json()
        self.assertEqual(len(s["people"]), 1)

    def test_tried_and_told_flow(self):
        c = client("items2")
        s = c.post("/api/items", json={"client_id": "x", "title": "Tartine", "type": "restaurant", "person_name": "Sam"}).json()
        iid = s["items"][0]["id"]
        it = c.patch(f"/api/items/{iid}", json={"tried": True, "notes": "great bread"}).json()["items"][0]
        self.assertIsNotNone(it["tried_at"])
        self.assertEqual(it["notes"], "great bread")
        it = c.patch(f"/api/items/{iid}", json={"told": True, "lat": 43.65, "lon": -79.38, "place_label": "Here"}).json()["items"][0]
        self.assertIsNotNone(it["told_at"])
        self.assertEqual(it["lat"], 43.65)
        it = c.patch(f"/api/items/{iid}", json={"tried": False, "clear_pin": True}).json()["items"][0]
        self.assertIsNone(it["told_at"])
        self.assertIsNone(it["lat"])

    def test_users_cannot_see_or_touch_each_others_data(self):
        a, b = client("alice"), client("bob")
        s = a.post("/api/items", json={"client_id": "p", "title": "Secret", "person_name": "Private Person"}).json()
        iid, pid = s["items"][0]["id"], s["people"][0]["id"]
        self.assertEqual(b.get("/api/state").json(), {"people": [], "items": []})
        self.assertEqual(b.patch(f"/api/items/{iid}", json={"title": "hacked"}).status_code, 404)
        self.assertEqual(b.post("/api/items", json={"client_id": "q", "title": "x", "person_id": pid}).status_code, 404)
        b.delete(f"/api/items/{iid}")
        b.delete(f"/api/people/{pid}")
        s = a.get("/api/state").json()
        self.assertEqual((s["items"][0]["title"], len(s["people"])), ("Secret", 1))

    def test_import_people_and_delete_keeps_items(self):
        c = client("items3")
        s = c.post("/api/people", json={"names": ["Josie Chen", " ", "Josie Chen", "Sam Doe"]}).json()
        self.assertEqual(sorted(p["name"] for p in s["people"]), ["Josie Chen", "Sam Doe"])
        pid = s["people"][0]["id"]
        c.post("/api/items", json={"client_id": "z", "title": "Hades", "type": "game", "person_id": pid})
        s = c.delete(f"/api/people/{pid}").json()
        self.assertIsNone(s["items"][0]["person_id"])

    def test_add_place_with_pin(self):
        c = client("items5")
        s = c.post("/api/items", json={"client_id": "m", "title": "Test Cafe", "type": "restaurant",
                                       "lat": 43.65, "lon": -79.4, "place_label": "Test Cafe, Toronto"}).json()
        it = s["items"][0]
        self.assertEqual((it["lat"], it["lon"], it["place_label"]), (43.65, -79.4, "Test Cafe, Toronto"))

    def test_book_author_add_edit_clear(self):
        c = client("items6")
        it = c.post("/api/items", json={"client_id": "b", "title": "Dune", "type": "book", "creator": "  Frank   Herbert "}).json()["items"][0]
        self.assertEqual(it["creator"], "Frank Herbert")
        it = c.patch(f"/api/items/{it['id']}", json={"creator": "F. Herbert"}).json()["items"][0]
        self.assertEqual(it["creator"], "F. Herbert")
        it = c.patch(f"/api/items/{it['id']}", json={"notes": "x"}).json()["items"][0]
        self.assertEqual(it["creator"], "F. Herbert")  # untouched when not sent
        it = c.patch(f"/api/items/{it['id']}", json={"creator": ""}).json()["items"][0]
        self.assertIsNone(it["creator"])

    def test_old_database_gets_creator_column(self):
        import sqlite3
        old = tempfile.mktemp(suffix=".db")
        with sqlite3.connect(old) as db:  # items table as it was before the author field
            db.execute("CREATE TABLE items (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, client_id TEXT NOT NULL, "
                       "title TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'other', person_id INTEGER, notes TEXT NOT NULL DEFAULT '', "
                       "tried_at REAL, told_at REAL, lat REAL, lon REAL, place_label TEXT, created REAL NOT NULL, "
                       "updated REAL NOT NULL, UNIQUE (user_id, client_id))")
            db.execute("INSERT INTO items (user_id,client_id,title,created,updated) VALUES (1,'o','Old',0,0)")
        saved, main.DB_PATH = main.DB_PATH, old
        try:
            main.init_db()
            main.init_db()  # twice: must not try to add it again
            with sqlite3.connect(old) as db:
                self.assertEqual(db.execute("SELECT title, creator FROM items").fetchall(), [("Old", None)])
        finally:
            main.DB_PATH = saved
            os.remove(old)

    def test_bad_type_rejected(self):
        c = client("items4")
        self.assertEqual(c.post("/api/items", json={"client_id": "t", "title": "x", "type": "spaceship"}).status_code, 400)


class StaticTest(unittest.TestCase):
    def test_index_uses_hashed_assets_and_is_not_cached(self):
        c = TestClient(main.app)
        r = c.get("/")
        self.assertEqual(r.headers["cache-control"], "no-cache")
        for name, h in main.HASHES.items():
            self.assertIn(f'"assets/{h}/{name}"', r.text)
            a = c.get(f"/assets/{h}/{name}")
            self.assertEqual(a.status_code, 200)
            self.assertIn("immutable", a.headers["cache-control"])
        self.assertEqual(c.get("/assets/stale/app.js").status_code, 404)
        self.assertEqual(c.get("/manifest.json").status_code, 200)
        self.assertEqual(c.get("/health").json(), {"ok": True})
        self.assertEqual(c.get("/main.py").status_code, 404)


if __name__ == "__main__":
    unittest.main()
