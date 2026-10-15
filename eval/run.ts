// Run the evaluation: every question through the vector RAG baseline and the graph agent,
// same LLM, same embeddings, same FalkorDB vector index. Resumable (skips finished pairs),
// and stops cleanly when the daily Groq token cap is reached.
// Usage: pnpm eval:run [--model openai/gpt-oss-20b] [--only graph|vector] [--limit N] [--category expertise] [--wait]
// OpenAI completion: pnpm eval:run --model openai:gpt-5.6-luna [--max-usd 1]
//   answers every question that has no complete Groq pair, both systems with the same OpenAI model,
//   and stops before the spend ledger (eval/openai-spend.json) passes --max-usd.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import "../scripts/lib/env";
import { close } from "../src/lib/falkor";
import { runGraphAgent, runVectorBaseline } from "../src/lib/agent/run";
import { OPENAI_DIRECT, estimateCostUsd, openaiMeter } from "../src/lib/agent/llm";
import { embedMeter } from "../src/lib/embed";
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

// Questions rotate across three models within each category (daily token caps are per model).
// Both systems always answer a given question with the same model.
export const ROTATION = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"];
const assigned = (q: Q) => ROTATION[(Number(q.id.split("-").pop()) - 1) % ROTATION.length];
const existing = existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; system: string; model: string }) : [];
const done = new Set(existing.map((r) => `${r.id}|${r.system}|${r.model}`));

const OPENAI = MODEL.startsWith(OPENAI_DIRECT);
const ROW_MODEL = OPENAI ? MODEL.slice(OPENAI_DIRECT.length) : MODEL;
// A question is already answered if some other model has both its graph and vector rows.
const pairedElsewhere = new Set(
  existing.filter((r) => r.model !== ROW_MODEL && r.system === "graph" && existing.some((v) => v.id === r.id && v.model === r.model && v.system === "vector")).map((r) => r.id),
);

// OpenAI spend ledger for this completion run: persists across restarts, so the cap holds over resumes.
const LEDGER = "eval/openai-spend.json";
const MAX_USD = Number(arg("max-usd") ?? 1);
const EMBED_USD_PER_M = 0.02;
type Ledger = { model: string; maxUsd: number; calls: number; input: number; cached: number; output: number; embedTokens: number; usd: number; rows: number; updatedAt: string };
const ledger: Ledger = existsSync(LEDGER)
  ? JSON.parse(readFileSync(LEDGER, "utf8"))
  : { model: ROW_MODEL, maxUsd: MAX_USD, calls: 0, input: 0, cached: 0, output: 0, embedTokens: 0, usd: 0, rows: 0, updatedAt: "" };
const base = { ...ledger };
function syncLedger(rowsAdded = 0) {
  ledger.calls = base.calls + openaiMeter.calls;
  ledger.input = base.input + openaiMeter.input;
  ledger.cached = base.cached + openaiMeter.cached;
  ledger.output = base.output + openaiMeter.output;
  ledger.embedTokens = base.embedTokens + embedMeter.tokens;
  const chat = estimateCostUsd(ROW_MODEL, ledger.input, ledger.cached, ledger.output);
  if (chat === null) throw new Error(`no price for ${ROW_MODEL} in src/lib/agent/llm.ts`);
  ledger.usd = chat + (ledger.embedTokens * EMBED_USD_PER_M) / 1e6;
  ledger.rows += rowsAdded;
  ledger.updatedAt = new Date().toISOString();
  writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
}
let worstPairUsd = 0.05;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msgOf = (e: unknown) => {
  const err = e as { message?: string; lastError?: { message?: string; responseBody?: string } };
  return `${err?.message ?? e} ${err?.lastError?.message ?? ""} ${err?.lastError?.responseBody ?? ""}`;
};
const isCap = (e: unknown) => /tokens per day|\(TPD\)/i.test(msgOf(e));
const isRate = (e: unknown) => /rate limit|429|tokens per minute|TPM/i.test(msgOf(e));
// With --wait, a daily cap pauses until Groq's bucket refills instead of exiting.
const WAIT = process.argv.includes("--wait");
const waitMs = (e: unknown) => {
  const m = /try again in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(msgOf(e));
  if (!m || !m[0].match(/\d/)) return 10 * 60000;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
};

