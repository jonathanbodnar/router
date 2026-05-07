/**
 * Unit tests for:
 *   1. parsePromptOverride  — `!alias` / `[alias]` prefix on last user message
 *   2. maybeUpgradeWithLLM  — hybrid LLM classifier with mocked fetch
 *
 * Both run fully offline (no network, no env vars required).
 */

import { parsePromptOverride } from "../src/classify.js";
import {
  _resetClassifierCache,
  DEFAULT_CONFIG,
  maybeUpgradeWithLLM,
} from "../src/llm-classifier.js";
import type { ProviderConfig } from "../src/providers.js";
import { route } from "../src/router.js";

let failed = 0;
const expect = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

/* ============================================================ */
/* 1. parsePromptOverride                                        */
/* ============================================================ */

console.log("\n=== parsePromptOverride ===\n");

{
  const r = parsePromptOverride({
    model: "auto",
    messages: [{ role: "user", content: "!hard plan a refactor of billing" }],
  });
  expect("!hard prefix detected", r?.alias === "hard", `alias=${r?.alias}`);
  expect(
    "tag stripped from message",
    r?.request.messages?.[0]?.content === "plan a refactor of billing",
    `content=${JSON.stringify(r?.request.messages?.[0]?.content)}`,
  );
  expect("model overridden to alias", r?.request.model === "hard");
}

{
  const r = parsePromptOverride({
    model: "gpt-4.1",
    messages: [{ role: "user", content: "[opus]: deep dive on consensus" }],
  });
  expect("[opus] bracket form detected", r?.alias === "opus");
  expect(
    "delimiter consumed",
    r?.request.messages?.[0]?.content === "deep dive on consensus",
    `content=${JSON.stringify(r?.request.messages?.[0]?.content)}`,
  );
}

{
  const r = parsePromptOverride({
    messages: [{ role: "user", content: "!important note for the reader" }],
  });
  expect("unknown alias is ignored", r === null);
}

{
  // Cursor wraps user messages with <timestamp>...</timestamp>\n<user_query>\n
  // before the actual prompt. The override must still match.
  const wrapped =
    "<timestamp>Tuesday, May 5, 2026, 3:16 PM (UTC-5)</timestamp>\n" +
    "<user_query>\n[sonnet] Okay on create payment link, fix the bug\n</user_query>";
  const r = parsePromptOverride({
    model: "auto",
    messages: [{ role: "user", content: wrapped }],
  });
  expect("[sonnet] inside Cursor wrapper detected", r?.alias === "sonnet", `alias=${r?.alias}`);
  expect("model overridden to sonnet", r?.request.model === "sonnet");
  const c = r?.request.messages?.[0]?.content;
  expect(
    "tag stripped, wrapper preserved",
    typeof c === "string" && c.includes("Okay on create payment link") && !c.includes("[sonnet]"),
    `content=${JSON.stringify(c)}`,
  );
}

{
  // Same wrapping but with !sonnet bang form
  const wrapped =
    "<timestamp>x</timestamp>\n<user_query>\n!opus refactor billing flow\n</user_query>";
  const r = parsePromptOverride({
    messages: [{ role: "user", content: wrapped }],
  });
  expect("!opus inside wrapper detected", r?.alias === "opus");
}

{
  const r = parsePromptOverride({
    messages: [
      { role: "system", content: "ignore this" },
      { role: "user", content: "first ask" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "!cheap quick follow-up" },
    ],
  });
  expect("uses LAST user message", r?.alias === "cheap");
  expect(
    "earlier user messages preserved",
    r?.request.messages?.[1]?.content === "first ask",
  );
}

{
  // Array-form content (Cursor / OpenAI multimodal shape)
  const r = parsePromptOverride({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "!sonnet refactor src/foo.ts" },
        ],
      },
    ],
  });
  expect("alias parsed from array content", r?.alias === "sonnet");
  const c = r?.request.messages?.[0]?.content;
  const first = Array.isArray(c) ? c[0] : null;
  expect(
    "tag stripped inside array part",
    first != null && typeof first === "object" && first.text === "refactor src/foo.ts",
    `content=${JSON.stringify(c)}`,
  );
}

{
  const r = parsePromptOverride({
    messages: [{ role: "user", content: "regular message, no tag" }],
  });
  expect("no tag = no override", r === null);
}

/* ============================================================ */
/* 2. maybeUpgradeWithLLM                                        */
/* ============================================================ */

console.log("\n=== maybeUpgradeWithLLM ===\n");

const realFetch = globalThis.fetch;

function mockFetch(reply: string, opts: { status?: number; latencyMs?: number; throwErr?: boolean } = {}) {
  globalThis.fetch = (async (_url: any, init?: any) => {
    if (opts.latencyMs) {
      const signal: AbortSignal | undefined = init?.signal;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, opts.latencyMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    }
    if (opts.throwErr) throw new Error("boom");
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: reply } }],
        usage: { prompt_tokens: 200, completion_tokens: 1, cost: 0 },
      }),
      { status: opts.status ?? 200, headers: { "content-type": "application/json" } },
    );
  }) as any;
}

