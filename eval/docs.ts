// Write the evaluation results from eval/summary.json into README.md, docs/BLOG_DRAFT.md and docs/VIDEO_SCRIPT.md.
// Usage: pnpm eval:summary && pnpm eval:docs
import { readFileSync, writeFileSync } from "node:fs";

type Stats = { n: number; f1: number; exact: number; tokens: number; p50ms: number; citationValidity: number | null };
type Pair = { graph: Stats; vector: Stats };
type Info = { provider: string; questions: string[] };
const s = JSON.parse(readFileSync("eval/summary.json", "utf8")) as { pairedQuestions: number; totalQuestions?: number; generatedAt: string; overall: Pair; models: Record<string, Pair>; modelInfo?: Record<string, Info>; mixedModels?: boolean; categories: Record<string, Pair> };

const NAMES: Record<string, string> = {
  lookup: "Single-hop lookup (control)",
  expertise: "Expertise (PR to file to directory)",
  trace: "Decision trace (issue to PR to release)",
  cross_repo: "Cross-repo connection",
  impact: "Impact (open PRs under a directory)",
  aggregation: "Aggregation (top reviewers or openers)",
};
const total = s.totalQuestions ?? 60;
const f = (x: number) => x.toFixed(2);
const done = s.pairedQuestions >= total;
const cats = Object.entries(s.categories).filter(([, v]) => v.graph.n > 0);
const gaps = cats.filter(([c]) => c !== "lookup").sort((a, b) => b[1].graph.f1 - b[1].vector.f1 - (a[1].graph.f1 - a[1].vector.f1));
const short = (c: string) => (NAMES[c] ?? c).replace(/ \(.*\)$/, "").toLowerCase();
const gap = (v: Pair) => v.graph.f1 - v.vector.f1;
const top = gaps.filter(([, v]) => gaps[0] && Math.abs(gap(v) - gap(gaps[0][1])) < 1e-9).map(([c]) => short(c));
const strongest = top.length > 1 ? `${top.slice(0, -1).join(", ")} and ${top.at(-1)}` : (top[0] ?? "");
const bestVector = [...cats].sort((a, b) => b[1].vector.f1 - a[1].vector.f1)[0];
const vectorNote = bestVector
  ? `The vector baseline does best on ${short(bestVector[0])} questions (F1 ${f(bestVector[1].vector.f1)})${bestVector[0] === "lookup" ? ", the control category where the answer sits in one document" : ""}. Widest gap: ${strongest}.`
  : "";

const table = [
  "| Category | Pairs | Graph agent F1 | Vector RAG F1 |",
  "|---|---|---|---|",
  ...cats.map(([c, v]) => `| ${NAMES[c] ?? c} | ${v.graph.n} | ${f(v.graph.f1)} | ${f(v.vector.f1)} |`),
  `| **All** | **${s.pairedQuestions}** | **${f(s.overall.graph.f1)}** | **${f(s.overall.vector.f1)}** |`,
].join("\n");
const status = done
  ? `All ${total} questions were answered by both systems.`
  : `Run in progress: ${s.pairedQuestions} of ${total} questions answered by both systems so far (the rest resume as each model's daily Groq cap refills). These numbers cover finished pairs only.`;
const PROVIDER: Record<string, string> = { groq: "Groq", openai: "OpenAI, reasoning off" };
const label = (m: string) => `${m} (${PROVIDER[s.modelInfo?.[m]?.provider ?? "groq"] ?? s.modelInfo?.[m]?.provider})`;
const models = Object.entries(s.models)
  .map(([m, v]) => `${label(m)} on ${v.graph.n} questions`)
  .join(", ");
const modelTable = [
  "| Model | Questions | Graph agent F1 | Vector RAG F1 |",
  "|---|---|---|---|",
  ...Object.entries(s.models).map(([m, v]) => `| ${label(m)} | ${v.graph.n} | ${f(v.graph.f1)} | ${f(v.vector.f1)} |`),
].join("\n");
const mixNote = s.mixedModels
  ? `The questions were split across models: Groq's free daily token caps stopped the rotation part way, so the questions without a finished pair were completed with OpenAI gpt-5.6-luna. Each question was answered by one model, and its graph and vector runs always used that same model, so every comparison is paired within a question. The models received different mixes of categories, so the per-model rows are not a ranking of the models. Which model answered each question is listed in [\`eval/summary.json\`](eval/summary.json) and on every question at [/eval](https://threadline-graph.vercel.app/eval).`
  : "";
