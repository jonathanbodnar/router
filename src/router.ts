/**
 * Routing logic.
 *
 * The router maps an incoming OpenAI-style chat completion request to one
 * of four backing models across two providers:
 *
 *   - cheap     -> Fireworks  (DeepSeek V4 Pro)               non-dev work
 *   - agentic   -> OpenRouter (Xiaomi MiMo V2.5 Pro)          easy/medium dev work, long-context bulk
 *   - code      -> OpenRouter (Anthropic Claude Sonnet 4.6)   moderate dev work, substantial code
 *   - reasoning -> OpenRouter (Anthropic Claude Opus 4.7)     hard reasoning, architecture, complex refactors
 *
 * The "agentic" alias is kept for backward compatibility; "easy" works
 * too. Mental model:
 *
 *   non-dev      -> cheap     (DeepSeek)
 *   easy dev     -> agentic   (MiMo)
 *   moderate dev -> code      (Sonnet)
 *   hard dev     -> reasoning (Opus)
 *
 * The dispatch is based on either:
 *
 *   1. An explicit alias the client passed as `model`
 *      (e.g. "auto", "cheap", "easy", "agentic", "code", "reasoning"), OR
 *   2. A heuristic classification of the request when `model` is "auto"
 *      (or the alias / model is unrecognised).
 *
 * Concrete model ids (anything containing a "/") are passed through
 * unchanged. Fireworks-style ids ("accounts/fireworks/...") route to
 * Fireworks; everything else goes to OpenRouter.
 */

import { detectProvider, type Provider } from "./providers.js";

export type Tier = "cheap" | "agentic" | "code" | "reasoning";

export interface TierEntry {
  provider: Provider;
  model: string;
}

export const MODELS: Record<Tier, TierEntry> = {
  cheap: {
    provider: "fireworks",
    model: "accounts/fireworks/models/deepseek-v4-pro",
  },
  agentic: { provider: "openrouter", model: "xiaomi/mimo-v2.5-pro" },
  code: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
  reasoning: { provider: "openrouter", model: "anthropic/claude-opus-4.7" },
};

/** Aliases the user can request directly as `model` (or as a `!alias` prefix
 *  on the last user message — see `parsePromptOverride` in classify.ts). */
export const ALIASES: Record<string, Tier> = {
  auto: "cheap", // placeholder; "auto" is handled specially below
  cheap: "cheap",
  general: "cheap",
  fast: "cheap",
  agentic: "agentic",
  easy: "agentic",
  basic: "agentic",
  mimo: "agentic",
  "long-context": "agentic",
  longcontext: "agentic",
  long: "agentic",
  code: "code",
  dev: "code",
  coder: "code",
  moderate: "code",
  sonnet: "code",
  reasoning: "reasoning",
  hard: "reasoning",
  opus: "reasoning",
  best: "reasoning",
};

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "developer" | string;
  // OpenAI allows `content` to be a string or an array of parts.
  content?: string | Array<{ type: string; text?: string; [k: string]: unknown }> | null;
  name?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  [k: string]: unknown;
}

export interface IncomingRequest {
  model?: string;
  messages?: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  usage?: unknown;
  /** OpenRouter unified reasoning controls. We inject defaults for
   *  reasoning-heavy models (e.g. MiMo) when the client omits this. */
  reasoning?: { effort?: "low" | "medium" | "high"; max_tokens?: number; exclude?: boolean } | unknown;
  // ...other OpenAI fields are passed through untouched.
  [k: string]: unknown;
}

export interface RouteDecision {
  tier: Tier;
  provider: Provider;
  model: string; // resolved upstream model id
  reason: string;
  approxInputTokens: number;
}

/* ---------- helpers ---------- */

function messageText(m: ChatMessage): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("\n");
  }
  return "";
}

function fullText(req: IncomingRequest): string {
  return (req.messages ?? []).map(messageText).join("\n");
}

/**
 * Text of the latest user-role message. This — not the entire conversation
 * — is what we run keyword heuristics against.
 *
 * Cursor's stock agent system prompt + workspace metadata + previous
 * assistant turns + tool-result blobs can easily total 5k–30k tokens and
 * routinely contain language that matches the reasoning / code regexes
 * for completely unrelated reasons. If we let those decide the tier we'd
 * route trivial asks like "summarize the project" to Opus. By pinning
 * keyword detection to the user's actual ask, we keep the heuristic
 * honest and let total-token thresholds handle "long context bulk"
 * separately.
 */
