// Compute the 3D "constellation" layout once and store x, y, z on the nodes in FalkorDB.
// Members: repos, active directories (depth 1-2), the most active people, concepts.
// Usage: pnpm layout
import "./lib/env";
// @ts-expect-error d3-force-3d ships without types
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from "d3-force-3d";
import { BRAIN, close, query } from "../src/lib/falkor";

type N = { id: string; label: string; weight: number; x?: number; y?: number; z?: number };
type L = { source: string; target: string; strength: number };

async function main() {
  const repos = (await query<{ key: string; n: number }>(BRAIN, "MATCH (r:Repo)<-[:IN_REPO]-(t:Thread) RETURN r.key AS key, count(t) AS n")).rows;
  const dirs = (
    await query<{ key: string; parent: string; repo: string; n: number }>(
      BRAIN,
      `MATCH (d:Directory)<-[:IN_DIR*1..6]-(:File)<-[t:TOUCHED]-(pr:PullRequest)
WHERE d.depth >= 1 AND d.depth <= 2 AND NOT d.path STARTS WITH '.'
WITH d, count(DISTINCT pr) AS n WHERE n >= 8
OPTIONAL MATCH (d)-[:IN_DIR]->(p:Directory)
RETURN d.key AS key, p.key AS parent, 'repo:' + d.repo AS repo, n ORDER BY n DESC LIMIT 160`,
    )
  ).rows;
  const people = (
    await query<{ key: string; n: number }>(
      BRAIN,
      `MATCH (p:Person)-[e:AUTHORED|REVIEWED|COMMENTED_ON]->(:Thread) WHERE p.isBot = false
RETURN p.key AS key, count(e) AS n ORDER BY n DESC LIMIT 220`,
    )
  ).rows;
  const concepts = (await query<{ key: string; repo: string; n: number }>(BRAIN, "MATCH (c:Concept)<-[:MENTIONS]-(t:Thread)-[:IN_REPO]->(r:Repo) RETURN c.key AS key, r.key AS repo, count(t) AS n")).rows;
  const contrib = (await query<{ p: string; r: string; w: number }>(BRAIN, "MATCH (p:Person)-[c:CONTRIBUTES_TO]->(r:Repo) RETURN p.key AS p, r.key AS r, coalesce(c.prs, 0) + coalesce(c.reviews, 0) + coalesce(c.issues, 0) AS w")).rows;
  const knows = (await query<{ p: string; d: string; w: number }>(BRAIN, "MATCH (p:Person)-[k:KNOWS]->(d:Directory) WHERE d.depth >= 1 AND d.depth <= 2 RETURN p.key AS p, d.key AS d, k.authored * 2 + k.reviewed AS w")).rows;

  const nodes = new Map<string, N>();
  repos.forEach((r) => nodes.set(r.key, { id: r.key, label: "Repo", weight: r.n }));
  dirs.forEach((d) => nodes.set(d.key, { id: d.key, label: "Directory", weight: d.n }));
  people.forEach((p) => nodes.set(p.key, { id: p.key, label: "Person", weight: p.n }));
  const conceptTotals = new Map<string, number>();
  concepts.forEach((c) => conceptTotals.set(c.key, (conceptTotals.get(c.key) ?? 0) + c.n));
  for (const [k, n] of conceptTotals) if (n >= 5) nodes.set(k, { id: k, label: "Concept", weight: n });

  const links: L[] = [];
  for (const d of dirs) links.push({ source: d.key, target: d.parent && nodes.has(d.parent) ? d.parent : d.repo, strength: 0.9 });
  for (const c of contrib) if (nodes.has(c.p) && nodes.has(c.r) && c.w >= 2) links.push({ source: c.p, target: c.r, strength: Math.min(0.6, 0.05 + c.w / 200) });
  for (const k of knows) if (nodes.has(k.p) && nodes.has(k.d) && k.w >= 6) links.push({ source: k.p, target: k.d, strength: 0.15 });
  for (const c of concepts) if (nodes.has(c.key) && nodes.has(c.repo) && c.n >= 5) links.push({ source: c.key, target: c.repo, strength: Math.min(0.5, c.n / 300) });

  const list = [...nodes.values()];
  // Seed repos on a ring so the layout is reproducible and readable.
  repos.forEach((r, i) => {
    const n = nodes.get(r.key)!;
    const a = (i / repos.length) * Math.PI * 2;
    Object.assign(n, { x: Math.cos(a) * 260, y: (i % 2 ? 1 : -1) * 40, z: Math.sin(a) * 260 });
  });
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (const n of list) if (n.x === undefined) Object.assign(n, { x: rnd() * 300, y: rnd() * 300, z: rnd() * 300 });

  const sim = forceSimulation(list, 3)
    .force("link", forceLink(links).id((d: N) => d.id).strength((l: L) => l.strength).distance((l: { source: N | string }) => ((typeof l.source === "string" ? l.source : l.source.id).startsWith("dir:") ? 40 : 90)))
    .force("charge", forceManyBody().strength((d: N) => (d.label === "Repo" ? -900 : -60)))
    .force("collide", forceCollide((d: N) => (d.label === "Repo" ? 40 : 8)))
    .force("center", forceCenter(0, 0, 0))
    .stop();
  for (let i = 0; i < 400; i++) sim.tick();

  const rows = list.map((n) => ({ key: n.id, x: Math.round(n.x! * 10) / 10, y: Math.round(n.y! * 10) / 10, z: Math.round(n.z! * 10) / 10, w: n.weight }));
  await query(BRAIN, "MATCH (n:Entity) WHERE n.x IS NOT NULL REMOVE n.x, n.y, n.z, n.w");
  for (let i = 0; i < rows.length; i += 300) {
    await query(BRAIN, "UNWIND $rows AS row MATCH (n:Entity {key: row.key}) SET n.x = row.x, n.y = row.y, n.z = row.z, n.w = row.w", { rows: rows.slice(i, i + 300) });
  }
  console.log(`laid out ${rows.length} nodes (${repos.length} repos, ${dirs.length} dirs, ${people.length} people, ${[...conceptTotals.values()].filter((n) => n >= 5).length} concepts), ${links.length} links`);
}

main().finally(close);
