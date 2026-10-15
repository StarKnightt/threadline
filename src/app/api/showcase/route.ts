import { listShowcase } from "@/lib/memory";

export async function GET() {
  const rows = await listShowcase();
  return Response.json(rows, { headers: { "Cache-Control": "public, max-age=60, s-maxage=600" } });
}
