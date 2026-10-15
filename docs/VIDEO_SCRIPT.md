# Demo video script (2:43)

First-person voiceover for Prasenjit, about 400 words at a calm 2.4 to 2.5 words per second. Footage is in `demo/footage/` (1920x1080 WebM, recorded from production with `node scripts/demo-capture.mjs`; clip 11 is the exception, see the notes). In and out points are seconds within each clip. A plain-text copy for reading aloud is in `VOICEOVER.txt` next to the repo.

| Time | Footage (in to out) | Voiceover |
|---|---|---|
| 0:00 to 0:13 | `02-split-vector-vs-graph` 0 to 13 | Ask vector search who should review a change to FalkorDB's vector index code, and you get eight unconnected text chunks. Ask Threadline, and you get the people, and the path that proves it. |
| 0:13 to 0:25 | `01-home-constellation` 0 to 11.3, slowed to about 95 percent | I'm Prasenjit, and this is Threadline: a company brain on FalkorDB, built from the public GitHub history of the FalkorDB organisation. Twenty-seven thousand nodes of people, pull requests, issues, files and releases. |
| 0:25 to 0:41 | `03-cypher-and-verifier` 0 to 16 | Every answer is a walk through the graph, replayed in 3D. Each hop shows the exact Cypher it ran. Then a Verifier agent checks each citation against a real path in the graph, and the verified path turns gold. |
| 0:41 to 0:52 | `02-split-vector-vs-graph` 13 to 22.8, slowed to about 90 percent | Side by side, vector search returns similar text with no connections. The graph agent follows authorship and reviews to the people who actually know this code. |
| 0:52 to 1:08 | `04-decision-trace` 2 to 10, then `05-cross-repo` 2 to 10 | The same tools trace decisions, from an issue, to the pull request that closed it, to the release that shipped it. And they connect work across repositories, like a browser import request and the core team's restore work. |
| 1:08 to 1:19 | `06-impact` 2 to 7.5, then `07-algorithms` 2 to 7.5 | Impact analysis walks the directory tree to open pull requests. And FalkorDB's built-in algorithms become tools: PageRank finds key reviewers, and betweenness finds who bridges repositories. |
| 1:19 to 1:38 | `12-memory` 3 to 25, sped up slightly to fit | Memory lives in FalkorDB too, one graph per visitor. I say I work on the TypeScript client, then ask the same question for QueryWeaver, and it resolves the follow-up from memory. The two agents also coordinate through a shared graph, where claims, verdicts and handoffs are stored as nodes. |
| 1:38 to 1:47 | `11-live-question` 0 to 3, then 22 to 28 | This is a fresh question, asked live. The answer arrives with its path, and every citation is checked before it is shown. |
| 1:47 to 1:59 | `08-triage-action` 3 to 15 | It can also act. Draft triage turns an open issue into a ready-to-paste comment, with likely duplicates and suggested reviewers. And the same graph tools are served over MCP. |
| 1:59 to 2:19 | `09-eval` 0 to 9.2, then hold `shots/08-eval.png` for 11 s | I measured this on sixty questions, with gold answers computed from raw GitHub data, not from the graph. Each question used one model for both systems: Qwen, GPT-OSS, or GPT-5.6 Luna. The graph agent scored an F1 of zero point eight one. Vector search scored zero point one two. |
| 2:19 to 2:28 | `10-how-data-model` 0 to 9 | FalkorDB is the only database here: the brain, the memory, the agents' shared state, the stored traces, and even the 3D layout. |
| 2:28 to 2:34 | `13-light-theme` 10 to 16 | There is a light theme too, and the whole stage follows it. |
| 2:34 to 2:43 | End card (text below) | Threadline is open source, and it is live now at threadline-graph dot vercel dot app. Built with AI coding assistance, disclosed in the README. |

**On-screen caption during the eval segment (1:59 to 2:19):** `60 questions · graph agent F1 0.81 · vector RAG F1 0.12 · models: qwen3.8-27b (7), gpt-oss-120b (24), gpt-5.6-luna (29)`. These figures come from `eval/summary.json`; the clip and the still both show the per-model table.

**End card:** `threadline-graph.vercel.app` · `github.com/StarKnightt/threadline` · Tracks: Company Brain, Agents That Act on Connected Data, Agent Memory and Coordination · Built with FalkorDB.

## Recording notes

- Record the voiceover first, in one take per paragraph of `VOICEOVER.txt`, then lay the clips under it. Replay clips can run at 90 to 105 percent without looking wrong; the 3D motion is slow.
- Each replay clip spends its first one to two seconds loading, which is why most in-points start at 2 s. The gold verified path lands about 6 s into each replay.
- `11-live-question` (issue #2048) was recorded from a local server on the production FalkorDB graph, answered by OpenAI `gpt-5.4-mini` because every Groq model was capped at the time; the clip shows that model name. `gpt-5.4-mini` is now also the production fallback model, but the clip is still not a production run, so the narration only says "asked live". Its answer, PR #2306 shipped in v4.20.7, matches the graph ([trace](https://threadline-graph.vercel.app/t/705964c5-19c)).
- Total footage is 3:41, so several clips are trimmed; nothing in the script depends on footage that was not recorded.
- Upload to YouTube as public or unlisted, then paste the link into the README, the blog post and the submission form.
