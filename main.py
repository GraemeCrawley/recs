"""recs — jot down suggestions people give you, and who gave them.

FastAPI JSON API + SQLite (DB_PATH). Served under a path prefix (/recs) that Traefik
strips, so the UI only uses RELATIVE urls. Static assets are served at
assets/<content-hash>/<file> (Cloudflare caches static files for 4 h, so a changed
file must get a new URL); index.html itself is never cached.
"""
import hashlib
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

DB_PATH = os.environ.get("DB_PATH", "./recs.db")
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") == "1"
COOKIE_PATH = os.environ.get("COOKIE_PATH", "/")
SETUP_CODE = os.environ.get("RECS_SETUP_CODE", "")
STATIC = Path(__file__).parent / "static"
COOKIE = "recs_session"
SESSION_DAYS = 365
AUTH_LIMIT = (10, 300)  # max FAILED auth attempts per IP per window (seconds)
TYPES = {"book", "movie", "show", "restaurant", "place", "podcast", "music", "game", "other"}

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


# ---------- db ----------

@contextmanager
def db():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA foreign_keys = ON")
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init_db():
    with db() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            pw_hash TEXT NOT NULL, created REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
            expires REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS people (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
            name TEXT NOT NULL, created REAL NOT NULL, last_used REAL NOT NULL,
            UNIQUE (user_id, name COLLATE NOCASE));
        CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
            client_id TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'other',
            person_id INTEGER REFERENCES people(id) ON DELETE SET NULL, notes TEXT NOT NULL DEFAULT '',
            tried_at REAL, told_at REAL, lat REAL, lon REAL, place_label TEXT,
            created REAL NOT NULL, updated REAL NOT NULL, UNIQUE (user_id, client_id));
        """)


init_db()


# ---------- auth ----------

def hash_pw(pw: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    return salt + "$" + hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 200_000).hex()


def check_pw(pw: str, stored: str) -> bool:
    return secrets.compare_digest(hash_pw(pw, stored.split("$")[0]), stored)


_auth_fails: dict[str, list[float]] = {}


def client_ip(request: Request) -> str:
    return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "?")


def rate_limit_auth(request: Request) -> None:
    now, (n, window) = time.time(), AUTH_LIMIT
    hits = [t for t in _auth_fails.get(client_ip(request), []) if t > now - window]
    _auth_fails[client_ip(request)] = hits
    if len(hits) >= n:
        raise HTTPException(429, "Too many attempts, wait a few minutes")


def auth_failed(request: Request, msg: str):
    _auth_fails.setdefault(client_ip(request), []).append(time.time())
    raise HTTPException(401, msg)


def start_session(resp: Response, user_id: int):
    token = secrets.token_urlsafe(32)
    with db() as c:
        c.execute("INSERT INTO sessions VALUES (?,?,?)",
                  (hashlib.sha256(token.encode()).hexdigest(), user_id, time.time() + SESSION_DAYS * 86400))
    resp.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, secure=COOKIE_SECURE,
                    samesite="lax", path=COOKIE_PATH)


def current_user(request: Request) -> int:
    token = request.cookies.get(COOKIE)
    if token:
        with db() as c:
            row = c.execute("SELECT user_id FROM sessions WHERE token_hash=? AND expires>?",
                            (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        if row:
            return row["user_id"]
    raise HTTPException(401, "Not logged in")


class Creds(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=200)
    code: str = ""


@app.post("/api/register", dependencies=[Depends(rate_limit_auth)])
def register(body: Creds, resp: Response, request: Request):
    if not SETUP_CODE or not secrets.compare_digest(body.code.strip(), SETUP_CODE):
        auth_failed(request, "Wrong setup code")
    if len(body.password) < 8:
        raise HTTPException(400, "Password needs 8+ characters")
    try:
        with db() as c:
            uid = c.execute("INSERT INTO users (username,pw_hash,created) VALUES (?,?,?)",
                            (body.username.strip(), hash_pw(body.password), time.time())).lastrowid
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Username taken")
    start_session(resp, uid)
    return {"ok": True}


@app.post("/api/login", dependencies=[Depends(rate_limit_auth)])
def login(body: Creds, resp: Response, request: Request):
    with db() as c:
        row = c.execute("SELECT id, pw_hash FROM users WHERE username=?", (body.username.strip(),)).fetchone()
    if not row or not check_pw(body.password, row["pw_hash"]):
        auth_failed(request, "Wrong username or password")
    start_session(resp, row["id"])
    return {"ok": True}


@app.post("/api/logout")
def logout(request: Request, resp: Response):
    token = request.cookies.get(COOKIE)
    if token:
        with db() as c:
            c.execute("DELETE FROM sessions WHERE token_hash=?", (hashlib.sha256(token.encode()).hexdigest(),))
    resp.delete_cookie(COOKIE, path=COOKIE_PATH)
    return {"ok": True}


# ---------- data ----------

ITEM_COLS = "id, client_id, title, type, person_id, notes, tried_at, told_at, lat, lon, place_label, created, updated"


def get_state(c, uid: int) -> dict:
    people = [dict(r) for r in c.execute(
        "SELECT id, name, last_used FROM people WHERE user_id=? ORDER BY last_used DESC", (uid,))]
    items = [dict(r) for r in c.execute(
        f"SELECT {ITEM_COLS} FROM items WHERE user_id=? ORDER BY created DESC", (uid,))]
    return {"people": people, "items": items}


@app.get("/api/state")
def state(uid: int = Depends(current_user)):
    with db() as c:
        return get_state(c, uid)


def person_for(c, uid: int, person_id: int | None, person_name: str | None) -> int | None:
    """Resolve to one of this user's people, creating by name if needed (inline 'new person')."""
    now = time.time()
    if person_name and person_name.strip():
        name = re.sub(r"\s+", " ", person_name.strip())[:80]
        c.execute("INSERT INTO people (user_id,name,created,last_used) VALUES (?,?,?,?) "
                  "ON CONFLICT (user_id, name COLLATE NOCASE) DO UPDATE SET last_used=excluded.last_used", (uid, name, now, now))
        return c.execute("SELECT id FROM people WHERE user_id=? AND name=? COLLATE NOCASE", (uid, name)).fetchone()["id"]
    if person_id is not None:
        if not c.execute("SELECT 1 FROM people WHERE id=? AND user_id=?", (person_id, uid)).fetchone():
            raise HTTPException(404, "No such person")
        c.execute("UPDATE people SET last_used=? WHERE id=?", (now, person_id))
    return person_id


