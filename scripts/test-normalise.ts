/**
 * Unit tests for body normalisation. Two transforms tested:
 *   - Cursor / Responses-API shapes (input, instructions, prompt, system)
 *     reconstructed into a chat-completions `messages` array.
 *   - Flat tools / tool_choice (Responses API) translated to the nested
 *     chat-completions shape that strict upstreams (sglang behind MiMo,
 *     Anthropic providers) require. This is the fix for Cursor agent
 *     requests 500ing every time on every OpenRouter Anthropic / MiMo
 *     call when the prompt had tools attached.
 */
import {
  inputArrayToMessages,
  nestFlatTools,
  normaliseBody,
} from "../src/normalise.js";

let failed = 0;
const expect = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

console.log("\n=== nestFlatTools ===\n");

{
  // The exact Cursor-shaped tool that triggered the original 400.
  const before = {
    model: "auto",
    tools: [
      {
        type: "function",
        name: "Shell",
        description: "run a command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
        strict: false,
      },
    ],
  };
  const { body, translated } = nestFlatTools(before);
  expect("translated flag set", translated === true);
  const t = (body.tools as any[])[0];
  expect("type preserved", t.type === "function");
  expect("name nested under function", t.function?.name === "Shell");
  expect("description nested", t.function?.description === "run a command");
  expect("parameters nested", t.function?.parameters?.type === "object");
  expect("strict preserved nested", t.function?.strict === false);
  expect("top-level name removed", t.name === undefined);
}

{
  // Already-nested tools must pass through unchanged.
  const before = {
    tools: [
      { type: "function", function: { name: "X", parameters: { type: "object" } } },
    ],
  };
  const { translated } = nestFlatTools(before);
  expect("nested tool not double-translated", translated === false);
}

{
  // Flat tool_choice -> nested.
  const before = { tool_choice: { type: "function", name: "Shell" } };
  const { body, translated } = nestFlatTools(before);
  expect("tool_choice translated", translated === true);
  expect(
    "tool_choice has nested function.name",
    (body.tool_choice as any)?.function?.name === "Shell",
    `tool_choice=${JSON.stringify(body.tool_choice)}`,
  );
}

{
  // String tool_choice ("auto" / "none" / "required") untouched.
  const before = { tool_choice: "auto" };
  const { body, translated } = nestFlatTools(before);
  expect("string tool_choice unchanged", translated === false && body.tool_choice === "auto");
}

{
  // No tools at all -> no-op.
  const { translated } = nestFlatTools({ model: "auto", messages: [] });
  expect("body without tools is no-op", translated === false);
}

console.log("\n=== normaliseBody (Cursor + tools, end-to-end) ===\n");

