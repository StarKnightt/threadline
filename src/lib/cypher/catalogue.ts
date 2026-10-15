// The Cypher the agent tools run. Each entry is documented in docs/CYPHER.md under the same id.
// All user-supplied values are passed as parameters; nothing is string-concatenated into Cypher.

export const NAME = "coalesce(n.title, n.name, n.tag, n.login, n.path, n.key)";

export const Q = {
  /** Q1: entry points by meaning. Vector search over chunks, mapped back to the thread or doc they belong to. */
  vectorEntry: `CALL db.idx.vector.queryNodes('Chunk', 'embedding', $k, vecf32($vec)) YIELD node, score
MATCH (node)-[:PART_OF]->(n:Entity)
RETURN n.key AS key, labels(n) AS labels, ${NAME} AS name, n.repo AS repo, max(score) AS score
ORDER BY score DESC LIMIT $limit`,

  /** Q2: entry points by name. Full-text index over titles, names, paths, logins and tags. */
  fulltextEntry: `CALL db.idx.fulltext.queryNodes('Entity', $text) YIELD node, score
WITH node AS n, score WHERE NOT n:Label
RETURN n.key AS key, labels(n) AS labels, ${NAME} AS name, n.repo AS repo, score
ORDER BY score DESC LIMIT $limit`,

  /** Exact lookup by key (used when the question names an issue, PR, person or file directly). */
  byKeys: `MATCH (n:Entity) WHERE n.key IN $keys
RETURN n.key AS key, labels(n) AS labels, ${NAME} AS name, n.repo AS repo`,

  /** Thread by repo and number, for "#123" style mentions. */
  threadByNumber: `MATCH (n:Thread {number: $number})-[:IN_REPO]->(r:Repo)
WHERE $repo IS NULL OR toLower(r.name) = toLower($repo)
RETURN n.key AS key, labels(n) AS labels, n.title AS name, r.fullName AS repo, n.state AS state`,

  /** Concepts by name or alias. */
  conceptMatch: `MATCH (n:Concept)
WHERE toLower(n.name) CONTAINS toLower($text) OR toLower(n.aliases) CONTAINS toLower($text)
RETURN n.key AS key, labels(n) AS labels, n.name AS name, null AS repo LIMIT 3`,

  /** Details of one node plus its immediate, typed neighbourhood counts. */
  details: `MATCH (n:Entity {key: $key})
OPTIONAL MATCH (n)-[r]-(m:Entity)
WITH n, type(r) AS rel, count(m) AS c
RETURN n.key AS key, labels(n) AS labels, properties(n) AS props, collect({rel: rel, count: c}) AS degree`,

  /** One hop out from a node, optionally restricted to relationship types, newest first. */
  expand: `MATCH (s:Entity {key: $key})-[r]-(n:Entity)
WHERE (size($types) = 0 OR type(r) IN $types) AND coalesce(n.isBot, false) = false
RETURN type(r) AS rel, id(startNode(r)) = id(s) AS outgoing, n.key AS key, labels(n) AS labels, ${NAME} AS name,
       coalesce(n.mergedAt, n.createdAt, n.publishedAt, n.lastSeenAt, 0) AS at
ORDER BY at DESC LIMIT $limit`,

  /** Q4a: who knows a directory or file area, from derived KNOWS edges with recency decay (half-life about 4 months). */
  whoKnowsArea: `MATCH (d:Directory)
WHERE d.depth > 0 AND NOT d.path STARTS WITH '.' AND toLower(d.path) CONTAINS toLower($term) AND ($repo IS NULL OR toLower(d.repo) ENDS WITH toLower($repo))
WITH d ORDER BY d.depth ASC LIMIT 4
MATCH (p:Person)-[k:KNOWS]->(d)
WITH p, d, k, (2 * k.authored + k.reviewed) AS weight, ($now - k.lastAt) / 86400.0 AS ageDays
RETURN p.key AS key, p.login AS person, d.key AS area, d.path AS path, k.authored AS authored, k.reviewed AS reviewed,
       toInteger(ageDays) AS daysSinceLast, weight * exp(-ageDays / 180.0) AS score
ORDER BY score DESC LIMIT 10`,

  /** Q4b: who knows a concept, by walking concept <- mentioning merged PRs <- authors and reviewers. */
  whoKnowsConcept: `MATCH (c:Concept {key: $concept})<-[:MENTIONS]-(pr:PullRequest)
WHERE pr.mergedAt IS NOT NULL AND ($repo IS NULL OR toLower(pr.repo) ENDS WITH toLower($repo))
MATCH (p:Person)-[r:AUTHORED|REVIEWED]->(pr)
WHERE p.isBot = false
WITH p, c, count(DISTINCT pr) AS prs, sum(CASE WHEN type(r) = 'AUTHORED' THEN 2 ELSE 1 END) AS weight,
     max(pr.mergedAt) AS last, collect(DISTINCT pr.key)[0..3] AS sample
RETURN p.key AS key, p.login AS person, c.key AS area, prs, toInteger(($now - last) / 86400) AS daysSinceLast,
       weight * exp(-(($now - last) / 86400.0) / 180.0) AS score, sample
ORDER BY score DESC LIMIT 10`,

  /** Declared versus actual: CODEOWNERS entries for the matched areas. */
  declaredOwners: `MATCH (p:Person)-[o:DECLARED_OWNER]->(x:Entity) WHERE x.key IN $areas
RETURN p.key AS key, p.login AS person, x.key AS area, o.pattern AS pattern`,

  /** Q5: decision trace for an issue: the PRs that closed it, who wrote and reviewed them, and the release that shipped them. */
  traceIssue: `MATCH (i:Issue {key: $key})
OPTIONAL MATCH (fix:PullRequest)-[c:CLOSES]->(i)
OPTIONAL MATCH (fix)-[:SHIPPED_IN]->(rel:Release)
OPTIONAL MATCH (author:Person)-[:AUTHORED]->(fix)
OPTIONAL MATCH (opener:Person)-[:AUTHORED]->(i)
RETURN i.key AS issue, i.title AS title, i.state AS state, opener.login AS openedBy,
       fix.key AS fix, fix.title AS fixTitle, fix.mergedAt AS mergedAt, c.source AS linkSource,
       author.login AS fixAuthor, rel.key AS release, rel.tag AS tag, rel.publishedAt AS releasedAt`,

  /** Q5 (PR variant): what a PR closed, who reviewed it, and where it shipped. */
  tracePr: `MATCH (pr:PullRequest {key: $key})
OPTIONAL MATCH (pr)-[c:CLOSES]->(i:Issue)
OPTIONAL MATCH (pr)-[s:SHIPPED_IN]->(rel:Release)
OPTIONAL MATCH (author:Person)-[:AUTHORED]->(pr)
OPTIONAL MATCH (rv:Person)-[r:REVIEWED]->(pr)
RETURN pr.key AS pr, pr.title AS title, pr.state AS state, pr.mergedAt AS mergedAt, author.login AS author,
       collect(DISTINCT i.key) AS closes, collect(DISTINCT rel.key) AS releases, collect(DISTINCT rel.tag) AS tags,
       collect(DISTINCT s.source) AS shipSource, collect(DISTINCT {login: rv.login, state: r.state}) AS reviewers`,

  /** Threads that reference, or are referenced by, a thread (cross-repo flag included). */
  references: `MATCH (t:Thread {key: $key})-[r:REFERENCES|CLOSES]-(o:Thread)
RETURN type(r) AS rel, id(startNode(r)) = id(t) AS outgoing, o.key AS key, o.title AS name, o.repo AS repo, o.state AS state,
       coalesce(r.crossRepo, o.repo <> t.repo) AS crossRepo
ORDER BY crossRepo DESC LIMIT 25`,

  /** Q6: how two entities are connected. Shortest paths over work relationships (hub edges such as IN_REPO excluded). */
  connect: `MATCH (a:Entity {key: $a}), (b:Entity {key: $b})
WITH a, b
MATCH p = allShortestPaths((a)-[:REFERENCES|CLOSES|AUTHORED|REVIEWED|TOUCHED|SHIPPED_IN|COMMENTED_ON|MENTIONS*..6]-(b))
RETURN [n IN nodes(p) | n.key] AS keys, [r IN relationships(p) | type(r)] AS rels
LIMIT 3`,

  /** Q7a: impact. Open PRs touching files under an area. */
  impactOpenPrs: `MATCH (d:Directory)
WHERE d.depth > 0 AND NOT d.path STARTS WITH '.' AND toLower(d.path) CONTAINS toLower($term) AND ($repo IS NULL OR toLower(d.repo) ENDS WITH toLower($repo))
WITH d ORDER BY d.depth ASC LIMIT 3
MATCH (d)<-[:IN_DIR*1..6]-(f:File)<-[t:TOUCHED]-(pr:PullRequest)
WHERE pr.state = 'OPEN'
RETURN pr.key AS key, pr.title AS name, d.path AS area, count(DISTINCT f) AS files, pr.createdAt AS createdAt
ORDER BY files DESC LIMIT 15`,

  /** Q7b: impact. Open issues connected to past fixes in the area (fixed by a PR that touched it, then referenced again). */
  impactOpenIssues: `MATCH (d:Directory)
WHERE d.depth > 0 AND NOT d.path STARTS WITH '.' AND toLower(d.path) CONTAINS toLower($term) AND ($repo IS NULL OR toLower(d.repo) ENDS WITH toLower($repo))
WITH d ORDER BY d.depth ASC LIMIT 3
MATCH (d)<-[:IN_DIR*1..6]-(:File)<-[:TOUCHED]-(pr:PullRequest)-[:CLOSES|REFERENCES]-(i:Issue)
WHERE i.state = 'OPEN'
RETURN i.key AS key, i.title AS name, d.path AS area, count(DISTINCT pr) AS viaPrs
ORDER BY viaPrs DESC LIMIT 10`,

  /** Q7c: impact. Directories that usually change together with the area (derived CO_CHANGES). */
  coChanges: `MATCH (d:Directory)
WHERE d.depth > 0 AND NOT d.path STARTS WITH '.' AND toLower(d.path) CONTAINS toLower($term) AND ($repo IS NULL OR toLower(d.repo) ENDS WITH toLower($repo))
WITH d ORDER BY d.depth ASC LIMIT 3
MATCH (d)-[c:CO_CHANGES]-(o:Directory)
RETURN o.key AS key, o.path AS name, o.repo AS repo, c.count AS together
ORDER BY together DESC LIMIT 8`,

  /** Activity aggregation: who authored, reviewed, merged or commented most, optionally per repo, area and time window. */
  activity: {
    AUTHORED: `MATCH (p:Person)-[e:AUTHORED]->(t:Thread)-[:IN_REPO]->(r:Repo)
WHERE p.isBot = false AND ($repo IS NULL OR toLower(r.name) = toLower($repo)) AND t.createdAt >= $since AND t.createdAt < $until
  AND ($kind IS NULL OR ($kind = 'pr' AND t:PullRequest) OR ($kind = 'issue' AND t:Issue))
RETURN p.key AS key, p.login AS person, count(DISTINCT t) AS n, collect(t.key)[0..3] AS sample
ORDER BY n DESC LIMIT $limit`,
    REVIEWED: `MATCH (p:Person)-[e:REVIEWED]->(t:PullRequest)-[:IN_REPO]->(r:Repo)
WHERE p.isBot = false AND ($repo IS NULL OR toLower(r.name) = toLower($repo)) AND t.createdAt >= $since AND t.createdAt < $until
RETURN p.key AS key, p.login AS person, count(DISTINCT t) AS n, collect(t.key)[0..3] AS sample
ORDER BY n DESC LIMIT $limit`,
    MERGED: `MATCH (p:Person)-[e:MERGED]->(t:PullRequest)-[:IN_REPO]->(r:Repo)
WHERE p.isBot = false AND ($repo IS NULL OR toLower(r.name) = toLower($repo)) AND t.mergedAt >= $since AND t.mergedAt < $until
RETURN p.key AS key, p.login AS person, count(DISTINCT t) AS n, collect(t.key)[0..3] AS sample
ORDER BY n DESC LIMIT $limit`,
    COMMENTED_ON: `MATCH (p:Person)-[e:COMMENTED_ON]->(t:Thread)-[:IN_REPO]->(r:Repo)
WHERE p.isBot = false AND ($repo IS NULL OR toLower(r.name) = toLower($repo)) AND t.createdAt >= $since AND t.createdAt < $until
RETURN p.key AS key, p.login AS person, sum(e.count) AS n, collect(t.key)[0..3] AS sample
ORDER BY n DESC LIMIT $limit`,
  },

  /** Q8: key reviewers. PageRank over the derived who-reviews-whom graph. */
  pageRankReviewers: `CALL algo.pageRank('Person', 'REVIEWS_FOR') YIELD node, score
WHERE node.isBot = false
RETURN node.key AS key, node.login AS person, score
ORDER BY score DESC LIMIT 10`,

  /** Q9: bridges between repos. Betweenness centrality over people and the repos they contribute to. */
  betweennessBridges: `CALL algo.betweenness({nodeLabels: ['Person', 'Repo'], relationshipTypes: ['CONTRIBUTES_TO', 'HAS_CONTRIBUTOR']}) YIELD node, score
WITH node, score WHERE node:Person
MATCH (node)-[c:CONTRIBUTES_TO]->(r:Repo)
RETURN node.key AS key, node.login AS person, score, collect(r.name) AS repos
ORDER BY score DESC LIMIT 10`,

  /** Q10: discovered subsystems. Label propagation over directories that change together. */
  subsystems: `CALL algo.labelPropagation({nodeLabels: ['Directory'], relationshipTypes: ['CO_CHANGES']}) YIELD node, communityId
WITH communityId, collect(node) AS dirs
WHERE size(dirs) >= 2
RETURN communityId, [d IN dirs | d.key][0..8] AS keys, [d IN dirs | d.repo + ':' + d.path][0..8] AS paths, size(dirs) AS size
ORDER BY size DESC LIMIT 8`,

  /** Q12: verifier. Is the cited node reachable from the entry node within 4 hops (any direction)? */
  // shortestPath() is directed-only in FalkorDB and must sit in WITH/RETURN; allShortestPaths() in MATCH handles undirected.
  verifyPath: `MATCH (a:Entity {key: $entry}), (b:Entity {key: $cited})
WITH a, b
MATCH p = allShortestPaths((a)-[:AUTHORED|REVIEWED|MERGED|COMMENTED_ON|ASSIGNED_TO|TOUCHED|IN_DIR|CLOSES|REFERENCES|SHIPPED_IN|MENTIONS|DOCUMENTS|KNOWS|REVIEWS_FOR|CO_CHANGES|DECLARED_OWNER*..4]-(b))
RETURN length(p) AS hops, [n IN nodes(p) | n.key] AS keys, [r IN relationships(p) | type(r)] AS rels
LIMIT 1`,

  /** Neighbourhood for the 3D viewer (two hops, capped). */
  neighbourhood: `MATCH (s:Entity {key: $key})-[r1]-(n1:Entity)
WITH s, r1, n1 LIMIT 40
OPTIONAL MATCH (n1)-[r2]-(n2:Entity) WHERE n2 <> s
WITH s, r1, n1, collect({r: type(r2), k: n2.key, out: id(startNode(r2)) = id(n1)})[0..4] AS hop2
RETURN n1.key AS key, type(r1) AS rel, id(startNode(r1)) = id(s) AS outgoing, hop2`,

  /** Vector RAG baseline (same index, no graph traversal): top chunks with their text. */
  vectorRag: `CALL db.idx.vector.queryNodes('Chunk', 'embedding', $k, vecf32($vec)) YIELD node, score
MATCH (node)-[:PART_OF]->(n:Entity)
RETURN node.key AS chunk, node.text AS text, n.key AS key, ${NAME} AS name, score
ORDER BY score DESC`,
} as const;
