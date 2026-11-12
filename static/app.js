// recs UI. All API calls use RELATIVE urls (served under /recs/).
// Speed rules: render from the localStorage cache before the network answers, and save new
// items to a local outbox first so "Enter" is instant even offline.
"use strict";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ICON = { book: "📕", movie: "🎬", show: "📺", restaurant: "🍽️", place: "📍", podcast: "🎧", music: "🎵", game: "🎮", other: "✳️" };
const LABEL = { book: "Book", movie: "Movie", show: "Show", restaurant: "Restaurant", place: "Place", podcast: "Podcast", music: "Music", game: "Game", other: "Other" };
const TYPES = Object.keys(ICON);
// types with a "who made it" line (stored as creator); the label names it
const BY = { book: "Author" };
const PINNABLE = new Set(["place", "restaurant"]);

// Demo mode (#demo): every api call is answered by demo.js inside the browser, never the server.
// Its cache and outbox use separate storage keys, so demo data never mixes with a real account.
const DEMO = location.hash === "#demo";
const PFX = DEMO ? "recs.demo." : "recs.";
let demo = null;
try { if (DEMO) demo = RecsDemo.createDemo(localStorage); } catch {}
if (DEMO && !demo) demo = RecsDemo.createDemo({ getItem: () => null, setItem() {} });  // storage blocked: memory only

// Phones: never move focus into a text box on our own, it pops the keyboard up.
// Fields get focus when tapped, plus one deliberate case: the name box right after a type tile tap.
const TYPING = "input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]";
const finePointer = () => matchMedia("(hover: hover) and (pointer: fine)").matches;
// showModal() focuses the first field inside a dialog (the item title, a person's name...).
// The dialogs carry autofocus so the dialog itself takes focus; the blur is a fallback for older browsers.
function openDialog(d) {
  if (!d.open) d.showModal();
  const a = document.activeElement;
  if (a && d.contains(a) && a.matches(TYPING)) { a.blur(); d.focus(); }
}

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(PFX + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(PFX + k, JSON.stringify(v)); } catch {} },
};

let S = store.get("state", null);          // {people, items} from the server
let outbox = store.get("outbox", []);      // new items not yet acknowledged
let tab = "todo", mapFilter = null;
// To try list filters: who suggested it, what kind, and whether to include things already tried.
let F = { person: "", type: "", done: false };
try { F = { ...F, ...JSON.parse(sessionStorage.getItem(PFX + "filters")) }; } catch {}
const saveF = () => { try { sessionStorage.setItem(PFX + "filters", JSON.stringify(F)); } catch {} };

// ---------- api ----------

async function api(method, path, body) {
  if (DEMO) { await null; return demo.handle(method, path, body); }
  const r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  if (r.status === 401 && !path.startsWith("api/login") && !path.startsWith("api/register")) { showAuth(); throw new Error("auth"); }
  const data = r.headers.get("content-type")?.includes("json") ? await r.json() : null;
  if (!r.ok) throw Object.assign(new Error(data?.detail || "Something went wrong"), { status: r.status });
  return data;
}

function setState(s) {
  S = s; store.set("state", S); render();
}

async function mutate(method, path, body) {
  try { setState(await api(method, path, body)); }
  catch (e) { if (e.message !== "auth") toast(e.message); throw e; }
}

async function flush() {
  while (outbox.length) {
    const it = outbox[0];
    try {
      S = await api("POST", "api/items", it);
    } catch (e) {
      if (e.status >= 400 && e.status < 500 && e.status !== 401) { toast(`Couldn't save "${it.title}": ${e.message}`); }
      else break;  // offline or server down: keep it, retry later
    }
    outbox.shift(); store.set("outbox", outbox);
  }
  store.set("state", S); render();
}

// ---------- auth ----------

let registering = false;
function showAuth() {
  $("#app").hidden = true; $("#auth").hidden = false;
  try { localStorage.removeItem("recs.state"); } catch {}
  if (location.hash === "#signup") { history.replaceState(null, "", location.pathname); if (!registering) $("#auth-toggle").click(); }
  if (finePointer()) $("#auth-user").focus();  // desktop only
}
$("#auth-toggle").onclick = () => {
  registering = !registering;
  $("#auth-code").hidden = !registering;
  $("#auth-go").textContent = registering ? "Create account" : "Log in";
  $("#auth-toggle").textContent = registering ? "Have an account? Log in" : "New here? Set up an account";
  $("#auth-pass").autocomplete = registering ? "new-password" : "current-password";
};
$("#auth-demo").onclick = () => { location.hash = "demo"; location.reload(); };
$("#demo-signup").onclick = () => { location.replace(location.pathname + "#signup"); location.reload(); };
$("#demo-reset").onclick = () => {
  if (!confirm("Start the demo over with the sample data?")) return;
  outbox = []; store.set("outbox", outbox);
  setState(demo.reset()); toast("Demo reset");
};
$("#auth-form").onsubmit = async (e) => {
  e.preventDefault();
  $("#auth-err").textContent = "";
  try {
    await api("POST", registering ? "api/register" : "api/login",
      { username: $("#auth-user").value, password: $("#auth-pass").value, code: $("#auth-code").value });
    $("#auth").hidden = true;
    start();
    setState(await api("GET", "api/state"));
  } catch (err) { $("#auth-err").textContent = err.message; }
};

