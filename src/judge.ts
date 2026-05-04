/**
 * Async sampled quality judge.
 *
 * After a MiMo / DeepSeek (cheap-tier) response finishes, we fire-and-forget
 * a small Sonnet review call asking it to rate the response 1–10 against
 * the user's actual ask. The score, reasoning, and a "would Sonnet have
 * done this better?" boolean land back in the DB next to the call so we
 * can:
 *
 *   - see in the dashboard which prompts are dropping quality on MiMo,
 *   - tune REASONING_RE / DEV_TASK_RE in router.ts when patterns emerge,
 *   - eventually feed flagged hashes back into the LLM classifier so
 *     similar prompts auto-upgrade next time.
 *
 * Design choices:
 *   - ASYNC: setImmediate-scheduled, never blocks the user response.
 *   - SAMPLED: only a fraction of eligible calls get judged (configurable).
 *   - GATED: skip if response was trivial (no code, short output) or the
 *     call already used Sonnet/Opus (already premium).
 *   - SAFE: judge errors are swallowed; nothing the judge does can break
 *     the proxy.
 *   - CHEAP: Sonnet, not Opus. Tight max_tokens, structured JSON output,
 *     truncated user message and assistant response so the judge call
 *     stays under ~2k tokens.
 */
import { computeCost } from "./pricing.js";
import { type ProviderConfig } from "./providers.js";
import { type Tier } from "./router.js";
import { updateQuality } from "./db.js";

export interface JudgeConfig {
  enabled: boolean;
  /** Probability in [0, 1] of judging an eligible call. */
  sampleRate: number;
  /** Skip judging if completion_tokens < this. */
  minOutputTokens: number;
  /** Skip judging if user prompt has fewer chars (= trivial chat). */
  minUserChars: number;
  /** Hard timeout for the judge HTTP call. */
  timeoutMs: number;
  /** Model to use as the judge. */
  judgeModel: string;
  /** Max chars of the user message we send to the judge. */
  maxUserChars: number;
  /** Max chars of the assistant response we send to the judge. */
  maxResponseChars: number;
  /** Tiers that are eligible for judging. Tiers above this list (code,
   *  reasoning) are skipped because they're already on premium models. */
  eligibleTiers: Set<Tier>;
}

function envFloat(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return dflt;
  const v = Number(raw);
  return Number.isFinite(v) ? v : dflt;
}
function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return dflt;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.floor(v) : dflt;
}

export const DEFAULT_CONFIG: JudgeConfig = {
  enabled: process.env.ROUTER_JUDGE === "1",
  sampleRate: envFloat("ROUTER_JUDGE_SAMPLE", 1.0),
  minOutputTokens: envInt("ROUTER_JUDGE_MIN_OUTPUT_TOKENS", 100),
  minUserChars: envInt("ROUTER_JUDGE_MIN_USER_CHARS", 30),
  timeoutMs: envInt("ROUTER_JUDGE_TIMEOUT_MS", 12_000),
  judgeModel:
    process.env.ROUTER_JUDGE_MODEL ?? "anthropic/claude-sonnet-4.6",
  maxUserChars: envInt("ROUTER_JUDGE_MAX_USER_CHARS", 4_000),
  maxResponseChars: envInt("ROUTER_JUDGE_MAX_RESPONSE_CHARS", 6_000),
  eligibleTiers: new Set<Tier>(["cheap", "agentic"]),
};

const SYSTEM_PROMPT = `You are a strict code-quality auditor. You will be \
shown the latest user message in a coding-assistant conversation and the \
assistant's response. Rate the response on a 1-10 scale where:

  1-3  = wrong, harmful, or completely missed the user's ask
  4-6  = partially correct or shallow; a stronger model would do meaningfully better
  7-8  = solid, correct, reasonable for the ask
  9-10 = excellent: precise, complete, and clearly better than a routine answer

Penalize: incorrect code, made-up APIs, missing edge cases, vague hand-wavy \
answers, ignoring the user's actual request, repeating the question without \
answering.

Reward: correct working code, accurate reasoning, addressing exactly what \
was asked, including edge cases when relevant.

Reply with ONLY a JSON object in this exact shape and nothing else:

{"score": <int 1-10>, "reasons": "<one short sentence>", "better_with_sonnet": <true|false>}

The "better_with_sonnet" flag should be true ONLY if you believe a stronger \
model (Claude Sonnet or Opus) would have done a materially better job on \
this specific ask. Default to false when in doubt.`;

interface JudgeContext {
  /** DB row id of the call being judged. */
  callId: number;
  /** Tier the call actually ran on. */
  tier: Tier;
  /** Latest user message text. */
  userText: string;
  /** Assistant response text (for streamed responses, the concatenated
   *  delta content). */
  responseText: string;
  /** completion_tokens reported by the upstream. */
  outputTokens: number;
}

/**
 * Decide whether a finished call is eligible for judging. Cheap, sync.
 * `random` is injected for tests.
 */
