const KW = /\b(MATCH|OPTIONAL MATCH|WHERE|WITH|RETURN|ORDER BY|DESC|ASC|LIMIT|UNWIND|CALL|YIELD|MERGE|SET|CREATE|AS|AND|OR|NOT|IN|IS NULL|IS NOT NULL|CASE|WHEN|THEN|ELSE|END|DISTINCT|STARTS WITH|ENDS WITH|CONTAINS|count|collect|coalesce|max|sum|exp|size|toLower|toInteger|labels|type|id|startNode|nodes|relationships|length|allShortestPaths|shortestPath|vecf32|properties)\b/g;

/** Minimal Cypher highlighter: keywords, labels and relationship types, parameters, strings. */
export function Cypher({ code }: { code: string }) {
  const parts: { t: string; c?: string }[] = [];
  const re = new RegExp(`${KW.source}|(:[A-Z][A-Za-z_|]*)|(\\$\\w+)|('[^']*')`, "g");
  let last = 0;
  for (const m of code.matchAll(re)) {
    if (m.index! > last) parts.push({ t: code.slice(last, m.index) });
    parts.push({ t: m[0], c: m[1] ? "text-sky-300" : m[2] ? "text-amber-300" : m[3] ? "text-pink-300" : m[4] ? "text-emerald-300" : undefined });
    last = m.index! + m[0].length;
  }
  parts.push({ t: code.slice(last) });
  return (
    <pre className="overflow-x-auto whitespace-pre rounded-md border border-white/5 bg-black/40 p-3 font-mono text-[11px] leading-[1.55] text-slate-300">
      {parts.map((p, i) => (p.c ? <span key={i} className={p.c}>{p.t}</span> : p.t))}
    </pre>
  );
}
