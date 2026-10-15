// WCAG 2.x AA colour-contrast audit (axe-core) of every page in both themes.
// Usage: node scripts/a11y.mjs [baseUrl]
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const base = process.argv[2] ?? "http://localhost:3000";
const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`${base}/api/showcase`)).json();

const pages = [
  { name: "home", path: "/" },
  { name: "split", path: `/t/${list[0].id}`, ready: "text=/citations verified/", open: true },
  { name: "triage", path: `/t/${list[5]?.id ?? list[0].id}`, ready: "text=/citations verified|no node citations/" },
  { name: "eval", path: "/eval", details: true },
  { name: "how", path: "/how" },
];

const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
let failures = 0;
try {
  for (const theme of ["dark", "light"]) {
    for (const p of pages) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await ctx.addInitScript((t) => localStorage.setItem("tl_theme", t), theme);
      const page = await ctx.newPage();
      await page.goto(base + p.path, { waitUntil: "load" });
      if (p.ready) await page.waitForSelector(p.ready, { timeout: 90000 });
      await sleep(p.ready ? 2500 : 1200);
      if (p.open) {
        await page.locator("button:has-text('show Cypher')").first().click();
        await page.locator("button:has-text('What I remember')").click();
        await sleep(1200);
      }
      if (p.details) await page.evaluate(() => document.querySelectorAll("details").forEach((d, i) => i < 4 && (d.open = true)));
      await page.addScriptTag({ content: axe });
      const res = await page.evaluate(async () => {
        // The canvas labels sit over WebGL, which axe cannot see; they are checked against their own opaque backing.
        const r = await window.axe.run(document, { runOnly: ["color-contrast"], resultTypes: ["violations"] });
        return r.violations.flatMap((v) => v.nodes.map((n) => ({ html: n.html.slice(0, 110), msg: n.any[0]?.message?.slice(0, 170) })));
      });
      failures += res.length;
      console.log(`${theme.padEnd(5)} ${p.name.padEnd(7)} ${res.length ? `${res.length} contrast issues` : "pass"}`);
      for (const r of res.slice(0, 12)) console.log(`   ${r.msg}\n     ${r.html}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
process.exit(failures ? 1 : 0);