// ---------- add: a full-screen composer in three steps ----------
// 1. What kind? (big tiles)  2. What's it called? (places and restaurants search the map as you type)
// 3. Who suggested it? (a dropdown of everyone, recent first, with search). Then one big Save.
// The quick-add parser still helps in step 2: "Red Rising Jordan" pre-selects Jordan in step 3.

function people() { return S?.people || []; }
function personById(id) { return people().find((p) => p.id === id); }

const comp = $("#composer"), cBody = $("#c-body"), cFoot = $("#c-foot");
let C = null; // {step, type, text, title, pin, person (undefined = not chosen, null = nobody), candidates, results, query}
const STEP_NAMES = ["Type", "Name", "Who"];

function openComposer() {
  C = { step: 0, type: null, text: "", title: "", pin: null, person: undefined, candidates: [], results: null, query: "" };
  renderComposer();
  openDialog(comp);
}
$("#add-open").onclick = openComposer;
$("#c-close").onclick = () => comp.close();
$("#c-back").onclick = () => { if (C.step > 0) { C.step--; renderComposer(); } else comp.close(); };
comp.addEventListener("close", () => { C = null; dropComposerMap(); });

const isPlace = () => PINNABLE.has(C.type);
function goStep(n) { C.step = n; renderComposer(); }

function renderComposer() {
  dropComposerMap();
  $("#c-back").setAttribute("aria-label", C.step ? "Back" : "Close");
  $("#c-back").hidden = C.step === 0;
  // finished steps stay visible as big rows you can tap to change
  const done = [
    C.type && `${ICON[C.type]} ${LABEL[C.type]}`,
    C.step > 1 && C.title && `${C.pin ? "📍 " : ""}${C.title}${BY[C.type] && C.by?.trim() ? ", " + C.by.trim() : ""}`,
  ];
  $("#c-steps").innerHTML = STEP_NAMES.map((n, i) => `<li class="${i < C.step ? "done" : i === C.step ? "now" : ""}">
    ${i < C.step && done[i] ? `<button type="button" data-step="${i}"><small>${n}</small><b>${esc(done[i])}</b><span class="edit">Change</span></button>` : `<span><small>${i + 1}</small>${n}</span>`}</li>`).join("");
  if (C.step === 0) stepType();
  else if (C.step === 1) stepName();
  else stepWho();
}
$("#c-steps").onclick = (e) => { const b = e.target.closest("[data-step]"); if (b) goStep(+b.dataset.step); };

function stepType() {
  cBody.innerHTML = `<h3 class="c-q">What kind of thing?</h3>
    <div class="tiles">${TYPES.map((t) => `<button type="button" class="tile ${C.type === t ? "on" : ""}" data-type="${t}"><span aria-hidden="true">${ICON[t]}</span>${LABEL[t]}</button>`).join("")}</div>`;
  cFoot.innerHTML = "";
  cBody.onclick = (e) => { const b = e.target.closest("[data-type]"); if (!b) return; C.type = b.dataset.type; if (!isPlace()) C.pin = null; C.focusName = true; goStep(1); };
}

