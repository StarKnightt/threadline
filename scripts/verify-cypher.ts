// Run every catalogue query against the live graph with sample parameters and record row counts and timings.
// Writes docs/cypher-verification.json. Usage: pnpm verify:cypher
import { writeFileSync } from "node:fs";
import "./lib/env";
import { BRAIN, close, query } from "../src/lib/falkor";
import { Q } from "../src/lib/cypher/catalogue";
import { hash, loadCache } from "./embed";

const now = Math.floor(Date.now() / 1000);

async function main() {
  // A real chunk embedding stands in for a question vector (no OpenAI call needed).
  const { rows: sample } = await query<{ key: string; text: string }>(BRAIN, "MATCH (c:Chunk)-[:PART_OF]->(:PullRequest) WHERE c.text CONTAINS 'vector' RETURN c.key AS key, c.text AS text LIMIT 1");
  const cache = loadCache();
  const { rows: et } = await query<{ e: number[] }>(BRAIN, "MATCH (c:Chunk {key: $k}) RETURN c.embedding AS e", { k: sample[0].key });
  const vec = et[0]?.e ?? cache.values().next().value!;
  void hash;

  const { rows: iss } = await query<{ key: string }>(BRAIN, "MATCH (pr:PullRequest)-[:CLOSES]->(i:Issue) WHERE (pr)-[:SHIPPED_IN]->() RETURN i.key AS key LIMIT 1");
  const { rows: pr } = await query<{ key: string }>(BRAIN, "MATCH (pr:PullRequest)-[:SHIPPED_IN]->() WHERE (pr)-[:CLOSES]->() AND ()-[:REVIEWED]->(pr) RETURN pr.key AS key LIMIT 1");
  const { rows: xr } = await query<{ a: string; b: string }>(BRAIN, "MATCH (a:Issue)<-[r:REFERENCES]-(b:Thread) WHERE r.crossRepo = true RETURN a.key AS a, b.key AS b LIMIT 1");

  const cases: [string, string, Record<string, unknown>][] = [
    ["vectorEntry", Q.vectorEntry, { vec, k: 16, limit: 6 }],
    ["fulltextEntry", Q.fulltextEntry, { text: "vector | index", limit: 6 }],
    ["byKeys", Q.byKeys, { keys: ["person:swilly22", "repo:FalkorDB/QueryWeaver"] }],
    ["threadByNumber", Q.threadByNumber, { number: 1000, repo: "FalkorDB" }],
    ["conceptMatch", Q.conceptMatch, { text: "vector index" }],
    ["details", Q.details, { key: pr[0].key }],
    ["expand", Q.expand, { key: "person:swilly22", types: ["REVIEWED"], limit: 10 }],
    ["whoKnowsArea", Q.whoKnowsArea, { term: "src/index", repo: "FalkorDB", now }],
    ["whoKnowsConcept", Q.whoKnowsConcept, { concept: "concept:vector-index", repo: null, now }],
    ["declaredOwners", Q.declaredOwners, { areas: ["dir:FalkorDB/FalkorDB:/", "dir:FalkorDB/FalkorDB:src"] }],
    ["traceIssue", Q.traceIssue, { key: iss[0].key }],
    ["tracePr", Q.tracePr, { key: pr[0].key }],
    ["references", Q.references, { key: xr[0]?.a ?? iss[0].key }],
    ["connect", Q.connect, { a: xr[0]?.b ?? pr[0].key, b: "person:swilly22" }],
    ["impactOpenPrs", Q.impactOpenPrs, { term: "src/index", repo: "FalkorDB" }],
    ["impactOpenIssues", Q.impactOpenIssues, { term: "src/index", repo: "FalkorDB" }],
    ["coChanges", Q.coChanges, { term: "src/index", repo: "FalkorDB" }],
    ["activity.AUTHORED", Q.activity.AUTHORED, { repo: "falkordb-browser", since: 1735689600, until: 1767225600, limit: 5, kind: "issue" }],
    ["activity.REVIEWED", Q.activity.REVIEWED, { repo: "falkordb-ts", since: 1735689600, until: 1767225600, limit: 5 }],
    ["activity.MERGED", Q.activity.MERGED, { repo: "FalkorDB", since: 0, until: 4102444800, limit: 5 }],
    ["activity.COMMENTED_ON", Q.activity.COMMENTED_ON, { repo: null, since: 0, until: 4102444800, limit: 5 }],
    ["activityInArea", Q.activityInArea, { area: "src/index", repo: "FalkorDB", rel: "AUTHORED", since: 0, until: 4102444800, limit: 5 }],
    ["pageRankReviewers", Q.pageRankReviewers, {}],
    ["betweennessBridges", Q.betweennessBridges, {}],
    ["subsystems", Q.subsystems, {}],
    ["verifyPath", Q.verifyPath, { entry: "concept:vector-index", cited: "person:swilly22" }],
    ["neighbourhood", Q.neighbourhood, { key: "repo:FalkorDB/falkordb-ts" }],
    ["vectorRag", Q.vectorRag, { vec, k: 8 }],
  ];

  const results: Record<string, unknown>[] = [];
  let failed = 0;
  for (const [name, cypher, params] of cases) {
    const t = Date.now();
    try {
      const { rows } = await query(BRAIN, cypher, params, { ro: true, timeout: 20000 });
      const ms = Date.now() - t;
      const first = rows[0] ? JSON.stringify(rows[0]).slice(0, 220) : "(no rows)";
      console.log(`OK   ${name.padEnd(22)} rows=${String(rows.length).padStart(3)} ${String(ms).padStart(5)}ms  ${first}`);
      results.push({ name, ok: true, rows: rows.length, ms, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, Array.isArray(v) && v.length > 16 ? "[256-dim vector]" : v])), first: rows[0] ?? null });
    } catch (e) {
      failed++;
      console.log(`FAIL ${name.padEnd(22)} ${(e as Error).message.slice(0, 300)}`);
      results.push({ name, ok: false, error: (e as Error).message });
    }
  }
  writeFileSync("docs/cypher-verification.json", JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(failed ? `${failed} failed` : "all queries passed");
}

main().finally(close);
