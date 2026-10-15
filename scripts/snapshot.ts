// Snapshot and seed. `pnpm snapshot` gzips data/graph/rows.json and the embedding cache into data/snapshot/.
// `pnpm seed [tag]` downloads them from the GitHub release and restores them, then run `pnpm ingest:load --reset`.
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const FILES = [
  ["data/graph/rows.json", "rows.json.gz"],
  ["data/cache/embeddings.jsonl", "embeddings.jsonl.gz"],
] as const;
const REPO = "StarKnightt/threadline";

async function snapshot() {
  mkdirSync("data/snapshot", { recursive: true });
  for (const [src, name] of FILES) {
    await pipeline(createReadStream(src), createGzip({ level: 9 }), createWriteStream(`data/snapshot/${name}`));
    console.log(`wrote data/snapshot/${name}`);
  }
}

async function seed(tag: string) {
  for (const [dest, name] of FILES) {
    const url = `https://github.com/${REPO}/releases/download/${tag}/${name}`;
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`${url}: ${res.status}`);
    mkdirSync(dest.split("/").slice(0, -1).join("/"), { recursive: true });
    await pipeline(Readable.fromWeb(res.body as never), createGunzip(), createWriteStream(dest));
    console.log(`restored ${dest}`);
  }
  console.log("now run: pnpm ingest:load --reset && pnpm layout");
}

const [cmd, tag] = process.argv.slice(2);
if (cmd === "seed") seed(tag ?? "snapshot-2026-10-15");
else if (existsSync(FILES[0][0])) snapshot();
else console.error("run pnpm ingest:normalise first");