let searchT = null, searchN = 0;
function stepName() {
  const place = isPlace();
  cBody.innerHTML = `<h3 class="c-q">${place ? `Which ${C.type === "restaurant" ? "restaurant" : "place"}?` : `What's the ${LABEL[C.type].toLowerCase()} called?`}</h3>
    <input id="c-what" class="c-input" value="${esc(C.text)}" enterkeyhint="next" autocapitalize="sentences" autocorrect="off" spellcheck="false" autocomplete="off"
      placeholder="${place ? "Name or address" : "Title"}" aria-label="${place ? "Search for the place" : "Title"}">
    ${BY[C.type] ? `<input id="c-by" class="c-input small c-by" value="${esc(C.by || "")}" enterkeyhint="next" autocapitalize="words" autocorrect="off" spellcheck="false" autocomplete="off"
      placeholder="${BY[C.type]} (optional)" aria-label="${BY[C.type]}">` : ""}
    <p id="c-hint" class="c-hint"></p>
    ${place ? `<div id="c-map" class="c-map" hidden aria-hidden="true"></div><ul id="c-results" class="c-results" aria-live="polite"></ul>` : ""}`;
  const inp = $("#c-what"), by = $("#c-by");
  if (C.focusName) {  // only straight after a type tile tap: that tap lets iOS open the keyboard
    C.focusName = false;
    inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  }
  inp.oninput = () => { C.text = inp.value; C.pin = null; nameChanged(); };
  inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); if (by) by.focus(); else if (C.title) { C.pin = place ? C.pin : null; goStep(2); } } };
  if (by) {
    by.oninput = () => { C.by = by.value; };
    by.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); if (C.title) goStep(2); } };
  }
  cBody.onclick = (e) => {
    const b = e.target.closest("[data-r]");
    if (!b) return;
    if (b.dataset.r === "plain") { C.pin = null; C.title = C.title || C.text.trim(); }
    else return pickResult(+b.dataset.r);
    goStep(2);
  };
  if (place && !lastCoords) here().then((c) => { lastCoords = c; drawPins(); }).catch(() => {}); // bias results near you
  if (place) composerMap();
  nameChanged();
}

function pickResult(i) {
  const r = C?.results?.[i];
  if (!r) return;
  C.pin = r; C.title = r.label.split(",")[0].trim();
  goStep(2);
}

// The live map under the place search: numbered pins match the numbered rows, tap one to pick it.
// The list stays the accessible way to choose (the map is aria-hidden and its pins aren't focusable).
let cMap = null, cPins = null;
function dropComposerMap() { cMap?.remove(); cMap = cPins = null; }
async function composerMap() {
  const el = $("#c-map");
  try {
    const L = await loadLeaflet();
    if (!el.isConnected || cMap) return;
    cMap = L.map(el, { zoomControl: false, keyboard: false, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(cMap);
    cPins = L.layerGroup().addTo(cMap);
    drawPins();
  } catch { /* no map: the list still works */ }
}
function drawPins() {
  const el = $("#c-map");
  if (!cMap || !C || !el?.isConnected) return;
  const L = window.L, rs = C.results || [];
  el.hidden = !rs.length && !lastCoords;
  if (el.hidden) return;
  cMap.invalidateSize();
  cPins.clearLayers();
  if (lastCoords) L.circleMarker([lastCoords.latitude, lastCoords.longitude], { radius: 6, weight: 2, color: "#fff", fillColor: "#2f6bff", fillOpacity: 1, interactive: false }).addTo(cPins);
  rs.forEach((r, i) => L.marker([r.lat, r.lon], { keyboard: false, riseOnHover: true,
    icon: L.divIcon({ className: "c-pin", html: `<span>${i + 1}</span>`, iconSize: [32, 32], iconAnchor: [16, 16] }) })
    .on("click", () => pickResult(i)).addTo(cPins));
  if (rs.length) cMap.fitBounds(rs.map((r) => [r.lat, r.lon]), { padding: [36, 36], maxZoom: 16, animate: false });
  else cMap.setView([lastCoords.latitude, lastCoords.longitude], 14, { animate: false });
}

function nameChanged() {
  const raw = C.text.trim(), place = isPlace();
  // the parser strips a typed type word or a person's name ("Dune Sam") and remembers who for step 3
  const p = raw ? RecsParse.parse(raw, people()) : null;
  const strip = p && (p.person || p.newPerson || p.type === C.type);
  C.title = strip ? p.title : raw;
  C.candidates = p?.candidates || [];
  if (p?.person) { C.person = { id: p.person.id, name: p.person.name }; C.parsedWho = true; }
  else if (p?.newPerson) { C.person = { name: p.newPerson, isNew: true }; C.parsedWho = true; }
  else if (C.parsedWho) { C.person = undefined; C.parsedWho = false; } // the name no longer says who
  const hint = $("#c-hint"), t = C.title.toLowerCase();
  const dup = t.length > 2 && allItems().find((i) => i.title.toLowerCase() === t);
  hint.innerHTML = [C.person && strip ? `${avatar(C.person.name, C.person.isNew ? "new" : "")} From ${esc(C.person.name)}, picked next` : "",
    dup ? `Already saved: ${esc(dup.title)}${dup.person_id ? " from " + esc(personById(dup.person_id)?.name || "") : ""}` : ""].filter(Boolean).join("<br>");
  cFoot.innerHTML = place ? "" : `<button type="button" class="btn primary big" id="c-next" ${C.title ? "" : "disabled"}>Next: who suggested it</button>`;
  if (!place) { $("#c-next").onclick = () => goStep(2); return; }
  // places: live map search, debounced; stale answers are dropped
  const box = $("#c-results");
  const plain = C.title ? `<li><button type="button" data-r="plain" class="plain"><span><b>Use “${esc(C.title)}”</b><small>Save the name without a map pin</small></span></button></li>` : "";
  clearTimeout(searchT);
  if (C.title.length < 3) { box.innerHTML = plain; C.results = null; drawPins(); return; }
  if (C.query !== C.title) box.innerHTML = plain + `<li class="c-searching">Searching the map…</li>`;
  const n = ++searchN;
  searchT = setTimeout(async () => {
    try {
      const params = new URLSearchParams({ q: C.title });
      if (lastCoords) { params.set("lat", lastCoords.latitude); params.set("lon", lastCoords.longitude); }
      const res = await api("GET", "api/geocode?" + params);
      if (n !== searchN || !C || C.step !== 1) return;
      C.results = res; C.query = C.title; drawPins();
      box.innerHTML = res.map((r, i) => { const [name, ...rest] = r.label.split(", ");
        return `<li><button type="button" data-r="${i}"><span class="pin" aria-hidden="true">${i + 1}</span><span><b>${esc(name)}</b><small>${esc(rest.join(", "))}</small></span></button></li>`; }).join("")
        + (res.length ? "" : `<li class="c-searching">No map matches. Try adding the city.</li>`) + plain;
    } catch (e) {
      if (n !== searchN || !C) return;
      box.innerHTML = `<li class="c-searching">${e.message === "auth" ? "" : "Map search isn't available right now."}</li>` + plain;
    }
  }, 350);
}

function stepWho() {
  const list = () => {
    const f = C.query2 || "", fl = f.trim().toLowerCase();
    const all = [...C.candidates, ...people()].filter((p, i, a) => a.findIndex((x) => x.id === p.id) === i);
    const shown = fl ? all.filter((p) => p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(fl)) || p.name.toLowerCase().startsWith(fl)) : all;
    const sel = C.person;
    const isSel = (p) => sel && !sel.isNew && sel.id === p.id;
    const exact = fl && all.some((p) => p.name.toLowerCase() === fl);
    $("#c-people").innerHTML =
      (!fl ? `<li><button type="button" data-p="none" class="${sel === null ? "on" : ""}"><span class="av lg new">–</span><span><b>Nobody</b><small>I found it myself</small></span></button></li>` : "")
      + (fl && !exact ? `<li><button type="button" data-p="new" class="${sel?.isNew && sel.name === f.trim() ? "on" : ""}">${avatar(f, "lg new")}<span><b>Add “${esc(f.trim())}”</b><small>New person</small></span></button></li>` : "")
      + (sel?.isNew && sel.name !== f.trim() ? `<li><button type="button" data-p="keepnew" class="on">${avatar(sel.name, "lg new")}<span><b>${esc(sel.name)}</b><small>New person</small></span></button></li>` : "")
      + shown.map((p) => `<li><button type="button" data-p="${p.id}" class="${isSel(p) ? "on" : ""}" aria-pressed="${isSel(p)}">${avatar(p.name, "lg")}<span><b>${esc(p.name)}</b></span></button></li>`).join("");
    const who = sel === undefined ? "" : sel === null ? " (nobody)" : ` from ${firstName(sel.name)}`;
    cFoot.innerHTML = `<button type="button" class="btn primary big" id="c-save" ${sel === undefined ? "disabled" : ""}>Save${esc(who)}</button>`;
    $("#c-save").onclick = saveComposer;
  };
  cBody.innerHTML = `<h3 class="c-q">Who suggested it?</h3>
    <input id="c-find" class="c-input small" type="search" value="${esc(C.query2 || "")}" placeholder="Search or add a name" aria-label="Search people" autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false">
    <ul id="c-people" class="c-people"></ul>`;
  $("#c-find").oninput = (e) => { C.query2 = e.target.value; list(); };
  cBody.onclick = (e) => {
    const b = e.target.closest("[data-p]");
    if (!b) return;
    const v = b.dataset.p;
    C.parsedWho = false;
    C.person = v === "none" ? null : v === "new" ? { name: C.query2.trim(), isNew: true } : v === "keepnew" ? C.person : personById(+v);
    list();
    $("#c-save").focus();
  };
  list();
}

function saveComposer() {
  if (!C?.title || !C.type) return;
  const it = { client_id: crypto.randomUUID(), title: C.title, type: C.type, notes: "" };
  if (BY[C.type] && C.by?.trim()) it.creator = C.by.trim();
  if (C.person?.isNew) it.person_name = C.person.name; else if (C.person) it.person_id = C.person.id;
  if (C.pin) Object.assign(it, { lat: C.pin.lat, lon: C.pin.lon, place_label: C.pin.label });
  const who = C.person?.name, type = C.type;
  outbox.push(it); store.set("outbox", outbox);
  comp.close(); render();
  toast(`Saved ${ICON[type]} ${it.title}${who ? ", from " + who : ""}`, "Undo", () => undo(it.client_id));
  flush();
}

async function undo(cid) {
  const i = outbox.findIndex((x) => x.client_id === cid);
  if (i >= 0) { outbox.splice(i, 1); store.set("outbox", outbox); render(); return; }
  const it = S.items.find((x) => x.client_id === cid);
  if (it) await mutate("DELETE", `api/items/${it.id}`);
}

// ---------- lists ----------

// server items + not-yet-synced outbox items (shown immediately)
function allItems() {
  const known = new Set((S?.items || []).map((i) => i.client_id));
  const pending = outbox.filter((o) => !known.has(o.client_id)).map((o) => ({
    ...o, id: null, pending: true, created: Date.now() / 1000, tried_at: null, told_at: null,
    person_id: o.person_id ?? null, person_label: o.person_name }));
  return [...pending, ...(S?.items || [])];
}
// Each person gets a stable hue from their name, so the same friend is the same colour everywhere.
function avatar(name, cls = "") {
  const n = String(name || "").trim();
  let h = 0; for (const ch of n.toLowerCase()) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `<span class="av ${cls}" style="--h:${h}" aria-hidden="true">${esc((n[0] || "?").toUpperCase())}</span>`;
}
const personName = (it) => it.person_label || personById(it.person_id)?.name || "";
const firstName = (n) => (n || "").split(" ")[0];

function ago(ts) {
  const d = (Date.now() / 1000 - ts) / 86400;
  return d < 1 ? "today" : d < 2 ? "yesterday" : d < 30 ? `${Math.floor(d)}d ago` : new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function row(it, extra = "") {
  const who = personName(it);
  return `<li><button data-item="${it.id ?? ""}" ${it.pending ? "disabled" : ""}>
    <span class="ico" aria-hidden="true">${ICON[it.type] || ICON.other}</span>
    <span class="t"><b>${esc(it.title)}${it.creator ? `<span class="by">${esc(it.creator)}</span>` : ""}</b><small>${who ? `${avatar(who)}<span>${esc(who)},</span>` : ""}<span>${it.pending ? "syncing…" : ago(it.created)}</span>${extra ? `<span>${extra}</span>` : ""}</small></span>
  </button></li>`;
}

function render() {
  if (!S) return;
  const items = allItems();
  const toTell = items.filter((i) => i.tried_at && !i.told_at && i.person_id);
  $("#tell-n").hidden = !toTell.length; $("#tell-n").textContent = toTell.length;
  document.querySelectorAll("#tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab));
  const list = $("#list"), filters = $("#filters");
  filters.innerHTML = "";
  if (tab !== "map") $("#big-map").hidden = true;

  if (tab === "todo") {
    const pool = items.filter((i) => F.done || !i.tried_at);
    // options come from what's in the list, so no dead ends; keep a stale choice visible so it can be cleared
    const pids = new Set(pool.map((i) => i.person_id).filter(Boolean));
    if (F.person && F.person !== "none") pids.add(+F.person);
    const ppl = [...pids].map(personById).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    const types = TYPES.filter((t) => pool.some((i) => i.type === t) || t === F.type);
    const opt = (v, label, cur) => `<option value="${v}" ${String(cur) === String(v) ? "selected" : ""}>${esc(label)}</option>`;
    if (items.length) filters.innerHTML = `
      <label class="pick"><span class="sr">Who suggested it</span><select id="f-person">${opt("", "Everyone", F.person)}
        ${ppl.map((p) => opt(p.id, p.name, F.person)).join("")}${pool.some((i) => !i.person_id) || F.person === "none" ? opt("none", "Nobody (found it myself)", F.person) : ""}</select></label>
      <label class="pick"><span class="sr">Type</span><select id="f-type">${opt("", "All types", F.type)}
        ${types.map((t) => opt(t, `${ICON[t]} ${LABEL[t]}`, F.type)).join("")}</select></label>
      <label class="switch"><input id="f-done" type="checkbox" role="switch" ${F.done ? "checked" : ""}><span class="track" aria-hidden="true"></span>Done</label>`;
    const shown = pool.filter((i) => (!F.type || i.type === F.type)
      && (!F.person || (F.person === "none" ? !i.person_id : i.person_id === +F.person)));
    const filtered = F.person || F.type;
    list.innerHTML = shown.map((i) => row(i, i.tried_at ? `<span class="done-tag">tried ✓</span>` : "")).join("")
      || (filtered ? `<li class="empty"><b>Nothing matches</b><span class="muted">Try “Everyone” or “All types”.</span></li>`
        : `<li class="empty"><b>Nothing to try yet</b><span class="muted">Tap “Add a suggestion” when someone tells you about something.</span></li>`);
  } else if (tab === "tried") {
    const tried = items.filter((i) => i.tried_at).sort((a, b) => b.tried_at - a.tried_at);
    list.innerHTML = tried.map((i) => row(i, i.told_at ? `<span class="done-tag">told ✓</span>` : "")).join("") || `<li class="empty"><b>Nothing tried yet</b><span class="muted">Open something you've tried and tap “I tried it”.</span></li>`;
  } else if (tab === "tell") {
    list.innerHTML = toTell.length
      ? `<p class="muted">You tried these. Let them know.</p>` + toTell.map((i) => row(i, `<span class="tell-tag">tell ${esc(firstName(personName(i)))}</span>`)).join("")
      : `<li class="empty"><b>No one to tell</b><span class="muted">Mark something “tried” and the person who suggested it shows up here.</span></li>`;
  } else if (tab === "map") {
    const pinned = items.filter((i) => i.lat != null && i.lon != null);
    const nTried = pinned.filter((i) => i.tried_at).length, nTodo = pinned.length - nTried;
    const noPin = items.filter((i) => PINNABLE.has(i.type) && i.lat == null);
    // the chips double as the key: they show what each kind of pin looks like
    if (pinned.length) filters.innerHTML = [[null, "All", pinned.length], ["todo", "To try", nTodo], ["tried", "Tried", nTried]].map(([k, name, n]) =>
      `<button class="chip ${mapFilter === k ? "on" : ""}" data-mapf="${k ?? ""}">${k ? `<i class="key-pin ${k}" aria-hidden="true">${k === "tried" ? "✓" : ""}</i>` : ""}${name} ${n}</button>`).join("");
    list.innerHTML = (pinned.length ? "" : `<li class="empty"><b>Nothing on the map yet</b><span class="muted">Add a restaurant or place and pick it from the map search. It shows up here.</span></li>`)
      + (noPin.length ? `<p class="muted map-nopin">No pin yet. Open one to put it on the map.</p>` + noPin.map((i) => row(i)).join("") : "");
    $("#big-map").hidden = !pinned.length;
    if (pinned.length) drawBigMap(pinned.filter((i) => !mapFilter || (mapFilter === "tried") === !!i.tried_at));
  } else if (tab === "people") {
    const counts = {};
    for (const i of items) if (i.person_id) (counts[i.person_id] ||= { todo: 0, tried: 0 })[i.tried_at ? "tried" : "todo"]++;
    const ppl = [...people()].sort((a, b) => a.name.localeCompare(b.name));
    list.innerHTML = `<li><button data-import><span class="ico" aria-hidden="true">＋</span><span class="t"><b>Add or import people</b><small>Paste names or pick a contacts file (.vcf)</small></span></button></li>`
      + ppl.map((p) => `<li><button data-person="${p.id}">${avatar(p.name, "lg")}<span class="t"><b>${esc(p.name)}</b>
        <small>${counts[p.id] ? `${counts[p.id].todo} to try, ${counts[p.id].tried} tried` : "No suggestions yet"}</small></span></button></li>`).join("");
  }
}

