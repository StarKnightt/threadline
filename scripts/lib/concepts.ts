// Fixed concept dictionary for the FalkorDB domain. Matching is deterministic (no LLM):
// a thread, doc or chunk MENTIONS a concept when any alias pattern matches its text.
export type ConceptDef = { id: string; name: string; aliases: string[] };

export const CONCEPTS: ConceptDef[] = [
  { id: "vector-index", name: "vector index", aliases: ["vector index", "vector search", "vecf32", "db.idx.vector", "hnsw", "vector similarity"] },
  { id: "fulltext-index", name: "full-text index", aliases: ["full-text", "fulltext", "db.idx.fulltext", "redisearch"] },
  { id: "range-index", name: "range index", aliases: ["range index", "create index", "exact-match index"] },
  { id: "pagerank", name: "PageRank", aliases: ["pagerank", "algo.pagerank", "page rank"] },
  { id: "betweenness", name: "betweenness centrality", aliases: ["betweenness", "algo.betweenness"] },
  { id: "bfs", name: "breadth-first search", aliases: ["algo.bfs", "breadth-first", "bfs"] },
  { id: "shortest-path", name: "shortest path", aliases: ["shortestpath", "shortest path", "allshortestpaths", "algo.sppaths", "algo.sspaths"] },
  { id: "community-detection", name: "community detection", aliases: ["label propagation", "labelpropagation", "cdlp", "algo.wcc", "connected components", "louvain"] },
  { id: "udf", name: "user-defined functions", aliases: ["udf", "user defined function", "user-defined function", "graph.udf"] },
  { id: "memory-usage", name: "memory usage", aliases: ["memory usage", "graph.memory", "out of memory", "oom", "memory leak", "memory consumption"] },
  { id: "replication", name: "replication", aliases: ["replication", "replica", "replicaof"] },
  { id: "persistence", name: "persistence", aliases: ["persistence", "rdb", "aof", "bgsave", "snapshot load"] },
  { id: "cluster", name: "cluster mode", aliases: ["cluster mode", "redis cluster", "sentinel", "sharding"] },
  { id: "acl", name: "access control", aliases: ["acl", "access control", "graph.acl", "permissions", "read-only user"] },
  { id: "ro-query", name: "GRAPH.RO_QUERY", aliases: ["ro_query", "read-only query", "graph.ro_query"] },
  { id: "explain-profile", name: "query plans", aliases: ["graph.explain", "graph.profile", "execution plan", "query plan"] },
  { id: "config", name: "configuration", aliases: ["graph.config", "configuration parameter", "thread_count", "cache_size", "query_mem_capacity", "timeout_default", "timeout_max"] },
  { id: "timeout", name: "query timeout", aliases: ["timeout"] },
  { id: "merge", name: "MERGE clause", aliases: ["merge clause", "on create set", "on match set"] },
  { id: "unwind", name: "UNWIND clause", aliases: ["unwind"] },
  { id: "optional-match", name: "OPTIONAL MATCH", aliases: ["optional match"] },
  { id: "call-procedure", name: "procedures", aliases: ["call db.", "procedure", "db.labels", "db.relationshiptypes"] },
  { id: "bulk-loader", name: "bulk loading", aliases: ["bulk insert", "bulk loader", "falkordb-bulk-loader", "graph.bulk", "bulk import"] },
  { id: "constraints", name: "constraints", aliases: ["constraint", "unique constraint", "graph.constraint"] },
  { id: "temporal", name: "temporal types", aliases: ["datetime", "localdatetime", "duration", "temporal", "date()"] },
  { id: "point", name: "geospatial points", aliases: ["point(", "geospatial", "distance("] },
  { id: "parser", name: "Cypher parser", aliases: ["parser", "syntax error", "libcypher-parser", "parse error"] },
  { id: "crash", name: "crashes", aliases: ["crash", "segfault", "segmentation fault", "sigsegv", "panic", "assertion failed"] },
  { id: "performance", name: "performance", aliases: ["performance", "slow query", "latency", "throughput", "benchmark"] },
  { id: "docker", name: "Docker", aliases: ["docker", "docker-compose", "container image"] },
  { id: "kubernetes", name: "Kubernetes", aliases: ["kubernetes", "k8s", "helm"] },
  { id: "rust", name: "Rust core", aliases: ["rust", "cargo"] },
  { id: "graphblas", name: "GraphBLAS", aliases: ["graphblas", "suitesparse"] },
  { id: "browser-canvas", name: "graph canvas", aliases: ["canvas", "force graph", "graph visualization", "graph visualisation"] },
  { id: "schema", name: "schema", aliases: ["schema", "ontology"] },
  { id: "text-to-cypher", name: "text to Cypher", aliases: ["text-to-cypher", "text to cypher", "text2cypher", "nl2cypher", "natural language to cypher"] },
  { id: "graphrag", name: "GraphRAG", aliases: ["graphrag", "graph rag", "knowledge graph rag"] },
  { id: "mcp", name: "Model Context Protocol", aliases: ["mcp", "model context protocol"] },
  { id: "langchain", name: "LangChain", aliases: ["langchain", "langgraph"] },
  { id: "llamaindex", name: "LlamaIndex", aliases: ["llamaindex", "llama-index", "llama index"] },
  { id: "embeddings", name: "embeddings", aliases: ["embedding", "embeddings"] },
  { id: "llm-provider", name: "LLM providers", aliases: ["openai", "litellm", "azure openai", "gemini", "ollama", "anthropic", "groq"] },
  { id: "authentication", name: "authentication", aliases: ["authentication", "login", "password", "oauth", "auth "] },
  { id: "tls", name: "TLS", aliases: ["tls", "ssl"] },
  { id: "connection", name: "client connections", aliases: ["connection pool", "connection refused", "reconnect", "socket"] },
  { id: "typescript-client", name: "TypeScript client", aliases: ["falkordb-ts", "node client", "typescript client", "npm package"] },
  { id: "python-client", name: "Python client", aliases: ["falkordb-py", "python client", "pip install falkordb"] },
  { id: "multi-graph", name: "multi-graph tenancy", aliases: ["multi-graph", "multiple graphs", "multi-tenant", "multitenancy", "graph.list"] },
  { id: "export-import", name: "import and export", aliases: ["export", "import csv", "load csv", "dump"] },
  { id: "ci", name: "CI pipeline", aliases: ["github actions", "workflow", "ci pipeline", "ci:"] },
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MATCHERS = CONCEPTS.map((c) => ({
  id: c.id,
  re: new RegExp(c.aliases.map((a) => (/^[a-z0-9]/i.test(a) ? `\\b${escape(a)}` : escape(a))).join("|"), "i"),
}));

export function conceptsIn(text: string): string[] {
  if (!text) return [];
  return MATCHERS.filter((m) => m.re.test(text)).map((m) => m.id);
}
