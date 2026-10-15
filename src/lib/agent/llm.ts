import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, isStepCount, type LanguageModel } from "ai";

export const MODELS = (process.env.TL_MODELS ?? "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b").split(",");

/** Paid fallback for the live /ask route only; the eval and scripts never pass a PaidRun. */
export const OPENAI_MODEL = process.env.OPENAI_FALLBACK_MODEL?.trim() || "gpt-5.6-luna";
export const PAID_MAX_CALLS = 4;
export const PAID_MAX_OUTPUT_TOKENS = 2000;
export const PAID_RUNS_PER_DAY = Number(process.env.OPENAI_DAILY_RUNS ?? 30);
export const PAID_RUNS_PER_MONTH = Number(process.env.OPENAI_MONTHLY_RUNS ?? 100);

/** USD per 1M tokens: input, cached input, output. */
const PRICES: Record<string, [number, number, number]> = {
  "gpt-5.6-luna": [0.1, 0.01, 0.6],
  "gpt-5-nano": [0.05, 0.005, 0.4],
  "gpt-4.1-nano": [0.1, 0.025, 0.4],
};

export function estimateCostUsd(model: string, input: number, cached: number, output: number): number | null {
  const p = PRICES[model];
  return p ? ((input - cached) * p[0] + cached * p[1] + output * p[2]) / 1e6 : null;
}

export type Slot = { ok: boolean; why?: string };

/** Per-lane state for the metered route: one daily-budget slot, at most PAID_MAX_CALLS model calls. */
export class PaidRun {
  calls = 0;
  usage = { input: 0, cached: 0, output: 0 };
  private slot?: Promise<Slot>;
  constructor(private claimSlot: () => Promise<Slot>) {}
  claim() {
    this.slot ??= this.claimSlot();
    return this.slot;
  }
  get costUsd() {
    return estimateCostUsd(OPENAI_MODEL, this.usage.input, this.usage.cached, this.usage.output);
  }
}

/** Every provider is capped: the route turns this into a friendly pointer to the recorded runs. */
export class AllCappedError extends Error {
  capped = true;
}

export function isRateLimit(e: unknown) {
  const m = String((e as Error)?.message ?? e);
  return /rate.?limit|429|tokens per (day|minute)|TPD|TPM|quota|over capacity|unavailable|50[234]/i.test(m);
}

export type Providers = { groq: (id: string) => LanguageModel; openai: ((id: string) => LanguageModel) | null };

let defaults: Providers | undefined;
function defaultProviders(): Providers {
  if (!defaults) {
    const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
    const key = process.env.OPENAI_API_KEY?.trim();
    const openai = key && process.env.OPENAI_FALLBACK !== "0" ? createOpenAI({ apiKey: key }) : null;
    defaults = { groq: (id) => groq(id), openai: openai ? (id) => openai(id) : null };
  }
  return defaults;
}

type GenOpts = Omit<Parameters<typeof generateText>[0], "model">;

/** Model ids prefixed "openai:" call OpenAI directly with the caller's own step and token budgets (eval only). */
export const OPENAI_DIRECT = "openai:";
/** Token usage of every direct OpenAI call in this process, summed across all steps. */
export const openaiMeter = { calls: 0, input: 0, cached: 0, output: 0 };

export async function generateWithFallback(opts: GenOpts, models = MODELS, paid?: PaidRun, providers: Providers = defaultProviders()) {
  let last: unknown;
  for (const id of models) {
    if (id.startsWith(OPENAI_DIRECT)) {
      if (!providers.openai) throw new Error("OPENAI_API_KEY is not set");
      // Metered per step so a call that fails part way still counts the steps OpenAI billed.
      const onStepFinish = ({ usage }: { usage?: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } } }) => {
        openaiMeter.calls++;
        openaiMeter.input += usage?.inputTokens ?? 0;
        openaiMeter.cached += usage?.inputTokenDetails?.cacheReadTokens ?? 0;
        openaiMeter.output += usage?.outputTokens ?? 0;
      };
      const res = await generateText({ ...opts, maxRetries: 1, onStepFinish, model: providers.openai(id.slice(OPENAI_DIRECT.length)), providerOptions: { openai: { reasoningEffort: "none", parallelToolCalls: false } } } as Parameters<typeof generateText>[0]);
      return { res, model: id };
    }
    try {
      // gpt-oss models take low reasoning effort; Qwen3 supports turning thinking off entirely.
      const reasoningEffort = id.startsWith("qwen/") ? "none" : "low";
      const res = await generateText({ ...opts, maxRetries: 1, model: providers.groq(id), providerOptions: { groq: { reasoningEffort, parallelToolCalls: false } } } as Parameters<typeof generateText>[0]);
      return { res, model: id };
    } catch (e) {
      last = e;
      if (!isRateLimit(e)) throw e;
    }
  }
  if (!paid || !providers.openai) throw last;

  const left = PAID_MAX_CALLS - paid.calls;
  if (left <= 0) throw new AllCappedError(`OpenAI call cap reached (${PAID_MAX_CALLS} per run)`);
  const slot = await paid.claim();
  if (!slot.ok) throw new AllCappedError(slot.why ?? "Daily OpenAI budget used");
  const hasTools = !!opts.tools;
  try {
    const res = await generateText({
      ...opts,
      maxRetries: 0,
      model: providers.openai(OPENAI_MODEL),
      maxOutputTokens: Math.min(opts.maxOutputTokens ?? PAID_MAX_OUTPUT_TOKENS, PAID_MAX_OUTPUT_TOKENS),
      ...(hasTools
        ? {
            stopWhen: isStepCount(left),
            // The last allowed call must answer rather than ask for another tool.
            prepareStep: ({ stepNumber }: { stepNumber: number }) => (stepNumber >= left - 1 ? { toolChoice: "none" as const } : undefined),
          }
        : {}),
      providerOptions: { openai: { reasoningEffort: "none", parallelToolCalls: false } },
    } as Parameters<typeof generateText>[0]);
    const steps = res.steps?.length || 1;
    paid.calls += steps;
    const usage = res.totalUsage ?? res.usage;
    paid.usage.input += usage?.inputTokens ?? 0;
    paid.usage.cached += usage?.inputTokenDetails?.cacheReadTokens ?? 0;
    paid.usage.output += usage?.outputTokens ?? 0;
    return { res, model: OPENAI_MODEL };
  } catch (e) {
    paid.calls = PAID_MAX_CALLS;
    if (isRateLimit(e)) throw new AllCappedError(String((e as Error)?.message ?? e));
    throw e;
  }
}