$("#tabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) { tab = b.dataset.tab; render(); } };
$("#filters").onclick = (e) => {
  const b = e.target.closest("[data-mapf]");
  if (!b) return;
  mapFilter = b.dataset.mapf || null;
  render();
};
$("#filters").onchange = (e) => {
  const t = e.target;
  if (t.id === "f-person") F.person = t.value; else if (t.id === "f-type") F.type = t.value; else if (t.id === "f-done") F.done = t.checked; else return;
  saveF(); render();
};
$("#list").onclick = (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.item) openItem(+b.dataset.item);
  else if (b.dataset.person) openPerson(+b.dataset.person);
  else if ("import" in b.dataset) openImport();
};

// ---------- sheets ----------

const sheet = $("#sheet"), body = $("#sheet-body");
function openSheet(html) { body.innerHTML = html; openDialog(sheet); }
sheet.addEventListener("click", (e) => { if (e.target === sheet) sheet.close(); });
sheet.addEventListener("close", () => { mapState = null; });
swipeToClose(sheet);

// Pull a bottom sheet down to close it, like iOS sheets. Only when it's scrolled to the top, and not
// when the drag starts on the map (that pans the map) or in a text box.
function swipeToClose(d) {
  let y0 = null, dy = 0, t0 = 0;
  const reset = () => { d.style.transition = "transform .2s ease"; d.style.transform = ""; y0 = null; dy = 0; };
  d.addEventListener("touchstart", (e) => {
    y0 = null;
    if (e.touches.length !== 1 || d.scrollTop > 0 || e.target.closest(".leaflet-container, input, textarea, select")) return;
    y0 = e.touches[0].clientY; dy = 0; t0 = Date.now(); d.style.transition = "none";
  }, { passive: true });
  d.addEventListener("touchmove", (e) => {
    if (y0 === null) return;
    dy = e.touches[0].clientY - y0;
    if (dy <= 0) { d.style.transform = ""; if (dy < -6) y0 = null; return; }  // dragging up: let it scroll
    e.preventDefault();
    d.style.transform = `translateY(${dy}px)`;
  }, { passive: false });
  const end = () => {
    if (y0 === null) return;
    const fast = dy > 40 && dy / Math.max(1, Date.now() - t0) > 0.5;
    if (dy > 110 || fast) {
      d.style.transition = "transform .18s ease-in"; d.style.transform = "translateY(100%)";
      setTimeout(() => { d.close(); d.style.transition = "none"; d.style.transform = ""; }, 180);
      y0 = null; dy = 0;
    } else reset();
  };
  d.addEventListener("touchend", end);
  d.addEventListener("touchcancel", reset);
}

