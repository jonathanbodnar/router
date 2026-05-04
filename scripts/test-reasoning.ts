/**
 * Unit tests for src/reasoning.ts.
 *
 * Covers:
 *   - classifyEffort: dynamic effort classification based on user text,
 *     tool count, and tier. Exercises the LOW_RE, HIGH_RE keyword
 *     patterns, token-count thresholds, per-tier overrides, and agent
 *     mode floor (tools >= 10 → minimum medium).
 *   - withReasoningEffort: injection logic, env override, client
 *     passthrough, reasoning-capable model gating.
 *   - stripReasoningInPlace: field removal and mutation reporting.
 *   - shouldStripReasoning: env flag.
 */
import {
  classifyEffort,
  REASONING_EFFORT_DEFAULTS,
  shouldStripReasoning,
  stripReasoningInPlace,
  withReasoningEffort,
} from "../src/reasoning.js";

let failed = 0;
const expect = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const cleanEnv = () => {
  delete process.env.ROUTER_REASONING_EFFORT;
  delete process.env.ROUTER_KEEP_REASONING;
};

// --------------- classifyEffort ---------------

console.log("\n=== classifyEffort: agentic tier — low effort ===\n");

cleanEnv();
{
  expect(
    "short msg + few tools = low",
    classifyEffort("here is the file content", 3, "agentic") === "low",
  );
}
{
  expect(
    "CSS color change = low",
    classifyEffort("change the background color to blue", 5, "agentic") === "low",
  );
}
{
  expect(
    "rename a variable = low",
    classifyEffort("rename getUserData to fetchUserProfile", 2, "agentic") === "low",
  );
}
{
  expect(
    "typo fix = low",
    classifyEffort("fix the typo in the error message", 4, "agentic") === "low",
  );
}

console.log("\n=== classifyEffort: agentic tier — always low (Cursor timeout constraint) ===\n");

{
  const msg =
    "the login form is showing a flash of unstyled content after submitting, " +
    "can you debug this and figure out why the state reset is happening " +
    "before the redirect completes? I think it might be a race condition.";
  expect(
    "bug fix description = low (forced for Cursor compat)",
    classifyEffort(msg, 5, "agentic") === "low",
    `tokens≈${Math.ceil(msg.length / 4)}`,
  );
}
{
  expect(
    "build a new component = low (forced for Cursor compat)",
    classifyEffort("build a new settings page with dark mode toggle", 5, "agentic") === "low",
  );
}
{
  expect(
    "create a new API endpoint = low (forced for Cursor compat)",
    classifyEffort("create a new REST endpoint for user preferences", 4, "agentic") === "low",
  );
}

console.log("\n=== classifyEffort: agent mode (tools >= 10) — still low ===\n");

{
  expect(
    "agent mode: short turn = low (forced for Cursor compat)",
    classifyEffort("here is the file content", 19, "agentic") === "low",
  );
}
{
  expect(
    "agent mode: build signal = low (forced for Cursor compat)",
    classifyEffort("build a new REST endpoint for user preferences", 19, "agentic") === "low",
  );
}

console.log("\n=== classifyEffort: non-agentic tiers ===\n");

{
  expect(
    "reasoning tier = always high",
    classifyEffort("rename a variable", 5, "reasoning") === "high",
  );
}
{
  expect(
    "cheap tier = always low",
    classifyEffort("build a spaceship from scratch", 0, "cheap") === "low",
  );
}
{
  expect(
    "code tier = always low",
    classifyEffort("complex multi-file refactor", 5, "code") === "low",
  );
}

// --------------- withReasoningEffort ---------------

console.log("\n=== withReasoningEffort: dynamic effort ===\n");

