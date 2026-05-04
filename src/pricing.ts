/**
 * Per-model pricing (USD per 1M tokens), used for providers that don't
 * return cost in the response.
 *
 * - OpenRouter returns `usage.cost` directly, so the dashboard cost for
 *   OpenRouter calls is whatever they actually charged us — no entry needed
 *   here.
 * - Fireworks does NOT return cost, so we compute it from token counts
 *   using the table below. Defaults are best-effort placeholders — confirm
 *   against the current Fireworks rate card and either edit this file or
 *   override via env vars (PRICE_DEEPSEEK_V4_INPUT / _OUTPUT).
 */

export interface ModelPricing {
  input_per_1m: number;
  output_per_1m: number;
}

function num(v: string | undefined, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export const PRICING: Record<string, ModelPricing> = {
  // Fireworks-hosted DeepSeek V4 Pro. Update these to whatever Fireworks
  // is actually charging you per 1M tokens.
  "accounts/fireworks/models/deepseek-v4-pro": {
    input_per_1m: num(process.env.PRICE_DEEPSEEK_V4_INPUT, 0.5),
    output_per_1m: num(process.env.PRICE_DEEPSEEK_V4_OUTPUT, 1.5),
  },
};

export function computeCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = PRICING[model];
  if (!p) return 0;
  return (
    (promptTokens / 1_000_000) * p.input_per_1m +
    (completionTokens / 1_000_000) * p.output_per_1m
  );
}
