// Map cached GitHub JSON (data/raw) to graph rows with stable keys (data/graph/rows.json).
// Deterministic: no network, no LLM. Usage: pnpm ingest:normalise
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONCEPTS, conceptsIn } from "./lib/concepts";
import { DOCS_REPO, ORG, REPOS } from "./lib/env";

const RAW = "data/raw";
const SINCE = Date.parse(process.env.TL_SINCE ?? "2023-01-01T00:00:00Z") / 1000;
const MAX_DIR_DEPTH = 6;
const SNIPPET = 600;

type Props = Record<string, unknown>;
type NodeRow = { key: string; labels: string; props: Props };
type EdgeRow = { type: string; from: string; to: string; fromLabel: string; toLabel: string; props: Props };

const nodes = new Map<string, NodeRow>();
const edges = new Map<string, EdgeRow>();

function node(key: string, labels: string, props: Props) {
  const prev = nodes.get(key);
  if (prev) Object.assign(prev.props, Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined && v !== null)));
  else nodes.set(key, { key, labels, props: { ...props } });
}
function edge(type: string, from: string, to: string, props: Props = {}, fromLabel = "Entity", toLabel = "Entity") {
  const id = `${type}|${from}|${to}`;
  const prev = edges.get(id);
  if (prev) Object.assign(prev.props, props);
  else edges.set(id, { type, from, to, fromLabel, toLabel, props });
}

const ts = (s?: string | null) => (s ? Math.floor(Date.parse(s) / 1000) : null);
const readJsonl = (p: string) =>
  existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const BOT_LOGINS = /(\[bot\]$|^dependabot|^github-actions|^copilot|^coderabbitai|^codecov|^sonarcloud|^renovate|^gemini-code-assist|^qodo|^codeant|^ellipsis-dev|^sourcery-ai|^cursor|^devin-ai|^greptile|^vercel|^netlify|^allcontributors|^claude$)/i;

type Author = { login: string; __typename?: string; avatarUrl?: string } | null;
function person(a: Author, at: number | null): string | null {
  if (!a?.login) return null;
  const login = a.login.replace(/\[bot\]$/, "") + (a.login.endsWith("[bot]") ? "[bot]" : "");
  const isBot = a.__typename === "Bot" || BOT_LOGINS.test(login);
  const key = `person:${login}`;
  const prev = nodes.get(key);
  const first = Math.min((prev?.props.firstSeenAt as number) ?? Infinity, at ?? Infinity);
  const last = Math.max((prev?.props.lastSeenAt as number) ?? 0, at ?? 0);
  node(key, "Entity:Person", {
    login,
    isBot,
    avatarUrl: a.avatarUrl ?? (prev?.props.avatarUrl as string) ?? `https://avatars.githubusercontent.com/${login.replace(/\[bot\]$/, "")}`,
    firstSeenAt: Number.isFinite(first) ? first : null,
    lastSeenAt: last || null,
  });
  return key;
}

