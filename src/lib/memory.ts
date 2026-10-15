import "server-only";
import { randomUUID } from "node:crypto";
import { SHARED, memGraphName, query } from "./falkor";
import type { Trace } from "./agent/types";
import type { MemoryContext } from "./agent/run";

/** Cypher used by the memory layer. Documented in docs/CYPHER.md (Q13 to Q16). */
export const MEM_Q = {
  /** Q13: episodic memory. One Turn per question, chained with NEXT, with its tool calls and the brain nodes they touched. */
  writeTurn: `MERGE (s:Session {id: $sid})
ON CREATE SET s.startedAt = $now
CREATE (t:Turn {id: $tid, question: $q, answer: $a, at: $now, verified: $verified, total: $total, mode: $mode, traceId: $traceId})
MERGE (s)-[:HAS_TURN]->(t)
WITH s, t
OPTIONAL MATCH (s)-[:HAS_TURN]->(prev:Turn) WHERE prev.id <> t.id
WITH t, prev ORDER BY prev.at DESC LIMIT 1
FOREACH (_ IN CASE WHEN prev IS NULL THEN [] ELSE [1] END | MERGE (prev)-[:NEXT]->(t))
WITH t
UNWIND $calls AS c
CREATE (tc:ToolCall {tool: c.tool, step: c.step, ms: c.ms, rows: c.rows, cypher: c.cypher})
MERGE (t)-[:RAN]->(tc)
FOREACH (k IN c.refs | MERGE (r:Ref {key: k}) MERGE (tc)-[:TOUCHED_REF]->(r))`,

  /** Q15: semantic memory. A fact learned from a turn, optionally about brain nodes. */
  writeFact: `MATCH (t:Turn {id: $tid})
MERGE (f:Fact {text: $text})
ON CREATE SET f.kind = $kind, f.at = $now, f.confidence = 1.0
MERGE (f)-[:LEARNED_FROM]->(t)
WITH f
UNWIND $refs AS k
MERGE (r:Ref {key: k})
MERGE (f)-[:ABOUT]->(r)`,

  readFacts: `MATCH (f:Fact) RETURN f.text AS text, f.kind AS kind, f.at AS at ORDER BY f.at DESC LIMIT 12`,

  previousTurn: `MATCH (:Session {id: $sid})-[:HAS_TURN]->(t:Turn)
OPTIONAL MATCH (t)-[:RAN]->(:ToolCall)-[:TOUCHED_REF]->(r:Ref)
WITH t, collect(DISTINCT r.key)[0..10] AS refs
RETURN t.question AS question, t.at AS at, refs ORDER BY at DESC LIMIT 1`,

  history: `MATCH (s:Session)-[:HAS_TURN]->(t:Turn)
OPTIONAL MATCH (t)-[:RAN]->(tc:ToolCall)
WITH s, t, count(tc) AS calls
RETURN s.id AS session, t.id AS id, t.question AS question, t.at AS at, t.verified AS verified, t.total AS total, t.traceId AS traceId, calls
ORDER BY at DESC LIMIT 20`,

  /** Q14: procedural memory. Closest verified playbook for a new question (shared across users). */
  recallPlaybook: `CALL db.idx.vector.queryNodes('Playbook', 'embedding', 3, vecf32($vec)) YIELD node, score
WITH node, 1 - score AS similarity WHERE similarity > 0.86 AND node.successes >= 1
RETURN node.questionType AS questionType, node.toolSequence AS toolSequence, node.successes AS successes, similarity
ORDER BY similarity DESC LIMIT 1`,

  /** Q16: promote a verified tool sequence to a shared playbook. */
  writePlaybook: `MERGE (p:Playbook {questionType: $qt, toolSequence: $seq})
ON CREATE SET p.uses = 0, p.successes = 0, p.embedding = vecf32($vec), p.example = $q, p.createdAt = $now
SET p.uses = p.uses + 1, p.successes = p.successes + $ok, p.lastAt = $now`,

  /** Coordination: the Investigator's claims, the Verifier's verdicts and any handoff, on a shared blackboard. */
  writeCoordination: `MERGE (inv:Agent {name: 'investigator'})
MERGE (ver:Agent {name: 'verifier'})
CREATE (task:Task {id: $traceId, question: $q, status: $status, at: $now})
CREATE (inv)-[:WORKED_ON]->(task)
WITH inv, ver, task
UNWIND $claims AS c
CREATE (cl:Claim {key: c.key, ok: c.ok, hops: c.hops, observed: c.observed})
CREATE (inv)-[:POSTED]->(cl)-[:FOR]->(task)
CREATE (cl)-[:CHECKED_BY {verdict: CASE WHEN c.ok THEN 'verified' ELSE 'rejected' END, pathLength: c.hops}]->(ver)`,

  writeHandoff: `MATCH (task:Task {id: $traceId})
CREATE (task)-[:HANDED_OFF {from: 'verifier', to: 'investigator', reason: $reason, at: $now}]->(task)`,

  saveTrace: `CREATE (t:Trace {id: $id, question: $q, mode: $mode, at: $now, showcase: $showcase, verified: $verified, total: $total, json: $json})`,
  getTrace: `MATCH (t:Trace {id: $id}) RETURN t.json AS json`,
  listShowcase: `MATCH (t:Trace) WHERE t.showcase = true RETURN t.id AS id, t.question AS question, t.mode AS mode, t.verified AS verified, t.total AS total, t.at AS at ORDER BY t.id ASC`,
};

