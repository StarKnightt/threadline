"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Trace, TraceStep } from "@/lib/agent/types";
import { emptyLane, laneFromTrace, reduce, type Lane } from "@/lib/client/trace-state";
import { Answer, GroundedBadge, KeyChip } from "./answer";
import { Cypher } from "./cypher";
import { ThemeToggle } from "./theme-toggle";
import type { Constellation } from "./scene";
import { nodeVar } from "@/lib/theme";

const Scene = dynamic(() => import("./scene").then((m) => m.Scene), { ssr: false, loading: () => <div className="grid h-full place-items-center text-xs text-slate-500">Loading the graph…</div> });

const TOOL_NAMES: Record<string, string> = {
  find_entities: "Resolve entities",
  details: "Read node",
  expand: "Expand one hop",
  who_knows: "Who knows",
  trace: "Trace decision",
  connect: "Connect",
  impact: "Impact",
  activity: "Activity",
  rank: "Graph algorithm",
  cypher_readonly: "Free-form Cypher",
  verify_citations: "Verifier: path check",
  draft_triage: "Action: draft triage",
  vector_search: "Vector search",
};

type Showcase = { id: string; question: string; verified: number; total: number };
type Health = { ok: boolean; nodes: number; relationships: number; lastSync?: { at: number } | null; loadedAt?: number | null };
type Memory = { graph: string; facts: { text: string; kind: string }[]; history: { question: string; at: number; traceId: string; verified: number; total: number }[] };

function ids() {
  if (typeof window === "undefined") return { userId: "", sessionId: "" };
  let userId = localStorage.getItem("tl_user");
  if (!userId) localStorage.setItem("tl_user", (userId = crypto.randomUUID()));
  let sessionId = sessionStorage.getItem("tl_session");
  if (!sessionId) sessionStorage.setItem("tl_session", (sessionId = crypto.randomUUID()));
  return { userId, sessionId };
}

