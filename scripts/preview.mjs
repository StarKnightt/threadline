// Quick visual check of one page in both themes. Usage: node scripts/preview.mjs [baseUrl] [path|showcase:N] [outPrefix]
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:3000";
const target = process.argv[3] ?? "showcase:0";
const prefix = process.argv[4] ?? "preview";
mkdirSync("shots/preview", { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
try {
  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext(process.env.MOBILE ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1600, height: 900 } });
    await ctx.addInitScript((t) => localStorage.setItem("tl_theme", t), theme);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    let url = `${base}${target}`;
    if (target.startsWith("showcase:")) {
      const list = await (await fetch(`${base}/api/showcase`)).json();
      url = `${base}/t/${list[Number(target.split(":")[1])].id}`;
    }
    await page.goto(url, { waitUntil: "load" });
    if (target.startsWith("showcase:")) await page.waitForSelector("text=/citations verified|no node citations/", { timeout: 90000 });
    await sleep(target.startsWith("showcase:") ? 3000 : 1500);
    await page.screenshot({ path: `shots/preview/${prefix}-${theme}.png` });
    console.log(theme, url, errors.length ? `errors: ${errors.slice(0, 3).join(" | ")}` : "no console errors");
    await ctx.close();
  }
} finally {
  await browser.close();
}