let sharedReady: Promise<void> | null = null;
export function ensureShared() {
  sharedReady ??= (async () => {
    for (const q of [
      "CREATE INDEX FOR (t:Trace) ON (t.id)",
      "CREATE INDEX FOR (q:QueryEmbedding) ON (q.h)",
      "CREATE INDEX FOR (r:Rate) ON (r.key)",
      "CREATE INDEX FOR (t:Task) ON (t.id)",
      "CREATE VECTOR INDEX FOR (p:Playbook) ON (p.embedding) OPTIONS {dimension:256, similarityFunction:'cosine'}",
    ]) {
      await query(SHARED, q).catch(() => {});
    }
  })();
  return sharedReady;
}

export function questionType(q: string): string {
  const s = q.toLowerCase();
  if (/\b(who|whom)\b.*\b(know|knows|expert|review|own|owns|worked|work on|maintain)/.test(s)) return "expertise";
  if (/\b(fix|fixed|closed|release|shipped|ship)\b/.test(s)) return "trace";
  if (/\b(affect|affected|impact|break|breaks|open pull|depends)\b/.test(s)) return "impact";
  if (/\b(connect|connected|relate|related|reference|link)\b/.test(s)) return "connection";
  if (/\b(most|top|how many|count|busiest)\b/.test(s)) return "aggregation";
  return "lookup";
}

