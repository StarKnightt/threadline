import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example)`);
  return v;
}

export const ORG = process.env.TL_ORG ?? "FalkorDB";
export const REPOS = (process.env.TL_REPOS ??
  "FalkorDB,falkordb-browser,QueryWeaver,GraphRAG-SDK,falkordb-ts,FalkorDB-MCPServer")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
export const DOCS_REPO = process.env.TL_DOCS_REPO ?? "docs";
