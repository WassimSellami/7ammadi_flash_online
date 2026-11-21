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

  await page.getByRole("button", { name: /Solo score attack/ }).click();
  await page.waitForSelector("#game-chip", { timeout: 10_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "smoke-solo.png" });
  if (!(await page.locator("canvas").count())) throw new Error("no canvas");
  console.log("solo ok");

  await page.keyboard.press("Escape");
  await page.waitForSelector("text=Paused", { timeout: 5000 });
  await page.getByRole("button", { name: "Resume" }).click();
  await page.waitForSelector("#game-chip", { timeout: 5000 });
  console.log("pause/resume ok");

  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByRole("button", { name: "Main menu" }).click();
  await page.waitForSelector(".brand h1", { timeout: 5000 });

  await page.getByRole("button", { name: /Local hotseat/ }).click();
  await page.waitForSelector("#game-chip", { timeout: 10_000 });
  await page.waitForTimeout(1500);
  await page.keyboard.down("KeyD");
  await page.keyboard.down("ArrowLeft");
  await page.waitForTimeout(700);
  await page.keyboard.up("KeyD");
  await page.keyboard.up("ArrowLeft");
  console.log("hotseat ok");

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