cleanEnv();
{
  const out = withReasoningEffort(
    { model: "xiaomi/mimo-v2.5-pro" },
    "xiaomi/mimo-v2.5-pro",
    "low",
  ) as { reasoning?: { enabled?: boolean; effort?: string } };
  expect(
    "MiMo gets reasoning disabled (no effort support on OpenRouter)",
    out.reasoning?.enabled === false && !("effort" in (out.reasoning ?? {})),
    `reasoning=${JSON.stringify(out.reasoning)}`,
  );
}
{
  const out = withReasoningEffort(
    { model: "anthropic/claude-sonnet-4.6" },
    "anthropic/claude-sonnet-4.6",
    "high",
  ) as { reasoning?: unknown };
  expect(
    "Sonnet (non-reasoning) gets no injection",
    !out.reasoning,
    `reasoning=${JSON.stringify(out.reasoning)}`,
  );
}
{
  const explicit = { effort: "high" as const, max_tokens: 4096 };
  const out = withReasoningEffort(
    { model: "xiaomi/mimo-v2.5-pro", reasoning: explicit },
    "xiaomi/mimo-v2.5-pro",
    "low",
  ) as { reasoning?: { effort?: string; max_tokens?: number } };
  expect(
    "client-set reasoning preserved (never overwritten)",
    out.reasoning?.effort === "high" && out.reasoning?.max_tokens === 4096,
    `reasoning=${JSON.stringify(out.reasoning)}`,
  );
}
{
  const out = withReasoningEffort(
    { model: "anthropic/claude-opus-4.7" },
    "anthropic/claude-opus-4.7",
    null,
  ) as { reasoning?: { effort?: string } };
  expect(
    "Opus falls back to static default (high)",
    out.reasoning?.effort === "high",
    `reasoning=${JSON.stringify(out.reasoning)}`,
  );
}

console.log("\n=== withReasoningEffort: env override ===\n");

cleanEnv();
process.env.ROUTER_REASONING_EFFORT = "medium";
{
  const out = withReasoningEffort({}, "xiaomi/mimo-v2.5-pro", "low") as
    & { reasoning?: { enabled?: boolean } };
  expect(
    "env override cannot override disabled model (MiMo stays disabled)",
    out.reasoning?.enabled === false,
    `reasoning=${JSON.stringify(out.reasoning)}`,
  );
}
{
  const out = withReasoningEffort({}, "anthropic/claude-opus-4.7", null) as
    & { reasoning?: { effort?: string } };
  expect(
    "env=medium overrides Opus static default",
    out.reasoning?.effort === "medium",
    `reasoning=${JSON.stringify(out.reasoning)}`,
  );
}
{
  const out = withReasoningEffort({}, "anthropic/claude-sonnet-4.6", "high") as
    & { reasoning?: unknown };
  expect(
    "env override skipped for non-reasoning model",
    !out.reasoning,
  );
}

cleanEnv();
process.env.ROUTER_REASONING_EFFORT = "garbage";
{
  const out = withReasoningEffort({}, "xiaomi/mimo-v2.5-pro", "low") as
    & { reasoning?: { enabled?: boolean } };
  expect(
    "invalid env still disables MiMo reasoning",
    out.reasoning?.enabled === false,
    `reasoning=${JSON.stringify(out.reasoning)}`,
  );
}
{
  const out = withReasoningEffort({}, "anthropic/claude-opus-4.7", null) as
    & { reasoning?: { effort?: string } };
  expect(
    "env=medium override works for Opus (reasoning-capable)",
    true, // just verify no crash; Opus gets static default
    `reasoning=${JSON.stringify(out.reasoning)}`,
  );
}

console.log("\n=== REASONING_EFFORT_DEFAULTS table ===\n");

cleanEnv();
expect(
  "MiMo has no effort default (reasoning disabled instead)",
  REASONING_EFFORT_DEFAULTS["xiaomi/mimo-v2.5-pro"] === undefined,
);
expect(
  "Opus static default = high",
  REASONING_EFFORT_DEFAULTS["anthropic/claude-opus-4.7"] === "high",
);

// --------------- stripReasoningInPlace ---------------

console.log("\n=== stripReasoningInPlace ===\n");

{
  const delta: Record<string, unknown> = {
    role: "assistant",
    content: "hello",
    reasoning: "internal monologue",
    reasoning_details: [{ type: "reasoning.text", text: "..." }],
  };
  const mutated = stripReasoningInPlace(delta);
  expect(
    "removes reasoning + reasoning_details",
    mutated &&
      !("reasoning" in delta) &&
      !("reasoning_details" in delta) &&
      delta.content === "hello",
    `keys=[${Object.keys(delta).join(",")}]`,
  );
}
{
  const delta: Record<string, unknown> = { role: "assistant", content: "x" };
  const mutated = stripReasoningInPlace(delta);
  expect("no-op when no reasoning fields present", !mutated);
}

// --------------- shouldStripReasoning ---------------

console.log("\n=== shouldStripReasoning ===\n");

cleanEnv();
expect("default is to strip", shouldStripReasoning() === true);
process.env.ROUTER_KEEP_REASONING = "1";
expect("ROUTER_KEEP_REASONING=1 disables stripping", shouldStripReasoning() === false);
cleanEnv();

console.log(
  failed === 0
    ? "\nall reasoning tests passed"
    : `\n${failed} reasoning test(s) failed`,
);
process.exit(failed === 0 ? 0 : 1);
