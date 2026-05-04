/**
 * Tiny in-process circuit breaker for upstream models.
 *
 * Every chat-completions call reports its outcome via `record(model, ok)`.
 * If a model has had >= FAIL_THRESHOLD consecutive failures, `isOpen(model)`
 * returns true for COOLDOWN_MS, telling the router to skip the primary
 * model entirely and route to the Sonnet fallback right away. This stops
 * us from paying a slow round-trip every request when an upstream model is
 * having a bad afternoon, and keeps Cursor's BYOK proxy from tripping its
 * own rate-limiter on a flood of 5xx responses.
 *
 * A single success closes the breaker. Implementation is per-process; on
 * Railway with a single instance that's exactly what we want.
 */

const FAIL_THRESHOLD = Number(process.env.ROUTER_BREAKER_FAILS ?? 3);
const COOLDOWN_MS = Number(process.env.ROUTER_BREAKER_COOLDOWN_MS ?? 60_000);

interface BreakerState {
  consecutiveFails: number;
  /** Wall-clock ms when the breaker last tripped. 0 if currently closed. */
  trippedAt: number;
}

const state = new Map<string, BreakerState>();

function get(model: string): BreakerState {
  let s = state.get(model);
  if (!s) {
    s = { consecutiveFails: 0, trippedAt: 0 };
    state.set(model, s);
  }
  return s;
}

/** True when the breaker is currently open and we should skip this model. */
export function isOpen(model: string, now = Date.now()): boolean {
  const s = state.get(model);
  if (!s || s.trippedAt === 0) return false;
  if (now - s.trippedAt > COOLDOWN_MS) {
    // Cooldown expired — half-open: allow a probe through, but reset the
    // counter so a single failure doesn't immediately re-trip.
    s.trippedAt = 0;
    s.consecutiveFails = 0;
    return false;
  }
  return true;
}

/** Record the outcome of a call to `model`. */
export function record(model: string, ok: boolean, now = Date.now()): void {
  const s = get(model);
  if (ok) {
    s.consecutiveFails = 0;
    s.trippedAt = 0;
    return;
  }
  s.consecutiveFails += 1;
  if (s.consecutiveFails >= FAIL_THRESHOLD) {
    s.trippedAt = now;
  }
}

/** For testing / dashboard exposure. */
export function snapshot(): Array<{ model: string; consecutiveFails: number; openMsRemaining: number }> {
  const now = Date.now();
  const out: Array<{ model: string; consecutiveFails: number; openMsRemaining: number }> = [];
  for (const [model, s] of state.entries()) {
    out.push({
      model,
      consecutiveFails: s.consecutiveFails,
      openMsRemaining: s.trippedAt === 0 ? 0 : Math.max(0, COOLDOWN_MS - (now - s.trippedAt)),
    });
  }
  return out;
}

/** Test-only reset. */
export function _resetBreaker(): void {
  state.clear();
}

export const _config = { FAIL_THRESHOLD, COOLDOWN_MS };
