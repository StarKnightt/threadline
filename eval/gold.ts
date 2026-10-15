// Build the 60-question evaluation set with gold answers computed directly from the raw GitHub JSON
// in data/raw. This file deliberately shares no code with the normaliser or FalkorDB, so the graph
// is never grading itself. Usage: pnpm eval:gold
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ORG = "FalkorDB";
const REPOS = ["FalkorDB", "falkordb-browser", "QueryWeaver", "GraphRAG-SDK", "falkordb-ts", "FalkorDB-MCPServer"];
const SINCE = Date.parse("2023-01-01T00:00:00Z");
const PER_CATEGORY = 10;

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Question = { id: string; category: string; question: string; gold: string[]; goldKeys: string[]; detail: string };

// Seeded RNG (mulberry32) so the question set is reproducible.
let seed = 20261015;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const shuffle = <T>(xs: T[]) => xs.map((x) => [rand(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

const jsonl = (p: string): Any[] => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const isBot = (a: Any | null) => !a?.login || a.__typename === "Bot" || /\[bot\]$|^dependabot|^github-actions|^copilot|^coderabbitai|^codecov|^sonarcloud|^renovate|^gemini-code-assist|^qodo|^codeant|^ellipsis-dev|^sourcery-ai|^cursor|^devin-ai|^greptile|^vercel|^netlify|^claude$/i.test(a.login);
const inScope = (t: Any) => Math.max(Date.parse(t.updatedAt ?? t.createdAt), Date.parse(t.createdAt)) >= SINCE;

const data = REPOS.filter((r) => existsSync(join("data/raw", r, "repo.json"))).map((repo) => ({
  repo,
  meta: JSON.parse(readFileSync(join("data/raw", repo, "repo.json"), "utf8")),
  issues: jsonl(join("data/raw", repo, "issues.jsonl")).filter(inScope),
  pulls: jsonl(join("data/raw", repo, "pulls.jsonl")).filter(inScope),
  releases: jsonl(join("data/raw", repo, "releases.jsonl")).filter((r) => !r.isDraft && r.publishedAt),
}));

const questions: Question[] = [];
const push = (category: string, q: Omit<Question, "id" | "category"> & Partial<Question>) => {
  const id = `${category}-${String(questions.filter((x) => x.category === category).length + 1).padStart(2, "0")}`;
  questions.push({ question: q.question, gold: q.gold, goldKeys: q.goldKeys, detail: q.detail, id, category });
};

// 1. Single-hop lookup (control): who opened a PR. Vector retrieval should do fine here.
{
  const pool = shuffle(data.flatMap((d) => d.pulls.filter((p) => p.mergedAt && !isBot(p.author) && (p.body ?? "").length > 300).map((p) => ({ d, p }))));
  const used = new Set<string>();
  for (const { d, p } of pool) {
    if (questions.filter((q) => q.category === "lookup").length >= PER_CATEGORY) break;
    if (used.has(d.repo) && used.size < data.length) continue;
    used.add(d.repo);
    push("lookup", {
      question: `Who opened pull request #${p.number} in the ${d.repo} repository, and what was it about?`,
      gold: [p.author.login.toLowerCase()],
      goldKeys: [`pr:${ORG}/${d.repo}#${p.number}`, `person:${p.author.login}`],
      detail: p.title,
    });
  }
}

// Files under a directory, per merged PR, for expertise and impact questions.
const under = (path: string, dir: string) => path.startsWith(dir + "/");
function dirsOf(d: (typeof data)[number]) {
  const counts = new Map<string, number>();
  for (const p of d.pulls) {
    if (!p.mergedAt || isBot(p.author)) continue;
    const dirs = new Set<string>();
    for (const f of (p.files?.nodes ?? []).filter(Boolean)) {
      const parts = f.path.split("/");
      for (let i = 1; i < Math.min(parts.length, 4); i++) dirs.add(parts.slice(0, i).join("/"));
    }
    dirs.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
  }
  return counts;
}

// 2. Expertise: top authors of merged PRs touching a directory.
const top3 = (ranked: [string, number][]) => ranked.slice(0, 3).map(([l]) => l.toLowerCase());
{
  const cands: { d: (typeof data)[number]; dir: string }[] = [];
  for (const d of data) for (const [dir, n] of dirsOf(d)) if (!dir.startsWith(".") && (dir.includes("/") ? n >= 6 : n >= 12)) cands.push({ d, dir });
  for (const { d, dir } of shuffle(cands)) {
    if (questions.filter((q) => q.category === "expertise").length >= PER_CATEGORY) break;
    const by = new Map<string, number>();
    for (const p of d.pulls) {
      if (!p.mergedAt || isBot(p.author)) continue;
      if ((p.files?.nodes ?? []).filter(Boolean).some((f: Any) => under(f.path, dir))) by.set(p.author.login, (by.get(p.author.login) ?? 0) + 1);
    }
    const ranked = [...by.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length < 3 || ranked[2][1] < 2) continue;
    // Keep only unambiguous top-3 (no tie across the cut).
    if (ranked[3] && ranked[3][1] === ranked[2][1]) continue;
    // At most three directories per repo, and never a parent and child directory with the same answer.
    const same = questions.filter((q) => q.category === "expertise" && q.detail.startsWith(d.repo + ":"));
    if (same.length >= 3 || same.some((q) => q.gold.join() === top3(ranked).join())) continue;
    const top = ranked.slice(0, 3);
    push("expertise", {
      question: `Who has authored the most merged pull requests that touch files under ${dir}/ in the ${d.repo} repository? Name the top three.`,
      gold: top.map(([l]) => l.toLowerCase()),
      goldKeys: [`dir:${ORG}/${d.repo}:${dir}`, ...top.map(([l]) => `person:${l}`)],
      detail: `${d.repo}:${dir} ${top.map(([l, n]) => `${l}=${n}`).join(", ")}`,
    });
  }
}

// PR numbers referenced in release notes, per repo (the unambiguous SHIPPED_IN source).
const prRe = (repo: string) => new RegExp(`(?:github\\.com/${ORG}/${repo.replace(/[.-]/g, "\\$&")}/pull/(\\d+))|(?:\\s#(\\d+)\\b)`, "gi");
function shippedIn(d: (typeof data)[number]) {
  const m = new Map<number, string[]>();
  for (const r of d.releases) for (const x of (r.description ?? "").matchAll(prRe(d.repo))) {
    const n = Number(x[1] ?? x[2]);
    m.set(n, [...(m.get(n) ?? []), r.tagName]);
  }
  return m;
}

// 3. Decision trace: issue -> fixing PR -> release.
{
  const pool: Question[] = [];
  for (const d of data) {
    const ship = shippedIn(d);
    const prs = new Map(d.pulls.map((p) => [p.number, p]));
    const fixers = new Map<number, Set<number>>();
    for (const p of d.pulls) for (const ref of (p.closingIssuesReferences?.nodes ?? []).filter(Boolean)) {
      if (ref.repository.nameWithOwner.toLowerCase() !== `${ORG}/${d.repo}`.toLowerCase()) continue;
      fixers.set(ref.number, new Set([...(fixers.get(ref.number) ?? []), p.number]));
    }
    for (const i of d.issues) {
      const f = [...(fixers.get(i.number) ?? [])].filter((n) => prs.get(n)?.mergedAt);
      if (f.length !== 1) continue;
      const tags = ship.get(f[0]);
      if (!tags || tags.length !== 1) continue;
      pool.push({
        id: "",
        category: "trace",
        question: `Which pull request fixed issue #${i.number} in the ${d.repo} repository, and in which release did the fix ship?`,
        gold: [`#${f[0]}`, tags[0].toLowerCase()],
        goldKeys: [`issue:${ORG}/${d.repo}#${i.number}`, `pr:${ORG}/${d.repo}#${f[0]}`, `release:${ORG}/${d.repo}@${tags[0]}`],
        detail: i.title,
      });
    }
  }
  for (const q of shuffle(pool).slice(0, PER_CATEGORY)) push("trace", q);
}

// 4. Cross-repo connections: which threads in other repos reference this issue or PR.
{
  const known = new Set(data.flatMap((d) => [...d.issues, ...d.pulls].map((t) => `${ORG}/${d.repo}#${t.number}`.toLowerCase())));
  const pool: Question[] = [];
  for (const d of data) {
    for (const t of [...d.issues, ...d.pulls]) {
      const refs = new Set<string>();
      for (const ev of (t.timelineItems?.nodes ?? []).filter(Boolean)) {
        if (ev.__typename !== "CrossReferencedEvent" || !ev.source?.number) continue;
        const src = `${ev.source.repository.nameWithOwner}#${ev.source.number}`;
        if (ev.source.repository.nameWithOwner.toLowerCase() === `${ORG}/${d.repo}`.toLowerCase()) continue;
        if (known.has(src.toLowerCase())) refs.add(src);
      }
      if (refs.size < 1 || refs.size > 5) continue;
      const kind = d.issues.includes(t) ? "issue" : "pull request";
      pool.push({
        id: "",
        category: "cross_repo",
        question: `Which issues or pull requests in other FalkorDB repositories reference ${kind} #${t.number} in the ${d.repo} repository?`,
        gold: [...refs].map((r) => `#${r.split("#")[1]}`),
        goldKeys: [`${kind === "issue" ? "issue" : "pr"}:${ORG}/${d.repo}#${t.number}`],
        detail: `${t.title} <- ${[...refs].join(", ")}`,
      });
    }
  }
  for (const q of shuffle(pool).slice(0, PER_CATEGORY)) push("cross_repo", q);
}

// 5. Impact: open PRs touching a directory.
{
  const pool: Question[] = [];
  for (const d of data) {
    const open = d.pulls.filter((p) => p.state === "OPEN");
    const dirs = new Map<string, Set<number>>();
    for (const p of open) for (const f of (p.files?.nodes ?? []).filter(Boolean)) {
      const parts = f.path.split("/");
      for (let i = 1; i < Math.min(parts.length, 4); i++) {
        const dir = parts.slice(0, i).join("/");
        dirs.set(dir, new Set([...(dirs.get(dir) ?? []), p.number]));
      }
    }
    for (const [dir, nums] of dirs) {
      if (nums.size < 1 || nums.size > 6) continue;
      pool.push({
        id: "",
        category: "impact",
        question: `Which open pull requests currently touch files under ${dir}/ in the ${d.repo} repository?`,
        gold: [...nums].map((n) => `#${n}`),
        goldKeys: [`dir:${ORG}/${d.repo}:${dir}`, ...[...nums].map((n) => `pr:${ORG}/${d.repo}#${n}`)],
        detail: `${d.repo}:${dir}`,
      });
    }
  }
  for (const q of shuffle(pool).slice(0, PER_CATEGORY)) push("impact", q);
}

// 6. Aggregation over relationships: top reviewers or issue openers in a repo and year.
{
  const pool: Question[] = [];
  for (const d of data) {
    for (const year of [2024, 2025]) {
      const from = Date.UTC(year, 0, 1);
      const to = Date.UTC(year + 1, 0, 1);
      const inYear = (t: Any) => Date.parse(t.createdAt) >= from && Date.parse(t.createdAt) < to;
      const rev = new Map<string, Set<number>>();
      for (const p of d.pulls.filter(inYear)) for (const r of (p.reviews?.nodes ?? []).filter(Boolean)) {
        if (isBot(r.author) || r.author.login === p.author?.login) continue;
        rev.set(r.author.login, new Set([...(rev.get(r.author.login) ?? []), p.number]));
      }
      const rr = [...rev.entries()].map(([l, s]) => [l, s.size] as const).sort((a, b) => b[1] - a[1]);
      if (rr.length >= 3 && (!rr[3] || rr[3][1] !== rr[2][1]) && rr[2][1] >= 3)
        pool.push({ id: "", category: "aggregation", question: `Who reviewed the most pull requests in the ${d.repo} repository in ${year}? Name the top three.`, gold: rr.slice(0, 3).map(([l]) => l.toLowerCase()), goldKeys: [`repo:${ORG}/${d.repo}`], detail: rr.slice(0, 4).map(([l, n]) => `${l}=${n}`).join(", ") });
      const op = new Map<string, number>();
      for (const i of d.issues.filter(inYear)) if (!isBot(i.author)) op.set(i.author.login, (op.get(i.author.login) ?? 0) + 1);
      const oo = [...op.entries()].sort((a, b) => b[1] - a[1]);
      if (oo.length >= 3 && (!oo[3] || oo[3][1] !== oo[2][1]) && oo[2][1] >= 3)
        pool.push({ id: "", category: "aggregation", question: `Who opened the most issues in the ${d.repo} repository in ${year}? Name the top three.`, gold: oo.slice(0, 3).map(([l]) => l.toLowerCase()), goldKeys: [`repo:${ORG}/${d.repo}`], detail: oo.slice(0, 4).map(([l, n]) => `${l}=${n}`).join(", ") });
    }
  }
  for (const q of shuffle(pool).slice(0, PER_CATEGORY)) push("aggregation", q);
}

const byCat: Record<string, number> = {};
for (const q of questions) byCat[q.category] = (byCat[q.category] ?? 0) + 1;
writeFileSync("eval/questions.json", JSON.stringify({ generatedAt: new Date().toISOString(), since: "2023-01-01", questions }, null, 2));
console.log(`wrote ${questions.length} questions`, byCat);
