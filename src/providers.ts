/**
 * Upstream LLM providers we know how to talk to.
 *
 * All three expose an OpenAI-compatible `/chat/completions` endpoint, so
 * the only differences we care about are:
 *
 *   - the base URL,
 *   - the API key env var,
 *   - whether to inject `usage: {include: true}` (OpenRouter extension),
 *   - whether the response includes `usage.cost` (OpenRouter does;
 *     Fireworks and Anthropic OpenAI-compat don't — we compute cost from
 *     tokens via pricing.ts for those).
 *
 * Direct Anthropic mode (ROUTER_USE_DIRECT_ANTHROPIC=1) routes the
 * `code` and `reasoning` tiers through Anthropic's OpenAI-compatible
 * endpoint instead of OpenRouter. Tradeoffs:
 *
 *   PRO:  one fewer proxy hop -> faster first-token latency
 *   CON:  Anthropic's compat endpoint does NOT support prompt caching
 *         (per docs), so for repeat-prefix workloads (Cursor agent loops)
 *         OpenRouter + cache_control markers is actually cheaper.
 *
 * Recommendation: keep OpenRouter mode (default) unless you specifically
 * want lowest first-token latency on one-shot calls.
 */

export type Provider = "openrouter" | "fireworks" | "anthropic";

export interface ProviderConfig {
  name: Provider;
  baseUrl: string;
  apiKey: string;
  injectUsageInclude: boolean;
  costFromUsage: boolean;
  extraHeaders: Record<string, string>;
}

export function loadProviders(): Record<Provider, ProviderConfig> {
  const orHeaders: Record<string, string> = {};
  if (process.env.OPENROUTER_SITE_URL)
    orHeaders["http-referer"] = process.env.OPENROUTER_SITE_URL;
  if (process.env.OPENROUTER_APP_TITLE)
    orHeaders["x-title"] = process.env.OPENROUTER_APP_TITLE;

  return {
    openrouter: {
      name: "openrouter",
      baseUrl:
        process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY ?? "",
      injectUsageInclude: true,
      costFromUsage: true,
      extraHeaders: orHeaders,
    },
    fireworks: {
      name: "fireworks",
      baseUrl:
        process.env.FIREWORKS_BASE_URL ??
        "https://api.fireworks.ai/inference/v1",
      apiKey: process.env.FIREWORKS_API_KEY ?? "",
      injectUsageInclude: false,
      costFromUsage: false,
      extraHeaders: {},
    },
    anthropic: {
      name: "anthropic",
      baseUrl:
        process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
      apiKey: process.env.ANTHROPIC_API_KEY ?? "",
      injectUsageInclude: false,
      costFromUsage: false,
      extraHeaders: {},
    },
  };
}

/** Detect provider from a model id string (used for passthrough). */
export function detectProvider(modelId: string): Provider {
  if (
    modelId.startsWith("accounts/fireworks/") ||
    modelId.startsWith("fireworks/")
  ) {
    return "fireworks";
  }
  if (modelId.startsWith("claude-")) {
    return "anthropic";
  }
  return "openrouter";
}

/** True when the user has opted into direct-Anthropic for code/reasoning. */
export function useDirectAnthropic(): boolean {
  return (
    process.env.ROUTER_USE_DIRECT_ANTHROPIC === "1" &&
    !!process.env.ANTHROPIC_API_KEY
  );
}
