// Demo mode ("See how it works" on the login screen): a stand-in for the server that runs
// entirely in the browser. It answers the same api paths as main.py, on made-up sample data
// kept in localStorage under its own key. Nothing here touches the network, so a visitor
// can never reach the database or anyone's real data. Pure, tested by tests/demo.test.js.
(function (root) {
  const KEY = "recs.demo.db";
  const DAY = 86400;

  // Made-up people and suggestions. Places are fake, scattered around downtown Toronto.
  function seed(now) {
    const people = ["Jordan Lewis", "Josie Chen", "Sam Doe", "Kim Doe", "Priya Shah"]
      .map((name, i) => ({ id: i + 1, name, last_used: now - i * DAY }));
    let id = 0;
    const item = (title, type, person_id, daysAgo, extra = {}) => ({
      id: ++id, client_id: "demo-" + id, title, creator: null, type, person_id, notes: "", tried_at: null, told_at: null,
      lat: null, lon: null, place_label: null, created: now - daysAgo * DAY, updated: now - daysAgo * DAY, ...extra });
    const items = [
      item("Little Blue Cafe", "restaurant", 4, 1, { lat: 43.6652, lon: -79.3851, place_label: "Little Blue Cafe, Toronto" }),
      item("99% Invisible", "podcast", 2, 2, { notes: "Start with the episode on parking" }),
      item("High Park", "place", 1, 3, { lat: 43.6465, lon: -79.4637, place_label: "High Park, Toronto" }),
      item("Corner Noodle Bar", "restaurant", 3, 4, { lat: 43.6545, lon: -79.4012, place_label: "Corner Noodle Bar, Toronto" }),
      item("The Bear", "show", 2, 6),
      item("Project Hail Mary", "book", 1, 9, { creator: "Andy Weir", notes: "Said the audiobook is even better" }),
      item("Paddington 2", "movie", 4, 12, { tried_at: now - 2 * DAY, notes: "Lovely. Kim was right." }),
      item("Hades", "game", 3, 20, { tried_at: now - 8 * DAY, told_at: now - 7 * DAY }),
      item("Green Fig Bakery", "restaurant", 5, 25, { lat: 43.6481, lon: -79.3958, place_label: "Green Fig Bakery, Toronto",
        tried_at: now - 10 * DAY, told_at: now - 10 * DAY }),
    ];
    return { people, items, nextPerson: people.length + 1, nextItem: id + 1 };
  }

  // Fake map search results, so place search works in the demo without leaving the browser.
  const PLACES = [
    ["Harbourfront Park, Toronto", 43.6387, -79.3817], ["Lakeside Diner, Toronto", 43.6426, -79.3871],
    ["Maple Street Market, Toronto", 43.6532, -79.3832], ["Riverside Tacos, Toronto", 43.6596, -79.3488],
    ["Old Mill Gardens, Toronto", 43.6495, -79.4943],
  ];

  function err(status, message) { return Object.assign(new Error(message), { status }); }
  const clean = (s) => String(s).trim().replace(/\s+/g, " ").slice(0, 80);
  const copy = (x) => JSON.parse(JSON.stringify(x));

  function createDemo(storage, clock = () => Date.now() / 1000) {
    const load = () => { try { return JSON.parse(storage.getItem(KEY)); } catch { return null; } };
    const save = () => { try { storage.setItem(KEY, JSON.stringify(db)); } catch {} };
    let db = load() || seed(clock());

    function state() {
      return copy({
        people: [...db.people].sort((a, b) => b.last_used - a.last_used),
        items: [...db.items].sort((a, b) => b.created - a.created),
      });
    }
    const findItem = (id) => db.items.find((i) => i.id === id) || (() => { throw err(404, "No such item"); })();

    // Same rules as person_for() in main.py: a name creates (or reuses) a person.
    function personFor(person_id, person_name) {
      const now = clock();
      if (person_name && person_name.trim()) {
        const name = clean(person_name);
        let p = db.people.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!p) db.people.push(p = { id: db.nextPerson++, name, last_used: now });
        p.last_used = now;
        return p.id;
      }
      if (person_id != null) {
        const p = db.people.find((x) => x.id === person_id);
        if (!p) throw err(404, "No such person");
        p.last_used = now;
      }
      return person_id ?? null;
    }

    function handle(method, path, body = {}) {
      const [route, query] = path.split("?");
      const parts = route.split("/");           // ["api", "items", "3"]
      const id = parts[2] !== undefined ? +parts[2] : null;
      const now = clock();
      const key = method + " " + parts.slice(0, 2).join("/") + (id !== null ? "/:id" : "");

      switch (key) {
        case "GET api/state": return state();
        case "GET api/geocode": {
          const q = (new URLSearchParams(query).get("q") || "").toLowerCase();
          const words = q.split(/\s+/).filter((w) => w.length > 2);
          return PLACES.filter(([label]) => words.some((w) => label.toLowerCase().includes(w)))
            .map(([label, lat, lon]) => ({ label, lat, lon }));
        }
        case "POST api/items": {
          if (!db.items.some((i) => i.client_id === body.client_id)) {
            db.items.push({ id: db.nextItem++, client_id: body.client_id, title: String(body.title).trim(),
              creator: body.creator ? clean(body.creator) || null : null, type: body.type || "other", person_id: personFor(body.person_id, body.person_name), notes: body.notes || "",
              tried_at: null, told_at: null, lat: body.lat ?? null, lon: body.lon ?? null,
              place_label: body.place_label ?? null, created: now, updated: now });
          }
          break;
        }
        case "PATCH api/items/:id": {
          const it = findItem(id);
          for (const f of ["title", "type", "notes", "lat", "lon", "place_label"]) if (body[f] != null) it[f] = body[f];
          if (body.creator != null) it.creator = clean(body.creator) || null;
          if (body.person_id != null || body.person_name) it.person_id = personFor(body.person_id, body.person_name);
          if (body.clear_person) it.person_id = null;
          if (body.clear_pin) Object.assign(it, { lat: null, lon: null, place_label: null });
          if (body.tried != null) { it.tried_at = body.tried ? now : null; if (!body.tried) it.told_at = null; }
          if (body.told != null) it.told_at = body.told ? now : null;
          it.updated = now;
          break;
        }
        case "DELETE api/items/:id": db.items = db.items.filter((i) => i.id !== id); break;
        case "POST api/people":
          for (const n of body.names || []) {
            const name = clean(n);
            if (name && !db.people.some((p) => p.name.toLowerCase() === name.toLowerCase()))
              db.people.push({ id: db.nextPerson++, name, last_used: 0 });
          }
          break;
        case "PATCH api/people/:id": {
          const name = clean(body.name || "");
          if (db.people.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) throw err(409, "Someone already has that name");
          const p = db.people.find((x) => x.id === id);
          if (p && name) p.name = name;
          break;
        }
        case "DELETE api/people/:id":
          db.people = db.people.filter((p) => p.id !== id);
          for (const it of db.items) if (it.person_id === id) it.person_id = null;
          break;
        default: throw err(404, "Not available in the demo");
      }
      save();
      return state();
    }

    function reset() { db = seed(clock()); save(); return state(); }
    return { handle, reset, state };
  }

  const api = { createDemo, seed, KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RecsDemo = api;
})(typeof window !== "undefined" ? window : globalThis);
