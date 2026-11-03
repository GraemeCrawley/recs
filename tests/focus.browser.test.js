// Real-browser check on an emulated iPhone: walk every view of the demo and of a real account and
// assert no text box has focus after navigating. Needs playwright-core (set PLAYWRIGHT_CORE to its
// path if it isn't installed here) and the .venv with uvicorn; skips otherwise.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

let pw = null;
try { pw = require(process.env.PLAYWRIGHT_CORE || "playwright-core"); } catch {}
const root = path.join(__dirname, "..");
const uvicorn = path.join(root, ".venv/bin/uvicorn");
const skip = !pw ? "playwright-core not found (set PLAYWRIGHT_CORE)" : !fs.existsSync(uvicorn) ? "no .venv" : false;

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}/`;

// What has focus, if it's something that raises the keyboard.
const typingFocus = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a && a.matches("input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]")
    ? `${a.tagName.toLowerCase()}#${a.id || a.getAttribute("aria-label") || "?"}` : null;
});

async function walk(page, where) {
  const check = async (step) => assert.equal(await typingFocus(page), null, `${where}: a text box got focus after ${step}`);
  await page.waitForSelector("#app:not([hidden])");
  await check("page load");
  for (const t of ["people", "tell", "tried", "map", "todo"]) {
    const tab = page.locator(`[data-tab="${t}"]`);
    if (await tab.count()) { await tab.tap(); await page.waitForTimeout(150); await check(`tab ${t}`); }
  }
  // every item sheet in the To try list
  const n = await page.locator("#list li button, main ul li > button").count();
  for (let i = 0; i < Math.min(n, 4); i++) {
    await page.locator("main ul li > button").nth(i).tap(); await page.waitForTimeout(150);
    await check(`opening item ${i}`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(100);
  }
  // a person sheet
  await page.locator('[data-tab="people"]').tap(); await page.waitForTimeout(150);
  const person = page.locator("main ul li > button").first();
  if (await person.count()) { await person.tap(); await page.waitForTimeout(150); await check("opening a person"); await page.keyboard.press("Escape"); }
  await page.locator('[data-tab="todo"]').tap(); await page.waitForTimeout(100);
  // add flow: Add opens the type step with no keyboard
  await page.locator("#add-open").tap(); await page.waitForTimeout(150);
  await check("tapping Add");
  // the one allowed case: a type tile tap focuses the name box
  await page.locator('[data-type="book"]').tap(); await page.waitForTimeout(150);
  assert.equal(await typingFocus(page), "input#c-name", `${where}: name box should focus after a type tile tap`);
  await page.locator("#c-name").fill("Focus Test Book");
  await page.locator("#c-next").tap(); await page.waitForTimeout(150);
  await check("going to the who step");
  await page.locator("#c-back").tap(); await page.waitForTimeout(150);
  await check("Back to the name step");
  await page.keyboard.press("Escape"); await page.waitForTimeout(100);
}

test("no text box gets focus on navigation (emulated iPhone)", { skip, timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recs-focus-"));
  const srv = spawn(uvicorn, ["main:app", "--port", String(PORT), "--host", "127.0.0.1"], {
    cwd: root, env: { ...process.env, DB_PATH: path.join(tmp, "t.db"), COOKIE_SECURE: "0", RECS_SETUP_CODE: "focus-test" }, stdio: "ignore" });
  const browser = await pw.chromium.launch();
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const ctx = await browser.newContext({ ...pw.devices["iPhone 13"], hasTouch: true, isMobile: true });
    const page = await ctx.newPage();

    // logged out: the login screen must not focus the username box on a phone
    await page.goto(BASE); await page.waitForSelector("#auth:not([hidden])");
    assert.equal(await typingFocus(page), null, "login screen focused a text box");

    // demo
    await page.locator("#auth-demo").tap();
    await walk(page, "demo");

    // real account with a few items
    await page.goto(BASE + "#signup"); await page.reload(); await page.waitForSelector("#auth:not([hidden])");
    assert.equal(await typingFocus(page), null, "sign-up screen focused a text box");
    await page.evaluate(async () => {
      const post = (u, b) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
      await post("api/register", { username: "focustest", password: "focus-pass-1", code: "focus-test" });
      await post("api/items", { client_id: "1", title: "Dune", type: "book", person_name: "Test Person" });
      await post("api/items", { client_id: "2", title: "Test Park", type: "place", lat: 43.6, lon: -79.4, place_label: "Test Park" });
    });
    await page.goto(BASE); await page.reload();
    await walk(page, "real app");
  } finally {
    await browser.close(); srv.kill(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
