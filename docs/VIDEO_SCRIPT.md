# Demo video script (target 2:40, hard cap 3:00)

No length limit is published on the event pages; this script stays under three minutes. Footage comes from `node scripts/demo-capture.mjs` (replay scenes) and `node scripts/demo-capture.mjs --live --only 1` (scenes 11 and 12, which call the LLM). Clips land in `demo/footage/` at 1920x1080. The capture is resumable: existing clips are skipped unless `--force` is passed. Read at a calm pace; each block has about 2.5 words per second of room.

The evaluation line is generated from `eval/summary.json` by `pnpm eval:docs`, so it always matches the committed results.

| Time | Clip | Voiceover |
|---|---|---|
| 0:00 to 0:12 | `02-split-vector-vs-graph` (first 12 s) | Ask a vector search system who should review a change to FalkorDB's vector index code, and you get eight loosely related text chunks. Ask Threadline, and you get the people, plus the path in the graph that backs it up. |
| 0:12 to 0:28 | `01-home-constellation` | Threadline is a company brain built from the public GitHub history of the FalkorDB organisation. Six repositories and the docs, in one FalkorDB graph of about twenty-seven thousand nodes: people, pull requests, issues, reviews, files, releases and concepts. |
| 0:28 to 0:50 | `02-split-vector-vs-graph` (replay part) | The agent first resolves the question to graph nodes. Then it calls typed graph tools. Here, who-knows walks from the vector index concept to the merged pull requests that mention it, and on to their authors and reviewers, weighted by how recent the work is. |
| 0:50 to 1:05 | `03-cypher-and-verifier` | Every step shows the exact Cypher, its parameters and its timing. Then a separate verifier agent checks each citation: it must appear in a tool result and connect to the question by a real path in the graph. Verified evidence turns gold. |
| 1:05 to 1:17 | `04-decision-trace` | Decision traces work the same way: from issue fourteen sixty-two, to the pull request that closed it, to the release that shipped it. |
| 1:17 to 1:27 | `05-cross-repo` | And across repositories: the browser's request to import a graph from a dump connects to the core team's restore work. |
| 1:27 to 1:40 | `06-impact`, then `07-algorithms` | Impact analysis follows the directory tree to open pull requests and to code that usually changes together. PageRank over who reviews whom finds key reviewers, and betweenness centrality finds the people who bridge repositories. |
| 1:40 to 1:58 | `12-memory` | Each visitor gets their own FalkorDB graph as memory. Say you work on the TypeScript client, then ask "same question, but for QueryWeaver", and it resolves the follow-up from the previous turn. Verified tool sequences become shared playbooks. |
| 1:58 to 2:12 | `08-triage-action` | It can also act. Draft-triage turns an open issue into a ready-to-paste comment with likely duplicates and suggested reviewers. The same tools are served over MCP, so any MCP client can use them. |
| 2:12 to 2:28 | `09-eval` | We measured it on the first 31 of sixty questions, with gold answers computed from the raw GitHub data without FalkorDB, and the same model for both systems. The graph agent scored an F1 of 0.85, against 0.10 for vector retrieval. The gap is widest on cross-repo connection and aggregation questions, and vector search holds up best on simple lookups. |
| 2:28 to 2:40 | `10-how-data-model`, two seconds of `13-light-theme`, then an end card with the URL | FalkorDB is the only database here: the brain, the memory, the agents' shared blackboard, the stored traces and even the 3D layout. Threadline is open source and live now. Built with AI coding assistance, disclosed in the README. |

End card text: `threadline-graph.vercel.app` · `github.com/StarKnightt/threadline` · Tracks: Company Brain, Agents That Act on Connected Data, Agent Memory and Coordination.

## Recording notes

- Record the voiceover first, then trim clips to fit. Replay clips can be slowed to 90 percent if a block runs long.
- If a live clip shows a rate-limit message, rerun it a minute later; the per-minute token limit resets quickly.
- Upload to YouTube or Vimeo as public or unlisted and paste the link into the README and the submission form.
