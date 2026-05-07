# auto-router

A tiny OpenAI-compatible HTTP service that fronts [Fireworks](https://fireworks.ai)
and [OpenRouter](https://openrouter.ai) and **auto-picks the right model for
each request** based on the task, then **logs every call** (model, project,
tokens, cost) to a small SQLite-backed dashboard.

Designed to run on [Railway](https://railway.com) and be plugged into
Cursor's "Override OpenAI Base URL" setting so every Cursor request is routed
to the most appropriate model — and you have a single pane of glass for spend.

## Routing table

| Tier | Model | Provider | When |
| --- | --- | --- | --- |
| `cheap` | `deepseek-v4-pro` | Fireworks | Non-dev work — summaries, first drafts, business copy, general Q&A |
| `agentic` (alias `easy`) | `xiaomi/mimo-v2.5-pro` | OpenRouter | Default for everyday dev work — quick changes, simple debugging, day-to-day Cursor coding. Also long-context bulk work (1M context window, fast). |
| `code` (alias `moderate`) | `anthropic/claude-sonnet-4.6` | OpenRouter | Substantial code work — non-trivial refactors, multi-file context (~5k+ tokens of code), structured reasoning |
| `reasoning` (alias `hard`) | `anthropic/claude-opus-4.7` | OpenRouter | Architecture, complex refactors, "must be excellent" reasoning |

The classifier (in `src/router.ts`) picks a tier from cheapest to highest in
this rough order: reasoning signal + substance &rarr; Opus; long context with
no tools &rarr; MiMo; substantial code work &rarr; Sonnet; any code/tool
signal &rarr; MiMo; otherwise &rarr; DeepSeek.

The choice is made by `src/router.ts` using cheap heuristics (input length,
presence of tools, code fences, file paths, dev verbs, architecture/reasoning
keywords). See that file for the exact rules.

For requests where the heuristic is uncertain — medium-sized prompts with no
strong reasoning signal — a tiny **hybrid LLM classifier** (`src/llm-classifier.ts`)
quickly asks DeepSeek to label the task as `easy` / `moderate` / `hard` and
**upgrades** the routing to Sonnet or Opus when warranted. It only ever
upgrades, never downgrades, has a hard timeout (default 1.5s), caches by
content hash for 5 minutes so retries don't pay twice, and folds its own
tiny cost into the call's `cost_usd`. Disable with `ROUTER_LLM_CLASSIFIER=0`.

### Async quality judge (optional)

To get visibility into where MiMo / DeepSeek are dropping quality vs a
stronger model, you can enable the **async sampled judge**
(`src/judge.ts`). After every successful cheap-tier call:

1. Eligibility check (sync, in-process): tier is `cheap` or `agentic`,
   completion was substantive (≥100 output tokens, contains code or is
   meaningfully long), random dice roll passes the sample rate.
2. If eligible, schedule a fire-and-forget Sonnet call (after the user
   response has already been delivered — never blocks them) that rates
   the response 1–10 against the user's actual ask, with a one-sentence
   reason and a `would_be_better_with_sonnet` boolean.
3. The score, reasons, and judge cost are saved to the DB and surface in
   the dashboard:
   - per-call **score badge** in the recent-calls table (red <6, yellow
     6–7, green 8+),
   - one-sentence judge reasoning shown inline under each judged call,
   - aggregate **Quality** card (judged calls / avg score / Sonnet flags),
   - **Low-quality calls** panel listing rows scored <6.

Cost: a typical judge call is ~1.5k tokens in / 200 tokens out on Sonnet
(~$0.007). At 100% sampling and 30 daily MiMo calls that's ~$0.20/day;
at 25% sampling, ~$0.05/day. The judge's cost is added to that call's
`cost_usd` so the dashboard reflects total spend.

Off by default. Turn it on with `ROUTER_JUDGE=1`. See `.env.example`
for sampling / threshold / model overrides.

### Anthropic prompt caching (the big cost lever)

Sonnet and Opus calls can route through OpenRouter with **`cache_control: ephemeral`**
breakpoints injected automatically (`src/prompt-cache.ts`). Anthropic
charges cache writes at 1.25x normal input price and cache reads at
**0.1x** input price, so for Cursor's repetitive agent loop (same 18k
system prompt + 19 tool defs + growing history sent on every turn)
total input cost typically drops by **~80-90%**. This is why a Cursor
BYOK Anthropic key feels cheaper than a naive proxy.

Markers we inject (Anthropic allows up to 4 breakpoints):
- the **last tool definition** (caches the entire tools array)
- the **last system / developer message** (caches the system prompt)
- the **most recent assistant or tool message** before the latest user
  turn (caches the conversation history; the new user turn stays fresh
  so the cache hits across turns).

Disable with `ROUTER_PROMPT_CACHE=0`. Idempotent — pre-existing
`cache_control` markers from the client are respected.

### Direct Anthropic mode (optional)

If you want to skip the OpenRouter hop entirely for Sonnet/Opus, set
`ROUTER_USE_DIRECT_ANTHROPIC=1` and provide `ANTHROPIC_API_KEY`. Calls
hit Anthropic's OpenAI-compatible endpoint at `https://api.anthropic.com/v1/`
with shorter latency. **Trade-off:** Anthropic's compat endpoint does
not support prompt caching, so for repeat-prefix workloads (the typical
Cursor agent loop) OpenRouter + caching is actually cheaper. Use direct
mode when first-token latency matters more than cost.

Override the model ids per tier:
- `ROUTER_MODEL_CODE` (default: `anthropic/claude-sonnet-4.6` on
  OpenRouter, `claude-sonnet-4-6` on direct)
- `ROUTER_MODEL_REASONING` (default: `anthropic/claude-opus-4.7` on
  OpenRouter, `claude-opus-4-7` on direct)

### Vision / image support

Image content (`image_url` parts in OpenAI shape, `input_image` in
Cursor's Responses-API shape, or Anthropic-style `image` source blocks)
is preserved end-to-end and forwarded to vision-capable models like
Claude 4.x and GPT-4o. Text-only requests still flatten content to a
plain string for backwards compatibility with the routing heuristics.

### Stream timeout safety net

Streaming requests are protected by two layers of timeout:

1. **First-content timeout** (18s, was 18s — unchanged): if the upstream
   connects but produces no real content within the window, the router
   walks a stall-fallback chain — Sonnet first, then DeepSeek as a final
   resort on a separate provider — so a wedged provider can never block
   indefinitely.
2. **Hard stream ceiling** (`ROUTER_MAX_STREAM_MS`, default 180s): even
   if heartbeats keep the connection alive, the stream is closed cleanly
   with `finish_reason: "stop"` after this duration. Prevents the
   "request never responds" symptom seen on workspaces with very large
   contexts.

### Reasoning-model controls

Reasoning-heavy models like Xiaomi MiMo V2.5 Pro and Anthropic's
extended-thinking variants run an internal chain-of-thought before
emitting any visible output. With OpenRouter's defaults (`high` effort)
MiMo regularly burns 1–2 minutes of internal reasoning per turn — long
enough that Cursor looks hung even though the request is healthy and
streaming. Two knobs (in `src/reasoning.ts`) keep this in check:

1. **Default effort injection.** Outbound requests for known reasoning
   models get `reasoning: { effort: "low" }` prepended when the client
   didn't already set one. MiMo is in the table by default. Override
   globally with `ROUTER_REASONING_EFFORT={low|medium|high}`, or
   per-model by editing `REASONING_EFFORT_DEFAULTS`.
2. **Reasoning stripping.** `reasoning` and `reasoning_details` fields
   are stripped from streamed deltas and non-streaming messages before
   forwarding to the client. Cursor doesn't render them anyway, and the
   chain-of-thought wire payload is often 10–100x larger than the
   actual content. Disable with `ROUTER_KEEP_REASONING=1` if your
   client *does* render reasoning.

### Picking the model from inside a prompt

You don't have to switch the Cursor model dropdown to force a tier. Start
your message with one of these and the router strips the tag and forces
that tier — the underlying model never sees the tag:

| Prefix | Tier | Model |
| --- | --- | --- |
| `!cheap` &middot; `!fast` | cheap | DeepSeek |
| `!easy` &middot; `!mimo` &middot; `!agentic` | agentic | MiMo |
| `!code` &middot; `!moderate` &middot; `!sonnet` | code | Sonnet |
| `!hard` &middot; `!reasoning` &middot; `!opus` | reasoning | Opus |

Both `!alias` and `[alias]` forms are accepted (e.g. `[opus]: deep dive on...`).
Anything after the tag is forwarded as-is, with leading punctuation stripped.

```text
!hard plan a refactor of the billing service
[opus]: review this consensus algorithm for correctness
!cheap quick — what does this regex do?
```

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
- `GET  /dashboard/api/stats?period=24h|7d|30d|all` &mdash; same data as JSON.
- `GET  /dashboard/api/stats?from=<epoch>&to=<epoch>` &mdash; custom date
  range (epoch seconds). Either bound is optional; missing `from` means
  all of history, missing `to` means now. The dashboard UI exposes a
  date-pair picker plus a `today` preset for calendar-day filtering.

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

Smoke-test the prompt-override parser and the hybrid LLM classifier
(unit tests, mocked fetch — no network):

```bash
npx tsx scripts/test-classifier.ts
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
- `src/classify.ts` &mdash; project + work-type detection, plus the `!alias` in-prompt override parser.
- `src/llm-classifier.ts` &mdash; hybrid LLM classifier (uncertain-band only, with timeout + cache).
- `src/judge.ts` &mdash; async sampled quality judge that scores cheap-tier responses with Sonnet.
- `src/breaker.ts` &mdash; in-process circuit breaker for flapping upstream models (skips primary, goes to fallback).
- `src/db.ts` &mdash; SQLite schema, `recordCall`, `updateQuality`, dashboard queries.
- `src/dashboard.ts` &mdash; HTML dashboard + JSON stats API + Basic-auth gate.
- `src/normalise.ts` &mdash; body-shape normalisation (Responses API ↔ Chat Completions, flat tools ↔ nested, image-content preservation).
- `src/prompt-cache.ts` &mdash; injects Anthropic `cache_control` breakpoints for Sonnet/Opus calls so OpenRouter applies the 10x cache-read discount.
- `scripts/test-router.ts` &mdash; offline sanity checks for the heuristic classifier.
- `scripts/test-classifier.ts` &mdash; unit tests for prompt overrides + hybrid LLM classifier (mocked).
- `scripts/test-judge.ts` &mdash; unit tests for the quality judge (mocked).
- `scripts/test-breaker.ts` &mdash; unit tests for the circuit breaker.
- `scripts/test-fallback.ts` &mdash; end-to-end test for upstream-failure fallback + prompt overrides.
- `scripts/test-normalise.ts` &mdash; unit tests for body-shape normalisation (incl. image preservation).
- `scripts/test-prompt-cache.ts` &mdash; unit tests for cache_control breakpoint injection.
- `scripts/test-work-type.ts` &mdash; unit tests for the dashboard work-type tag classifier.
- `scripts/smoke.ts` &mdash; offline DB / classifier smoke test.
- `scripts/http-smoke.ts` &mdash; full HTTP smoke test against a fake upstream (covers both providers).
- `railway.json` &mdash; build/start commands and healthcheck for Railway.
