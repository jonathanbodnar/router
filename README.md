# openrouter-auto-router

A tiny OpenAI-compatible HTTP service that sits in front of [OpenRouter](https://openrouter.ai)
and **auto-picks the right model for each request** based on the task, then
**logs every call** (model, project, tokens, cost) to a small SQLite-backed
dashboard.

Designed to run on [Railway](https://railway.com) and be plugged into
Cursor's "Override OpenAI Base URL" setting so every Cursor request is routed
to the most appropriate model — and you have a single pane of glass for spend.

## Routing table

| Task type | Model |
| --- | --- |
| Cheap/general answering, summaries, first drafts, simple business copy | `deepseek/deepseek-v4-pro` |
| Long-context agentic workflows, big docs, multi-step automation, heavy tool use | `xiaomi/mimo-v2.5-pro` |
| High-quality product/dev work, code edits, debugging, structured reasoning | `anthropic/claude-sonnet-4.6` |
| Highest-stakes reasoning, architecture, complex refactors, "must be excellent" output | `anthropic/claude-opus-4.7` |

The choice is made by `src/router.ts` using cheap heuristics (input length,
presence of tools, code fences, file paths, dev verbs, architecture/reasoning
keywords). See that file for the exact rules.

## Endpoints

All `/v1/*` endpoints require `Authorization: Bearer $ROUTER_API_KEY`.
The `/dashboard` UI is HTTP-Basic protected (username `admin`, password
`$DASHBOARD_PASSWORD`, falling back to `$ROUTER_API_KEY`).

- `GET  /healthz` &mdash; liveness probe (used by Railway).
- `GET  /v1/models` &mdash; lists the four backing models plus the routing
  aliases (`auto`, `cheap`, `agentic`, `code`, `reasoning`).
- `POST /v1/chat/completions` &mdash; standard OpenAI chat-completions API,
  including streaming. The `model` field accepts:
  - `auto` &mdash; classify and route automatically (recommended).
  - `cheap` / `agentic` / `code` / `reasoning` &mdash; force a specific tier.
  - any concrete OpenRouter model id like `anthropic/claude-opus-4.7` &mdash; passthrough.
- `GET  /dashboard` &mdash; HTML dashboard (totals, breakdowns, recent calls).
- `GET  /dashboard/api/stats?period=24h|7d|30d|all` &mdash; the same data as JSON.

The response's `model` field is rewritten back to whatever the client
requested (e.g. `auto`), and a `_router` debug object is attached on
non-streaming responses showing which tier and concrete model were used.

## What gets logged

Every chat-completion request writes one row to `calls` in SQLite:

| Field | Notes |
| --- | --- |
| `routed_model`, `tier` | what we actually called on OpenRouter |
| `requested_model` | what the client asked for (`auto`, alias, model id) |
| `project` | detected from Cursor's `Workspace Path: …` system block, or the `X-Router-Project` header |
| `work_type` | one of `bug_fix` / `rework` / `new_feature` / `other`, heuristic on the last user message; or `X-Router-Work-Type` header |
| `prompt_tokens`, `completion_tokens`, `total_tokens` | from OpenRouter's `usage` (we inject `usage: { include: true }`) |
| `cost_usd` | from OpenRouter's `usage.cost` — what your account is actually billed |
| `duration_ms`, `status`, `stream`, `error` | request bookkeeping |

The dashboard slices that table by model, by project, by work-type, and gives
you a live recent-calls list. There's a 24h / 7d / 30d / all period selector;
data refreshes every 15 seconds.

### Tagging requests from outside Cursor

Direct API users can label calls explicitly:

```bash
curl https://your-app.up.railway.app/v1/chat/completions \
  -H "authorization: Bearer $ROUTER_API_KEY" \
  -H "content-type: application/json" \
  -H "x-router-project: shopapp" \
  -H "x-router-work-type: bug_fix" \
  -d '{"model":"auto","messages":[{"role":"user","content":"why is checkout 500ing?"}]}'
```

Accepted `x-router-work-type` values: `bug_fix` (or `bug`/`fix`),
`rework` (or `refactor`), `new_feature` (or `feature`/`new`), `other`.

## Local dev

```bash
cp .env.example .env
# fill in OPENROUTER_API_KEY and ROUTER_API_KEY
npm install
npm run dev
```

Open <http://localhost:8787/dashboard>.

Smoke-test the routing classifier (no network):

```bash
npx tsx scripts/test-router.ts
```

Smoke-test the full HTTP loop against a fake OpenRouter (no network, no DB
in your repo — uses `.tmp-http-smoke.db`):

```bash
npx tsx scripts/http-smoke.ts
```

## Deploy on Railway

1. Push this repo to GitHub.
2. **New Project &rarr; Deploy from GitHub repo** and pick this repo. Railway
   auto-detects Node via Nixpacks; the included `railway.json` pins the
   build/start commands and the `/healthz` healthcheck.
3. Under **Variables**, set:
   - `OPENROUTER_API_KEY` &mdash; your OpenRouter key (`sk-or-v1-...`).
   - `ROUTER_API_KEY` &mdash; a long random string. Cursor will use this.
   - `DASHBOARD_PASSWORD` &mdash; password for the `/dashboard` UI (optional;
     defaults to `ROUTER_API_KEY`).
   - `DATABASE_PATH=/data/router.db`.
   - *(optional)* `OPENROUTER_SITE_URL`, `OPENROUTER_APP_TITLE`, `ROUTER_LOG=1`.
4. Under **Settings &rarr; Volumes**, attach a small volume mounted at
   `/data`. This is where the SQLite call log lives so it survives redeploys.
5. Under **Settings &rarr; Networking**, click **Generate Domain**. You'll
   get something like `https://your-app.up.railway.app`.

That domain plus `/v1` is your OpenAI-compatible base URL. The dashboard is
at `https://your-app.up.railway.app/dashboard`.

## Wire it into Cursor

In Cursor: **Settings &rarr; Models &rarr; OpenAI API Key**:

- **OpenAI API Key**: paste your `ROUTER_API_KEY`.
- Expand **Override OpenAI Base URL** and set it to:
  `https://your-app.up.railway.app/v1`
- Click **Verify**.
- Under **Models**, add a custom model named `auto` (and optionally
  `cheap`, `agentic`, `code`, `reasoning`). Disable any built-in models you
  don't want Cursor to use directly so it always goes through the router.

From here on, Cursor sends every request to your Railway service, which:
1. Picks the right OpenRouter model per request,
2. Tags it with the workspace's project name and a heuristic work-type,
3. Calls OpenRouter, captures token + cost, and logs it,
4. Streams the response back transparently.

## Files

- `src/index.ts` &mdash; Hono server, auth, OpenRouter proxy (streaming + non-streaming), call logging.
- `src/router.ts` &mdash; routing heuristics + alias table.
- `src/classify.ts` &mdash; project + work-type detection (with header overrides).
- `src/db.ts` &mdash; SQLite schema, `recordCall`, dashboard queries.
- `src/dashboard.ts` &mdash; HTML dashboard + JSON stats API + Basic-auth gate.
- `scripts/test-router.ts` &mdash; offline sanity checks for the classifier.
- `scripts/smoke.ts` &mdash; offline DB / classifier smoke test.
- `scripts/http-smoke.ts` &mdash; full HTTP smoke test against a fake OpenRouter.
- `railway.json` &mdash; build/start commands and healthcheck for Railway.
