/**
 * Anthropic prompt caching (via OpenRouter).
 *
 * Background — why this is a big deal for cost:
 *
 *   Cursor's agent loop sends 20-30 chat-completion calls per task. Every
 *   call carries the same ~18k-token system prompt and ~19 tool definitions
 *   plus the growing conversation history. Without caching, Anthropic
 *   charges full input price for that prefix on EVERY call.
 *
 *   With Anthropic prompt caching:
 *     - first request:  cache writes are 1.25x normal input price
 *     - all subsequent: cache reads are 0.1x normal input price
 *     - cache lifetime: 5 minutes (refreshed on each hit)
 *
 *   Net effect over a typical multi-turn task: ~80-90% reduction in input
 *   token cost. This is the single biggest savings the router can deliver,
 *   and it's why a Cursor BYOK Anthropic key feels cheaper than this proxy
 *   today — Cursor injects cache_control markers, we don't.
 *
 * How OpenRouter handles it:
 *
 *   OpenRouter passes `cache_control: {type: "ephemeral"}` markers through
 *   to Anthropic transparently and uses provider-sticky routing so cache
 *   hits land on the same provider instance. We just need to mark the
 *   right blocks.
 *
 * What we mark (Anthropic allows up to 4 breakpoints):
 *
 *   1. The LAST tool definition  (caches the entire tools array)
 *   2. The LAST system message   (caches the system prompt)
 *   3. The LAST assistant/tool   (caches the conversation history except
 *      the latest user turn — gives a hit on the next turn since the
 *      conversation only ever grows by appending)
 *
 * String message contents are auto-converted to a single-text-block array
 * (`[{type: "text", text: "..."}]`) so we have somewhere to attach the
 * marker. OpenRouter accepts both shapes.
 */

import type { ChatMessage, IncomingRequest } from "./router.js";

/**
 * Default-on. Set ROUTER_PROMPT_CACHE=0 to disable globally.
 *
 * Note: Anthropic's OpenAI-compatible endpoint (used by ROUTER_USE_DIRECT_ANTHROPIC=1)
 * does NOT support prompt caching per their docs. We still emit the
 * markers for direct-Anthropic; they're harmless if ignored, and make
 * the request body identical regardless of provider so debugging is easier.
 */
function enabled(): boolean {
  return process.env.ROUTER_PROMPT_CACHE !== "0";
}

/**
 * True when this model is an Anthropic Claude one whose backend honours
 * the `cache_control: ephemeral` marker. Recognises both the OpenRouter
 * id (`anthropic/claude-sonnet-4.6`) and the direct-Anthropic compat id
 * (`claude-sonnet-4-6`).
 */
export function isCacheableModel(model: string): boolean {
  return /(^anthropic\/claude-)|(^claude-)/.test(model);
}

interface ContentBlock {
  type: string;
  text?: string;
  cache_control?: { type: "ephemeral" };
  [k: string]: unknown;
}

function hasCacheControl(obj: Record<string, unknown> | null | undefined): boolean {
  return !!obj && typeof obj === "object" && obj.cache_control != null;
}

/**
 * Take a message and ensure its content's LAST block carries
 * `cache_control: {type: "ephemeral"}`. Strings are wrapped in a
 * single-element typed-parts array so we have somewhere to attach the
 * marker; existing typed-parts arrays just get the last block tagged.
 *
 * Returns a new message; never mutates the input.
 */
function markMessage(msg: ChatMessage): ChatMessage {
  const c = msg.content;
  if (c == null) return msg;
  if (typeof c === "string") {
    if (!c) return msg;
    const block: ContentBlock = {
      type: "text",
      text: c,
      cache_control: { type: "ephemeral" },
    };
    return { ...msg, content: [block] as unknown as ChatMessage["content"] };
  }
  if (Array.isArray(c) && c.length > 0) {
    const last = c[c.length - 1];
    if (!last || typeof last !== "object" || hasCacheControl(last)) return msg;
    const blocks = c.slice() as ContentBlock[];
    blocks[blocks.length - 1] = {
      ...last,
      cache_control: { type: "ephemeral" },
    } as ContentBlock;
    return { ...msg, content: blocks as unknown as ChatMessage["content"] };
  }
  return msg;
}

/**
 * Inject cache_control breakpoints into a request body destined for an
 * Anthropic model. Returns a new body; never mutates the input.
 *
 * Idempotent: if cache_control is already set on a block we leave it
 * alone (Cursor or any client that already does its own caching is
 * respected).
 */
export function withPromptCaching(
  body: IncomingRequest,
  upstreamModel: string,
): IncomingRequest {
  if (!enabled()) return body;
  if (!isCacheableModel(upstreamModel)) return body;

  let breakpoints = 0;
  const MAX_BREAKPOINTS = 4;

  let next: IncomingRequest = body;

  // 1. Last tool definition gets the marker (caches tools array).
  if (Array.isArray(next.tools) && next.tools.length > 0) {
    const tools = (next.tools as Array<Record<string, unknown>>).slice();
    const last = tools[tools.length - 1];
    if (last && !hasCacheControl(last)) {
      tools[tools.length - 1] = {
        ...last,
        cache_control: { type: "ephemeral" },
      };
      next = { ...next, tools };
      breakpoints++;
    } else if (hasCacheControl(last)) {
      breakpoints++;
    }
  }

  // 2 & 3. System message + conversation history.
  if (Array.isArray(next.messages) && next.messages.length > 0) {
    const messages = (next.messages as ChatMessage[]).slice();

    // Find the LAST system / developer message to mark.
    let lastSysIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const r = messages[i]?.role;
      if (r === "system" || r === "developer") {
        lastSysIdx = i;
        break;
      }
    }
    if (lastSysIdx !== -1 && breakpoints < MAX_BREAKPOINTS) {
      const before = messages[lastSysIdx]!;
      const marked = markMessage(before);
      if (marked !== before) {
        messages[lastSysIdx] = marked;
        breakpoints++;
      }
    }

    // 3. The most recent assistant/tool message before the LAST user
    //    message (so the latest user turn stays "fresh" — the cache hit
    //    covers everything up to the prior turn). Falls back to the last
    //    non-final message if there's no assistant/tool.
    if (breakpoints < MAX_BREAKPOINTS) {
      let lastUserIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      // Walk backwards from just before the last user message, find an
      // assistant or tool message to mark. If none, mark whatever's
      // immediately before the last user message.
      let convCacheIdx = -1;
      const startFrom =
        lastUserIdx === -1 ? messages.length - 2 : lastUserIdx - 1;
      for (let i = startFrom; i >= 0; i--) {
        const r = messages[i]?.role;
        if (r === "assistant" || r === "tool") {
          convCacheIdx = i;
          break;
        }
      }
      if (convCacheIdx === -1 && startFrom >= 0) convCacheIdx = startFrom;
      // Don't double-mark the system breakpoint we already used.
      if (convCacheIdx !== -1 && convCacheIdx !== lastSysIdx) {
        const before = messages[convCacheIdx]!;
        const marked = markMessage(before);
        if (marked !== before) {
          messages[convCacheIdx] = marked;
          breakpoints++;
        }
      }
    }

    next = { ...next, messages };
  }

  return next;
}
