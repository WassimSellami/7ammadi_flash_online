import { chromium } from "playwright";

const url = process.argv[2] ?? "https://7ammadi-flash.7ammadi.workers.dev/";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

page.on("console", (m) => console.log("[console]", m.type(), m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.stack ?? e.message));
page.on("requestfailed", (r) => console.log("[requestfailed]", r.url(), r.failure()?.errorText));
page.on("response", (r) => {
  if (r.status() >= 400) console.log("[http]", r.status(), r.url());
});

await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
await page.waitForTimeout(5000);

const state = await page.evaluate(() => {
  const stage = document.getElementById("stage");
  const ui = document.getElementById("ui");
  const canvas = stage?.querySelector("canvas");
  let gl = null;
  try {
    const c = document.createElement("canvas");
    gl = {
      webgl2: !!c.getContext("webgl2"),
      webgl: !!c.getContext("webgl"),
    };
  } catch (e) {
    gl = { error: String(e) };
  }
  return {
    title: document.title,
    uiText: (ui?.innerText ?? "").slice(0, 500),
    uiHtmlLen: ui?.innerHTML.length ?? -1,
    stageHtmlLen: stage?.innerHTML.length ?? -1,
    canvas: canvas ? { w: canvas.width, h: canvas.height, cw: canvas.clientWidth, ch: canvas.clientHeight } : null,
    gl,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  };
});
console.log(JSON.stringify(state, null, 2));
await page.screenshot({ path: "C:\\Users\\WASSIM~1\\AppData\\Local\\Temp\\kilo\\deployed.png" });
await browser.close();
