/**
 * Spins up a fake OpenRouter on :8801, points the router at it via a
 * monkey-patched global fetch, and runs both a non-streaming and a
 * streaming chat completion through the router on :8802. Then hits the
 * dashboard API and prints the resulting stats.
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
    const model = parsed.model ?? "unknown";

    if (!isStream) {
      const payload = {
        id: "chatcmpl-fake",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50, cost: 0.0007 },
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
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0033 },
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
      ROUTER_API_KEY: ROUTER_KEY,
      DASHBOARD_PASSWORD: DASH_PASS,
      PORT: String(ROUTER_PORT),
      DATABASE_PATH: "./.tmp-http-smoke.db",
      ROUTER_LOG: "1",
      // Override the OpenRouter base URL via a tiny env hack:
      OPENROUTER_BASE_URL: `http://127.0.0.1:${FAKE_PORT}/api/v1`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
child.stdout.on("data", (d) => process.stdout.write(`[router] ${d}`));
child.stderr.on("data", (d) => process.stderr.write(`[router-err] ${d}`));

await sleep(700);

/* ---------- exercise it ---------- */

async function call(stream: boolean, project: string, work_type: string, msg: string) {
  const res = await fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ROUTER_KEY}`,
      "x-router-project": project,
      "x-router-work-type": work_type,
    },
    body: JSON.stringify({
      model: "auto",
      stream,
      messages: [{ role: "user", content: msg }],
    }),
  });
  if (stream) {
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
    console.log(`[json resp] status=${res.status} model=${j.model} usage=${JSON.stringify(j.usage)}`);
  }
}

await call(false, "router",  "bug_fix",     "fix the bug in src/db.ts where ts is wrong");
await call(true,  "shopapp", "new_feature", "build a new checkout page in src/Checkout.tsx");

/* ---------- dashboard ---------- */

const dashAuth = "Basic " + Buffer.from(`admin:${DASH_PASS}`).toString("base64");
const stats = await fetch(`http://127.0.0.1:${ROUTER_PORT}/dashboard/api/stats?period=24h`, {
  headers: { authorization: dashAuth },
}).then((r) => r.json());

console.log("\n[dashboard.totals]", stats.totals);
console.log("[dashboard.by_project]", stats.by_project);
console.log("[dashboard.by_work_type]", stats.by_work_type);

const noAuth = await fetch(`http://127.0.0.1:${ROUTER_PORT}/dashboard`);
console.log(`[dashboard no-auth] status=${noAuth.status} (want 401)`);

/* ---------- shutdown ---------- */

child.kill("SIGTERM");
fake.close();
await sleep(200);
process.exit(0);
