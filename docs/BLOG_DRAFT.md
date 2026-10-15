---
title: "Building a company brain that shows its work: multi-hop GraphRAG on FalkorDB, with the agent's path in 3D"
published: false
tags: graphrag, falkordb, ai, webdev
---

> Draft for DEV (account `starknight`). The results section is generated from `eval/summary.json` by `pnpm eval:docs`; remove these comment markers and this note before publishing. Cover image: `shots/02-split-graph-vs-vector.png`. Replace `[link]` with the video URL.

Some questions about a software company are not about any single document. "Who should review a change to the vector index code?" "Which pull request fixed this issue, and which release shipped it?" "What breaks if we change this directory?" The answer lives in how people, pull requests, files and releases connect.

For [WeMakeDevs Graph Hacks](https://www.wemakedevs.org/hackathons/falkordb) I built **Threadline**, a company brain for an open-source company, on FalkorDB. It answers those questions by walking a graph, shows every hop in 3D with the Cypher it ran, and checks its own citations against the graph before it calls an answer verified.

Live demo: https://threadline-graph.vercel.app · Code: https://github.com/StarKnightt/threadline · Video: [link]

## Choosing the data: an open-source org as a company

I used the public GitHub history of the FalkorDB organisation: the core database, the browser, QueryWeaver, GraphRAG-SDK, the TypeScript client, the MCP server and the docs. It is public, it has real structure (reviews, closing references, releases, cross-repository mentions), and anyone can check the answers.

Two constraints shaped the scope:

- **Privacy.** People are stored by GitHub login and avatar only. No names, emails or locations. Bots are flagged and kept out of expertise rankings.
- **The free tier's 100 MB.** FalkorDB Cloud's free instance holds about 100 MB in memory. I kept items updated since January 2023 and used 256-dimension embeddings. The final graph has about 27,000 nodes and 136,000 relationships, and `GRAPH.MEMORY USAGE` reports 41 MB, of which text chunks with their vectors take 19 MB.

## The graph model

Every brain node carries an `:Entity` label and a unique `key` such as `pr:FalkorDB/FalkorDB#1461` or `person:swilly22`. One index on `Entity.key` lets any tool address any node, and the keys double as citations in answers.

The core relationships come straight from GitHub: `AUTHORED`, `REVIEWED`, `MERGED`, `COMMENTED_ON`, `TOUCHED` (PR to file), `IN_DIR` (file to directory to parent), `CLOSES`, `REFERENCES` (with a `crossRepo` flag), `SHIPPED_IN` and `MENTIONS` (to a fixed dictionary of concepts such as `vector-index` or `pagerank`, matched without an LLM).

The interesting part is the derived edges, computed in Cypher after each load and by a daily sync:

```cypher
MATCH (p:Person)-[:AUTHORED]->(pr:PullRequest)-[:TOUCHED]->(:File)-[:IN_DIR*1..6]->(d:Directory)
WHERE p.isBot = false AND pr.mergedAt IS NOT NULL
WITH p, d, count(DISTINCT pr) AS authored, max(pr.mergedAt) AS last
MERGE (p)-[k:KNOWS]->(d)
SET k.authored = authored, k.authoredLastAt = last
```

`KNOWS` turns thousands of file touches into one weighted edge per person and directory. `REVIEWS_FOR` (reviewer to author) feeds PageRank, `CO_CHANGES` (directories changed by the same PRs) feeds label propagation, and `CONTRIBUTES_TO` feeds betweenness.

## The Cypher that does the work

**Who knows an area, now.** Expertise decays: someone who touched the index code three years ago is a weaker answer than someone who reviewed it last week.

```cypher
MATCH (p:Person)-[k:KNOWS]->(d:Directory)
WITH p, d, k, (2 * k.authored + k.reviewed) AS weight, ($now - k.lastAt) / 86400.0 AS ageDays
RETURN p.login, k.authored, k.reviewed, weight * exp(-ageDays / 180.0) AS score
ORDER BY score DESC LIMIT 10
```

**Decision trace.** From an issue to the PR that closed it, to the release that shipped it:

```cypher
MATCH (i:Issue {key: $key})
OPTIONAL MATCH (fix:PullRequest)-[c:CLOSES]->(i)
OPTIONAL MATCH (fix)-[:SHIPPED_IN]->(rel:Release)
OPTIONAL MATCH (author:Person)-[:AUTHORED]->(fix)
RETURN i.title, fix.key, author.login, rel.tag, c.source
```

**Impact.** A variable-length walk down the directory tree to open pull requests:

```cypher
MATCH (d)<-[:IN_DIR*1..6]-(f:File)<-[:TOUCHED]-(pr:PullRequest)
WHERE pr.state = 'OPEN'
RETURN pr.key, pr.title, count(DISTINCT f) AS files ORDER BY files DESC
```

**Graph algorithms as tools.** `algo.pageRank('Person', 'REVIEWS_FOR')` finds key reviewers; `algo.betweenness` over people and repositories finds who bridges teams; `algo.labelPropagation` over `CO_CHANGES` finds the real subsystems.

### Three FalkorDB details I learned the hard way

1. **`shortestPath()` lives in `WITH` or `RETURN`, and it is directed only.** My first verifier query put it in `MATCH` and failed; moving it to `WITH` then failed on the undirected pattern. `allShortestPaths()` in `MATCH` accepts undirected patterns, so the verifier uses that.
2. **Betweenness follows edge direction.** People only point at repositories, so no shortest path ran through a person and every score was zero. A derived reverse edge fixed it.
3. **Vector `score` is a distance.** `db.idx.vector.queryNodes` yields cosine distance, lower is closer. I had sorted it descending, so entity resolution quietly took the farthest of the nearest neighbours. A title-only query exposed it: the right chunk came back first with a "score" of 0.18 while worse matches scored 0.36. Every vector query now reports `1 - score` as similarity.

I run every catalogue query against the live instance with `pnpm verify:cypher`; most return in 65 to 160 ms including the network round trip from India to the Mumbai region.

## Typed tools first, free-form Cypher last

The agent (Groq-hosted gpt-oss-120b through the Vercel AI SDK) gets typed tools: `find_entities`, `who_knows`, `trace`, `connect`, `impact`, `activity`, `rank`, `expand`, `details`, `draft_triage`, and finally `cypher_readonly` for questions nothing else fits. The free-form tool runs with `GRAPH.RO_QUERY` as a separate read-only database user (FalkorDB Cloud's "Read" role), rejects write clauses and enforces a `LIMIT`. I checked both guards: `GRAPH.RO_QUERY` refuses writes, and the read-only user cannot call `GRAPH.QUERY` at all.

Each tool returns rows plus the node keys it touched, the edges it traversed and its Cypher. Those stream to the browser over server-sent events and drive the 3D view.

## A verifier that uses the graph

Language models cite things they never saw. So a second agent, with no LLM in its core check, verifies every citation in an answer:

- the cited key must appear in some tool result, and
- it must be reachable from the question's entry nodes within four hops over work relationships (hub edges such as `IN_REPO` are excluded, otherwise everything is two hops from everything).

```cypher
MATCH (a:Entity {key: $entry}), (b:Entity {key: $cited})
WITH a, b
MATCH p = allShortestPaths((a)-[:AUTHORED|REVIEWED|MERGED|TOUCHED|IN_DIR|CLOSES|REFERENCES|SHIPPED_IN|MENTIONS|KNOWS*..4]-(b))
RETURN length(p) AS hops, [n IN nodes(p) | n.key] AS keys LIMIT 1
```

If a citation fails, the Verifier hands the claim back to the Investigator once, with the reason. Claims, verdicts and handoffs are written to a shared FalkorDB graph, which is the coordination layer between the two agents. In practice the verifier caught abbreviated keys (`pr:#2527`), keys glued to full-width brackets, and answers about org-wide rankings that had no entry node at all; each case changed how the verifier resolves and anchors citations.

## Memory as graphs

FalkorDB holds thousands of graphs on one instance, so each visitor gets their own: `tl_mem_<id>`. A turn is a node chained to the previous one; its tool calls hang off it with edges to the brain nodes they touched, so any past answer can be replayed. Facts come only from explicit statements ("I work on the TypeScript client"), stored with the turn they came from. Verified tool sequences become shared playbooks with their own vector index, and the next similar question starts from that plan.

## Drawing the agent's reasoning

The 3D view is React Three Fiber. The background is a constellation of repositories, active directories, people and concepts, laid out once with `d3-force-3d` and stored as `x, y, z` on the nodes in FalkorDB, so even the layout comes from the graph. When a step arrives, its nodes ignite in their label colour with selective bloom, traversed edges carry a light pulse, the camera eases to the new frontier, and the verifier's evidence path turns gold. Labels are one DOM layer projected every frame with simple collision avoidance, which avoided creating a React root per label.

There is also a light theme. Bloom only works when colours exceed 1.0 against a dark background, so the light stage drops it: nodes switch to darker, saturated variants, faded context fades toward the pale background instead of toward black, and the verified path becomes a deeper gold drawn thicker. The page applies the saved theme in an inline script before first paint, so there is no flash of the wrong theme, and an axe-core check of every page passes WCAG AA contrast in both themes.

## Did the graph actually help?

Sixty questions in six categories, with gold answers computed by a separate script from the raw GitHub JSON, without FalkorDB, so the graph never grades itself. Both systems use the same model, the same embeddings and the same FalkorDB vector index; the vector baseline takes the eight nearest chunks with their document metadata. Because Groq's free tier caps tokens per model per day, questions rotate across three models, and each question is answered by both systems with the same model.

<!-- EVAL:START -->
Run in progress: 31 of 60 questions answered by both systems so far (the rest resume as each model's daily Groq cap refills). These numbers cover finished pairs only. Models: qwen/qwen3.8-27b (7 pairs), openai/gpt-oss-120b (24 pairs).

| Category | Pairs | Graph agent F1 | Vector RAG F1 |
|---|---|---|---|
| Single-hop lookup (control) | 7 | 1.00 | 0.43 |
| Expertise (PR to file to directory) | 7 | 0.76 | 0.00 |
| Decision trace (issue to PR to release) | 5 | 0.80 | 0.00 |
| Cross-repo connection | 4 | 1.00 | 0.00 |
| Impact (open PRs under a directory) | 4 | 0.50 | 0.00 |
| Aggregation (top reviewers or openers) | 4 | 1.00 | 0.00 |
| **All** | **31** | **0.85** | **0.10** |

The graph agent used about 5,721 tokens per answer against 1,533 for the baseline. 96 percent of the graph agent's citations were verified by a graph path. The vector baseline does best on single-hop lookup questions (F1 0.43), the control category where the answer sits in one document. Widest gap: cross-repo connection and aggregation. Every question, gold answer, raw answer and score is in [`eval/`](https://github.com/StarKnightt/threadline/tree/main/eval) and on [/eval](https://threadline-graph.vercel.app/eval).
<!-- EVAL:END -->

One honest detail from building the eval: the control category, "who opened the pull request titled X", depends heavily on phrasing for vector retrieval. With a question-first template the right chunk was in the top eight for 1 of 10 questions; with the title first, 6 of 10; with the bare title, 8 of 10. I used the title-first phrasing so the baseline gets a fair chance.

## What I would do next

- LLM-extracted `Decision` nodes linked to the comments that justify them.
- Point it at a second organisation; the ingestion only needs an org name.
- A fine-grained token for the daily sync, and persistence beyond the free tier.

## AI disclosure

I planned the concept, graph model, query catalogue and evaluation method before the event. Most of the implementation was written with an AI coding agent in Cursor under my direction, and every query was run against the live FalkorDB instance before it went into the catalogue.
