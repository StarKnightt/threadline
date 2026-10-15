import { randomUUID } from "node:crypto";
import { AllCappedError, isRateLimit, OPENAI_MODEL, PAID_RUNS_PER_DAY, PAID_RUNS_PER_MONTH, PaidRun, type Slot } from "@/lib/agent/llm";
import { runGraphAgent, runVectorBaseline } from "@/lib/agent/run";
import type { Trace } from "@/lib/agent/types";
import { embedQuestion } from "@/lib/embed";
import { bump, ensureShared, loadMemory, persist } from "@/lib/memory";

export const maxDuration = 120;

const CAPPED_MESSAGE =
  "Today's free model capacity for live questions is used up. The recorded runs above replay full investigations instantly, with every hop and its Cypher, and need no model call. Live questions open again when the daily limits reset.";

/** One paid OpenAI run per lane, counted atomically in FalkorDB (shared across instances). */
async function claimPaidRun(): Promise<Slot> {
  const day = await bump("openai-runs:day", 86400);
  if (day > PAID_RUNS_PER_DAY) return { ok: false, why: `daily OpenAI budget used (${PAID_RUNS_PER_DAY} runs)` };
  const month = await bump("openai-runs:month", 30 * 86400);
  if (month > PAID_RUNS_PER_MONTH) return { ok: false, why: `monthly OpenAI budget used (${PAID_RUNS_PER_MONTH} runs)` };
  return { ok: true };
}

const PER_IP = Number(process.env.ASK_PER_IP_PER_HOUR ?? 10);
const GLOBAL = Number(process.env.ASK_GLOBAL_PER_DAY ?? 300);
const idRe = /^[a-zA-Z0-9-]{8,64}$/;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { question?: string; mode?: string; sessionId?: string; userId?: string };
  const question = (body.question ?? "").trim().slice(0, 400);
  const mode = body.mode === "vector" ? "vector" : body.mode === "split" ? "split" : "graph";
  const userId = idRe.test(body.userId ?? "") ? body.userId! : undefined;
  const sessionId = idRe.test(body.sessionId ?? "") ? body.sessionId! : undefined;
  if (question.length < 6) return Response.json({ error: "Ask a longer question." }, { status: 400 });

  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  await ensureShared();
  const [perIp, global] = await Promise.all([bump(`ip:${ip}`, 3600), bump("global", 86400)]);
  if (perIp > PER_IP || global > GLOBAL) {
    return Response.json(
      { error: perIp > PER_IP ? `Demo limit reached (${PER_IP} live questions per hour). The showcase traces replay without limits.` : "The daily demo budget is used up. The showcase traces replay without limits." },
      { status: 429 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      const run = async (m: "graph" | "vector") => {
        const emit = (e: Record<string, unknown>) => send({ ...e, lane: m });
        const vec = m === "graph" ? await embedQuestion(question).catch(() => null) : null;
        const mem = m === "graph" && userId && sessionId ? await loadMemory(userId, sessionId, vec) : undefined;
        if (mem && (mem.facts.length || mem.previous || mem.playbook)) emit({ type: "memory", facts: mem.facts, previous: mem.previous?.question, playbook: mem.playbook });
        const paid = new PaidRun(claimPaidRun);
        let t: Omit<Trace, "id" | "at">;
        try {
          t = m === "graph" ? await runGraphAgent(question, emit, mem, { paid }) : await runVectorBaseline(question, emit, { paid });
        } finally {
          if (paid.calls) console.log(`[llm] openai ${OPENAI_MODEL} ${m}: ${paid.calls} calls, ${paid.usage.input} in (${paid.usage.cached} cached) + ${paid.usage.output} out, ~$${(paid.costUsd ?? 0).toFixed(5)}`);
        }
        const trace: Trace = { ...t, id: randomUUID().slice(0, 12), at: Math.floor(Date.now() / 1000) };
        await persist(trace, { userId: m === "graph" ? userId : undefined, sessionId, vec }).catch((e) => console.error("persist failed", e));
        emit({ type: "done", traceId: trace.id, tokens: trace.tokens, ms: trace.ms, model: trace.model });
      };
      try {
        if (mode === "split") await Promise.all([run("vector"), run("graph")]);
        else await run(mode);
      } catch (e) {
        const msg = String((e as Error).message ?? e);
        if (e instanceof AllCappedError || isRateLimit(e)) {
          console.warn("[llm] all providers capped:", msg.replace(/org_\w+/g, "org").slice(0, 200));
          send({ type: "error", capped: true, message: CAPPED_MESSAGE });
        } else send({ type: "error", message: msg.slice(0, 200) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
