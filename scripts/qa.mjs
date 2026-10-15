// Release check: every page and every showcase replay, both themes, desktop and mobile, failing on console errors.
// Usage: node scripts/qa.mjs [baseUrl]   (screenshots in shots/qa/)
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://threadline-graph.vercel.app";
mkdirSync("shots/qa", { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const showcase = await (await fetch(`${base}/api/showcase`)).json();
const targets = [
  ["home", "/"],
  ["how", "/how"],
  ["eval", "/eval"],
  ...showcase.map((s, i) => [`showcase-${i}`, `/t/${s.id}`, true]),
];
const viewports = {
  desktop: { viewport: { width: 1600, height: 900 } },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
let failures = 0;
try {
  for (const [vp, opts] of Object.entries(viewports)) {
    for (const theme of ["dark", "light"]) {
      const ctx = await browser.newContext(opts);
      await ctx.addInitScript((t) => localStorage.setItem("tl_theme", t), theme);
      for (const [name, path, replay] of targets) {
        const page = await ctx.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
        let note = "";
        try {
          await page.goto(base + path, { waitUntil: "load", timeout: 60000 });
          if (replay) {
            await page.waitForSelector("text=/citations verified|no node citations/", { timeout: 90000 });
            note = (await page.locator("text=/\\d+ of \\d+ citations verified/").first().textContent().catch(() => "")) ?? "";
          }
          await sleep(replay ? 2500 : 1500);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          if (overflow > 1) errors.push(`horizontal overflow ${overflow}px`);
          await page.screenshot({ path: `shots/qa/${vp}-${theme}-${name}.png` });
        } catch (e) {
          errors.push(`load: ${e.message.split("\n")[0]}`);
        }
        if (errors.length) failures++;
        console.log(`${vp.padEnd(7)} ${theme.padEnd(5)} ${name.padEnd(10)} ${errors.length ? "FAIL " + errors.slice(0, 3).join(" | ") : "ok"} ${note.trim()}`);
        await page.close();
      }
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} page(s) with problems` : "all pages clean");
process.exit(failures ? 1 : 0);
