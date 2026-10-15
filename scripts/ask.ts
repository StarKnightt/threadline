// Ask the graph agent (or the vector baseline) from the terminal and print the trace.
// Usage: pnpm ask "who knows the vector index code?" [--vector] [--model openai/gpt-oss-120b]
import "./lib/env";
import { close } from "../src/lib/falkor";
import { runGraphAgent, runVectorBaseline } from "../src/lib/agent/run";

const args = process.argv.slice(2);
const mi = args.indexOf("--model");
const models = mi >= 0 ? [args[mi + 1]] : undefined;
const question = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--model").join(" ");

async function main() {
  const emit = (e: Record<string, unknown>) => {
    if (e.type === "step_start") console.log(`\n> ${e.tool} ${JSON.stringify(e.args)}`);
    if (e.type === "step_result") console.log(`  ${e.error ? "ERROR " + e.error : `${(e.rows as unknown[]).length} rows, ${(e.refs as unknown[]).length} refs, ${e.ms} ms`}`);
    if (e.type === "verify") console.log(`  verify ${e.key}: ${e.ok ? "ok" : "REJECTED"} (observed=${e.observed}, hops=${e.hops})`);
    if (e.type === "handoff") console.log(`\n~ handoff: ${e.reason}`);
    if (e.type === "answer") console.log(`\n${e.revised ? "REVISED " : ""}ANSWER (${e.model}):\n${e.text}`);
  };
  const t = args.includes("--vector") ? await runVectorBaseline(question, emit, { models }) : await runGraphAgent(question, emit, undefined, { models });
  console.log(`\n${t.mode} | ${t.tokens} tokens | ${t.ms} ms | verified ${t.verification ? `${t.verification.verified}/${t.verification.total}` : "n/a"}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(close);
