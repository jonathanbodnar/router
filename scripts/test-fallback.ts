/**
 * Verify the upstream-fallback behaviour:
 *   - Primary call returns 500
 *   - Router retries on Sonnet (the code tier)
 *   - Client gets a 200 with the Sonnet response
 *   - Dashboard records the call as routed to Sonnet (not the original tier)
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:http";

const FAKE_PORT = 8901;
const ROUTER_PORT = 8902;
const ROUTER_KEY = "test-router-key";
const DASH_PASS = "test-dash-pass";

/* ---------- fake upstream that fails certain models ---------- */

const FAILING_MODELS = new Set<string>([
  "anthropic/claude-opus-4.7", // Opus always 500s in this test
  "xiaomi/mimo-v2.5-pro",      // MiMo always 400s in this test
]);

const fake = createServer((req, res) => {
  if (req.url !== "/api/v1/chat/completions" || req.method !== "POST") {
    res.statusCode = 404; res.end("nope"); return;
  }
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed: any; try { parsed = JSON.parse(body); } catch { parsed = {}; }
    const model: string = parsed.model ?? "unknown";

    if (FAILING_MODELS.has(model)) {
      const status = model.includes("opus") ? 500 : 400;
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: { message: `${model} simulated failure`, code: status } }));
      return;
    }

    // Success path (this is hit for the Sonnet fallback).
    const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, cost: 0.0123 };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "chatcmpl-fake", object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage,
    }));
  });
});

await new Promise<void>((r) => fake.listen(FAKE_PORT, r));

const child = spawn("node", ["dist/index.js"], {
  env: {
    ...process.env,
    OPENROUTER_API_KEY: "fake-or-key",
    FIREWORKS_API_KEY: "fake-fw-key",
    ROUTER_API_KEY: ROUTER_KEY,
    DASHBOARD_PASSWORD: DASH_PASS,
    PORT: String(ROUTER_PORT),
    DATABASE_PATH: "./.tmp-fallback.db",
    ROUTER_LOG: "1",
    OPENROUTER_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/api/v1`,
    FIREWORKS_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/api/v1`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (d) => process.stdout.write(`[router] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[router-err] ${d}`));
await sleep(700);

async function call(model: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ROUTER_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
  return { status: res.status, body: await res.json() };
}

let failed = 0;
const expect = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

console.log("\n=== test 1: opus -> falls back to sonnet ===");
const r1 = await call("reasoning"); // alias for Opus
expect("client gets 200", r1.status === 200, `status=${r1.status}`);
expect("served by sonnet", r1.body?._router?.routed_to === "anthropic/claude-sonnet-4.6", `routed_to=${r1.body?._router?.routed_to}`);
expect("fell_back recorded", r1.body?._router?.fell_back?.includes("claude-sonnet-4.6") === true, `fell_back=${r1.body?._router?.fell_back}`);

console.log("\n=== test 2: mimo -> falls back to sonnet ===");
const r2 = await call("easy"); // alias for MiMo
expect("client gets 200", r2.status === 200, `status=${r2.status}`);
expect("served by sonnet", r2.body?._router?.routed_to === "anthropic/claude-sonnet-4.6", `routed_to=${r2.body?._router?.routed_to}`);
expect("fell_back recorded", r2.body?._router?.fell_back?.includes("claude-sonnet-4.6") === true, `fell_back=${r2.body?._router?.fell_back}`);

console.log("\n=== test 3: cheap -> succeeds without fallback ===");
const r3 = await call("cheap");
expect("client gets 200", r3.status === 200);
expect("served by deepseek", r3.body?._router?.routed_to?.includes("deepseek-v4-pro") === true);
expect("no fall_back", r3.body?._router?.fell_back == null);

console.log("\n=== test 4: code -> succeeds; no recursive retry on its own failure ===");
// Make Sonnet ALSO fail — should propagate the error rather than loop.
FAILING_MODELS.add("anthropic/claude-sonnet-4.6");
const r4 = await call("code");
expect("client gets 4xx since code itself fails", r4.status >= 400);
FAILING_MODELS.delete("anthropic/claude-sonnet-4.6");

/* ---------- shutdown ---------- */

child.kill("SIGTERM");
fake.close();
await sleep(200);
if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall fallback tests passed");
process.exit(0);
