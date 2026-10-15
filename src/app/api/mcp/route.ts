import { createMcpHandler } from "mcp-handler";
import { makeTools, type ToolCtx } from "@/lib/agent/tools";
import { bump } from "@/lib/memory";

export const maxDuration = 30;

// The same typed graph tools the Threadline agent uses, served over MCP (Streamable HTTP).
// The calling client's model does the tool selection; nothing here calls an LLM.
const TOOL_NAMES = ["find_entities", "details", "expand", "who_knows", "trace", "connect", "impact", "activity", "rank", "draft_triage", "cypher_readonly"] as const;

async function callTool(name: (typeof TOOL_NAMES)[number], args: unknown) {
  const n = await bump("mcp:global", 3600);
  if (n > 600) return { content: [{ type: "text" as const, text: "Hourly MCP limit reached for the public demo. Try again later." }], isError: true };
  const ctx: ToolCtx = { now: Math.floor(Date.now() / 1000), steps: [], emit: () => {} };
  const tools = makeTools(ctx);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out = await (tools[name].execute as any)(args, { toolCallId: "mcp", messages: [] });
  const s = ctx.steps[0];
  const payload = { ...out, cypher: s?.queries.map((q) => q.cypher), refs: s?.refs.slice(0, 40), ms: s?.ms };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 1) }] };
}

const handler = createMcpHandler((server) => {
  const describe = makeTools({ now: 0, steps: [], emit: () => {} });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const register = server.registerTool.bind(server) as (...a: any[]) => unknown;
  for (const name of TOOL_NAMES) {
    const t = describe[name];
    register(name, { title: name.replace(/_/g, " "), description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true } }, (args: unknown) => callTool(name, args));
  }
}, { verboseLogs: process.env.NODE_ENV !== "production" });

export { handler as GET, handler as POST, handler as DELETE };
