import "server-only";
import { createHash } from "node:crypto";
import { SHARED, query } from "./falkor";

const memo = new Map<string, number[]>();

/**
 * Question embedding (text-embedding-3-small, 256 dims). Cached in memory and in the shared FalkorDB graph,
 * so a repeated question never pays OpenAI twice, even across cold starts.
 */
export async function embedQuestion(text: string): Promise<number[]> {
  const norm = text.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 2000);
  const h = createHash("sha1").update(norm).digest("hex").slice(0, 20);
  const hit = memo.get(h);
  if (hit) return hit;
  try {
    const { rows } = await query<{ e: number[] }>(SHARED, "MATCH (q:QueryEmbedding {h: $h}) RETURN q.e AS e", { h });
    if (rows[0]?.e?.length) {
      memo.set(h, rows[0].e);
      return rows[0].e;
    }
  } catch {
    /* shared graph may not exist yet */
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: norm, dimensions: 256 }),
  });
  if (!res.ok) throw new Error(`embedding failed: ${res.status}`);
  const json = (await res.json()) as { data: { embedding: number[] }[]; usage: { total_tokens: number } };
  const e = json.data[0].embedding.map((x) => Math.round(x * 1e5) / 1e5);
  memo.set(h, e);
  query(SHARED, "MERGE (q:QueryEmbedding {h: $h}) SET q.e = $e, q.at = timestamp() WITH q MERGE (s:Spend {key: 'openai'}) SET s.tokens = coalesce(s.tokens, 0) + $t", { h, e, t: json.usage.total_tokens }).catch(() => {});
  return e;
}
