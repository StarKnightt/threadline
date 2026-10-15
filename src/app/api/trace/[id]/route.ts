import { getTrace } from "@/lib/memory";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-zA-Z0-9-]{4,64}$/.test(id)) return Response.json({ error: "bad id" }, { status: 400 });
  const trace = await getTrace(id).catch(() => null);
  if (!trace) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(trace, { headers: { "Cache-Control": "public, max-age=60, s-maxage=86400" } });
}