const cite = s.overall.graph.citationValidity !== null ? ` ${Math.round((s.overall.graph.citationValidity ?? 0) * 100)} percent of the graph agent's citations were verified by a graph path.` : "";
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const latency = Object.entries(s.models)
  .map(([m, v]) => `${sec(v.graph.p50ms)} graph and ${sec(v.vector.p50ms)} vector on ${m}`)
  .join(", ");
const latencyNote = ` Median latency in the eval: ${latency}. The Groq runs went back to back under an 8,000 tokens per minute limit, so their graph latencies include waiting for that limit; single live questions took 1.6 to 15 s in testing.`;
const tokens = `The graph agent used about ${Math.round(s.overall.graph.tokens).toLocaleString("en-US")} tokens per answer against ${Math.round(s.overall.vector.tokens).toLocaleString("en-US")} for the baseline.`;

const block = `${status} Models: ${models}.${mixNote ? `\n\n${mixNote}` : ""}

${table}

${s.mixedModels ? `${modelTable}\n\n` : ""}${tokens}${cite}${latencyNote} ${vectorNote} Every question, gold answer, raw answer and score is in [\`eval/\`](eval/) and on [/eval](https://threadline-graph.vercel.app/eval).`;

function between(file: string, start: string, end: string, body: string) {
  const text = readFileSync(file, "utf8");
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < 0) throw new Error(`${file}: markers ${start} / ${end} not found`);
  writeFileSync(file, text.slice(0, a + start.length) + "\n" + body + "\n" + text.slice(b));
}

between("README.md", "<!-- EVAL:START -->", "<!-- EVAL:END -->", `Method: 60 questions in six categories, generated from templates over the raw GitHub JSON. Gold answers are computed by \`eval/gold.ts\` from that JSON without FalkorDB, so the graph never grades itself. Both systems use the same model, the same 256-dimension embeddings and the same FalkorDB vector index; scores are set-based F1 over each answer's final ANSWER line.\n\n${block}`);
between("docs/BLOG_DRAFT.md", "<!-- EVAL:START -->", "<!-- EVAL:END -->", block.replace("(eval/)", "(https://github.com/StarKnightt/threadline/tree/main/eval)").replace("(eval/summary.json)", "(https://github.com/StarKnightt/threadline/blob/main/eval/summary.json)"));

const vs = readFileSync("docs/VIDEO_SCRIPT.md", "utf8").split("\n");
const i = vs.findIndex((l) => l.startsWith("| 2:12 to 2:28 |"));
if (i >= 0) {
  const g = f(s.overall.graph.f1);
  const v = f(s.overall.vector.f1);
  const scope = done ? `sixty questions` : `the first ${s.pairedQuestions} of sixty questions`;
  const who = s.mixedModels
    ? `, split across ${Object.entries(s.models).map(([m, v]) => `${m.split("/").pop()} for ${v.graph.n}`).join(", ")}, with both systems always on the same model for a given question`
    : ", and the same model for both systems";
  vs[i] = `| 2:12 to 2:28 | \`09-eval\` | We measured it on ${scope}, with gold answers computed from the raw GitHub data without FalkorDB${who}. The graph agent scored an F1 of ${g}, against ${v} for vector retrieval. The gap is widest on ${strongest} questions${bestVector?.[0] === "lookup" ? ", and vector search holds up best on simple lookups" : ""}. |`;
  writeFileSync("docs/VIDEO_SCRIPT.md", vs.join("\n"));
}
console.log(`docs updated: ${s.pairedQuestions}/${total} pairs, graph ${f(s.overall.graph.f1)} vs vector ${f(s.overall.vector.f1)}, widest gap: ${strongest}`);
