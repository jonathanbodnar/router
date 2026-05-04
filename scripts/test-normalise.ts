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
import { nestFlatTools, normaliseBody } from "../src/normalise.js";

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

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall normalise tests passed");
