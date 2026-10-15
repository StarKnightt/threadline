// Capture README / submission screenshots from a running instance (replays stored showcase runs, so no LLM calls).
// Usage: node scripts/shots.mjs [baseUrl]   (uses the locally installed Chrome)
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "https://threadline-graph.vercel.app";
const out = new URL("../shots/", import.meta.url);
mkdirSync(out, { recursive: true });
const file = (n) => new URL(n, out).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"] });

async function showcase(page, index) {
  const list = await (await fetch(`${base}/api/showcase`)).json();
  const id = list[index]?.id;
  await page.goto(`${base}/t/${id}`, { waitUntil: "load" });
  await page.waitForSelector("text=/citations verified|no node citations/", { timeout: 60000 });
  await sleep(2500);
}

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  await page.goto(base, { waitUntil: "load" });
  await sleep(6000);
  await page.screenshot({ path: file("01-home-constellation.png") });

  await showcase(page, 0);
  await page.screenshot({ path: file("02-split-graph-vs-vector.png") });
  await page.screenshot({ path: file("../src/app/opengraph-image.png"), clip: { x: 0, y: 0, width: 1600, height: 838 } });

  await page.locator("button:has-text('show Cypher')").nth(1).click();
  await sleep(500);
  await page.screenshot({ path: file("03-step-cypher.png") });

  await showcase(page, 1);
  await page.screenshot({ path: file("04-decision-trace.png") });

  await showcase(page, 2);
  await page.screenshot({ path: file("05-cross-repo.png") });

  await showcase(page, 3);
  await page.screenshot({ path: file("06-impact.png") });

  await showcase(page, 5);
  await page.screenshot({ path: file("07-triage-action.png") });

  await page.goto(`${base}/eval`, { waitUntil: "load" });
  await sleep(800);
  await page.screenshot({ path: file("08-eval.png"), fullPage: false });

  await page.goto(`${base}/how`, { waitUntil: "load" });
  await sleep(800);
  await page.screenshot({ path: file("09-how-data-model.png") });
  await page.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await showcase(mobile, 1);
  await mobile.screenshot({ path: file("10-mobile.png") });
  await mobile.close();
  console.log("screenshots written to", file(""));
} finally {
  await browser.close();
}
