import { route } from "../src/router.js";

const cases: Array<{ name: string; req: Parameters<typeof route>[0] }> = [
  {
    name: "short casual question",
    req: {
      model: "auto",
      messages: [{ role: "user", content: "what's the capital of france?" }],
    },
  },
  {
    name: "short business copy",
    req: {
      model: "auto",
      messages: [
        { role: "user", content: "write a 3-bullet summary of why we should adopt PRs" },
      ],
    },
  },
  {
    name: "code edit with file path + fence",
    req: {
      model: "auto",
      messages: [
        {
          role: "user",
          content:
            "fix the bug in src/foo.ts:\n```ts\nfunction add(a: number, b: number) { return a - b }\n```",
        },
      ],
    },
  },
  {
    name: "tool-calling request",
    req: {
      model: "auto",
      tools: [{ type: "function", function: { name: "search", parameters: {} } }],
      messages: [{ role: "user", content: "find recent issues about auth" }],
    },
  },
  {
    name: "long-context doc",
    req: {
      model: "auto",
      messages: [
        { role: "user", content: "summarize this:\n" + "lorem ipsum ".repeat(20000) },
      ],
    },
  },
  {
    name: "architecture review (substantial)",
    req: {
      model: "auto",
      messages: [
        {
          role: "user",
          content:
            "I'm doing a complex refactor of our distributed system architecture. " +
            "I need you to deeply analyze the trade-offs between event sourcing and " +
            "CRUD for our billing service. " +
            "Here's the context: ".padEnd(8000, "x"),
        },
      ],
    },
  },
  {
    name: "explicit alias: code",
    req: { model: "code", messages: [{ role: "user", content: "hi" }] },
  },
  {
    name: "passthrough model id",
    req: {
      model: "anthropic/claude-opus-4.7",
      messages: [{ role: "user", content: "hi" }],
    },
  },
];

for (const c of cases) {
  const d = route(c.req);
  console.log(
    `${c.name.padEnd(34)} -> ${d.tier.padEnd(9)} (${d.model})  [${d.reason}]`,
  );
}
