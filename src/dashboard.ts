import type { Context, Hono } from "hono";
import {
  byModel,
  byProject,
  byWorkType,
  recent,
  totals,
  type Period,
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
    const period = parsePeriod(c.req.query("period"));
    return c.json({
      period,
      totals: totals(period),
      by_model: byModel(period),
      by_project: byProject(period),
      by_work_type: byWorkType(period),
      recent: recent(period, 100),
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
  .muted { color: var(--muted); }
  .row { display: flex; align-items: center; gap: 8px; }
  .err { color: var(--bad); }
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
    <button data-p="24h">24h</button>
    <button data-p="7d" class="active">7d</button>
    <button data-p="30d">30d</button>
    <button data-p="all">all</button>
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
  <section class="card">
    <h2>Recent calls</h2>
    <div id="recent"></div>
  </section>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  let period = "7d";

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

  function recentTable(rows) {
    if (!rows.length) return '<div class="empty">no data yet</div>';
    const body = rows.map(r => \`<tr>
      <td class="mono muted">\${fmtTime(r.ts)}</td>
      <td>\${r.project ? '<code>' + r.project + '</code>' : '<span class="muted">—</span>'}</td>
      <td><span class="pill \${r.work_type}">\${r.work_type}</span></td>
      <td class="mono">\${r.routed_model}</td>
      <td class="num">\${fmtInt(r.prompt_tokens)}</td>
      <td class="num">\${fmtInt(r.completion_tokens)}</td>
      <td class="num">\${fmtMoney(r.cost_usd)}</td>
      <td class="num muted">\${fmtDur(r.duration_ms)}</td>
      <td class="num \${r.status >= 400 ? 'err' : 'muted'}">\${r.status}</td>
    </tr>\`).join("");
    return \`<table><thead><tr>
      <th>Time</th><th>Project</th><th>Type</th><th>Model</th>
      <th class="num">In</th><th class="num">Out</th><th class="num">Cost</th>
      <th class="num">Dur</th><th class="num">Status</th>
    </tr></thead><tbody>\${body}</tbody></table>\`;
  }

  async function load() {
    const res = await fetch("/dashboard/api/stats?period=" + period, { credentials: "include" });
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
  }

  document.querySelectorAll("#period-seg button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#period-seg button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      period = b.dataset.p;
      load();
    });
  });

  load();
  setInterval(load, 15_000);
</script>
</body>
</html>`;