function lastUserText(req: IncomingRequest): string {
  const msgs = req.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") return messageText(msgs[i]!);
  }
  return "";
}

/** Cheap, deterministic token estimate (~4 chars / token). */
function approxTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/* ---------- signal detectors ---------- */

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const FILE_PATH_RE =
  /\b[\w./@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|c|h|cc|cpp|hpp|cs|rb|php|sh|sql|yaml|yml|toml|json|md|html|css|scss|vue|svelte)\b/i;
const CODEY_TOKENS_RE =
  /\b(function|const |let |var |class |interface |import |export |return |async |await |def |print\(|console\.log|=>|stack ?trace|traceback|exception|null pointer|segfault)\b/i;
const DEV_TASK_RE =
  /\b(debug|fix (?:this|the|a) bug|stack ?trace|error|implement|refactor|unit ?test|integration ?test|code review|lint|type ?error|compile|build fail|regex|api endpoint|edit (?:this|the) file|write (?:a )?(?:function|component|hook|module|script))\b/i;

const REASONING_RE = new RegExp(
  [
    // architecture / design
    "system design",
    "design doc",
    "design review",
    "architectural (?:decision|choice|trade ?off|review)",
    "high[- ]level design",
    "end[- ]to[- ]end design",
    "cross[- ]cutting concern",
    // refactors / migrations
    "complex refactor",
    "large refactor",
    "migration plan",
    "schema migration",
    "rollout plan",
    "rollback strategy",
    "breaking change",
    // production / risk
    "production[- ]grade",
    "mission[- ]critical",
    "highest stakes",
    "must be excellent",
    // analysis / proofs
    "deeply analyze",
    "deep dive",
    "formal proof",
    "invariant",
    "step ?by ?step reasoning",
    "chain[- ]of[- ]thought",
    "prove that",
    "why is this (?:the )?(?:correct|right) (?:approach|design)",
    "trade[- ]offs?\\b.*\\bvs\\b",
    // distributed systems / concurrency
    "consistency model",
    "distributed system",
    "consensus",
    "byzantine",
    "raft\\b",
    "paxos\\b",
    "data race",
    "race condition",
    "thread[- ]safety",
    "concurrency (?:bug|model|primitive)",
    // performance / scalability
    "performance bottleneck",
    "algorithmic complexity",
    "big[- ]?o\\b.*(?:analysis|complexity)",
    "scaling strategy",
    // security
    "threat model",
    "security audit",
    "attack vector",
    // hard / stakes language
    "hard problem",
    "very hard\\b",
  ].join("|"),
  "i",
);

/**
 * Heuristic thresholds, tuned for Cursor-style traffic.
 *
 * Decisions are split into two axes:
 *   - keyword/regex signals — measured ONLY against the user's latest
 *     message (`userTokens`), to prevent Cursor's stock system prompt
 *     from biasing every request toward Opus.
 *   - bulk / long-context — measured against the entire context
 *     (`totalTokens`), because that's what determines whether MiMo's
 *     long context wins.
 */
const LONG_CONTEXT_TOKENS = 32_000; // total-context bulk threshold (MiMo)
const REASONING_USER_MIN_TOKENS = 600; // user's ask must be substantive to
//                                     // warrant Opus, otherwise a 5-token
//                                     // mention of "architecture" routes us
//                                     // to a $0.30 reply.
const MODERATE_CODE_USER_TOKENS = 1_500; // pasted-code threshold for Sonnet

/* ---------- main classifier ---------- */

function classify(req: IncomingRequest): RouteDecision {
  const allText = fullText(req);
  const totalTokens = approxTokens(allText);
  const userText = lastUserText(req);
  const userTokens = approxTokens(userText);
  const tools = Array.isArray(req.tools) ? req.tools.length : 0;

  const decide = (tier: Tier, reason: string): RouteDecision => ({
    tier,
    provider: MODELS[tier].provider,
    model: MODELS[tier].model,
    reason,
    // We report TOTAL tokens for billing/context display, even though
    // routing decisions key on userTokens for keyword signals.
    approxInputTokens: totalTokens,
  });

  // Keyword signals: pinned to the user's latest message ONLY.
  const hasCodeFence = CODE_FENCE_RE.test(userText);
  CODE_FENCE_RE.lastIndex = 0;
  const hasFilePath = FILE_PATH_RE.test(userText);
  const hasDevVerb = DEV_TASK_RE.test(userText);
  const hasCodeyTokens = CODEY_TOKENS_RE.test(userText);
  const looksReasoning = REASONING_RE.test(userText);

  const strongCodeSignal = hasCodeFence || hasFilePath || hasDevVerb;
  const weakCodeSignal = hasCodeyTokens;
  const codeSignal = strongCodeSignal || weakCodeSignal;

  // 1. Highest-stakes reasoning / architecture -> Opus.
  //    Require BOTH a reasoning regex hit in the user's latest message
  //    AND that user message to be substantive. This is intentionally
  //    strict; pair it with the LLM classifier (cheap upgrade pass) and
  //    explicit `!hard` / `[opus]` overrides for the cases where the user
  //    asks something genuinely hard in a short prompt.
  if (looksReasoning && userTokens >= REASONING_USER_MIN_TOKENS) {
    return decide(
      "reasoning",
      `reasoning signal in user msg (~${userTokens} user tok / ${totalTokens} total)`,
    );
  }

  // 2. Long-context bulk with NO tools -> MiMo (cheap 1M ctx).
  //    Pasted-doc summarisation, repo-wide reads, etc. Total context
  //    matters here, not user-message length.
  if (tools === 0 && totalTokens >= LONG_CONTEXT_TOKENS) {
    return decide("agentic", `long context (~${totalTokens} tok, no tools)`);
  }

  // 3. Pasted code / substantial dev request -> Sonnet (moderate tier).
  //    Strong code signal in the user's message AND the user's message
  //    is itself meaty (~1.5k tokens of pasted code or dense dev spec).
  //    Short asks like "fix the typo in foo.ts" stay on MiMo by default.
  if (strongCodeSignal && userTokens >= MODERATE_CODE_USER_TOKENS) {
    return decide(
      "code",
      `substantial code request (~${userTokens} user tok, tools=${tools})`,
    );
  }

  // 4. Any tool-calling agent loop or code/dev hint -> MiMo.
  //    This is the default for Cursor: every agent message has tools
  //    attached, so without an explicit reasoning/code flag we run on
  //    MiMo for cost.
  if (codeSignal || tools > 0) {
    const why = strongCodeSignal
      ? "code/dev signal in user msg"
      : weakCodeSignal
        ? "code-ish prose in user msg"
        : "tool-calling request";
    return decide(
      "agentic",
      `${why} (~${userTokens} user tok, tools=${tools})`,
    );
  }

  // 5. Default: short non-dev prompt -> DeepSeek (cheapest).
  return decide("cheap", `general/short prompt (~${userTokens} user tok)`);
}

/** Resolve the client's `model` field to a concrete upstream model id. */
export function route(req: IncomingRequest): RouteDecision {
  // Project tags (model name "gpt-4.1__router") are stripped before
  // routing so classification only sees the base model name.
  const rawModel = (req.model ?? "auto").trim();
  const tagSep = rawModel.indexOf("__");
  const requested = tagSep === -1 ? rawModel : rawModel.slice(0, tagSep);

  // Passthrough for fully-qualified model ids. Provider is inferred from
  // the id ("accounts/fireworks/..." -> Fireworks; everything else -> OR).
  if (requested.includes("/")) {
    return {
      tier: "cheap",
      provider: detectProvider(requested),
      model: requested,
      reason: `passthrough (${requested})`,
      approxInputTokens: approxTokens(fullText(req)),
    };
  }

  const lower = requested.toLowerCase();

  // Explicit alias (anything except "auto" forces a tier).
  if (lower !== "auto" && lower in ALIASES) {
    const tier = ALIASES[lower]!;
    return {
      tier,
      provider: MODELS[tier].provider,
      model: MODELS[tier].model,
      reason: `alias "${lower}" -> ${tier}`,
      approxInputTokens: approxTokens(fullText(req)),
    };
  }

  // "auto" or anything unrecognised -> classify.
  return classify(req);
}
