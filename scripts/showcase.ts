// Record the showcase runs: each question through the vector baseline and the graph agent, stored in FalkorDB
// as a linked pair so the site can replay them without any LLM call. Usage: pnpm showcase [--only N]
import "./lib/env";
import { randomUUID } from "node:crypto";
import { SHARED, close, query } from "../src/lib/falkor";
import { runGraphAgent, runVectorBaseline } from "../src/lib/agent/run";
import { embedQuestion } from "../src/lib/embed";
import { persist } from "../src/lib/memory";
import type { Trace } from "../src/lib/agent/types";

export const SHOWCASE = [
  "Who should review a change to the vector index code in the core FalkorDB repo?",
  "Which pull request fixed issue #1462 in the FalkorDB repository, and which release shipped it?",
  "How is falkordb-browser issue #1802 (importing a graph from an RDB dump) connected to work in the core FalkorDB repository?",
  "What is affected if we change src/index in the core FalkorDB repository?",
  "Who are the key reviewers across FalkorDB, and who bridges the most repositories?",
  "Draft a triage comment for falkordb-browser issue #1802.",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const only = process.argv.includes("--only") ? Number(process.argv[process.argv.indexOf("--only") + 1]) : null;

async function main() {
  const at = () => Math.floor(Date.now() / 1000);
  for (const [i, q] of SHOWCASE.entries()) {
    if (only !== null && only !== i) continue;
    console.log(`\n[${i}] ${q}`);
    const v = await runVectorBaseline(q, () => {});
    const vt: Trace = { ...v, id: `sv${i}-${randomUUID().slice(0, 6)}`, at: at() };
    await persist(vt, {});
    await sleep(15000);
    let g: Awaited<ReturnType<typeof runGraphAgent>> | null = null;
    for (let attempt = 0; !g && attempt < 4; attempt++) {
      try {
        g = await runGraphAgent(q, () => {});
      } catch (e) {
        console.warn("  retrying after:", (e as Error).message.slice(0, 120));
        await sleep(45000);
      }
    }
    if (!g) continue;
    await query(SHARED, "MATCH (t:Trace) WHERE t.showcase = true AND t.question = $q SET t.showcase = false", { q });
    const gt: Trace = { ...g, id: `s${i}-${randomUUID().slice(0, 6)}`, at: at() + i, showcase: true, pairId: vt.id };
    await persist(gt, { vec: await embedQuestion(q) });
    console.log(`  graph ${gt.id}: ${g.steps.map((s) => s.tool).join(" > ")} | verified ${g.verification?.verified}/${g.verification?.total} | ${g.tokens} tokens | ${g.model}`);
    console.log(`  ${g.answer.replace(/\n+/g, " ").slice(0, 300)}`);
    await sleep(45000);
  }
}

main().finally(close);
