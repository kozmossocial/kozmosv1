import { chromium } from "playwright";
import fs from "node:fs";

const outDir = "output/web-game/space-mobile";
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto("http://localhost:3000/play/starfall-protocol", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(500);
await page.click("#start-btn");
await page.waitForTimeout(200);
await page.evaluate(async () => {
  if (typeof window.advanceTime === "function") {
    await window.advanceTime(1200);
  }
});
await page.screenshot({ path: `${outDir}/shot-mobile.png`, fullPage: true });
const state = await page.evaluate(() => {
  if (typeof window.render_game_to_text === "function") return window.render_game_to_text();
  return "";
});
if (state) fs.writeFileSync(`${outDir}/state-mobile.json`, state);
await browser.close();
