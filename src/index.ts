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
import { DEFAULT_CONFIG as CLASSIFIER_CFG, maybeUpgradeWithLLM } from "./llm-classifier.js";
import { computeCost } from "./pricing.js";
import { loadProviders, type Provider } from "./providers.js";
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
function normaliseBody(
  body: Record<string, unknown>,
): { body: Record<string, unknown>; adapted: string[] } {
  const adapted: string[] = [];
  const messagesPresent =
    Array.isArray(body.messages) && (body.messages as unknown[]).length > 0;
  if (messagesPresent) return { body, adapted };

  const messages: Array<{ role: string; content: string }> = [];

  // Responses API: top-level `instructions` becomes a system message.
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    messages.push({ role: "system", content: body.instructions });
    adapted.push("instructions");
  }
  // Some clients use `system` directly.
  if (typeof body.system === "string" && body.system.length > 0) {
    messages.push({ role: "system", content: body.system });
    adapted.push("system");
  }

  // Responses API: `input` may be a string or an array of typed parts.
  if (typeof body.input === "string" && body.input.length > 0) {
    messages.push({ role: "user", content: body.input });
    adapted.push("input");
  } else if (Array.isArray(body.input)) {
    const text = (body.input as Array<Record<string, unknown>>)
      .map((p) =>
        typeof p?.text === "string"
          ? p.text
          : typeof p?.content === "string"
            ? p.content
            : "",
      )
      .filter(Boolean)
      .join("\n");
    if (text) {
      messages.push({ role: "user", content: text });
      adapted.push("input[]");
    }
  }

  // Legacy completions: `prompt` is a plain string.
  if (typeof body.prompt === "string" && body.prompt.length > 0) {
    messages.push({ role: "user", content: body.prompt });
    adapted.push("prompt");
  }

  if (messages.length > 0) {
    const out: Record<string, unknown> = { ...body, messages };
    delete out.input;
    delete out.instructions;
    delete out.system;
    delete out.prompt;
    return { body: out, adapted };
  }
  return { body, adapted };
}

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
  if (log && adapted.length > 0) {
    console.log(`[normalise] adapted fields: ${adapted.join(", ")} -> messages`);
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

  if (log) {
    console.log(
      `[route] requested="${requestedModel}" -> ${decision.provider}:${decision.model} ` +
        `(${decision.tier}; ${decision.reason}) ` +
        `project=${project ?? "-"} work_type=${workType} stream=${isStream}`,
    );
  }

  /**
   * Headers we NEVER forward from the client to upstream — anything that
   * would either be wrong (Host, Content-Length), a duplicate of what we
   * set ourselves (Authorization, Content-Type), a transport concern
   * (Connection, Transfer-Encoding, Accept-Encoding), or part of our own
   * namespace (X-Router-*).
   */
  const STRIPPED = new Set([
    "authorization",
    "host",
    "content-length",
    "content-type",
    "cookie",
    "set-cookie",
    "connection",
    "transfer-encoding",
    "accept-encoding",
  ]);

  /**
   * Build the request to send upstream for a given (provider, model) pair.
   * We deliberately forward most client headers (User-Agent, OpenAI-Beta,
   * X-Stainless-*, etc.) so upstream can apply the same client-aware
   * compatibility behaviour it does when the client talks to it directly
   * — without those headers, e.g. OpenRouter's adapter for Xiaomi/MiMo
   * doesn't translate OpenAI-shaped tool definitions, and Xiaomi rejects
   * the request with "Param Incorrect, param: function is not set".
   */
  const buildUpstreamRequest = (
    p: typeof provider,
    model: string,
  ): { url: string; init: RequestInit } => {
    let payload: IncomingRequest = { ...body, model };
    if (p.injectUsageInclude) payload = withUsageIncluded(payload);

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (STRIPPED.has(lower)) return;
      if (lower.startsWith("x-router-")) return;
      headers[name] = value;
    });
    // Our overrides go last so they win over anything the client sent.
    headers["content-type"] = "application/json";
    headers["authorization"] = `Bearer ${p.apiKey}`;
    for (const [k, v] of Object.entries(p.extraHeaders)) headers[k] = v;

    return {
      url: `${p.baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
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

  /** Single place that writes the call to the DB. The classifier's own
   *  cost is folded into cost_usd so the dashboard reflects total spend. */
  const finalize = (status: number, error: string | null) => {
    try {
      recordCall({
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
    } catch (err) {
      console.error("[db] failed to record call:", err);
    }
  };

  /**
   * Try the routed (provider, model). If upstream returns a non-OK status
   * AND we weren't already on the code tier (Sonnet), retry once on
   * Sonnet — it's the most reliable target for OpenAI-shaped tool calls.
   *
   * Before the primary call we also consult a tiny in-process circuit
   * breaker (`src/breaker.ts`): if the primary model has tripped recently,
   * we skip it entirely and go straight to the fallback, so a flapping
   * upstream doesn't pile up 5xx responses that trip Cursor's BYOK proxy
   * rate-limiter.
   *
   * Returns the (final) Response, with body never consumed.
   */
  const callUpstreamWithFallback = async (): Promise<Response> => {
    const fallbackEntry = MODELS.code;
    const fallbackProvider = PROVIDERS[fallbackEntry.provider];
    const tryFallback = async (
      reasonForFallback: string,
    ): Promise<Response> => {
      const fb = buildUpstreamRequest(fallbackProvider, fallbackEntry.model);
      let fbResp: Response;
      try {
        fbResp = await fetch(fb.url, fb.init);
      } catch (err) {
        console.error(`[upstream:${fallbackProvider.name}] fallback fetch failed:`, err);
        breaker.record(fallbackEntry.model, false);
        throw err;
      }
      actualProvider = fallbackProvider;
      actualModel = fallbackEntry.model;
      actualTier = "code";
      fellBackTo = `${fallbackProvider.name}:${fallbackEntry.model} (${reasonForFallback})`;
      breaker.record(fallbackEntry.model, fbResp.ok);
      return fbResp;
    };

    // 0. Breaker open on primary -> skip it and go straight to fallback.
    if (
      decision.tier !== "code" &&
      decision.model !== fallbackEntry.model &&
      breaker.isOpen(decision.model)
    ) {
      console.warn(
        `[breaker-open] skipping ${provider.name}:${decision.model}, ` +
          `going straight to ${fallbackProvider.name}:${fallbackEntry.model}`,
      );
      return tryFallback("breaker-open");
    }

    // 1. Try the primary.
    const primary = buildUpstreamRequest(provider, decision.model);
    let resp: Response;
    try {
      resp = await fetch(primary.url, primary.init);
    } catch (err) {
      console.error(`[upstream:${provider.name}] fetch failed:`, err);
      breaker.record(decision.model, false);
      throw err;
    }
    breaker.record(decision.model, resp.ok);
    // Don't retry the code tier itself, and don't retry on success.
    if (resp.ok || decision.tier === "code") return resp;

    // 2. Primary failed -> snapshot error body, retry on Sonnet.
    let primaryBody = "";
    try { primaryBody = await resp.text(); } catch { /* ignore */ }
    console.warn(
      `[fallback] ${provider.name}:${decision.model} -> ${resp.status} ` +
        `body=${primaryBody.slice(0, 400)} ; retrying on code tier (Sonnet)`,
    );
    let fallbackResp: Response;
    try {
      fallbackResp = await tryFallback(`primary-${resp.status}`);
    } catch {
      // Network error on fallback — surface the primary error.
      return new Response(primaryBody, { status: resp.status, headers: resp.headers });
    }
    if (fallbackResp.ok) return fallbackResp;
    // Both failed. Surface the fallback's error since it's the more recent;
    // log a structured one-liner for debugging both legs in one place.
    let fallbackBodyPreview = "";
    try {
      fallbackBodyPreview = (await fallbackResp.clone().text()).slice(0, 400);
    } catch { /* ignore */ }
    console.warn(
      `[fallback-failed] both legs failed: ` +
        `primary=${provider.name}:${decision.model}(${resp.status}) ` +
        `fallback=${fallbackProvider.name}:${fallbackEntry.model}(${fallbackResp.status}) ` +
        `primary_body=${primaryBody.slice(0, 200)} ` +
        `fallback_body=${fallbackBodyPreview}`,
    );
    return fallbackResp;
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
        json.model = requestedModel;
        if (!json._router) {
          json._router = {
            requested: requestedModel,
            provider: actualProvider.name,
            routed_to: actualModel,
            tier: actualTier,
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

  const headers = new Headers({
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

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
            const rewritten = rewriteSseEvent(rawEvent, requestedModel, usage);
            controller.enqueue(encoder.encode(rewritten + "\n\n"));
          }
        }
        if (buffer.length > 0) {
          const rewritten = rewriteSseEvent(buffer, requestedModel, usage);
          controller.enqueue(encoder.encode(rewritten));
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

  return new Response(stream, { status: 200, headers });
});

/**
 * Rewrite the `model` field of an SSE event's JSON payload so the client
 * sees the alias it requested instead of the underlying OpenRouter id, and
 * extract any `usage` block we encounter (OpenRouter sends one in the final
 * chunk when `usage.include` is set).
 */
function rewriteSseEvent(
  rawEvent: string,
  requestedModel: string,
  usageOut: CapturedUsage,
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
        if ("model" in obj) {
          obj.model = requestedModel;
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
