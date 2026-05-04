/**
 * Reasoning controls for OpenRouter-mediated models.
 *
 * Models like Xiaomi MiMo V2.5 Pro and Anthropic's extended-thinking
 * variants run an internal chain-of-thought before emitting visible
 * content or tool calls.
 *
 * This module does four things:
 *
 *   1. **Dynamic effort classification** — decides low / medium / high
 *      reasoning effort based on what the user is actually asking for.
 *      (Only injected for models that support `reasoning.effort`.)
 *
 *   2. **Effort injection** — augments the outbound request body with
 *      `reasoning: { effort }` when the model supports it.
 *
 *   3. **Reasoning stripping** — removes `reasoning` / `reasoning_details`
 *      from response payloads before forwarding to the client.
 *
 *   4. **Heartbeat model set** — exported so the streaming layer can
 *      inject synthetic content tokens while the model thinks, keeping
 *      Cursor alive (it sees "gpt-4.1" and expects fast content).
 *
 * Env overrides:
 *   - ROUTER_REASONING_EFFORT={low|medium|high}   force a single level
 *   - ROUTER_KEEP_REASONING=1                     keep the fields on wire
 */

import type { Tier } from "./router.js";

export type ReasoningEffort = "low" | "medium" | "high";

/* ------------------------------------------------------------------ */
/*  Models that support the reasoning.effort parameter                */
/* ------------------------------------------------------------------ */

const REASONING_CAPABLE_MODELS = new Set([
  "anthropic/claude-opus-4.7",
]);

/**
 * Static fallback per model. Used when the global env override is set
 * OR when classifyEffort would otherwise be skipped. Models not in the
 * set get no injection at all (provider default).
 */
export const REASONING_EFFORT_DEFAULTS: Record<string, ReasoningEffort> = {
  "anthropic/claude-opus-4.7": "high",
};

/**
 * Models that think before producing content. The streaming layer
 * injects synthetic " " content tokens every ~2s while MiMo (etc.)
 * is in its reasoning phase so Cursor doesn't timeout and retry.
 *
 * OpenRouter doesn't support `reasoning.effort` for these models —
 * they just think natively. We leave the request body untouched
 * (no `reasoning` field injected) and handle the delay client-side.
 */
export const HEARTBEAT_MODELS = new Set([
  "xiaomi/mimo-v2.5-pro",
]);

/* ------------------------------------------------------------------ */
/*  Dynamic effort classification                                     */
/* ------------------------------------------------------------------ */

/**
 * Signals that the task is trivial / mechanical — no deep thinking
 * needed. Rename, CSS tweak, import fix, comment update, etc.
 */
const LOW_RE = new RegExp(
  [
    "\\b(?:css|style|color|colour|font|padding|margin|spacing|border|width|height|display|flex|grid|opacity|shadow|radius|z-index|background|align|justify|gap|text-align|hover|transition|animation)\\b",
    "\\brename\\b",
    "\\bmove (?:this|the|a) (?:file|folder|component|function|variable)",
    "\\b(?:copy|delete|remove) (?:this|the|a) (?:file|folder|line|import)",
    "\\b(?:typo|spelling|grammar|lint|prettier|eslint|whitespace|indent)\\b",
    "\\b(?:format|reformat) (?:the |this )?(?:code|file|files)\\b",
    "\\b(?:add|remove|update|fix) (?:the |an? )?import",
    "\\bexport (?:this|the|default)",
    "\\b(?:add|update|remove|fix) (?:a |the )?comment",
    "\\bwhat (?:is|does) (?:this|the)\\b",
    "\\bwhere (?:is|are) (?:this|the)\\b",
    "\\b(?:show|list|find|search for) (?:me )?(?:the |all )?",
  ].join("|"),
  "i",
);

/**
 * Signals the task creates new things or needs careful planning to
 * avoid breaking existing code.
 */
