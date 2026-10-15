import "server-only";
import { tool } from "ai";
import { z } from "zod";
import { Q } from "../cypher/catalogue";
import { BRAIN, query, type Row } from "../falkor";
import { embedQuestion } from "../embed";
import type { TraceEdge, TraceStep } from "./types";

export const KEY_RE = /^(pr|issue|person|file|dir|release|doc|concept|repo|label|org):/;

export type ToolCtx = {
  now: number;
  steps: TraceStep[];
  emit: (event: Record<string, unknown>) => void;
};

/** Collect every node key mentioned anywhere in the rows (these light up in the viewer and may be cited). */
function refsOf(rows: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (KEY_RE.test(v)) out.add(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(rows);
  return [...out];
}

/** Shrink rows before they go back to the model: drop nulls, clip strings, cap row count. */
function compact(rows: Row[], max = 12): Row[] {
  const clip = (v: unknown): unknown => {
    if (typeof v === "string") return v.length > 180 ? v.slice(0, 180) + "…" : v;
    if (typeof v === "number") return Number.isInteger(v) ? v : Math.round(v * 1000) / 1000;
    if (Array.isArray(v)) return v.slice(0, 8).map(clip);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, clip(x)]));
    return v;
  };
  return rows.slice(0, max).map(({ draft, ...r }) => ({ ...(clip(r) as Row), ...(typeof draft === "string" ? { draft } : {}) }));
}

const tsToDate = (s: unknown) => (typeof s === "number" && s > 1e9 ? new Date(s * 1000).toISOString().slice(0, 10) : s);
function datesReadable(rows: Row[]): Row[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, /At$/.test(k) ? tsToDate(v) : v])));
}

type Run = { cypher: string; params: Record<string, unknown>; rows: Row[]; ms: number };

async function run(cypher: string, params: Record<string, unknown> = {}, ro = true): Promise<Run> {
  const t = Date.now();
  const { rows } = await query(BRAIN, cypher, params, { ro, timeout: 8000 });
  return { cypher, params, rows, ms: Date.now() - t };
}

async function step(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>,
  body: () => Promise<{ runs: Run[]; rows: Row[]; edges?: TraceEdge[]; note?: string; refs?: string[] }>,
) {
  const n = ctx.steps.length + 1;
  ctx.emit({ type: "step_start", step: n, tool: name, args });
  const t = Date.now();
  try {
    const out = await body();
    const rows = datesReadable(out.rows);
    const refs = out.refs ?? refsOf(rows);
    const s: TraceStep = {
      step: n,
      tool: name,
      args,
      queries: out.runs.map((r) => ({ cypher: r.cypher, params: redactParams(r.params), rows: r.rows.length, ms: r.ms })),
      ms: Date.now() - t,
      refs,
      edges: out.edges ?? [],
      rows: compact(rows, 20),
      note: out.note,
    };
    ctx.steps.push(s);
    ctx.emit({ type: "step_result", ...s });
    const forModel = compact(rows, 10).map(({ labels: _l, ...r }) => r); // eslint-disable-line @typescript-eslint/no-unused-vars
    return { rows: forModel, ...(out.note ? { note: out.note } : {}) };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    const s: TraceStep = { step: n, tool: name, args, queries: [], ms: Date.now() - t, refs: [], edges: [], rows: [], error: msg };
    ctx.steps.push(s);
    ctx.emit({ type: "step_result", ...s });
    return { error: msg };
  }
}

function redactParams(p: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Array.isArray(v) && v.length > 16 && typeof v[0] === "number" ? `[${v.length}-dim vector]` : v]));
}

/** RediSearch query syntax treats many characters as operators; keep words only. */
const ftText = (s: string) =>
  s
    .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()))
    .slice(0, 8)
    .join(" | ");
const STOP = new Set("the and for who what which with that this from into have has was were are about most recently should when why how did does any last month year code change changes review".split(" "));

