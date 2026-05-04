import { route, type RouteDecision } from "../src/router.js";

interface Case {
  name: string;
  req: Parameters<typeof route>[0];
  expect?: RouteDecision["tier"];
}

const cases: Case[] = [
  // --- non-dev / cheap ---
  { name: "short casual question",      expect: "cheap",
    req: { model: "auto", messages: [{ role: "user", content: "what's the capital of france?" }] } },
  { name: "short business copy",        expect: "cheap",
    req: { model: "auto", messages: [{ role: "user", content: "write a 3-bullet summary of why we should adopt PRs" }] } },

  // --- easy dev / agentic / MiMo ---
  { name: "small code edit + file path", expect: "agentic",
    req: { model: "auto", messages: [{ role: "user", content:
      "fix the bug in src/foo.ts:\n```ts\nfunction add(a: number, b: number) { return a - b }\n```" }] } },
  { name: "tool-calling request (short)", expect: "agentic",
    req: { model: "auto", tools: [{ type: "function", function: { name: "search", parameters: {} } }],
      messages: [{ role: "user", content: "find recent issues about auth" }] } },
  { name: "Cursor-like chat (short, w/ tools)", expect: "agentic",
    req: { model: "gpt-4.1",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [{ role: "system", content: "you are an agent." },
                 { role: "user", content: "rename `foo` to `bar` in src/util.ts" }] } },

  // --- bulk doc / long context / agentic ---
  { name: "long-context doc (no tools)", expect: "agentic",
    req: { model: "auto", messages: [{ role: "user", content: "summarize this:\n" + "lorem ipsum ".repeat(20000) }] } },

  // --- moderate dev / code / Sonnet ---
  { name: "substantial code (large + fence)", expect: "code",
    req: { model: "auto", messages: [{ role: "user", content:
      "implement this feature in src/foo.ts:\n```ts\n" + "// pretend this is real code\n".repeat(800) + "\n```" }] } },
  { name: "Cursor-like chat (large, w/ tools)", expect: "code",
    req: { model: "gpt-4.1",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [{ role: "system", content: "you are an agent." },
                 { role: "user", content: "refactor src/billing/index.ts to use the new payment provider:\n" + "lorem ".repeat(4000) }] } },

  // --- hard / reasoning / Opus ---
  { name: "architecture review (substantial)", expect: "reasoning",
    req: { model: "auto", messages: [{ role: "user", content:
      "I'm doing a complex refactor of our distributed system architecture. " +
      "Deeply analyze the trade-offs between event sourcing and CRUD for our billing service. " +
      "Context: ".padEnd(28000, "x") }] } },

  // --- aliases / passthrough ---
  { name: "alias: easy",   expect: "agentic",  req: { model: "easy",   messages: [{ role: "user", content: "hi" }] } },
  { name: "alias: code",   expect: "code",     req: { model: "code",   messages: [{ role: "user", content: "hi" }] } },
  { name: "alias: hard",   expect: "reasoning",req: { model: "hard",   messages: [{ role: "user", content: "hi" }] } },
  { name: "passthrough OR model id",            req: { model: "anthropic/claude-opus-4.7", messages: [{ role: "user", content: "hi" }] } },
  { name: "passthrough Fireworks model id",     req: { model: "accounts/fireworks/models/deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] } },
  { name: "model name with project tag",        req: { model: "gpt-4.1__router", messages: [{ role: "user", content: "hi" }] } },
];

let failed = 0;
for (const c of cases) {
  const d = route(c.req);
  const ok = c.expect == null || d.tier === c.expect;
  if (!ok) failed++;
  const status = c.expect == null ? "    " : ok ? "PASS" : "FAIL";
  console.log(
    `${status} ${c.name.padEnd(36)} -> ${d.tier.padEnd(9)} ${d.provider.padEnd(10)} ${d.model}  [${d.reason}]`,
  );
}
if (failed > 0) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
