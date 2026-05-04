import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Tiny SQLite-backed call log.
 *
 * On Railway, point DATABASE_PATH at a mounted volume (e.g. /data/router.db)
 * so the log survives redeploys. Locally it just defaults to ./router.db.
 */

const DB_PATH = process.env.DATABASE_PATH ?? "router.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                INTEGER NOT NULL,
    requested_model   TEXT,
    routed_model      TEXT NOT NULL,
    tier              TEXT NOT NULL,
    project           TEXT,
    work_type         TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens      INTEGER NOT NULL DEFAULT 0,
    cost_usd          REAL    NOT NULL DEFAULT 0,
    duration_ms       INTEGER NOT NULL DEFAULT 0,
    status            INTEGER NOT NULL DEFAULT 200,
    stream            INTEGER NOT NULL DEFAULT 0,
    error             TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_calls_ts        ON calls(ts);
  CREATE INDEX IF NOT EXISTS idx_calls_model     ON calls(routed_model);
  CREATE INDEX IF NOT EXISTS idx_calls_project   ON calls(project);
  CREATE INDEX IF NOT EXISTS idx_calls_work_type ON calls(work_type);
`);

export interface CallRecord {
  ts: number;
  requested_model: string | null;
  routed_model: string;
  tier: string;
  project: string | null;
  work_type: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  duration_ms: number;
  status: number;
  stream: boolean;
  error: string | null;
}

const insertStmt = db.prepare(`
  INSERT INTO calls (
    ts, requested_model, routed_model, tier, project, work_type,
    prompt_tokens, completion_tokens, total_tokens, cost_usd,
    duration_ms, status, stream, error
  ) VALUES (
    @ts, @requested_model, @routed_model, @tier, @project, @work_type,
    @prompt_tokens, @completion_tokens, @total_tokens, @cost_usd,
    @duration_ms, @status, @stream_int, @error
  )
`);

export function recordCall(r: CallRecord): void {
  insertStmt.run({ ...r, stream_int: r.stream ? 1 : 0 });
}

/* ---------- queries used by the dashboard ---------- */

export type Period = "24h" | "7d" | "30d" | "all";

function sinceFor(period: Period): number {
  const now = Math.floor(Date.now() / 1000);
  switch (period) {
    case "24h":
      return now - 24 * 3600;
    case "7d":
      return now - 7 * 24 * 3600;
    case "30d":
      return now - 30 * 24 * 3600;
    case "all":
      return 0;
  }
}

export interface Totals {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

export interface Breakdown extends Totals {
  key: string;
}

export function totals(period: Period): Totals {
  const since = sinceFor(period);
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                 AS calls,
         COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)      AS total_tokens,
         COALESCE(SUM(cost_usd), 0)          AS cost_usd
       FROM calls WHERE ts >= ?`,
    )
    .get(since) as Totals;
  return row;
}

function breakdownBy(column: string, period: Period): Breakdown[] {
  const since = sinceFor(period);
  const rows = db
    .prepare(
      `SELECT
         COALESCE(${column}, '(unknown)')    AS key,
         COUNT(*)                            AS calls,
         COALESCE(SUM(prompt_tokens), 0)     AS prompt_tokens,
         COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
         COALESCE(SUM(total_tokens), 0)      AS total_tokens,
         COALESCE(SUM(cost_usd), 0)          AS cost_usd
       FROM calls
       WHERE ts >= ?
       GROUP BY key
       ORDER BY cost_usd DESC, calls DESC`,
    )
    .all(since) as Breakdown[];
  return rows;
}

export function byModel(period: Period) {
  return breakdownBy("routed_model", period);
}
export function byProject(period: Period) {
  return breakdownBy("project", period);
}
export function byWorkType(period: Period) {
  return breakdownBy("work_type", period);
}

export interface RecentCall {
  id: number;
  ts: number;
  requested_model: string | null;
  routed_model: string;
  tier: string;
  project: string | null;
  work_type: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  duration_ms: number;
  status: number;
  stream: number;
  error: string | null;
}

export function recent(period: Period, limit = 100): RecentCall[] {
  const since = sinceFor(period);
  return db
    .prepare(
      `SELECT * FROM calls WHERE ts >= ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(since, limit) as RecentCall[];
}
