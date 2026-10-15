// Index and derived-edge Cypher for the brain graph. Every statement here is listed in docs/CYPHER.md.

export const INDEXES = [
  "CREATE INDEX FOR (e:Entity) ON (e.key)",
  "CREATE INDEX FOR (c:Chunk) ON (c.key)",
  "CREATE INDEX FOR (p:Person) ON (p.login)",
  "CREATE INDEX FOR (t:Thread) ON (t.number, t.createdAt, t.state)",
  "CREATE INDEX FOR (d:Directory) ON (d.path)",
  "CREATE INDEX FOR (f:File) ON (f.path)",
  "CALL db.idx.fulltext.createNodeIndex('Entity', 'title', 'name', 'path', 'login', 'tag')",
  "CREATE VECTOR INDEX FOR (c:Chunk) ON (c.embedding) OPTIONS {dimension:256, similarityFunction:'cosine'}",
];

/** Derived edges, recomputed after a load and by the daily sync. Order matters. */
export const DERIVED: { name: string; cypher: string }[] = [
  {
    name: "KNOWS (authored)",
    cypher: `MATCH (p:Person)-[:AUTHORED]->(pr:PullRequest)-[:TOUCHED]->(:File)-[:IN_DIR*1..6]->(d:Directory)
WHERE p.isBot = false AND pr.mergedAt IS NOT NULL
WITH p, d, count(DISTINCT pr) AS authored, max(pr.mergedAt) AS last
MERGE (p)-[k:KNOWS]->(d)
SET k.authored = authored, k.authoredLastAt = last`,
  },
  {
    name: "KNOWS (reviewed)",
    cypher: `MATCH (p:Person)-[rv:REVIEWED]->(pr:PullRequest)-[:TOUCHED]->(:File)-[:IN_DIR*1..6]->(d:Directory)
WHERE p.isBot = false
WITH p, d, count(DISTINCT pr) AS reviewed, max(rv.at) AS last
MERGE (p)-[k:KNOWS]->(d)
SET k.reviewed = reviewed, k.reviewedLastAt = last`,
  },
  {
    name: "KNOWS (lastAt)",
    cypher: `MATCH (:Person)-[k:KNOWS]->(:Directory)
SET k.authored = coalesce(k.authored, 0), k.reviewed = coalesce(k.reviewed, 0),
    k.lastAt = CASE WHEN coalesce(k.authoredLastAt, 0) >= coalesce(k.reviewedLastAt, 0) THEN k.authoredLastAt ELSE k.reviewedLastAt END`,
  },
  {
    name: "REVIEWS_FOR",
    cypher: `MATCH (r:Person)-[rv:REVIEWED]->(pr:PullRequest)<-[:AUTHORED]-(a:Person)
WHERE r.isBot = false AND a.isBot = false AND id(r) <> id(a)
WITH r, a, count(rv) AS n
MERGE (r)-[e:REVIEWS_FOR]->(a)
SET e.count = n`,
  },
  {
    name: "CONTRIBUTES_TO (authored)",
    cypher: `MATCH (p:Person)-[:AUTHORED]->(t:Thread)-[:IN_REPO]->(r:Repo)
WHERE p.isBot = false
WITH p, r, sum(CASE WHEN t:PullRequest THEN 1 ELSE 0 END) AS prs, sum(CASE WHEN t:Issue THEN 1 ELSE 0 END) AS issues
MERGE (p)-[c:CONTRIBUTES_TO]->(r)
SET c.prs = prs, c.issues = issues`,
  },
  {
    name: "CONTRIBUTES_TO (reviews)",
    cypher: `MATCH (p:Person)-[rv:REVIEWED]->(:PullRequest)-[:IN_REPO]->(r:Repo)
WHERE p.isBot = false
WITH p, r, count(rv) AS n
MERGE (p)-[c:CONTRIBUTES_TO]->(r)
SET c.reviews = n, c.prs = coalesce(c.prs, 0), c.issues = coalesce(c.issues, 0)`,
  },
  {
    name: "CO_CHANGES",
    cypher: `MATCH (pr:PullRequest)-[:TOUCHED]->(:File)-[:IN_DIR]->(d:Directory)
WITH pr, collect(DISTINCT d) AS ds
WHERE size(ds) > 1 AND size(ds) <= 25
UNWIND ds AS d1
UNWIND ds AS d2
WITH d1, d2, pr WHERE id(d1) < id(d2)
WITH d1, d2, count(DISTINCT pr) AS n WHERE n >= 3
MERGE (d1)-[c:CO_CHANGES]->(d2)
SET c.count = n`,
  },
];
