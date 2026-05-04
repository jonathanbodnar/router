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

/**
 * Quality-judge columns added in a later migration. We use IF NOT EXISTS-style
 * ALTER TABLE so existing deployments pick them up on next start without
 * dropping data. SQLite lacks `ADD COLUMN IF NOT EXISTS`, so we introspect.
 */
{
  const existing = new Set<string>(
    (db
      .prepare(`PRAGMA table_info(calls)`)
      .all() as Array<{ name: string }>).map((r) => r.name),
  );
  const addColumn = (name: string, decl: string) => {
    if (!existing.has(name)) db.exec(`ALTER TABLE calls ADD COLUMN ${decl}`);
  };
  addColumn("quality_score", "quality_score INTEGER");
  addColumn("quality_reasons", "quality_reasons TEXT");
  addColumn("quality_better_with_sonnet", "quality_better_with_sonnet INTEGER");
  addColumn("quality_judge_model", "quality_judge_model TEXT");
  addColumn("quality_judge_cost_usd", "quality_judge_cost_usd REAL");
  addColumn("quality_judged_at", "quality_judged_at INTEGER");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_quality_score ON calls(quality_score)`);
}

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

export function recordCall(r: CallRecord): number {
  const info = insertStmt.run({ ...r, stream_int: r.stream ? 1 : 0 });
  return Number(info.lastInsertRowid);
}

/* ---------- judge-pass quality updates ---------- */

export interface QualityUpdate {
  call_id: number;
  score: number;
  reasons: string;
  better_with_sonnet: boolean;
  judge_model: string;
  judge_cost_usd: number;
}

const updateQualityStmt = db.prepare(`
  UPDATE calls SET
    quality_score              = @score,
    quality_reasons            = @reasons,
    quality_better_with_sonnet = @better_int,
    quality_judge_model        = @judge_model,
    quality_judge_cost_usd     = @judge_cost_usd,
    quality_judged_at          = @judged_at,
    cost_usd                   = cost_usd + @judge_cost_usd
  WHERE id = @call_id
`);

export function updateQuality(u: QualityUpdate): void {
  updateQualityStmt.run({
    ...u,
    better_int: u.better_with_sonnet ? 1 : 0,
    judged_at: Math.floor(Date.now() / 1000),
  });
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
  quality_score: number | null;
  quality_reasons: string | null;
  quality_better_with_sonnet: number | null;
  quality_judge_model: string | null;
  quality_judge_cost_usd: number | null;
  quality_judged_at: number | null;
}

export function recent(period: Period, limit = 100): RecentCall[] {
  const since = sinceFor(period);
  return db
    .prepare(
      `SELECT * FROM calls WHERE ts >= ? ORDER BY ts DESC LIMIT ?`,
    )
    .all(since, limit) as RecentCall[];
}

/**
 * Rows where the judge gave a low quality score. Used to surface the
 * "MiMo dropped quality here" cases in the dashboard so we can decide
 * whether to upgrade the heuristic or add a keyword pattern.
 */
export function recentLowQuality(
  period: Period,
  threshold = 6,
  limit = 50,
): RecentCall[] {
  const since = sinceFor(period);
  return db
    .prepare(
      `SELECT * FROM calls
       WHERE ts >= ?
         AND quality_score IS NOT NULL
         AND quality_score < ?
       ORDER BY quality_score ASC, ts DESC
       LIMIT ?`,
    )
    .all(since, threshold, limit) as RecentCall[];
}

export interface QualitySummary {
  judged_calls: number;
  avg_score: number | null;
  flagged_for_sonnet: number;
}

export function qualitySummary(period: Period): QualitySummary {
  const since = sinceFor(period);
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS judged_calls,
         AVG(quality_score) AS avg_score,
         SUM(quality_better_with_sonnet) AS flagged_for_sonnet
       FROM calls
       WHERE ts >= ? AND quality_score IS NOT NULL`,
    )
    .get(since) as {
    judged_calls: number;
    avg_score: number | null;
    flagged_for_sonnet: number | null;
  };
  return {
    judged_calls: row.judged_calls ?? 0,
    avg_score: row.avg_score,
    flagged_for_sonnet: row.flagged_for_sonnet ?? 0,
  };
}
