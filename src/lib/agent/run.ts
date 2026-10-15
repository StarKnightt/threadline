import "server-only";
import { isStepCount, type ModelMessage } from "ai";
import { Q } from "../cypher/catalogue";
import { BRAIN, query } from "../falkor";
import { embedQuestion } from "../embed";
import { generateWithFallback, type PaidRun } from "./llm";
import { KEY_RE, makeTools, type ToolCtx } from "./tools";
import type { Citation, Trace, TraceEdge, TraceStep, Verification } from "./types";

export { MODELS } from "./llm";

export type MemoryContext = { facts: string[]; previous?: { question: string; refs: string[] }; playbook?: { questionType: string; toolSequence: string } };

const CITE_RE = /\b((?:pr|issue|person|file|dir|release|doc|concept|repo|label):[^\s\]\[;,()【】「」'"*]+)/g;

function systemPrompt(now: number, mem?: MemoryContext) {
  const lines = [
    "You are Threadline, a company brain for the FalkorDB open-source organisation.",
    "The knowledge graph holds public GitHub data: repos, people (GitHub logins), issues, pull requests, reviews, files, directories, releases, docs and concepts.",
    `Today is ${new Date(now * 1000).toISOString().slice(0, 10)}.`,
    "Plans that work (2 to 4 tool calls):",
    "- Who knows / who should review an area: find_entities, then who_knows with the concept key (concept:...) or a path fragment such as src/index.",
    "- What fixed issue #N / which release shipped it / what references it: find_entities with number and repo, then trace on the issue or PR key.",
    "- What is affected by changing an area / open PRs touching a path: impact with the path fragment.",
    "- Who did the most X in a repo, year or directory: activity (metric AUTHORED with kind pr or issue, REVIEWED, MERGED, COMMENTED_ON; since/until as YYYY-MM-DD; area for a directory path).",
    "- Cross-repo references: trace gives each referencing thread with a crossRepo flag; only list rows where crossRepo is true when asked about other repositories.",
    "- How two things relate: find_entities for each, then connect. Org-wide influence: rank.",
    "- Triage an issue or draft a comment for it: find_entities with number and repo, then draft_triage; include the draft in the answer.",
    "Rules:",
    "- Prefer the typed tools. Use cypher_readonly only when nothing else fits.",
    "- Use at most 5 tool calls, then answer.",
    "- Cite the node key behind every factual claim in square brackets, for example [pr:FalkorDB/FalkorDB#1234] or [person:swilly22]. Only cite full node keys that appeared in tool results, never tool names.",
    "- If the graph has no evidence, say so plainly. Do not guess.",
    "- Answer in under 150 words of plain prose or a short list. End with one line: ANSWER: item; item; item (the key entities as logins, issue or PR numbers like #123, or release tags).",
  ];
  if (mem?.facts.length) lines.push(`Known about this user (from earlier sessions): ${mem.facts.join("; ")}.`);
  if (mem?.previous) lines.push(`Previous question in this session: "${mem.previous.question}" (it used ${mem.previous.refs.slice(0, 6).join(", ")}). Resolve follow-ups like "same for ..." against it.`);
  if (mem?.playbook) lines.push(`A similar ${mem.playbook.questionType} question was answered and verified before with this tool sequence: ${mem.playbook.toolSequence}. Start from that plan.`);
  return lines.join("\n");
}

export function citedKeys(answer: string) {
  return [...new Set([...answer.matchAll(CITE_RE)].map((m) => m[1].replace(/[.:]+$/, "")))];
}

/** Deterministic verifier: each citation must have been observed in a tool result and be reachable from an entry node. */
export async function verify(steps: TraceStep[], answer: string, emit: (e: Record<string, unknown>) => void): Promise<Verification> {
  const observed = new Set<string>();
  for (const s of steps) {
    s.refs.forEach((r) => observed.add(r));
    s.edges.forEach(([a, , b]) => (observed.add(a), observed.add(b)));
  }
  // Entry nodes: what the investigation started from (resolved entities, keys the agent passed in, and the anchor areas it resolved).
  const first = steps.find((s) => s.tool === "find_entities" && !s.error);
  const fromFind = (first?.rows ?? []).map((r) => r.key as string).filter((k) => k && KEY_RE.test(k)).slice(0, 4);
  const fromArgs = steps.flatMap((s) => Object.values(s.args).flat().filter((v): v is string => typeof v === "string" && KEY_RE.test(v)));
  const early = steps.filter((s) => s.agent !== "verifier" && !s.error).slice(0, 2).flatMap((s) => s.refs);
  const areaAnchors = early.filter((r) => /^(concept|dir|file|repo):/.test(r)).slice(0, 3);
  const anchors = areaAnchors.length ? areaAnchors : early.filter((r) => /^(issue|pr):/.test(r)).slice(0, 2);
  const entry = [...new Set([...fromFind, ...fromArgs, ...anchors])].slice(0, 6);
  // Resolve abbreviated citations (pr:#2527, person:aviavni) to the observed key they clearly refer to.
  const canonical = (k: string) => {
    if (observed.has(k)) return k;
    const [prefix, rest] = [k.split(":")[0], k.slice(k.indexOf(":") + 1).toLowerCase()];
    const num = /#(\d+)$/.exec(rest)?.[1];
    const match = [...observed].filter((o) => o.startsWith(prefix + ":") && (num ? o.endsWith(`#${num}`) : o.slice(prefix.length + 1).toLowerCase() === rest));
    return match.length === 1 ? match[0] : k;
  };
  const cited = [...new Set(citedKeys(answer).map(canonical))].slice(0, 12);
  const citations: Citation[] = [];
  const t0 = Date.now();
  const queries: TraceStep["queries"] = [];
  for (const key of cited) {
    let hops: number | null = null;
    let path: TraceEdge[] = [];
    if (entry.includes(key)) hops = 0;
    for (const e of entry) {
      if (hops !== null) break;
      const t = Date.now();
      try {
        const { rows } = await query<{ hops: number; keys: string[]; rels: string[] }>(BRAIN, Q.verifyPath, { entry: e, cited: key }, { ro: true, timeout: 4000 });
        queries.push({ cypher: Q.verifyPath, params: { entry: e, cited: key }, rows: rows.length, ms: Date.now() - t });
        if (rows[0]) {
          hops = rows[0].hops;
          path = rows[0].rels.map((rel, i) => [rows[0].keys[i], rel, rows[0].keys[i + 1]] as TraceEdge);
        }
      } catch {
        queries.push({ cypher: Q.verifyPath, params: { entry: e, cited: key }, rows: 0, ms: Date.now() - t });
      }
    }
    // Org-wide algorithm questions have no entry node; then a citation must at least come from tool output.
    const ok = observed.has(key) && (hops !== null || entry.length === 0);
    const c: Citation = { key, observed: observed.has(key), hops, path, ok, basis: hops !== null ? "path" : ok ? "observed" : undefined };
    citations.push(c);
    emit({ type: "verify", ...c });
  }
  const v: Verification = { entry, citations, verified: citations.filter((c) => c.ok).length, total: citations.length };
  const verifierStep: TraceStep = {
    step: steps.length + 1,
    tool: "verify_citations",
    agent: "verifier",
    args: { entry, cited },
    queries: queries.slice(0, 6),
    ms: Date.now() - t0,
    refs: citations.filter((c) => c.ok).map((c) => c.key),
    edges: citations.flatMap((c) => c.path),
    rows: citations.map((c) => ({ key: c.key, observed: c.observed, hops: c.hops, ok: c.ok })),
    note: `${v.verified} of ${v.total} citations verified`,
  };
  steps.push(verifierStep);
  emit({ type: "step_result", ...verifierStep });
  return v;
}

export async function runGraphAgent(question: string, emit: (e: Record<string, unknown>) => void, mem?: MemoryContext, opts: { handoff?: boolean; models?: string[]; paid?: PaidRun } = {}): Promise<Omit<Trace, "id" | "at">> {
  const t0 = Date.now();
  const now = Math.floor(Date.now() / 1000);
  const ctx: ToolCtx = { now, steps: [], emit };
  const tools = makeTools(ctx);
  const messages: ModelMessage[] = [{ role: "user", content: question }];
  const { res, model } = await generateWithFallback({ system: systemPrompt(now, mem), messages, tools, stopWhen: isStepCount(6), maxOutputTokens: 1400, temperature: 0 }, opts.models, opts.paid);
  let answer = res.text.trim();
  let tokens = res.usage?.totalTokens ?? 0;
  if (!answer) answer = "I could not finish an answer within the step budget. The trace above shows what the graph returned.";
  emit({ type: "answer", text: answer, model });

  let verification = await verify(ctx.steps, answer, emit);

  // Coordination: one handoff back to the Investigator when the Verifier rejects claims.
  const rejected = verification.citations.filter((c) => !c.ok).map((c) => c.key);
  if (opts.handoff !== false && rejected.length && rejected.length < verification.total + 1) {
    const reason = `${rejected.length} citation(s) failed verification (not seen in tool results or not connected to the question's entry nodes): ${rejected.join(", ")}`;
    emit({ type: "handoff", from: "verifier", to: "investigator", reason, rejected });
    try {
      const observed = [...new Set(ctx.steps.filter((s) => s.agent !== "verifier").flatMap((s) => s.refs))].slice(0, 60);
      const fix = await generateWithFallback(
        {
          system: "You revise answers from a graph agent so that every citation is a full node key that was observed in the tool results. Keep the same facts, drop claims you cannot cite, keep it under 150 words, and keep the final ANSWER line.",
          prompt: `Question: ${question}\n\nDraft answer:\n${answer}\n\nNode keys observed in tool results:\n${observed.join("\n")}\n\nVerifier: ${reason}.\n\nRewrite the answer, citing only keys from the observed list in square brackets.`,
          maxOutputTokens: 700,
          temperature: 0,
        },
        opts.models,
        opts.paid,
      );
      tokens += fix.res.usage?.totalTokens ?? 0;
      if (fix.res.text.trim()) {
        answer = fix.res.text.trim();
        emit({ type: "answer", text: answer, model: fix.model, revised: true });
        ctx.steps.pop();
        verification = await verify(ctx.steps, answer, emit);
        verification.handoff = { reason, rejected };
      }
    } catch (e) {
      console.warn("handoff revision failed:", (e as Error).message.slice(0, 200));
    }
  }

  return { question, mode: "graph", answer, steps: ctx.steps, verification, model, tokens, ms: Date.now() - t0 };
}

export async function runVectorBaseline(question: string, emit: (e: Record<string, unknown>) => void, opts: { models?: string[]; k?: number; paid?: PaidRun } = {}): Promise<Omit<Trace, "id" | "at">> {
  const t0 = Date.now();
  const vec = await embedQuestion(question);
  const t = Date.now();
  const { rows } = await query<{ chunk: string; text: string; key: string; name: string; author: string | null; state: string | null; createdAt: number | null; score: number }>(BRAIN, Q.vectorRag, { vec, k: opts.k ?? 8 }, { ro: true });
  const step: TraceStep = {
    step: 1,
    tool: "vector_search",
    args: { k: opts.k ?? 8 },
    queries: [{ cypher: Q.vectorRag, params: { vec: "[256-dim vector]", k: opts.k ?? 8 }, rows: rows.length, ms: Date.now() - t }],
    ms: Date.now() - t,
    refs: [...new Set(rows.map((r) => r.key))],
    edges: [],
    rows: rows.map((r) => ({ key: r.key, name: r.name, score: Math.round(r.score * 1000) / 1000 })),
  };
  emit({ type: "step_result", ...step });
  // Each chunk carries its document's metadata (title, author, state, date), as a typical RAG pipeline would.
  const meta = (r: (typeof rows)[number]) =>
    [r.author && `opened by ${r.author}`, r.state && `state ${r.state}`, r.createdAt && `created ${new Date(r.createdAt * 1000).toISOString().slice(0, 10)}`].filter(Boolean).join(", ");
  const context = rows.map((r, i) => `[${i + 1}] source ${r.key} "${r.name}"${meta(r) ? ` (${meta(r)})` : ""}:\n${r.text}`).join("\n\n");
  const { res, model } = await generateWithFallback(
    {
      system: [
        "You answer questions about the FalkorDB open-source organisation using only the retrieved text chunks below.",
        "Cite the source key of each claim in square brackets, for example [pr:FalkorDB/FalkorDB#1234]. If the chunks do not contain the answer, say so.",
        "Answer in under 150 words. End with one line: ANSWER: item; item; item (logins, issue or PR numbers like #123, or release tags).",
      ].join("\n"),
      prompt: `Retrieved chunks:\n\n${context}\n\nQuestion: ${question}`,
      maxOutputTokens: 900,
      temperature: 0,
    },
    opts.models,
    opts.paid,
  );
  const answer = res.text.trim();
  emit({ type: "answer", text: answer, model });
  return {
    question,
    mode: "vector",
    answer,
    steps: [step],
    model,
    tokens: res.usage?.totalTokens ?? 0,
    ms: Date.now() - t0,
    chunks: rows.map((r) => ({ chunk: r.chunk, key: r.key, name: r.name, score: r.score, text: r.text })),
  };
}