class NewItem(BaseModel):
    client_id: str = Field(min_length=1, max_length=64)
    title: str = Field(min_length=1, max_length=300)
    type: str = "other"
    person_id: int | None = None
    person_name: str | None = None
    notes: str = Field("", max_length=5000)
    lat: float | None = None
    lon: float | None = None
    place_label: str | None = Field(None, max_length=300)


@app.post("/api/items")
def add_item(body: NewItem, uid: int = Depends(current_user)):
    """Idempotent on client_id: the phone's offline outbox may resend."""
    if body.type not in TYPES:
        raise HTTPException(400, "Unknown type")
    now = time.time()
    with db() as c:
        pid = person_for(c, uid, body.person_id, body.person_name)
        c.execute("INSERT INTO items (user_id,client_id,title,type,person_id,notes,lat,lon,place_label,created,updated) "
                  "VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (user_id, client_id) DO NOTHING",
                  (uid, body.client_id, body.title.strip(), body.type, pid, body.notes,
                   body.lat, body.lon, body.place_label, now, now))
        return get_state(c, uid)


class ItemPatch(BaseModel):
    title: str | None = Field(None, min_length=1, max_length=300)
    type: str | None = None
    person_id: int | None = None
    person_name: str | None = None
    clear_person: bool = False
    notes: str | None = Field(None, max_length=5000)
    tried: bool | None = None
    told: bool | None = None
    lat: float | None = None
    lon: float | None = None
    place_label: str | None = Field(None, max_length=300)
    clear_pin: bool = False


@app.patch("/api/items/{item_id}")
def edit_item(item_id: int, body: ItemPatch, uid: int = Depends(current_user)):
    if body.type is not None and body.type not in TYPES:
        raise HTTPException(400, "Unknown type")
    now = time.time()
    with db() as c:
        if not c.execute("SELECT 1 FROM items WHERE id=? AND user_id=?", (item_id, uid)).fetchone():
            raise HTTPException(404, "No such item")
        sets: dict = {"updated": now}
        for f in ("title", "type", "notes", "lat", "lon", "place_label"):
            if getattr(body, f) is not None:
                sets[f] = getattr(body, f)
        if body.person_id is not None or body.person_name:
            sets["person_id"] = person_for(c, uid, body.person_id, body.person_name)
        if body.clear_person:
            sets["person_id"] = None
        if body.clear_pin:
            sets.update(lat=None, lon=None, place_label=None)
        if body.tried is not None:
            sets["tried_at"] = now if body.tried else None
            if not body.tried:
                sets["told_at"] = None
        if body.told is not None:
            sets["told_at"] = now if body.told else None
        c.execute(f"UPDATE items SET {', '.join(k + '=?' for k in sets)} WHERE id=? AND user_id=?",
                  (*sets.values(), item_id, uid))
        return get_state(c, uid)


