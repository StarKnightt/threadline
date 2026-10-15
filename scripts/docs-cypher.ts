// Generate docs/CYPHER.md from the catalogue source (doc comments + queries) and the live verification timings.
// Usage: pnpm docs:cypher
import { readFileSync, writeFileSync } from "node:fs";
import { Q } from "../src/lib/cypher/catalogue";
import { DERIVED, INDEXES } from "../src/lib/cypher/schema";

const src = readFileSync("src/lib/cypher/catalogue.ts", "utf8");
const memSrc = readFileSync("src/lib/memory.ts", "utf8");
const ver = JSON.parse(readFileSync("docs/cypher-verification.json", "utf8")) as { at: string; results: { name: string; ok: boolean; rows: number; ms: number }[] };
const timing = new Map(ver.results.map((r) => [r.name, r]));

const USED_BY: Record<string, string> = {
  vectorEntry: "find_entities", fulltextEntry: "find_entities", byKeys: "find_entities", threadByNumber: "find_entities", conceptMatch: "find_entities, who_knows",
  details: "details", expand: "expand", whoKnowsArea: "who_knows", whoKnowsConcept: "who_knows", declaredOwners: "who_knows",
  traceIssue: "trace", tracePr: "trace", references: "trace", connect: "connect", impactOpenPrs: "impact", impactOpenIssues: "impact", coChanges: "impact",
  activity: "activity", activityInArea: "activity", pageRankReviewers: "rank", betweennessBridges: "rank", subsystems: "rank", verifyPath: "Verifier",
  neighbourhood: "3D viewer", triageIssue: "draft_triage", triageSimilar: "draft_triage", triageOwners: "draft_triage", triageLabels: "draft_triage", vectorRag: "vector RAG baseline",
};

function docFor(source: string, key: string) {
  const re = new RegExp(`/\\*\\*\\s*([\\s\\S]*?)\\*/\\s*(?://[^\\n]*\\n\\s*)?${key}:`);
  const m = re.exec(source);
  return m ? m[1].replace(/\s*\n\s*\*?\s*/g, " ").trim() : "";
}

const out: string[] = [
  "# Cypher catalogue",
  "",
  "Every query Threadline runs against FalkorDB, generated from `src/lib/cypher/catalogue.ts`, `src/lib/cypher/schema.ts` and `src/lib/memory.ts` by `pnpm docs:cypher`. Values are always passed as parameters. Timings are from `pnpm verify:cypher` against the FalkorDB Cloud free instance (AWS ap-south-1), measured from a client in India, so they include the network round trip (about 63 ms).",
  "",
  `Last verification: ${ver.at} (${ver.results.filter((r) => r.ok).length} of ${ver.results.length} passed).`,
  "",
  "## FalkorDB specifics we hit",
  "",
  "- `shortestPath()` must be used in `WITH` or `RETURN`, not in `MATCH`, and it is directed only. For undirected checks the Verifier uses `allShortestPaths()` in `MATCH`, which accepts undirected patterns.",
  "- `algo.betweenness` follows edge direction. People only point at repos (`CONTRIBUTES_TO`), so no shortest path ran through a person and every score was 0. A derived reverse edge (`HAS_CONTRIBUTOR`) fixes it.",
  "- `db.idx.vector.queryNodes` yields a cosine **distance** as `score` (lower is closer). Queries convert it to similarity with `1 - score`.",
  "- Relationship aliases are referenced whenever we count, following the known-limitations note that unreferenced relationships are only checked for existence.",
  "",
  "## Indexes",
  "",
  "```cypher",
  ...INDEXES,
  "```",
  "",
  "## Derived edges (run after every load and by the daily sync)",
  "",
];
for (const d of DERIVED) out.push(`### ${d.name}`, "", "```cypher", d.cypher, "```", "");

out.push("## Tool queries", "");
for (const [k, v] of Object.entries(Q as Record<string, string | Record<string, string>>)) {
  const entries = typeof v === "string" ? [[k, v]] : Object.entries(v).map(([m, c]) => [`${k}.${m}`, c]);
  for (const [name, cypher] of entries) {
    const t = timing.get(name);
    out.push(`### \`${name}\``, "", `${docFor(src, k) || "Activity ranking variant."}`, "", `Used by: ${USED_BY[k] ?? "-"}${t?.ok ? `. Verified: ${t.rows} rows in ${t.ms} ms.` : ""}`, "", "```cypher", cypher, "```", "");
  }
}

out.push("## Memory, coordination and traces (`tl_mem_<visitor>` and `tl_shared` graphs)", "");
const memBlock = /export const MEM_Q = \{([\s\S]*?)\n\};/.exec(memSrc)?.[1] ?? "";
for (const m of memBlock.matchAll(/(?:\/\*\*\s*([\s\S]*?)\*\/\s*)?(\w+): `([\s\S]*?)`,/g)) {
  out.push(`### \`${m[2]}\``, "", m[1] ? m[1].replace(/\s*\n\s*\*?\s*/g, " ").trim() : "", "", "```cypher", m[3], "```", "");
}

writeFileSync("docs/CYPHER.md", out.join("\n"));
console.log(`wrote docs/CYPHER.md (${out.length} lines)`);
