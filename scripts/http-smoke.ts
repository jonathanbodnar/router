/**
 * Spins up a single fake "OpenAI-compatible" server on :8801 that
 * impersonates BOTH OpenRouter and Fireworks (the only difference matters
 * here is whether `usage.cost` is present in the response — OpenRouter
 * returns it, Fireworks does not).
 *
 * We then run the router on :8802 with both upstream base URLs pointed at
 * the fake, and exercise the cheap tier (Fireworks) and the code tier
 * (OpenRouter) so we can verify that:
 *
 *   - dispatch picks the correct provider per tier,
 *   - cost is read from `usage.cost` for OpenRouter calls,
 *   - cost is computed locally from pricing.ts for Fireworks calls.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:http";

const FAKE_PORT = 8801;
const ROUTER_PORT = 8802;
const ROUTER_KEY = "test-router-key";
const DASH_PASS = "test-dash-pass";

/* ---------- fake OpenRouter ---------- */

const fake = createServer((req, res) => {
  if (req.url !== "/api/v1/chat/completions" || req.method !== "POST") {
    res.statusCode = 404;
    res.end("nope");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { parsed = {}; }
    const isStream = parsed.stream === true;
    const model: string = parsed.model ?? "unknown";
    const isFireworks = model.startsWith("accounts/fireworks/");
    // OpenRouter sends cost; Fireworks does not.
    const usageBase = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 };
    const usageNonStream = isFireworks ? usageBase : { ...usageBase, cost: 0.0123 };

    if (!isStream) {
      const payload = {
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: usageNonStream,
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
      return;
    }

    res.setHeader("content-type", "text/event-stream");
    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    const id = "chatcmpl-fake-stream";
    send({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { role: "assistant" } }] });
    send({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "hello " } }] });
    send({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "world" }, finish_reason: "stop" }] });
    send({
      id, object: "chat.completion.chunk", model,
      choices: [],
      usage: usageNonStream,
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise<void>((r) => fake.listen(FAKE_PORT, r));
console.log(`[fake-openrouter] listening on :${FAKE_PORT}`);

/* ---------- launch router (real binary, fake upstream via env) ---------- */

const child = spawn(
  "node",
  ["dist/index.js"],
  {
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "fake-or-key",
      FIREWORKS_API_KEY: "fake-fw-key",
      ROUTER_API_KEY: ROUTER_KEY,
      DASHBOARD_PASSWORD: DASH_PASS,
      PORT: String(ROUTER_PORT),
      DATABASE_PATH: "./.tmp-http-smoke.db",
      ROUTER_LOG: "1",
      // Point both upstreams at the fake server.
      OPENROUTER_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/api/v1`,
      FIREWORKS_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/api/v1`,
      // Pin Fireworks pricing to known values so the assertion is stable.
      PRICE_DEEPSEEK_V4_INPUT: "1.0",
      PRICE_DEEPSEEK_V4_OUTPUT: "2.0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (d) => process.stdout.write(`[router] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[router-err] ${d}`));

await sleep(700);

/* ---------- exercise it ---------- */

async function call(opts: {
  stream: boolean;
  project: string;
  work_type: string;
  model?: string;
  msg: string;
}) {
  const res = await fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ROUTER_KEY}`,
      "x-router-project": opts.project,
      "x-router-work-type": opts.work_type,
    },
    body: JSON.stringify({
      model: opts.model ?? "auto",
      stream: opts.stream,
      messages: [{ role: "user", content: opts.msg }],
    }),
  });
  if (opts.stream) {
    const reader = res.body!.getReader();
    let total = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += new TextDecoder().decode(value);
    }
    console.log(`[stream resp] status=${res.status} bytes=${total.length}`);
  } else {
    const j = await res.json();
    console.log(
      `[json resp] status=${res.status} model=${j.model} provider=${j._router?.provider} routed_to=${j._router?.routed_to} usage=${JSON.stringify(j.usage)}`,
    );
  }
}

// 1. code tier -> Sonnet (OpenRouter, non-streaming) — cost from usage.cost
await call({ stream: false, project: "router",    work_type: "bug_fix",     model: "code",  msg: "fix the bug in src/db.ts where ts is wrong" });
// 2. code tier -> Sonnet (OpenRouter, streaming) — cost from final chunk
await call({ stream: true,  project: "shopapp",   work_type: "new_feature", model: "code",  msg: "build a new checkout page in src/Checkout.tsx" });
// 3. cheap tier -> Fireworks (non-streaming) — cost COMPUTED locally,
//    1000 in * $1/1M + 200 out * $2/1M = 0.0014 USD
await call({ stream: false, project: "marketing", work_type: "other",       model: "cheap", msg: "write a 3-bullet summary of why we should adopt PRs" });
// 4. cheap tier -> Fireworks (streaming)
await call({ stream: true,  project: "marketing", work_type: "other",       model: "cheap", msg: "write 5 alt taglines for our login page" });

/* ---------- dashboard ---------- */

const dashAuth = "Basic " + Buffer.from(`admin:${DASH_PASS}`).toString("base64");
const stats = await fetch(`http://127.0.0.1:${ROUTER_PORT}/dashboard/api/stats?period=24h`, {
  headers: { authorization: dashAuth },
}).then((r) => r.json());

console.log("\n[dashboard.totals]", stats.totals);
console.log("[dashboard.by_model]", stats.by_model);
console.log("[dashboard.by_project]", stats.by_project);
console.log("[dashboard.by_work_type]", stats.by_work_type);

// Sanity-check Fireworks cost computation:
// 2 calls × (1000 in × $1/1M + 200 out × $2/1M) = 2 × 0.0014 = $0.0028
const fwRow = stats.by_model.find((r: any) => r.key.startsWith("accounts/fireworks/"));
const expectedFwCost = 2 * (1000 / 1e6 * 1.0 + 200 / 1e6 * 2.0);
const fwOk = fwRow && Math.abs(fwRow.cost_usd - expectedFwCost) < 1e-9;
console.log(`[assert] fireworks cost = ${fwRow?.cost_usd} (expected ${expectedFwCost}) -> ${fwOk ? "OK" : "FAIL"}`);

// And OpenRouter cost should come straight from usage.cost = $0.0123 × 2 calls
const orRow = stats.by_model.find((r: any) => r.key.startsWith("anthropic/"));
const expectedOrCost = 2 * 0.0123;
const orOk = orRow && Math.abs(orRow.cost_usd - expectedOrCost) < 1e-9;
console.log(`[assert] openrouter cost = ${orRow?.cost_usd} (expected ${expectedOrCost}) -> ${orOk ? "OK" : "FAIL"}`);

const noAuth = await fetch(`http://127.0.0.1:${ROUTER_PORT}/dashboard`);
console.log(`[dashboard no-auth] status=${noAuth.status} (want 401)`);

/* ---------- shutdown ---------- */

child.kill("SIGTERM");
fake.close();
await sleep(200);
process.exit(0);
