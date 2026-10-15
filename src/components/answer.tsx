"use client";

import { Fragment } from "react";
import { labelOf, shortName, type Citation } from "@/lib/agent/types";
import { githubUrl } from "@/lib/client/trace-state";
import { nodeVar } from "@/lib/theme";

const KEY_SPLIT = /[\[【]?\b((?:pr|issue|person|file|dir|release|doc|concept|repo|label):[^\s\]\[;,()【】「」'"*]+?)[\]】]?(?=[\s.,;)\]【】*]|$)/g;

export function KeyChip({ k, status, onHover }: { k: string; status?: "ok" | "rejected"; onHover?: (k: string | null) => void }) {
  const url = githubUrl(k);
  const label = labelOf(k);
  const inner = (
    <>
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: nodeVar(label) }} />
      <span className="truncate">{shortName(k)}</span>
      {status === "ok" && <span className="text-gold" title="Verified: observed in a tool result and connected to the question by a graph path">✓</span>}
      {status === "rejected" && <span className="text-rose-400" title="Rejected by the verifier">✕</span>}
    </>
  );
  const cls = "mx-0.5 inline-flex max-w-[220px] items-center gap-1 rounded border border-white/10 bg-white/[0.04] px-1.5 py-[1px] align-baseline font-mono text-[11px] text-slate-200 transition hover:border-white/30 hover:bg-white/10";
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className={cls} onMouseEnter={() => onHover?.(k)} onMouseLeave={() => onHover?.(null)}>
      {inner}
    </a>
  ) : (
    <span className={cls} onMouseEnter={() => onHover?.(k)} onMouseLeave={() => onHover?.(null)}>
      {inner}
    </span>
  );
}

function inline(text: string, cites: Map<string, Citation>, onHover: (k: string | null) => void) {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(KEY_SPLIT)) {
    if (m.index! > last) out.push(text.slice(last, m.index).replace(/\*\*/g, ""));
    const key = m[1].replace(/[.:]+$/, "");
    const c = cites.get(key);
    out.push(<KeyChip key={`${key}-${m.index}`} k={key} status={c ? (c.ok ? "ok" : "rejected") : undefined} onHover={onHover} />);
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last).replace(/\*\*/g, ""));
  return out;
}

export function Answer({ text, citations, onHover }: { text: string; citations: Citation[]; onHover: (k: string | null) => void }) {
  const cites = new Map(citations.map((c) => [c.key, c]));
  const answerLine = [...text.matchAll(/ANSWER\s*:\s*(.+)/gi)].pop()?.[1];
  const body = text.replace(/\n?\s*ANSWER\s*:.+$/gim, "").trim();
  const lines = body.split(/\n+/);
  return (
    <div className="space-y-2 text-[13.5px] leading-relaxed text-slate-200">
      {lines.map((l, i) => {
        const li = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(l);
        return li ? (
          <div key={i} className="flex gap-2 pl-1">
            <span className="text-slate-500">•</span>
            <span>{inline(li[1], cites, onHover)}</span>
          </div>
        ) : (
          <p key={i}>{inline(l, cites, onHover)}</p>
        );
      })}
      {answerLine && (
        <div className="flex flex-wrap items-center gap-1 border-t border-white/5 pt-2 font-mono text-[11px] text-slate-400">
          <span className="mr-1 uppercase tracking-wider text-slate-500">answer</span>
          {answerLine.split(/;\s*/).filter(Boolean).map((a, i) => (
            <Fragment key={i}>{/^(pr|issue|person|release|file|dir|doc|concept|repo):/.test(a.trim()) ? <KeyChip k={a.trim()} onHover={onHover} /> : <span className="rounded bg-white/5 px-1.5 py-[1px]">{a.trim()}</span>}</Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export function GroundedBadge({ citations, handoff }: { citations: Citation[]; handoff?: { reason: string; rejected: string[] } }) {
  if (!citations.length) return <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-slate-400">no node citations</span>;
  const ok = citations.filter((c) => c.ok).length;
  const all = ok === citations.length;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span
        className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${all ? "border-gold/50 bg-gold/10 text-gold" : ok ? "border-amber-400/40 bg-amber-400/10 text-amber-300" : "border-rose-400/40 bg-rose-400/10 text-rose-300"}`}
        title="Each cited node must appear in a tool result and be reachable from the question's entry nodes within 4 hops"
      >
        {ok} of {citations.length} citations verified by graph path
      </span>
      {handoff && <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[11px] text-sky-300" title={handoff.reason}>verifier handed {handoff.rejected.length} claim{handoff.rejected.length === 1 ? "" : "s"} back</span>}
    </span>
  );
}
