import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import * as breaker from "./breaker.js";
import {
  parseModelProjectTag,
  parsePromptOverride,
  resolveProject,
  resolveWorkType,
} from "./classify.js";
import { mountDashboard } from "./dashboard.js";
import { recordCall } from "./db.js";
import { DEFAULT_CONFIG as JUDGE_CFG, scheduleJudge } from "./judge.js";
import { DEFAULT_CONFIG as CLASSIFIER_CFG, maybeUpgradeWithLLM } from "./llm-classifier.js";
import { normaliseBody } from "./normalise.js";
import { computeCost } from "./pricing.js";
import { loadProviders, type Provider } from "./providers.js";
import {
  classifyEffort,
  HEARTBEAT_MODELS,
  type ReasoningEffort,
  shouldStripReasoning,
  stripReasoningInPlace,
  withReasoningEffort,
} from "./reasoning.js";

const STRIP_REASONING = shouldStripReasoning();
import { MODELS, route, type IncomingRequest } from "./router.js";

const { ROUTER_API_KEY, ROUTER_LOG, PORT } = process.env;

if (!ROUTER_API_KEY) {
  console.error("FATAL: ROUTER_API_KEY is not set.");
  process.exit(1);
}

const PROVIDERS = loadProviders();

// Validate API keys for the providers actually used by our tiers.
const tiersInUse = new Set<Provider>(
  Object.values(MODELS).map((t) => t.provider),
);
for (const p of tiersInUse) {
  if (!PROVIDERS[p].apiKey) {
    const envName = p === "openrouter" ? "OPENROUTER_API_KEY" : "FIREWORKS_API_KEY";
    console.error(`FATAL: ${envName} is not set (required for ${p}).`);
    process.exit(1);
  }
}

const log = ROUTER_LOG === "1" || ROUTER_LOG === "true";

const app = new Hono();

app.use("*", cors());

app.get("/", (c) =>
  c.json({
    ok: true,
    service: "openrouter-auto-router",
    endpoints: ["/v1/models", "/v1/chat/completions", "/dashboard"],
  }),
);

app.get("/healthz", (c) => c.text("ok"));

mountDashboard(app);

/* ---------- auth (v1 only) ---------- */

app.use("/v1/*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  const presented = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : "";
  if (!presented || presented !== ROUTER_API_KEY) {
    return c.json(
      {
        error: {
          message: "Invalid or missing API key.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      },
      401,
    );
  }
  await next();
});

/* ---------- models ---------- */

app.get("/v1/models", (c) => {
  const now = Math.floor(Date.now() / 1000);
  const aliases = ["auto", "cheap", "agentic", "code", "reasoning"];
  const data = [
    ...aliases.map((id) => ({
      id,
      object: "model",
      created: now,
      owned_by: "router",
    })),
    ...Object.values(MODELS).map((t) => ({
      id: t.model,
      object: "model",
      created: now,
      owned_by: t.provider,
    })),
  ];
  return c.json({ object: "list", data });
});

/* ---------- chat completions ---------- */

interface CapturedUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
}

function emptyUsage(): CapturedUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };
}

/**
 * Extract the latest user-role message text. Used by the quality judge so
 * it knows what the user actually asked. Mirrors the helper in router.ts
 * but works on a normalised IncomingRequest.
 */
function lastUserMessageText(req: IncomingRequest): string {
  const msgs = req.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
    }
    return "";
  }
  return "";
}

function mergeUsage(into: CapturedUsage, raw: unknown): void {
  if (!raw || typeof raw !== "object") return;
  const u = raw as Record<string, unknown>;
  if (typeof u.prompt_tokens === "number") into.prompt_tokens = u.prompt_tokens;
  if (typeof u.completion_tokens === "number")
    into.completion_tokens = u.completion_tokens;
  if (typeof u.total_tokens === "number") into.total_tokens = u.total_tokens;
  // OpenRouter returns `cost` (USD) when usage.include is set.
  if (typeof u.cost === "number") into.cost_usd = u.cost;
  else if (typeof u.cost_usd === "number") into.cost_usd = u.cost_usd;
}

/** Force OpenRouter to return token + cost numbers in usage. */
function withUsageIncluded(body: IncomingRequest): IncomingRequest {
  const existing =
    body.usage && typeof body.usage === "object"
      ? (body.usage as Record<string, unknown>)
      : {};
  return { ...body, usage: { ...existing, include: true } };
}


