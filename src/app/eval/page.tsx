import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Evaluation: graph agent vs vector RAG | Threadline" };

type Stats = { n: number; f1: number; precision: number; recall: number; exact: number; tokens: number; p50ms: number; p95ms: number; steps: number; citationValidity: number | null; fullyGrounded: number | null };
type Summary = { model: string; generatedAt: string; pairedQuestions: number; overall: { graph: Stats; vector: Stats }; categories: Record<string, { graph: Stats; vector: Stats }> };
type Row = { id: string; category: string; system: string; question: string; gold: string[]; pred: string[]; f1: number; answer: string; tokens: number; ms: number; verified: string | null; tools: string[] };

const LABELS: Record<string, { name: string; about: string }> = {
  lookup: { name: "Single-hop lookup (control)", about: "Who opened a PR, given its title. The answer sits in one document, so vector retrieval should cope." },
  expertise: { name: "Expertise", about: "Top authors of merged PRs touching a directory. Needs PR to file to directory joins." },
  trace: { name: "Decision trace", about: "Which PR fixed an issue and which release shipped it. Issue to PR to release." },
  cross_repo: { name: "Cross-repo connection", about: "Threads in other repositories that reference a given issue or PR." },
  impact: { name: "Impact", about: "Open PRs touching files under a directory." },
  aggregation: { name: "Aggregation", about: "Top reviewers or issue openers in a repo and year. Counting over relationships." },
};

function read<T>(p: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), p), "utf8")) as T;
  } catch {
    return fallback;
  }
}

function Bar({ v, color }: { v: number; color: string }) {
  return (
    <div className="h-2 w-full rounded-full bg-white/5">
      <div className="h-2 rounded-full" style={{ width: `${Math.round(v * 100)}%`, background: color }} />
    </div>
  );
}

export default function EvalPage() {
  const s = read<Summary | null>("eval/summary.json", null);
  let rows: Row[] = [];
  try {
    rows = readFileSync(join(process.cwd(), "eval/results.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {}
  const ids = [...new Set(rows.map((r) => r.id))].filter((id) => rows.some((r) => r.id === id && r.system === "graph") && rows.some((r) => r.id === id && r.system === "vector"));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-300">
      <Link href="/" className="text-[12px] text-slate-500 hover:text-white">← Threadline</Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">Graph agent vs vector RAG</h1>
      <p className="mt-3 max-w-3xl text-[14px] leading-relaxed">
        60 questions in six categories, generated from templates over the raw GitHub JSON. Gold answers are computed by <code className="text-slate-200">eval/gold.ts</code> directly from that JSON, without FalkorDB, so the graph never grades itself. Both systems use the same language model, the same 256-dimension embeddings and the same FalkorDB vector index. The vector baseline embeds the question, takes the 8 nearest chunks (with each chunk&apos;s document title, author, state and date) and answers from them. Scores are set-based F1 over the entities in each answer&apos;s final ANSWER line.
      </p>
      {s ? (
        <>
          <div className="mt-2 font-mono text-[11px] text-slate-500">
            model {s.model} · {s.pairedQuestions} paired questions · generated {s.generatedAt.slice(0, 16).replace("T", " ")} UTC
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {(["graph", "vector"] as const).map((k) => (
              <div key={k} className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-5">
                <div className={`text-[11px] uppercase tracking-wider ${k === "graph" ? "text-violet-300" : "text-pink-300"}`}>{k === "graph" ? "Threadline graph agent" : "Vector RAG baseline"}</div>
                <div className="mt-1 text-4xl font-semibold text-white">{s.overall[k].f1.toFixed(2)}<span className="ml-2 text-sm font-normal text-slate-500">mean F1</span></div>
                <div className="mt-3 grid grid-cols-3 gap-2 font-mono text-[11px] text-slate-400">
                  <div>exact {Math.round(s.overall[k].exact * 100)}%</div>
                  <div>{Math.round(s.overall[k].tokens).toLocaleString()} tok/answer</div>
                  <div>p50 {(s.overall[k].p50ms / 1000).toFixed(1)} s</div>
                  {k === "graph" && s.overall.graph.citationValidity !== null && <div className="col-span-3">citations verified by graph path: {Math.round((s.overall.graph.citationValidity ?? 0) * 100)}%</div>}
                </div>
              </div>
            ))}
          </div>

          <h2 className="mt-10 text-lg font-semibold text-white">By category</h2>
          <div className="mt-4 space-y-4">
            {Object.entries(s.categories).map(([c, v]) => (
              <div key={c} className="rounded-xl border border-white/[0.06] p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium text-white">{LABELS[c]?.name ?? c}</span>
                  <span className="text-[12px] text-slate-500">{LABELS[c]?.about}</span>
                  <span className="ml-auto font-mono text-[11px] text-slate-500">n={v.graph.n}</span>
                </div>
                <div className="mt-3 grid grid-cols-[110px_1fr_48px] items-center gap-x-3 gap-y-2 text-[12px]">
                  <span className="text-violet-300">Graph agent</span>
                  <Bar v={v.graph.f1} color="#a78bfa" />
                  <span className="font-mono text-slate-300">{v.graph.f1.toFixed(2)}</span>
                  <span className="text-pink-300">Vector RAG</span>
                  <Bar v={v.vector.f1} color="#f472b6" />
                  <span className="font-mono text-slate-300">{v.vector.f1.toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-6 text-slate-500">The evaluation has not been summarised yet.</p>
      )}

      <h2 className="mt-10 text-lg font-semibold text-white">Every question</h2>
      <p className="mt-1 text-[12.5px] text-slate-500">Gold answer, each system&apos;s parsed answer, and the full text.</p>
      <div className="mt-4 space-y-2">
        {ids.map((id) => {
          const g = rows.find((r) => r.id === id && r.system === "graph")!;
          const v = rows.find((r) => r.id === id && r.system === "vector")!;
          return (
            <details key={id} className="rounded-lg border border-white/[0.06] p-3 open:bg-white/[0.02]">
              <summary className="cursor-pointer list-none text-[13px]">
                <span className="mr-2 font-mono text-[11px] text-slate-500">{id}</span>
                {g.question}
                <span className="float-right font-mono text-[11px]">
                  <span className="text-violet-300">{g.f1.toFixed(2)}</span> / <span className="text-pink-300">{v.f1.toFixed(2)}</span>
                </span>
              </summary>
              <div className="mt-3 font-mono text-[11px] text-slate-400">gold: {g.gold.join(", ")}</div>
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                {[g, v].map((r) => (
                  <div key={r.system} className="rounded-md bg-black/30 p-3">
                    <div className={`text-[11px] uppercase tracking-wider ${r.system === "graph" ? "text-violet-300" : "text-pink-300"}`}>
                      {r.system} · F1 {r.f1.toFixed(2)} · {r.tokens.toLocaleString()} tokens{r.verified ? ` · verified ${r.verified}` : ""}
                    </div>
                    {r.system === "graph" && <div className="mt-1 font-mono text-[10.5px] text-slate-500">{r.tools.join(" → ")}</div>}
                    <pre className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-slate-300">{r.answer}</pre>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </main>
  );
}