function StepCard({ s, active, onClick }: { s: TraceStep; active: boolean; onClick: () => void }) {
  const [open, setOpen] = useState(false);
  const verifier = s.agent === "verifier";
  const args = Object.entries(s.args).filter(([, v]) => v !== undefined && v !== null && !(Array.isArray(v) && !v.length));
  return (
    <div className={`tl-in rounded-lg border p-3 transition-colors ${verifier ? "border-gold/30 bg-gold/[0.04]" : active ? "border-violet-400/40 bg-violet-400/[0.06]" : "border-white/[0.06] bg-surface hover:border-white/15"}`}>
      <button onClick={onClick} className="flex w-full items-baseline gap-2 text-left">
        <span className={`font-mono text-[11px] ${verifier ? "text-gold" : "text-violet-300"}`}>{String(s.step).padStart(2, "0")}</span>
        <span className="text-[13px] font-medium text-slate-100">{TOOL_NAMES[s.tool] ?? s.tool}</span>
        <span className="ml-auto shrink-0 font-mono text-[10.5px] text-slate-500">
          {s.queries.length} quer{s.queries.length === 1 ? "y" : "ies"} · {s.ms} ms · {s.rows.length} rows
        </span>
      </button>
      {args.length > 0 && !verifier && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-slate-400">
          {args.map(([k, v]) => (
            <span key={k}>
              <span className="text-slate-500">{k}=</span>
              {typeof v === "string" ? `"${v.length > 60 ? v.slice(0, 60) + "…" : v}"` : JSON.stringify(v).slice(0, 60)}
            </span>
          ))}
        </div>
      )}
      {s.note && <div className={`mt-1.5 text-[11.5px] ${verifier ? "text-gold" : "text-slate-400"}`}>{s.note}</div>}
      {typeof s.rows[0]?.draft === "string" && (
        <div className="mt-2 rounded-md border border-emerald-400/20 bg-emerald-400/[0.04] p-2.5">
          <div className="mb-1 flex items-center text-[10.5px] uppercase tracking-wider text-emerald-300">
            Triage draft (not posted)
            <button onClick={() => navigator.clipboard.writeText(s.rows[0].draft as string)} className="ml-auto normal-case tracking-normal text-emerald-300 hover:text-white">Copy</button>
          </div>
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-300">{s.rows[0].draft as string}</pre>
        </div>
      )}
      {s.error && <div className="mt-1.5 text-[11.5px] text-rose-300">Error: {s.error}</div>}
      {s.queries.length > 0 && (
        <div className="mt-2">
          <button onClick={() => setOpen((o) => !o)} className="text-[11px] text-slate-500 hover:text-slate-300">
            {open ? "▾ hide Cypher" : "▸ show Cypher"}
          </button>
          {open && (
            <div className="mt-1.5 space-y-2">
              {s.queries.slice(0, 4).map((q, i) => (
                <div key={i}>
                  <Cypher code={q.cypher} />
                  <div className="mt-0.5 font-mono text-[10px] text-slate-500">
                    params {JSON.stringify(q.params).slice(0, 160)} · {q.rows} rows · {q.ms} ms
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function usePlayback(lane: Lane | null, live: boolean) {
  const [upTo, setUpTo] = useState(0);
  const [playing, setPlaying] = useState(false);
  const total = lane?.steps.length ?? 0;
  useEffect(() => {
    if (live) setUpTo(total);
  }, [live, total]);
  useEffect(() => {
    if (!playing) return;
    if (upTo >= total) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setUpTo((u) => u + 1), upTo === 0 ? 500 : 1700);
    return () => clearTimeout(t);
  }, [playing, upTo, total]);
  const replay = useCallback(() => {
    setUpTo(0);
    setPlaying(true);
  }, []);
  return { upTo, setUpTo, playing, setPlaying, replay };
}

export function Theatre({ traceId }: { traceId?: string }) {
  const [constellation, setConstellation] = useState<Constellation | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [showcase, setShowcase] = useState<Showcase[]>([]);
  const [graph, setGraph] = useState<Lane | null>(null);
  const [vector, setVector] = useState<Lane | null>(null);
  const [tab, setTab] = useState<"graph" | "vector">("graph");
  const [question, setQuestion] = useState("");
  const [asked, setAsked] = useState("");
  const [split, setSplit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [memory, setMemory] = useState<Memory | null>(null);
  const [memOpen, setMemOpen] = useState(false);
  const gp = usePlayback(graph, live);
  const vp = usePlayback(vector, live);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/constellation").then((r) => r.json()).then(setConstellation).catch(() => {});
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
    fetch("/api/showcase").then((r) => r.json()).then((x) => Array.isArray(x) && setShowcase(x)).catch(() => {});
  }, []);

  const loadMemory = useCallback(() => {
    const { userId } = ids();
    fetch(`/api/memory?userId=${userId}`).then((r) => r.json()).then(setMemory).catch(() => {});
  }, []);

  const openTrace = useCallback(
    async (id: string, push = true) => {
      abortRef.current?.abort();
      setError(null);
      setLive(false);
      const t = (await fetch(`/api/trace/${id}`).then((r) => (r.ok ? r.json() : null))) as Trace | null;
      if (!t) return setError("That trace was not found.");
      const pair = t.pairId ? ((await fetch(`/api/trace/${t.pairId}`).then((r) => (r.ok ? r.json() : null))) as Trace | null) : null;
      setAsked(t.question);
      setQuestion(t.question);
      const g = t.mode === "graph" ? t : pair?.mode === "graph" ? pair : null;
      const v = t.mode === "vector" ? t : pair?.mode === "vector" ? pair : null;
      setGraph(g ? laneFromTrace(g) : null);
      setVector(v ? laneFromTrace(v) : null);
      setSplit(!!(g && v));
      setTab(g ? "graph" : "vector");
      gp.replay();
      vp.replay();
      if (push) window.history.pushState(null, "", `/t/${id}`);
    },
    [gp, vp],
  );

  useEffect(() => {
    if (traceId) openTrace(traceId, false);
  }, [traceId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function ask(q: string) {
    if (busy || q.trim().length < 6) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setLive(true);
    setError(null);
    setAsked(q);
    setGraph(emptyLane("graph"));
    setVector(split ? emptyLane("vector") : null);
    setTab("graph");
    const { userId, sessionId } = ids();
    try {
      const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: q, mode: split ? "split" : "graph", userId, sessionId }), signal: ac.signal });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const p of parts) {
          const line = p.replace(/^data: /, "");
          if (!line.trim()) continue;
          const e = JSON.parse(line) as Record<string, unknown>;
          if (e.type === "error") setError(e.message as string);
          if (e.lane === "vector") setVector((l) => reduce(l ?? emptyLane("vector"), e));
          else setGraph((l) => reduce(l ?? emptyLane("graph"), e));
          if (e.type === "done" && e.lane === "graph") window.history.replaceState(null, "", `/t/${e.traceId}`);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setBusy(false);
      loadMemory();
    }
  }

  const lane = tab === "vector" ? vector : graph;
  const playback = tab === "vector" ? vp : gp;
  const shown = lane?.steps.slice(0, live ? lane.steps.length : Math.max(playback.upTo, 0)) ?? [];
  const answerVisible = lane && (live ? !!lane.answer : playback.upTo >= lane.steps.length);
  const hops = useMemo(() => new Set(graph?.steps.flatMap((s) => s.edges.map((e) => `${e[0]}|${e[2]}`)) ?? []).size, [graph]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-slate-200 lg:flex-row">
      <aside className="order-2 flex min-h-0 flex-1 flex-col border-white/[0.06] lg:order-1 lg:w-[460px] lg:flex-none lg:border-r">
        <header className="border-b border-white/[0.06] px-5 pb-3 pt-4">
          <div className="flex items-center gap-2">
            <Link href="/" onClick={() => { setGraph(null); setVector(null); setAsked(""); }} className="flex items-center gap-2">
              <span className="relative h-5 w-5">
                <span className="absolute left-0 top-2 h-1 w-5 rounded-full bg-gradient-to-r from-amber-300 via-violet-400 to-gold" />
                <span className="absolute left-0 top-0.5 h-1.5 w-1.5 rounded-full bg-amber-300" />
                <span className="absolute right-0 top-3 h-1.5 w-1.5 rounded-full bg-gold" />
              </span>
              <span className="text-[15px] font-semibold tracking-tight text-white">Threadline</span>
            </Link>
            <nav className="ml-auto flex items-center gap-3 text-[12px] text-slate-400">
              <Link href="/eval" className="hover:text-white">Eval</Link>
              <Link href="/how" className="hover:text-white">How it works</Link>
              <a href="https://github.com/StarKnightt/threadline" target="_blank" rel="noreferrer" className="hover:text-white">GitHub</a>
            </nav>
            <ThemeToggle className="ml-1" />
          </div>
          <p className="mt-1.5 text-[12px] leading-snug text-slate-400">
            A company brain built from the public GitHub history of the FalkorDB organisation. Every answer walks a FalkorDB graph, and every hop is shown with its Cypher.
          </p>
          {health?.ok && (
            <div className="mt-2 font-mono text-[10.5px] text-slate-500">
              {health.nodes.toLocaleString()} nodes · {health.relationships.toLocaleString()} relationships · FalkorDB Cloud
            </div>
          )}
        </header>

        <div className="border-b border-white/[0.06] px-5 py-3">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
          >
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  ask(question);
                }
              }}
              rows={2}
              maxLength={400}
              placeholder="Who should review a change to the vector index code?"
              className="w-full resize-none rounded-lg border border-white/10 bg-surface px-3 py-2 text-[13.5px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400/50"
            />
            <div className="mt-2 flex items-center gap-2">
              <div className="flex rounded-md border border-white/10 p-0.5 text-[11.5px]">
                <button type="button" onClick={() => setSplit(false)} className={`tl-press rounded px-2 py-1 ${!split ? "bg-white/10 text-white" : "text-slate-400"}`}>Graph agent</button>
                <button type="button" onClick={() => setSplit(true)} className={`tl-press rounded px-2 py-1 ${split ? "bg-white/10 text-white" : "text-slate-400"}`}>Graph vs vector RAG</button>
              </div>
              <button disabled={busy || question.trim().length < 6} className="ml-auto rounded-md tl-press bg-accent px-3 py-1.5 text-[12.5px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-40">
                {busy ? "Walking the graph…" : "Ask"}
              </button>
            </div>
          </form>
          {showcase.length > 0 && (
            <div className="mt-3">
              <div className="mb-1.5 text-[10.5px] uppercase tracking-wider text-slate-500">Recorded runs (replay from FalkorDB, no LLM call)</div>
              <div className="flex flex-col gap-1">
                {showcase.map((s) => (
                  <button key={s.id} onClick={() => openTrace(s.id)} className="tl-press truncate rounded-md border border-white/[0.06] bg-surface px-2.5 py-1.5 text-left text-[12px] text-slate-300 hover:border-violet-400/40 hover:text-white">
                    {s.question}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {error && <div className="mb-3 rounded-md border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[12px] text-rose-200">{error}</div>}
          {asked && (
            <>
              {vector && graph && (
                <div className="mb-3 flex rounded-md border border-white/10 p-0.5 text-[11.5px]">
                  <button onClick={() => setTab("graph")} className={`tl-press flex-1 rounded px-2 py-1 ${tab === "graph" ? "bg-white/10 text-white" : "text-slate-400"}`}>Graph agent</button>
                  <button onClick={() => setTab("vector")} className={`tl-press flex-1 rounded px-2 py-1 ${tab === "vector" ? "bg-white/10 text-white" : "text-slate-400"}`}>Vector RAG baseline</button>
                </div>
              )}
              <div className="mb-3 text-[13px] font-medium text-white">{asked}</div>
              {lane?.memory && (lane.memory.previous || lane.memory.facts.length > 0 || lane.memory.playbook) && (
                <div className="mb-3 rounded-lg border border-sky-400/20 bg-sky-400/[0.05] p-3 text-[11.5px] text-sky-200">
                  <div className="mb-1 font-medium text-sky-300">Recalled from memory</div>
                  {lane.memory.previous && <div>Previous question in this session: “{lane.memory.previous}”</div>}
                  {lane.memory.facts.map((f) => <div key={f}>Fact: {f}</div>)}
                  {lane.memory.playbook && <div>Playbook for {lane.memory.playbook.questionType} questions: {lane.memory.playbook.toolSequence}</div>}
                </div>
              )}
              <div className="space-y-2">
                {shown.map((s) => (
                  <StepCard key={`${s.step}-${s.tool}`} s={s} active={s.step === shown[shown.length - 1]?.step} onClick={() => playback.setUpTo(s.step)} />
                ))}
                {lane?.running && (
                  <div className="flex items-center gap-2 rounded-lg border border-violet-400/30 bg-violet-400/[0.05] px-3 py-2 text-[12.5px] text-violet-200">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-violet-400" />
                    {TOOL_NAMES[lane.running.tool] ?? lane.running.tool}…
                  </div>
                )}
                {busy && lane && !lane.running && !lane.answer && <div className="px-1 text-[12px] text-slate-500">Thinking about the next hop…</div>}
                {lane?.handoff && answerVisible && (
                  <div className="rounded-lg border border-sky-400/25 bg-sky-400/[0.05] px-3 py-2 text-[11.5px] text-sky-200">
                    <span className="font-medium text-sky-300">Handoff, verifier to investigator: </span>
                    {lane.handoff.reason}
                  </div>
                )}
              </div>
              {answerVisible && lane?.answer && (
                <div className="tl-in mt-4 rounded-lg border border-white/[0.08] bg-surface p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-[11px] uppercase tracking-wider text-slate-500">{lane.mode === "graph" ? "Answer" : "Vector RAG answer"}</span>
                    {lane.mode === "graph" ? <GroundedBadge citations={lane.citations} handoff={lane.handoff} /> : <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-slate-400">no path check possible: chunks are not connected</span>}
                  </div>
                  <Answer text={lane.answer} citations={lane.citations} onHover={setHovered} />
                  <div className="mt-3 font-mono text-[10px] text-slate-500">
                    {lane.model}
                    {lane.tokens ? ` · ${lane.tokens.toLocaleString()} tokens` : ""}
                    {lane.ms ? ` · ${(lane.ms / 1000).toFixed(1)} s` : ""}
                    {lane.traceId ? ` · trace ${lane.traceId}` : ""}
                  </div>
                </div>
              )}
            </>
          )}
          {!asked && (
            <div className="space-y-3 text-[12.5px] leading-relaxed text-slate-400">
              <p>Ask about people, code areas, issues, pull requests and releases across six FalkorDB repositories. Or replay a recorded run above.</p>
              <p className="text-slate-500">The agent resolves your words to graph nodes, then calls typed graph tools (expertise, decision trace, impact, activity, PageRank, betweenness, label propagation). A verifier checks that every cited node is connected to the question by a real path before the answer gets a gold badge.</p>
            </div>
          )}
        </div>

        <div className="border-t border-white/[0.06] px-5 py-2">
          <button onClick={() => { setMemOpen((o) => !o); if (!memOpen) loadMemory(); }} className="flex w-full items-center text-[11.5px] text-slate-400 hover:text-slate-200">
            <span>{memOpen ? "▾" : "▸"} What I remember about you</span>
            {memory && <span className="ml-auto font-mono text-[10px] text-slate-500">{memory.history.length} turns · {memory.facts.length} facts</span>}
          </button>
          {memOpen && memory && (
            <div className="mt-2 max-h-48 space-y-2 overflow-y-auto pb-1 text-[11.5px]">
              <div className="font-mono text-[10px] text-slate-500">your own graph: {memory.graph}</div>
              {memory.facts.length === 0 && <div className="text-slate-500">No facts yet. Try “I work on the TypeScript client” in a question.</div>}
              {memory.facts.map((f) => <div key={f.text} className="text-slate-300">• {f.text} <span className="text-slate-500">({f.kind})</span></div>)}
              {memory.history.slice(0, 6).map((h) => (
                <button key={h.traceId + h.at} onClick={() => openTrace(h.traceId)} className="block w-full truncate text-left text-slate-400 hover:text-white">
                  ↺ {h.question}
                </button>
              ))}
              <button
                onClick={async () => {
                  await fetch(`/api/memory?userId=${ids().userId}`, { method: "DELETE" });
                  loadMemory();
                }}
                className="text-rose-300 hover:text-rose-200"
              >
                Forget everything
              </button>
            </div>
          )}
        </div>
      </aside>

      <main className="relative order-1 h-[46dvh] shrink-0 lg:order-2 lg:h-auto lg:flex-1">
        <div className={`grid h-full ${split && vector ? "grid-cols-2" : "grid-cols-1"}`}>
          {split && vector && (
            <div className="relative border-r border-white/[0.06]">
              <div className="pointer-events-none absolute left-4 top-3 z-10">
                <div className="text-[11px] uppercase tracking-wider text-pink-300">Vector RAG</div>
                <div className="text-[12px] text-slate-400">{vector.chunks?.length ?? 0} retrieved chunks, no connections between them</div>
              </div>
              <Scene constellation={constellation} lane={vector} upTo={live ? vector.steps.length : vp.upTo} hovered={hovered} onHover={setHovered} onPick={() => {}} />
            </div>
          )}
          <div className="relative">
            {split && vector && (
              <div className="pointer-events-none absolute left-4 top-3 z-10">
                <div className="text-[11px] uppercase tracking-wider text-violet-300">Graph agent</div>
                <div className="text-[12px] text-slate-400">{graph?.steps.filter((s) => s.agent !== "verifier").length ?? 0} tool calls, {hops} traversed edges</div>
              </div>
            )}
            <Scene constellation={constellation} lane={graph} upTo={live ? (graph?.steps.length ?? 0) : gp.upTo} hovered={hovered} onHover={setHovered} onPick={(k) => setHovered(k)} />
          </div>
        </div>

        {hovered && (
          <div className="pointer-events-auto absolute right-4 top-3 z-20 max-w-[320px]">
            <KeyChip k={hovered} />
          </div>
        )}

        <div className="pointer-events-none absolute bottom-3 left-4 z-10 hidden flex-wrap gap-x-3 gap-y-1 text-[10.5px] text-slate-400 md:flex">
          {["Repo", "Person", "PullRequest", "Issue", "Directory", "File", "Release", "Concept", "Doc"].map((l) => (
            <span key={l} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ background: nodeVar(l) }} />
              {l === "PullRequest" ? "Pull request" : l}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-gold" />
            Verified path
          </span>
        </div>

        {graph && graph.steps.length > 0 && !live && (
          <div className="absolute bottom-3 right-4 z-10 flex items-center gap-2 rounded-full border border-white/10 bg-black/50 px-3 py-1.5 backdrop-blur">
            <button onClick={() => { gp.replay(); vp.replay(); }} className="text-[11.5px] text-slate-300 hover:text-white">
              {gp.playing ? "Playing…" : "↻ Replay"}
            </button>
            <div className="flex gap-1">
              {graph.steps.map((s) => (
                <button key={s.step} onClick={() => gp.setUpTo(s.step)} title={TOOL_NAMES[s.tool] ?? s.tool} aria-label={`Show up to step ${s.step}: ${TOOL_NAMES[s.tool] ?? s.tool}`} className="tl-press -m-1 grid h-4 w-4 place-items-center rounded-full">
                  <span className={`h-2 w-2 rounded-full transition-colors ${s.step <= gp.upTo ? (s.agent === "verifier" ? "bg-gold" : "bg-violet-400") : "bg-white/15"}`} />
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
