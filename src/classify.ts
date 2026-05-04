import type { ChatMessage, IncomingRequest } from "./router.js";

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
