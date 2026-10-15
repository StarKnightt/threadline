import type { Metadata } from "next";
import Link from "next/link";
import { Cypher } from "@/components/cypher";
import { COLORS } from "@/components/scene";
import { Q } from "@/lib/cypher/catalogue";
import { DERIVED, INDEXES } from "@/lib/cypher/schema";
import { MEM_Q } from "@/lib/memory";

export const metadata: Metadata = { title: "How it works | Threadline" };

const NODES: [string, string, string][] = [
  ["Repo", "repo:FalkorDB/falkordb-browser", "name, language, stars, url"],
  ["Person", "person:<login>", "login, avatarUrl, isBot, firstSeenAt, lastSeenAt (no names or emails)"],
  ["Issue / PullRequest", "issue:FalkorDB/FalkorDB#123", "number, title, state, createdAt, closedAt, mergedAt, author, summary (600 chars)"],
  ["File / Directory", "file:FalkorDB/FalkorDB:src/index/x.c", "path, ext, depth"],
  ["Release", "release:FalkorDB/FalkorDB@v4.8.0", "tag, publishedAt, url, notes"],
  ["Label", "label:FalkorDB/FalkorDB:bug", "name, color"],
  ["Doc", "doc:docs:cypher/indexing/vector-index", "title, path, url"],
  ["Concept", "concept:vector-index", "name, aliases (fixed dictionary, no LLM)"],
  ["Chunk", "chunk:<owner>:<i>", "text (600 chars), embedding (vecf32, 256 dims), kind"],
];

const RELS: [string, string][] = [
  ["AUTHORED, REVIEWED {state}, MERGED, COMMENTED_ON {count}", "Person to Issue or PullRequest"],
  ["TOUCHED {additions, deletions}", "PullRequest to File"],
  ["IN_DIR", "File to Directory, Directory to parent Directory"],
  ["CLOSES {source}", "PullRequest to Issue (closing references, connected events, fixes #N)"],
  ["REFERENCES {crossRepo, source}", "Thread to Thread (timeline cross-references and #N in bodies)"],
  ["SHIPPED_IN {source}", "PullRequest to Release (release notes, else first release after merge)"],
  ["HAS_LABEL, ASSIGNED_TO, IN_REPO, HAS_REPO, PREVIOUS", "structure"],
  ["MENTIONS, DOCUMENTS", "Thread, Doc or Chunk to Concept"],
  ["PART_OF", "Chunk to Thread or Doc"],
  ["KNOWS {authored, reviewed, lastAt}", "derived: Person to Directory"],
  ["REVIEWS_FOR {count}", "derived: reviewer to author"],
  ["CONTRIBUTES_TO / HAS_CONTRIBUTOR", "derived: Person and Repo, both directions for betweenness"],
  ["CO_CHANGES {count}", "derived: Directory pairs changed by the same PRs"],
];

const USED_BY: Record<string, string> = {
  vectorEntry: "find_entities",
  fulltextEntry: "find_entities",
  byKeys: "find_entities",
  threadByNumber: "find_entities",
  conceptMatch: "find_entities, who_knows",
  details: "details",
  expand: "expand",
  whoKnowsArea: "who_knows",
  whoKnowsConcept: "who_knows",
  declaredOwners: "who_knows",
  traceIssue: "trace",
  tracePr: "trace",
  references: "trace",
  connect: "connect",
  impactOpenPrs: "impact",
  impactOpenIssues: "impact",
  coChanges: "impact",
  activityInArea: "activity",
  pageRankReviewers: "rank (reviewers)",
  betweennessBridges: "rank (bridges)",
  subsystems: "rank (subsystems)",
  verifyPath: "verifier",
  neighbourhood: "viewer",
  triageIssue: "draft_triage",
  triageSimilar: "draft_triage",
  triageOwners: "draft_triage",
  triageLabels: "draft_triage",
  vectorRag: "vector baseline",
};

