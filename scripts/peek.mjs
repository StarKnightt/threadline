// Quick visual check during development: screenshot a URL (optionally after asking a question or opening a trace).
// Usage: node scripts/peek.mjs <url> <out.png> [--ask "question"] [--wait ms]
import { chromium } from "playwright-core";

const [url, out] = process.argv.slice(2);
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const browser = await chromium.launch({ channel: "chrome", args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-angle=swiftshader"] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const logs = [];
  page.on("console", (m) => m.type() === "error" && logs.push(m.text()));
  page.on("pageerror", (e) => logs.push(String(e)));
  await page.goto(url, { waitUntil: "load" });
  await page.waitForTimeout(4000);
  if (process.argv.includes("--split")) await page.click("button:has-text('Graph vs vector RAG')");
  const q = arg("ask");
  if (q) {
    await page.fill("textarea", q);
    await page.click("button:has-text('Ask')");
    await page.waitForSelector("text=/citations verified|no node citations|Vector RAG answer/", { timeout: 150000 }).catch(() => {});
  }
  await page.waitForTimeout(Number(arg("wait") ?? 2500));
  await page.screenshot({ path: out });
  if (logs.length) console.log("console errors:\n" + logs.slice(0, 8).join("\n"));
  console.log("saved", out);
} finally {
  await browser.close();
}
