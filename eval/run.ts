// Run the evaluation: every question through the vector RAG baseline and the graph agent,
// same LLM, same embeddings, same FalkorDB vector index. Resumable (skips finished pairs),
// and stops cleanly when the daily Groq token cap is reached.
// Usage: pnpm eval:run [--model openai/gpt-oss-20b] [--only graph|vector] [--limit N] [--category expertise]
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import "../scripts/lib/env";
import { close } from "../src/lib/falkor";
import { runGraphAgent, runVectorBaseline } from "../src/lib/agent/run";
import { score } from "./score";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const MODEL = arg("model") ?? "openai/gpt-oss-20b";
const ONLY = arg("only");
const LIMIT = Number(arg("limit") ?? 1000);
const CATEGORY = arg("category");
const OUT = "eval/results.jsonl";

type Q = { id: string; category: string; question: string; gold: string[]; goldKeys: string[] };
const { questions } = JSON.parse(readFileSync("eval/questions.json", "utf8")) as { questions: Q[] };
const done = new Set(
  existsSync(OUT)
    ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => {
        const r = JSON.parse(l);
        return `${r.id}|${r.system}|${r.model}`;
      })
    : [],
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isCap = (e: unknown) => /tokens per day|TPD|daily|quota/i.test(String((e as Error)?.message ?? e));

async function main() {
  let ran = 0;
  for (const q of questions) {
    if (CATEGORY && q.category !== CATEGORY) continue;
    for (const system of ["vector", "graph"] as const) {
      if (ONLY && ONLY !== system) continue;
      if (done.has(`${q.id}|${system}|${MODEL}`)) continue;
      if (ran >= LIMIT) return;
      const t0 = Date.now();
      try {
        const trace =
          system === "graph"
            ? await runGraphAgent(q.question, () => {}, undefined, { handoff: false, models: [MODEL] })
            : await runVectorBaseline(q.question, () => {}, { models: [MODEL] });
        const s = score(trace.answer, q.gold);
        const row = {
          id: q.id,
          category: q.category,
          system,
          model: MODEL,
          question: q.question,
          gold: q.gold,
          answer: trace.answer,
          ...s,
          steps: trace.steps.filter((x) => x.agent !== "verifier").length,
          tools: trace.steps.map((x) => x.tool),
          verified: trace.verification ? `${trace.verification.verified}/${trace.verification.total}` : null,
          tokens: trace.tokens,
          ms: Date.now() - t0,
          at: new Date().toISOString(),
        };
        appendFileSync(OUT, JSON.stringify(row) + "\n");
        console.log(`${q.id.padEnd(14)} ${system.padEnd(6)} f1=${s.f1.toFixed(2)} tokens=${trace.tokens} ${row.ms}ms  pred=${s.pred.join(",")}  gold=${q.gold.join(",")}`);
        ran++;
      } catch (e) {
        if (isCap(e)) {
          console.log(`\nDaily token cap reached for ${MODEL}; rerun later to resume. (${(e as Error).message.slice(0, 160)})`);
          return;
        }
        console.warn(`${q.id} ${system} failed: ${(e as Error).message.slice(0, 200)}`);
        await sleep(3000);
      }
      await sleep(1500);
    }
  }
}

main().finally(close);
