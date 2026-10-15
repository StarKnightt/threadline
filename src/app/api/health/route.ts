import { BRAIN, query } from "@/lib/falkor";

export async function GET() {
  const t = Date.now();
  try {
    const [labels, rels, meta, sync] = await Promise.all([
      query<{ label: string; n: number }>(BRAIN, "MATCH (n) RETURN labels(n)[size(labels(n)) - 1] AS label, count(n) AS n ORDER BY n DESC", {}, { ro: true }),
      query<{ n: number }>(BRAIN, "MATCH ()-[r]->() RETURN count(r) AS n", {}, { ro: true }),
      query<{ loadedAt: number }>(BRAIN, "MATCH (m:Meta {key: 'meta'}) RETURN m.loadedAt AS loadedAt", {}, { ro: true }),
      query<{ at: number; items: number }>(BRAIN, "MATCH (s:SyncRun) RETURN s.at AS at, s.items AS items ORDER BY s.at DESC LIMIT 1", {}, { ro: true }),
    ]);
    const nodes = labels.rows.reduce((a, r) => a + r.n, 0);
    return Response.json(
      { ok: nodes > 0, nodes, relationships: rels.rows[0]?.n ?? 0, labels: Object.fromEntries(labels.rows.map((r) => [r.label, r.n])), loadedAt: meta.rows[0]?.loadedAt ?? null, lastSync: sync.rows[0] ?? null, ms: Date.now() - t },
      { headers: { "Cache-Control": "public, max-age=30, s-maxage=300" } },
    );
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message.slice(0, 200), ms: Date.now() - t }, { status: 503 });
  }
}
