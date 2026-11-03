const test = require("node:test");
const assert = require("node:assert");
const { parse } = require("../static/parse.js");

const people = [
  { id: 1, name: "Jordan Lewis" },
  { id: 2, name: "Josie Chen" },
  { id: 3, name: "Sam Doe" },
];
const p = (t) => parse(t, people);

test("brief example: title, type, person by first name + initial", () => {
  const r = p("Red Rising Book Jordan L");
  assert.equal(r.title, "Red Rising");
  assert.equal(r.type, "book");
  assert.equal(r.person.name, "Jordan Lewis");
});
test("type after title, lowercase person", () => {
  const r = p("dune movie sam");
  assert.deepEqual([r.title, r.type, r.person.id], ["dune", "movie", 3]);
});
test("prefix ambiguity ranks candidates, first used wins", () => {
  const r = p("Pho Lien restaurant Jo");
  assert.equal(r.person.id, 1);
  assert.deepEqual(r.candidates.map((c) => c.id), [1, 2]);
});
test("last name alone", () => assert.equal(p("Severance tv Lewis").person.id, 1));
test("@ new person", () => {
  const r = p("Tartine @Kim Doe");
  assert.equal(r.title, "Tartine");
  assert.equal(r.newPerson, "Kim Doe");
});
test("from + type at end", () => {
  const r = p("Hades from Sam game");
  assert.deepEqual([r.title, r.type, r.person.id], ["Hades", "game", 3]);
});
test("from inside a title is left alone", () => {
  const r = p("Letters from Iwo Jima film");
  assert.equal(r.title, "Letters from Iwo Jima");
  assert.equal(r.type, "movie");
  assert.deepEqual([r.person, r.newPerson], [null, null]);
});
test("type at start with colon", () => {
  const r = p("Book: The Overstory");
  assert.deepEqual([r.title, r.type], ["The Overstory", "book"]);
});
test("no type, no person", () => {
  const r = p("Something good");
  assert.deepEqual([r.title, r.type, r.person, r.newPerson], ["Something good", null, null, null]);
});
test("single type word is a title, not a type", () => assert.equal(p("Bar").title, "Bar"));
test("title word is not taken as a person when it isn't a name prefix", () =>
  assert.equal(p("Red Rising").person, null));
