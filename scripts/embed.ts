// Embed every Chunk in data/graph/rows.json with OpenAI text-embedding-3-small at 256 dims.
// Cached by content hash in data/cache/embeddings.jsonl, so reruns only pay for new text.
// Spend is tracked in data/cache/openai-spend.json. Usage: pnpm ingest:embed
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { need } from "./lib/env";

const KEY = need("OPENAI_API_KEY");
const MODEL = "text-embedding-3-small";
const DIMS = 256;
const PRICE_PER_M = 0.02; // USD per 1M input tokens, OpenAI list price for text-embedding-3-small
const CACHE = "data/cache/embeddings.jsonl";
const SPEND = "data/cache/openai-spend.json";
const MAX_USD = Number(process.env.TL_EMBED_MAX_USD ?? 0.5);

export const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 20);

export function loadCache(): Map<string, number[]> {
  const m = new Map<string, number[]>();
  if (!existsSync(CACHE)) return m;
  for (const l of readFileSync(CACHE, "utf8").split("\n")) {
    if (!l) continue;
    const { h, e } = JSON.parse(l);
    m.set(h, e);
  }
  return m;
}

function spend() {
  return existsSync(SPEND) ? JSON.parse(readFileSync(SPEND, "utf8")) : { tokens: 0, usd: 0, calls: 0 };
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const s = spend();
  if (s.usd > MAX_USD) throw new Error(`Embedding spend guard: $${s.usd.toFixed(4)} > $${MAX_USD}`);
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts, dimensions: DIMS }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data: { embedding: number[] }[]; usage: { total_tokens: number } };
  s.tokens += json.usage.total_tokens;
  s.calls += 1;
  s.usd = (s.tokens / 1e6) * PRICE_PER_M;
  writeFileSync(SPEND, JSON.stringify(s, null, 2));
  return json.data.map((d) => d.embedding.map((x) => Math.round(x * 1e5) / 1e5));
}

async function main() {
  mkdirSync("data/cache", { recursive: true });
  const rows = JSON.parse(readFileSync("data/graph/rows.json", "utf8"));
  const cache = loadCache();
  const todo = new Map<string, string>();
  for (const n of rows.nodes) {
    if (n.labels !== "Chunk") continue;
    const text = (n.props.embedText as string).slice(0, 4000);
    const h = hash(text);
    if (!cache.has(h)) todo.set(h, text);
  }
  console.log(`chunks needing embeddings: ${todo.size} (cached: ${cache.size})`);
  const entries = [...todo.entries()];
  for (let i = 0; i < entries.length; i += 200) {
    const batch = entries.slice(i, i + 200);
    const vecs = await embedBatch(batch.map(([, t]) => t));
    appendFileSync(CACHE, batch.map(([h], j) => JSON.stringify({ h, e: vecs[j] })).join("\n") + "\n");
    process.stdout.write(`\r  ${Math.min(i + 200, entries.length)}/${entries.length}  spent $${spend().usd.toFixed(4)}   `);
  }
  console.log(`\ndone. total embedding spend so far: $${spend().usd.toFixed(4)} (${spend().tokens} tokens)`);
}

if (process.argv[1]?.includes("embed")) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
