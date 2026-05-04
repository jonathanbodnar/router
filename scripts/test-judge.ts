/**
 * Unit tests for the async sampled quality judge.
 *
 *   - shouldJudge() eligibility gating (tier, output size, sample rate,
 *     substantive-output check, configurability)
 *   - parseJudgeReply() recovers a score from the model's JSON, with or
 *     without markdown fences, and rejects garbage
 *   - runJudge() calls the upstream, parses the response, and persists
 *     via the injected updateQuality function
 *   - failure modes: non-OK response, network error, malformed JSON
 *
 * All offline; no network, no DB.
 */

import {
  DEFAULT_CONFIG as JUDGE_CFG,
  _internal,
  runJudge,
  shouldJudge,
  type JudgeConfig,
} from "../src/judge.js";
import type { ProviderConfig } from "../src/providers.js";

let failed = 0;
const expect = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

/* ============================================================ */
/* 1. shouldJudge                                                */
/* ============================================================ */

console.log("\n=== shouldJudge eligibility ===\n");

const baseCfg: JudgeConfig = {
  ...JUDGE_CFG,
  enabled: true,
  sampleRate: 1.0,
  minOutputTokens: 100,
  minUserChars: 30,
};

const baseCtx = {
  callId: 1,
  tier: "agentic" as const,
  userText: "Please refactor src/billing.ts to use the new payment provider.",
  responseText:
    "Here's the refactored file:\n```ts\nexport function charge() { return new PaymentProvider().charge(); }\n```",
  outputTokens: 250,
};

expect(
  "eligible: agentic + substantive output",
  shouldJudge(baseCtx, baseCfg, () => 0.0),
);

expect(
  "skipped when disabled",
  !shouldJudge(baseCtx, { ...baseCfg, enabled: false }, () => 0.0),
);

expect(
  "skipped when tier is code (already premium)",
  !shouldJudge({ ...baseCtx, tier: "code" }, baseCfg, () => 0.0),
);

expect(
  "skipped when tier is reasoning (already premium)",
  !shouldJudge({ ...baseCtx, tier: "reasoning" }, baseCfg, () => 0.0),
);

expect(
  "skipped when output too short",
  !shouldJudge({ ...baseCtx, outputTokens: 20 }, baseCfg, () => 0.0),
);

expect(
  "skipped when user message too short",
  !shouldJudge({ ...baseCtx, userText: "hi" }, baseCfg, () => 0.0),
);

expect(
  "skipped when response is trivial (no code, short)",
  !shouldJudge(
    { ...baseCtx, responseText: "I'll help you. What would you like me to do?" },
    baseCfg,
    () => 0.0,
  ),
  `responseLen=${"I'll help you. What would you like me to do?".length}`,
);

expect(
  "passes when response is long prose without code",
  shouldJudge(
    {
      ...baseCtx,
      responseText:
        "Here is a thorough analysis of the situation. ".repeat(15),
    },
    baseCfg,
    () => 0.0,
  ),
);

expect(
  "passes when response mentions a file path (even short-ish)",
  shouldJudge(
    {
      ...baseCtx,
      responseText:
        "I updated src/billing.ts to call PaymentProvider.charge() instead of the old API.",
    },
    baseCfg,
    () => 0.0,
  ),
);

{
  // Sample rate gating: 0.5 with random()=0.7 should reject; 0.3 should accept.
  const cfg = { ...baseCfg, sampleRate: 0.5 };
  expect(
    "sample rate rejects when dice > rate",
    !shouldJudge(baseCtx, cfg, () => 0.7),
  );
  expect(
    "sample rate accepts when dice < rate",
    shouldJudge(baseCtx, cfg, () => 0.3),
  );
}

{
  // 0.0 sample rate = always skip
  expect(
    "sample rate 0 always skips",
    !shouldJudge(baseCtx, { ...baseCfg, sampleRate: 0 }, () => 0),
  );
}

/* ============================================================ */
/* 2. parseJudgeReply                                             */
/* ============================================================ */

console.log("\n=== parseJudgeReply ===\n");

const parse = _internal.parseJudgeReply;

{
  const r = parse('{"score": 8, "reasons": "solid working code", "better_with_sonnet": false}');
  expect("plain JSON parsed", r?.score === 8);
  expect("reasons captured", r?.reasons === "solid working code");
  expect("better_with_sonnet false", r?.better_with_sonnet === false);
}

{
  const r = parse(
    '```json\n{"score": 4, "reasons": "missed edge case", "better_with_sonnet": true}\n```',
  );
  expect("markdown-fenced JSON parsed", r?.score === 4);
  expect("better_with_sonnet flag preserved", r?.better_with_sonnet === true);
}

{
  // Trailing prose around a JSON block
  const r = parse(
    'Here is the verdict:\n{"score": 7, "reasons": "fine", "better_with_sonnet": false}\nHope that helps.',
  );
  expect("JSON-in-prose extracted", r?.score === 7);
}

{
  expect("garbage rejected", parse("nope, not a score") === null);
  expect("empty rejected", parse("") === null);
  expect("score out of range rejected", parse('{"score": 99}') === null);
  expect("missing score rejected", parse('{"reasons": "x"}') === null);
  expect("string score rejected", parse('{"score": "eight"}') === null);
}