/**
 * Some clients (Cursor, OpenAI Responses-API consumers, etc.) post bodies
 * that use `input` / `instructions` / `prompt` instead of `messages`. We
 * normalise everything to a chat-completions-shaped body before forwarding,
 * so upstream never has to deal with the variation.
 *
 * Returns the normalised body and a list of source-field names we adapted
 * from (for logging).
 */

/**
 * Compute cost for a finished call. For providers that return cost in
 * `usage.cost` (OpenRouter) we trust that number; otherwise we derive it
 * from the per-model price table in pricing.ts.
 */
function finalizeCost(
  provider: Provider,
  routedModel: string,
  usage: CapturedUsage,
): void {
  if (PROVIDERS[provider].costFromUsage) return; // already set from upstream
  if (usage.cost_usd > 0) return;
  usage.cost_usd = computeCost(
    routedModel,
    usage.prompt_tokens,
    usage.completion_tokens,
  );
}

app.post("/v1/chat/completions", async (c) => {
  const startedAt = Date.now();

  let rawBody: Record<string, unknown>;
  try {
    rawBody = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json(
      {
        error: {
          message: "Invalid JSON body.",
          type: "invalid_request_error",
        },
      },
      400,
    );
  }

  // Log the incoming body shape so we can see exactly what clients send
  // (Cursor in particular has been seen to use Responses-API-style fields).
  if (log) {
    const keys = Object.keys(rawBody);
    const msgs = Array.isArray(rawBody.messages)
      ? (rawBody.messages as unknown[]).length
      : "—";
    console.log(
      `[req] keys=[${keys.join(",")}] messages=${msgs} ` +
        `has_input=${"input" in rawBody} has_prompt=${"prompt" in rawBody} ` +
        `has_instructions=${"instructions" in rawBody} ` +
        `headers=[${[...c.req.raw.headers.keys()].join(",")}]`,
    );
  }
  // Opt-in full-body dump for one-off debugging. Set ROUTER_LOG_BODY=1 in
  // Railway, send a few requests, then unset it again.
  if (process.env.ROUTER_LOG_BODY === "1") {
    try {
      console.log("[body]", JSON.stringify(rawBody).slice(0, 4000));
    } catch {
      console.log("[body] <unserialisable>");
    }
  }

  const { body: normalisedBody, adapted } = normaliseBody(rawBody);
  // Always log when we translate flat tools — strict upstreams (sglang
  // behind MiMo, certain Anthropic providers) reject the flat shape, so
  // this line is the proof-point that the fix kicked in. Other adaptations
  // are still gated behind ROUTER_LOG_UPSTREAM.
  if (adapted.includes("tools(flat->nested)")) {
    console.log(`[normalise] translated flat tools -> nested for upstream`);
  }
  if (log && adapted.length > 0) {
    console.log(`[normalise] adapted fields: ${adapted.join(", ")}`);
  }

  let body = normalisedBody as IncomingRequest;

  // Capture the originally-requested model BEFORE any override rewrites it,
  // so the dashboard / response present what the client actually sent.
  const requestedModel = (body.model ?? "auto").toString();

  // 1. In-prompt routing override: if the last user message starts with
  //    `!hard`, `[opus]`, etc., strip it and force that tier. We do this
  //    BEFORE classification so the heuristic and LLM classifier never see
  //    the override tag and can't get confused by it.
  let promptOverrideAlias: string | null = null;
  const override = parsePromptOverride(body);
  if (override) {
    promptOverrideAlias = override.alias;
    body = override.request;
    if (log) {
      console.log(`[prompt-override] alias=${promptOverrideAlias}`);
    }
  }

  // 2. Heuristic routing (synchronous, fast).
  const heuristicDecision = route(body);

  // 3. Hybrid LLM classifier — only fires inside a narrow uncertain band
  //    AND only when the user didn't explicitly override the tier in the
  //    prompt or via an alias model name.
  let decision = heuristicDecision;
  let llmDifficulty: string | null = null;
  let llmCostUsd = 0;
  let llmDurationMs = 0;
  let llmCached = false;
  // Skip the classifier when the user has explicitly chosen a tier, either
  // via the in-prompt `!alias` override or by passing an alias / concrete
  // model id as `model`. We detect "user was explicit" from the routing
  // reason: heuristic decisions start with the tier description, while
  // explicit ones start with `alias "..."` or `passthrough`.
  const wasExplicit =
    promptOverrideAlias != null ||
    /^(?:alias |passthrough)/.test(heuristicDecision.reason);
  if (!wasExplicit) {
    try {
      const upgrade = await maybeUpgradeWithLLM(
        body,
        heuristicDecision,
        PROVIDERS,
        CLASSIFIER_CFG,
      );
      decision = upgrade.decision;
      llmDifficulty = upgrade.difficulty;
      llmCostUsd = upgrade.classifierCostUsd;
      llmDurationMs = upgrade.durationMs;
      llmCached = upgrade.cached;
      if (log && upgrade.upgraded) {
        console.log(
          `[classifier] ${heuristicDecision.tier} -> ${decision.tier} ` +
            `(difficulty=${llmDifficulty}, ${llmDurationMs}ms${llmCached ? ", cached" : ""})`,
        );
      } else if (log && llmDifficulty) {
        console.log(
          `[classifier] kept ${decision.tier} ` +
            `(difficulty=${llmDifficulty}, ${llmDurationMs}ms${llmCached ? ", cached" : ""})`,
        );
      }
    } catch (err) {
      console.error("[classifier] error (ignored):", err);
    }
  }
  const provider = PROVIDERS[decision.provider];
  const { project: modelProjectTag } = parseModelProjectTag(requestedModel);
  const project = resolveProject(
    c.req.header("x-router-project"),
    modelProjectTag,
    body,
  );
  const workType = resolveWorkType(c.req.header("x-router-work-type"), body);
  const isStream = body.stream === true;

  // Dynamic reasoning effort — adapts to task complexity so MiMo
  // thinks hard on "build this feature" but barely pauses on "rename X".
  const userTextForEffort = lastUserMessageText(body);
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  const reasoningEffort: ReasoningEffort = classifyEffort(
    userTextForEffort,
    toolCount,
    decision.tier,
  );

  if (log) {
    console.log(
      `[route] requested="${requestedModel}" -> ${decision.provider}:${decision.model} ` +
        `(${decision.tier}; ${decision.reason}) ` +
        `effort=${reasoningEffort} ` +
        `ctx=${decision.approxInputTokens}tok ` +
        `project=${project ?? "-"} work_type=${workType} stream=${isStream}`,
    );
  }

  /**
   * Headers we DO forward from the client to upstream. We use a strict
   * allowlist (rather than a denylist) because forwarding anything Cursor
   * happens to send was causing OpenRouter's edge to reject the request
   * with a generic "Internal Server Error" 500 for Anthropic models.
   *
   * The kept ones are SDK-identification headers that OpenRouter's
   * model-specific adapters (notably MiMo's tool-translation layer) use
   * to apply the right OpenAI-compat shim. Anything else — Cursor-specific
   * headers, CDN/Cloudflare beacons, Accept-Encoding, etc. — is dropped.
   */
  const HEADER_ALLOW_EXACT = new Set([
    "user-agent",
    "openai-beta",
    "openai-organization",
    "openai-project",
  ]);
  const HEADER_ALLOW_PREFIXES = ["x-stainless-"];

  /**
   * Build the request to send upstream for a given (provider, model) pair.
   */
  const buildUpstreamRequest = (
    p: typeof provider,
    model: string,
  ): { url: string; init: RequestInit } => {
    let payload: IncomingRequest = { ...body, model };
    if (p.injectUsageInclude) payload = withUsageIncluded(payload);
    payload = withReasoningEffort(payload, model, reasoningEffort);

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (
        HEADER_ALLOW_EXACT.has(lower) ||
        HEADER_ALLOW_PREFIXES.some((prefix) => lower.startsWith(prefix))
      ) {
        headers[name] = value;
      }
    });
    // Our overrides go last so they win over anything the client sent.
    headers["content-type"] = "application/json";
    headers["authorization"] = `Bearer ${p.apiKey}`;
    for (const [k, v] of Object.entries(p.extraHeaders)) headers[k] = v;

    const url = `${p.baseUrl}/chat/completions`;
    const bodyJson = JSON.stringify(payload);
    if (process.env.ROUTER_LOG_UPSTREAM === "1") {
      const safeHeaders = { ...headers };
      if (safeHeaders.authorization) {
        safeHeaders.authorization = `Bearer ***${(p.apiKey ?? "").slice(-4)}`;
      }
      console.log(
        `[upstream-out] ${p.name}:${model} ${url} ` +
          `headers=${JSON.stringify(safeHeaders)} body=${bodyJson.slice(0, 4000)}`,
      );
    }
    return {
      url,
      init: {
        method: "POST",
        headers,
        body: bodyJson,
      },
    };
  };

  // Mutable "what we actually called" so logging + DB record reflect the
  // final model, not just the original routing decision.
  let actualProvider = provider;
  let actualModel = decision.model;
  let actualTier = decision.tier;
  let fellBackTo: string | null = null;

  const usage = emptyUsage();

  // Captured for the async judge — only used when a successful response
  // is produced and the call lands on a cheap-tier model.
  const captured = {
    userText: lastUserMessageText(body),
    responseText: "",
  };

  /** Single place that writes the call to the DB. The classifier's own
   *  cost is folded into cost_usd so the dashboard reflects total spend.
   *  Returns the inserted DB row id (or 0 if the insert failed). */
  const finalize = (status: number, error: string | null): number => {
    try {
      const id = recordCall({
        ts: Math.floor(startedAt / 1000),
        requested_model: requestedModel,
        routed_model: actualModel,
        tier: actualTier,
        project,
        work_type: workType,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        cost_usd: usage.cost_usd + llmCostUsd,
        duration_ms: Date.now() - startedAt,
        status,
        stream: isStream,
        error,
      });
      // Async sampled quality judge — fire-and-forget. The user response
      // has already been streamed/returned at this point, so this can
      // never delay them. Eligibility (sample rate, min output tokens,
      // tier filter, substantive-output check) is enforced inside.
      if (status >= 200 && status < 300 && id > 0) {
        scheduleJudge(
          {
            callId: id,
            tier: actualTier,
            userText: captured.userText,
            responseText: captured.responseText,
            outputTokens: usage.completion_tokens,
          },
          PROVIDERS,
          JUDGE_CFG,
        );
      }
      return id;
    } catch (err) {
      console.error("[db] failed to record call:", err);
      return 0;
    }
  };

  /**
   * Try the routed (provider, model). On non-OK upstream, walk a fallback
   * chain so we always land somewhere healthy:
   *
   *   reasoning -> code -> agentic -> cheap
   *
   * Each step is skipped when its model's circuit breaker is open. We
   * always end at `cheap` (DeepSeek on Fireworks) which is on a separate
   * provider, so even a full OpenRouter outage still gets the user a
   * response and Cursor's BYOK proxy won't trip its local rate-limiter.
   *
   * Returns the (final) Response, with body never consumed.
   */
  const callUpstreamWithFallback = async (): Promise<Response> => {
    // Priority list of (tier, model, provider) to try. The fallback
    // chain is cost-aware: cheap/agentic tiers fall back DOWN (to
    // cheaper models), not UP to Sonnet. Only code/reasoning tiers
    // fall back through Sonnet before hitting DeepSeek.
    //
    //   reasoning -> code    -> cheap   (worth paying for Sonnet fallback)
    //   code      -> cheap              (already Sonnet; skip to DeepSeek)
    //   agentic   -> cheap              (MiMo fail? go cheap, not Sonnet)
    //   cheap     -> agentic -> code    (DeepSeek fail? try MiMo, then Sonnet)
    type FallbackLabel = "primary" | "fallback-sonnet" | "fallback-deepseek" | "fallback-mimo";
    const candidates: Array<{
      tier: typeof decision.tier;
      model: string;
      providerCfg: typeof provider;
      label: FallbackLabel;
    }> = [];
    const seen = new Set<string>();
    const push = (
      tier: typeof decision.tier,
      label: FallbackLabel,
    ) => {
      const entry = MODELS[tier];
      if (seen.has(entry.model)) return;
      seen.add(entry.model);
      candidates.push({
        tier,
        model: entry.model,
        providerCfg: PROVIDERS[entry.provider],
        label,
      });
    };
    push(decision.tier, "primary");
    if (decision.tier === "reasoning" || decision.tier === "code") {
      push("code", "fallback-sonnet");
    }
    if (decision.tier === "cheap") {
      push("agentic", "fallback-mimo");
      push("code", "fallback-sonnet");
    }
    push("cheap", "fallback-deepseek");

    let lastResp: Response | null = null;
    let lastBodyPreview = "";

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i]!;
      const isLast = i === candidates.length - 1;
      // Skip candidates whose breaker is open — but never skip the last
      // one (we always need to attempt at least the final fallback).
      if (!isLast && breaker.isOpen(cand.model)) {
        console.warn(
          `[breaker-open] skipping ${cand.providerCfg.name}:${cand.model} (${cand.label})`,
        );
        continue;
      }

      const reqOut = buildUpstreamRequest(cand.providerCfg, cand.model);
      let resp: Response;
      try {
        resp = await fetch(reqOut.url, reqOut.init);
      } catch (err) {
        console.error(`[upstream:${cand.providerCfg.name}] fetch failed:`, err);
        breaker.record(cand.model, false);
        lastBodyPreview = String(err);
        continue;
      }
      breaker.record(cand.model, resp.ok);

      let bodyPreview = "";
      if (process.env.ROUTER_LOG_UPSTREAM === "1") {
        try {
          bodyPreview = (await resp.clone().text()).slice(0, 2000);
          console.log(
            `[upstream-in] ${cand.providerCfg.name}:${cand.model} ` +
              `status=${resp.status} body=${bodyPreview}`,
          );
        } catch { /* ignore */ }
      }

      // Update "what we actually called" so logs / DB / response metadata
      // reflect reality.
      actualProvider = cand.providerCfg;
      actualModel = cand.model;
      actualTier = cand.tier;
      if (cand.label !== "primary") {
        fellBackTo = `${cand.providerCfg.name}:${cand.model} (${cand.label})`;
      }

      if (resp.ok) return resp;

      // Non-OK: snapshot body, log a one-liner, continue walking.
      let bodyText = bodyPreview;
      if (!bodyText) {
        try { bodyText = (await resp.clone().text()).slice(0, 2000); } catch { /* ignore */ }
      }
      console.warn(
        `[fallback] ${cand.providerCfg.name}:${cand.model} (${cand.label}) -> ` +
          `${resp.status} body=${bodyText.slice(0, 400)}`,
      );
      lastResp = resp;
      lastBodyPreview = bodyText;
    }

    if (lastResp) {
      console.warn(
        `[fallback-exhausted] every tier failed for this request; ` +
          `last_status=${lastResp.status} last_body=${lastBodyPreview.slice(0, 200)}`,
      );
      return lastResp;
    }
    throw new Error(`upstream chain exhausted: ${lastBodyPreview.slice(0, 200)}`);
  };

  let upstream: Response;
  try {
    upstream = await callUpstreamWithFallback();
  } catch (err) {
    finalize(502, String(err));
    return c.json(
      {
        error: {
          message: `Upstream request to ${provider.name} failed.`,
          type: "upstream_error",
        },
      },
      502,
    );
  }

  if (log && fellBackTo) {
    console.log(`[fallback-ok] served via ${fellBackTo}`);
  }

  /* ---------- non-streaming ---------- */

  if (!isStream) {
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error(
        `[upstream:${actualProvider.name}] ${upstream.status} body=${text.slice(0, 800)}`,
      );
      finalize(upstream.status, text.slice(0, 500));
      return new Response(text, {
        status: upstream.status,
        headers: {
          "content-type":
            upstream.headers.get("content-type") ?? "application/json",
        },
      });
    }
    try {
      const json = JSON.parse(text);
      if (json && typeof json === "object") {
        if (json.usage) mergeUsage(usage, json.usage);
        finalizeCost(actualProvider.name, actualModel, usage);
        // Capture assistant text for the async judge, and optionally
        // strip reasoning fields the upstream included.
        try {
          const choices = (json as { choices?: unknown }).choices;
          if (Array.isArray(choices)) {
            const parts: string[] = [];
            for (const ch of choices) {
              const msg = (ch as { message?: Record<string, unknown> } | null)?.message;
              if (msg && typeof msg === "object" && STRIP_REASONING) {
                stripReasoningInPlace(msg);
              }
              const content = msg?.content;
              if (typeof content === "string") parts.push(content);
              else if (Array.isArray(content)) {
                for (const p of content as Array<{ text?: unknown; type?: unknown }>) {
                  if (typeof p?.text === "string") parts.push(p.text);
                }
              }
              const tcs = msg?.tool_calls;
              if (Array.isArray(tcs)) {
                for (const tc of tcs as Array<{ function?: { name?: unknown; arguments?: unknown } }>) {
                  const fn = tc?.function;
                  if (fn && typeof fn === "object") {
                    parts.push(
                      `[tool_call ${typeof fn.name === "string" ? fn.name : ""}: ${
                        typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {})
                      }]`,
                    );
                  }
                }
              }
            }
            captured.responseText = parts.join("\n");
          }
        } catch { /* ignore */ }
        json.model = requestedModel;
        if (!json._router) {
          json._router = {
            requested: requestedModel,
            provider: actualProvider.name,
            routed_to: actualModel,
            tier: actualTier,
            reasoning_effort: reasoningEffort,
            reason: decision.reason,
            fell_back: fellBackTo,
            prompt_override: promptOverrideAlias,
            classifier: llmDifficulty
              ? {
                  difficulty: llmDifficulty,
                  duration_ms: llmDurationMs,
                  cached: llmCached,
                  cost_usd: llmCostUsd,
                }
              : null,
            project,
            work_type: workType,
          };
        }
      }
      finalize(upstream.status, null);
      return c.json(json, upstream.status as 200);
    } catch {
      finalizeCost(actualProvider.name, actualModel, usage);
      finalize(upstream.status, "non-json upstream response");
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": "application/json" },
      });
    }
  }

  /* ---------- streaming ---------- */

  const sseHeaders = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  // Cursor sees "gpt-4.1" and times out if it doesn't get content within ~3s.
  // This affects ALL models — not just MiMo — when context is large (Sonnet
  // with 300K+ tokens also takes 10-30s before first token). Apply heartbeats
  // to every streaming request so the connection never stalls.
  const needsHeartbeat = isStream;
  const HEARTBEAT_MS = 1_500;

  if (needsHeartbeat) {
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let streamCancelled = false;
    const clearHB = () => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    };

    const encoder = new TextEncoder();
    let lastContentMs = 0;
    let recorded = false;
    const recordOnce = (status: number, err: string | null) => {
      if (recorded) return;
      recorded = true;
      finalize(status, err);
    };

    // Controller reference — set synchronously inside start().
    let ctrl: ReadableStreamDefaultController<Uint8Array>;

    let hbCount = 0;
    const emitHeartbeat = () => {
      if (streamCancelled) { clearHB(); return; }
      if (lastContentMs && Date.now() - lastContentMs < HEARTBEAT_MS) return;
      hbCount++;
      if (log) console.log(`[heartbeat] #${hbCount} sent (lastContentMs=${lastContentMs}, seenContent=${lastContentMs > 0})`);
      const hb = JSON.stringify({
        id: `hb-${Date.now()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: requestedModel,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: " " },
          finish_reason: null,
        }],
      });
      try { ctrl.enqueue(encoder.encode(`data: ${hb}\n\n`)); }
      catch (e) { console.log(`[heartbeat] enqueue failed (stream closed?):`, e); clearHB(); }
    };

    // If the upstream model connects but produces no real content for this
    // many ms, abort it and retry with Sonnet directly. Prevents MiMo queue
    // back-pressure from causing 60-80s hangs that kill Cursor's subagents.
    const FIRST_CONTENT_TIMEOUT_MS = 25_000;

    // Detached async function that fetches upstream and pipes
    // chunks into the controller. Runs independently of start().
    // Pass `forceModel` to bypass callUpstreamWithFallback and hit a
    // specific model directly (used for the content-timeout fallback).
    async function pipeUpstream(forceModel?: { model: string; tier: typeof decision.tier }) {
      try {
        let upstreamResp: Response;
        if (forceModel) {
          const entry = MODELS[forceModel.tier];
          const pCfg = PROVIDERS[entry.provider];
          const reqOut = buildUpstreamRequest(pCfg, forceModel.model);
          actualProvider = pCfg;
          actualModel = forceModel.model;
          actualTier = forceModel.tier;
          fellBackTo = `${pCfg.name}:${forceModel.model} (content-timeout-fallback)`;
          upstreamResp = await fetch(reqOut.url, reqOut.init);
        } else {
          upstreamResp = await callUpstreamWithFallback();
        }

        if (streamCancelled) { clearHB(); return; }
        const msSinceStart = Date.now() - startedAt;
        if (log) console.log(`[heartbeat] upstream connected after ${msSinceStart}ms, sent ${hbCount} HBs so far`);

        if (!upstreamResp.ok || !upstreamResp.body) {
          clearHB();
          const text = await upstreamResp.text();
          console.error(
            `[upstream:${actualProvider.name}] ${upstreamResp.status} (hb-stream) body=${text.slice(0, 800)}`,
          );
          const errChunk = JSON.stringify({
            id: `err-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: requestedModel,
            choices: [{
              index: 0,
              delta: { content: `\n[upstream error: ${upstreamResp.status}]` },
              finish_reason: "stop",
            }],
          });
          ctrl.enqueue(encoder.encode(`data: ${errChunk}\n\ndata: [DONE]\n\n`));
          recordOnce(upstreamResp.status, text.slice(0, 500));
          ctrl.close();
          return;
        }

        const reader = upstreamResp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Watchdog: if upstream is connected but producing nothing but
        // reasoning/comments for too long, bail and fall back to Sonnet.
        // Only arm on the initial (non-forced) call to avoid loops.
        let firstContentTimer: ReturnType<typeof setTimeout> | null = null;
        const sonnetTier = "code" as const;
        const sonnetEntry = MODELS[sonnetTier];
        const canFallbackToSonnet = !forceModel && actualModel !== sonnetEntry.model;
        if (canFallbackToSonnet) {
          firstContentTimer = setTimeout(() => {
            if (lastContentMs || streamCancelled) return;
            const waited = Date.now() - startedAt;
            console.warn(
              `[timeout] ${actualModel} no real content after ${waited}ms — ` +
              `aborting & retrying with ${sonnetEntry.model}`,
            );
            reader.cancel().catch(() => {});
            // Retry the whole pipe with Sonnet; heartbeats stay active.
            pipeUpstream({ model: sonnetEntry.model, tier: sonnetTier });
          }, FIRST_CONTENT_TIMEOUT_MS);
        }

        for (;;) {
          if (streamCancelled) { reader.cancel(); clearHB(); if (firstContentTimer) clearTimeout(firstContentTimer); return; }
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const rewritten = rewriteSseEvent(
              rawEvent, requestedModel, usage, captured,
            );
              if (rewritten.includes('"content":"') &&
                  !rewritten.includes('"content":""')) {
                if (!lastContentMs) {
                  if (firstContentTimer) { clearTimeout(firstContentTimer); firstContentTimer = null; }
                  if (log) console.log(`[heartbeat] first real content at ${Date.now() - startedAt}ms after ${hbCount} HBs`);
                }
                lastContentMs = Date.now();
              }
            ctrl.enqueue(encoder.encode(rewritten + "\n\n"));
          }
        }
        if (firstContentTimer) { clearTimeout(firstContentTimer); firstContentTimer = null; }
        clearHB();
        if (buffer.length > 0) {
          ctrl.enqueue(encoder.encode(
            rewriteSseEvent(buffer, requestedModel, usage, captured),
          ));
        }
        finalizeCost(actualProvider.name, actualModel, usage);
        recordOnce(200, null);
      } catch (err) {
        if (streamCancelled) return;
        // reader.cancel() from the timeout fires as an AbortError — that's
        // expected; the fallback retry handles continuation.
        const msg = String(err);
        if (msg.includes("This readable stream reader has been released") ||
            msg.includes("AbortError") ||
            msg.includes("The operation was aborted")) {
          return; // normal timeout-triggered cancellation
        }
        clearHB();
        console.error("[stream] error:", err);
        try { ctrl.error(err); } catch { /* already closed */ }
        return;
      }
      try { ctrl.close(); } catch { /* already closed */ }
    }

    const stream = new ReadableStream<Uint8Array>({
      // CRITICAL: start() is synchronous — returns void, NOT a
      // Promise. This lets enqueued heartbeats flush to the HTTP
      // response immediately instead of being held until an async
      // start() promise resolves.
      start(controller) {
        ctrl = controller;
        if (log) console.log(`[heartbeat] stream opened for ${actualModel}, firing first HB immediately`);
        emitHeartbeat();
        heartbeatTimer = setInterval(emitHeartbeat, HEARTBEAT_MS);
        pipeUpstream();
      },
      cancel(reason) {
        streamCancelled = true;
        clearHB();
        console.log(`[heartbeat] stream CANCELLED after ${hbCount} HBs, reason:`, reason);
      },
    });

    return new Response(stream, { status: 200, headers: sseHeaders });
  }

  // ---- Standard (non-heartbeat) streaming path ----

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    console.error(
      `[upstream:${actualProvider.name}] ${upstream.status} (stream) body=${text.slice(0, 800)}`,
    );
    finalize(upstream.status, text.slice(0, 500));
    return new Response(text || "Upstream error", {
      status: upstream.status,
      headers: {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";
      let recorded = false;
      const recordOnce = (status: number, err: string | null) => {
        if (recorded) return;
        recorded = true;
        finalize(status, err);
      };

      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const rewritten = rewriteSseEvent(
              rawEvent, requestedModel, usage, captured,
            );
            controller.enqueue(encoder.encode(rewritten + "\n\n"));
          }
        }
        if (buffer.length > 0) {
          controller.enqueue(encoder.encode(
            rewriteSseEvent(buffer, requestedModel, usage, captured),
          ));
        }
        finalizeCost(actualProvider.name, actualModel, usage);
        recordOnce(200, null);
      } catch (err) {
        console.error("[stream] error:", err);
        recordOnce(500, String(err));
        controller.error(err);
        return;
      }
      controller.close();
    },
    cancel(reason) {
      if (log) console.log("[stream] cancelled:", reason);
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders });
});

