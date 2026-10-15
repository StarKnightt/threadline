// Capture README / submission screenshots from a running instance (replays stored showcase runs, so no LLM calls).
// Usage: node scripts/shots.mjs [baseUrl] [dark|light|both]   (uses the locally installed Chrome)
// Dark files keep the plain names; light files get a "-light" suffix.
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://threadline-graph.vercel.app";
const which = process.argv[3] ?? "both";
const out = new URL("../shots/", import.meta.url);
mkdirSync(out, { recursive: true });
const file = (n) => new URL(n, out).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });
const list = await (await fetch(`${base}/api/showcase`)).json();

async function showcase(page, index) {
  await page.goto(`${base}/t/${list[index]?.id}`, { waitUntil: "load" });
  await page.waitForSelector("text=/citations verified|no node citations/", { timeout: 60000 });
  await sleep(2500);
}

async function capture(theme) {
  const sfx = theme === "light" ? "-light" : "";
  const name = (n) => file(`${n}${sfx}.png`);
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => localStorage.setItem("tl_theme", t), theme);
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "load" });
  await sleep(6000);
  await page.screenshot({ path: name("01-home-constellation") });

  await showcase(page, 0);
  await page.screenshot({ path: name("02-split-graph-vs-vector") });
  if (theme === "dark") await page.screenshot({ path: file("../src/app/opengraph-image.png"), clip: { x: 0, y: 0, width: 1600, height: 838 } });

  await page.locator("button:has-text('show Cypher')").nth(1).click();
  await sleep(500);
  await page.screenshot({ path: name("03-step-cypher") });

  await showcase(page, 1);
  await page.screenshot({ path: name("04-decision-trace") });
  await showcase(page, 2);
  await page.screenshot({ path: name("05-cross-repo") });
  await showcase(page, 3);
  await page.screenshot({ path: name("06-impact") });
  await showcase(page, 5);
  await page.screenshot({ path: name("07-triage-action") });

  await page.goto(`${base}/eval`, { waitUntil: "load" });
  await sleep(800);
  await page.screenshot({ path: name("08-eval") });
  await page.goto(`${base}/how`, { waitUntil: "load" });
  await sleep(800);
  await page.screenshot({ path: name("09-how-data-model") });
  await ctx.close();

  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mctx.addInitScript((t) => localStorage.setItem("tl_theme", t), theme);
  const mobile = await mctx.newPage();
  await showcase(mobile, 1);
  await mobile.screenshot({ path: name("10-mobile") });
  await mctx.close();
  console.log(theme, "screenshots written to", file(""));
}

try {
  for (const theme of which === "both" ? ["dark", "light"] : [which]) await capture(theme);
} finally {
  await browser.close();
}