const fwProvider: ProviderConfig = {
  name: "fireworks",
  baseUrl: "http://mock",
  apiKey: "mock-key",
  injectUsageInclude: false,
  costFromUsage: false,
  extraHeaders: {},
};
const orProvider: ProviderConfig = {
  name: "openrouter",
  baseUrl: "http://mock",
  apiKey: "mock-key",
  injectUsageInclude: true,
  costFromUsage: true,
  extraHeaders: {},
};
const providers = { fireworks: fwProvider, openrouter: orProvider };
const cfg = { ...DEFAULT_CONFIG, enabled: true, timeoutMs: 1000, minTokens: 100 };

const mediumPrompt = "I have a service with multiple modules. ".repeat(50);

{
  _resetClassifierCache();
  mockFetch("hard");
  const heuristic = route({ model: "auto", messages: [{ role: "user", content: mediumPrompt }] });
  const up = await maybeUpgradeWithLLM(
    { messages: [{ role: "user", content: mediumPrompt }] },
    heuristic,
    providers,
    cfg,
  );
  expect(`heuristic starting tier was upgradable (${heuristic.tier})`,
    heuristic.tier === "cheap" || heuristic.tier === "agentic");
  expect("LLM 'hard' upgrades to reasoning", up.decision.tier === "reasoning",
    `tier=${up.decision.tier}`);
  expect("upgrade flagged", up.upgraded === true);
}

{
  _resetClassifierCache();
  mockFetch("moderate");
  const heuristic = route({ model: "auto", messages: [{ role: "user", content: mediumPrompt }] });
  const up = await maybeUpgradeWithLLM(
    { messages: [{ role: "user", content: mediumPrompt }] },
    heuristic,
    providers,
    cfg,
  );
  expect("LLM 'moderate' upgrades to code", up.decision.tier === "code",
    `tier=${up.decision.tier}`);
}

{
  _resetClassifierCache();
  mockFetch("easy");
  const heuristic = route({ model: "auto", messages: [{ role: "user", content: mediumPrompt }] });
  const up = await maybeUpgradeWithLLM(
    { messages: [{ role: "user", content: mediumPrompt }] },
    heuristic,
    providers,
    cfg,
  );
  expect("LLM 'easy' does NOT downgrade", up.decision.tier === heuristic.tier);
  expect("upgraded=false", up.upgraded === false);
}

{
  // Cache hit: second call to identical text doesn't re-fetch.
  _resetClassifierCache();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "hard" } }],
        usage: {},
      }),
      { status: 200 },
    );
  }) as any;
  const req = { messages: [{ role: "user", content: mediumPrompt }] };
  const heuristic = route({ model: "auto", ...req });
  await maybeUpgradeWithLLM(req, heuristic, providers, cfg);
  await maybeUpgradeWithLLM(req, heuristic, providers, cfg);
  expect("classifier cached after first call", calls === 1, `calls=${calls}`);
}

{
  // Timeout: classifier exceeds budget -> falls back to heuristic.
  _resetClassifierCache();
  mockFetch("hard", { latencyMs: 2000 });
  const tinyCfg = { ...cfg, timeoutMs: 100 };
  const req = { messages: [{ role: "user", content: mediumPrompt }] };
  const heuristic = route({ model: "auto", ...req });
  const up = await maybeUpgradeWithLLM(req, heuristic, providers, tinyCfg);
  expect("timeout -> kept heuristic decision", up.decision.tier === heuristic.tier);
  expect("upgraded=false on timeout", up.upgraded === false);
}

{
  // Network error: graceful fallback.
  _resetClassifierCache();
  mockFetch("", { throwErr: true });
  const req = { messages: [{ role: "user", content: mediumPrompt }] };
  const heuristic = route({ model: "auto", ...req });
  const up = await maybeUpgradeWithLLM(req, heuristic, providers, cfg);
  expect("network error -> kept heuristic", up.decision.tier === heuristic.tier);
}

{
  // Already on Sonnet: classifier is skipped (no second LLM call).
  _resetClassifierCache();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hard" } }], usage: {} }),
      { status: 200 },
    );
  }) as any;
  const heuristicCode = {
    tier: "code" as const,
    provider: "openrouter" as const,
    model: "anthropic/claude-sonnet-4.6",
    reason: "test",
    approxInputTokens: 3000,
  };
  const up = await maybeUpgradeWithLLM(
    { messages: [{ role: "user", content: mediumPrompt }] },
    heuristicCode,
    providers,
    cfg,
  );
  expect("already-code skips classifier (no upgrade call)", calls === 0, `calls=${calls}`);
  expect("decision unchanged", up.decision === heuristicCode);
}

{
  // Disabled flag: classifier never fires.
  _resetClassifierCache();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("{}", { status: 200 });
  }) as any;
  const req = { messages: [{ role: "user", content: mediumPrompt }] };
  const heuristic = route({ model: "auto", ...req });
  await maybeUpgradeWithLLM(req, heuristic, providers, { ...cfg, enabled: false });
  expect("disabled = no fetch", calls === 0);
}

globalThis.fetch = realFetch;

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall classifier tests passed");
