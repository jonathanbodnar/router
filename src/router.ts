/**
 * Routing logic.
 *
 * The router maps an incoming OpenAI-style chat completion request to one of
 * four backing models across two providers:
 *
 *   - cheap     -> Fireworks (DeepSeek V4 Pro)
 *   - agentic   -> OpenRouter (Xiaomi MiMo V2.5 Pro)
 *   - code      -> OpenRouter (Anthropic Claude Sonnet 4.6)
 *   - reasoning -> OpenRouter (Anthropic Claude Opus 4.7)
 *
 * The dispatch is based on either:
 *
 *   1. An explicit alias the client passed as `model`
 *      (e.g. "auto", "cheap", "agentic", "code", "reasoning"), OR
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

/** Aliases the user can request directly as `model`. */
const ALIASES: Record<string, Tier> = {
  auto: "cheap", // placeholder; "auto" is handled specially below
  cheap: "cheap",
  general: "cheap",
  fast: "cheap",
  agentic: "agentic",
  "long-context": "agentic",
  longcontext: "agentic",
  long: "agentic",
  code: "code",
  dev: "code",
  coder: "code",
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

const REASONING_RE =
  /\b(architect(?:ure)?|system design|design system|design doc|trade ?off|complex refactor|large refactor|migrate|migration plan|critical|production[- ]grade|mission[- ]critical|deeply analyze|prove|formal|invariant|consistency model|distributed system|threat model|security review|reason step ?by ?step|chain[- ]of[- ]thought|hard problem|highest stakes)\b/i;

/** Heuristic token thresholds, tuned for Cursor-style traffic. */
const LONG_CONTEXT_TOKENS = 32_000; // anything bigger -> agentic / long-context tier
const REASONING_MIN_TOKENS = 1_500; // need some substance before we go to opus
const CODE_MIN_TOKENS = 200;

/* ---------- main classifier ---------- */

function classify(req: IncomingRequest): RouteDecision {
  const text = fullText(req);
  const tokens = approxTokens(text);
  const tools = Array.isArray(req.tools) ? req.tools.length : 0;

  const decide = (tier: Tier, reason: string): RouteDecision => ({
    tier,
    provider: MODELS[tier].provider,
    model: MODELS[tier].model,
    reason,
    approxInputTokens: tokens,
  });

  // 1. Long context with NO tools -> mimo.
  //    MiMo via OpenRouter rejects OpenAI-shaped tool definitions
  //    ("Param Incorrect, param: function is not set"), so anything that
  //    has tools must go to a model that natively understands OpenAI tools
  //    (Sonnet / Opus). Tool-heavy agent loops therefore fall through to
  //    the code/reasoning tiers below regardless of context size.
  if (tools === 0 && tokens >= LONG_CONTEXT_TOKENS) {
    return decide("agentic", `long context (~${tokens} tok, no tools)`);
  }

  const hasCodeFence = CODE_FENCE_RE.test(text);
  CODE_FENCE_RE.lastIndex = 0;
  const hasFilePath = FILE_PATH_RE.test(text);
  const hasDevVerb = DEV_TASK_RE.test(text);
  const hasCodeyTokens = CODEY_TOKENS_RE.test(text);

  // Strong code signals: any one of these is enough on its own, regardless of
  // length. A fence, an explicit file path, or a dev verb means the user is
  // clearly doing dev work.
  const strongCodeSignal = hasCodeFence || hasFilePath || hasDevVerb;
  // Weak code signals (just "function" / "class" etc. in prose) still need
  // some volume to avoid false positives.
  const weakCodeSignal = hasCodeyTokens;

  const looksReasoning = REASONING_RE.test(text);

  // 2. Highest-stakes reasoning -> opus.
  //    Require both a reasoning signal AND meaningful substance, otherwise
  //    casual mentions of "architecture" don't blow the budget.
  if (looksReasoning && tokens >= REASONING_MIN_TOKENS) {
    return decide(
      "reasoning",
      `reasoning/architecture signal (~${tokens} tok)`,
    );
  }

  // 3. Code / dev work -> sonnet.
  if (strongCodeSignal) {
    return decide(
      "code",
      `code/dev signal (~${tokens} tok, tools=${tools})`,
    );
  }
  if (weakCodeSignal && tokens >= CODE_MIN_TOKENS) {
    return decide(
      "code",
      `code-ish prose (~${tokens} tok, tools=${tools})`,
    );
  }
  // Tools present at all is a strong "this is a dev/agent task" signal even
  // if the prompt itself is short.
  if (tools > 0) {
    return decide(
      "code",
      `tool-calling request (${tools} tools, ~${tokens} tok)`,
    );
  }

  // 4. Default: cheap general-purpose.
  return decide("cheap", `general/short prompt (~${tokens} tok)`);
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