async function main() {
  let ran = 0;
  for (const q of questions) {
    if (CATEGORY && q.category !== CATEGORY) continue;
    if (OPENAI ? pairedElsewhere.has(q.id) : !process.argv.includes("--all") && assigned(q) !== MODEL) continue;
    const pairStart = ledger.usd;
    if (OPENAI && ["vector", "graph"].some((s) => !done.has(`${q.id}|${s}|${ROW_MODEL}`)) && ledger.usd + 2 * worstPairUsd > MAX_USD) {
      console.log(`\nStopping before ${q.id}: OpenAI spend $${ledger.usd.toFixed(4)} plus a worst-case pair would pass $${MAX_USD.toFixed(2)}.`);
      return;
    }
    for (const system of ["vector", "graph"] as const) {
      if (ONLY && ONLY !== system) continue;
      if (done.has(`${q.id}|${system}|${ROW_MODEL}`)) continue;
      if (ran >= LIMIT) return;
      const t0 = Date.now();
      try {
        let trace: Awaited<ReturnType<typeof runGraphAgent>> | undefined;
        for (let attempt = 0; !trace; attempt++) {
          try {
            trace =
              system === "graph"
                ? await runGraphAgent(q.question, () => {}, undefined, { handoff: false, models: [MODEL] })
                : await runVectorBaseline(q.question, () => {}, { models: [MODEL] });
          } catch (e) {
            if (isCap(e) && WAIT) {
              // A graph question makes several calls (about 8-10K tokens); waiting only for the next call's
              // share lets a later call hit the cap and wastes the earlier ones, so wait for roughly an hour of refill.
              const ms = Math.max(waitMs(e) + 15000, 60 * 60000);
              console.log(`${q.id} ${system}: daily cap for ${MODEL}, waiting ${Math.round(ms / 60000)} min`);
              await sleep(ms);
              attempt = 0;
              continue;
            }
            if (isCap(e) || !isRate(e) || attempt >= 5) throw e;
            await sleep(30000);
          }
        }
        const s = score(trace.answer, q.gold);
        const row = {
          id: q.id,
          category: q.category,
          system,
          model: ROW_MODEL,
          provider: OPENAI ? "openai" : "groq",
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
        if (OPENAI) syncLedger(1);
        console.log(`${q.id.padEnd(14)} ${system.padEnd(6)} f1=${s.f1.toFixed(2)} tokens=${trace.tokens} ${row.ms}ms  pred=${s.pred.join(",")}  gold=${q.gold.join(",")}${OPENAI ? `  spend=$${ledger.usd.toFixed(4)}` : ""}`);
        ran++;
      } catch (e) {
        if (OPENAI) syncLedger();
        if (OPENAI && /insufficient_quota|billing|exceeded your current quota/i.test(msgOf(e))) {
          console.log(`\nOpenAI quota or billing error; stopping. (${msgOf(e).slice(0, 160)})`);
          return;
        }
        if (isCap(e)) {
          console.log(`\nDaily token cap reached for ${MODEL}; rerun later to resume. (${(e as Error).message.slice(0, 160)})`);
          return;
        }
        console.warn(`${q.id} ${system} failed: ${(e as Error).message.slice(0, 200)}`);
        await sleep(3000);
      }
      if (OPENAI && ledger.usd > MAX_USD) {
        console.log(`\nOpenAI spend $${ledger.usd.toFixed(4)} passed $${MAX_USD.toFixed(2)}; hard stop.`);
        return;
      }
      await sleep(1500);
    }
    if (OPENAI) worstPairUsd = Math.max(worstPairUsd, ledger.usd - pairStart);
  }
  if (OPENAI) console.log(`\nDone. OpenAI spend this run: $${ledger.usd.toFixed(4)} (${ledger.calls} calls, ${ledger.input} input, ${ledger.cached} cached, ${ledger.output} output, ${ledger.embedTokens} embedding tokens).`);
}

main().finally(close);
