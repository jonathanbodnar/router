/**
 * Unit tests for src/reasoning.ts.
 *
 * Covers:
 *   - classifyEffort: dynamic effort classification based on user text,
 *     tool count, and tier. Exercises the LOW_RE, HIGH_RE keyword
 *     patterns, token-count thresholds, and per-tier overrides.
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

console.log("\n=== classifyEffort: agentic tier (MiMo) — low effort ===\n");

cleanEnv();
{
  // Short tool-calling continuation — "user sent tool results back"
  expect(
    "short msg + tools = low",
    classifyEffort("here is the file content", 17, "agentic") === "low",
  );
}
{
  // CSS change
  expect(
    "CSS color change = low",
    classifyEffort("change the background color to blue", 5, "agentic") === "low",
  );
}
{
  expect(
    "rename a variable = low",
    classifyEffort("rename getUserData to fetchUserProfile", 10, "agentic") === "low",
  );
}
{
  expect(
    "fix an import = low",
    classifyEffort("fix the import for React", 8, "agentic") === "low",
  );
}
{
  expect(
    "add a comment = low",
    classifyEffort("add a comment explaining this function", 5, "agentic") === "low",
  );
}
{
  expect(
    "typo fix = low",
    classifyEffort("fix the typo in the error message", 4, "agentic") === "low",
  );
}
{
  expect(
    "what is this = low",
    classifyEffort("what is this function doing?", 5, "agentic") === "low",
  );
}
{
  expect(
    "where is the config = low",
    classifyEffort("where is the database config?", 3, "agentic") === "low",
  );
}
{
  expect(
    "show me all routes = low",
    classifyEffort("show me all the API routes", 5, "agentic") === "low",
  );
}
{
  // Very short, no keywords, has tools = low (tool-call relay)
  expect(
    "4-word msg + tools = low",
    classifyEffort("ok do it", 12, "agentic") === "low",
  );
}
{
  expect(
    "update padding = low",
    classifyEffort("update the padding on the card to 16px", 5, "agentic") === "low",
  );
}
{
  expect(
    "eslint fix = low",
    classifyEffort("run eslint and fix the warnings", 5, "agentic") === "low",
  );
}

console.log("\n=== classifyEffort: agentic tier (MiMo) — medium effort ===\n");

{
  // Medium-length bug fix — no HIGH_RE or LOW_RE keywords
  const msg =
    "the login form is showing a flash of unstyled content after submitting, " +
    "can you debug this and figure out why the state reset is happening " +
    "before the redirect completes? I think it might be a race condition " +
    "in the useEffect cleanup.";
  expect(
    "bug fix description (medium-length) = medium",
    classifyEffort(msg, 15, "agentic") === "medium",
    `tokens≈${Math.ceil(msg.length / 4)}`,
  );
}
{
  // Moderate-length code task, no strong creation/trivial signal
  const msg =
    "update the API response handler to properly parse the new pagination " +
    "format. Right now it expects a flat array but the backend now returns " +
    "an object with data and metadata fields.";
  expect(
    "API handler update = medium",
    classifyEffort(msg, 10, "agentic") === "medium",
    `tokens≈${Math.ceil(msg.length / 4)}`,
  );
}
{
  // 100-token ask, generic dev work
  const msg = "a ".repeat(45) + "please fix the form validation logic here";
  expect(
    "generic medium-length dev request = medium",
    classifyEffort(msg, 8, "agentic") === "medium",
    `tokens≈${Math.ceil(msg.length / 4)}`,
  );
}

console.log("\n=== classifyEffort: agentic tier (MiMo) — high effort ===\n");

{
  expect(
    "build a new component = high",
    classifyEffort("build a new settings page with dark mode toggle", 12, "agentic") === "high",
  );
}
{
  expect(
    "create a new API endpoint = high",
    classifyEffort("create a new REST endpoint for user preferences", 10, "agentic") === "high",
  );
}
{
  expect(
    "implement new feature = high",
    classifyEffort("implement a new notification system with real-time updates", 15, "agentic") === "high",
  );
}
{
  expect(
    "integrate third-party service = high",
    classifyEffort("integrate Stripe payment processing into the checkout flow", 8, "agentic") === "high",
  );
}
{
  expect(
    "new feature keyword = high",
    classifyEffort("add a new feature for bulk user import via CSV", 10, "agentic") === "high",
  );
}
{
  expect(
    "from scratch = high",
    classifyEffort("write the auth middleware from scratch", 5, "agentic") === "high",
  );
}
{
  expect(
    "scaffold = high",
    classifyEffort("scaffold the project structure for the new microservice", 5, "agentic") === "high",
  );
}
{
  expect(
    "end-to-end = high",
    classifyEffort("wire up the end-to-end flow from form submission to email confirmation", 10, "agentic") === "high",
  );
}
{
  expect(
    "don't break existing = high",
    classifyEffort("refactor the data layer but don't break the existing API contracts", 10, "agentic") === "high",
  );
}
{
  expect(
    "large refactor = high",
    classifyEffort("do a large refactor of the state management layer", 8, "agentic") === "high",
  );
}
{
  expect(
    "migration = high",
    classifyEffort("migrate the database schema to support multi-tenancy", 5, "agentic") === "high",
  );
}
{
  expect(
    "multi-file work = high",
    classifyEffort("this is a multi-file change across the frontend and backend", 10, "agentic") === "high",
  );
}

console.log("\n=== classifyEffort: non-agentic tiers ===\n");

{
  // Opus: always high regardless of user text
  expect(
    "reasoning tier = always high",
    classifyEffort("rename a variable", 5, "reasoning") === "high",
  );
}
{
  // Cheap: always low
  expect(
    "cheap tier = always low",
    classifyEffort("build a spaceship from scratch", 0, "cheap") === "low",
  );
}
{
  // Code (Sonnet): always low (Sonnet doesn't have reasoning)
  expect(
    "code tier = always low",
    classifyEffort("complex multi-file refactor", 10, "code") === "low",
  );
}

// --------------- withReasoningEffort ---------------

console.log("\n=== withReasoningEffort: dynamic effort ===\n");

cleanEnv();
{
  // Dynamic effort is passed through for MiMo
  const out = withReasoningEffort(
    { model: "xiaomi/mimo-v2.5-pro" },
    "xiaomi/mimo-v2.5-pro",
    "medium",
  ) as { reasoning?: { effort?: string } };
  expect(
    "MiMo gets dynamic medium effort",
    out.reasoning?.effort === "medium",
    `effort=${out.reasoning?.effort}`,
  );
}
{
  // Dynamic high for MiMo
  const out = withReasoningEffort(
    { model: "xiaomi/mimo-v2.5-pro" },
    "xiaomi/mimo-v2.5-pro",
    "high",
  ) as { reasoning?: { effort?: string } };
  expect(
    "MiMo gets dynamic high effort",
    out.reasoning?.effort === "high",
    `effort=${out.reasoning?.effort}`,
  );
}
{
  // Non-reasoning model gets nothing even with dynamic effort
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
  // Client-set reasoning is never overridden
  const explicit = { effort: "high" as const, max_tokens: 4096 };
  const out = withReasoningEffort(
    { model: "xiaomi/mimo-v2.5-pro", reasoning: explicit },
    "xiaomi/mimo-v2.5-pro",
    "low",
  ) as { reasoning?: { effort?: string; max_tokens?: number } };
  expect(
    "client-set reasoning preserved even when dynamic=low",
    out.reasoning?.effort === "high" && out.reasoning?.max_tokens === 4096,
    `reasoning=${JSON.stringify(out.reasoning)}`,
  );
}
{
  // Opus gets high from static defaults when no dynamic effort passed
  const out = withReasoningEffort(
    { model: "anthropic/claude-opus-4.7" },
    "anthropic/claude-opus-4.7",
    null,
  ) as { reasoning?: { effort?: string } };
  expect(
    "Opus falls back to static default (high)",
    out.reasoning?.effort === "high",
    `effort=${out.reasoning?.effort}`,
  );
}

console.log("\n=== withReasoningEffort: env override ===\n");

cleanEnv();
process.env.ROUTER_REASONING_EFFORT = "medium";
{
  const out = withReasoningEffort({}, "xiaomi/mimo-v2.5-pro", "low") as
    & { reasoning?: { effort?: string } };
  expect(
    "env=medium overrides dynamic low",
    out.reasoning?.effort === "medium",
    `effort=${out.reasoning?.effort}`,
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
  const out = withReasoningEffort({}, "xiaomi/mimo-v2.5-pro", "medium") as
    & { reasoning?: { effort?: string } };
  expect(
    "invalid env falls back to dynamic effort",
    out.reasoning?.effort === "medium",
    `effort=${out.reasoning?.effort}`,
  );
}

console.log("\n=== REASONING_EFFORT_DEFAULTS table ===\n");

cleanEnv();
expect(
  "MiMo static default = low",
  REASONING_EFFORT_DEFAULTS["xiaomi/mimo-v2.5-pro"] === "low",
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