/**
 * Rewrite the `model` field of an SSE event's JSON payload so the client
 * sees the alias it requested instead of the underlying OpenRouter id,
 * extract any `usage` block we encounter (OpenRouter sends one in the
 * final chunk when `usage.include` is set), and accumulate the assistant's
 * delta text + tool-call arguments into `captured.responseText` for the
 * async quality judge.
 */
function rewriteSseEvent(
  rawEvent: string,
  requestedModel: string,
  usageOut: CapturedUsage,
  captured?: { responseText: string },
): string {
  if (!rawEvent.includes("data:")) return rawEvent;
  const lines = rawEvent.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      out.push(line);
      continue;
    }
    const payload = line.slice(5).trimStart();
    if (payload === "[DONE]" || payload === "") {
      out.push(line);
      continue;
    }
    try {
      const obj = JSON.parse(payload);
      if (obj && typeof obj === "object") {
        if (obj.usage) mergeUsage(usageOut, obj.usage);
        let mutated = false;
        const choices = (obj as { choices?: unknown }).choices;
        if (Array.isArray(choices)) {
          for (const ch of choices) {
            const choice = ch as { delta?: Record<string, unknown> } | null;
            const delta = choice?.delta;
            if (delta && typeof delta === "object") {
              // Strip reasoning fields but KEEP forwarding the chunk.
              // Cursor sees "gpt-4.1" and doesn't understand reasoning
              // fields — it only watches `content`. We strip to save
              // bandwidth but keep the chunk (with content:"") flowing
              // so Cursor sees continuous SSE data events.
              if (STRIP_REASONING) {
                if (stripReasoningInPlace(delta)) mutated = true;
              }
              if (captured) {
                const c = delta.content;
                if (typeof c === "string") captured.responseText += c;
                const tcs = delta.tool_calls;
                if (Array.isArray(tcs)) {
                  for (const tc of tcs as Array<{
                    function?: { name?: unknown; arguments?: unknown };
                  }>) {
                    const fn = tc?.function;
                    if (fn) {
                      if (typeof fn.name === "string" && fn.name) {
                        captured.responseText += `\n[tool_call ${fn.name}]`;
                      }
                      if (typeof fn.arguments === "string") {
                        captured.responseText += fn.arguments;
                      }
                    }
                  }
                }
              }
            }
          }
        }
        if ("model" in obj) {
          obj.model = requestedModel;
          mutated = true;
        }
        if (mutated) {
          out.push(`data: ${JSON.stringify(obj)}`);
          continue;
        }
      }
    } catch {
      // fall through, emit unchanged
    }
    out.push(line);
  }
  return out.join("\n");
}

/* ---------- start ---------- */

const port = Number(PORT ?? 8787);
serve({ fetch: app.fetch, port }, ({ port }) => {
  console.log(`router listening on :${port}`);
});