// Pass a suggestion on to a friend via the phone's share menu (or copy it where there's none).
async function shareItem(it) {
  const { title, text } = RecsShare.shareText(it);
  try {
    if (navigator.share) await navigator.share({ title, text });
    else { await navigator.clipboard.writeText(text); toast("Copied. Paste it to whoever you like."); }
  } catch (e) { if (e.name !== "AbortError") toast("Couldn't share that"); }
}

function openItem(id) {
  const it = S.items.find((i) => i.id === id);
  if (!it) return;
  const who = personName(it);
  const pin = it.lat != null;
  openSheet(`
    <div class="title-row"><input id="it-title" class="sheet-title" value="${esc(it.title)}" aria-label="Title">
      <button class="btn share" data-act="share" aria-label="Share with a friend"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>Share</button></div>
    ${BY[it.type] || it.creator ? `<input id="it-by" class="sheet-by" value="${esc(it.creator || "")}" placeholder="${BY[it.type] || "Made by"}" aria-label="${BY[it.type] || "Made by"}" autocomplete="off" autocapitalize="words" autocorrect="off" spellcheck="false">` : ""}
    <div class="row types">${TYPES.map((t) => `<button class="chip ${t === it.type ? "on" : ""}" data-settype="${t}">${ICON[t]} ${LABEL[t]}</button>`).join("")}</div>
    <div class="from">${who ? avatar(who, "lg") : `<span class="av lg new">?</span>`}<span>From</span>
      <select id="it-person" class="btn"><option value="">Nobody</option>${[...people()].sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => `<option value="${p.id}" ${p.id === it.person_id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
    <textarea id="it-notes" placeholder="${it.tried_at ? "What did you think?" : "Notes"}">${esc(it.notes)}</textarea>
    <div class="status ${it.tried_at ? "ok" : ""}">
      ${it.tried_at
        ? `<span>✓ Tried ${ago(it.tried_at)}</span><button class="btn" data-act="untry">Undo</button>`
        : `<button class="btn primary" data-act="try">I tried it</button>`}
    </div>
    ${it.tried_at && it.person_id ? `<div class="status ${it.told_at ? "ok" : ""}">
      ${it.told_at ? `<span>✓ Told ${esc(firstName(who))} ${ago(it.told_at)}</span><button class="btn" data-act="untold">Undo</button>`
        : `<button class="btn primary" data-act="tell">Tell ${esc(firstName(who))}</button><button class="btn" data-act="told">Already told</button>`}
    </div>` : ""}
    ${PINNABLE.has(it.type) ? `<div id="pin">
      ${pin ? `<div class="place"><span>📍 ${esc(it.place_label || "Pinned")}</span>
        <a class="btn" href="https://maps.apple.com/?q=${encodeURIComponent(it.title)}&ll=${it.lat},${it.lon}" target="_blank" rel="noopener">Open in Maps</a>
        <button class="btn danger" data-act="unpin">Remove</button></div>` : ""}
      <div class="row"><input id="pin-q" value="${esc(it.title)}" aria-label="Search for the place">
        <button class="btn" data-act="search">${pin ? "Move pin" : "Find on map"}</button>
        <button class="btn" data-act="here">Here</button></div>
      <div id="pin-results" class="results"></div>
      <div id="mini-map" class="mini-map" ${pin ? "" : "hidden"}></div>
    </div>` : ""}
    <div class="sheet-foot"><button class="btn danger" data-act="delete">Delete</button><span class="spacer"></span><button class="btn" data-act="close">Done</button></div>`);

  const patch = (b) => mutate("PATCH", `api/items/${id}`, b).then(() => openItem(id)).catch(() => {});
  $("#it-title").onchange = (e) => e.target.value.trim() && patch({ title: e.target.value.trim() });
  $("#it-notes").onchange = (e) => patch({ notes: e.target.value });
  if ($("#it-by")) $("#it-by").onchange = (e) => patch({ creator: e.target.value.trim() });
  $("#it-person").onchange = (e) => patch(e.target.value ? { person_id: +e.target.value } : { clear_person: true });
  if (pin) showMiniMap(it.lat, it.lon);

  body.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.settype) return patch({ type: b.dataset.settype });
    const notes = $("#it-notes")?.value;
    switch (b.dataset.act) {
      case "share": return shareItem(it);
      case "try": return patch({ tried: true, notes });
      case "untry": return patch({ tried: false });
      case "told": return patch({ told: true });
      case "untold": return patch({ told: false });
      case "tell": return tell(it, notes);
      case "unpin": return patch({ clear_pin: true });
      case "close": return sheet.close();
      case "delete":
        if (confirm(`Delete “${it.title}”?`)) { await mutate("DELETE", `api/items/${id}`); sheet.close(); }
        return;
      case "search": return searchPlace(id);
      case "here": return pinHere(id);
    }
  };
}

// "Tell Jordan": open the phone's share sheet with a ready-made message (pick Messages + Jordan).
async function tell(it, notes) {
  const who = firstName(personName(it));
  const text = `Hey ${who}! I finally tried ${it.title} — your recommendation.${notes?.trim() ? " " + notes.trim() : ""}`;
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); toast("Message copied — paste it to " + who); }
    await mutate("PATCH", `api/items/${it.id}`, { told: true });
    openItem(it.id);
  } catch (e) { if (e.name !== "AbortError") toast("Couldn't open sharing"); }
}

// ---------- map pins (Leaflet loaded only when needed) ----------

let leaflet = null, mapState = null;
function loadLeaflet() {
  return leaflet ||= new Promise((res, rej) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    const js = document.createElement("script");
    js.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    js.onload = () => res(window.L); js.onerror = () => { leaflet = null; rej(new Error("Map failed to load")); };
    document.head.append(css, js);
  });
}
async function showMiniMap(lat, lon) {
  const el = $("#mini-map");
  if (!el) return;
  el.hidden = false;
  try {
    const L = await loadLeaflet();
    if (!$("#mini-map")) return;
    const map = L.map(el, { zoomControl: false, attributionControl: true }).setView([lat, lon], 15);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
    L.marker([lat, lon]).addTo(map);
    mapState = map;
  } catch (e) { el.hidden = true; toast(e.message); }
}
// The Map tab: one pin per item that has a place. To try is a filled pin with the type's icon,
// tried is a smaller white pin with a tick. Names show beside pins once you're zoomed in.
// The map is made once and kept; it only re-fits when the set of pins changes, so a sync
// or marking something tried doesn't throw away where you'd panned to.
let bigMap = null, bigPins = null, bigKey = null;
async function drawBigMap(shown) {
  const el = $("#big-map");
  try {
    const L = await loadLeaflet();
    if (tab !== "map") return;
    if (!bigMap) {
      bigMap = L.map(el, { zoomControl: false });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(bigMap);
      bigPins = L.layerGroup().addTo(bigMap);
      bigMap.on("zoomend", () => el.classList.toggle("far", bigMap.getZoom() < 14));
    }
    bigMap.invalidateSize();
    bigPins.clearLayers();
    for (const it of shown) {
      const tried = !!it.tried_at, size = tried ? 28 : 36;
      const m = L.marker([it.lat, it.lon], { zIndexOffset: tried ? 0 : 500, riseOnHover: true,
        icon: L.divIcon({ className: `m-pin ${tried ? "tried" : ""}`, iconSize: [size, size], iconAnchor: [size / 2, size / 2],
          html: `<span aria-hidden="true">${tried ? "✓" : ICON[it.type] || ICON.other}</span><b>${esc(it.title)}</b>` }) });
      // on "add", not straight away: before the map has its first view, a marker has no element yet
      m.on("add", () => m.getElement()?.setAttribute("aria-label", `${it.title}, ${tried ? "tried" : "to try"}`));
      if (it.id) m.on("click", () => openItem(it.id));
      m.addTo(bigPins);
    }
    const key = shown.map((i) => i.client_id || i.id).sort().join();
    if (key !== bigKey && shown.length) {
      bigKey = key;
      if (shown.length === 1) bigMap.setView([shown[0].lat, shown[0].lon], 15, { animate: false });
      else bigMap.fitBounds(shown.map((i) => [i.lat, i.lon]), { padding: [44, 44], maxZoom: 16, animate: false });
    }
  } catch { el.hidden = true; toast("The map didn't load. Check your connection."); }
}
function here() {
  return new Promise((res, rej) => navigator.geolocation
    ? navigator.geolocation.getCurrentPosition((p) => res(p.coords), () => rej(new Error("Location not available")), { timeout: 8000 })
    : rej(new Error("Location not available")));
}
async function pinHere(id) {
  try {
    const c = await here();
    await mutate("PATCH", `api/items/${id}`, { lat: c.latitude, lon: c.longitude, place_label: "Pinned where I was" });
    openItem(id);
  } catch (e) { toast(e.message); }
}
let lastCoords = null;
async function searchPlace(id) {
  const query = $("#pin-q").value.trim();
  if (!query) return;
  const out = $("#pin-results");
  out.innerHTML = `<p class="muted">Searching…</p>`;
  if (!lastCoords) here().then((c) => (lastCoords = c)).catch(() => {});
  try {
    const params = new URLSearchParams({ q: query });
    if (lastCoords) { params.set("lat", lastCoords.latitude); params.set("lon", lastCoords.longitude); }
    const res = await api("GET", "api/geocode?" + params);
    out.innerHTML = res.length ? res.map((r, i) => `<button data-r="${i}">${esc(r.label)}</button>`).join("") : `<p class="muted">No matches. Try adding the city.</p>`;
    out.onclick = async (e) => {
      const b = e.target.closest("[data-r]");
      if (!b) return;
      e.stopPropagation();
      const r = res[+b.dataset.r];
      await mutate("PATCH", `api/items/${id}`, { lat: r.lat, lon: r.lon, place_label: r.label });
      openItem(id);
    };
  } catch (e) { out.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

// ---------- people ----------

function openPerson(pid) {
  const p = personById(pid);
  if (!p) return;
  const theirs = allItems().filter((i) => i.person_id === pid);
  const group = (title, xs) => xs.length ? `<div><h3 class="group">${title}</h3><ul class="plist">${xs.map((i) => row(i)).join("")}</ul></div>` : "";
  openSheet(`
    <div class="sheet-head">${avatar(p.name, "lg")}<input id="p-name" class="sheet-title" value="${esc(p.name)}" aria-label="Name"></div>
    ${group("To try", theirs.filter((i) => !i.tried_at))}
    ${group("Tried — tell them", theirs.filter((i) => i.tried_at && !i.told_at))}
    ${group("Tried and told", theirs.filter((i) => i.told_at))}
    ${theirs.length ? "" : `<p class="muted">No suggestions from ${esc(firstName(p.name))} yet.</p>`}
    <div class="sheet-foot"><button class="btn danger" data-act="del">Delete person</button><span class="spacer"></span><button class="btn" data-act="close">Done</button></div>`);
  $("#p-name").onchange = (e) => e.target.value.trim() && mutate("PATCH", `api/people/${pid}`, { name: e.target.value.trim() }).catch(() => {});
  body.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.item) return openItem(+b.dataset.item);
    if (b.dataset.act === "close") sheet.close();
    if (b.dataset.act === "del" && confirm(`Delete ${p.name}? Their suggestions stay, without a name.`)) {
      await mutate("DELETE", `api/people/${pid}`); sheet.close();
    }
  };
}

// iPhone browsers can't read contacts, so: paste names, or share contacts as a .vcf file.
function openImport() {
  openSheet(`
    <h2>Add people</h2>
    <p class="muted">One name per line. Or pick a contacts file: in the iPhone Contacts app, open a contact (or a list) → Share → Save to Files, then choose it here.</p>
    <textarea id="imp-names" placeholder="Jordan Lewis&#10;Josie Chen"></textarea>
    <input id="imp-file" type="file" accept=".vcf,text/vcard,text/x-vcard">
    <div class="sheet-foot"><span class="spacer"></span><button class="btn" data-act="close">Cancel</button><button class="btn primary" data-act="add">Add</button></div>`);
  $("#imp-file").onchange = async (e) => {
    const txt = await e.target.files[0]?.text();
    if (!txt) return;
    const names = [...txt.matchAll(/^FN[^:]*:(.+)$/gim)].map((m) => m[1].trim().replace(/\\,/g, ","));
    $("#imp-names").value = [$("#imp-names").value.trim(), ...names].filter(Boolean).join("\n");
  };
  body.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.act === "close") return sheet.close();
    if (b.dataset.act === "add") {
      const names = $("#imp-names").value.split("\n").map((s) => s.trim()).filter(Boolean);
      if (!names.length) return;
      await mutate("POST", "api/people", { names });
      toast(`Added ${names.length} ${names.length === 1 ? "person" : "people"}`);
      sheet.close();
    }
  };
}

// ---------- toast ----------

let toastTimer;
function toast(msg, action, fn) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action)}</button>` : ""}`;
  t.hidden = false;
  if (action) t.querySelector("button").onclick = () => { t.hidden = true; fn(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// ---------- boot ----------

function start() {
  $("#app").hidden = false;
  $("#demo-bar").hidden = !DEMO;
  render();
}
window.addEventListener("online", flush);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S) { flush(); api("GET", "api/state").then(setState).catch(() => {}); }
});

if (S) start();   // instant: last known list from this phone, then refresh
api("GET", "api/state").then((s) => { if (!S) start(); setState(s); flush(); }).catch(() => { if (S) toast("Offline — showing saved list"); });
