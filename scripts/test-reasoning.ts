/**
 * Unit tests for src/reasoning.ts.
 *
 * Covers:
 *   - Default effort injection for known reasoning-heavy models.
 *   - No-op for models without a default and no env override.
 *   - Client-supplied `reasoning` is respected (not overwritten).
 *   - ROUTER_REASONING_EFFORT env override wins for any model.
 *   - stripReasoningInPlace removes both fields and reports mutation.
 */
import {
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

console.log("\n=== withReasoningEffort: defaults ===\n");

cleanEnv();
{
  // MiMo gets `low` by default.
  const out = withReasoningEffort({ model: "xiaomi/mimo-v2.5-pro" }, "xiaomi/mimo-v2.5-pro") as
    & { reasoning?: { effort?: string } };
  expect("MiMo default = low", out.reasoning?.effort === "low",
    `effort=${out.reasoning?.effort}`);
}
{
  // Sonnet has no default — left alone.
  const out = withReasoningEffort({ model: "anthropic/claude-sonnet-4.6" }, "anthropic/claude-sonnet-4.6") as
    & { reasoning?: unknown };
  expect("Sonnet untouched (no default)", !out.reasoning,
    `reasoning=${JSON.stringify(out.reasoning)}`);
}
{
  // Client already specified reasoning -> we MUST NOT override it.
  const explicit = { effort: "high" as const, max_tokens: 4096 };
  const out = withReasoningEffort(
    { model: "xiaomi/mimo-v2.5-pro", reasoning: explicit },
    "xiaomi/mimo-v2.5-pro",
  ) as { reasoning?: { effort?: string; max_tokens?: number } };
  expect(
    "client-set reasoning preserved",
    out.reasoning?.effort === "high" && out.reasoning?.max_tokens === 4096,
    `reasoning=${JSON.stringify(out.reasoning)}`,
  );
}
{
  // The defaults table contains the MiMo entry we expect.
  expect(
    "REASONING_EFFORT_DEFAULTS table contains MiMo",
    REASONING_EFFORT_DEFAULTS["xiaomi/mimo-v2.5-pro"] === "low",
  );
}

console.log("\n=== withReasoningEffort: env override ===\n");

cleanEnv();
process.env.ROUTER_REASONING_EFFORT = "medium";
{
  // Env override applies to a model with a default (overriding it)...
  const out = withReasoningEffort({}, "xiaomi/mimo-v2.5-pro") as
    & { reasoning?: { effort?: string } };
  expect(
    "env=medium overrides MiMo's low default",
    out.reasoning?.effort === "medium",
    `effort=${out.reasoning?.effort}`,
  );
}
{
  // ...AND to a model with no default (introducing one).
  const out = withReasoningEffort({}, "anthropic/claude-sonnet-4.6") as
    & { reasoning?: { effort?: string } };
  expect(
    "env=medium applies to Sonnet (no default)",
    out.reasoning?.effort === "medium",
    `effort=${out.reasoning?.effort}`,
  );
}

cleanEnv();
process.env.ROUTER_REASONING_EFFORT = "garbage";
{
  // Invalid env values are ignored (fall back to model defaults).
  const out = withReasoningEffort({}, "xiaomi/mimo-v2.5-pro") as
    & { reasoning?: { effort?: string } };
  expect(
    "invalid env value falls back to per-model default",
    out.reasoning?.effort === "low",
    `effort=${out.reasoning?.effort}`,
  );
}

console.log("\n=== stripReasoningInPlace ===\n");

cleanEnv();
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
{
  const delta: Record<string, unknown> = { reasoning: "only this" };
  stripReasoningInPlace(delta);
  expect(
    "only-reasoning delta becomes empty",
    Object.keys(delta).length === 0,
  );
}

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
