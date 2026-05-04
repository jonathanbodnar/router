/**
 * Reasoning controls for OpenRouter-mediated models.
 *
 * Models like Xiaomi MiMo V2.5 Pro and Anthropic's extended-thinking
 * variants run an internal chain-of-thought before emitting visible
 * content or tool calls.
 *
 * This module does three things:
 *
 *   1. **Dynamic effort classification** — decides low / medium / high
 *      reasoning effort based on what the user is actually asking for.
 *      A CSS rename doesn't need the same thinking budget as "build a
 *      new feature end-to-end."
 *
 *   2. **Effort injection** — augments the outbound request body with
 *      `reasoning: { effort }` when the client didn't already set one,
 *      and the routed model supports it.
 *
 *   3. **Reasoning stripping** — removes `reasoning` / `reasoning_details`
 *      fields from response payloads before forwarding to the client.
 *      Cursor and most OpenAI-compat clients don't render them, and the
 *      chain-of-thought wire payload dwarfs the actual content.
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
  "xiaomi/mimo-v2.5-pro",
  "anthropic/claude-opus-4.7",
]);

/**
 * Static fallback per model. Used when the global env override is set
 * OR when classifyEffort would otherwise be skipped. Models not in the
 * set get no injection at all (provider default).
 */
export const REASONING_EFFORT_DEFAULTS: Record<string, ReasoningEffort> = {
  "xiaomi/mimo-v2.5-pro": "low",
  "anthropic/claude-opus-4.7": "high",
};

/* ------------------------------------------------------------------ */
/*  Dynamic effort classification                                     */
/* ------------------------------------------------------------------ */

/**
 * Signals that the task is trivial / mechanical — no deep thinking
 * needed. Rename, CSS tweak, import fix, comment update, etc.
 */
const LOW_RE = new RegExp(
  [
    // cosmetic / style
    "\\b(?:css|style|color|colour|font|padding|margin|spacing|border|width|height|display|flex|grid|opacity|shadow|radius|z-index|background|align|justify|gap|text-align|hover|transition|animation)\\b",
    // rename / move
    "\\brename\\b",
    "\\bmove (?:this|the|a) (?:file|folder|component|function|variable)",
    "\\b(?:copy|delete|remove) (?:this|the|a) (?:file|folder|line|import)",
    // typo / formatting
    "\\b(?:typo|spelling|grammar|lint|prettier|eslint|whitespace|indent)\\b",
    "\\b(?:format|reformat) (?:the |this )?(?:code|file|files)\\b",
    // simple import/export
    "\\b(?:add|remove|update|fix) (?:the |an? )?import",
    "\\bexport (?:this|the|default)",
    // comment / doc
    "\\b(?:add|update|remove|fix) (?:a |the )?comment",
    // simple questions
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
    // creation / new work
    "\\bbuild (?:a |the |this |out )?",
    "\\bcreate (?:a |the |this )?(?:new )?",
    "\\bimplement (?:a |the |this )?(?:new )?",
    "\\bnew (?:feature|component|page|endpoint|hook|module|service|api|route|screen|view|table|migration|function)\\b",
    "\\bfrom scratch\\b",
    "\\bscaffold\\b",
    "\\bbootstrap\\b",
    "\\bset up\\b",
    // integration / wiring
    "\\bintegrate\\b",
    "\\bwire (?:up|together|in)\\b",
    "\\bend[- ]to[- ]end\\b",
    "\\bmulti[- ]?file\\b",
    // caution signals = complex task
    "\\bmake sure (?:it |this |to )?(?:doesn'?t|does not) break\\b",
    "\\bbe careful\\b",
    "\\bdon'?t (?:break|conflict|duplicate|regress)\\b",
    "\\bavoid (?:breaking|conflicts|regressions|bugs)\\b",
    // substantial refactor (not "small refactor")
    "\\b(?:large|major|big|full|complete|comprehensive) refactor\\b",
    // migration
    "\\bmigrat(?:e|ion)\\b",
  ].join("|"),
  "i",
);

/**
 * Classify the reasoning effort a model should use for this request.
 *
 * @param userText  The latest user message (already extracted upstream).
 * @param toolCount Number of tools attached to the request.
 * @param tier      The routing tier the request was assigned to.
 * @returns         The recommended `reasoning.effort` level.
 */
export function classifyEffort(
  userText: string,
  toolCount: number,
  tier: Tier,
): ReasoningEffort {
  const userTokens = Math.ceil((userText?.length ?? 0) / 4);

  // Opus: you're already paying for it — always think hard.
  if (tier === "reasoning") return "high";

  // Non-reasoning-capable tiers: effort param is ignored, but return
  // a sensible value for logging.
  if (tier === "cheap" || tier === "code") return "low";

  // ---- agentic (MiMo) tier: dynamic classification ----

  const isHighSignal = HIGH_RE.test(userText);

  // HIGH signals always win, regardless of message length.
  if (isHighSignal) return "high";

  // Very short user message + tools present = tool-call continuation
  // (read file, run command, etc.) — no thinking needed.
  if (userTokens < 30 && toolCount > 0) return "low";

  // Trivial / mechanical signals, but only for short messages.
  // Longer messages that happen to mention "css" might have more
  // going on, so we don't auto-low them.
  if (LOW_RE.test(userText) && userTokens < 150) return "low";

  // Longer user messages with no strong keyword signal are likely
  // moderate dev work — bug fixes, small feature adjustments, edits.
  if (userTokens > 80) return "medium";

  // Short message, no strong signal, no tools — still medium if
  // there's enough content to suggest a real task.
  if (userTokens > 30) return "medium";

  // Very short, no keywords = low.
  return "low";
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
 * @param effort  The dynamically classified effort (from classifyEffort).
 *                If null, falls back to the static per-model default.
 */
export function withReasoningEffort<B extends { reasoning?: unknown }>(
  body: B,
  model: string,
  effort: ReasoningEffort | null,
): B {
  // Respect anything the client (or our normaliser) already set.
  if (body.reasoning && typeof body.reasoning === "object") return body;

  // Global env override wins everything.
  const envOverride = envEffort();
  if (envOverride) {
    if (!REASONING_CAPABLE_MODELS.has(model)) return body;
    return { ...body, reasoning: { effort: envOverride } };
  }

  // Dynamic effort from classifier, falling back to static default.
  const resolved = effort ?? REASONING_EFFORT_DEFAULTS[model] ?? null;
  if (!resolved) return body;
  if (!REASONING_CAPABLE_MODELS.has(model)) return body;

  return { ...body, reasoning: { effort: resolved } };
}

/* ------------------------------------------------------------------ */
/*  Reasoning stripping                                               */
/* ------------------------------------------------------------------ */

/** Whether to strip reasoning fields from the response we forward. */
export function shouldStripReasoning(): boolean {
  return process.env.ROUTER_KEEP_REASONING !== "1";
}

/**
 * Strip `reasoning` and `reasoning_details` from a delta object (streaming
 * chunk) or a message object (non-streaming response). Mutates the object
 * in place. Returns `true` if anything was removed.
 */
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
