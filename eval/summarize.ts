// Summarise eval/results.jsonl into eval/summary.json (per category and overall, per system).
// Only questions answered by both systems are counted, so the comparison is paired.
import { readFileSync, writeFileSync } from "node:fs";

type R = { id: string; category: string; system: "graph" | "vector"; model: string; f1: number; precision: number; recall: number; exact: boolean; tokens: number; ms: number; steps: number; verified: string | null };
const rows = readFileSync("eval/results.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as R);
// Default: every model in the rotation. Pass a model id to summarise one model alone.
const only = process.argv[2];
const use = only ? rows.filter((r) => r.model === only) : rows;
const pairKey = (r: R) => `${r.id}|${r.model}`;
const both = new Set([...new Set(use.map(pairKey))].filter((k) => use.some((r) => pairKey(r) === k && r.system === "graph") && use.some((r) => pairKey(r) === k && r.system === "vector")));
const paired = use.filter((r) => both.has(pairKey(r)));
const model = only ?? [...new Set(paired.map((r) => r.model))].join(", ");

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};
function stats(rs: R[]) {
  const ver = rs.map((r) => r.verified).filter((v): v is string => !!v).map((v) => v.split("/").map(Number));
  const cited = ver.filter(([, t]) => t > 0);
  return {
    n: rs.length,
    f1: avg(rs.map((r) => r.f1)),
    precision: avg(rs.map((r) => r.precision)),
    recall: avg(rs.map((r) => r.recall)),
    exact: avg(rs.map((r) => (r.exact ? 1 : 0))),
    tokens: avg(rs.map((r) => r.tokens)),
    p50ms: pct(rs.map((r) => r.ms), 50),
    p95ms: pct(rs.map((r) => r.ms), 95),
    steps: avg(rs.map((r) => r.steps)),
    citationValidity: cited.length ? cited.reduce((a, [v]) => a + v, 0) / cited.reduce((a, [, t]) => a + t, 0) : null,
    fullyGrounded: cited.length ? cited.filter(([v, t]) => v === t).length / cited.length : null,
  };
}

const categories = ["lookup", "expertise", "trace", "cross_repo", "impact", "aggregation"];
const summary = {
  model,
  generatedAt: new Date().toISOString(),
  pairedQuestions: both.size,
  totalQuestions: 60,
  overall: { graph: stats(paired.filter((r) => r.system === "graph")), vector: stats(paired.filter((r) => r.system === "vector")) },
  models: Object.fromEntries([...new Set(paired.map((r) => r.model))].map((m) => [m, { graph: stats(paired.filter((r) => r.model === m && r.system === "graph")), vector: stats(paired.filter((r) => r.model === m && r.system === "vector")) }])),
  categories: Object.fromEntries(
    categories.map((c) => [c, { graph: stats(paired.filter((r) => r.category === c && r.system === "graph")), vector: stats(paired.filter((r) => r.category === c && r.system === "vector")) }]),
  ),
};
writeFileSync("eval/summary.json", JSON.stringify(summary, null, 2));
console.log(`${both.size} paired questions (${model})`);
for (const c of categories) {
  const s = summary.categories[c];
  console.log(`${c.padEnd(12)} graph F1 ${s.graph.f1.toFixed(2)} (n=${s.graph.n})  vector F1 ${s.vector.f1.toFixed(2)}`);
}
console.log(`overall      graph F1 ${summary.overall.graph.f1.toFixed(2)}  vector F1 ${summary.overall.vector.f1.toFixed(2)}`);