{
  const before = {
    model: "auto",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        name: "Read",
        description: "read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  };
  const { body, adapted } = normaliseBody(before);
  expect(
    "adapted reports tools translation",
    adapted.includes("tools(flat->nested)"),
    `adapted=${JSON.stringify(adapted)}`,
  );
  const t = (body.tools as any[])[0];
  expect("forwarded tools are nested", t.function?.name === "Read");
  expect(
    "messages preserved",
    Array.isArray(body.messages) && (body.messages as any[])[0]?.content === "hi",
  );
}

{
  // Responses-API shape (no messages, has input/instructions) AND flat tools.
  const before = {
    model: "auto",
    instructions: "be concise",
    input: "what time is it?",
    tools: [{ type: "function", name: "Clock", parameters: {} }],
  };
  const { body, adapted } = normaliseBody(before);
  expect(
    "both adaptations applied",
    adapted.includes("tools(flat->nested)") &&
      adapted.includes("instructions") &&
      adapted.includes("input"),
    `adapted=${JSON.stringify(adapted)}`,
  );
  const t = (body.tools as any[])[0];
  expect("tools nested in responses-api combo case", t.function?.name === "Clock");
  expect(
    "messages reconstructed",
    Array.isArray(body.messages) &&
      (body.messages as any[]).length === 2 &&
      (body.messages as any[])[0].role === "system" &&
      (body.messages as any[])[1].role === "user",
  );
}

{
  // No-op when nothing to adapt.
  const before = {
    model: "auto",
    messages: [{ role: "user", content: "hi" }],
  };
  const { adapted } = normaliseBody(before);
  expect("no-op case has empty adapted list", adapted.length === 0);
}

console.log("\n=== inputArrayToMessages (Responses API conversation) ===\n");

{
  // The exact shape Cursor sends: system message with string content,
  // user message with typed-parts array content. The previous bug was
  // returning "" for the user message because content was an array.
  const msgs = inputArrayToMessages([
    { role: "system", content: "you are a coding agent" },
    {
      role: "user",
      content: [{ type: "input_text", text: "summarize this project" }],
    },
  ]);
  expect("two messages produced", msgs.length === 2, `got ${msgs.length}`);
  expect("system role preserved", msgs[0].role === "system");
  expect("system content preserved", msgs[0].content === "you are a coding agent");
  expect("user role preserved", msgs[1].role === "user");
  expect(
    "typed-parts array flattened to text",
    msgs[1].content === "summarize this project",
    `got ${JSON.stringify(msgs[1].content)}`,
  );
}

{
  // Multiple typed parts in one message -> joined with newlines.
  const msgs = inputArrayToMessages([
    {
      role: "user",
      content: [
        { type: "input_text", text: "first part" },
        { type: "input_text", text: "second part" },
      ],
    },
  ]);
  expect(
    "multiple parts joined with newlines",
    msgs[0].content === "first part\nsecond part",
    `got ${JSON.stringify(msgs[0].content)}`,
  );
}

{
  // function_call -> assistant tool_calls
  const msgs = inputArrayToMessages([
    {
      type: "function_call",
      call_id: "call_abc",
      name: "Shell",
      arguments: '{"command":"ls"}',
    },
  ]);
  expect("function_call -> 1 message", msgs.length === 1);
  expect("function_call -> assistant role", msgs[0].role === "assistant");
  expect("function_call -> null content", msgs[0].content === null);
  expect("function_call -> tool_calls present", Array.isArray(msgs[0].tool_calls));
  expect("function_call name preserved", msgs[0].tool_calls?.[0].function.name === "Shell");
  expect(
    "function_call arguments preserved",
    msgs[0].tool_calls?.[0].function.arguments === '{"command":"ls"}',
  );
  expect("function_call id preserved", msgs[0].tool_calls?.[0].id === "call_abc");
}

{
  // function_call_output -> tool message with tool_call_id
  const msgs = inputArrayToMessages([
    { type: "function_call_output", call_id: "call_abc", output: "total 0\n" },
  ]);
  expect("function_call_output -> tool role", msgs[0].role === "tool");
  expect(
    "function_call_output -> tool_call_id wired",
    msgs[0].tool_call_id === "call_abc",
  );
  expect("function_call_output -> output content", msgs[0].content === "total 0\n");
}

{
  // Realistic multi-turn: system, user, assistant calls Shell, tool result,
  // assistant final text.
  const msgs = inputArrayToMessages([
    { role: "system", content: "you are an agent" },
    { role: "user", content: [{ type: "input_text", text: "list files" }] },
    {
      type: "function_call",
      call_id: "c1",
      name: "Shell",
      arguments: '{"command":"ls"}',
    },
    { type: "function_call_output", call_id: "c1", output: "a.txt\nb.txt" },
    { role: "assistant", content: "There are two files: a.txt and b.txt." },
  ]);
  expect("multi-turn produces 5 messages", msgs.length === 5);
  expect("turn 0 system", msgs[0].role === "system");
  expect("turn 1 user with extracted text", msgs[1].role === "user" && msgs[1].content === "list files");
  expect(
    "turn 2 assistant tool_calls",
    msgs[2].role === "assistant" && msgs[2].content === null && Array.isArray(msgs[2].tool_calls),
  );
  expect(
    "turn 3 tool result",
    msgs[3].role === "tool" && msgs[3].tool_call_id === "c1" && msgs[3].content === "a.txt\nb.txt",
  );
  expect(
    "turn 4 assistant final text",
    msgs[4].role === "assistant" && msgs[4].content === "There are two files: a.txt and b.txt.",
  );
}

console.log("\n=== normaliseBody: Cursor-shaped Responses API request ===\n");

{
  // Reproduces the exact request keys observed in Railway logs:
  //   keys=[user,model,input,tools,store,stream,metadata,stream_options]
  // and the input shape that broke before this fix.
  const before = {
    user: "9057d5091e396134",
    model: "gpt-4.1",
    store: true,
    stream: true,
    stream_options: { include_usage: true },
    metadata: { project: "shoutout" },
    input: [
      { role: "system", content: "you are a coding agent" },
      {
        role: "user",
        content: [{ type: "input_text", text: "scan the project and summarize" }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "Shell",
        description: "run a shell command",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ],
  };
  const { body, adapted } = normaliseBody(before);

  expect(
    "tools translated",
    adapted.includes("tools(flat->nested)"),
    `adapted=${JSON.stringify(adapted)}`,
  );
  expect(
    "input[] processed",
    adapted.includes("input[]"),
    `adapted=${JSON.stringify(adapted)}`,
  );
  expect(
    "store stripped",
    adapted.some((a) => a.startsWith("stripped:") && a.includes("store")),
    `adapted=${JSON.stringify(adapted)}`,
  );

  expect(
    "messages array built",
    Array.isArray(body.messages) && (body.messages as any[]).length === 2,
    `messages=${JSON.stringify(body.messages)}`,
  );
  const msgs = body.messages as any[];
  expect("system message preserved", msgs[0].role === "system" && msgs[0].content === "you are a coding agent");
  expect(
    "user message extracted from typed parts (THE BUG WAS HERE)",
    msgs[1].role === "user" && msgs[1].content === "scan the project and summarize",
    `user.content=${JSON.stringify(msgs[1].content)}`,
  );

  expect("input field removed", body.input === undefined);
  expect("store field removed", body.store === undefined);
  expect(
    "metadata stripped (causes gpt-4.1__shoutout stall on strict upstreams)",
    body.metadata === undefined,
  );
  expect(
    "tools nested",
    (body.tools as any[])[0].function?.name === "Shell",
  );
  expect("model preserved", body.model === "gpt-4.1");
  expect("stream preserved", body.stream === true);
}

{
  // text.format -> response_format
  const before = {
    model: "auto",
    input: "hi",
    text: { format: { type: "json_schema", schema: { type: "object" } } },
  };
  const { body, adapted } = normaliseBody(before);
  expect(
    "text.format translated",
    adapted.some((a) => a.includes("text.format->response_format")),
    `adapted=${JSON.stringify(adapted)}`,
  );
  expect("response_format set", (body as any).response_format?.type === "json_schema");
  expect("text field removed", body.text === undefined);
}

console.log("\n=== normaliseBody: image content (vision support) ===\n");

{
  // Cursor-style input_image part with a data URL.
  const before = {
    model: "auto",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "what's in this screenshot?" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,iVBORw0KGgoAAAANSU=",
          },
        ],
      },
    ],
  };
  const { body } = normaliseBody(before);
  const msgs = body.messages as any[];
  expect("image-bearing message preserved", msgs.length === 1);
  expect("content is structured array (not flattened)", Array.isArray(msgs[0].content));
  const parts = msgs[0].content as any[];
  expect("text part preserved", parts[0]?.type === "text" && parts[0]?.text === "what's in this screenshot?");
  expect(
    "image normalised to OpenAI image_url shape",
    parts[1]?.type === "image_url" &&
      parts[1]?.image_url?.url === "data:image/png;base64,iVBORw0KGgoAAAANSU=",
    `got ${JSON.stringify(parts[1])}`,
  );
}

