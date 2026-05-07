import { ALIASES, type ChatMessage, type IncomingRequest } from "./router.js";

/* ---------- project detection ---------- */

/**
 * Extract a "project" name from the request.
 *
 * Cursor's system prompt for chat/agent requests includes a `<user_info>`
 * block that looks like:
 *
 *   OS Version: darwin 25.5.0
 *   Shell: zsh
 *   Workspace Path: /Users/jonathanbodnar/router
 *   ...
 *
 * We pull the last segment of the workspace path. If we don't find one we
 * fall back to looking for cwd / repo paths in any message, and finally
 * give up and return null (recorded as `(unknown)` in the dashboard).
 */
const WORKSPACE_RE =
  /(?:Workspace Path|workspace path|workspaceFolder|cwd)\s*[:=]\s*([^\n\r"'`<>]+)/;

const REPO_PATH_RE =
  /[\\/](?:Users|home|workspace|repos|projects)[\\/][^\s\n"'`<>]+?[\\/]([A-Za-z0-9._-]+)/;

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

function lastPathSegment(p: string): string | null {
  const trimmed = p.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const parts = trimmed.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : null;
}

export function detectProject(req: IncomingRequest): string | null {
  const messages = req.messages ?? [];
  // Prefer system / developer messages (Cursor puts user_info there).
  const ordered = [...messages].sort((a, b) => {
    const score = (m: ChatMessage) =>
      m.role === "system" ? 0 : m.role === "developer" ? 1 : 2;
    return score(a) - score(b);
  });

  for (const m of ordered) {
    const text = messageText(m);
    const ws = WORKSPACE_RE.exec(text);
    if (ws && ws[1]) {
      const seg = lastPathSegment(ws[1]);
      if (seg) return seg;
    }
  }

  // Fallback: scan all messages for a plausible repo path.
  for (const m of messages) {
    const text = messageText(m);
    const rp = REPO_PATH_RE.exec(text);
    if (rp && rp[1]) return rp[1];
  }

  return null;
}

/* ---------- work-type classification ---------- */

export type WorkType = "bug_fix" | "rework" | "new_feature" | "other";

/**
 * Strip the Cursor user-message wrapper so the regexes don't see the
 * <timestamp> / <user_query> tags that surround every message. Without
 * this, half of all messages match BUG_FIX_RE just because the wrapper
 * happens to contain "Tuesday" or similar accidental matches.
 */
function unwrapUserText(s: string): string {
  return s
    .replace(/<timestamp>[\s\S]*?<\/timestamp>/gi, "")
    .replace(/<\/?user_query>/gi, "")
    .replace(/<\/?attached_files>[\s\S]*?<\/attached_files>/gi, "")
    .replace(/<\/?system_reminder>[\s\S]*?<\/system_reminder>/gi, "")
    .trim();
}

/**
 * Bug fix signals — must be reasonably specific to actual bugs, NOT just
 * the word "fix". Plain "fix the typo" or "fix the comment" doesn't count
 * as a real bug fix and should fall through to "other".
 */
const BUG_FIX_RE = new RegExp(
  [
    // Explicit bug language
    "\\bbug\\b",
    "\\bbugs\\b",
    "\\bhotfix\\b",
    "\\bregression\\b",
    "\\broot ?cause\\b",
    "\\brepro(?:duce|duction)?\\b",
    // "X is broken / not working / failing" etc.
    "\\b(?:is|isn'?t|wasn'?t|aren'?t|are|been|been not) (?:broken|crashing|throwing|failing|erroring|hanging|stuck|stalling|stalled|deadlocked|undefined)\\b",
    "\\b(?:doesn'?t|does not|won'?t|will not) (?:work|render|load|compile|build|return|fire|trigger|respond|update|persist)\\b",
    "\\b(?:not|never) (?:working|rendering|loading|firing|persisting|returning|saving)\\b",
    // Errors / crashes / traces
    "\\b(?:throws?|threw|throwing) (?:an? )?(?:error|exception|TypeError|ReferenceError|RangeError|null|undefined)\\b",
    "\\b(?:stack ?trace|traceback|null pointer|segfault|panic|core dumped)\\b",
    "\\b(?:crash(?:es|ed|ing)?|panicking)\\b",
    "\\bfailing tests?\\b",
    "\\btests? (?:failing|are failing|fails?|breaks?|broken)\\b",
    // "fix the X" where X is bug-language adjacent
    "\\bfix (?:the |this |that |a |an |my |our )?(?:bug|crash|error|exception|panic|regression|hang|deadlock|race|memory leak|leak|null pointer|segfault|stall|broken)\\b",
    // Diagnostic verbs (when paired with errors/bugs)
    "\\bdebug (?:the |this |a )?(?:bug|error|crash|issue|problem|failure)\\b",
    "\\bwhy (?:is|isn'?t|does|doesn'?t|are|aren'?t).{0,40}(?:broken|failing|crashing|throwing|undefined|null)",
  ].join("|"),
  "i",
);

/**
 * Feature-noun group — used by both REWORK_RE (extract a hook) and
 * NEW_FEATURE_RE (build a hook). Kept in one place so adding a new noun
 * affects both classifiers consistently.
 */
const FEATURE_NOUN =
  "feature|endpoint|api|route|page|screen|view|component|module|service|hook|workflow|integration|provider|adapter|migration|table|schema|model|dashboard|panel|widget|form|button|modal|chart|graph|report|tool|script|cli|webhook|listener|handler|consumer|publisher|cron|job|worker|microservice|database|index|cache|queue|product|payment|auth|login|signup|onboarding|notification|alert|email|sms|push|mvp|prototype|poc|demo";

/**
 * Rework signals — refactors, migrations, renames, restructuring.
 *
 * Matches allow up to three filler words between the verb and the noun
 * so phrasings like "simplify the public api" and "rename utils.ts to
 * helpers.ts" still match.
 */
const REWORK_RE = new RegExp(
  [
    "\\brefactor(?:s|ed|ing)?\\b",
    "\\brework(?:s|ed|ing)?\\b",
    "\\brewrit(?:e|es|ing|ten)\\b",
    "\\brestructur(?:e|es|ed|ing)\\b",
    "\\bclean ?up (?:the |this |these )?(?:code|file|files|module|component|implementation|logic)",
    "\\btidy ?up\\b",
    "\\bmigrat(?:e|ion|ing|ed) (?:from|to|away|the)\\b",
    "\\bsimplify (?:[\\w/.-]+ ){0,3}(?:code|implementation|logic|api|interface|module)\\b",
    "\\bdedup(?:e|licate|licates|licating)\\b",
    "\\bextract (?:a |the |this |that )?(?:method|function|component|hook|module|helper|util|interface|type)\\b",
    "\\bconsolidate\\b",
    "\\b(?:rename|renaming) (?:the |this |a |an |my |our )?(?:file|function|class|component|method|type|interface|module|directory|folder|column|table|field)\\b",
    // "rename utils.ts to helpers.ts" — file/symbol-style renames with → arrow
    "\\b(?:rename|renaming) [\\w./-]+ (?:to|->|→) [\\w./-]+",
    "\\bsplit (?:up |out )?(?:the |this )?(?:file|function|component|module) (?:into|across|up)\\b",
    "\\bmerge (?:the |these )?(?:files|functions|components|modules) (?:into|together)\\b",
    "\\bport (?:the |this |our )?[\\w-]+ (?:to|from)\\b",
  ].join("|"),
  "i",
);

/**
 * New-feature signals — building genuinely new things.
 *
 * Matches a feature verb followed by up to three filler words and then a
 * concrete feature noun. This keeps "build a small CLI tool" and "create
 * a new payment endpoint" working without tripping on bare "add" or "create".
 */
const NEW_FEATURE_RE = new RegExp(
  [
    `\\b(?:build|create|implement|add|introduce|wire (?:up|in)|scaffold|bootstrap|spin up|stand up|set up|setup|design) (?:[\\w-]+ ){0,4}(?:${FEATURE_NOUN})s?\\b`,
    "\\b(?:from scratch|greenfield)\\b",
    `\\b(?:a |the )?new (?:[\\w-]+ ){0,2}(?:${FEATURE_NOUN})s?\\b`,
    "\\bstart(?:ing)? (?:on |working on |building |implementing )(?:a |the |new )?",
    "\\b(?:MVP|prototype)\\b",
  ].join("|"),
  "i",
);

/**
 * Anti-patterns: matches that LOOK like new-feature/bug language but are
 * actually trivial maintenance. If any of these match, downgrade to
 * "other" before the main classifier runs.
 */
const TRIVIAL_RE = new RegExp(
  [
    "\\b(?:add|update|fix|remove|delete) (?:a |the |an |this )?(?:comment|comments|typo|typos|whitespace|indent|indentation|newline|trailing|spacing|formatting|format|prettier|lint|eslint)\\b",
    "\\b(?:add|update|fix|remove|delete) (?:a |the |an |this )?(?:import|imports|export|exports)\\b",
    "\\b(?:rename) (?:a |the |this )?(?:variable|var|const|let|param|parameter)\\b",
  ].join("|"),
  "i",
);

/**
 * Examine the user's latest message (only) to classify the work type.
 * Earlier turns are noisy in agent loops — they often mention "fix" and
 * "implement" from previous tasks even though the current ask is
 * unrelated. We pin to the latest message and strip Cursor's wrapper.
 *
 * Override via the X-Router-Work-Type header (handled in resolveWorkType).
 */
export function detectWorkType(req: IncomingRequest): WorkType {
  // Latest user message only.
  let text = "";
  const msgs = req.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") {
      text = unwrapUserText(messageText(msgs[i]!));
      break;
    }
  }
  if (!text || text.length < 4) return "other";

  // If it's clearly a trivial maintenance task, return "other" up front
  // so the verb regexes can't fire false positives like "add a comment"
  // -> new_feature.
  if (TRIVIAL_RE.test(text)) return "other";

  const bug = BUG_FIX_RE.test(text);
  const rew = REWORK_RE.test(text);
  const neu = NEW_FEATURE_RE.test(text);

  // Disambiguation: when multiple match, the most specific signal wins.
  // Bug-fix language is the rarest false positive, then rework, then new
  // feature (whose verbs are still the easiest to overshoot on).
  if (bug) return "bug_fix";
  if (rew) return "rework";
  if (neu) return "new_feature";
  return "other";
}

/**
 * Extract a project tag from a model name of the form `<base>__<project>`.
 * Returns the project (or null) and the base model name with the tag
 * stripped so downstream classification only sees the base.
 *
 * Example: "gpt-4.1__router" -> { base: "gpt-4.1", project: "router" }
 *          "gpt-4.1"         -> { base: "gpt-4.1", project: null }
 */
export function parseModelProjectTag(model: string | undefined): {
  base: string;
  project: string | null;
} {
  const m = (model ?? "").trim();
  const idx = m.indexOf("__");
  if (idx === -1) return { base: m, project: null };
  const base = m.slice(0, idx);
  const tag = m.slice(idx + 2).trim();
  return { base, project: tag.length > 0 ? tag : null };
}

/**
 * Resolve the project tag for a request. Precedence:
 *   1. X-Router-Project header (if present)
 *   2. Project tag baked into the model name (`gpt-4.1__router`)
 *   3. Heuristic detection from message content
 */
export function resolveProject(
  headerValue: string | undefined,
  modelTag: string | null,
  req: IncomingRequest,
): string | null {
  const h = headerValue?.trim();
  if (h) return h;
  if (modelTag) return modelTag;
  return detectProject(req);
}

/* ---------- in-prompt routing override ---------- */

/**
 * Look at the last user message and check if it starts with an inline
 * routing tag like `!hard`, `!cheap`, `!sonnet`, `[opus]`, etc. If so:
 *
 *   - extract the alias,
 *   - strip the tag (and any leading whitespace) from the message,
 *   - return a NEW request with the modified message and `model` set
 *     to the alias so `route()` will resolve it.
 *
 * Recognised forms (case-insensitive). The tag may appear at the very start
 * of the message, OR at the start of any line — this is important because
 * Cursor wraps user messages with `<timestamp>...</timestamp>\n<user_query>\n`
 * before the actual prompt, so `[sonnet]` ends up on a line by itself.
 *
 *   !alias    rest...
 *   [alias]   rest...
 *
 * Only valid aliases (those listed in router.ts ALIASES) are honoured —
 * `!unknownword foo` is left untouched so we don't accidentally eat a
 * legitimate `!important` style at the start of a message.
 */
const PROMPT_TAG_RE = /(?:^|\n)[ \t]*(?:!([a-z][a-z0-9_-]*)|\[([a-z][a-z0-9_-]*)\])(?=[\s,:.\-]|$)/i;

export interface PromptOverride {
  alias: string;
  request: IncomingRequest;
}

function setMessageContent(m: ChatMessage, newText: string): ChatMessage {
  const c = m.content;
  if (typeof c === "string" || c == null) return { ...m, content: newText };
  if (Array.isArray(c)) {
    let replaced = false;
    const parts = c.map((p) => {
      if (!replaced && p && typeof p === "object" && typeof p.text === "string") {
        replaced = true;
        return { ...p, text: newText };
      }
      return p;
    });
    if (!replaced) {
      parts.unshift({ type: "text", text: newText });
    }
    return { ...m, content: parts };
  }
  return { ...m, content: newText };
}

export function parsePromptOverride(req: IncomingRequest): PromptOverride | null {
  const messages = req.messages ?? [];
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return null;

  const msg = messages[lastUserIdx]!;
  const text = messageText(msg);
  if (!text) return null;

  const m = PROMPT_TAG_RE.exec(text);
  if (!m) return null;
  const alias = (m[1] ?? m[2] ?? "").toLowerCase();
  if (!alias || !(alias in ALIASES)) return null;

  // Strip the matched tag (just the tag itself, leaving the wrapper context
  // and following text intact) plus any trailing delimiter right after it.
  const tagStart = m.index + (m[0].startsWith("\n") ? 1 : 0);
  const tagEnd = m.index + m[0].length;
  const before = text.slice(0, tagStart);
  const after = text.slice(tagEnd).replace(/^[ \t]*[\s,:.\-–—]+/, "");
  const rest = before + after;

  const newMessages = messages.slice();
  newMessages[lastUserIdx] = setMessageContent(msg, rest);

  return {
    alias,
    request: { ...req, messages: newMessages, model: alias },
  };
}

export function resolveWorkType(
  headerValue: string | undefined,
  req: IncomingRequest,
): WorkType {
  const v = headerValue?.trim().toLowerCase();
  if (v === "bug_fix" || v === "bug-fix" || v === "bug" || v === "fix")
    return "bug_fix";
  if (v === "rework" || v === "refactor") return "rework";
  if (v === "new_feature" || v === "new-feature" || v === "feature" || v === "new")
    return "new_feature";
  if (v === "other") return "other";
  return detectWorkType(req);
}
