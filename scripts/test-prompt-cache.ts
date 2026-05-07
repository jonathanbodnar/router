/**
 * Unit tests for Anthropic prompt-cache breakpoint injection.
 *
 * The router rewrites outbound requests for Sonnet/Opus to add up-to-4
 * `cache_control: {type: "ephemeral"}` markers on:
 *   - the last tool definition
 *   - the last system / developer message
 *   - the last assistant or tool message before the latest user turn
 *
 * Cache reads are 0.1x normal input price, so for Cursor's repetitive
 * agent loop (same system + same 19 tools + growing history) this drops
 * input cost by ~80-90%.
 */
import { isCacheableModel, withPromptCaching } from "../src/prompt-cache.js";
import type { IncomingRequest } from "../src/router.js";

let failed = 0;
const expect = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

// Reset env to defaults for the test run.
delete process.env.ROUTER_PROMPT_CACHE;

console.log("\n=== isCacheableModel ===\n");
expect("sonnet is cacheable", isCacheableModel("anthropic/claude-sonnet-4.6") === true);
expect("opus is cacheable", isCacheableModel("anthropic/claude-opus-4.7") === true);
expect("mimo is NOT cacheable", isCacheableModel("xiaomi/mimo-v2.5-pro") === false);
expect(
  "deepseek is NOT cacheable",
  isCacheableModel("accounts/fireworks/models/deepseek-v4-pro") === false,
);

console.log("\n=== withPromptCaching: no-op cases ===\n");

{
  const before: IncomingRequest = {
    messages: [{ role: "user", content: "hi" }],
  };
  const after = withPromptCaching(before, "xiaomi/mimo-v2.5-pro");
  expect(
    "non-Anthropic model is unmodified",
    JSON.stringify(after) === JSON.stringify(before),
  );
}

{
  process.env.ROUTER_PROMPT_CACHE = "0";
  const before: IncomingRequest = {
    messages: [{ role: "user", content: "hi" }],
  };
  const after = withPromptCaching(before, "anthropic/claude-sonnet-4.6");
  expect(
    "ROUTER_PROMPT_CACHE=0 disables injection",
    JSON.stringify(after) === JSON.stringify(before),
  );
  delete process.env.ROUTER_PROMPT_CACHE;
}

console.log("\n=== withPromptCaching: tools breakpoint ===\n");

{
  const before: IncomingRequest = {
    tools: [
      { type: "function", function: { name: "Read", parameters: {} } },
      { type: "function", function: { name: "Shell", parameters: {} } },
    ],
    messages: [{ role: "user", content: "ls" }],
  };
  const after = withPromptCaching(before, "anthropic/claude-sonnet-4.6");
  const tools = after.tools as any[];
  expect("tools count preserved", tools.length === 2);
  expect("first tool unchanged", tools[0].cache_control === undefined);
  expect(
    "last tool gets cache_control",
    tools[1].cache_control?.type === "ephemeral",
    `got ${JSON.stringify(tools[1].cache_control)}`,
  );
}

console.log("\n=== withPromptCaching: system message breakpoint ===\n");

{
  const before: IncomingRequest = {
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "hi" },
    ],
  };
  const after = withPromptCaching(before, "anthropic/claude-sonnet-4.6");
  const msgs = after.messages as any[];
  expect(
    "system content wrapped in typed-parts array",
    Array.isArray(msgs[0].content),
    `got ${JSON.stringify(msgs[0].content)}`,
  );
  const blocks = msgs[0].content as any[];
  expect("text preserved in block", blocks[0].text === "You are a helpful assistant.");
  expect(
    "system block gets cache_control",
    blocks[0].cache_control?.type === "ephemeral",
  );
  expect(
    "user message untouched (latest turn stays fresh)",
    msgs[1].content === "hi",
  );
}

console.log("\n=== withPromptCaching: conversation history breakpoint ===\n");

{
  // Multi-turn agent loop: system + user + assistant tool_call + tool result + new user.
  // We expect cache_control on:
  //   - tools[last]
  //   - system message
  //   - the tool result (most recent assistant/tool message before the
  //     latest user turn)
  const before: IncomingRequest = {
    tools: [{ type: "function", function: { name: "Shell", parameters: {} } }],
    messages: [
      { role: "system", content: "agent system prompt" },
      { role: "user", content: "list files" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Shell", arguments: "{}" } }] as any },
      { role: "tool", tool_call_id: "c1", content: "a.txt b.txt" },
      { role: "user", content: "now read a.txt" },
    ],
  };
  const after = withPromptCaching(before, "anthropic/claude-opus-4.7");
  const tools = after.tools as any[];
  const msgs = after.messages as any[];

  expect("tools breakpoint set", tools[0].cache_control?.type === "ephemeral");

  const sysBlocks = msgs[0].content as any[];
  expect(
    "system breakpoint set",
    Array.isArray(sysBlocks) && sysBlocks[0].cache_control?.type === "ephemeral",
  );

  // tool result is index 3 (last assistant/tool before final user).
  const toolBlocks = msgs[3].content as any[];
  expect(
    "tool result breakpoint set (caches conversation history)",
    Array.isArray(toolBlocks) && toolBlocks[0].cache_control?.type === "ephemeral",
    `got ${JSON.stringify(msgs[3].content)}`,
  );

  // Latest user turn must stay fresh (no cache_control).
  expect(
    "latest user turn stays fresh (no cache_control)",
    msgs[4].content === "now read a.txt",
  );
}

console.log("\n=== withPromptCaching: idempotence ===\n");

{
  // Pre-existing cache_control should be respected, not duplicated.
  const before: IncomingRequest = {
    tools: [
      {
        type: "function",
        function: { name: "X", parameters: {} },
        cache_control: { type: "ephemeral" },
      } as any,
    ],
    messages: [{ role: "system", content: "x" }, { role: "user", content: "y" }],
  };
  const after = withPromptCaching(before, "anthropic/claude-sonnet-4.6");
  const tools = after.tools as any[];
  expect(
    "existing cache_control preserved exactly once",
    tools[0].cache_control?.type === "ephemeral",
  );
}

console.log("\n=== withPromptCaching: input is not mutated ===\n");

{
  const before: IncomingRequest = {
    tools: [{ type: "function", function: { name: "X", parameters: {} } }],
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
    ],
  };
  const beforeJson = JSON.stringify(before);
  withPromptCaching(before, "anthropic/claude-sonnet-4.6");
  expect(
    "input request object is not mutated",
    JSON.stringify(before) === beforeJson,
  );
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall prompt-cache tests passed");
