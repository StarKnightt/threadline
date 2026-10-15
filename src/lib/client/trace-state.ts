import type { Citation, Trace, TraceEdge, TraceStep } from "../agent/types";

export type Lane = {
  mode: "graph" | "vector";
  steps: TraceStep[];
  running: { step: number; tool: string; args: Record<string, unknown> } | null;
  answer: string;
  revised: boolean;
  citations: Citation[];
  handoff?: { reason: string; rejected: string[] };
  memory?: { facts: string[]; previous?: string; playbook?: { questionType: string; toolSequence: string } };
  chunks?: Trace["chunks"];
  traceId?: string;
  tokens?: number;
  ms?: number;
  model?: string;
  error?: string;
  done: boolean;
};

export const emptyLane = (mode: "graph" | "vector"): Lane => ({ mode, steps: [], running: null, answer: "", revised: false, citations: [], done: false });

/** Fold one server-sent event into a lane. */
export function reduce(lane: Lane, e: Record<string, unknown>): Lane {
  switch (e.type) {
    case "memory":
      return { ...lane, memory: { facts: (e.facts as string[]) ?? [], previous: e.previous as string | undefined, playbook: e.playbook as { questionType: string; toolSequence: string } | undefined } };
    case "step_start":
      return { ...lane, running: { step: e.step as number, tool: e.tool as string, args: e.args as Record<string, unknown> } };
    case "step_result": {
      const s = e as unknown as TraceStep;
      if (s.agent === "verifier") return { ...lane, steps: [...lane.steps.filter((x) => x.agent !== "verifier"), s], running: null };
      const chunks = s.tool === "vector_search" ? (s.rows as unknown as Trace["chunks"]) : lane.chunks;
      return { ...lane, steps: [...lane.steps, s], running: null, chunks };
    }
    case "answer":
      return { ...lane, answer: e.text as string, revised: !!e.revised, model: e.model as string, citations: e.revised ? [] : lane.citations };
    case "verify":
      return { ...lane, citations: [...lane.citations.filter((c) => c.key !== e.key), e as unknown as Citation] };
    case "handoff":
      return { ...lane, handoff: { reason: e.reason as string, rejected: e.rejected as string[] } };
    case "done":
      return { ...lane, done: true, running: null, traceId: e.traceId as string, tokens: e.tokens as number, ms: e.ms as number, model: (e.model as string) ?? lane.model };
    case "error":
      return { ...lane, done: true, running: null, error: e.message as string };
    default:
      return lane;
  }
}

export function laneFromTrace(t: Trace): Lane {
  return {
    mode: t.mode,
    steps: t.steps,
    running: null,
    answer: t.answer,
    revised: !!t.verification?.handoff,
    citations: t.verification?.citations ?? [],
    handoff: t.verification?.handoff,
    chunks: t.chunks,
    traceId: t.id,
    tokens: t.tokens,
    ms: t.ms,
    model: t.model,
    done: true,
  };
}

/** Everything the 3D scene needs for the first `upTo` steps. */
export function sceneData(lane: Lane, upTo: number) {
  const steps = lane.steps.slice(0, upTo);
  const nodes = new Map<string, number>(); // key -> step it first appeared in
  const edges: { e: TraceEdge; step: number; gold: boolean }[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    const gold = s.agent === "verifier";
    for (const r of s.refs) if (!nodes.has(r)) nodes.set(r, s.step);
    for (const e of s.edges) {
      for (const k of [e[0], e[2]]) if (!nodes.has(k)) nodes.set(k, s.step);
      const id = `${e[0]}|${e[2]}|${gold}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ e, step: s.step, gold });
    }
  }
  const last = steps[steps.length - 1];
  return { nodes, edges, activeStep: last?.step ?? 0, active: new Set([...(last?.refs ?? []), ...(last?.edges ?? []).flatMap((e) => [e[0], e[2]])]) };
}

export function githubUrl(key: string): string | null {
  const m = /^(pr|issue):([^#]+)#(\d+)$/.exec(key);
  if (m) return `https://github.com/${m[2]}/${m[1] === "pr" ? "pull" : "issues"}/${m[3]}`;
  const p = /^person:(.+)$/.exec(key);
  if (p && !p[1].endsWith("[bot]")) return `https://github.com/${p[1]}`;
  const r = /^release:([^@]+)@(.+)$/.exec(key);
  if (r) return `https://github.com/${r[1]}/releases/tag/${r[2]}`;
  const repo = /^repo:(.+)$/.exec(key);
  if (repo) return `https://github.com/${repo[1]}`;
  const f = /^(file|dir):([^:]+):(.*)$/.exec(key);
  if (f) return `https://github.com/${f[2]}/tree/HEAD/${f[3] === "/" ? "" : f[3]}`;
  const d = /^doc:docs:(.+)$/.exec(key);
  if (d) return `https://docs.falkordb.com/${d[1]}.html`;
  return null;
}
