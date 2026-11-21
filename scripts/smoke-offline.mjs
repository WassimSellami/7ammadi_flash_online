/**
 * PWA offline smoke test against the built preview (port 4173).
 *   node scripts/smoke-offline.mjs
 */

import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:4173";
const errors = [];
const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});

try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("pageerror:", error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
      console.error("console:", message.text());
    }
  });
  page.on("requestfailed", (request) => {
    console.error("requestfailed:", request.url(), request.failure()?.errorText);
  });

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".brand h1", { timeout: 20_000 });
  const controlled = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    return Boolean(registration.active);
  });
  console.log("service worker active:", controlled);
  if (!controlled) throw new Error("service worker not active");
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {
    timeout: 20_000,
  });
  console.log("page controlled by service worker");

  // Give the precache a moment to settle, then go offline.
  await page.waitForTimeout(1500);
  const cacheReport = await page.evaluate(async () => {
    const names = await caches.keys();
    const report = [];
    for (const name of names) {
      const cache = await caches.open(name);
      const keys = await cache.keys();
      report.push({
        name,
        count: keys.length,
        hasIndex: keys.some(
          (request) =>
            new URL(request.url).pathname.startsWith("/assets/index-") &&
            new URL(request.url).pathname.endsWith(".js"),
        ),
        sample: keys.slice(0, 3).map((request) => new URL(request.url).pathname),
      });
    }
    return report;
  });
  console.log("caches:", JSON.stringify(cacheReport));
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".brand h1", { timeout: 20_000 });
  console.log("offline reload ok");

  await page.getByRole("button", { name: /Solo score attack/ }).click();
  await page.waitForSelector("#game-chip", { timeout: 10_000 });
  await page.waitForTimeout(1500);
  console.log("offline solo ok");

  if (errors.length) {
    console.error("ERRORS:\n" + errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("no console/page errors");
  }
} finally {
  await browser.close();
}