const shortRef = (k: string) => k.replace(/^(?:pr|issue):FalkorDB\//, "").replace(/^(?:pr|issue):/, "");

const repoArg = z.string().optional().describe("Repository short name, for example FalkorDB, falkordb-browser, QueryWeaver, GraphRAG-SDK, falkordb-ts, FalkorDB-MCPServer");

export function makeTools(ctx: ToolCtx) {
  return {
    find_entities: tool({
      description:
        "Resolve words in the question to graph nodes. Combines exact lookup (issue or PR numbers, logins, keys), full-text search over titles, names and paths, concept matching, and vector search over text chunks mapped back to their thread or doc. Always call this first.",
      inputSchema: z.object({
        text: z.string().describe("The phrase to resolve, for example 'vector index' or 'browser login bug'"),
        number: z.number().int().optional().describe("Issue or PR number if the question names one"),
        repo: repoArg,
      }),
      execute: async ({ text, number, repo }) =>
        step(ctx, "find_entities", { text, number, repo }, async () => {
          const runs: Run[] = [];
          const found = new Map<string, Row>();
          const add = (rows: Row[], via: string) => rows.forEach((r) => !found.has(r.key as string) && found.set(r.key as string, { ...r, via }));
          if (number) {
            const r = await run(Q.threadByNumber, { number, repo: repo ?? null });
            runs.push(r);
            add(r.rows, "number");
          }
          const keys = [...text.matchAll(/\b((?:pr|issue|person|file|dir|release|doc|concept|repo):[^\s,;]+)/g)].map((m) => m[1]);
          const logins = [...text.matchAll(/@([\w-]+)/g)].map((m) => `person:${m[1]}`);
          if (keys.length + logins.length) {
            const r = await run(Q.byKeys, { keys: [...keys, ...logins] });
            runs.push(r);
            add(r.rows, "key");
          }
          const words = text.replace(/\b(?:pr|issue|person|file|dir|release|doc|concept|repo):[^\s,;]+/g, " ").replace(/@[\w-]+/g, " ").trim();
          if (words.length >= 3) {
            const c = await run(Q.conceptMatch, { text: words.slice(0, 60) });
            runs.push(c);
            add(c.rows, "concept");
            const ft = ftText(words);
            if (ft) {
              const r = await run(Q.fulltextEntry, { text: ft, limit: 6 });
              runs.push(r);
              add(r.rows, "fulltext");
            }
            const vec = await embedQuestion(words);
            const v = await run(Q.vectorEntry, { vec, k: 16, limit: 6 });
            runs.push(v);
            add(v.rows, "vector");
          }
          return { runs, rows: [...found.values()].slice(0, 12) };
        }),
    }),

    details: tool({
      description: "Read one node's properties (title, state, dates, summary) and how many relationships of each type it has.",
      inputSchema: z.object({ key: z.string().describe("Node key, for example issue:FalkorDB/FalkorDB#123") }),
      execute: async ({ key }) =>
        step(ctx, "details", { key }, async () => {
          const r = await run(Q.details, { key });
          return { runs: [r], rows: r.rows, refs: [key] };
        }),
    }),

    expand: tool({
      description:
        "Step one hop out from a node. Optionally restrict relationship types: AUTHORED, REVIEWED, MERGED, COMMENTED_ON, ASSIGNED_TO, HAS_LABEL, TOUCHED, IN_DIR, CLOSES, REFERENCES, SHIPPED_IN, PREVIOUS, MENTIONS, DOCUMENTS, KNOWS, CONTRIBUTES_TO, REVIEWS_FOR, CO_CHANGES, DECLARED_OWNER, IN_REPO.",
      inputSchema: z.object({
        key: z.string(),
        types: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(40).optional(),
      }),
      execute: async ({ key, types, limit }) =>
        step(ctx, "expand", { key, types, limit }, async () => {
          const r = await run(Q.expand, { key, types: (types ?? []).map((t) => t.toUpperCase()), limit: limit ?? 20 });
          const edges: TraceEdge[] = r.rows.map((x) => (x.outgoing ? [key, x.rel as string, x.key as string] : [x.key as string, x.rel as string, key]));
          return { runs: [r], rows: r.rows, edges };
        }),
    }),

    who_knows: tool({
      description:
        "Who knows an area now. 'area' is a directory or file path fragment (for example 'src/index' or 'vector') or a concept key from find_entities (concept:vector-index). Uses derived KNOWS edges (authored and reviewed merged PRs per directory) with recency decay, plus a concept walk (concept <- PRs that mention it <- their authors and reviewers), and lists CODEOWNERS entries for comparison.",
      inputSchema: z.object({ area: z.string(), repo: repoArg }),
      execute: async ({ area, repo }) =>
        step(ctx, "who_knows", { area, repo }, async () => {
          const runs: Run[] = [];
          const rows: Row[] = [];
          const edges: TraceEdge[] = [];
          let concept = area.startsWith("concept:") ? area : null;
          if (!concept && !/[/:.]/.test(area)) {
            const c = await run(Q.conceptMatch, { text: area.trim().slice(0, 60) });
            runs.push(c);
            concept = (c.rows[0]?.key as string) ?? null;
          }
          if (concept) {
            const r = await run(Q.whoKnowsConcept, { concept, repo: repo ?? null, now: ctx.now });
            runs.push(r);
            for (const x of r.rows) {
              rows.push({ ...x, via: "concept" });
              for (const s of (x.sample as string[]) ?? []) edges.push([x.key as string, "AUTHORED|REVIEWED", s], [s, "MENTIONS", concept]);
            }
          }
          if (!area.startsWith("concept:")) {
            const base = area.replace(/^(dir|file):[^:]+:/, "").trim();
            const words = base.split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w.toLowerCase()));
            const terms = [...new Set([base, base.replace(/\s+/g, "_"), ...words.reverse()])];
            let r = await run(Q.whoKnowsArea, { term: terms[0], repo: repo ?? null, now: ctx.now });
            for (const term of terms.slice(1)) {
              if (r.rows.length) break;
              r = await run(Q.whoKnowsArea, { term, repo: repo ?? null, now: ctx.now });
            }
            runs.push(r);
            for (const x of r.rows) {
              rows.push({ ...x, via: "KNOWS" });
              edges.push([x.key as string, "KNOWS", x.area as string]);
            }
            const areas = [...new Set(r.rows.map((x) => x.area as string))];
            if (areas.length) {
              const o = await run(Q.declaredOwners, { areas });
              runs.push(o);
              for (const x of o.rows) {
                rows.push({ ...x, via: "CODEOWNERS" });
                edges.push([x.key as string, "DECLARED_OWNER", x.area as string]);
              }
            }
          }
          return { runs, rows, edges, note: rows.length ? undefined : "No expertise edges matched. Try a shorter path fragment or a concept key." };
        }),
    }),

    trace: tool({
      description:
        "Decision trace for an issue or PR key: which PRs closed the issue, who wrote and reviewed them, which release shipped them, and which other threads (including other repos) reference it.",
      inputSchema: z.object({ key: z.string().describe("issue:... or pr:... key") }),
      execute: async ({ key }) =>
        step(ctx, "trace", { key }, async () => {
          const runs: Run[] = [];
          const edges: TraceEdge[] = [];
          const rows: Row[] = [];
          if (key.startsWith("issue:")) {
            const r = await run(Q.traceIssue, { key });
            runs.push(r);
            for (const x of r.rows) {
              rows.push(x);
              if (x.fix) edges.push([x.fix as string, "CLOSES", key]);
              if (x.fix && x.release) edges.push([x.fix as string, "SHIPPED_IN", x.release as string]);
              if (x.fix && x.fixAuthor) edges.push([`person:${x.fixAuthor}`, "AUTHORED", x.fix as string]);
            }
          } else {
            const r = await run(Q.tracePr, { key });
            runs.push(r);
            for (const x of r.rows) {
              rows.push(x);
              for (const i of (x.closes as string[]) ?? []) edges.push([key, "CLOSES", i]);
              for (const rel of (x.releases as string[]) ?? []) edges.push([key, "SHIPPED_IN", rel]);
              if (x.author) edges.push([`person:${x.author}`, "AUTHORED", key]);
              for (const rv of (x.reviewers as { login: string | null }[]) ?? []) if (rv.login) edges.push([`person:${rv.login}`, "REVIEWED", key]);
            }
          }
          const refs = await run(Q.references, { key });
          runs.push(refs);
          for (const x of refs.rows) {
            rows.push({ ...x, via: "reference" });
            edges.push(x.outgoing ? [key, x.rel as string, x.key as string] : [x.key as string, x.rel as string, key]);
          }
          return { runs, rows, edges };
        }),
    }),

    connect: tool({
      description: "How two nodes are connected: shortest paths over work relationships (references, closes, authored, reviewed, touched, shipped in, commented on, mentions).",
      inputSchema: z.object({ a: z.string(), b: z.string() }),
      execute: async ({ a, b }) =>
        step(ctx, "connect", { a, b }, async () => {
          const r = await run(Q.connect, { a, b });
          const edges: TraceEdge[] = [];
          for (const x of r.rows) {
            const keys = x.keys as string[];
            const rels = x.rels as string[];
            rels.forEach((rel, i) => edges.push([keys[i], rel, keys[i + 1]]));
          }
          return { runs: [r], rows: r.rows, edges, note: r.rows.length ? undefined : "No path within 6 hops." };
        }),
    }),

    impact: tool({
      description: "What is affected if an area changes: open PRs touching files under it, open issues linked to past fixes there, and directories that usually change together with it.",
      inputSchema: z.object({ area: z.string().describe("Directory or file path fragment"), repo: repoArg }),
      execute: async ({ area, repo }) =>
        step(ctx, "impact", { area, repo }, async () => {
          const term = area.replace(/^(dir|file):[^:]+:/, "");
          const p = { term, repo: repo ?? null };
          const [a, b, c] = [await run(Q.impactOpenPrs, p), await run(Q.impactOpenIssues, p), await run(Q.coChanges, p)];
          const rows = [...a.rows.map((x) => ({ ...x, kind: "open_pr" })), ...b.rows.map((x) => ({ ...x, kind: "open_issue" })), ...c.rows.map((x) => ({ ...x, kind: "co_changes" }))];
          const edges: TraceEdge[] = [
            ...a.rows.map((x) => [x.key as string, "TOUCHED", x.areaKey as string] as TraceEdge),
            ...b.rows.map((x) => [x.key as string, "LINKED_TO_FIX_IN", x.areaKey as string] as TraceEdge),
            ...c.rows.map((x) => [x.areaKey as string, "CO_CHANGES", x.key as string] as TraceEdge),
          ];
          return { runs: [a, b, c], rows, edges };
        }),
    }),

    activity: tool({
      description:
        "Rank people by activity: who authored, reviewed, merged or commented on the most threads, optionally in one repo, one kind (pr or issue), a date window (YYYY-MM-DD), or one directory (area, for example src/index: counts merged PRs touching files under it).",
      inputSchema: z.object({
        metric: z.enum(["AUTHORED", "REVIEWED", "MERGED", "COMMENTED_ON"]),
        repo: repoArg,
        kind: z.enum(["pr", "issue"]).optional(),
        since: z.string().optional(),
        until: z.string().optional(),
        area: z.string().optional().describe("Directory path, for example src/index"),
      }),
      execute: async ({ metric, repo, kind, since, until, area }) =>
        step(ctx, "activity", { metric, repo, kind, since, until, area }, async () => {
          const toTs = (s: string | undefined, d: number) => (s && !Number.isNaN(Date.parse(s)) ? Math.floor(Date.parse(s) / 1000) : d);
          const params: Record<string, unknown> = { repo: repo ?? null, since: toTs(since, 0), until: toTs(until, 4102444800), limit: 10 };
          if (area && (metric === "AUTHORED" || metric === "REVIEWED")) {
            const path = area.replace(/^dir:[^:]+:/, "").replace(/^\/+|\/+$/g, "");
            const r = await run(Q.activityInArea, { ...params, area: path, rel: metric });
            const edges: TraceEdge[] = r.rows.flatMap((x) => [[x.key as string, "KNOWS", x.area as string] as TraceEdge, ...((x.sample as string[]) ?? []).map((s) => [x.key as string, metric, s] as TraceEdge)]);
            return { runs: [r], rows: r.rows, edges, note: r.rows.length ? undefined : `No directory with path exactly '${path}'. Try who_knows for fuzzy matching.` };
          }
          if (metric === "AUTHORED") params.kind = kind ?? null;
          const r = await run(Q.activity[metric], params);
          const edges: TraceEdge[] = r.rows.flatMap((x) => ((x.sample as string[]) ?? []).map((s) => [x.key as string, metric, s] as TraceEdge));
          return { runs: [r], rows: r.rows, edges };
        }),
    }),

    rank: tool({
      description: "Graph algorithms over the whole org: 'reviewers' = PageRank on who reviews whom; 'bridges' = betweenness centrality of people across repos; 'subsystems' = label propagation communities of directories that change together.",
      inputSchema: z.object({ kind: z.enum(["reviewers", "bridges", "subsystems"]) }),
      execute: async ({ kind }) =>
        step(ctx, "rank", { kind }, async () => {
          const cy = kind === "reviewers" ? Q.pageRankReviewers : kind === "bridges" ? Q.betweennessBridges : Q.subsystems;
          const r = await run(cy, {});
          return { runs: [r], rows: r.rows };
        }),
    }),

    draft_triage: tool({
      description:
        "Action: draft a triage comment for an issue key: likely duplicates (vector similarity), probable owners (similar threads -> their fixing PRs -> touched directories -> KNOWS), and suggested labels. Returns ready-to-paste markdown. Nothing is posted anywhere.",
      inputSchema: z.object({ key: z.string().describe("issue:... key") }),
      execute: async ({ key }) =>
        step(ctx, "draft_triage", { key }, async () => {
          const runs: Run[] = [];
          const i = await run(Q.triageIssue, { key });
          runs.push({ ...i, rows: i.rows.map(({ e: _e, ...r }) => r) }); // eslint-disable-line @typescript-eslint/no-unused-vars
          const issue = i.rows[0];
          if (!issue) return { runs, rows: [], note: "Issue not found." };
          const vec = (issue.e as number[] | null) ?? (await embedQuestion(`${issue.title} ${issue.summary ?? ""}`));
          const sim = await run(Q.triageSimilar, { vec, key });
          runs.push(sim);
          const similar = sim.rows.map((r) => r.key as string);
          const own = await run(Q.triageOwners, { similar });
          runs.push(own);
          const lab = await run(Q.triageLabels, { similar });
          runs.push(lab);
          const owners = [...new Map(own.rows.map((r) => [r.person, r])).values()].slice(0, 3);
          const md = [
            `**Triage draft for ${shortRef(key)}: ${issue.title}**`,
            "",
            similar.length ? "Possibly related or duplicate:" : "No similar threads found.",
            ...sim.rows.slice(0, 4).map((r) => `- ${shortRef(r.key as string)} ${r.name} (${String(r.state).toLowerCase()}, similarity ${(r.similarity as number).toFixed(2)})`),
            "",
            owners.length ? `Suggested reviewers, from who changed the same code when similar issues were fixed: ${owners.map((o) => `@${o.person} (${o.path})`).join(", ")}` : "No owner signal in the graph.",
            lab.rows.length ? `Suggested labels: ${lab.rows.map((l) => `\`${l.label}\``).join(", ")}` : "",
            "",
            "_Drafted by Threadline from the FalkorDB graph; every line links back to a graph node._",
          ].filter((l, idx, a) => !(l === "" && a[idx - 1] === ""));
          const edges: TraceEdge[] = [...similar.slice(0, 4).map((s) => [key, "SIMILAR_TO", s] as TraceEdge), ...owners.map((o) => [o.key as string, "KNOWS", o.area as string] as TraceEdge)];
          return { runs, rows: [{ key, title: issue.title, draft: md.join("\n") }, ...sim.rows, ...owners, ...lab.rows], edges };
        }),
    }),

    cypher_readonly: tool({
      description:
        "Last resort for questions the typed tools cannot answer: run one read-only Cypher query (GRAPH.RO_QUERY, read-only user, LIMIT enforced, 5 s timeout). Labels: Entity, Person, Thread, Issue, PullRequest, Repo, File, Directory, Release, Label, Doc, Concept, Chunk. Node keys are in the 'key' property. Timestamps are epoch seconds.",
      inputSchema: z.object({ cypher: z.string() }),
      execute: async ({ cypher }) =>
        step(ctx, "cypher_readonly", { cypher }, async () => {
          const safe = guardCypher(cypher);
          const t = Date.now();
          const { rows } = await query(BRAIN, safe, {}, { ro: true, timeout: 5000 });
          return { runs: [{ cypher: safe, params: {}, rows, ms: Date.now() - t }], rows, note: "free-form query" };
        }),
    }),
  };
}

const WRITE = /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|FOREACH|LOAD\s+CSV)\b|db\.idx\.\w+\.(create|drop)|algo\.\w+\s*\(.*write/i;
export function guardCypher(cypher: string): string {
  const q = cypher.trim().replace(/;+\s*$/, "");
  if (q.includes(";")) throw new Error("one statement only");
  if (!/^(MATCH|OPTIONAL\s+MATCH|WITH|UNWIND|CALL|RETURN)\b/i.test(q)) throw new Error("query must start with MATCH, OPTIONAL MATCH, WITH, UNWIND, CALL or RETURN");
  if (WRITE.test(q)) throw new Error("write clauses are not allowed");
  const m = /\bLIMIT\s+(\d+)\s*$/i.exec(q);
  if (m) return Number(m[1]) > 200 ? q.replace(/\bLIMIT\s+\d+\s*$/i, "LIMIT 200") : q;
  return `${q} LIMIT 200`;
}
