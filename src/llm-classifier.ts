/**
 * Hybrid classifier: when the heuristic in `router.ts` is *uncertain* about
 * a request, we ask a cheap, fast LLM to label it as easy / moderate / hard.
 * The result can only ever UPGRADE the heuristic decision (cheap/agentic ->
 * code or reasoning) — we never downgrade, because that would override an
 * explicit code signal.
 *
 * The classifier:
 *
 *   - runs only inside a narrow "uncertain band" (medium-sized prompts with
 *     no strong reasoning signal already detected),
 *   - is gated by ROUTER_LLM_CLASSIFIER (default on, set to "0" to disable),
 *   - has a hard timeout (default 1500ms) so it can't stall a request,
 *   - caches results by content hash for 5 minutes so retries / streaming
 *     reconnects don't pay for duplicate classifications,
 *   - prefers Fireworks DeepSeek-V4-Pro (cheapest in our stack) for the
 *     classification call itself, falling back to OpenRouter MiMo if
 *     Fireworks isn't configured.
 */
import { computeCost } from "./pricing.js";
import { type ProviderConfig } from "./providers.js";
import {
  MODELS,
  type IncomingRequest,
  type RouteDecision,
  type Tier,
} from "./router.js";

export type Difficulty = "easy" | "moderate" | "hard";

export interface ClassifierConfig {
  enabled: boolean;
  timeoutMs: number;
  /** Min approx-input-tokens to bother classifying. Below this the prompt
   *  is too small to be hard regardless of phrasing. */
  minTokens: number;
  /** Above this the heuristic already escalates on size, so no need to ask. */
  maxTokens: number;
  cacheTtlMs: number;
  cacheMax: number;
  /** Max chars of the user message to send to the classifier. */
  maxPromptChars: number;
}

export const DEFAULT_CONFIG: ClassifierConfig = {
  enabled: process.env.ROUTER_LLM_CLASSIFIER !== "0",
  timeoutMs: Number(process.env.ROUTER_LLM_CLASSIFIER_TIMEOUT_MS ?? 1500),
  minTokens: Number(process.env.ROUTER_LLM_CLASSIFIER_MIN_TOKENS ?? 800),
  maxTokens: Number(process.env.ROUTER_LLM_CLASSIFIER_MAX_TOKENS ?? 8000),
  cacheTtlMs: 5 * 60 * 1000,
  cacheMax: 500,
  maxPromptChars: 4000,
};

const SYSTEM_PROMPT =
  "You are a routing classifier for a coding assistant. Given the user's " +
  "latest message, label the task with EXACTLY one of these words and " +
  "nothing else:\n" +
  '- "easy": casual question, simple change, small scope (single file, ' +
  "trivial logic, well-understood).\n" +
  '- "moderate": substantive coding work — debugging, multi-file edits, ' +
  "writing a new function/component with real logic, structured reasoning " +
  "about a small system.\n" +
  '- "hard": architecture, system design, distributed-systems reasoning, ' +
  "complex refactor, performance/concurrency analysis, security analysis, " +
  '"must be excellent" output where mistakes are expensive.\n\n' +
  'Respond with ONLY one word: "easy", "moderate", or "hard".';

interface CacheEntry {
  difficulty: Difficulty | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function lastUserText(req: IncomingRequest): string {
  const messages = req.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }
  return "";
}

/** Fast non-cryptographic hash (FNV-1a 32-bit). */
function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

function shouldClassify(
  decision: RouteDecision,
  cfg: ClassifierConfig,
): boolean {
  if (!cfg.enabled) return false;
  if (decision.tier !== "cheap" && decision.tier !== "agentic") return false;
  if (decision.approxInputTokens < cfg.minTokens) return false;
  if (decision.approxInputTokens > cfg.maxTokens) return false;
  return true;
}

/**
 * Pick which provider/model to use for the classification call. We prefer
 * the absolute cheapest available; if neither provider is configured we
 * return null and skip classification.
 */
