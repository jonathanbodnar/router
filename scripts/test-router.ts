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
      ("I'm doing a complex refactor of our distributed system architecture. " +
       "Deeply analyze the trade-offs between event sourcing and CRUD for our billing service. " +
       "Walk me through the migration plan, the rollback strategy, and how we'd handle the " +
       "consistency model across services. ").repeat(20) }] } },

  // --- regression: short user msg + Cursor's giant system prompt should
  //     NOT route to Opus. Reproduces the "summarize the project" case
  //     that cost $0.30/call on the dashboard.
  { name: "regression: short ask, huge Cursor system prompt", expect: "agentic",
    req: { model: "gpt-4.1__shoutout",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [
        // System prompt that contains every reasoning-flavored phrase
        // we have in REASONING_RE — this is a reasonable approximation
        // of Cursor's stock prompt + agent skills + workspace metadata.
        { role: "system", content:
          "You are a coding agent. Document architectural decisions and design reviews. " +
          "Walk through complex refactors step by step. Watch out for race conditions, " +
          "thread safety, and other concurrency bugs. Be production-grade. ".repeat(200) },
        { role: "user", content: "summarize the project" },
      ] } },

  // --- conversational / cheap with tools ---
  { name: "status report with tools = cheap", expect: "cheap",
    req: { model: "gpt-4.1__shoutout",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [{ role: "user", content: "thanks, /kpi and /showkpi STILL only show 49 talent, but admin > shoutout fans shows 65 (correct)" }] } },
  { name: "thanks acknowledgment = cheap", expect: "cheap",
    req: { model: "gpt-4.1",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [{ role: "user", content: "thanks, looks good" }] } },
  { name: "it's working now = cheap", expect: "cheap",
    req: { model: "gpt-4.1",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [{ role: "user", content: "ok that's correct, it is working now" }] } },
  { name: "action request stays agentic", expect: "agentic",
    req: { model: "auto",
      tools: [{ type: "function", function: { name: "search", parameters: {} } }],
      messages: [{ role: "user", content: "find recent issues about auth" }] } },
  { name: "ack + action verb = agentic", expect: "agentic",
    req: { model: "gpt-4.1",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [{ role: "user", content: "ok, now fix the loading issue" }] } },
  { name: "thanks + check request = agentic", expect: "agentic",
    req: { model: "gpt-4.1",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [{ role: "user", content: "thanks, can you also check why it's slow?" }] } },

  // --- explicit reasoning requests (bypass token minimum) ---
  { name: "big project + max reasoning", expect: "reasoning",
    req: { model: "gpt-4.1__RevOs",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [{ role: "user", content:
        "this is a big project, with lots of complex pieces please use maximum reasoning: I need a basic clean interface, where super admin can create a Clinic account" }] } },
  { name: "use best model = reasoning", expect: "reasoning",
    req: { model: "gpt-4.1",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [{ role: "user", content: "use the best model for this, redesign the auth flow" }] } },
  { name: "needs deep thinking = reasoning", expect: "reasoning",
    req: { model: "auto",
      messages: [{ role: "user", content: "this needs deep careful reasoning — plan the entire multi-tenant schema" }] } },
  { name: "this is complex = reasoning", expect: "reasoning",
    req: { model: "gpt-4.1",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [{ role: "user", content: "this is a large complex project from scratch, build the full payment system" }] } },

  // --- MiMo context cap: huge agentic context -> Sonnet ---
  { name: "MiMo cap: huge context + tools = Sonnet", expect: "code",
    req: { model: "gpt-4.1__RevOs",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [
        { role: "user", content: "I want to use supabase for the DB" },
        // 8+ minutes of prior tool results = massive context
        { role: "assistant", content: "building schema... " + "lorem ipsum ".repeat(20000) },
        { role: "tool", content: "file output: " + "code line\n".repeat(15000), tool_call_id: "t1" },
        { role: "assistant", content: "continuing... " + "code ".repeat(15000) },
        { role: "tool", content: "result: " + "data ".repeat(15000), tool_call_id: "t2" },
        { role: "user", content: "I want to use supabase for the DB" },
      ] } },

  // --- $93 regression: Opus with huge growing context -> downgrade to Sonnet ---
  // Once the agent loop is deep (100K+ tokens), we're doing implementation
  // work. Downgrade from Opus to Sonnet even if the original message asked
  // for "maximum reasoning". The first planning turn is cheap; turns 10-40
  // doing file reads/writes should be Sonnet.
  { name: "regression: max reasoning but huge context = Sonnet", expect: "code",
    req: { model: "gpt-4.1__RevOs",
      tools: Array.from({ length: 19 }, (_, i) => ({ type: "function", function: { name: `tool_${i}`, parameters: {} } })),
      messages: [
        { role: "user", content:
          "this is a big project, with lots of complex pieces please use maximum reasoning" },
        // Simulate 40 turns of growing agent context (tool calls, file reads, etc.)
        { role: "assistant", content: "I'll build this step by step. " + "lorem ipsum ".repeat(6000) },
        { role: "tool", content: "file contents: " + "code ".repeat(6000), tool_call_id: "t1" },
        { role: "assistant", content: "continuing... " + "lorem ipsum ".repeat(6000) },
        { role: "tool", content: "more output: " + "code ".repeat(6000), tool_call_id: "t2" },
        { role: "assistant", content: "nearly done. " + "lorem ipsum ".repeat(3000) },
        { role: "user", content: "this is a big project, with lots of complex pieces please use maximum reasoning" },
      ] } },

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
