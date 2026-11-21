/**
 * Browser smoke test (Playwright). Not part of `vitest`; run manually:
 *   npm run build
 *   node scripts/smoke.mjs http://127.0.0.1:4173
 */

import { chromium } from "playwright";

const base = process.argv[2] ?? "http://127.0.0.1:4173";
const errors = [];

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("console", (message) => {
  if (message.type() === "error") {
    const text = `console: ${message.text()}`;
    errors.push(text);
    console.error(text);
  }
});
page.on("pageerror", (error) => {
  errors.push(`pageerror: ${error.message}`);
  console.error(`pageerror: ${error.message}`);
  void page.screenshot({ path: "smoke-failure.png" });
});

try {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".brand h1", { timeout: 20_000 });
  console.log("menu ok");

  await page.getByRole("button", { name: /Local hotseat/ }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "smoke-hotseat.png" });
  if (!(await page.locator("canvas").count())) throw new Error("no canvas");
  console.log("hotseat ok");

  await page.keyboard.press("Escape");
  await page.waitForSelector("text=Paused", { timeout: 5000 });
  await page.getByRole("button", { name: "Resume" }).click();
  console.log("pause/resume ok");

  await page.keyboard.press("Escape");
  await page.waitForSelector("text=Paused", { timeout: 5000 });
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.waitForSelector(".brand h1", { timeout: 5000 });
  console.log("back to menu ok");

  await page.goto(`${base}/?room=ABCD`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Play online", { timeout: 10_000 });
  console.log("invite form ok");

  if (errors.length) {
    console.error("ERRORS:\n" + errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("no console/page errors");
  }
} finally {
  await browser.close();
}
