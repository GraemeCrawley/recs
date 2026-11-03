// Phones: no text box may grab focus when a page or view opens (it pops the keyboard up).
// Source rules, always run. tests/focus.browser.test.js checks the same thing in a real (emulated) phone browser.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const read = (f) => fs.readFileSync(path.join(__dirname, "../static", f), "utf8");
const app = read("app.js"), html = read("index.html");

test("dialogs only open through openDialog(), which keeps focus out of text boxes", () => {
  const calls = app.split("\n").filter((l) => l.includes("showModal(") && !l.trim().startsWith("//"));
  assert.deepEqual(calls.map((l) => l.trim()), ["if (!d.open) d.showModal();"]);
  for (const id of ["composer", "sheet"]) assert.match(html, new RegExp(`<dialog id="${id}"[^>]*\\bautofocus\\b`));
});

test("no autofocus attribute on any field", () => {
  for (const src of [html, app]) {
    const tags = [...src.matchAll(/<(input|textarea|select)\b[^>]*>/g)].map((m) => m[0]);
    assert.deepEqual(tags.filter((t) => /\bautofocus\b/.test(t)), []);
  }
});

test("every .focus() on a field is guarded (desktop only, or straight after a type tile tap)", () => {
  const lines = app.split("\n").filter((l) => /\.focus\(\)/.test(l)).map((l) => l.trim());
  const allowed = [
    /^if \(finePointer\(\)\) \$\("#auth-user"\)\.focus\(\);/,                    // login: desktop only
    /^inp\.focus\(\); inp\.setSelectionRange/,                                     // name box, inside if (C.focusName)
    /^\$\("#c-save"\)\.focus\(\);/,                                                // a button, no keyboard
    /^if \(a && d\.contains\(a\) && a\.matches\(TYPING\)\) \{ a\.blur\(\); d\.focus\(\); \}/, // focus the dialog itself
  ];
  for (const l of lines) assert.ok(allowed.some((r) => r.test(l)), "unexpected focus(): " + l);
  const i = app.indexOf("inp.focus();");
  assert.match(app.slice(i - 200, i), /if \(C\.focusName\) \{[^}]*C\.focusName = false;\s*$/);
});
