import "server-only";
import { createHash } from "node:crypto";
import { DERIVED } from "./cypher/schema";
import { BRAIN, SHARED, db, query } from "./falkor";

const ORG = process.env.TL_ORG ?? "FalkorDB";
const REPOS = (process.env.TL_REPOS ?? "FalkorDB,falkordb-browser,QueryWeaver,GraphRAG-SDK,falkordb-ts,FalkorDB-MCPServer").split(",");
const BOT = /(\[bot\]$|^dependabot|^github-actions|^copilot|^coderabbitai|^codecov|^sonarcloud|^renovate|^gemini-code-assist|^qodo|^codeant|^ellipsis-dev|^sourcery-ai|^cursor|^devin-ai|^greptile|^vercel|^netlify|^claude$)/i;

const FIELDS = `number title state url createdAt updatedAt closedAt body
  author { login __typename avatarUrl }
  labels(first: 15) { nodes { name color } }
  timelineItems(first: 30, itemTypes: [CROSS_REFERENCED_EVENT]) { nodes { ... on CrossReferencedEvent { createdAt source { ... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } } } } } }`;
const QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    pullRequests(first:20, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ${FIELDS} mergedAt additions deletions changedFiles baseRefName
      reviews(first: 30) { nodes { author { login __typename } state submittedAt } }
      files(first: 100) { nodes { path additions deletions } }
      closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } } } }
    issues(first:20, orderBy:{field:UPDATED_AT,direction:DESC}){ nodes{ ${FIELDS} } }
  }
}`;

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ts = (s?: string | null) => (s ? Math.floor(Date.parse(s) / 1000) : null);
const clean = (t?: string | null) =>
  (t ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

async function embed(texts: string[]): Promise<number[][]> {
  if (!texts.length || !process.env.OPENAI_API_KEY) return [];
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts, dimensions: 256 }),
  });
  if (!res.ok) return [];
  const j = (await res.json()) as { data: { embedding: number[] }[] };
  return j.data.map((d) => d.embedding);
}

/** Incremental sync: MERGE threads updated since the last run, recompute derived edges, prune old memory graphs. */
export async function sync() {
  const t0 = Date.now();
  const { rows } = await query<{ at: number }>(BRAIN, "MATCH (s:SyncRun) RETURN max(s.at) AS at");
  const meta = await query<{ loadedAt: number }>(BRAIN, "MATCH (m:Meta {key: 'meta'}) RETURN m.loadedAt AS loadedAt");
  const since = rows[0]?.at ?? Math.floor((meta.rows[0]?.loadedAt ?? Date.now()) / 1000);
  let items = 0;
  const newChunks: { key: string; owner: string; text: string; repo: string; at: number | null }[] = [];

  // Without a token the run still counts as daily use of the free instance and prunes memory graphs.
  for (const repo of process.env.GITHUB_TOKEN ? REPOS : []) {
    const full = `${ORG}/${repo}`;
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${process.env.GITHUB_TOKEN}`, "Content-Type": "application/json", "User-Agent": "threadline-sync" },
      body: JSON.stringify({ query: QUERY, variables: { owner: ORG, name: repo } }),
    });
    if (!res.ok) continue;
    const data = ((await res.json()) as { data?: Any }).data?.repository;
    if (!data) continue;
    const threads = [
      ...data.pullRequests.nodes.filter(Boolean).map((t: Any) => ({ t, kind: "pr" })),
      ...data.issues.nodes.filter(Boolean).map((t: Any) => ({ t, kind: "issue" })),
    ].filter(({ t }) => (ts(t.updatedAt) ?? 0) > since);

    for (const { t, kind } of threads) {
      const key = `${kind}:${full}#${t.number}`;
      const body = clean(t.body);
      const login = t.author?.login as string | undefined;
      await query(
        BRAIN,
        `MERGE (n:Entity:Thread:${kind === "pr" ? "PullRequest" : "Issue"} {key: $key})
SET n += $props
WITH n
MATCH (r:Repo {key: $repo}) MERGE (n)-[:IN_REPO]->(r)
WITH n
FOREACH (_ IN CASE WHEN $login IS NULL THEN [] ELSE [1] END |
  MERGE (p:Entity:Person {key: 'person:' + $login})
  ON CREATE SET p.login = $login, p.isBot = $isBot
  MERGE (p)-[a:AUTHORED]->(n) SET a.at = $createdAt)
FOREACH (l IN $labels |
  MERGE (lb:Entity:Label {key: 'label:' + $full + ':' + l.name}) ON CREATE SET lb.name = l.name, lb.color = l.color, lb.repo = $full
  MERGE (n)-[:HAS_LABEL]->(lb))`,
        {
          key,
          repo: `repo:${full}`,
          full,
          login: login ?? null,
          isBot: login ? BOT.test(login) || t.author?.__typename === "Bot" : false,
          createdAt: ts(t.createdAt),
          labels: (t.labels?.nodes ?? []).filter(Boolean).map((l: Any) => ({ name: l.name, color: l.color })),
          props: Object.fromEntries(
            Object.entries({
              number: t.number,
              title: t.title,
              state: t.state,
              createdAt: ts(t.createdAt),
              closedAt: ts(t.closedAt),
              updatedAt: ts(t.updatedAt),
              mergedAt: ts(t.mergedAt),
              url: t.url,
              repo: full,
              summary: body.slice(0, 600),
              author: login ?? null,
              additions: t.additions,
              deletions: t.deletions,
              changedFiles: t.changedFiles,
              baseRef: t.baseRefName,
            }).filter(([, v]) => v !== undefined && v !== null),
          ),
        },
      );
      if (kind === "pr") {
        const reviews = (t.reviews?.nodes ?? []).filter((r: Any) => r?.author?.login && r.author.login !== login).map((r: Any) => ({ login: r.author.login, state: r.state, at: ts(r.submittedAt), isBot: BOT.test(r.author.login) || r.author.__typename === "Bot" }));
        const files = (t.files?.nodes ?? []).filter(Boolean).map((f: Any) => {
          const parts = f.path.split("/");
          parts.pop();
          const dirs = parts.slice(0, 6).map((_: string, i: number) => parts.slice(0, i + 1).join("/"));
          return { path: f.path, additions: f.additions, deletions: f.deletions, dir: dirs.length ? dirs[dirs.length - 1] : "/", ext: f.path.includes(".") ? f.path.split(".").pop().toLowerCase() : "" };
        });
        const closes = (t.closingIssuesReferences?.nodes ?? []).filter(Boolean).map((r: Any) => `issue:${r.repository.nameWithOwner}#${r.number}`);
        await query(
          BRAIN,
          `MATCH (n:PullRequest {key: $key})
FOREACH (r IN $reviews |
  MERGE (p:Entity:Person {key: 'person:' + r.login}) ON CREATE SET p.login = r.login, p.isBot = r.isBot
  MERGE (p)-[e:REVIEWED]->(n) SET e.state = r.state, e.at = r.at)
FOREACH (f IN $files |
  MERGE (fl:Entity:File {key: 'file:' + $full + ':' + f.path}) ON CREATE SET fl.path = f.path, fl.ext = f.ext, fl.repo = $full
  MERGE (n)-[t:TOUCHED]->(fl) SET t.additions = f.additions, t.deletions = f.deletions
  MERGE (d:Entity:Directory {key: 'dir:' + $full + ':' + f.dir}) ON CREATE SET d.path = f.dir, d.repo = $full
  MERGE (fl)-[:IN_DIR]->(d))
WITH n
UNWIND $closes AS ik
MATCH (i:Issue {key: ik})
MERGE (n)-[c:CLOSES]->(i) ON CREATE SET c.source = 'closingReference'`,
          { key, full, reviews, files, closes },
        );
      }
      const refs = (t.timelineItems?.nodes ?? []).filter((e: Any) => e?.source?.number).map((e: Any) => ({ src: `${e.source.repository.nameWithOwner}#${e.source.number}`, at: ts(e.createdAt), cross: e.source.repository.nameWithOwner.toLowerCase() !== full.toLowerCase() }));
      if (refs.length) {
        await query(
          BRAIN,
          `MATCH (n:Thread {key: $key})
UNWIND $refs AS r
MATCH (s:Thread) WHERE s.key IN ['pr:' + r.src, 'issue:' + r.src]
MERGE (s)-[e:REFERENCES]->(n) ON CREATE SET e.at = r.at, e.crossRepo = r.cross, e.source = 'timeline'`,
          { key, refs },
        );
      }
      if (body.length >= 80 && !(login && BOT.test(login))) newChunks.push({ key: `chunk:${key}:0`, owner: key, text: `${t.title}. ${body}`.slice(0, 1200), repo: full, at: ts(t.createdAt) });
      items++;
    }
  }

  const vecs = await embed(newChunks.map((c) => c.text));
  if (vecs.length === newChunks.length && newChunks.length) {
    await query(
      BRAIN,
      `UNWIND $rows AS row
MATCH (o:Thread {key: row.owner})
MERGE (c:Chunk {key: row.key})
SET c.text = left(row.text, 600), c.kind = 'body', c.repo = row.repo, c.at = row.at, c.owner = row.owner, c.embedding = vecf32(row.e), c.h = row.h
MERGE (c)-[:PART_OF {i: 0}]->(o)`,
      { rows: newChunks.map((c, i) => ({ ...c, e: vecs[i], h: createHash("sha1").update(c.text).digest("hex").slice(0, 12) })) },
    );
  }

  if (items) for (const d of DERIVED) await query(BRAIN, d.cypher, {}, { timeout: 60000 });

  // Prune per-user memory graphs idle for more than 3 days (the free tier has 100 MB in total).
  let pruned = 0;
  const client = await db("rw");
  const cutoff = Math.floor(Date.now() / 1000) - 3 * 86400;
  for (const g of await client.list()) {
    if (!g.startsWith("tl_mem_")) continue;
    const last = await query<{ at: number }>(g, "MATCH (t:Turn) RETURN max(t.at) AS at").catch(() => ({ rows: [{ at: 0 }] }));
    if ((last.rows[0]?.at ?? 0) < cutoff) {
      await client.selectGraph(g).delete().catch(() => {});
      pruned++;
    }
  }
  await query(SHARED, "MATCH (r:Rate) WHERE r.exp < $now DELETE r", { now: Math.floor(Date.now() / 1000) }).catch(() => {});

  const now = Math.floor(Date.now() / 1000);
  await query(BRAIN, "CREATE (:SyncRun {at: $now, items: $items, chunks: $chunks, ms: $ms, pruned: $pruned})", { now, items, chunks: newChunks.length, ms: Date.now() - t0, pruned });
  return { since, items, chunks: newChunks.length, pruned, ms: Date.now() - t0 };
}
