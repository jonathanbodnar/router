/**
 * Routing logic.
 *
 * The router maps an incoming OpenAI-style chat completion request to one of
 * four OpenRouter models, based either on:
 *
 *   1. An explicit alias the client passed as `model`
 *      (e.g. "auto", "cheap", "agentic", "code", "reasoning"), OR
 *   2. A heuristic classification of the request when `model` is "auto"
 *      (or the alias / model is unrecognised).
 *
 * Concrete OpenRouter model ids (anything containing a "/") are passed
 * through unchanged so power users can still pin a specific model.
 */

export type Tier = "cheap" | "agentic" | "code" | "reasoning";

export const MODELS: Record<Tier, string> = {
  cheap: "deepseek/deepseek-v4-pro",
  agentic: "xiaomi/mimo-v2.5-pro",
  code: "anthropic/claude-sonnet-4.6",
  reasoning: "anthropic/claude-opus-4.7",
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
  model: string; // resolved OpenRouter model id
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
  const numMessages = req.messages?.length ?? 0;

  // 1. Long context or heavy tool-use agentic loops -> mimo.
  if (tokens >= LONG_CONTEXT_TOKENS) {
    return {
      tier: "agentic",
      model: MODELS.agentic,
      reason: `long context (~${tokens} tok)`,
      approxInputTokens: tokens,
    };
  }
  if (tools > 0 && (tokens >= 6_000 || numMessages >= 12)) {
    return {
      tier: "agentic",
      model: MODELS.agentic,
      reason: `tool-heavy agent loop (${tools} tools, ${numMessages} msgs, ~${tokens} tok)`,
      approxInputTokens: tokens,
    };
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
    return {
      tier: "reasoning",
      model: MODELS.reasoning,
      reason: `reasoning/architecture signal (~${tokens} tok)`,
      approxInputTokens: tokens,
    };
  }

  // 3. Code / dev work -> sonnet.
  if (strongCodeSignal) {
    return {
      tier: "code",
      model: MODELS.code,
      reason: `code/dev signal (~${tokens} tok, tools=${tools})`,
      approxInputTokens: tokens,
    };
  }
  if (weakCodeSignal && tokens >= CODE_MIN_TOKENS) {
    return {
      tier: "code",
      model: MODELS.code,
      reason: `code-ish prose (~${tokens} tok, tools=${tools})`,
      approxInputTokens: tokens,
    };
  }
  // Tools present at all is a strong "this is a dev/agent task" signal even
  // if the prompt itself is short.
  if (tools > 0) {
    return {
      tier: "code",
      model: MODELS.code,
      reason: `tool-calling request (${tools} tools, ~${tokens} tok)`,
      approxInputTokens: tokens,
    };
  }

  // 4. Default: cheap general-purpose.
  return {
    tier: "cheap",
    model: MODELS.cheap,
    reason: `general/short prompt (~${tokens} tok)`,
    approxInputTokens: tokens,
  };
}

/** Resolve the client's `model` field to a concrete OpenRouter model id. */
export function route(req: IncomingRequest): RouteDecision {
  const requested = (req.model ?? "auto").trim();

  // Passthrough for fully-qualified model ids ("vendor/model").
  if (requested.includes("/")) {
    return {
      tier: "cheap",
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
      model: MODELS[tier],
      reason: `alias "${lower}" -> ${tier}`,
      approxInputTokens: approxTokens(fullText(req)),
    };
  }

  // "auto" or anything unrecognised -> classify.
  return classify(req);
}