{
  // OpenAI-style image_url part with object shape and detail.
  const before = {
    model: "auto",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          {
            type: "image_url",
            image_url: { url: "https://example.com/x.png", detail: "high" },
          },
        ],
      },
    ],
  };
  const { body } = normaliseBody(before);
  const parts = (body.messages as any[])[0].content as any[];
  expect(
    "OpenAI image_url passes through with detail",
    parts[1]?.type === "image_url" &&
      parts[1]?.image_url?.url === "https://example.com/x.png" &&
      parts[1]?.image_url?.detail === "high",
  );
}

{
  // Anthropic-style image source -> rewritten as OpenAI image_url.
  const before = {
    model: "auto",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "look" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
          },
        ],
      },
    ],
  };
  const { body } = normaliseBody(before);
  const parts = (body.messages as any[])[0].content as any[];
  expect(
    "Anthropic image source -> data URL",
    parts[1]?.type === "image_url" &&
      parts[1]?.image_url?.url === "data:image/jpeg;base64,AAAA",
  );
}

{
  // Pure text in a typed-parts array still flattens to a string for
  // backwards compat with classifier code that assumes string content.
  const before = {
    model: "auto",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
  };
  const { body } = normaliseBody(before);
  const c = (body.messages as any[])[0].content;
  expect("text-only content stays a string", typeof c === "string" && c === "hi");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall normalise tests passed");
