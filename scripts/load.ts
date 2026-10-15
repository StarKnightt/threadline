// Load data/graph/rows.json (+ cached embeddings) into FalkorDB, then compute derived edges.
// Usage: pnpm ingest:load [--reset] [--derived-only]
import { readFileSync } from "node:fs";
import "./lib/env";
import { BRAIN, close, db, query } from "../src/lib/falkor";
import { DERIVED, INDEXES } from "../src/lib/cypher/schema";
import { hash, loadCache } from "./embed";

type NodeRow = { key: string; labels: string; props: Record<string, unknown> };
type EdgeRow = { type: string; from: string; to: string; fromLabel: string; toLabel: string; props: Record<string, unknown> };

const args = process.argv.slice(2);
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

async function batched<T>(rows: T[], size: number, fn: (b: T[]) => Promise<unknown>, label: string) {
  for (let i = 0; i < rows.length; i += size) {
    await fn(rows.slice(i, i + size));
    process.stdout.write(`\r  ${label}: ${Math.min(i + size, rows.length)}/${rows.length}   `);
  }
  if (rows.length) console.log();
}

async function main() {
  if (args.includes("--reset")) {
    const client = await db("rw");
    const graphs = await client.list();
    if (graphs.includes(BRAIN)) await client.selectGraph(BRAIN).delete();
    console.log(`reset ${BRAIN}`);
  }

  if (!args.includes("--derived-only")) {
    const { nodes, edges } = JSON.parse(readFileSync("data/graph/rows.json", "utf8")) as { nodes: NodeRow[]; edges: EdgeRow[] };
    await query(BRAIN, "MERGE (m:Meta {key: 'meta'}) SET m.createdAt = timestamp()");
    for (const idx of INDEXES) {
      try {
        await query(BRAIN, idx);
      } catch (e) {
        const msg = (e as Error).message;
        if (!/already (indexed|exists)/i.test(msg)) console.warn(`  index warning: ${msg}`);
      }
    }
    console.log(`indexes ready (${secs()})`);

    const cache = loadCache();
    const groups = new Map<string, NodeRow[]>();
    for (const n of nodes) groups.set(n.labels, [...(groups.get(n.labels) ?? []), n]);
    let missing = 0;
    for (const [labels, rows] of groups) {
      if (labels === "Chunk") {
        const withVec = rows.map((r) => {
          const e = cache.get(hash((r.props.embedText as string).slice(0, 4000)));
          if (!e) missing++;
          const { embedText: _drop, ...props } = r.props; // eslint-disable-line @typescript-eslint/no-unused-vars
          return { key: r.key, props, embedding: e ?? null };
        });
        await batched(withVec, 150, (b) =>
          query(BRAIN, `UNWIND $rows AS row MERGE (n:Chunk {key: row.key}) SET n += row.props
            WITH n, row WHERE row.embedding IS NOT NULL SET n.embedding = vecf32(row.embedding)`, { rows: b }), "Chunk");
      } else {
        await batched(rows, 500, (b) =>
          query(BRAIN, `UNWIND $rows AS row MERGE (n:${labels} {key: row.key}) SET n += row.props`, { rows: b.map((r) => ({ key: r.key, props: r.props })) }), labels);
      }
    }
    if (missing) console.warn(`  ${missing} chunks loaded without embeddings (run pnpm ingest:embed)`);

    const egroups = new Map<string, EdgeRow[]>();
    for (const e of edges) {
      const k = `${e.type}|${e.fromLabel}|${e.toLabel}`;
      egroups.set(k, [...(egroups.get(k) ?? []), e]);
    }
    for (const [k, rows] of egroups) {
      const [type, fl, tl] = k.split("|");
      await batched(rows, 1000, (b) =>
        query(BRAIN, `UNWIND $rows AS row MATCH (a:${fl} {key: row.from}) MATCH (b:${tl} {key: row.to})
          MERGE (a)-[r:${type}]->(b) SET r += row.props`, { rows: b.map((e) => ({ from: e.from, to: e.to, props: e.props })) }), type);
    }
    console.log(`base graph loaded (${secs()})`);
  }

  for (const d of DERIVED) {
    const s = Date.now();
    const res = await query(BRAIN, d.cypher, {}, { timeout: 120000 });
    console.log(`  derived ${d.name}: ${res.metadata.filter((m) => /created|set/i.test(m)).join(", ")} (${Date.now() - s} ms)`);
  }

  const counts = await query<{ label: string; n: number }>(BRAIN, "MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n ORDER BY n DESC");
  console.log("labels", Object.fromEntries(counts.rows.map((r) => [r.label, r.n])));
  const rels = await query<{ t: string; n: number }>(BRAIN, "MATCH ()-[r]->() RETURN type(r) AS t, count(r) AS n ORDER BY n DESC");
  console.log("relationships", Object.fromEntries(rels.rows.map((r) => [r.t, r.n])));
  try {
    const client = await db("rw");
    const mem = await client.selectGraph(BRAIN).memoryUsage();
    console.log("GRAPH.MEMORY USAGE", mem);
  } catch (e) {
    console.warn("memory usage unavailable:", (e as Error).message);
  }
  await query(BRAIN, "MATCH (m:Meta {key: 'meta'}) SET m.loadedAt = timestamp()");
  console.log(`done (${secs()})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(close);