{
  // Float scores get rounded
  const r = parse('{"score": 7.6, "reasons": "ok", "better_with_sonnet": false}');
  expect("float score rounded to 8", r?.score === 8, `got ${r?.score}`);
}

/* ============================================================ */
/* 3. runJudge                                                    */
/* ============================================================ */

console.log("\n=== runJudge with mocked fetch ===\n");

const realFetch = globalThis.fetch;

interface FakeProviders {
  openrouter: ProviderConfig;
}
const fakeProviders: FakeProviders = {
  openrouter: {
    name: "openrouter",
    baseUrl: "https://fake-openrouter.test/api/v1",
    apiKey: "fake-key",
    injectUsageInclude: true,
    costFromUsage: true,
    extraHeaders: { "x-title": "test" },
  },
};

function setMockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = impl as typeof fetch;
}

function mockJudgeReply(
  body: string,
  status = 200,
  cost?: number,
): Response {
  const json = {
    choices: [{ message: { content: body } }],
    usage: { prompt_tokens: 1500, completion_tokens: 100, ...(cost != null ? { cost } : {}) },
  };
  return new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ctx = {
  callId: 42,
  tier: "agentic" as const,
  userText: "Please refactor src/billing.ts to use the new payment provider.",
  responseText:
    "Here's the diff:\n```ts\n- old.charge();\n+ new PaymentProvider().charge();\n```",
  outputTokens: 250,
};

// Test: judge call succeeds, persists with score
{
  let captured: any = null;
  setMockFetch(async () =>
    mockJudgeReply(
      '{"score": 7, "reasons": "correct refactor", "better_with_sonnet": false}',
      200,
      0.0072,
    ),
  );
  const result = await runJudge(
    ctx,
    fakeProviders as any,
    { ...JUDGE_CFG, enabled: true, judgeModel: "anthropic/claude-sonnet-4.6" },
    (u) => {
      captured = u;
    },
  );
  expect("judge ran", result.ran === true);
  expect("score returned", result.result?.score === 7);
  expect("cost from usage.cost honored", Math.abs(result.costUsd - 0.0072) < 1e-9, `cost=${result.costUsd}`);
  expect("persisted call_id", captured?.call_id === 42);
  expect("persisted score", captured?.score === 7);
  expect("persisted reasons", captured?.reasons === "correct refactor");
  expect("persisted not flagged for sonnet", captured?.better_with_sonnet === false);
  expect("persisted judge model", captured?.judge_model === "anthropic/claude-sonnet-4.6");
}

// Test: judge call returns garbage -> no persist, ran=true
{
  let captured: any = null;
  setMockFetch(async () => mockJudgeReply("not a json reply at all"));
  const result = await runJudge(
    ctx,
    fakeProviders as any,
    { ...JUDGE_CFG, enabled: true },
    (u) => {
      captured = u;
    },
  );
  expect("judge ran but no result on garbage", result.ran === true && result.result === null);
  expect("persist not called on garbage", captured === null);
}

// Test: judge call non-OK -> no persist, ran=true
{
  let captured: any = null;
  setMockFetch(async () =>
    new Response('{"error": "rate limited"}', {
      status: 429,
      headers: { "content-type": "application/json" },
    }),
  );
  const result = await runJudge(
    ctx,
    fakeProviders as any,
    { ...JUDGE_CFG, enabled: true },
    (u) => {
      captured = u;
    },
  );
  expect("non-OK swallowed", result.ran === true && result.result === null);
  expect("persist not called on non-OK", captured === null);
}

// Test: network error -> swallowed
{
  let captured: any = null;
  setMockFetch(async () => {
    throw new Error("ECONNRESET");
  });
  const result = await runJudge(
    ctx,
    fakeProviders as any,
    { ...JUDGE_CFG, enabled: true },
    (u) => {
      captured = u;
    },
  );
  expect("network error swallowed", result.ran === true && result.result === null);
  expect("persist not called on network error", captured === null);
}

// Test: missing OpenRouter provider -> no-op
{
  let captured: any = null;
  let fetchCalls = 0;
  setMockFetch(async () => {
    fetchCalls++;
    return mockJudgeReply('{"score": 7, "reasons": "ok", "better_with_sonnet": false}');
  });
  const result = await runJudge(
    ctx,
    { openrouter: { ...fakeProviders.openrouter, apiKey: "" } } as any,
    { ...JUDGE_CFG, enabled: true },
    (u) => {
      captured = u;
    },
  );
  expect("no API key -> no fetch", fetchCalls === 0);
  expect("no API key -> ran=false", result.ran === false);
  expect("no API key -> persist not called", captured === null);
}

// Test: better_with_sonnet=true is captured and persisted
{
  let captured: any = null;
  setMockFetch(async () =>
    mockJudgeReply(
      '{"score": 4, "reasons": "shallow answer, would benefit from a stronger model", "better_with_sonnet": true}',
    ),
  );
  await runJudge(
    ctx,
    fakeProviders as any,
    { ...JUDGE_CFG, enabled: true },
    (u) => {
      captured = u;
    },
  );
  expect("low-score flagged", captured?.score === 4);
  expect("better_with_sonnet=true persisted", captured?.better_with_sonnet === true);
}

globalThis.fetch = realFetch;

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall judge tests passed");
