import type { Context, Hono } from "hono";
import { snapshot as breakerSnapshot } from "./breaker.js";
import {
  byModel,
  byProject,
  byWorkType,
  qualitySummary,
  recent,
  recentLowQuality,
  totals,
  type Period,
  type Range,
} from "./db.js";

/** Constant-time-ish string compare. */
function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/**
 * Dashboard auth: HTTP Basic with username `admin` and password set by
 * DASHBOARD_PASSWORD (or ROUTER_API_KEY as a fallback). Browsers prompt
 * natively, which keeps this dependency-free.
 */
function checkBasicAuth(c: Context): boolean {
  const expected =
    process.env.DASHBOARD_PASSWORD ?? process.env.ROUTER_API_KEY ?? "";
  if (!expected) return false;
  const header = c.req.header("authorization") ?? "";
  if (!header.toLowerCase().startsWith("basic ")) return false;
  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const password = decoded.slice(idx + 1);
  return eq(password, expected);
}

function parsePeriod(v: string | undefined): Period {
  if (v === "24h" || v === "7d" || v === "30d" || v === "all") return v;
  return "7d";
}

function parseEpoch(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Resolve the time range from query params. Custom `from`/`to` (epoch
 * seconds) override `period`. If only `from` is given, `to` defaults to
 * now; if only `to` is given, `from` defaults to 0 (all of history).
 */
function parseRange(c: Context): { range: Range; label: string } {
  const fromQ = parseEpoch(c.req.query("from"));
  const toQ = parseEpoch(c.req.query("to"));
  if (fromQ !== undefined || toQ !== undefined) {
    return {
      range: { from: fromQ, to: toQ },
      label: `custom:${fromQ ?? 0}-${toQ ?? "now"}`,
    };
  }
  const p = parsePeriod(c.req.query("period"));
  return { range: p, label: p };
}

export function mountDashboard(app: Hono): void {
  app.use("/dashboard", async (c, next) => {
    if (!checkBasicAuth(c)) {
      return new Response("Authentication required", {
        status: 401,
        headers: {
          "www-authenticate": 'Basic realm="router-dashboard", charset="UTF-8"',
        },
      });
    }
    await next();
  });

  app.use("/dashboard/*", async (c, next) => {
    if (!checkBasicAuth(c)) {
      return new Response("Authentication required", {
        status: 401,
        headers: {
          "www-authenticate": 'Basic realm="router-dashboard", charset="UTF-8"',
        },
      });
    }
    await next();
  });

  app.get("/dashboard/api/stats", (c) => {
    const { range, label } = parseRange(c);
    return c.json({
      period: label,
      totals: totals(range),
      by_model: byModel(range),
      by_project: byProject(range),
      by_work_type: byWorkType(range),
      breaker: breakerSnapshot(),
      quality: qualitySummary(range),
      low_quality: recentLowQuality(range, 6, 50),
      recent: recent(range, 100),
      generated_at: Math.floor(Date.now() / 1000),
    });
  });

  app.get("/dashboard", (c) =>
    c.html(DASHBOARD_HTML, 200, { "content-type": "text/html; charset=utf-8" }),
  );
}

/* ----------------------------- the page ----------------------------- */

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Router Dashboard</title>
<style>
  :root {
    --bg: #0b0c10;
    --panel: #14161c;
    --panel-2: #1b1e26;
    --border: #262a35;
    --text: #e6e9ef;
    --muted: #8a93a6;
    --accent: #7aa7ff;
    --good: #5fd28b;
    --warn: #f4c66a;
    --bad: #ef7878;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text);
    font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header {
    display: flex; align-items: center; gap: 16px;
    padding: 16px 24px; border-bottom: 1px solid var(--border);
    position: sticky; top: 0; background: var(--bg); z-index: 10;
  }
  header h1 { font-size: 16px; font-weight: 600; margin: 0; }
  header .spacer { flex: 1; }
  .seg {
    display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
  }
  .seg button {
    background: transparent; color: var(--muted); border: 0;
    padding: 6px 12px; font: inherit; cursor: pointer;
  }
  .seg button.active { background: var(--panel-2); color: var(--text); }
  .seg button + button { border-left: 1px solid var(--border); }
  .range-picker {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border: 1px solid var(--border); border-radius: 8px;
    color: var(--muted); font-size: 12px;
  }
  .range-picker input[type="date"] {
    background: transparent; border: 0; color: var(--text);
    font: inherit; padding: 2px 4px; outline: none;
    color-scheme: dark;
  }
  .range-picker input[type="date"]::-webkit-calendar-picker-indicator {
    filter: invert(1) opacity(0.5); cursor: pointer;
  }
  .range-picker button.apply {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 3px 8px; font: inherit; cursor: pointer; font-size: 11px;
  }
  .range-picker button.apply:hover { background: var(--border); }
  .range-picker button.clear {
    background: transparent; border: 0; color: var(--muted);
    cursor: pointer; padding: 2px 4px; font-size: 14px; line-height: 1;
  }
  .range-picker.active { color: var(--text); border-color: var(--accent); }
  main { padding: 24px; max-width: 1200px; margin: 0 auto; }
  .grid { display: grid; gap: 16px; }
  .grid-4 { grid-template-columns: repeat(4, 1fr); }
  .grid-2 { grid-template-columns: repeat(2, 1fr); }
  @media (max-width: 900px) {
    .grid-4 { grid-template-columns: repeat(2, 1fr); }
    .grid-2 { grid-template-columns: 1fr; }
  }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px;
  }
  .stat .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat .value { font-size: 24px; font-weight: 600; margin-top: 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
       margin: 0 0 12px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase;
       letter-spacing: 0.04em; }
  tbody tr:hover { background: var(--panel-2); }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .pill {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    font-size: 11px; border: 1px solid var(--border); color: var(--muted);
  }
  .pill.bug_fix { color: var(--bad); border-color: #4d2a2a; background: #2a1818; }
  .pill.rework { color: var(--warn); border-color: #4d3f1c; background: #2a2418; }
  .pill.new_feature { color: var(--good); border-color: #1c4d2c; background: #18261d; }
  .pill.other { color: var(--muted); }
  .score { display: inline-block; padding: 1px 6px; border-radius: 4px;
           font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .score.lo  { color: var(--bad);  background: #2a1818; border: 1px solid #4d2a2a; }
  .score.mid { color: var(--warn); background: #2a2418; border: 1px solid #4d3f1c; }
  .score.hi  { color: var(--good); background: #18261d; border: 1px solid #1c4d2c; }
  tr.qrow td {
    background: #14201a; border-top: 0; padding: 6px 10px 12px;
    white-space: pre-wrap; word-break: break-word; font-size: 11px; line-height: 1.45;
    color: var(--muted);
  }
  tr.qrow .reasons { color: var(--text); }
  tr.qrow .flag { color: var(--warn); margin-left: 8px; }
  .muted { color: var(--muted); }
  .row { display: flex; align-items: center; gap: 8px; }
  .err { color: var(--bad); }
  tr.errrow td {
    background: #1a1112; border-top: 0; padding: 6px 10px 12px;
    white-space: pre-wrap; word-break: break-word; font-size: 11px; line-height: 1.45;
  }
  section + section { margin-top: 24px; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .empty { color: var(--muted); padding: 24px; text-align: center; }
</style>
</head>
<body>
<header>
  <h1>router</h1>
  <span class="muted mono" id="updated"></span>
  <div class="spacer"></div>
  <div class="seg" id="period-seg">
    <button data-p="today">today</button>
    <button data-p="24h">24h</button>
    <button data-p="7d" class="active">7d</button>
    <button data-p="30d">30d</button>
    <button data-p="all">all</button>
  </div>
  <div class="range-picker" id="range-picker">
    <input type="date" id="range-from" aria-label="from">
    <span>→</span>
    <input type="date" id="range-to" aria-label="to">
    <button class="apply" id="range-apply">apply</button>
    <button class="clear" id="range-clear" title="clear custom range" style="display:none">×</button>
  </div>
</header>
<main>
  <section class="grid grid-4" id="stats"></section>
  <section class="grid grid-2">
    <div class="card"><h2>By model</h2><div id="by_model"></div></div>
    <div class="card"><h2>By project</h2><div id="by_project"></div></div>
  </section>
  <section class="grid grid-2">
    <div class="card"><h2>By work type</h2><div id="by_work_type"></div></div>
    <div class="card"><h2></h2><div class="muted" style="font-size:12px">
      Project is detected from the <code>Workspace Path:</code> line that
      Cursor puts in its system prompt. Override with the
      <code>X-Router-Project</code> header. Work type is heuristic on the last
      user message; override with <code>X-Router-Work-Type</code>.
    </div></div>
  </section>
  <section class="card" id="quality_card" style="display:none">
    <h2>Quality (sampled MiMo / DeepSeek calls)</h2>
    <div id="quality_summary"></div>
  </section>
  <section class="card" id="low_quality_card" style="display:none">
    <h2>Low-quality calls (score &lt; 6)</h2>
    <div id="low_quality"></div>
  </section>
  <section class="card" id="breaker_card" style="display:none">
    <h2>Circuit breaker</h2>
    <div id="breaker"></div>
  </section>
  <section class="card">
    <h2>Recent calls</h2>
    <div id="recent"></div>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let period = "7d";
  // When set, a custom date range overrides the period preset. Either
  // bound may be null (open-ended). Stored as YYYY-MM-DD strings to
  // match the date-input values.
  let customRange = null;

  function dateToEpoch(s, endOfDay) {
    if (!s) return null;
    const [y, m, d] = s.split("-").map(Number);
    if (!y || !m || !d) return null;
    const dt = new Date(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
    return Math.floor(dt.getTime() / 1000);
  }

  function statsUrl() {
    if (customRange && (customRange.from || customRange.to)) {
      const params = new URLSearchParams();
      const from = dateToEpoch(customRange.from, false);
      const to = dateToEpoch(customRange.to, true);
      if (from != null) params.set("from", String(from));
      if (to != null) params.set("to", String(to));
      return "/dashboard/api/stats?" + params.toString();
    }
    return "/dashboard/api/stats?period=" + period;
  }

  function fmtMoney(n) {
    if (!n) return "$0";
    if (n < 0.01) return "$" + n.toFixed(4);
    if (n < 1) return "$" + n.toFixed(3);
    return "$" + n.toFixed(2);
  }
  function fmtInt(n) { return (n || 0).toLocaleString(); }
  function fmtTime(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleString();
  }
  function fmtDur(ms) {
    if (ms == null) return "-";
    if (ms < 1000) return ms + "ms";
    return (ms / 1000).toFixed(2) + "s";
  }

  function statCard(label, value) {
    return \`<div class="card stat"><div class="label">\${label}</div><div class="value">\${value}</div></div>\`;
  }

  function breakdownTable(rows, keyLabel) {
    if (!rows.length) return '<div class="empty">no data yet</div>';
    const head = \`<thead><tr>
      <th>\${keyLabel}</th>
      <th class="num">Calls</th>
      <th class="num">In tok</th>
      <th class="num">Out tok</th>
      <th class="num">Cost</th>
    </tr></thead>\`;
    const body = rows.map(r => \`<tr>
      <td class="mono">\${r.key}</td>
      <td class="num">\${fmtInt(r.calls)}</td>
      <td class="num">\${fmtInt(r.prompt_tokens)}</td>
      <td class="num">\${fmtInt(r.completion_tokens)}</td>
      <td class="num">\${fmtMoney(r.cost_usd)}</td>
    </tr>\`).join("");
    return \`<table>\${head}<tbody>\${body}</tbody></table>\`;
  }

  function workTypeTable(rows) {
    if (!rows.length) return '<div class="empty">no data yet</div>';
    const body = rows.map(r => \`<tr>
      <td><span class="pill \${r.key}">\${r.key}</span></td>
      <td class="num">\${fmtInt(r.calls)}</td>
      <td class="num">\${fmtInt(r.total_tokens)}</td>
      <td class="num">\${fmtMoney(r.cost_usd)}</td>
    </tr>\`).join("");
    return \`<table><thead><tr><th>Type</th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>\${body}</tbody></table>\`;
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function scoreBadge(score) {
    if (score == null) return '<span class="muted">—</span>';
    const cls = score < 6 ? 'lo' : score < 8 ? 'mid' : 'hi';
    return \`<span class="score \${cls}">\${score}</span>\`;
  }

  function recentTable(rows) {
    if (!rows.length) return '<div class="empty">no data yet</div>';
    const body = rows.map(r => {
      const main = \`<tr>
        <td class="mono muted">\${fmtTime(r.ts)}</td>
        <td>\${r.project ? '<code>' + r.project + '</code>' : '<span class="muted">—</span>'}</td>
        <td><span class="pill \${r.work_type}">\${r.work_type}</span></td>
        <td class="mono">\${escapeHtml(r.routed_model)}</td>
        <td class="num">\${fmtInt(r.prompt_tokens)}</td>
        <td class="num">\${fmtInt(r.completion_tokens)}</td>
        <td class="num">\${fmtMoney(r.cost_usd)}</td>
        <td class="num muted">\${fmtDur(r.duration_ms)}</td>
        <td class="num \${r.status >= 400 ? 'err' : 'muted'}">\${r.status}</td>
        <td class="num">\${scoreBadge(r.quality_score)}</td>
      </tr>\`;
      const extras = [];
      if (r.error) {
        extras.push(\`<tr class="errrow"><td colspan="10" class="mono err">\${escapeHtml(r.error)}</td></tr>\`);
      }
      if (r.quality_reasons) {
        const flag = r.quality_better_with_sonnet
          ? '<span class="flag">⚑ would be better on Sonnet</span>'
          : '';
        extras.push(\`<tr class="qrow"><td colspan="10">judge: <span class="reasons">\${escapeHtml(r.quality_reasons)}</span>\${flag}</td></tr>\`);
      }
      return main + extras.join("");
    }).join("");
    return \`<table><thead><tr>
      <th>Time</th><th>Project</th><th>Type</th><th>Model</th>
      <th class="num">In</th><th class="num">Out</th><th class="num">Cost</th>
      <th class="num">Dur</th><th class="num">Status</th><th class="num">Score</th>
    </tr></thead><tbody>\${body}</tbody></table>\`;
  }

  function lowQualityTable(rows) {
    if (!rows.length) return '<div class="empty">nothing flagged in this period</div>';
    const body = rows.map(r => \`<tr>
      <td class="num">\${scoreBadge(r.quality_score)}</td>
      <td class="mono muted">\${fmtTime(r.ts)}</td>
      <td>\${r.project ? '<code>' + r.project + '</code>' : '<span class="muted">—</span>'}</td>
      <td class="mono">\${escapeHtml(r.routed_model)}</td>
      <td class="reasons">\${escapeHtml(r.quality_reasons || '')}</td>
      <td class="num \${r.quality_better_with_sonnet ? 'err' : 'muted'}">\${r.quality_better_with_sonnet ? 'yes' : '—'}</td>
    </tr>\`).join("");
    return \`<table><thead><tr>
      <th class="num">Score</th><th>Time</th><th>Project</th><th>Model</th>
      <th>Judge reasoning</th><th class="num">Sonnet?</th>
    </tr></thead><tbody>\${body}</tbody></table>\`;
  }

  async function load() {
    const res = await fetch(statsUrl(), { credentials: "include" });
    if (!res.ok) {
      document.body.innerHTML = "<p style='padding:24px'>Failed to load stats: " + res.status + "</p>";
      return;
    }
    const data = await res.json();
    const t = data.totals;
    $("stats").innerHTML = [
      statCard("Calls", fmtInt(t.calls)),
      statCard("Total tokens", fmtInt(t.total_tokens)),
      statCard("Cost", fmtMoney(t.cost_usd)),
      statCard("In / Out", fmtInt(t.prompt_tokens) + " / " + fmtInt(t.completion_tokens)),
    ].join("");
    $("by_model").innerHTML       = breakdownTable(data.by_model, "Model");
    $("by_project").innerHTML     = breakdownTable(data.by_project, "Project");
    $("by_work_type").innerHTML   = workTypeTable(data.by_work_type);
    $("recent").innerHTML         = recentTable(data.recent);
    $("updated").textContent      = "updated " + new Date(data.generated_at * 1000).toLocaleTimeString();

    const q = data.quality || { judged_calls: 0 };
    if (q.judged_calls > 0) {
      $("quality_card").style.display = "";
      const avg = q.avg_score == null ? '—' : q.avg_score.toFixed(2);
      const flagged = q.flagged_for_sonnet || 0;
      $("quality_summary").innerHTML = \`<div class="row" style="gap:32px">
        <div><div class="label muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Judged calls</div>
             <div style="font-size:20px;font-weight:600;margin-top:2px">\${fmtInt(q.judged_calls)}</div></div>
        <div><div class="label muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Avg score</div>
             <div style="font-size:20px;font-weight:600;margin-top:2px">\${avg}</div></div>
        <div><div class="label muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em">Flagged for Sonnet</div>
             <div style="font-size:20px;font-weight:600;margin-top:2px">\${fmtInt(flagged)}</div></div>
      </div>\`;
    } else {
      $("quality_card").style.display = "none";
    }

    const lq = data.low_quality || [];
    if (lq.length > 0) {
      $("low_quality_card").style.display = "";
      $("low_quality").innerHTML = lowQualityTable(lq);
    } else {
      $("low_quality_card").style.display = "none";
    }

    const breaker = (data.breaker || []).filter(b => b.consecutiveFails > 0 || b.openMsRemaining > 0);
    if (breaker.length) {
      $("breaker_card").style.display = "";
      $("breaker").innerHTML = \`<table><thead><tr>
        <th>Model</th><th class="num">Recent fails</th><th class="num">Open for</th><th>State</th>
      </tr></thead><tbody>\${breaker.map(b => \`<tr>
        <td class="mono">\${escapeHtml(b.model)}</td>
        <td class="num">\${fmtInt(b.consecutiveFails)}</td>
        <td class="num \${b.openMsRemaining > 0 ? 'err' : 'muted'}">\${b.openMsRemaining > 0 ? fmtDur(b.openMsRemaining) : '-'}</td>
        <td class="\${b.openMsRemaining > 0 ? 'err' : 'muted'}">\${b.openMsRemaining > 0 ? 'OPEN — skipping to fallback' : 'cooling'}</td>
      </tr>\`).join("")}</tbody></table>\`;
    } else {
      $("breaker_card").style.display = "none";
    }
  }

  // "today" is implemented client-side as midnight-to-now in the user's
  // local timezone, so it respects DST and locale. The other presets
  // (24h, 7d, 30d, all) are server-side rolling windows.
  function applyPreset(preset) {
    document.querySelectorAll("#period-seg button").forEach(x => x.classList.remove("active"));
    document.querySelectorAll("#period-seg button").forEach(x => {
      if (x.dataset.p === preset) x.classList.add("active");
    });
    if (preset === "today") {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      // Use a custom range under the hood so we hit the from/to query params.
      period = "today";
      customRange = {
        from: start.toISOString().slice(0, 10),
        to: now.toISOString().slice(0, 10),
      };
      $("range-from").value = customRange.from;
      $("range-to").value = customRange.to;
      $("range-picker").classList.remove("active"); // visually still belongs to preset
      $("range-clear").style.display = "none";
    } else {
      period = preset;
      customRange = null;
      $("range-from").value = "";
      $("range-to").value = "";
      $("range-picker").classList.remove("active");
      $("range-clear").style.display = "none";
    }
    load();
  }

  document.querySelectorAll("#period-seg button").forEach(b => {
    b.addEventListener("click", () => applyPreset(b.dataset.p));
  });

  function applyCustomRange() {
    const from = $("range-from").value || null;
    const to = $("range-to").value || null;
    if (!from && !to) {
      customRange = null;
      $("range-picker").classList.remove("active");
      $("range-clear").style.display = "none";
    } else {
      customRange = { from, to };
      $("range-picker").classList.add("active");
      $("range-clear").style.display = "";
      // Deselect period buttons since custom range overrides them.
      document.querySelectorAll("#period-seg button").forEach(x => x.classList.remove("active"));
    }
    load();
  }

  $("range-apply").addEventListener("click", applyCustomRange);
  $("range-from").addEventListener("change", () => { /* don't auto-apply, wait for Apply click */ });
  $("range-to").addEventListener("change", () => { /* same */ });
  // Allow Enter in either date input to apply.
  ["range-from", "range-to"].forEach(id => {
    $(id).addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") applyCustomRange();
    });
  });
  $("range-clear").addEventListener("click", () => {
    // Clearing a custom range falls back to 7d (the default preset).
    applyPreset("7d");
  });

  load();
  // Slow down auto-refresh while a custom range is active — the range is
  // user-chosen, no need to refresh as aggressively.
  setInterval(() => { if (!document.hidden) load(); }, 15_000);
</script>
</body>
</html>`;
