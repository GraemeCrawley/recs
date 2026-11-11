const test = require("node:test");
const assert = require("node:assert");
const { shareText } = require("../static/share.js");

test("a book: title and kind", () => {
  assert.equal(shareText({ title: "Project Hail Mary", type: "book" }).text, "You should try this:\n📕 Project Hail Mary (book)");
});
test("a pinned place: address without repeating the name, plus a map link anyone can open", () => {
  const t = shareText({ title: "Test Cafe", type: "restaurant", lat: 43.6, lon: -79.4, place_label: "Test Cafe, 1 Main Street, Toronto, Canada" }).text;
  assert.equal(t.split("\n")[1], "🍽️ Test Cafe");
  assert.equal(t.split("\n")[2], "1 Main Street, Toronto, Canada");
  assert.match(t, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=Test%20Cafe%2C%201%20Main%20Street/m);
});
test("pinned 'where I was': coordinates only, no fake address", () => {
  const t = shareText({ title: "Somewhere", type: "place", lat: 43.65, lon: -79.38, place_label: "Pinned where I was" }).text;
  assert.deepEqual(t.split("\n").slice(1), ["📍 Somewhere", "https://www.google.com/maps/search/?api=1&query=43.65%2C-79.38"]);
});
test("never shares who suggested it or your notes", () => {
  const t = shareText({ title: "Dune", type: "book", person_id: 3, person_label: "Secret Friend", notes: "private note" }).text;
  assert.doesNotMatch(t, /Secret Friend|private note/);
});