function pickClassifierTarget(
  providers: Record<string, ProviderConfig>,
): { provider: ProviderConfig; model: string } | null {
  // Default: Fireworks DeepSeek (same as our cheap tier).
  const fw = providers["fireworks"];
  if (fw && fw.apiKey) {
    return { provider: fw, model: MODELS.cheap.model };
  }
  const or = providers["openrouter"];
  if (or && or.apiKey) {
    return { provider: or, model: MODELS.agentic.model };
  }
  return null;
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

interface ClassifyResult {
  difficulty: Difficulty | null;
  cached: boolean;
  durationMs: number;
  costUsd: number;
}

async function classifyDifficulty(
  req: IncomingRequest,
  providers: Record<string, ProviderConfig>,
  cfg: ClassifierConfig,
): Promise<ClassifyResult> {
  const t0 = Date.now();
  const text = lastUserText(req);
  if (!text || text.length < 30) {
    return { difficulty: null, cached: false, durationMs: 0, costUsd: 0 };
  }

  const trimmed = text.length > cfg.maxPromptChars
    ? text.slice(0, cfg.maxPromptChars)
    : text;
  const key = hashText(trimmed);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return {
      difficulty: hit.difficulty,
      cached: true,
      durationMs: 0,
      costUsd: 0,
    };
  }

  const target = pickClassifierTarget(providers);
  if (!target) {
    return { difficulty: null, cached: false, durationMs: 0, costUsd: 0 };
  }

  const body = {
    model: target.model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: trimmed },
    ],
    max_tokens: 4,
    temperature: 0,
    stream: false,
  };

  let difficulty: Difficulty | null = null;
  let costUsd = 0;
  try {
    const resp = await fetchWithTimeout(
      `${target.provider.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${target.provider.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      cfg.timeoutMs,
    );
    if (resp.ok) {
      const json = (await resp.json()) as Record<string, unknown>;
      const choices = json.choices as Array<{ message?: { content?: string } }> | undefined;
      const out = String(choices?.[0]?.message?.content ?? "")
        .trim()
        .toLowerCase();
      if (out.startsWith("hard")) difficulty = "hard";
      else if (out.startsWith("mod")) difficulty = "moderate";
      else if (out.startsWith("easy")) difficulty = "easy";

      // Capture cost so we can attribute it to the call.
      const usage = (json.usage ?? {}) as Record<string, unknown>;
      const promptT = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
      const completionT = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
      if (typeof usage.cost === "number" && usage.cost > 0) {
        costUsd = usage.cost;
      } else if (promptT > 0 || completionT > 0) {
        costUsd = computeCost(target.model, promptT, completionT);
      }
    }
  } catch {
    // Network error / timeout / abort — silently fall through. The caller
    // will keep using the heuristic decision.
  }

  if (cache.size >= cfg.cacheMax) {
    const firstKey = cache.keys().next().value;
    if (firstKey != null) cache.delete(firstKey);
  }
  cache.set(key, { difficulty, expiresAt: now + cfg.cacheTtlMs });

  return {
    difficulty,
    cached: false,
    durationMs: Date.now() - t0,
    costUsd,
  };
}

export interface UpgradeResult {
  decision: RouteDecision;
  upgraded: boolean;
  difficulty: Difficulty | null;
  cached: boolean;
  durationMs: number;
  classifierCostUsd: number;
}

/**
 * If the heuristic decision lands in the uncertain band, ask the classifier.
 * Only ever UPGRADES — we never downgrade an already-substantial decision.
 */
export async function maybeUpgradeWithLLM(
  req: IncomingRequest,
  decision: RouteDecision,
  providers: Record<string, ProviderConfig>,
  cfg: ClassifierConfig = DEFAULT_CONFIG,
): Promise<UpgradeResult> {
  if (!shouldClassify(decision, cfg)) {
    return {
      decision,
      upgraded: false,
      difficulty: null,
      cached: false,
      durationMs: 0,
      classifierCostUsd: 0,
    };
  }

  const { difficulty, cached, durationMs, costUsd } = await classifyDifficulty(
    req,
    providers,
    cfg,
  );

  let upgradedTier: Tier | null = null;
  if (difficulty === "hard") upgradedTier = "reasoning";
  else if (difficulty === "moderate") upgradedTier = "code";

  if (!upgradedTier || upgradedTier === decision.tier) {
    return {
      decision,
      upgraded: false,
      difficulty,
      cached,
      durationMs,
      classifierCostUsd: costUsd,
    };
  }

  const next = MODELS[upgradedTier];
  return {
    decision: {
      tier: upgradedTier,
      provider: next.provider,
      model: next.model,
      reason: `${decision.reason} -> upgraded to ${upgradedTier} by LLM classifier (${difficulty})`,
      approxInputTokens: decision.approxInputTokens,
    },
    upgraded: true,
    difficulty,
    cached,
    durationMs,
    classifierCostUsd: costUsd,
  };
}

/** Test-only: clear the in-process cache. */
export function _resetClassifierCache(): void {
  cache.clear();
}
