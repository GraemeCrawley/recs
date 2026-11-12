// Demo mode must never touch the server: every api call is answered by demo.js in the browser.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createDemo, seed, KEY } = require("../static/demo.js");

const memStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };
const appSrc = fs.readFileSync(path.join(__dirname, "../static/app.js"), "utf8");

// Every api(...) call app.js makes, e.g. ["PATCH", "api/items/${id}"].
const calls = [...appSrc.matchAll(/api\("(GET|POST|PATCH|DELETE)", [`"]([^`"]+)[`"]/g)].map((m) => [m[1], m[2]]);
const mutate = [...appSrc.matchAll(/mutate\("(GET|POST|PATCH|DELETE)", [`"]([^`"]+)[`"]/g)].map((m) => [m[1], m[2]]);

test("app.js api(): demo branch returns before fetch, and fetch is used nowhere else", () => {
  const body = appSrc.slice(appSrc.indexOf("async function api("), appSrc.indexOf("function setState("));
  assert.ok(body.indexOf("if (DEMO)") >= 0 && body.indexOf("if (DEMO)") < body.indexOf("fetch("), "demo check must come first");
  assert.match(body, /if \(DEMO\) \{[^}]*return demo\.handle\(/);
  assert.equal(appSrc.split("fetch(").length - 1, 1, "only api() may call fetch");
  assert.doesNotMatch(appSrc, /XMLHttpRequest|sendBeacon|new WebSocket|EventSource/);
});

test("the demo answers every api call the app makes, including all writes", () => {
  const all = [...calls, ...mutate];
  assert.ok(all.filter(([m]) => m !== "GET").length >= 6, "found the app's write calls");
  for (const [method, p] of all) {
    const d = createDemo(memStorage());
    const s = d.state();
    const url = p.replace("${pid}", s.people[0].id).replace(/\$\{[^}]*\}/, s.items[0].id).replace(/\?$/, "?q=park");
    const body = { client_id: "t1", title: "Test", names: ["Test Person"], name: "Renamed", told: true };
    assert.doesNotThrow(() => d.handle(method, url, body), `${method} ${url}`);
  }
});

test("a full demo session never calls fetch", () => {
  const realFetch = globalThis.fetch; let fetches = 0;
  globalThis.fetch = () => { fetches++; throw new Error("network used in demo"); };
  try {
    const d = createDemo(memStorage());
    let s = d.handle("POST", "api/items", { client_id: "a", title: "Dune", type: "book", person_name: "New Friend" });
    const dune = s.items.find((i) => i.title === "Dune");
    assert.equal(s.people.find((p) => p.id === dune.person_id).name, "New Friend");
    s = d.handle("PATCH", `api/items/${dune.id}`, { tried: true });
    s = d.handle("PATCH", `api/items/${dune.id}`, { told: true, notes: "Great" });
    assert.ok(s.items.find((i) => i.id === dune.id).told_at);
    d.handle("GET", "api/geocode?q=park");
    d.handle("POST", "api/people", { names: ["A Person", "a person", " "] });
    const pid = d.state().people.find((p) => p.name === "A Person").id;
    d.handle("PATCH", `api/people/${pid}`, { name: "B Person" });
    d.handle("DELETE", `api/people/${pid}`);
    d.handle("DELETE", `api/items/${dune.id}`);
    assert.equal(fetches, 0);
  } finally { globalThis.fetch = realFetch; }
});

test("POST api/items is idempotent on client_id, like the server", () => {
  const d = createDemo(memStorage());
  const n = d.state().items.length;
  d.handle("POST", "api/items", { client_id: "x", title: "Hades", type: "game" });
  d.handle("POST", "api/items", { client_id: "x", title: "Hades", type: "game" });
  assert.equal(d.state().items.length, n + 1);
});

test("book author: saved, edited and cleared, like the server", () => {
  const d = createDemo(memStorage());
  const find = () => d.state().items.find((i) => i.client_id === "a");
  d.handle("POST", "api/items", { client_id: "a", title: "Dune", type: "book", creator: " Frank  Herbert " });
  assert.equal(find().creator, "Frank Herbert");
  d.handle("PATCH", `api/items/${find().id}`, { creator: "" });
  assert.equal(find().creator, null);
});
test("changes persist in the browser's storage only, and reset restores the sample data", () => {
  const st = memStorage();
  const d = createDemo(st);
  d.handle("POST", "api/items", { client_id: "y", title: "Kept", type: "other" });
  assert.deepEqual([...st.m.keys()], [KEY]);
  assert.ok(createDemo(st).state().items.some((i) => i.title === "Kept"), "survives a reload");
  const fresh = d.reset();
  assert.equal(fresh.items.length, seed(0).items.length);
  assert.ok(!fresh.items.some((i) => i.title === "Kept"));
});

test("unknown paths are refused, not silently sent anywhere", () => {
  assert.throws(() => createDemo(memStorage()).handle("POST", "api/register", {}), /Not available in the demo/);
});

test("renaming to an existing name is refused, like the server", () => {
  const d = createDemo(memStorage());
  const [a, b] = d.state().people;
  assert.throws(() => d.handle("PATCH", `api/people/${a.id}`, { name: b.name.toUpperCase() }), /already has that name/);
});
