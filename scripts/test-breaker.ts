/**
 * Unit tests for the in-process circuit breaker.
 */
import { _config, _resetBreaker, isOpen, record, snapshot } from "../src/breaker.js";

let failed = 0;
const expect = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

_resetBreaker();

const M = "anthropic/claude-opus-4.7";
const T = _config.FAIL_THRESHOLD;

expect("starts closed", isOpen(M) === false);

for (let i = 0; i < T - 1; i++) record(M, false);
expect(`closed below threshold (after ${T - 1} fails)`, isOpen(M) === false);

record(M, false);
expect(`open at threshold (${T} consecutive fails)`, isOpen(M) === true);

const snap = snapshot().find((s) => s.model === M);
expect("snapshot reports open ms remaining", (snap?.openMsRemaining ?? 0) > 0, `snap=${JSON.stringify(snap)}`);

// One success closes it.
record(M, true);
expect("success closes the breaker", isOpen(M) === false);

// Cooldown expiry path.
_resetBreaker();
const now = Date.now();
for (let i = 0; i < T; i++) record(M, false, now);
expect("open just after tripping", isOpen(M, now + 1) === true);
expect("closed after cooldown expires", isOpen(M, now + _config.COOLDOWN_MS + 1) === false);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall breaker tests passed");
