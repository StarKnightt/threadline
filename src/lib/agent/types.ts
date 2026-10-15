export type TraceEdge = [from: string, rel: string, to: string];

export type TraceStep = {
  step: number;
  tool: string;
  args: Record<string, unknown>;
  queries: { cypher: string; params: Record<string, unknown>; rows: number; ms: number }[];
  ms: number;
  refs: string[];
  edges: TraceEdge[];
  rows: Record<string, unknown>[];
  note?: string;
  error?: string;
  agent?: "investigator" | "verifier";
};

export type Citation = { key: string; observed: boolean; hops: number | null; path: TraceEdge[]; ok: boolean };

export type Verification = {
  entry: string[];
  citations: Citation[];
  verified: number;
  total: number;
  handoff?: { reason: string; rejected: string[] };
};

export type Trace = {
  id: string;
  question: string;
  mode: "graph" | "vector";
  answer: string;
  steps: TraceStep[];
  verification?: Verification;
  model: string;
  tokens: number;
  ms: number;
  at: number;
  showcase?: boolean;
  /** Showcase pairs: the vector-baseline trace for the same question. */
  pairId?: string;
  /** Vector baseline only: retrieved chunks with similarity scores. */
  chunks?: { chunk: string; key: string; name: string; score: number; text: string }[];
};

export type NodeInfo = { key: string; label: string; name: string };

export function labelOf(key: string): string {
  const p = key.split(":")[0];
  return (
    { pr: "PullRequest", issue: "Issue", person: "Person", file: "File", dir: "Directory", release: "Release", doc: "Doc", concept: "Concept", repo: "Repo", label: "Label", org: "Org", chunk: "Chunk" } as Record<string, string>
  )[p] ?? "Entity";
}

export function shortName(key: string): string {
  const [p, ...rest] = key.split(":");
  const r = rest.join(":");
  if (p === "pr" || p === "issue") return r.replace(/^FalkorDB\//, "");
  if (p === "file" || p === "dir") return r.replace(/^FalkorDB\/[^:]+:/, "") || "/";
  if (p === "release") return r.replace(/^FalkorDB\//, "");
  if (p === "repo") return r.replace(/^FalkorDB\//, "");
  return r;
}
