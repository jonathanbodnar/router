import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  parseModelProjectTag,
  resolveProject,
  resolveWorkType,
} from "./classify.js";
import { mountDashboard } from "./dashboard.js";
import { recordCall } from "./db.js";
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

  const body = normalisedBody as IncomingRequest;

  const decision = route(body);
  const provider = PROVIDERS[decision.provider];
  const requestedModel = (body.model ?? "auto").toString();
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

  let upstreamBody: IncomingRequest = { ...body, model: decision.model };
  if (provider.injectUsageInclude) {
    upstreamBody = withUsageIncluded(upstreamBody);
  }

  const upstreamHeaders: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${provider.apiKey}`,
    ...provider.extraHeaders,
  };

  const usage = emptyUsage();

  /** Single place that writes the call to the DB. */
  const finalize = (status: number, error: string | null) => {
    try {
      recordCall({
        ts: Math.floor(startedAt / 1000),
        requested_model: requestedModel,
        routed_model: decision.model,
        tier: decision.tier,
        project,
        work_type: workType,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        total_tokens: usage.total_tokens,
        cost_usd: usage.cost_usd,
        duration_ms: Date.now() - startedAt,
        status,
        stream: isStream,
        error,
      });
    } catch (err) {
      console.error("[db] failed to record call:", err);
    }
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders,
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    console.error(`[upstream:${provider.name}] fetch failed:`, err);
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

  /* ---------- non-streaming ---------- */

  if (!isStream) {
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error(
        `[upstream:${provider.name}] ${upstream.status} body=${text.slice(0, 800)}`,
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
        finalizeCost(decision.provider, decision.model, usage);
        json.model = requestedModel;
        if (!json._router) {
          json._router = {
            requested: requestedModel,
            provider: decision.provider,
            routed_to: decision.model,
            tier: decision.tier,
            reason: decision.reason,
            project,
            work_type: workType,
          };
        }
      }
      finalize(upstream.status, null);
      return c.json(json, upstream.status as 200);
    } catch {
      finalizeCost(decision.provider, decision.model, usage);
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
      `[upstream:${provider.name}] ${upstream.status} (stream) body=${text.slice(0, 800)}`,
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
        finalizeCost(decision.provider, decision.model, usage);
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