/** Strip markdown/HTML noise so snippets and embeddings carry the actual words. */
function clean(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/<details>[\s\S]*?<\/details>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chunksOf(text: string, size = 1200): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > 0 && out.length < 4) {
    if (rest.length <= size) {
      out.push(rest);
      break;
    }
    let cut = rest.lastIndexOf(". ", size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(" ", size);
    if (cut < 0) cut = size;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  return out.filter((c) => c.length >= 80);
}

// Number -> key, per repo, so "#123" can be resolved to an issue or a PR.
const threadKeyByRef = new Map<string, string>();
const refKey = (repoFull: string, n: number) => `${repoFull.toLowerCase()}#${n}`;

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const raw: { repo: string; issues: Raw[]; pulls: Raw[]; releases: Raw[]; meta: Raw; codeowners: string | null }[] = [];

for (const repo of REPOS) {
  const dir = join(RAW, repo);
  if (!existsSync(join(dir, "repo.json"))) {
    console.warn(`skip ${repo}: not fetched`);
    continue;
  }
  raw.push({
    repo,
    meta: JSON.parse(readFileSync(join(dir, "repo.json"), "utf8")),
    issues: readJsonl(join(dir, "issues.jsonl")),
    pulls: readJsonl(join(dir, "pulls.jsonl")),
    releases: readJsonl(join(dir, "releases.jsonl")),
    codeowners: existsSync(join(dir, "CODEOWNERS")) ? readFileSync(join(dir, "CODEOWNERS"), "utf8") : null,
  });
}

const keep = (t: Raw) => Math.max(ts(t.updatedAt) ?? 0, ts(t.createdAt) ?? 0) >= SINCE;

// Pass 1: register thread keys so cross references can be resolved in pass 2.
for (const r of raw) {
  const full = `${ORG}/${r.repo}`;
  for (const i of r.issues.filter(keep)) threadKeyByRef.set(refKey(full, i.number), `issue:${full}#${i.number}`);
  for (const p of r.pulls.filter(keep)) threadKeyByRef.set(refKey(full, p.number), `pr:${full}#${p.number}`);
}

const REF_RE = /(?:https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+))|(?:\b([\w.-]+\/[\w.-]+)#(\d+))|(?:(?:^|[\s(])#(\d+)\b)/g;
function refsInText(text: string, repoFull: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(REF_RE)) {
    const repo = m[1] ?? m[3] ?? repoFull;
    const n = Number(m[2] ?? m[4] ?? m[5]);
    const k = threadKeyByRef.get(refKey(repo, n));
    if (k) out.add(k);
  }
  return [...out];
}
const CLOSE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+((?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+)|(?:[\w.-]+\/[\w.-]+)?#\d+)/gi;

function dirChain(repoFull: string, path: string): string {
  const parts = path.split("/");
  parts.pop();
  const depth = Math.min(parts.length, MAX_DIR_DEPTH);
  let parentKey = `dir:${repoFull}:/`;
  node(parentKey, "Entity:Directory", { path: "/", depth: 0, repo: repoFull });
  edge("IN_REPO", parentKey, `repo:${repoFull}`);
  for (let d = 1; d <= depth; d++) {
    const p = parts.slice(0, d).join("/");
    const key = `dir:${repoFull}:${p}`;
    node(key, "Entity:Directory", { path: p, depth: d, repo: repoFull });
    edge("IN_DIR", key, parentKey);
    parentKey = key;
  }
  return parentKey;
}

let chunkCount = 0;
function addChunks(ownerKey: string, ownerLabel: string, kind: string, text: string, startIndex: number, at: number | null, repoFull: string | null) {
  let i = startIndex;
  for (const c of chunksOf(text)) {
    const key = `chunk:${ownerKey}:${i}`;
    node(key, "Chunk", { text: c.slice(0, SNIPPET), embedText: c, kind, at, repo: repoFull, owner: ownerKey });
    edge("PART_OF", key, ownerKey, { i }, "Chunk", ownerLabel);
    for (const cid of conceptsIn(c)) edge("MENTIONS", key, `concept:${cid}`, {}, "Chunk", "Entity");
    i++;
    chunkCount++;
  }
  return i;
}

node(`org:${ORG}`, "Entity:Org", { name: ORG });
for (const c of CONCEPTS) node(`concept:${c.id}`, "Entity:Concept", { name: c.name, aliases: c.aliases.join(", ") });

for (const r of raw) {
  const full = `${ORG}/${r.repo}`;
  const repoKey = `repo:${full}`;
  node(repoKey, "Entity:Repo", { name: r.repo, fullName: full, language: r.meta.language, stars: r.meta.stars, url: r.meta.url, description: r.meta.description });
  edge("HAS_REPO", `org:${ORG}`, repoKey);

  const threads = [
    ...r.issues.filter(keep).map((t) => ({ t, kind: "issue" as const })),
    ...r.pulls.filter(keep).map((t) => ({ t, kind: "pr" as const })),
  ];

  for (const { t, kind } of threads) {
    const key = `${kind}:${full}#${t.number}`;
    const createdAt = ts(t.createdAt);
    const body = clean(t.body);
    const labels = kind === "pr" ? "Entity:Thread:PullRequest" : "Entity:Thread:Issue";
    const props: Props = {
      number: t.number,
      title: t.title,
      state: t.state,
      createdAt,
      closedAt: ts(t.closedAt),
      updatedAt: ts(t.updatedAt),
      url: t.url,
      repo: full,
      summary: body.slice(0, SNIPPET),
      commentCount: t.comments?.totalCount ?? 0,
    };
    if (kind === "pr") Object.assign(props, { mergedAt: ts(t.mergedAt), additions: t.additions, deletions: t.deletions, changedFiles: t.changedFiles, baseRef: t.baseRefName });
    else props.stateReason = t.stateReason ?? null;
    if (t.author?.login) props.author = t.author.login;
    node(key, labels, props);
    edge("IN_REPO", key, repoKey);

    const author = person(t.author, createdAt);
    if (author) edge("AUTHORED", author, key, { at: createdAt });
    for (const l of (t.labels?.nodes ?? []).filter(Boolean)) {
      const lk = `label:${full}:${l.name}`;
      node(lk, "Entity:Label", { name: l.name, color: l.color, repo: full });
      edge("HAS_LABEL", key, lk);
    }
    for (const a of (t.assignees?.nodes ?? []).filter(Boolean)) {
      const pk = person(a, null);
      if (pk) edge("ASSIGNED_TO", key, pk);
    }

    // Comments: aggregate COMMENTED_ON per person; non-bot comment text becomes chunks.
    const isBotThread = nodes.get(author ?? "")?.props.isBot === true;
    let ci = 0;
    if (!isBotThread && body) ci = addChunks(key, "Thread", "body", `${t.title}. ${body}`, 0, createdAt, full);
    else if (!isBotThread) ci = addChunks(key, "Thread", "body", `${t.title}. ${t.title}`.padEnd(90, " "), 0, createdAt, full);
    for (const c of (t.comments?.nodes ?? []).filter(Boolean)) {
      const at = ts(c.createdAt);
      const pk = person(c.author, at);
      if (!pk) continue;
      const id = `COMMENTED_ON|${pk}|${key}`;
      const prev = edges.get(id)?.props;
      edge("COMMENTED_ON", pk, key, {
        count: ((prev?.count as number) ?? 0) + 1,
        firstAt: Math.min((prev?.firstAt as number) ?? Infinity, at ?? Infinity),
        lastAt: Math.max((prev?.lastAt as number) ?? 0, at ?? 0),
      });
      if (!nodes.get(pk)?.props.isBot && !isBotThread) {
        const text = clean(c.body);
        if (text.length >= 120) ci = addChunks(key, "Thread", "comment", text, ci, at, full);
      }
    }

    const allText = `${t.title} ${body}`;
    for (const cid of conceptsIn(allText)) edge("MENTIONS", key, `concept:${cid}`);

    // References: timeline cross-references (source -> this), plus #N in the body (this -> target).
    for (const ev of (t.timelineItems?.nodes ?? []).filter(Boolean)) {
      if (ev.__typename === "CrossReferencedEvent" && ev.source?.number) {
        const src = threadKeyByRef.get(refKey(ev.source.repository.nameWithOwner, ev.source.number));
        if (src && src !== key) edge("REFERENCES", src, key, { at: ts(ev.createdAt), crossRepo: ev.source.repository.nameWithOwner.toLowerCase() !== full.toLowerCase(), source: "timeline" });
      }
      if (ev.__typename === "ConnectedEvent" && ev.subject?.number) {
        const other = threadKeyByRef.get(refKey(ev.subject.repository.nameWithOwner, ev.subject.number));
        if (other && other !== key) {
          if (kind === "pr" && other.startsWith("issue:")) edge("CLOSES", key, other, { source: "connected" });
          if (kind === "issue" && other.startsWith("pr:")) edge("CLOSES", other, key, { source: "connected" });
        }
      }
    }
    for (const target of refsInText(t.body ?? "", full)) {
      if (target !== key) edge("REFERENCES", key, target, { at: createdAt, crossRepo: !target.includes(`:${full}#`), source: "body" });
    }

    if (kind === "pr") {
      for (const ref of (t.closingIssuesReferences?.nodes ?? []).filter(Boolean)) {
        const ik = threadKeyByRef.get(refKey(ref.repository.nameWithOwner, ref.number));
        if (ik?.startsWith("issue:")) edge("CLOSES", key, ik, { source: "closingReference" });
      }
      for (const m of (t.body ?? "").matchAll(CLOSE_RE)) {
        for (const ik of refsInText(m[1].startsWith("#") ? ` ${m[1]}` : m[1], full)) {
          if (ik.startsWith("issue:") && !edges.has(`CLOSES|${key}|${ik}`)) edge("CLOSES", key, ik, { source: "keyword" });
        }
      }
      for (const rv of (t.reviews?.nodes ?? []).filter(Boolean)) {
        const at = ts(rv.submittedAt);
        const pk = person(rv.author, at);
        if (!pk || pk === author) continue;
        const id = `REVIEWED|${pk}|${key}`;
        const prev = edges.get(id)?.props;
        const rank = (s: string) => ({ APPROVED: 3, CHANGES_REQUESTED: 2, COMMENTED: 1 })[s] ?? 0;
        const state = prev && rank(prev.state as string) >= rank(rv.state) ? prev.state : rv.state;
        edge("REVIEWED", pk, key, { state, at: Math.max((prev?.at as number) ?? 0, at ?? 0), count: ((prev?.count as number) ?? 0) + 1 });
      }
      if (t.mergedBy?.login && t.mergedBy.login !== t.author?.login) {
        const pk = person(t.mergedBy, ts(t.mergedAt));
        if (pk) edge("MERGED", pk, key, { at: ts(t.mergedAt) });
      }
      for (const f of (t.files?.nodes ?? []).filter(Boolean)) {
        const fk = `file:${full}:${f.path}`;
        const ext = f.path.includes(".") ? f.path.split(".").pop()!.toLowerCase() : "";
        node(fk, "Entity:File", { path: f.path, ext, repo: full, name: f.path.split("/").pop() });
        edge("TOUCHED", key, fk, { additions: f.additions, deletions: f.deletions });
        edge("IN_DIR", fk, dirChain(full, f.path));
      }
    }
  }

  // Releases: PREVIOUS chain; SHIPPED_IN from release notes, then by merge date for the rest.
  const rels = r.releases
    .filter((x) => !x.isDraft && x.publishedAt)
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  let prevKey: string | null = null;
  const shipped = new Set<string>();
  for (const rel of rels) {
    const rk = `release:${full}@${rel.tagName}`;
    node(rk, "Entity:Release", { tag: rel.tagName, name: rel.name, publishedAt: ts(rel.publishedAt), url: rel.url, prerelease: rel.isPrerelease, repo: full, notes: clean(rel.description).slice(0, SNIPPET) });
    edge("IN_REPO", rk, repoKey);
    if (prevKey) edge("PREVIOUS", rk, prevKey);
    prevKey = rk;
    for (const pk of refsInText(rel.description ?? "", full)) {
      if (pk.startsWith("pr:")) {
        edge("SHIPPED_IN", pk, rk, { source: "notes" });
        shipped.add(pk);
      }
    }
  }
  const stable = rels.filter((x) => !x.isPrerelease);
  for (const p of r.pulls.filter(keep)) {
    const pk = `pr:${full}#${p.number}`;
    if (!p.mergedAt || shipped.has(pk) || p.baseRefName !== r.meta.defaultBranch) continue;
    const merged = Date.parse(p.mergedAt);
    const rel = stable.find((x) => Date.parse(x.publishedAt) >= merged);
    if (rel) edge("SHIPPED_IN", pk, `release:${full}@${rel.tagName}`, { source: "tagRange" });
  }

  // CODEOWNERS: declared ownership (people only; team handles are skipped).
  if (r.codeowners) {
    for (const line of r.codeowners.split("\n")) {
      const [pattern, ...owners] = line.trim().split(/\s+/);
      if (!pattern || pattern.startsWith("#")) continue;
      const p = pattern.replace(/^\//, "").replace(/\/\*{0,2}$/, "");
      const target = p === "*" || p === "" ? `dir:${full}:/` : nodes.has(`dir:${full}:${p}`) ? `dir:${full}:${p}` : nodes.has(`file:${full}:${p}`) ? `file:${full}:${p}` : null;
      if (!target) continue;
      for (const o of owners) {
        if (!o.startsWith("@") || o.includes("/")) continue;
        const pk = person({ login: o.slice(1) }, null);
        if (pk) edge("DECLARED_OWNER", pk, target, { pattern });
      }
    }
  }
}

// Docs: one Doc per markdown page, chunked by section.
const docs = readJsonl(join(RAW, DOCS_REPO, "docs.jsonl"));
for (const d of docs) {
  const path = (d.path as string).replace(/\.mdx?$/, "").replace(/\/index$/, "");
  const key = `doc:${DOCS_REPO}:${path}`;
  const fm = /^---\n([\s\S]*?)\n---/.exec(d.text);
  const title = /title:\s*"?([^"\n]+)"?/.exec(fm?.[1] ?? "")?.[1] ?? /^#\s+(.+)$/m.exec(d.text)?.[1] ?? path;
  const body = d.text.replace(/^---\n[\s\S]*?\n---/, "");
  node(key, "Entity:Doc", { title: title.trim(), path, url: d.url });
  const titleConcepts = new Set(conceptsIn(`${title} ${path.replace(/[-/]/g, " ")}`));
  for (const cid of conceptsIn(body)) edge(titleConcepts.has(cid) ? "DOCUMENTS" : "MENTIONS", key, `concept:${cid}`);
  let i = 0;
  for (const section of body.split(/\n(?=#{1,3}\s)/)) {
    const text = clean(section);
    if (text.length < 80) continue;
    i = addChunks(key, "Doc", "doc", `${title}: ${text}`, i, null, null);
  }
}

// Drop edges whose endpoints were filtered out (for example references to items before SINCE).
let dropped = 0;
for (const [id, e] of edges) {
  if (!nodes.has(e.from) || !nodes.has(e.to)) {
    edges.delete(id);
    dropped++;
  }
}
for (const e of edges.values()) {
  if (e.type === "COMMENTED_ON") {
    if (!Number.isFinite(e.props.firstAt)) e.props.firstAt = null;
    if (!e.props.lastAt) e.props.lastAt = null;
  }
}

mkdirSync("data/graph", { recursive: true });
const byLabel: Record<string, number> = {};
for (const n of nodes.values()) byLabel[n.labels] = (byLabel[n.labels] ?? 0) + 1;
const byType: Record<string, number> = {};
for (const e of edges.values()) byType[e.type] = (byType[e.type] ?? 0) + 1;
writeFileSync("data/graph/rows.json", JSON.stringify({ org: ORG, since: SINCE, generatedAt: new Date().toISOString(), nodes: [...nodes.values()], edges: [...edges.values()] }));
console.log("nodes", nodes.size, byLabel);
console.log("edges", edges.size, byType, `(dropped ${dropped} dangling)`);
console.log("chunks", chunkCount);
