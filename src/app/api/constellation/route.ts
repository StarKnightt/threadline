import { BRAIN, query } from "@/lib/falkor";

/** The background constellation for the 3D viewer. Positions are stored on the nodes in FalkorDB by scripts/layout.ts. */
export async function GET() {
  try {
    const [nodes, edges] = await Promise.all([
      query<{ key: string; name: string; label: string; x: number; y: number; z: number; w: number }>(
        BRAIN,
        "MATCH (n:Entity) WHERE n.x IS NOT NULL RETURN n.key AS key, coalesce(n.name, n.login, n.path) AS name, labels(n)[1] AS label, n.x AS x, n.y AS y, n.z AS z, n.w AS w",
        {},
        { ro: true },
      ),
      query<{ a: string; b: string; t: string }>(
        BRAIN,
        `MATCH (a:Entity)-[r:CONTRIBUTES_TO|IN_DIR|IN_REPO]->(b:Entity)
WHERE a.x IS NOT NULL AND b.x IS NOT NULL AND (type(r) <> 'CONTRIBUTES_TO' OR coalesce(r.prs, 0) + coalesce(r.reviews, 0) >= 5)
RETURN a.key AS a, b.key AS b, type(r) AS t`,
        {},
        { ro: true },
      ),
    ]);
    return Response.json({ nodes: nodes.rows, edges: edges.rows }, { headers: { "Cache-Control": "public, max-age=300, s-maxage=86400" } });
  } catch (e) {
    return Response.json({ nodes: [], edges: [], error: (e as Error).message.slice(0, 200) }, { status: 503 });
  }
}
