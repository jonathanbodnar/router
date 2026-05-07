/**
 * Tests for detectWorkType — the dashboard work-type tag classifier.
 *
 * Covers the false-positive cases that motivated the rewrite:
 *   - "add a comment" must NOT be tagged new_feature (was, before)
 *   - "fix the typo" must NOT be tagged bug_fix (was, before)
 *   - Cursor's <timestamp>...</timestamp><user_query>...</user_query>
 *     wrapper must be stripped before regex testing
 *   - Only the LATEST user message is examined — earlier turns from a
 *     long agent loop don't pollute the signal
 */
import { detectWorkType, resolveWorkType } from "../src/classify.js";

let failed = 0;
const expect = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const wrap = (s: string) =>
  `<timestamp>Tuesday, May 5, 2026, 3:16 PM (UTC-5)</timestamp>\n<user_query>\n${s}\n</user_query>`;

const u = (text: string) => ({
  messages: [{ role: "user", content: text }],
});

console.log("\n=== detectWorkType: bug_fix (true positives) ===\n");

expect("explicit bug",        detectWorkType(u("there's a bug in the login flow")) === "bug_fix");
expect("X is broken",         detectWorkType(u("the dashboard is broken on mobile")) === "bug_fix");
expect("doesn't work",        detectWorkType(u("the save button doesn't work after upgrade")) === "bug_fix");
expect("throws an error",     detectWorkType(u("it throws a TypeError when args is null")) === "bug_fix");
expect("stack trace",         detectWorkType(u("here's the stack trace, please debug")) === "bug_fix");
expect("regression",          detectWorkType(u("looks like a regression after the rebase")) === "bug_fix");
expect("failing tests",       detectWorkType(u("two unit tests are failing in CI")) === "bug_fix");
expect("fix the bug",         detectWorkType(u("fix the bug where the modal won't close")) === "bug_fix");
expect("not loading",         detectWorkType(u("the page is not loading anymore")) === "bug_fix");
expect("hotfix",              detectWorkType(u("we need a hotfix before the demo")) === "bug_fix");

console.log("\n=== detectWorkType: bug_fix false-positive guards ===\n");

expect("'fix the typo' is NOT bug_fix",       detectWorkType(u("fix the typo on line 12")) === "other");
expect("'fix the comment' is NOT bug_fix",    detectWorkType(u("fix the comment in foo.ts")) === "other");
expect("'fix formatting' is NOT bug_fix",     detectWorkType(u("fix formatting in this file")) === "other");
expect("'fix the import' is NOT bug_fix",     detectWorkType(u("fix the import order")) === "other");
expect("plain 'fix' alone -> other",          detectWorkType(u("fix this please")) === "other");

console.log("\n=== detectWorkType: rework ===\n");

expect("refactor",            detectWorkType(u("refactor the auth middleware")) === "rework");
expect("rewrite the module",  detectWorkType(u("rewrite the billing module in TypeScript")) === "rework");
expect("clean up the code",   detectWorkType(u("clean up the code in src/utils.ts")) === "rework");
expect("migrate to X",        detectWorkType(u("migrate from sequelize to drizzle")) === "rework");
expect("simplify the API",    detectWorkType(u("simplify the public api")) === "rework");
expect("extract a function",  detectWorkType(u("extract a function for the date math")) === "rework");
expect("rename file -> ...",  detectWorkType(u("rename utils.ts to helpers.ts")) === "rework");
expect("split the file",      detectWorkType(u("split this file into separate modules")) === "rework");

console.log("\n=== detectWorkType: rework guards ===\n");

expect(
  "'rename a variable' -> other (trivial)",
  detectWorkType(u("rename the variable foo to bar")) === "other",
);

console.log("\n=== detectWorkType: new_feature ===\n");

expect("build a feature",        detectWorkType(u("build a new dashboard for billing")) === "new_feature");
expect("create an endpoint",     detectWorkType(u("create an endpoint to list invoices")) === "new_feature");
expect("implement a hook",       detectWorkType(u("implement a hook to fetch user data")) === "new_feature");
expect("add a webhook",          detectWorkType(u("add a webhook handler for stripe events")) === "new_feature");
expect("scaffold a CLI",         detectWorkType(u("scaffold a small CLI for the dev workflow")) === "new_feature");
expect("from scratch",           detectWorkType(u("let's build this from scratch")) === "new_feature");
expect("MVP",                    detectWorkType(u("we need an MVP for the demo")) === "new_feature");
expect("a new component",        detectWorkType(u("a new component for the settings page")) === "new_feature");

console.log("\n=== detectWorkType: new_feature false-positive guards ===\n");

expect(
  "'add a comment' is NOT new_feature (was, before)",
  detectWorkType(u("add a comment explaining what this does")) === "other",
);
expect(
  "'add an import' is NOT new_feature",
  detectWorkType(u("add an import for lodash")) === "other",
);
expect(
  "'create a const' is NOT new_feature",
  detectWorkType(u("create a constant for this magic number")) === "other",
);
expect(
  "'add a TODO' is NOT new_feature",
  detectWorkType(u("add a TODO marker here")) === "other",
);

console.log("\n=== detectWorkType: Cursor wrapper handling ===\n");

expect(
  "wrapped bug message detected",
  detectWorkType(u(wrap("the page is broken after the migration"))) === "bug_fix",
);
expect(
  "wrapped feature message detected",
  detectWorkType(u(wrap("build a new endpoint for retries"))) === "new_feature",
);
expect(
  "wrapped trivial message stays 'other'",
  detectWorkType(u(wrap("add a comment to this function"))) === "other",
);

console.log("\n=== detectWorkType: ignores earlier turns (latest only) ===\n");

{
  const req = {
    messages: [
      { role: "user", content: "build a new dashboard" },
      { role: "assistant", content: "Done." },
      { role: "user", content: "thanks!" }, // latest = trivial chitchat
    ],
  };
  expect(
    "earlier 'build a new ...' doesn't bleed into the latest turn",
    detectWorkType(req) === "other",
    `got ${detectWorkType(req)}`,
  );
}

{
  const req = {
    messages: [
      { role: "user", content: "fix the bug in the loader" }, // latest = bug
      { role: "assistant", content: "fixed" },
      { role: "user", content: "now also add a comment" },
    ],
  };
  expect(
    "stale 'fix the bug' from earlier turn doesn't override 'add a comment'",
    detectWorkType(req) === "other",
  );
}

console.log("\n=== resolveWorkType: header overrides win ===\n");

expect(
  "X-Router-Work-Type: feature -> new_feature",
  resolveWorkType("feature", u("fix the bug")) === "new_feature",
);
expect(
  "X-Router-Work-Type: bug -> bug_fix",
  resolveWorkType("bug", u("build a new dashboard")) === "bug_fix",
);
expect(
  "X-Router-Work-Type: refactor -> rework",
  resolveWorkType("refactor", u("add a feature")) === "rework",
);
expect(
  "X-Router-Work-Type: <empty> -> falls through to detection",
  resolveWorkType(undefined, u("the page is broken")) === "bug_fix",
);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall work-type tests passed");