export default function HowPage() {
  const catalogue: [string, string][] = Object.entries(Q as Record<string, string | Record<string, string>>).flatMap(([k, v]) =>
    typeof v === "string" ? [[k, v] as [string, string]] : Object.entries(v).map(([m, c]) => [`${k}.${m}`, c] as [string, string]),
  );
  return (
    <main className="mx-auto max-w-5xl px-6 py-10 text-slate-300">
      <Link href="/" className="text-[12px] text-slate-500 hover:text-white">← Threadline</Link>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-white">How Threadline works</h1>
      <p className="mt-3 max-w-3xl text-[14px] leading-relaxed">
        FalkorDB is the only database. It holds the company brain (one graph), each visitor&apos;s memory (one graph per visitor), the shared blackboard where the Investigator and Verifier agents coordinate, the stored traces that replay runs, the vector index used by both the agent and the baseline, the rate-limit counters, and even the 3D layout. Take FalkorDB out and nothing is left.
      </p>

      <h2 className="mt-10 text-lg font-semibold text-white">Pipeline</h2>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[13.5px] leading-relaxed">
        <li>Fetch: public GitHub GraphQL for six FalkorDB repositories plus the docs repo, cached as JSONL.</li>
        <li>Normalise: deterministic mapping to nodes and edges with stable keys; references parsed from timelines and bodies; concepts from a fixed dictionary.</li>
        <li>Embed: text-embedding-3-small at 256 dimensions, cached by content hash (total spend so far about four US cents).</li>
        <li>Load: <code>UNWIND</code> batches with <code>MERGE</code> on <code>key</code>, then derived edges in Cypher. About 41 MB of the free tier&apos;s 100 MB.</li>
        <li>Ask: the Investigator (Groq gpt-oss) calls typed graph tools; every tool returns rows, node keys, traversed edges and its Cypher, streamed to the browser.</li>
        <li>Verify: the Verifier checks each cited node was observed in a tool result and is reachable from the question&apos;s entry nodes within 4 hops. Rejected claims are handed back once.</li>
        <li>Remember: turns, tool calls and facts go to the visitor&apos;s own graph; verified tool sequences become shared playbooks.</li>
        <li>Stay current: a daily Vercel Cron job merges updated issues and PRs, recomputes derived edges and prunes idle memory graphs.</li>
      </ol>

      <h2 className="mt-10 text-lg font-semibold text-white">Graph data model</h2>
      <div className="mt-3 overflow-x-auto rounded-lg border border-white/[0.06]">
        <table className="w-full text-left text-[12.5px]">
          <thead className="bg-white/[0.03] text-slate-400"><tr><th className="p-2.5">Label (all brain nodes also carry :Entity)</th><th className="p-2.5">Key</th><th className="p-2.5">Properties</th></tr></thead>
          <tbody>
            {NODES.map(([l, k, p]) => (
              <tr key={l} className="border-t border-white/[0.05]">
                <td className="p-2.5"><span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: COLORS[l.split(" ")[0]] ?? "#94a3b8" }} />{l}</td>
                <td className="p-2.5 font-mono text-[11px] text-slate-400">{k}</td>
                <td className="p-2.5 text-slate-400">{p}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-white/[0.06]">
        <table className="w-full text-left text-[12.5px]">
          <thead className="bg-white/[0.03] text-slate-400"><tr><th className="p-2.5">Relationship</th><th className="p-2.5">Between</th></tr></thead>
          <tbody>
            {RELS.map(([r, b]) => (
              <tr key={r} className="border-t border-white/[0.05]"><td className="p-2.5 font-mono text-[11px] text-slate-200">{r}</td><td className="p-2.5 text-slate-400">{b}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[12.5px] text-slate-500">Memory graphs <code>tl_mem_&lt;visitor&gt;</code>: Session, Turn (episodic), ToolCall, Ref, Fact (semantic). Shared graph <code>tl_shared</code>: Trace, Task, Claim, Agent, Playbook (procedural, with its own vector index), QueryEmbedding, Rate.</p>

      <h2 className="mt-10 text-lg font-semibold text-white">Indexes</h2>
      <div className="mt-3"><Cypher code={INDEXES.join("\n")} /></div>

      <h2 className="mt-10 text-lg font-semibold text-white">Derived edges</h2>
      <div className="mt-3 space-y-3">
        {DERIVED.map((d) => (
          <div key={d.name}>
            <div className="mb-1 text-[12.5px] text-slate-400">{d.name}</div>
            <Cypher code={d.cypher} />
          </div>
        ))}
      </div>

      <h2 className="mt-10 text-lg font-semibold text-white">Cypher catalogue (the queries the tools run)</h2>
      <p className="mt-1 text-[12.5px] text-slate-500">Rendered from the same constants the server executes. All values are parameters.</p>
      <div className="mt-3 space-y-4">
        {catalogue.map(([k, c]) => (
          <div key={k}>
            <div className="mb-1 flex items-baseline gap-2 text-[12.5px]"><span className="font-mono text-slate-200">{k}</span><span className="text-slate-500">used by {USED_BY[k.split(".")[0]] ?? "activity"}</span></div>
            <Cypher code={c} />
          </div>
        ))}
      </div>

      <h2 className="mt-10 text-lg font-semibold text-white">Memory and coordination Cypher</h2>
      <div className="mt-3 space-y-4">
        {Object.entries(MEM_Q as Record<string, string>).map(([k, c]) => (
          <div key={k}>
            <div className="mb-1 font-mono text-[12.5px] text-slate-200">{k}</div>
            <Cypher code={c} />
          </div>
        ))}
      </div>

      <h2 className="mt-10 text-lg font-semibold text-white">MCP</h2>
      <p className="mt-2 text-[13.5px]">
        The same typed tools are served over MCP (Streamable HTTP) at <code className="text-slate-200">/api/mcp</code>: find_entities, details, expand, who_knows, trace, connect, impact, activity, rank, draft_triage and cypher_readonly. The client&apos;s own model chooses the tools; the server never calls an LLM.
      </p>
    </main>
  );
}