/** Facts come only from explicit statements by the user; no LLM guesses. */
export function extractFacts(q: string): { text: string; kind: string }[] {
  const out: { text: string; kind: string }[] = [];
  const work = /\bi(?:'m| am)? (?:work(?:ing)? on|maintain|contribute to|use)\s+(?:the\s+)?([\w@./ -]{2,60}?)(?:[.,!?;]|\s+(?:and|so|but)\b|$)/i.exec(q);
  if (work) out.push({ text: `User works on ${work[1].trim()}`, kind: "preference" });
  const alias = /\bby\s+["']?([\w@./ -]{2,40}?)["']?\s+i mean\s+["']?([\w@./ -]{2,60}?)["']?(?:[.,!?;]|$)/i.exec(q);
  if (alias) out.push({ text: `"${alias[1].trim()}" means ${alias[2].trim()}`, kind: "alias" });
  const remember = /\bremember (?:that )?(.{4,120}?)(?:[.!?]|$)/i.exec(q);
  if (remember) out.push({ text: remember[1].trim(), kind: "note" });
  if (/\b(that|the last) (?:answer )?(?:was|is) (?:wrong|incorrect)\b/i.test(q)) out.push({ text: "User flagged the previous answer as wrong", kind: "correction" });
  return out;
}

export async function loadMemory(userId: string, sessionId: string, vec: number[] | null): Promise<MemoryContext> {
  const g = memGraphName(userId);
  const [facts, prev, pb] = await Promise.all([
    query<{ text: string }>(g, MEM_Q.readFacts).then((r) => r.rows.map((x) => x.text)).catch(() => []),
    query<{ question: string; refs: string[] }>(g, MEM_Q.previousTurn, { sid: sessionId }).then((r) => r.rows[0]).catch(() => undefined),
    vec ? query<{ questionType: string; toolSequence: string }>(SHARED, MEM_Q.recallPlaybook, { vec }).then((r) => r.rows[0]).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  return { facts, previous: prev ? { question: prev.question, refs: prev.refs ?? [] } : undefined, playbook: pb };
}

export async function persist(trace: Trace, opts: { userId?: string; sessionId?: string; vec?: number[] | null }) {
  await ensureShared();
  const now = Math.floor(Date.now() / 1000);
  const v = trace.verification;
  await query(SHARED, MEM_Q.saveTrace, { id: trace.id, q: trace.question, mode: trace.mode, now, showcase: !!trace.showcase, verified: v?.verified ?? 0, total: v?.total ?? 0, json: JSON.stringify(trace) });
  if (trace.mode === "graph" && v) {
    await query(SHARED, MEM_Q.writeCoordination, {
      traceId: trace.id,
      q: trace.question,
      status: v.total && v.verified === v.total ? "verified" : "partially_verified",
      now,
      claims: v.citations.map((c) => ({ key: c.key, ok: c.ok, hops: c.hops ?? -1, observed: c.observed })),
    });
    if (v.handoff) await query(SHARED, MEM_Q.writeHandoff, { traceId: trace.id, reason: v.handoff.reason, now });
    const tools = trace.steps.filter((s) => s.agent !== "verifier" && !s.error).map((s) => s.tool);
    if (opts.vec && tools.length && v.total > 0 && v.verified === v.total) {
      await query(SHARED, MEM_Q.writePlaybook, { qt: questionType(trace.question), seq: tools.join(" -> "), vec: opts.vec, q: trace.question, now, ok: 1 });
    }
  }
  if (opts.userId && opts.sessionId) {
    const g = memGraphName(opts.userId);
    const tid = randomUUID();
    await query(g, MEM_Q.writeTurn, {
      sid: opts.sessionId,
      tid,
      q: trace.question,
      a: trace.answer.slice(0, 2000),
      now,
      verified: v?.verified ?? 0,
      total: v?.total ?? 0,
      mode: trace.mode,
      traceId: trace.id,
      calls: trace.steps.map((s) => ({ tool: s.tool, step: s.step, ms: s.ms, rows: s.rows.length, cypher: s.queries[0]?.cypher ?? "", refs: s.refs.slice(0, 25) })),
    });
    for (const f of extractFacts(trace.question)) {
      await query(g, MEM_Q.writeFact, { tid, text: f.text, kind: f.kind, now, refs: f.kind === "correction" ? (v?.citations ?? []).map((c) => c.key).slice(0, 8) : [] });
    }
  }
}

export async function getTrace(id: string): Promise<Trace | null> {
  const { rows } = await query<{ json: string }>(SHARED, MEM_Q.getTrace, { id }, { ro: true });
  return rows[0] ? (JSON.parse(rows[0].json) as Trace) : null;
}

export async function listShowcase() {
  const { rows } = await query(SHARED, MEM_Q.listShowcase, {}, { ro: true }).catch(() => ({ rows: [] }));
  return rows;
}

export async function memorySnapshot(userId: string) {
  const g = memGraphName(userId);
  const [facts, history] = await Promise.all([
    query(g, MEM_Q.readFacts).then((r) => r.rows).catch(() => []),
    query(g, MEM_Q.history).then((r) => r.rows).catch(() => []),
  ]);
  return { graph: g, facts, history };
}

export async function forget(userId: string) {
  await query(memGraphName(userId), "MATCH (n) DETACH DELETE n").catch(() => {});
}

/** Fixed-window counter in FalkorDB; returns the count after incrementing. */
export async function bump(key: string, windowSecs: number) {
  await ensureShared();
  const now = Math.floor(Date.now() / 1000);
  const { rows } = await query<{ n: number }>(
    SHARED,
    `MERGE (r:Rate {key: $key})
ON CREATE SET r.n = 0, r.exp = $exp
SET r.n = CASE WHEN r.exp < $now THEN 1 ELSE r.n + 1 END,
    r.exp = CASE WHEN r.exp < $now THEN $exp ELSE r.exp END
RETURN r.n AS n`,
    { key, now, exp: now + windowSecs },
  );
  return rows[0]?.n ?? 0;
}
