// Record demo footage: one 1920x1080 clip per scene (webm) into demo/footage/, matching docs/VIDEO_SCRIPT.md.
// Replay scenes use stored showcase runs (no LLM). Pass --live to also record the live and memory scenes.
// Usage: node scripts/demo-capture.mjs [baseUrl] [--live] [--only 03]
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { chromium } from "playwright-core";

const base = process.argv.find((a) => a.startsWith("http")) ?? "https://threadline-graph.vercel.app";
const live = process.argv.includes("--live");
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const dir = new URL("../demo/footage/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const tmp = dir + "_tmp/";
mkdirSync(tmp, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const showcase = await (await fetch(`${base}/api/showcase`)).json();

const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--hide-scrollbars"] });

async function scene(name, fn) {
  if (only && !name.startsWith(only)) return;
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: tmp, size: { width: 1920, height: 1080 } } });
  const page = await ctx.newPage();
  await page.addInitScript(() => localStorage.setItem("tl_user", "demo-capture-user-0001"));
  const t = Date.now();
  try {
    await fn(page);
  } finally {
    const video = page.video();
    await ctx.close();
    const src = await video.path();
    renameSync(src, `${dir}${name}.webm`);
    console.log(`${name}.webm  ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
}

async function openShowcase(page, i, playMs = 11000) {
  await page.goto(`${base}/t/${showcase[i].id}`, { waitUntil: "load" });
  await page.waitForSelector("text=/citations verified|no node citations/", { timeout: 90000 });
  await sleep(playMs);
}

async function typeSlowly(page, text) {
  await page.click("textarea");
  await page.fill("textarea", "");
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(28);
  }
}

await scene("01-home-constellation", async (page) => {
  await page.goto(base, { waitUntil: "load" });
  await sleep(9000);
});

await scene("02-split-vector-vs-graph", async (page) => {
  await openShowcase(page, 0, 4000);
  await page.click("button:has-text('Replay')");
  await sleep(9000);
  await page.hover("a:has-text('AviAvni')").catch(() => {});
  await sleep(3000);
});

await scene("03-cypher-and-verifier", async (page) => {
  await openShowcase(page, 0, 3000);
  await page.locator("button:has-text('show Cypher')").nth(1).click();
  await sleep(3500);
  await page.locator("button:has-text('show Cypher')").last().click();
  await sleep(3500);
});

await scene("04-decision-trace", async (page) => {
  await openShowcase(page, 1, 9000);
});

await scene("05-cross-repo", async (page) => {
  await openShowcase(page, 2, 10000);
});

await scene("06-impact", async (page) => {
  await openShowcase(page, 3, 9000);
});

await scene("07-algorithms", async (page) => {
  await openShowcase(page, 4, 9000);
});

await scene("08-triage-action", async (page) => {
  await openShowcase(page, 5, 7000);
  await page.mouse.move(200, 700);
  await page.mouse.wheel(0, 500);
  await sleep(3000);
});

await scene("09-eval", async (page) => {
  await page.goto(`${base}/eval`, { waitUntil: "load" });
  await sleep(2500);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, 260);
    await sleep(700);
  }
  await sleep(1500);
});

await scene("10-how-data-model", async (page) => {
  await page.goto(`${base}/how`, { waitUntil: "load" });
  await sleep(2000);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 300);
    await sleep(650);
  }
  await sleep(1500);
});

if (live) {
  await scene("11-live-question", async (page) => {
    await page.goto(base, { waitUntil: "load" });
    await sleep(2500);
    await typeSlowly(page, "Which pull request fixed issue #2048 in the FalkorDB repository, and which release shipped it?");
    await page.click("button:has-text('Ask')");
    await page.waitForSelector("text=/citations verified|no node citations/", { timeout: 120000 });
    await sleep(5000);
  });

  await scene("12-memory", async (page) => {
    await page.goto(base, { waitUntil: "load" });
    await sleep(2000);
    await typeSlowly(page, "I work on the TypeScript client. Who reviewed the most pull requests in falkordb-ts in 2025?");
    await page.click("button:has-text('Ask')");
    await page.waitForSelector("text=/citations verified|no node citations/", { timeout: 120000 });
    await sleep(3000);
    await typeSlowly(page, "Same question, but for QueryWeaver.");
    await page.click("button:has-text('Ask')");
    await page.waitForSelector("text=Recalled from memory", { timeout: 120000 });
    await page.waitForSelector("text=/citations verified|no node citations/", { timeout: 120000 });
    await sleep(2500);
    await page.click("button:has-text('What I remember about you')");
    await sleep(4000);
  });
}

await browser.close();
for (const f of readdirSync(tmp)) rmSync(tmp + f);
console.log("footage in", dir);
