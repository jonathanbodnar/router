/**
 * Body-shape normalisation for the proxy.
 *
 * Cursor and other Responses-API-style clients send chat-completions
 * requests in shapes that strict upstreams (sglang behind MiMo, Anthropic
 * providers via OpenRouter, Fireworks) reject. We normalise to the
 * classic Chat Completions shape before forwarding. Three transforms:
 *
 *   1. messages reconstruction from `instructions` / `input` / `system` /
 *      `prompt`. The `input` array is the Responses-API conversation
 *      history; we walk it and convert each item (typed parts, function
 *      calls, function call outputs) into a chat-completions `messages`
 *      entry while preserving roles.
 *   2. tools flat -> nested shape (Responses API tools have `name` at the
 *      top level; chat-completions expects them under a nested `function`
 *      key).
 *   3. response-format translation: `text.format` -> `response_format`,
 *      and stripping of Responses-API-only top-level fields (`store`,
 *      `previous_response_id`, `prompt_cache_key`, `truncation`,
 *      `include`).
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

/**
 * Flatten a Responses-API content array (`[{type:"input_text", text}, ...]`)
 * into a single newline-joined string. Unknown part types and bare strings
 * pass through; everything else is dropped.
 */
function partsToText(parts: unknown): string {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  const pieces: string[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      if (p) pieces.push(p);
      continue;
    }
    if (!p || typeof p !== "object") continue;
    const part = p as Record<string, unknown>;
    if (typeof part.text === "string" && part.text) {
      pieces.push(part.text);
    } else if (typeof part.content === "string" && part.content) {
      pieces.push(part.content);
    }
    // image_url / file etc. silently skipped — chat completions can carry
    // them but most upstreams choke on the Responses-API field names, and
    // for now we only need text for routing decisions to work.
  }
  return pieces.join("\n");
}

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/**
 * Convert the Responses-API `input` array to chat-completions `messages`.
 * Handles role-tagged messages with string OR typed-parts content,
 * `function_call` entries (assistant tool use), and `function_call_output`
 * entries (tool result messages). Order is preserved.
 */
export function inputArrayToMessages(input: unknown[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;

    // Responses-API function call -> assistant tool_calls
    if (it.type === "function_call") {
      const args =
        typeof it.arguments === "string"
          ? it.arguments
          : JSON.stringify(it.arguments ?? {});
      const call = {
        id:
          (typeof it.call_id === "string" && it.call_id) ||
          (typeof it.id === "string" && it.id) ||
          `call_${Math.random().toString(36).slice(2, 10)}`,
        type: "function" as const,
        function: {
          name: typeof it.name === "string" ? it.name : "",
          arguments: args,
        },
      };
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.tool_calls)) {
        last.tool_calls.push(call);
      } else {
        out.push({ role: "assistant", content: null, tool_calls: [call] });
      }
      continue;
    }

    // Responses-API function call output -> tool message
    if (it.type === "function_call_output") {
      const output =
        typeof it.output === "string"
          ? it.output
          : JSON.stringify(it.output ?? "");
      out.push({
        role: "tool",
        tool_call_id:
          (typeof it.call_id === "string" && it.call_id) ||
          (typeof it.id === "string" && it.id) ||
          "",
        content: output,
      });
      continue;
    }

    // Plain message: {role, content?} where content may be a string or
    // an array of typed parts.
    if (typeof it.role === "string") {
      let content: string;
      if (typeof it.content === "string") {
        content = it.content;
      } else if (Array.isArray(it.content)) {
        content = partsToText(it.content);
      } else if (typeof it.text === "string") {
        content = it.text;
      } else {
        content = "";
      }
      out.push({ role: it.role, content });
      continue;
    }

    // Bare typed text: {type: "input_text", text: "..."}
    if (typeof it.text === "string" && it.text) {
      out.push({ role: "user", content: it.text });
    }
  }
  return out;
}

/**
 * Strip Responses-API-only top-level fields that strict chat-completions
 * upstreams reject, and translate `text.format` -> `response_format` if
 * present. Mutates a shallow copy and returns whether anything changed.
 */
function stripResponsesApiFields(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; stripped: string[] } {
  const stripped: string[] = [];
  let next = body;

  // text: { format: { type: "json_schema", ... } } -> response_format
  if (
    next.text &&
    typeof next.text === "object" &&
    !Array.isArray(next.text)
  ) {
    const t = next.text as Record<string, unknown>;
    if (t.format && typeof t.format === "object" && !next.response_format) {
      next = { ...next, response_format: t.format };
      stripped.push("text.format->response_format");
    }
    const { text: _, ...rest } = next;
    next = rest;
    if (!stripped.includes("text.format->response_format")) stripped.push("text");
  }

  for (const k of [
    "store",
    "previous_response_id",
    "prompt_cache_key",
    "truncation",
    "include",
    "background",
  ] as const) {
    if (k in next) {
      const { [k]: _drop, ...rest } = next;
      next = rest;
      stripped.push(k);
    }
  }

  return { body: next, stripped };
}

export function normaliseBody(
  body: Record<string, unknown>,
): NormaliseResult {
  const adapted: string[] = [];

  // 1. Translate flat tools -> nested.
  const nested = nestFlatTools(body);
  if (nested.translated) {
    body = nested.body;
    adapted.push("tools(flat->nested)");
  }

  // 2. Build messages array if the client didn't send one. Responses-API
  //    requests have `input` and/or `instructions`; legacy completions
  //    have `prompt`. We may also receive `system` from looser clients.
  const messagesPresent =
    Array.isArray(body.messages) && (body.messages as unknown[]).length > 0;

  if (!messagesPresent) {
    const messages: ChatMessage[] = [];

    if (typeof body.instructions === "string" && body.instructions.length > 0) {
      messages.push({ role: "system", content: body.instructions });
      adapted.push("instructions");
    }
    if (typeof body.system === "string" && body.system.length > 0) {
      messages.push({ role: "system", content: body.system });
      adapted.push("system");
    }

    if (typeof body.input === "string" && body.input.length > 0) {
      messages.push({ role: "user", content: body.input });
      adapted.push("input");
    } else if (Array.isArray(body.input)) {
      const fromInput = inputArrayToMessages(body.input as unknown[]);
      if (fromInput.length > 0) {
        messages.push(...fromInput);
        adapted.push("input[]");
      }
    }

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
      body = out;
    }
  }

  // 3. Strip Responses-API-only top-level fields and translate text.format.
  const stripped = stripResponsesApiFields(body);
  if (stripped.stripped.length > 0) {
    body = stripped.body;
    adapted.push(`stripped:${stripped.stripped.join(",")}`);
  }

  return { body, adapted };
}