const HIGH_RE = new RegExp(
  [
    "\\bbuild (?:a |the |this |out )?",
    "\\bcreate (?:a |the |this )?(?:new )?",
    "\\bimplement (?:a |the |this )?(?:new )?",
    "\\bnew (?:feature|component|page|endpoint|hook|module|service|api|route|screen|view|table|migration|function)\\b",
    "\\bfrom scratch\\b",
    "\\bscaffold\\b",
    "\\bbootstrap\\b",
    "\\bset up\\b",
    "\\bintegrate\\b",
    "\\bwire (?:up|together|in)\\b",
    "\\bend[- ]to[- ]end\\b",
    "\\bmulti[- ]?file\\b",
    "\\bmake sure (?:it |this |to )?(?:doesn'?t|does not) break\\b",
    "\\bbe careful\\b",
    "\\bdon'?t (?:break|conflict|duplicate|regress)\\b",
    "\\bavoid (?:breaking|conflicts|regressions|bugs)\\b",
    "\\b(?:large|major|big|full|complete|comprehensive) refactor\\b",
    "\\bmigrat(?:e|ion)\\b",
  ].join("|"),
  "i",
);

/**
 * Classify the reasoning effort a model should use for this request.
 * Only actually injected for REASONING_CAPABLE_MODELS (Opus).
 * For HEARTBEAT_MODELS (MiMo), the value is logged but not sent
 * upstream — MiMo doesn't support effort levels.
 */
export function classifyEffort(
  userText: string,
  toolCount: number,
  tier: Tier,
): ReasoningEffort {
  const userTokens = Math.ceil((userText?.length ?? 0) / 4);

  if (tier === "reasoning") return "high";
  if (tier === "cheap" || tier === "code") return "low";

  // ---- agentic (MiMo) tier: dynamic classification ----
  const isHighSignal = HIGH_RE.test(userText);
  if (isHighSignal) return "high";

  const isAgentMode = toolCount >= 10;
  const floor: ReasoningEffort = isAgentMode ? "medium" : "low";

  if (!isAgentMode && userTokens < 30 && toolCount > 0) return "low";
  if (!isAgentMode && LOW_RE.test(userText) && userTokens < 150) return "low";
  if (userTokens > 80) return "medium";
  if (userTokens > 30) return "medium";

  return floor;
}

/* ------------------------------------------------------------------ */
/*  Effort injection                                                  */
/* ------------------------------------------------------------------ */

function envEffort(): ReasoningEffort | null {
  const e = process.env.ROUTER_REASONING_EFFORT;
  return e === "low" || e === "medium" || e === "high" ? e : null;
}

/**
 * Augment the request body with `reasoning: { effort }` when the model
 * supports it and the client didn't already set one.
 *
 * HEARTBEAT_MODELS (MiMo) are left untouched — they don't support
 * effort levels. Their thinking delay is handled by the streaming
 * heartbeat in index.ts.
 */
export function withReasoningEffort<B extends { reasoning?: unknown }>(
  body: B,
  model: string,
  effort: ReasoningEffort | null,
): B {
  if (body.reasoning && typeof body.reasoning === "object") return body;

  // MiMo etc. — don't inject anything, let it think natively.
  if (HEARTBEAT_MODELS.has(model)) return body;

  const envOverride = envEffort();
  if (envOverride) {
    if (!REASONING_CAPABLE_MODELS.has(model)) return body;
    return { ...body, reasoning: { effort: envOverride } };
  }

  const resolved = effort ?? REASONING_EFFORT_DEFAULTS[model] ?? null;
  if (!resolved) return body;
  if (!REASONING_CAPABLE_MODELS.has(model)) return body;

  return { ...body, reasoning: { effort: resolved } };
}

/* ------------------------------------------------------------------ */
/*  Reasoning stripping                                               */
/* ------------------------------------------------------------------ */

export function shouldStripReasoning(): boolean {
  return process.env.ROUTER_KEEP_REASONING !== "1";
}

export function stripReasoningInPlace(obj: Record<string, unknown>): boolean {
  let mutated = false;
  if ("reasoning" in obj) {
    delete obj.reasoning;
    mutated = true;
  }
  if ("reasoning_details" in obj) {
    delete obj.reasoning_details;
    mutated = true;
  }
  return mutated;
}
