/**
 * Two-browser online smoke test. Requires a dev room server on :8787 and the
 * Vite dev server on :5173 (the proxy forwards /api and /ws).
 *
 *   node scripts/smoke-online.mjs
 */

import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:5173";
const errors = [];

function watch(page, label) {
  page.on("console", (message) => {
    if (message.type() === "error") {
      const text = `[${label}] console: ${message.text()}`;
      errors.push(text);
      console.error(text);
      console.error(text);
    }
  });
  page.on("pageerror", (error) => {
    const text = `[${label}] pageerror: ${error.message}`;
    errors.push(text);
    console.error(text);
  });
}

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  const host = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  watch(host, "host");
  await host.goto(base, { waitUntil: "networkidle" });
  await host.waitForSelector(".brand h1", { timeout: 20_000 });
  await host.getByRole("button", { name: /Play online/ }).click();
  await host.locator('input[name="name"]').fill("Hostess");
  await host.getByRole("button", { name: "Create room" }).click();
  await host.waitForSelector(".code", { timeout: 15_000 });
  const code = (await host.locator(".code").first().textContent())?.trim() ?? "";
  console.log(`room ${code}`);
  if (!/^[A-Z0-9]{4,8}$/.test(code)) throw new Error(`bad room code: ${code}`);
  await host.waitForSelector(".slot-list", { timeout: 10_000 });

  const guest = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  watch(guest, "guest");
  await guest.goto(`${base}/?room=${code}`, { waitUntil: "networkidle" });
  await guest.locator('input[name="name"]').waitFor({ timeout: 20_000 });
  await guest.locator('input[name="name"]').fill("Guest");
  await guest.getByRole("button", { name: "Join" }).click();
  await guest.waitForSelector(".slot-list", { timeout: 15_000 });
  console.log("host lobby:", (await host.locator(".slot-list").innerText()).replace(/\s+/g, " "));
  console.log("guest lobby:", (await guest.locator(".slot-list").innerText()).replace(/\s+/g, " "));
  // Pick a palette the host is not using.
  const free = guest.locator('.swatch:not([data-taken="true"])').first();
  await free.click();
  await host.waitForSelector(".slot-list", { timeout: 10_000 });

  await host.getByRole("button", { name: "I'm ready" }).click();
  await guest.getByRole("button", { name: "I'm ready" }).click();
  await host.getByRole("button", { name: "Start game" }).click();

  await host.waitForSelector("#game-chip", { timeout: 15_000 });
  await guest.waitForSelector("#game-chip", { timeout: 15_000 });
  console.log("both in game");

  await host.reload({ waitUntil: "networkidle" });
  console.log("after reload", host.url(), await host.evaluate(() => Object.keys(sessionStorage)));
  try {
    await host.waitForSelector("#game-chip", { timeout: 15_000 });
  } catch (error) {
    console.error("reload UI:", (await host.locator("#ui").innerText()).slice(0, 300));
    throw error;
  }
  await host.waitForTimeout(800);
  await host.screenshot({ path: "smoke-online-host.png" });
  console.log("mid-round reload reconnected");

  await host.waitForSelector("text=Results", { timeout: 30_000 });
  await guest.waitForSelector("text=Results", { timeout: 30_000 });
  console.log("both saw results");

  const hostScore = await host.locator(".result-percent").first().textContent();
  const guestScore = await guest.locator(".result-percent").first().textContent();
  console.log(`host sees ${hostScore}, guest sees ${guestScore}`);

  if (errors.length) {
    console.error("ERRORS:\n" + errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("no console/page errors");
  }
} finally {
  await browser.close();
}
