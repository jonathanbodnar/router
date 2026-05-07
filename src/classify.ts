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

const BUG_FIX_RE =
  /\b(fix(?:es|ed|ing)?|bug|broken|crash(?:es|ed|ing)?|regression|hotfix|patch|stack ?trace|traceback|error message|throws?\b|failing test|failure|repro|root cause)\b/i;

const REWORK_RE =
  /\b(refactor(?:ing|ed)?|rework(?:ing|ed)?|rewrite|rewriting|restructur(?:e|ing)|cleanup|clean up|tidy up|migrate|migration|simplify|deduplicate|extract (?:method|function|component)|rename)\b/i;

const NEW_FEATURE_RE =
  /\b(add(?:ing)?|implement(?:ing|ed)?|build(?:ing)?|create(?:s|d|ing)?|introduce(?:s|d)?|new (?:feature|endpoint|component|module|product|page|screen|workflow|api|tool|script)|set up|setup|scaffold|bootstrap|prototype|MVP)\b/i;

/** Concatenate the last few user messages — that's where the actual ask is. */
function recentUserText(req: IncomingRequest, n = 3): string {
  const userMsgs = (req.messages ?? []).filter((m) => m.role === "user");
  return userMsgs.slice(-n).map(messageText).join("\n");
}

export function detectWorkType(req: IncomingRequest): WorkType {
  const text = recentUserText(req);
  if (!text) return "other";

  const bug = BUG_FIX_RE.test(text);
  const rew = REWORK_RE.test(text);
  const neu = NEW_FEATURE_RE.test(text);

  // Disambiguation: if multiple match, prefer the most "specific" signal.
  // bug_fix wins over rework wins over new_feature, because the verbs in
  // new_feature ("add", "create") are easy false positives.
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