@app.delete("/api/items/{item_id}")
def delete_item(item_id: int, uid: int = Depends(current_user)):
    with db() as c:
        c.execute("DELETE FROM items WHERE id=? AND user_id=?", (item_id, uid))
        return get_state(c, uid)


class PeopleImport(BaseModel):
    names: list[str] = Field(max_length=5000)


@app.post("/api/people")
def add_people(body: PeopleImport, uid: int = Depends(current_user)):
    """Add/import people (typed list, or names read from a .vcf contacts export on the phone).
    Imported people get last_used=0 so they don't jump ahead of people actually used."""
    with db() as c:
        for n in body.names:
            n = re.sub(r"\s+", " ", n.strip())[:80]
            if n:
                c.execute("INSERT INTO people (user_id,name,created,last_used) VALUES (?,?,?,0) "
                          "ON CONFLICT DO NOTHING", (uid, n, time.time()))
        return get_state(c, uid)


class PersonPatch(BaseModel):
    name: str = Field(min_length=1, max_length=80)


@app.patch("/api/people/{person_id}")
def rename_person(person_id: int, body: PersonPatch, uid: int = Depends(current_user)):
    with db() as c:
        try:
            c.execute("UPDATE people SET name=? WHERE id=? AND user_id=?", (body.name.strip(), person_id, uid))
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Someone already has that name")
        return get_state(c, uid)


@app.delete("/api/people/{person_id}")
def delete_person(person_id: int, uid: int = Depends(current_user)):
    with db() as c:
        c.execute("DELETE FROM people WHERE id=? AND user_id=?", (person_id, uid))
        return get_state(c, uid)


@app.get("/api/geocode")
async def geocode(q: str, lat: float | None = None, lon: float | None = None, uid: int = Depends(current_user)):
    """Place search for map pins (Photon / OpenStreetMap). Only the place text leaves the server;
    the bias location is rounded to 2 decimals (~1 km). Never send people's names here."""
    params: dict = {"q": q[:200], "limit": 6}
    if lat is not None and lon is not None:
        params.update(lat=round(lat, 2), lon=round(lon, 2))
    try:
        async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "recs-home-app"}) as cl:
            r = await cl.get("https://photon.komoot.io/api/", params=params)
            r.raise_for_status()
    except httpx.HTTPError:
        raise HTTPException(502, "Place search unavailable")
    out = []
    for f in r.json().get("features", []):
        pr, (flon, flat) = f["properties"], f["geometry"]["coordinates"]
        bits = [pr.get("name"), pr.get("street") and " ".join(filter(None, [pr.get("housenumber"), pr["street"]])),
                pr.get("city"), pr.get("country")]
        out.append({"label": ", ".join(dict.fromkeys(b for b in bits if b)), "lat": flat, "lon": flon})
    return out


# ---------- static ----------

ASSETS = ("parse.js", "demo.js", "app.js", "style.css")


def _asset_hashes() -> dict[str, str]:
    return {n: hashlib.sha256((STATIC / n).read_bytes()).hexdigest()[:10] for n in ASSETS}


HASHES = _asset_hashes()
INDEX = (STATIC / "index.html").read_text()
for _n, _h in HASHES.items():
    INDEX = INDEX.replace(f'"{_n}"', f'"assets/{_h}/{_n}"')
NO_CACHE = {"Cache-Control": "no-cache"}


@app.get("/", response_class=HTMLResponse)
def index():
    return HTMLResponse(INDEX, headers=NO_CACHE)


@app.get("/assets/{h}/{name}")
def asset(h: str, name: str):
    if HASHES.get(name) != h:
        raise HTTPException(404)
    return FileResponse(STATIC / name, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/{name}")
def static_file(name: str):
    # manifest + icons; names are stable, so keep them out of the long-lived cache
    if not re.fullmatch(r"[a-z0-9\-]+\.(png|json|svg)", name) or not (STATIC / name).is_file():
        raise HTTPException(404)
    return FileResponse(STATIC / name, headers=NO_CACHE)
