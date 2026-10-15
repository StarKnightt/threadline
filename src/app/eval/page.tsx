import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { ThemeToggle } from "@/components/theme-toggle";

export const metadata: Metadata = { title: "Evaluation: graph agent vs vector RAG | Threadline" };

type Stats = { n: number; f1: number; precision: number; recall: number; exact: number; tokens: number; p50ms: number; p95ms: number; steps: number; citationValidity: number | null; fullyGrounded: number | null };
type Pair = { graph: Stats; vector: Stats };
type Summary = { model: string; generatedAt: string; pairedQuestions: number; totalQuestions?: number; overall: Pair; models?: Record<string, Pair>; modelInfo?: Record<string, { provider: string; questions: string[] }>; mixedModels?: boolean; categories: Record<string, Pair> };
type Row = { id: string; category: string; system: string; model: string; provider?: string; question: string; gold: string[]; pred: string[]; f1: number; answer: string; tokens: number; ms: number; verified: string | null; tools: string[] };

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
  // A question's pair is the graph and vector rows from the same model (unpaired leftovers are not shown).
  const pairs = [...new Set(rows.filter((r) => r.system === "graph").map((r) => `${r.id}|${r.model}`))]
    .map((k) => {
      const [id, model] = k.split("|");
      const g = rows.find((r) => r.id === id && r.model === model && r.system === "graph");
      const v = rows.find((r) => r.id === id && r.model === model && r.system === "vector");
      return g && v ? { id, g, v } : null;
    })
    .filter((p): p is { id: string; g: Row; v: Row } => !!p)
    .sort((a, b) => {
      const order = Object.keys(LABELS);
      const ca = order.indexOf(a.id.replace(/-\d+$/, ""));
      const cb = order.indexOf(b.id.replace(/-\d+$/, ""));
      return ca - cb || a.id.localeCompare(b.id, "en", { numeric: true });
    });
  const provider = (m: string) => ((s?.modelInfo?.[m]?.provider ?? "groq") === "openai" ? "OpenAI" : "Groq");

  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-300">
      <div className="flex items-center gap-3">
        <Link href="/" className="text-[12px] text-slate-500 hover:text-white">← Threadline</Link>
        <ThemeToggle className="ml-auto" />
      </div>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">Graph agent vs vector RAG</h1>
      <p className="mt-3 max-w-3xl text-[14px] leading-relaxed">
        60 questions in six categories, generated from templates over the raw GitHub JSON. Gold answers are computed by <code className="text-slate-200">eval/gold.ts</code> directly from that JSON, without FalkorDB, so the graph never grades itself. Both systems use the same language model, the same 256-dimension embeddings and the same FalkorDB vector index. The vector baseline embeds the question, takes the 8 nearest chunks (with each chunk&apos;s document title, author, state and date) and answers from them. Scores are set-based F1 over the entities in each answer&apos;s final ANSWER line.
      </p>
      {s ? (
        <>
          <div className="mt-2 font-mono text-[11px] text-slate-500">
            {s.pairedQuestions} of {s.totalQuestions ?? 60} questions answered by both systems · generated {s.generatedAt.slice(0, 16).replace("T", " ")} UTC
          </div>
          {s.pairedQuestions < (s.totalQuestions ?? 60) && (
            <p className="mt-2 max-w-3xl text-[12.5px] text-slate-400">
              The run is still in progress: questions rotate across three Groq models because each model has its own daily token cap, and the remaining questions resume as that cap refills. Numbers below cover only finished pairs.
            </p>
          )}
          {s.mixedModels && s.models && (
            <p className="mt-2 max-w-3xl text-[12.5px] text-slate-400">
              Mixed models: {Object.entries(s.models).map(([m, v]) => `${m} (${provider(m)}) answered ${v.graph.n}`).join(", ")} of the questions. Groq&apos;s free daily caps stopped the rotation part way, so the unfinished questions were completed on OpenAI with reasoning off. Each question&apos;s graph and vector runs always used the same model, and every question below names its model. The overall numbers pool all models.
            </p>
          )}
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {(["graph", "vector"] as const).map((k) => (
              <div key={k} className="rounded-xl border border-white/[0.07] bg-surface p-5">
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

          {s.models && (
            <>
              <h2 className="mt-10 text-lg font-semibold text-white">By model</h2>
              <p className="mt-1 text-[12.5px] text-slate-500">Questions were assigned round-robin to three Groq models, and those the daily caps left unfinished went to OpenAI. Both systems always answer a given question with the same model. The models received different mixes of categories, so these rows are not a ranking of the models.</p>
              <div className="mt-3 overflow-x-auto rounded-xl border border-white/[0.06]">
                <table className="w-full text-left text-[12.5px]">
                  <thead className="text-[11px] uppercase tracking-wider text-slate-500">
                    <tr className="border-b border-white/[0.06]">
                      <th className="p-2.5 font-medium">Model</th>
                      <th className="p-2.5 font-medium">Pairs</th>
                      <th className="p-2.5 font-medium text-violet-300">Graph F1</th>
                      <th className="p-2.5 font-medium text-pink-300">Vector F1</th>
                      <th className="p-2.5 font-medium">Graph tok/answer</th>
                      <th className="p-2.5 font-medium">Vector tok/answer</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-[12px] text-slate-300">
                    {Object.entries(s.models).map(([m, v]) => (
                      <tr key={m} className="border-b border-white/[0.04] last:border-0">
                        <td className="p-2.5">{m} <span className="text-slate-500">({provider(m)})</span></td>
                        <td className="p-2.5">{v.graph.n}</td>
                        <td className="p-2.5">{v.graph.f1.toFixed(2)}</td>
                        <td className="p-2.5">{v.vector.f1.toFixed(2)}</td>
                        <td className="p-2.5">{Math.round(v.graph.tokens).toLocaleString()}</td>
                        <td className="p-2.5">{Math.round(v.vector.tokens).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

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
                  <Bar v={v.graph.f1} color="var(--tl-graph)" />
                  <span className="font-mono text-slate-300">{v.graph.f1.toFixed(2)}</span>
                  <span className="text-pink-300">Vector RAG</span>
                  <Bar v={v.vector.f1} color="var(--tl-vector)" />
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
        {pairs.map(({ id, g, v }) => {
          return (
            <details key={id} className="rounded-lg border border-white/[0.06] p-3 open:bg-surface">
              <summary className="cursor-pointer list-none text-[13px]">
                <span className="mr-2 font-mono text-[11px] text-slate-500">{id}</span>
                {g.question}
                <span className="ml-2 font-mono text-[10.5px] text-slate-500">{g.model} ({provider(g.model)})</span>
                <span className="float-right font-mono text-[11px]">
                  <span className="text-violet-300">{g.f1.toFixed(2)}</span> / <span className="text-pink-300">{v.f1.toFixed(2)}</span>
                </span>
              </summary>
              <div className="mt-3 font-mono text-[11px] text-slate-400">gold: {g.gold.join(", ")}</div>
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                {[g, v].map((r) => (
                  <div key={r.system} className="rounded-md bg-black/30 p-3">
                    <div className={`text-[11px] uppercase tracking-wider ${r.system === "graph" ? "text-violet-300" : "text-pink-300"}`}>
                      {r.system} · {r.model} · F1 {r.f1.toFixed(2)} · {r.tokens.toLocaleString()} tokens{r.verified ? ` · verified ${r.verified}` : ""}
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