export function shouldJudge(
  ctx: JudgeContext,
  cfg: JudgeConfig = DEFAULT_CONFIG,
  random: () => number = Math.random,
): boolean {
  if (!cfg.enabled) return false;
  if (!cfg.eligibleTiers.has(ctx.tier)) return false;
  if (ctx.outputTokens < cfg.minOutputTokens) return false;
  if (ctx.userText.length < cfg.minUserChars) return false;
  if (ctx.responseText.length < 40) return false;
  // Only judge when there's some substance: code fence, file path, or
  // tool-call style output. Skip plain "I see, what would you like?"-type
  // acknowledgements.
  const looksSubstantive =
    /```/.test(ctx.responseText) ||
    /\b\w+\.(?:ts|tsx|js|jsx|py|rs|go|sql|md|json|yaml)\b/i.test(
      ctx.responseText,
    ) ||
    ctx.responseText.length >= 400;
  if (!looksSubstantive) return false;
  if (random() >= cfg.sampleRate) return false;
  return true;
}

interface JudgeResult {
  score: number;
  reasons: string;
  better_with_sonnet: boolean;
}

/** Best-effort JSON parse of the judge's reply. Returns null if it can't
 *  recover a score in 1..10. */
function parseJudgeReply(raw: string): JudgeResult | null {
  if (!raw) return null;
  // Strip markdown fences the model sometimes wraps things in.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  // Try direct parse first, then fall back to the first {...} block.
  let obj: Record<string, unknown> | null = null;
  try {
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        obj = JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const scoreRaw = obj.score;
  const score = typeof scoreRaw === "number" ? Math.round(scoreRaw) : NaN;
  if (!Number.isFinite(score) || score < 1 || score > 10) return null;
  const reasons =
    typeof obj.reasons === "string" ? obj.reasons.slice(0, 500) : "";
  const better_with_sonnet =
    obj.better_with_sonnet === true || obj.better_with_sonnet === "true";
  return { score, reasons, better_with_sonnet };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the judge against a captured call. Persists the result via
 * `updateQuality()` on success. Errors are logged but never thrown; this
 * is a fire-and-forget background task.
 */
export async function runJudge(
  ctx: JudgeContext,
  providers: Record<string, ProviderConfig>,
  cfg: JudgeConfig = DEFAULT_CONFIG,
  /** Test-only override for the persistence layer. */
  persist: (u: Parameters<typeof updateQuality>[0]) => void = updateQuality,
): Promise<{ ran: boolean; result: JudgeResult | null; costUsd: number }> {
  const target = providers["openrouter"];
  if (!target || !target.apiKey) {
    return { ran: false, result: null, costUsd: 0 };
  }

  const userTrim = ctx.userText.slice(0, cfg.maxUserChars);
  const respTrim = ctx.responseText.slice(0, cfg.maxResponseChars);

  const userPrompt =
    `USER MESSAGE:\n${userTrim}\n\n` +
    `ASSISTANT RESPONSE:\n${respTrim}\n\n` +
    `Rate the assistant response.`;

  const body = {
    model: cfg.judgeModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 200,
    temperature: 0,
    stream: false,
    usage: { include: true },
    response_format: { type: "json_object" },
  };

  let result: JudgeResult | null = null;
  let costUsd = 0;

  try {
    const resp = await fetchWithTimeout(
      `${target.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${target.apiKey}`,
          ...target.extraHeaders,
        },
        body: JSON.stringify(body),
      },
      cfg.timeoutMs,
    );
    if (!resp.ok) {
      console.warn(`[judge] non-OK response: ${resp.status}`);
      return { ran: true, result: null, costUsd: 0 };
    }
    const json = (await resp.json()) as Record<string, unknown>;
    const choices = json.choices as
      | Array<{ message?: { content?: string } }>
      | undefined;
    const out = String(choices?.[0]?.message?.content ?? "");
    result = parseJudgeReply(out);

    const usage = (json.usage ?? {}) as Record<string, unknown>;
    if (typeof usage.cost === "number" && usage.cost > 0) {
      costUsd = usage.cost;
    } else {
      const promptT =
        typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
      const completionT =
        typeof usage.completion_tokens === "number"
          ? usage.completion_tokens
          : 0;
      if (promptT > 0 || completionT > 0) {
        costUsd = computeCost(cfg.judgeModel, promptT, completionT);
      }
    }
  } catch (err) {
    console.warn("[judge] error (ignored):", err);
    return { ran: true, result: null, costUsd: 0 };
  }

  if (result) {
    try {
      persist({
        call_id: ctx.callId,
        score: result.score,
        reasons: result.reasons,
        better_with_sonnet: result.better_with_sonnet,
        judge_model: cfg.judgeModel,
        judge_cost_usd: costUsd,
      });
    } catch (err) {
      console.warn("[judge] persist failed:", err);
    }
  } else {
    console.warn("[judge] could not parse score from judge reply");
  }

  return { ran: true, result, costUsd };
}

/**
 * Schedule a judge run on the next tick so the user response is never
 * delayed. Eligibility is checked synchronously before scheduling.
 */
export function scheduleJudge(
  ctx: JudgeContext,
  providers: Record<string, ProviderConfig>,
  cfg: JudgeConfig = DEFAULT_CONFIG,
): boolean {
  if (!shouldJudge(ctx, cfg)) return false;
  // setImmediate so it runs after the current request handler returns.
  setImmediate(() => {
    runJudge(ctx, providers, cfg).catch((err) => {
      console.warn("[judge] unexpected error:", err);
    });
  });
  return true;
}

/** Test-only: directly expose parser for unit tests. */
export const _internal = { parseJudgeReply };
