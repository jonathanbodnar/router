# auto-router

A tiny OpenAI-compatible HTTP service that fronts [Fireworks](https://fireworks.ai)
and [OpenRouter](https://openrouter.ai) and **auto-picks the right model for
each request** based on the task, then **logs every call** (model, project,
tokens, cost) to a small SQLite-backed dashboard.

Designed to run on [Railway](https://railway.com) and be plugged into
Cursor's "Override OpenAI Base URL" setting so every Cursor request is routed
to the most appropriate model — and you have a single pane of glass for spend.

## Routing table

| Task type | Model | Provider |
| --- | --- | --- |
| Cheap/general answering, summaries, first drafts, simple business copy | `deepseek-v4-pro` | Fireworks |
| Long-context agentic workflows, big docs, multi-step automation, heavy tool use | `xiaomi/mimo-v2.5-pro` | OpenRouter |
| High-quality product/dev work, code edits, debugging, structured reasoning | `anthropic/claude-sonnet-4.6` | OpenRouter |
| Highest-stakes reasoning, architecture, complex refactors, "must be excellent" output | `anthropic/claude-opus-4.7` | OpenRouter |

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
  - any concrete model id &mdash; passthrough. Provider is inferred from the
    id format: `accounts/fireworks/...` &rarr; Fireworks; everything else
    (e.g. `anthropic/claude-opus-4.7`) &rarr; OpenRouter.
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
| `project` | resolved (in order) from: 1) `X-Router-Project` header, 2) a `__project` suffix on the model name (e.g. `gpt-4.1__router`), 3) heuristic detection from message content (looks for Cursor's `Workspace Path: …` block when present) |
| `work_type` | one of `bug_fix` / `rework` / `new_feature` / `other`, heuristic on the last user message; or `X-Router-Work-Type` header |
| `prompt_tokens`, `completion_tokens`, `total_tokens` | from each provider's `usage` (we inject `usage: { include: true }` for OpenRouter) |
| `cost_usd` | from `usage.cost` for OpenRouter (what your account is actually billed); computed locally from `src/pricing.ts` for Fireworks (Fireworks doesn't return cost in the response) |
| `duration_ms`, `status`, `stream`, `error` | request bookkeeping |

> Fireworks doesn't return cost in its responses, so we compute it from the
> per-model price table in `src/pricing.ts`. Defaults are best-effort
> placeholders ($0.50 / $1.50 per 1M in/out for DeepSeek V4 Pro). Override
> via `PRICE_DEEPSEEK_V4_INPUT` and `PRICE_DEEPSEEK_V4_OUTPUT`, or just edit
> `pricing.ts`.

The dashboard slices that table by model, by project, by work-type, and gives
you a live recent-calls list. There's a 24h / 7d / 30d / all period selector;
data refreshes every 15 seconds.

### Tagging requests from outside Cursor

Direct API users can label calls explicitly via headers:

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

### Tagging requests from Cursor (per-project)

Cursor's BYOK proxy strips its `Workspace Path:` system block before
forwarding to your custom URL, so heuristic project detection won't work
for Cursor traffic. Instead, **encode the project in the model name**
using a `__` separator:

| Cursor model name | Routing | Project tag |
| --- | --- | --- |
| `gpt-4.1` | auto-classified | _(none — falls back to heuristic / null)_ |
| `gpt-4.1__router` | auto-classified | `router` |
| `gpt-4.1__shopapp` | auto-classified | `shopapp` |
| `gpt-4.1__marketing` | auto-classified | `marketing` |

Cursor lets you add as many custom models as you want under one base URL;
add one entry per project, then pick the right one in the model selector
of each chat. The base before `__` is what Cursor's allowlist sees and
what we use for routing — so all of `gpt-4.1__*` route exactly the same
as plain `gpt-4.1`. Only the `_router` debug field and the dashboard
project breakdown change.

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
     Used for the agentic / code / reasoning tiers.
   - `FIREWORKS_API_KEY` &mdash; your Fireworks key (`fw_...`).
     Used for the cheap tier (DeepSeek V4 Pro).
   - `ROUTER_API_KEY` &mdash; a long random string. Cursor will use this.
   - `DASHBOARD_PASSWORD` &mdash; password for the `/dashboard` UI (optional;
     defaults to `ROUTER_API_KEY`).
   - `DATABASE_PATH=/data/router.db`.
   - *(optional)* `OPENROUTER_SITE_URL`, `OPENROUTER_APP_TITLE`, `ROUTER_LOG=1`,
     `PRICE_DEEPSEEK_V4_INPUT`, `PRICE_DEEPSEEK_V4_OUTPUT`.
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
- Click **Verify** (only once — multiple clicks can trip Cursor's local rate
  limiter).
- Under **Models**, add custom models named after Cursor's allowed list
  (most reliably `gpt-4.1`). Optionally add tagged variants per project,
  e.g. `gpt-4.1__router`, `gpt-4.1__shopapp` — see "Tagging requests from
  Cursor" above. Disable Cursor's built-in models so all chat traffic goes
  through the router.

From here on, Cursor sends every request to your Railway service, which:
1. Picks the right OpenRouter model per request,
2. Tags it with the workspace's project name and a heuristic work-type,
3. Calls OpenRouter, captures token + cost, and logs it,
4. Streams the response back transparently.

## Files

- `src/index.ts` &mdash; Hono server, auth, upstream proxy (streaming + non-streaming), call logging.
- `src/router.ts` &mdash; routing heuristics + alias + tier-to-(provider, model) table.
- `src/providers.ts` &mdash; provider configs (base URL, API key, headers, cost-from-usage flag).
- `src/pricing.ts` &mdash; per-model price table for providers that don't return cost (Fireworks).
- `src/classify.ts` &mdash; project + work-type detection (with header overrides).
- `src/db.ts` &mdash; SQLite schema, `recordCall`, dashboard queries.
- `src/dashboard.ts` &mdash; HTML dashboard + JSON stats API + Basic-auth gate.
- `scripts/test-router.ts` &mdash; offline sanity checks for the classifier.
- `scripts/smoke.ts` &mdash; offline DB / classifier smoke test.
- `scripts/http-smoke.ts` &mdash; full HTTP smoke test against a fake upstream (covers both providers).
- `railway.json` &mdash; build/start commands and healthcheck for Railway.
