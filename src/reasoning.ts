/**
 * Reasoning controls for OpenRouter-mediated models.
 *
 * Models like Xiaomi MiMo V2.5 Pro and Anthropic's extended-thinking
 * variants run an internal chain-of-thought before emitting visible
 * content or tool calls. With OpenRouter's defaults (`high` effort) MiMo
 * regularly burns 1–2 minutes of internal reasoning per turn, which
 * makes Cursor look hung even though the request is healthy and
 * streaming.
 *
 * This module:
 *   1. Injects a sane default `reasoning.effort` on outbound requests
 *      for models that have a reasoning loop, when the client didn't
 *      already set one.
 *   2. Strips `reasoning` / `reasoning_details` fields from streamed
 *      deltas and non-streaming messages before forwarding to the
 *      client. Cursor (and most OpenAI-compatible clients) don't render
 *      reasoning, and the chain-of-thought wire payload can dwarf the
 *      actual content by 10–100x.
 *
 * Both behaviours are env-overridable:
 *   - ROUTER_REASONING_EFFORT={low|medium|high}   global override
 *   - ROUTER_KEEP_REASONING=1                     keep the fields on the wire
 */

export type ReasoningEffort = "low" | "medium" | "high";

/**
 * Per-model defaults. Add a model id here to opt it into a non-default
 * effort level. Anything not in the table is left alone.
 */
export const REASONING_EFFORT_DEFAULTS: Record<string, ReasoningEffort> = {
  "xiaomi/mimo-v2.5-pro": "low",
};

function envEffort(): ReasoningEffort | null {
  const e = process.env.ROUTER_REASONING_EFFORT;
  return e === "low" || e === "medium" || e === "high" ? e : null;
}

/**
 * Return the body augmented with a `reasoning.effort` setting if we have
 * a default for this model and the client didn't already provide one.
 *
 * The body is shallow-copied so the caller can use it immutably.
 */
export function withReasoningEffort<B extends { reasoning?: unknown }>(
  body: B,
  model: string,
): B {
  // Respect anything the client (or our normaliser) already set.
  if (body.reasoning && typeof body.reasoning === "object") return body;

  const effort = envEffort() ?? REASONING_EFFORT_DEFAULTS[model] ?? null;
  if (!effort) return body;

  return { ...body, reasoning: { effort } };
}

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
