/**
 * Body-shape normalisation for the proxy.
 *
 * Cursor and other Responses-API-style clients send chat-completions
 * requests in shapes that strict upstreams (sglang behind MiMo, certain
 * Anthropic providers, Fireworks) reject. We normalise to the classic
 * Chat Completions shape before forwarding. Two specific transforms:
 *
 *   1. messages reconstruction from `instructions` / `input` / `system` /
 *      `prompt` when the client doesn't send `messages` at all.
 *   2. tools flat -> nested shape conversion (Responses API tools have
 *      `name` at the top level; chat-completions expects them under a
 *      nested `function` key).
 */

export interface NormaliseResult {
  body: Record<string, unknown>;
  adapted: string[];
}

/**
 * Translate Responses-API-style flat tools into chat-completions nested
 * tools. Items that are already nested or have an unfamiliar shape are
 * passed through unchanged.
 *
 *   { type: "function", name: "X", description: "...", parameters: {...} }
 *     ->
 *   { type: "function", function: { name: "X", description: "...", parameters: {...} } }
 */
export function nestFlatTools(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; translated: boolean } {
  let translated = false;
  let next = body;

  if (Array.isArray(next.tools)) {
    const newTools = (next.tools as Array<Record<string, unknown>>).map((t) => {
      if (
        t &&
        typeof t === "object" &&
        t.type === "function" &&
        typeof t.name === "string" &&
        (t.function == null || typeof t.function !== "object")
      ) {
        translated = true;
        const { type, name, description, parameters, strict, ...rest } = t;
        const inner: Record<string, unknown> = { name };
        if (description !== undefined) inner.description = description;
        if (parameters !== undefined) inner.parameters = parameters;
        if (strict !== undefined) inner.strict = strict;
        for (const [k, v] of Object.entries(rest)) inner[k] = v;
        return { type, function: inner };
      }
      return t;
    });
    next = { ...next, tools: newTools };
  }

  if (
    next.tool_choice &&
    typeof next.tool_choice === "object" &&
    !Array.isArray(next.tool_choice)
  ) {
    const tc = next.tool_choice as Record<string, unknown>;
    if (
      tc.type === "function" &&
      typeof tc.name === "string" &&
      (tc.function == null || typeof tc.function !== "object")
    ) {
      translated = true;
      next = {
        ...next,
        tool_choice: { type: "function", function: { name: tc.name } },
      };
    }
  }

  return { body: next, translated };
}

export function normaliseBody(
  body: Record<string, unknown>,
): NormaliseResult {
  const adapted: string[] = [];

  // 1. Translate flat tools first — applies regardless of whether messages
  //    are already present, because Cursor sends `messages` AND uses the
  //    flat tools shape.
  const nested = nestFlatTools(body);
  if (nested.translated) {
    body = nested.body;
    adapted.push("tools(flat->nested)");
  }

  const messagesPresent =
    Array.isArray(body.messages) && (body.messages as unknown[]).length > 0;
  if (messagesPresent) return { body, adapted };

  const messages: Array<{ role: string; content: string }> = [];

  // Responses API: top-level `instructions` becomes a system message.
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    messages.push({ role: "system", content: body.instructions });
    adapted.push("instructions");
  }
  // Some clients use `system` directly.
  if (typeof body.system === "string" && body.system.length > 0) {
    messages.push({ role: "system", content: body.system });
    adapted.push("system");
  }

  // Responses API: `input` may be a string or an array of typed parts.
  if (typeof body.input === "string" && body.input.length > 0) {
    messages.push({ role: "user", content: body.input });
    adapted.push("input");
  } else if (Array.isArray(body.input)) {
    const text = (body.input as Array<Record<string, unknown>>)
      .map((p) =>
        typeof p?.text === "string"
          ? p.text
          : typeof p?.content === "string"
            ? p.content
            : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text) {
      messages.push({ role: "user", content: text });
      adapted.push("input[]");
    }
  }

  // Legacy completions: `prompt` is a plain string.
  if (typeof body.prompt === "string" && body.prompt.length > 0) {
    messages.push({ role: "user", content: body.prompt });
    adapted.push("prompt");
  }

  if (messages.length > 0) {
    const out: Record<string, unknown> = { ...body, messages };
    delete out.input;
    delete out.instructions;
    delete out.system;
    delete out.prompt;
    return { body: out, adapted };
  }
  return { body, adapted };
}
