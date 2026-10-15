import { tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AllCappedError, generateWithFallback, OPENAI_MODEL, PAID_MAX_CALLS, PAID_MAX_OUTPUT_TOKENS, PaidRun, type Providers } from "../src/lib/agent/llm";

const usage = { inputTokens: { total: 1000, noCache: 1000, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 100, text: 100, reasoning: 0 } };
const capped = () =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error("Rate limit reached for model on tokens per day (TPD): Limit 200000, Used 199990. Please try again in 1h2m.");
    },
  });
const finish = (reason: "stop" | "tool-calls") => ({ unified: reason, raw: reason });
const answer = (text: string) => async () => ({ content: [{ type: "text" as const, text }], finishReason: finish("stop"), usage, warnings: [] });

function setup(openai: MockLanguageModelV4 | null, slot = true) {
  const groqCalls: string[] = [];
  const providers: Providers = {
    groq: (id) => (groqCalls.push(id), capped()),
    openai: openai ? () => openai : null,
  };
  let claims = 0;
  const paid = new PaidRun(async () => (claims++, slot ? { ok: true } : { ok: false, why: "daily OpenAI budget used" }));
  return { providers, paid, groqCalls, claims: () => claims };
}

describe("OpenAI fallback when every Groq model is capped", () => {
  it("tries every Groq model, then answers on OpenAI with capped output tokens", async () => {
    const openai = new MockLanguageModelV4({ doGenerate: answer("Answer [person:swilly22]\nANSWER: swilly22") });
    const s = setup(openai);
    const { res, model } = await generateWithFallback({ prompt: "who?", maxOutputTokens: 5000 }, ["a", "b", "c"], s.paid, s.providers);
    expect(s.groqCalls).toEqual(["a", "b", "c"]);
    expect(model).toBe(OPENAI_MODEL);
    expect(res.text).toContain("swilly22");
    expect(openai.doGenerateCalls[0].maxOutputTokens).toBe(PAID_MAX_OUTPUT_TOKENS);
    expect(openai.doGenerateCalls[0].providerOptions?.openai).toMatchObject({ reasoningEffort: "none" });
    expect(s.paid.calls).toBe(1);
    expect(s.paid.costUsd).toBeCloseTo((1000 * 0.2 + 100 * 1.2) / 1e6);
  });

  it("caps a tool loop at four OpenAI calls and forces an answer on the last one", async () => {
    let n = 0;
    const openai = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        n++;
        if (opts.toolChoice?.type === "none") return answer("done")();
        return { content: [{ type: "tool-call" as const, toolCallId: `t${n}`, toolName: "look", input: "{}" }], finishReason: finish("tool-calls"), usage, warnings: [] };
      },
    });
    const s = setup(openai);
    const tools = { look: tool({ description: "look", inputSchema: z.object({}), execute: async () => ({ ok: true }) }) };
    const { res } = await generateWithFallback({ prompt: "q", tools, maxOutputTokens: 1400 }, ["a"], s.paid, s.providers);
    expect(openai.doGenerateCalls.length).toBe(PAID_MAX_CALLS);
    expect(res.text).toBe("done");
    expect(s.paid.calls).toBe(PAID_MAX_CALLS);
    // A follow-up call in the same run (the Verifier handoff) is refused instead of spending a fifth call.
    await expect(generateWithFallback({ prompt: "revise" }, ["a"], s.paid, s.providers)).rejects.toBeInstanceOf(AllCappedError);
    expect(openai.doGenerateCalls.length).toBe(PAID_MAX_CALLS);
    expect(s.claims()).toBe(1);
  });

  it("refuses when today's OpenAI budget is used, without calling OpenAI", async () => {
    const openai = new MockLanguageModelV4({ doGenerate: answer("x") });
    const s = setup(openai, false);
    await expect(generateWithFallback({ prompt: "q" }, ["a", "b"], s.paid, s.providers)).rejects.toBeInstanceOf(AllCappedError);
    expect(openai.doGenerateCalls.length).toBe(0);
  });

  it("never falls back without a PaidRun (eval and scripts) and keeps Groq's error", async () => {
    const openai = new MockLanguageModelV4({ doGenerate: answer("x") });
    const s = setup(openai);
    await expect(generateWithFallback({ prompt: "q" }, ["a"], undefined, s.providers)).rejects.toThrow(/tokens per day/);
    expect(openai.doGenerateCalls.length).toBe(0);
  });

  it("uses Groq when it is not capped", async () => {
    const groq = new MockLanguageModelV4({ doGenerate: answer("free") });
    const openai = new MockLanguageModelV4({ doGenerate: answer("paid") });
    const paid = new PaidRun(async () => ({ ok: true }));
    const { model, res } = await generateWithFallback({ prompt: "q" }, ["a"], paid, { groq: () => groq, openai: () => openai });
    expect([model, res.text, paid.calls, openai.doGenerateCalls.length]).toEqual(["a", "free", 0, 0]);
  });
});
