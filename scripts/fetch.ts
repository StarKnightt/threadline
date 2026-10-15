// Fetch public GitHub data for the configured org into data/raw/<repo>/*.jsonl.
// Resumable: the last cursor per (repo, kind) is kept in data/raw/<repo>/<kind>.cursor.
// Usage: pnpm fetch [repo...]   (defaults to TL_REPOS) ; pnpm fetch --docs
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOCS_REPO, ORG, REPOS, need } from "./lib/env";

const TOKEN = need("GITHUB_TOKEN");
const RAW = "data/raw";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json", "User-Agent": "threadline-ingest" },
      body: JSON.stringify({ query, variables }),
    });
    if (res.status === 502 || res.status === 504 || res.status === 403 || res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || 5000 * (attempt + 1);
      console.warn(`  GitHub ${res.status}, waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors?.length && !json.data) throw new Error(json.errors.map((e) => e.message).join("; "));
    if (json.errors?.length) console.warn("  partial errors:", json.errors.map((e) => e.message).join("; ").slice(0, 300));
    return json.data as T;
  }
  throw new Error("GitHub GraphQL kept failing");
}

const REF = `... on Issue { number repository { nameWithOwner } } ... on PullRequest { number repository { nameWithOwner } }`;
const COMMON = `
  number title state url createdAt updatedAt closedAt body
  author { login __typename avatarUrl }
  labels(first: 15) { nodes { name color } }
  assignees(first: 5) { nodes { login } }
  comments(first: 6) { totalCount nodes { author { login __typename } body createdAt } }
  timelineItems(first: 40, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
    nodes {
      __typename
      ... on CrossReferencedEvent { createdAt source { ${REF} } }
      ... on ConnectedEvent { createdAt subject { ${REF} } }
    }
  }`;

const QUERIES = {
  pulls: `query($owner:String!,$name:String!,$cursor:String){
    repository(owner:$owner,name:$name){
      pullRequests(first:25, after:$cursor, orderBy:{field:CREATED_AT,direction:ASC}){
        pageInfo{hasNextPage endCursor}
        nodes{ ${COMMON}
          mergedAt additions deletions changedFiles baseRefName
          mergedBy { login }
          reviews(first: 40) { nodes { author { login __typename } state submittedAt } }
          files(first: 100) { nodes { path additions deletions } }
          closingIssuesReferences(first: 10) { nodes { number repository { nameWithOwner } } }
        }
      }
    }
    rateLimit{cost remaining resetAt}
  }`,
  issues: `query($owner:String!,$name:String!,$cursor:String){
    repository(owner:$owner,name:$name){
      issues(first:50, after:$cursor, orderBy:{field:CREATED_AT,direction:ASC}){
        pageInfo{hasNextPage endCursor}
        nodes{ ${COMMON} stateReason }
      }
    }
    rateLimit{cost remaining resetAt}
  }`,
  releases: `query($owner:String!,$name:String!,$cursor:String){
    repository(owner:$owner,name:$name){
      releases(first:50, after:$cursor, orderBy:{field:CREATED_AT,direction:ASC}){
        pageInfo{hasNextPage endCursor}
        nodes{ tagName name url publishedAt createdAt isPrerelease isDraft description
          tagCommit: tag { target { oid } } }
      }
    }
    rateLimit{cost remaining resetAt}
  }`,
} as const;

type Page = {
  repository: Record<string, { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: unknown[] }>;
  rateLimit: { cost: number; remaining: number; resetAt: string };
};

async function fetchKind(repo: string, kind: keyof typeof QUERIES) {
  const dir = join(RAW, repo);
  mkdirSync(dir, { recursive: true });
  const cursorFile = join(dir, `${kind}.cursor`);
  const out = join(dir, `${kind}.jsonl`);
  let cursor: string | null = existsSync(cursorFile) ? readFileSync(cursorFile, "utf8").trim() || null : null;
  if (cursor === "DONE") return console.log(`${repo}/${kind}: already complete`);
  const field = kind === "pulls" ? "pullRequests" : kind;
  let total = 0;
  for (;;) {
    const data = await gql<Page>(QUERIES[kind], { owner: ORG, name: repo, cursor });
    const conn = data.repository[field];
    if (conn.nodes.length) appendFileSync(out, conn.nodes.map((n) => JSON.stringify(n)).join("\n") + "\n");
    total += conn.nodes.length;
    const rl = data.rateLimit;
    process.stdout.write(`\r${repo}/${kind}: ${total} (cost ${rl.cost}, remaining ${rl.remaining})   `);
    if (!conn.pageInfo.hasNextPage) {
      writeFileSync(cursorFile, "DONE");
      break;
    }
    cursor = conn.pageInfo.endCursor;
    writeFileSync(cursorFile, cursor ?? "");
    if (rl.remaining < 200) {
      const wait = new Date(rl.resetAt).getTime() - Date.now() + 5000;
      console.log(`\n  rate limit low, sleeping ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
    await sleep(400);
  }
  console.log();
}

async function rest(path: string) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `bearer ${TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "threadline-ingest" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function fetchMeta(repo: string) {
  const dir = join(RAW, repo);
  mkdirSync(dir, { recursive: true });
  const meta = (await rest(`/repos/${ORG}/${repo}`)) as Record<string, unknown>;
  writeFileSync(
    join(dir, "repo.json"),
    JSON.stringify({ name: meta.name, fullName: meta.full_name, language: meta.language, stars: meta.stargazers_count, url: meta.html_url, description: meta.description, defaultBranch: meta.default_branch }, null, 2),
  );
  for (const p of [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"]) {
    const f = (await rest(`/repos/${ORG}/${repo}/contents/${p}`)) as { content?: string } | null;
    if (f?.content) {
      writeFileSync(join(dir, "CODEOWNERS"), Buffer.from(f.content, "base64").toString("utf8"));
      break;
    }
  }
}

async function fetchDocs() {
  const dir = join(RAW, DOCS_REPO);
  mkdirSync(dir, { recursive: true });
  const meta = (await rest(`/repos/${ORG}/${DOCS_REPO}`)) as { default_branch: string; html_url: string };
  const tree = (await rest(`/repos/${ORG}/${DOCS_REPO}/git/trees/${meta.default_branch}?recursive=1`)) as { tree: { path: string; type: string }[] };
  const files = tree.tree.filter((t) => t.type === "blob" && /\.mdx?$/.test(t.path) && !/^(README|CONTRIBUTING|LICENSE)/i.test(t.path));
  const out = join(dir, "docs.jsonl");
  writeFileSync(out, "");
  let n = 0;
  for (const f of files) {
    const res = await fetch(`https://raw.githubusercontent.com/${ORG}/${DOCS_REPO}/${meta.default_branch}/${f.path}`);
    if (!res.ok) continue;
    appendFileSync(out, JSON.stringify({ path: f.path, url: `${meta.html_url}/blob/${meta.default_branch}/${f.path}`, text: await res.text() }) + "\n");
    process.stdout.write(`\rdocs: ${++n}/${files.length}   `);
    await sleep(80);
  }
  console.log();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--docs")) return fetchDocs();
  const repos = args.length ? args : REPOS;
  for (const repo of repos) {
    await fetchMeta(repo);
    for (const kind of ["releases", "issues", "pulls"] as const) await fetchKind(repo, kind);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
