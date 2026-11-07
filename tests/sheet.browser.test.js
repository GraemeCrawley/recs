// Emulated iPhone: pulling the item sheet down closes it; a short pull snaps back; a drag on the map doesn't close it.
// Needs playwright-core (PLAYWRIGHT_CORE=path) and the .venv; skips otherwise. Runs in demo mode (no server data).
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
const PORT = 8890 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}/`;

test("item sheet: pull down to close (emulated iPhone)", { skip, timeout: 60000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "recs-sheet-"));
  const srv = spawn(uvicorn, ["main:app", "--port", String(PORT), "--host", "127.0.0.1"], {
    cwd: root, env: { ...process.env, DB_PATH: path.join(tmp, "t.db"), COOKIE_SECURE: "0" }, stdio: "ignore" });
  const browser = await pw.chromium.launch();
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
    const ctx = await browser.newContext({ ...pw.devices["iPhone 13"], hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    async function drag(x, y, dy) {
      await touch("touchStart", x, y);
      for (let s = 1; s <= 10; s++) { await touch("touchMove", x, y + (dy * s) / 10); await page.waitForTimeout(30); }
      await touch("touchEnd"); await page.waitForTimeout(400);
    }
    const open = () => page.evaluate(() => document.querySelector("#sheet").open);
    async function openItem(title) {
      await page.locator("main ul li > button", { hasText: title }).first().tap();
      await page.waitForTimeout(300);
      assert.equal(await open(), true, "sheet opened");
    }
    const top = async () => { const b = await page.locator("#sheet").boundingBox(); return { x: b.x + b.width / 2, y: b.y + 12 }; };

    await page.goto(BASE + "#demo"); await page.waitForSelector("#app:not([hidden])");

    await openItem("The Bear");
    let p = await top(); await drag(p.x, p.y, 40);
    assert.equal(await open(), true, "short pull snaps back");
    assert.equal(await page.evaluate(() => document.querySelector("#sheet").style.transform), "");
    p = await top(); await drag(p.x, p.y, 250);
    assert.equal(await open(), false, "long pull closes the sheet");

    // a place sheet has a map: dragging on the map must not close it
    await openItem("High Park");
    const map = page.locator("#sheet .leaflet-container, #sheet [id*=map]").first();
    assert.ok(await map.count(), "place sheet shows a map"); {
      await map.scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
      const m = await map.boundingBox();
      if (m) { await drag(m.x + m.width / 2, m.y + 20, 200); assert.equal(await open(), true, "dragging the map keeps the sheet open"); }
    }
  } finally {
    await browser.close(); srv.kill(); fs.rmSync(tmp, { recursive: true, force: true });
  }
});
