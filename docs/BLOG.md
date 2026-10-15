---
title: "A company brain that shows its work: multi-hop GraphRAG on FalkorDB, with every hop replayed in 3D"
published: false
description: "Threadline turns six FalkorDB repositories into a FalkorDB graph, answers ownership and decision questions by walking it, checks its own citations with path queries, and scores 0.81 F1 against 0.12 for vector RAG on 60 questions."
tags: falkordb, graphrag, ai, opensource
cover_image: https://raw.githubusercontent.com/StarKnightt/threadline/main/shots/02-split-graph-vs-vector.png
---

Some questions about a software company are not answered by any single document. "Who should review a change to the vector index code?" "Which pull request fixed this issue, and which release shipped it?" "What is affected if we change this directory?" The answer lives in how people, pull requests, files and releases connect, and text retrieval is a poor tool for following connections.

For [WeMakeDevs Graph Hacks](https://www.wemakedevs.org/hackathons/falkordb) I built **Threadline**, a company brain for an open-source company, with FalkorDB as its only database. An agent answers by walking the graph with typed tools, every hop is replayed in 3D with the exact Cypher it ran, and a second agent checks each citation against a real path in the graph before the answer is marked verified.

- **Live app:** https://threadline-graph.vercel.app (six recorded runs replay instantly with no model call)
- **Code (MIT):** https://github.com/StarKnightt/threadline
- **Demo video:** VIDEO_URL

![Graph agent versus vector RAG on the same question. Left: eight retrieved chunks with no connections between them. Right: the graph path from the vector-index concept to the PRs that mention it and the people who wrote and reviewed them, with the verified path in gold.](https://raw.githubusercontent.com/StarKnightt/threadline/main/shots/02-split-graph-vs-vector.png)

This post covers the graph model, the Cypher that does the work, how the verifier uses the graph, how I measured whether the graph helps, and what did not work.

## The data: an open-source organisation as a company

I used the public GitHub history of the FalkorDB organisation: the core database, the browser, QueryWeaver, GraphRAG-SDK, the TypeScript client, the MCP server and the docs. It is public, it has real organisational structure (reviews, closing references, releases, cross-repository mentions), and anyone can check the answers against GitHub.

Two constraints shaped the scope:

- **Privacy.** People are stored by GitHub login and avatar URL only. No names, emails or locations. Bots are flagged and kept out of expertise rankings.
- **The free tier's 100 MB.** FalkorDB Cloud's free instance holds about 100 MB in memory. I kept items updated since January 2023 and used 256-dimension embeddings. The result is about 27,000 nodes and 136,000 relationships, and `GRAPH.MEMORY USAGE` reports 41 MB, of which text chunks with their vectors take 19 MB.

## The graph model

Every brain node carries an `:Entity` label and a unique `key` such as `pr:FalkorDB/FalkorDB#1461` or `person:swilly22`. One index on `Entity.key` lets any tool address any node, and the same keys double as citations in answers, which is what makes them checkable later.

The core relationships come straight from GitHub: `AUTHORED`, `REVIEWED`, `MERGED`, `COMMENTED_ON`, `TOUCHED` (PR to file), `IN_DIR` (file to directory to parent directory), `CLOSES`, `REFERENCES` (with a `crossRepo` flag), `SHIPPED_IN` and `MENTIONS` (to a fixed dictionary of about 50 concepts such as `vector-index` or `pagerank`, matched without an LLM).

![The data model as rendered on the app's How it works page, generated from the same constants the server runs.](https://raw.githubusercontent.com/StarKnightt/threadline/main/shots/09-how-data-model.png)

The most useful part turned out to be the **derived edges**, computed in Cypher after each load and again by a daily sync:

```cypher
MATCH (p:Person)-[:AUTHORED]->(pr:PullRequest)-[:TOUCHED]->(:File)-[:IN_DIR*1..6]->(d:Directory)
WHERE p.isBot = false AND pr.mergedAt IS NOT NULL
WITH p, d, count(DISTINCT pr) AS authored, max(pr.mergedAt) AS last
MERGE (p)-[k:KNOWS]->(d)
SET k.authored = authored, k.authoredLastAt = last
```

`KNOWS` turns thousands of file touches into one weighted edge per person and directory, so "who knows this area" becomes a one-hop question at query time. `REVIEWS_FOR` (reviewer to author) feeds PageRank, `CO_CHANGES` (directories changed by the same PRs) feeds label propagation, and `CONTRIBUTES_TO` feeds betweenness. Precomputing these is the graph equivalent of an index: it moves the expensive walk to load time.

## The Cypher that does the work

**Who knows an area, now.** Expertise decays: someone who touched the index code three years ago is a weaker answer than someone who reviewed it last week.

```cypher
MATCH (p:Person)-[k:KNOWS]->(d:Directory)
WITH p, d, k, (2 * k.authored + k.reviewed) AS weight, ($now - k.lastAt) / 86400.0 AS ageDays
RETURN p.login, k.authored, k.reviewed, weight * exp(-ageDays / 180.0) AS score
ORDER BY score DESC LIMIT 10
```

**Decision trace.** From an issue to the PR that closed it, to the release that shipped it, with the source of each link recorded on the edge:

```cypher
MATCH (i:Issue {key: $key})
OPTIONAL MATCH (fix:PullRequest)-[c:CLOSES]->(i)
OPTIONAL MATCH (fix)-[:SHIPPED_IN]->(rel:Release)
OPTIONAL MATCH (author:Person)-[:AUTHORED]->(fix)
RETURN i.title, fix.key, author.login, rel.tag, c.source
```

![A decision trace replayed: issue to closing PR to release, with the step cards and their Cypher on the left.](https://raw.githubusercontent.com/StarKnightt/threadline/main/shots/04-decision-trace.png)

**Impact.** A variable-length walk down the directory tree to open pull requests:

```cypher
MATCH (d)<-[:IN_DIR*1..6]-(f:File)<-[:TOUCHED]-(pr:PullRequest)
WHERE pr.state = 'OPEN'
RETURN pr.key, pr.title, count(DISTINCT f) AS files ORDER BY files DESC
```

**Graph algorithms as tools.** `algo.pageRank` over `REVIEWS_FOR` finds key reviewers; `algo.betweenness` over people and repositories finds who bridges teams; `algo.labelPropagation` over `CO_CHANGES` finds the subsystems that actually change together, which do not always match the directory layout.

The full catalogue, 27 queries with parameters and measured timings, is generated into [docs/CYPHER.md](https://github.com/StarKnightt/threadline/blob/main/docs/CYPHER.md) from the same constants the server runs. `pnpm verify:cypher` runs every one against the live instance; most return in 65 to 160 ms including the round trip from India to the Mumbai region.

### Three FalkorDB details I learned the hard way

1. **`shortestPath()` lives in `WITH` or `RETURN`, and it is directed only.** My first verifier query put it in `MATCH` and failed; moving it to `WITH` then failed on the undirected pattern. `allShortestPaths()` in `MATCH` accepts undirected patterns, so the verifier uses that.
2. **Betweenness follows edge direction.** People only pointed at repositories, so no shortest path ran through a person and every score was zero. A derived reverse edge (`HAS_CONTRIBUTOR`) fixed it.
3. **Vector `score` is a distance.** `db.idx.vector.queryNodes` yields cosine distance, where lower is closer. I had sorted it descending, so entity resolution quietly picked the farthest of the nearest neighbours. A title-only query exposed it: the right chunk came back with a "score" of 0.18 while worse matches scored 0.36. Every vector query now reports `1 - score` as similarity.

## Typed tools first, free-form Cypher last

The Investigator agent (Vercel AI SDK, temperature 0, at most six steps) gets typed tools: `find_entities`, `who_knows`, `trace`, `connect`, `impact`, `activity`, `rank`, `expand`, `details`, `draft_triage`, and finally `cypher_readonly` for questions nothing else fits. Typed tools are easier for a model to call correctly than raw Cypher, and each one is a query I wrote and tested by hand.

The free-form tool runs through `GRAPH.RO_QUERY` as a separate read-only database user (FalkorDB Cloud's Read role), rejects write clauses and enforces a `LIMIT` and a 5 second timeout. I checked both guards directly: `GRAPH.RO_QUERY` refuses writes, and the read-only user cannot call `GRAPH.QUERY` at all.

Each tool returns rows plus the node keys it touched, the edges it traversed and its Cypher. Those stream to the browser over server-sent events and drive the 3D view, so the visualisation is a direct rendering of what the agent actually did rather than an illustration of it.

![A step card with its Cypher expanded, next to the traversal it produced.](https://raw.githubusercontent.com/StarKnightt/threadline/main/shots/03-step-cypher.png)

## A verifier that uses the graph

Language models cite things they never saw. So a Verifier agent, deterministic with no LLM in its check, inspects every citation in an answer:

- the cited key must appear in some tool result, and
- it must be reachable from the question's entry nodes within four hops over work relationships. Hub edges such as `IN_REPO` are excluded; otherwise everything is two hops from everything and the check proves nothing.

```cypher
MATCH (a:Entity {key: $entry}), (b:Entity {key: $cited})
WITH a, b
MATCH p = allShortestPaths((a)-[:AUTHORED|REVIEWED|MERGED|TOUCHED|IN_DIR|CLOSES|REFERENCES|SHIPPED_IN|MENTIONS|KNOWS*..4]-(b))
RETURN length(p) AS hops, [n IN nodes(p) | n.key] AS keys LIMIT 1
```

If a citation fails, the Verifier hands the claim back to the Investigator once, with the reason. Claims, verdicts (`CHECKED_BY {verdict, pathLength}`) and handoffs (`HANDED_OFF`) are written to a shared FalkorDB graph, `tl_shared`, which is the coordination layer between the two agents.

Here is a real example from a production run during final testing: "Which pull request fixed issue #1003 in the falkordb-browser repository, and in which release did the fix ship?" The first answer cited `release:v1.4.0`, an abbreviated key that matches no node. The Verifier rejected it, the Investigator rewrote the citation as `release:FalkorDB/falkordb-browser@v1.4.0`, and the second check verified 2 of 2. The whole exchange took 2.9 seconds and is [replayable here](https://threadline-graph.vercel.app/t/c35f0b88-340). A direct Cypher query agrees: PR #1007 closes the issue through a closing reference and shipped in v1.4.0 according to the release notes.

Building the verifier changed the rest of the system. It caught abbreviated keys like `pr:#2527`, keys glued to full-width brackets, and answers about org-wide rankings that had no entry node at all. Each case changed how citations are resolved and anchored.

## Memory as graphs, one per visitor

FalkorDB holds many isolated graphs on one instance, so each visitor gets their own: `tl_mem_<id>`. A turn is a node chained to the previous one with `NEXT`; its tool calls hang off it with edges to the brain nodes they touched, so any past answer can be replayed. Facts come only from explicit statements ("I work on the TypeScript client") and keep a `LEARNED_FROM` edge to the turn they came from, so the app can show why it believes something. Follow-ups such as "same question, but for QueryWeaver" resolve against the previous turn. Verified tool sequences become shared procedural playbooks with their own vector index, and the next similar question starts from that plan.

## Drawing the agent's reasoning

The 3D view is React Three Fiber. The background is a constellation of repositories, active directories, people and concepts, laid out once with `d3-force-3d` and stored as `x, y, z` properties on the nodes, so even the layout comes from FalkorDB. When a step arrives, its nodes ignite in their label colour, traversed edges carry a light pulse, the camera eases to the new frontier, and the verifier's evidence path turns gold. Labels are one DOM layer projected every frame with simple collision avoidance, which avoided creating a React root per label.

There is also a light theme. Bloom only works when colours exceed 1.0 against a dark background, so the light stage drops it: nodes switch to darker, saturated variants, faded context fades toward the pale background instead of toward black, and the verified path becomes a deeper gold drawn thicker. An axe-core check passes WCAG AA contrast on every page in both themes.

![The same comparison in the light theme.](https://raw.githubusercontent.com/StarKnightt/threadline/main/shots/02-split-graph-vs-vector-light.png)

## Acting, not only answering

`draft_triage` turns an open issue into a ready-to-paste triage comment: likely duplicates by vector similarity, suggested reviewers from the people who changed the same code when similar issues were fixed, and suggested labels. It never posts anything. The same typed tools are served over MCP at `/api/mcp`, so any MCP client can use the graph directly.

![A drafted triage comment for falkordb-browser issue #1802, with the evidence path behind each suggestion.](https://raw.githubusercontent.com/StarKnightt/threadline/main/shots/07-triage-action.png)

## Did the graph actually help?

I wanted a number I could defend, so the evaluation was designed so the graph cannot grade itself. Sixty questions in six categories are generated from templates over the raw GitHub JSON, and their gold answers are computed by a separate script from that JSON, without FalkorDB. Both systems use the same model on a given question, the same 256-dimension embeddings and the same FalkorDB vector index; the vector baseline takes the eight nearest chunks with their document metadata. Scores are set-based F1 over each answer's final `ANSWER:` line.

Groq's free tier caps tokens per model per day, so questions rotated across three Groq models, and the 29 questions those caps left unfinished were completed on OpenAI gpt-5.6-luna with reasoning off. Every comparison is still paired within a question.

<!-- EVAL:START -->
All 60 questions were answered by both systems. Models: qwen/qwen3.8-27b (Groq) on 7 questions, openai/gpt-oss-120b (Groq) on 24 questions, gpt-5.6-luna (OpenAI, reasoning off) on 29 questions.

The questions were split across models: Groq's free daily token caps stopped the rotation part way, so the questions without a finished pair were completed with OpenAI gpt-5.6-luna. Each question was answered by one model, and its graph and vector runs always used that same model, so every comparison is paired within a question. The models received different mixes of categories, so the per-model rows are not a ranking of the models. Which model answered each question is listed in [`eval/summary.json`](https://github.com/StarKnightt/threadline/blob/main/eval/summary.json) and on every question at [/eval](https://threadline-graph.vercel.app/eval).

| Category | Pairs | Graph agent F1 | Vector RAG F1 |
|---|---|---|---|
| Single-hop lookup (control) | 10 | 1.00 | 0.60 |
| Expertise (PR to file to directory) | 10 | 0.83 | 0.00 |
| Decision trace (issue to PR to release) | 10 | 0.85 | 0.00 |
| Cross-repo connection | 10 | 0.88 | 0.00 |
| Impact (open PRs under a directory) | 10 | 0.30 | 0.10 |
| Aggregation (top reviewers or openers) | 10 | 1.00 | 0.00 |
| **All** | **60** | **0.81** | **0.12** |

| Model | Questions | Graph agent F1 | Vector RAG F1 |
|---|---|---|---|
| qwen/qwen3.8-27b (Groq) | 7 | 1.00 | 0.29 |
| openai/gpt-oss-120b (Groq) | 24 | 0.81 | 0.04 |
| gpt-5.6-luna (OpenAI, reasoning off) | 29 | 0.77 | 0.14 |

The graph agent used about 6,190 tokens per answer against 1,479 for the baseline. 95 percent of the graph agent's citations were verified by a graph path. Median latency in the eval: 54.4 s graph and 9.4 s vector on qwen/qwen3.8-27b, 19.5 s graph and 1.5 s vector on openai/gpt-oss-120b, 7.2 s graph and 2.4 s vector on gpt-5.6-luna. The Groq runs went back to back under an 8,000 tokens per minute limit, so their graph latencies include waiting for that limit; single live questions took 1.6 to 15 s in testing. The vector baseline does best on single-hop lookup questions (F1 0.60), the control category where the answer sits in one document. Widest gap: aggregation. Every question, gold answer, raw answer and score is in [`eval/`](https://github.com/StarKnightt/threadline/tree/main/eval) and on [/eval](https://threadline-graph.vercel.app/eval).
<!-- EVAL:END -->

![The /eval page: paired results per category and per model, with every question, gold answer and raw answer.](https://raw.githubusercontent.com/StarKnightt/threadline/main/shots/08-eval.png)

How I read these numbers:

- **The control category behaves as it should.** When the answer sits in one document, vector retrieval does reasonably well (0.60). That is the point of a control: the gap on the other categories is about structure, not a crippled baseline.
- **I gave the baseline a fair chance, and it mattered.** For the lookup questions, the right chunk was in the top eight for 1 of 10 questions with a question-first phrasing, 6 of 10 with the title first, and 8 of 10 with the bare title. I used the title-first phrasing.
- **Aggregation is where retrieval cannot win.** "Who reviewed the most PRs in 2024?" is a count over hundreds of edges. No chunk contains it, so the baseline either refuses or guesses; the graph answers with one `count()`.
- **The graph costs more tokens.** About 4 times the baseline per answer, because tool results carry rows and keys. For these questions that trade is worth it, but it is a real cost.

### The impact category, and a bug the eval found

Impact scored only 0.30, and the reason is instructive. The graph agent missed seven of its ten questions, and in six of those it answered "none". Checking the misses with Cypher showed the data was there: PR #272 is open and touches files under `clients/python/queryweaver_client`, exactly as the gold answer says. The problem was the tool. The questions write paths with a trailing slash (`clients/python/queryweaver_client/`), the `impact` tool matched them with `CONTAINS` against directory paths stored without one, and so the query returned nothing. The agent then reported, truthfully, that its tool found no open PRs. Another tool in the same file already stripped slashes; `impact` did not.

The fix is one line. After it, the impact query itself returns the gold PRs for 9 of the 10 impact questions; the tenth sits under `.claude/`, which the tool deliberately skips. I have **not** rerun the agent evaluation, so the published numbers above are the measured, pre-fix ones. The lesson for me is that an honest eval is mostly useful for what it tells you about your own tools.

## Running on free tiers, and what it costs

The whole project runs on free tiers plus a few cents of OpenAI usage:

- **FalkorDB Cloud free tier** (AWS ap-south-1). It has no persistence and stops after a day without use, so a daily Vercel Cron sync keeps it in use, and `pnpm seed` rebuilds the graph from a published snapshot in about two minutes. The free tier also has no TLS, so only public GitHub data and least-privilege credentials travel over that connection.
- **Groq's free tier** for the agent (gpt-oss-120b first, then gpt-oss-20b and qwen3.8-27b when rate limited). The caps are per model per day and shared with the evaluation.
- **A capped OpenAI fallback for live questions only.** When every Groq model is capped, a live question continues on OpenAI gpt-5.4-mini, with at most 4 calls of up to 2,000 output tokens per run, 10 runs a day and 25 runs a month across all visitors. At Standard prices ($0.75 input, $0.075 cached input, $4.50 output per million tokens), the token counts of real fallback runs cost about $0.001 to $0.0035 each, a worst-case run is about $0.07, and the monthly cap bounds the fallback at under $2.
- **Spend so far:** embedding the corpus cost about four US cents, and the 29 OpenAI evaluation questions cost about $0.024.

Recorded showcase runs replay from the stored traces in FalkorDB with no model call at all, which is also what makes the demo reliable during judging.

## Limitations

- **The eval pools models.** Questions were split across three models because of free-tier caps. Comparisons are paired within each question, but the per-model rows are not a ranking, and a single-model run would be cleaner.
- **The impact numbers are pre-fix**, as described above.
- **Expertise is inferred from authored and reviewed PRs.** Design discussions in chat, calls or other channels are invisible to the graph.
- **Release attribution falls back to "first release after the merge"** when release notes do not list a PR. The source is recorded on each `SHIPPED_IN` edge, but the fallback can be wrong.
- **Concept matching uses a fixed dictionary** of about 50 FalkorDB terms. It is precise but does not generalise to another organisation without editing.
- **Concurrent live questions slow down** under Groq's 8,000 tokens per minute limit, and past the daily caps the app falls back, then stops and points to the recorded runs.
- **Decision nodes extracted by an LLM**, linked to the comments that justify them, were planned and not built.

## What I would do next

- Rerun the full evaluation on one model, after the impact fix.
- LLM-extracted `Decision` nodes with `JUSTIFIED_BY` edges to the comments behind them.
- Point it at a second organisation; ingestion only needs an org name, but the concept dictionary needs work.
- Persistence beyond the free tier, and a fine-grained token for the daily sync.

## AI disclosure

I planned the concept, graph model, query catalogue and evaluation method before the event as notes, which the rules allow. During the event, most of the implementation code was written by an AI coding agent in Cursor (Anthropic Claude) working from that plan under my direction, and this post was drafted with its help and edited by me. Every Cypher query was run and checked against the live FalkorDB instance before it went into the catalogue, and the evaluation's gold answers are computed independently of FalkorDB. At runtime the app uses Groq-hosted open-weight models with a capped OpenAI fallback, plus OpenAI embeddings.

## Links

- Live app: https://threadline-graph.vercel.app
- Source code and setup: https://github.com/StarKnightt/threadline
- Cypher catalogue: https://github.com/StarKnightt/threadline/blob/main/docs/CYPHER.md
- Evaluation data: https://github.com/StarKnightt/threadline/tree/main/eval
- Demo video: VIDEO_URL
