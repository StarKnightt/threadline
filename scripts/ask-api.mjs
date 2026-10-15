// Ask through the HTTP API (exercises memory, persistence and the SSE stream).
// Usage: node scripts/ask-api.mjs <baseUrl> <userId> <sessionId> "question" [graph|split]
const [base, userId, sessionId, question, mode = "graph"] = process.argv.slice(2);
const res = await fetch(`${base}/api/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, userId, sessionId, mode }) });
if (!res.ok) {
  console.log(res.status, await res.text());
  process.exit(1);
}
const text = await res.text();
for (const block of text.split("\n\n")) {
  const line = block.replace(/^data: /, "").trim();
  if (!line) continue;
  const e = JSON.parse(line);
  if (e.type === "memory") console.log("MEMORY", JSON.stringify({ facts: e.facts, previous: e.previous, playbook: e.playbook }));
  if (e.type === "step_result") console.log(`[${e.lane}] ${e.tool} ${JSON.stringify(e.args).slice(0, 120)} -> ${e.rows?.length} rows${e.note ? " | " + e.note : ""}`);
  if (e.type === "handoff") console.log("HANDOFF", e.reason);
  if (e.type === "answer") console.log(`[${e.lane}] ANSWER${e.revised ? " (revised)" : ""}:`, e.text.replace(/\n+/g, " ").slice(0, 400));
  if (e.type === "done") console.log(`[${e.lane}] done trace=${e.traceId} tokens=${e.tokens} ms=${e.ms}`);
  if (e.type === "error") console.log("ERROR", e.message);
}
