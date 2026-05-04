/**
 * End-to-end smoke test that does NOT touch OpenRouter.
 *
 * Runs by:
 *   1. Spawning a tiny local "OpenRouter" mock that always returns a
 *      well-formed chat completion with usage + cost.
 *   2. Spawning the router, pointing it at the mock via a monkey-patched
 *      module... actually we just invoke the route() classifier and the
 *      DB layer directly here.
 *
 * For the full HTTP loop we use a child server that imports our app but
 * with the OpenRouter base URL replaced via env var. To keep this simple
 * and dependency-free we just exercise the DB + dashboard query layer.
 */

import { recordCall, byModel, byProject, byWorkType, totals, recent } from "../src/db.js";
import { detectProject, detectWorkType } from "../src/classify.js";

console.log("\n=== classify ===");
const sample = {
  messages: [
    {
      role: "system" as const,
      content:
        "You are an AI coding assistant.\n\n<user_info>\nOS Version: darwin 25.5.0\nWorkspace Path: /Users/jonathanbodnar/router\n</user_info>",
    },
    {
      role: "user" as const,
      content: "fix the bug in src/db.ts where ts is parsed wrong",
    },
  ],
};
console.log("project   ->", detectProject(sample));
console.log("work_type ->", detectWorkType(sample));

console.log("\n=== record some synthetic calls ===");
const now = Math.floor(Date.now() / 1000);
const fixtures = [
  { model: "deepseek/deepseek-v4-pro",     tier: "cheap",     project: "router",  work_type: "new_feature", in: 200, out: 400,  cost: 0.0008 },
  { model: "anthropic/claude-sonnet-4.6",  tier: "code",      project: "router",  work_type: "bug_fix",     in: 1200, out: 600, cost: 0.012  },
  { model: "anthropic/claude-opus-4.7",    tier: "reasoning", project: "router",  work_type: "rework",      in: 8000, out: 1500, cost: 0.18  },
  { model: "xiaomi/mimo-v2.5-pro",         tier: "agentic",   project: "shopapp", work_type: "new_feature", in: 50000, out: 2000, cost: 0.09 },
  { model: "anthropic/claude-sonnet-4.6",  tier: "code",      project: "shopapp", work_type: "bug_fix",     in: 800, out: 200,  cost: 0.0042 },
];
for (const f of fixtures) {
  recordCall({
    ts: now,
    requested_model: "auto",
    routed_model: f.model,
    tier: f.tier,
    project: f.project,
    work_type: f.work_type,
    prompt_tokens: f.in,
    completion_tokens: f.out,
    total_tokens: f.in + f.out,
    cost_usd: f.cost,
    duration_ms: 1234,
    status: 200,
    stream: false,
    error: null,
  });
}

console.log("\n=== totals (24h) ===");
console.log(totals("24h"));

console.log("\n=== by model ===");
for (const r of byModel("24h")) console.log(r);

console.log("\n=== by project ===");
for (const r of byProject("24h")) console.log(r);

console.log("\n=== by work_type ===");
for (const r of byWorkType("24h")) console.log(r);

console.log("\n=== recent (top 3) ===");
for (const r of recent("24h", 3)) console.log(r);
