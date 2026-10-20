#!/usr/bin/env node
/**
 * OpenAI- and Anthropic-compatible local proxy for OpenCode Zen models.
 *
 * Start it from this directory, then point your OpenAI or Anthropic client at
 * http://127.0.0.1:8787/v1:
 *
 *   node opencode-zen-proxy.mjs
 *
 * The Zen free tier currently checks more than request headers. It expects an
 * OpenCode-shaped User-Agent, a valid `ses_...` session, a streaming request,
 * and a function tool named `read`. This proxy adds those compatibility
 * markers. It passes SSE through for streaming clients and aggregates SSE into
 * a normal response for non-streaming clients. `/v1/responses` and
 * `/v1/messages` are supported with their native wire formats.
 *
 * Environment:
 *   PORT                         listen port (default 8787)
 *   HOST                         listen host (default 127.0.0.1)
 *   OPENCODE_ZEN_BASE_URL        upstream base URL (default https://opencode.ai/zen/v1)
 *   OPENCODE_PROXY_UA            User-Agent override
 *   OPENCODE_PROXY_SESSION       fixed `ses_...` session override
 *   OPENCODE_PROXY_PROJECT       fixed 32-hex project override
 *   OPENCODE_PROXY_AUTH          upstream bearer value (default `public`)
 *   OPENCODE_PROXY_PASSTHROUGH_AUTH
 *                                forward the caller's Authorization when set to `1`
 *   OPENCODE_PROXY_RESPONSES_MODE
 *                                `auto` (default), `chat`, or `native`
 *   OPENCODE_PROXY_ANTHROPIC_MODE
 *                                `auto` (default), `chat`, or `native`
 */

import http from "node:http"
import { createHash, randomBytes } from "node:crypto"
import { gunzipSync, gzipSync } from "node:zlib"

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const CONFIGURED_PORT = Number(process.env.PORT ?? 8787)
const PORT = Number.isInteger(CONFIGURED_PORT) && CONFIGURED_PORT >= 0 ? CONFIGURED_PORT : 8787
const CONFIGURED_ATTEMPTS = Number(process.env.PORT_ATTEMPTS ?? 20)
const PORT_ATTEMPTS = Number.isFinite(CONFIGURED_ATTEMPTS) ? Math.max(1, Math.floor(CONFIGURED_ATTEMPTS)) : 20
const HOST = process.env.HOST ?? "127.0.0.1"
const UPSTREAM = (process.env.OPENCODE_ZEN_BASE_URL ?? "https://opencode.ai/zen/v1").replace(/\/+$/, "")
const USER_AGENT = process.env.OPENCODE_PROXY_UA ?? "opencode/latest/2.0.32/cli"
const SESSION = process.env.OPENCODE_PROXY_SESSION ?? createSessionID()
const PROJECT = process.env.OPENCODE_PROXY_PROJECT ?? randomBytes(16).toString("hex")
const AUTH = process.env.OPENCODE_PROXY_AUTH
const PASSTHROUGH_AUTH = process.env.OPENCODE_PROXY_PASSTHROUGH_AUTH === "1"
const RESPONSES_MODE = process.env.OPENCODE_PROXY_RESPONSES_MODE ?? "auto"
const ANTHROPIC_MODE = process.env.OPENCODE_PROXY_ANTHROPIC_MODE ?? "auto"
const MAX_BODY_BYTES = 64 * 1024 * 1024
const REASONING_PREFIX = "zen1:"
const FIXED_SESSION = process.env.OPENCODE_PROXY_SESSION

const LOG_TIME_ZONE = process.env.LOG_TIME_ZONE ?? "Asia/Hong_Kong"
const LOG_TIME_FORMAT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: LOG_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
})

function logTimestamp() {
  return LOG_TIME_FORMAT.format(new Date()).replace(",", ".")
}

function logLine(level, message) {
  const line = `[${logTimestamp()}] [zen-proxy] ${message}`
  if (level === "error") console.error(line)
  else if (level === "warn") console.warn(line)
  else console.log(line)
}

function logInfo(message) {
  logLine("log", message)
}

function logWarn(message) {
  logLine("warn", message)
}

function logError(message) {
  logLine("error", message)
}

function createRequestStats(protocol, model, stream) {
  return {
    protocol,
    model: String(model ?? "unknown"),
    stream,
    startedAt: Date.now(),
    firstOutputAt: null,
    lastOutputAt: null,
    status: null,
    usage: null,
    error: null,
  }
}

function markOutput(stats) {
  if (!stats) return
  const now = Date.now()
  if (stats.firstOutputAt === null) stats.firstOutputAt = now
  stats.lastOutputAt = now
}

function usageSnapshot(usage) {
  if (!usage) return undefined
  const input = usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0
  const output = usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0
  return {
    input,
    output,
    total: usage.totalTokens ?? usage.total_tokens ?? input + output,
    cached:
      usage.inputTokenDetails?.cacheReadTokens ??
      usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.cache_read_input_tokens ??
      0,
    reasoning:
      usage.outputTokenDetails?.reasoningTokens ??
      usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      0,
  }
}

function formatDuration(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

function logRequest(stats) {
  const elapsedMs = Math.max(0, Date.now() - stats.startedAt)
  const usage = usageSnapshot(stats.usage)
  const tokens = usage
    ? `tokens=${usage.input}/${usage.output}/${usage.total} cached=${usage.cached} reasoning=${usage.reasoning}`
    : "tokens=unknown"
  const ttftMs = stats.firstOutputAt === null ? null : Math.max(0, stats.firstOutputAt - stats.startedAt)
  const generationMs =
    stats.firstOutputAt === null || stats.lastOutputAt === null
      ? null
      : Math.max(0, stats.lastOutputAt - stats.firstOutputAt)
  // Token speed uses the observed generation window; total latency includes queueing and TTFT.
  const speedWindowMs = generationMs !== null && generationMs > 0 ? generationMs : elapsedMs
  const speed = usage && usage.output > 0 && speedWindowMs > 0
    ? (usage.output / (speedWindowMs / 1000)).toFixed(1)
    : "0.0"
  const ttft = ttftMs === null ? "" : ` ttft=${formatDuration(ttftMs)}`
  const generation = generationMs !== null && generationMs > 0 ? ` gen=${formatDuration(generationMs)}` : ""
  const status = stats.status ? `${stats.status} ` : ""
  const errorText =
    stats.error && typeof stats.error === "object"
      ? (stats.error.message ?? JSON.stringify(stats.error))
      : stats.error
  const error = errorText ? ` error=${String(errorText).slice(0, 200)}` : ""
  logLine(
    stats.error ? "error" : "log",
    `${status}${stats.protocol} model=${stats.model} stream=${stats.stream} ${tokens} elapsed=${formatDuration(elapsedMs)}${ttft}${generation} speed=${speed}tok/s${error}`,
  )
}

// The free-tier gate checks for a tool named `read`. This minimal definition is
// enough; tools already supplied by the caller are preserved.
const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description:
      "Compatibility marker only. Do not call this tool; use the caller's own tools for reading files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File or directory to read",
        },
      },
      required: ["path"],
    },
  },
}

const RESPONSES_READ_TOOL = {
  type: "function",
  name: "read",
  description:
    "Compatibility marker only. Do not call this tool; use the caller's own tools for reading files.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File or directory to read",
      },
    },
    required: ["path"],
  },
}

function handleRequest(request, response) {
  handle(request, response).catch((error) => {
    if (error?.name === "AbortError" || (error instanceof Error && error.message.includes("aborted"))) return
    logError(error instanceof Error ? error.message : String(error))
    const status = typeof error?.status === "number" ? error.status : 500
    if (!response.headersSent) {
      const target = String(request.url ?? "")
      return json(
        response,
        status,
        target.endsWith("/messages") ? anthropicUpstreamError(error instanceof Error ? error.message : String(error)) : proxyError(error),
      )
    }
    response.end()
  })
}

startServer()

function startServer(attempt = 0) {
  const port = PORT === 0 ? 0 : PORT + attempt
  const server = http.createServer(handleRequest)
  const onListenError = (error) => {
    const canRetry =
      error?.code === "EADDRINUSE" &&
      PORT !== 0 &&
      attempt + 1 < PORT_ATTEMPTS &&
      PORT + attempt + 1 <= 65535
    if (canRetry) {
      logWarn(`port ${port} is in use, trying ${PORT + attempt + 1}`)
      setImmediate(() => startServer(attempt + 1))
      return
    }
    logError(`failed to listen on ${HOST}:${port}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
  server.once("error", onListenError)
  server.listen(port, HOST, () => {
    server.off("error", onListenError)
    server.on("error", (error) => {
      logError(`server error: ${error instanceof Error ? error.message : String(error)}`)
    })
    const address = server.address()
    const actualPort = typeof address === "object" && address ? address.port : port
    logInfo(`listening on http://${HOST}:${actualPort}/v1`)
    logInfo(`upstream ${UPSTREAM}`)
    logInfo(`session ${SESSION}`)
    logInfo(`project ${PROJECT}`)
  })
}

async function handle(request, response) {
  setCors(response)
  if (request.method === "OPTIONS") {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
  if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz")) {
    json(response, 200, { ok: true, upstream: UPSTREAM, session: SESSION, project: PROJECT })
    return
  }

  if (request.method === "GET" && url.pathname.endsWith("/models") && !url.pathname.includes("/models/")) {
    await proxyModels(response)
    return
  }

  if (request.method === "POST" && url.pathname.endsWith("/responses")) {
    await proxyResponses(request, response)
    return
  }

  if (request.method === "POST" && url.pathname.endsWith("/messages")) {
    await proxyAnthropic(request, response)
    return
  }

  if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    json(response, 404, {
      error: {
        type: "not_found",
        message: "Use /v1/chat/completions, /v1/responses, /v1/messages or /v1/models",
      },
    })
    return
  }

  await proxyChat(request, response)
}

async function proxyModels(response) {
  const upstream = await fetch(`${UPSTREAM}/models`, {
    headers: {
      accept: "application/json",
      "accept-encoding": "identity",
      "user-agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(10000),
  })
  const body = await upstream.text()
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/json",
    "cache-control": "no-store",
  })
  response.end(body)
}

async function proxyChat(request, response) {
  const raw = await readBody(request)
  const input = parseBody(raw)
  if (!input) {
    json(response, 400, { error: { type: "invalid_request", message: "Request body must be a JSON object" } })
    return
  }
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    json(response, 400, { error: { type: "invalid_request", message: "model is required" } })
    return
  }
  if (!Array.isArray(input.messages)) {
    json(response, 400, { error: { type: "invalid_request", message: "messages must be an array" } })
    return
  }

  const wantsStream = input.stream === true
  const rewritten = rewriteBody(input, wantsStream)
  const body = rewritten.body
  const session = requestSession(request.headers, input)
  const stats = createRequestStats("chat", input.model, wantsStream)
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(request.headers, wantsStream, session),
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      stats.error = "aborted"
      logRequest(stats)
      response.end()
      return
    }
    stats.error = upstream.error instanceof Error ? upstream.error.message : String(upstream.error)
    logRequest(stats)
    json(response, 502, proxyError(upstream.error))
    return
  }

  stats.status = upstream.status
  if (!upstream.ok) {
    const text = await upstream.text()
    const error = readUpstreamError(text)
    stats.error = error.message
    logRequest(stats)
    json(response, upstream.status, { error })
    return
  }

  const contentType = upstream.headers.get("content-type") ?? ""
  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const result = await pipeChatStream(upstream, response, rewritten.injectedRead, stats)
    stats.usage = result?.usage
    stats.error = result?.error
    logRequest(stats)
    return
  }

  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const text = await upstream.text()
    const chat = parseBody(text)
    if (chat) {
      if (chat.error) {
        const error = readUpstreamError(text)
        stats.error = error.message
        logRequest(stats)
        json(response, 502, { error })
        return
      }
      for (const choice of chat.choices ?? []) {
        const message = choice?.message
        if (!message) continue
        if (typeof message.content === "string") message.content = stripThinkControl(message.content)
        if (typeof message.reasoning_content === "string") {
          message.reasoning_content = stripThinkControl(message.reasoning_content)
        }
        if (rewritten.injectedRead && Array.isArray(message.tool_calls)) {
          message.tool_calls = message.tool_calls.filter((call) => call.function?.name !== "read")
        }
      }
      stats.usage = chat.usage
      logRequest(stats)
      json(response, 200, chat)
      return
    }
    stats.error = "Upstream returned a non-JSON response"
    logRequest(stats)
    response.writeHead(200, {
      "content-type": contentType || "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  try {
    const chat = await aggregate(upstream, rewritten.injectedRead, stats)
    stats.usage = chat.usage
    logRequest(stats)
    json(response, 200, chat)
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error)
    logRequest(stats)
    throw error
  }
}

async function proxyResponses(request, response) {
  const raw = await readBody(request)
  const input = parseBody(raw)
  if (!input) {
    json(response, 400, { error: { type: "invalid_request", message: "Request body must be a JSON object" } })
    return
  }
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    json(response, 400, { error: { type: "invalid_request", message: "model is required" } })
    return
  }
  if (typeof input.input !== "string" && !Array.isArray(input.input)) {
    json(response, 400, { error: { type: "invalid_request", message: "input must be a string or an array" } })
    return
  }

  if (responsesMode(input.model) === "chat") {
    await proxyResponsesViaChat(request, response, input)
    return
  }

  const result = await proxyNativeResponses(request, response, input)
  if (result === "fallback") await proxyResponsesViaChat(request, response, input)
}

async function proxyNativeResponses(request, response, input) {
  const wantsStream = input.stream === true
  const body = rewriteResponsesBody(input)
  const session = requestSession(request.headers, input)
  const stats = createRequestStats("responses-native", input.model, wantsStream)
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${UPSTREAM}/responses`, {
    method: "POST",
    headers: buildHeaders(request.headers, wantsStream, session),
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      stats.error = "aborted"
      logRequest(stats)
      response.end()
      return
    }
    stats.error = upstream.error instanceof Error ? upstream.error.message : String(upstream.error)
    logRequest(stats)
    json(response, 502, proxyError(upstream.error))
    return
  }

  stats.status = upstream.status
  if (!upstream.ok) {
    const text = await upstream.text()
    if (RESPONSES_MODE === "auto" && upstream.status === 400 && isModelProtocolUnsupported(text)) {
      stats.error = "native responses unsupported; falling back"
      logRequest(stats)
      return "fallback"
    }
    const error = readUpstreamError(text)
    stats.error = error.message
    logRequest(stats)
    json(response, upstream.status, { error })
    return
  }

  const contentType = upstream.headers.get("content-type") ?? ""
  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const result = await pipeBody(upstream, response, stats)
    stats.usage = result?.usage
    stats.error = result?.error
    logRequest(stats)
    return
  }

  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const text = await upstream.text()
    const parsed = parseBody(text)
    stats.usage = parsed?.usage
    if (parsed?.error) stats.error = readUpstreamError(text).message
    logRequest(stats)
    response.writeHead(200, {
      "content-type": contentType || "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  try {
    const result = await aggregateResponses(upstream, stats)
    stats.usage = result.usage
    if (result.status === "failed") {
      stats.error = result.error?.message ?? "Upstream response failed"
    }
    logRequest(stats)
    json(response, 200, result)
    return "done"
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error)
    logRequest(stats)
    throw error
  }
}

async function proxyResponsesViaChat(request, response, input) {
  const wantsStream = input.stream === true
  const converted = responsesToChat(input)
  const rewritten = rewriteBody(converted.body, wantsStream)
  const body = rewritten.body
  const session = requestSession(request.headers, input)
  const stats = createRequestStats("responses", input.model, wantsStream)
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(request.headers, wantsStream, session),
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      stats.error = "aborted"
      logRequest(stats)
      response.end()
      return
    }
    stats.error = upstream.error instanceof Error ? upstream.error.message : String(upstream.error)
    logRequest(stats)
    json(response, 502, proxyError(upstream.error))
    return
  }

  stats.status = upstream.status
  if (!upstream.ok) {
    const text = await upstream.text()
    const error = readUpstreamError(text)
    stats.error = error.message
    logRequest(stats)
    json(response, upstream.status, { error })
    return
  }

  const contentType = upstream.headers.get("content-type") ?? ""
  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const result = await translateChatStream(
      upstream,
      response,
      input.model,
      converted.registry,
      rewritten.injectedRead,
      stats,
    )
    stats.usage = result?.usage
    stats.error = result?.error
    logRequest(stats)
    return
  }

  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const text = await upstream.text()
    const chat = parseBody(text)
    if (chat) {
      if (chat.error) {
        const error = readUpstreamError(text)
        stats.error = error.message
        logRequest(stats)
        json(response, 502, { error })
        return
      }
      const translated = chatToResponse(chat, input.model, converted.registry, rewritten.injectedRead)
      stats.usage = translated.usage
      logRequest(stats)
      json(response, 200, translated)
      return
    }
    stats.error = "Upstream returned a non-JSON response"
    logRequest(stats)
    response.writeHead(200, {
      "content-type": contentType || "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  try {
    const translated = chatToResponse(
      await aggregate(upstream, rewritten.injectedRead, stats),
      input.model,
      converted.registry,
      rewritten.injectedRead,
    )
    stats.usage = translated.usage
    logRequest(stats)
    json(response, 200, translated)
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error)
    logRequest(stats)
    throw error
  }
}

async function proxyAnthropic(request, response) {
  const raw = await readBody(request)
  const input = parseBody(raw)
  if (!input) {
    json(response, 400, { error: { type: "invalid_request", message: "Request body must be a JSON object" } })
    return
  }
  if (typeof input.model !== "string" || input.model.trim().length === 0) {
    json(response, 400, { error: { type: "invalid_request", message: "model is required" } })
    return
  }
  if (!Array.isArray(input.messages)) {
    json(response, 400, { error: { type: "invalid_request", message: "messages must be an array" } })
    return
  }

  if (anthropicMode(input.model) === "chat") {
    await proxyAnthropicViaChat(request, response, input)
    return
  }

  const result = await proxyNativeAnthropic(request, response, input)
  if (result === "fallback") await proxyAnthropicViaChat(request, response, input)
}

async function proxyNativeAnthropic(request, response, input) {
  const wantsStream = input.stream === true
  const session = requestSession(request.headers, input)
  const stats = createRequestStats("messages-native", input.model, wantsStream)
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${UPSTREAM}/messages`, {
    method: "POST",
    headers: buildAnthropicHeaders(request.headers, wantsStream, session),
    body: JSON.stringify(input),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      stats.error = "aborted"
      logRequest(stats)
      response.end()
      return
    }
    stats.error = upstream.error instanceof Error ? upstream.error.message : String(upstream.error)
    logRequest(stats)
    json(
      response,
      502,
      anthropicUpstreamError(upstream.error instanceof Error ? upstream.error.message : String(upstream.error)),
    )
    return
  }

  stats.status = upstream.status
  if (!upstream.ok) {
    const text = await upstream.text()
    if (ANTHROPIC_MODE === "auto" && upstream.status === 400 && isModelProtocolUnsupported(text)) {
      stats.error = "native messages unsupported; falling back"
      logRequest(stats)
      return "fallback"
    }
    stats.error = readUpstreamError(text).message
    logRequest(stats)
    json(response, upstream.status, anthropicUpstreamError(text))
    return "done"
  }

  const contentType = upstream.headers.get("content-type") ?? ""
  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const result = await pipeBody(upstream, response, stats)
    stats.usage = result?.usage
    stats.error = result?.error
    logRequest(stats)
    return "done"
  }

  const text = await upstream.text()
  const parsed = parseBody(text)
  stats.usage = parsed?.usage
  if (parsed?.error) stats.error = readUpstreamError(text).message
  logRequest(stats)
  response.writeHead(200, {
    "content-type": contentType || "application/json",
    "cache-control": "no-store",
  })
  response.end(text)
  return "done"
}

async function proxyAnthropicViaChat(request, response, input) {
  const wantsStream = input.stream === true
  const converted = anthropicToChat(input)
  const rewritten = rewriteBody(converted.body, wantsStream)
  const body = rewritten.body
  const session = requestSession(request.headers, input)
  const stats = createRequestStats("anthropic", input.model, wantsStream)
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(request.headers, wantsStream, session),
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      stats.error = "aborted"
      logRequest(stats)
      response.end()
      return
    }
    stats.error = upstream.error instanceof Error ? upstream.error.message : String(upstream.error)
    logRequest(stats)
    json(
      response,
      502,
      anthropicUpstreamError(upstream.error instanceof Error ? upstream.error.message : String(upstream.error)),
    )
    return
  }

  stats.status = upstream.status
  if (!upstream.ok) {
    const text = await upstream.text()
    stats.error = readUpstreamError(text).message
    logRequest(stats)
    json(response, upstream.status, anthropicUpstreamError(text))
    return
  }

  const contentType = upstream.headers.get("content-type") ?? ""
  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    const result = await translateChatToAnthropicStream(
      upstream,
      response,
      input.model,
      converted.registry,
      rewritten.injectedRead,
      stats,
    )
    stats.usage = result?.usage
    stats.error = result?.error
    logRequest(stats)
    return
  }

  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const text = await upstream.text()
    const chat = parseBody(text)
    if (chat) {
      if (chat.error) {
        stats.error = readUpstreamError(text).message
        logRequest(stats)
        json(response, 502, anthropicUpstreamError(text))
        return
      }
      const translated = chatToAnthropic(chat, input.model, converted.registry, rewritten.injectedRead)
      stats.usage = translated.usage
      logRequest(stats)
      json(response, 200, translated)
      return
    }
    stats.error = "Upstream returned a non-JSON response"
    logRequest(stats)
    response.writeHead(200, {
      "content-type": contentType || "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  try {
    const translated = chatToAnthropic(
      await aggregate(upstream, rewritten.injectedRead, stats),
      input.model,
      converted.registry,
      rewritten.injectedRead,
    )
    stats.usage = translated.usage
    logRequest(stats)
    json(response, 200, translated)
  } catch (error) {
    stats.error = error instanceof Error ? error.message : String(error)
    logRequest(stats)
    throw error
  }
}

function rewriteBody(input, wantsStream) {
  const source = Array.isArray(input.messages) ? input.messages.map(normalizeChatMessage) : input.messages
  const { messages, effort: directiveEffort } = stripChatDirective(source)
  const hasReasoning =
    (Array.isArray(messages) &&
      messages.some((message) => message?.role === "assistant" && typeof message.reasoning_content === "string")) ||
    knownReasoningModel(input.model)
  const normalized = hasReasoning
    ? messages.map((message) =>
        message?.role === "assistant" && message.reasoning_content === undefined
          ? { ...message, reasoning_content: "" }
          : message,
      )
    : messages
  const body = { ...input, messages: normalized, stream: true }
  const tools = Array.isArray(input.tools) ? [...input.tools] : []
  const hasRead = tools.some((tool) => tool?.function?.name === "read" || tool?.name === "read")
  if (!hasRead) tools.push(READ_TOOL)
  body.tools = tools

  const injectedRead = !hasRead
  if (injectedRead && tools.length > 1 && Array.isArray(normalized)) {
    const warning = {
      role: "system",
      content:
        "The `read` tool is a proxy compatibility marker. Do not call it; use the caller's tools for all work.",
    }
    const index = normalized.findIndex((message) => message?.role !== "system")
    normalized.splice(index === -1 ? normalized.length : index, 0, warning)
  }

  const effort = normalizeChatEffort(input.reasoning_effort ?? input.reasoning?.effort ?? directiveEffort)
  if (effort !== undefined) body.reasoning_effort = effort
  else if (input.reasoning_effort !== undefined) delete body.reasoning_effort

  // If the caller did not ask for tools, prevent the compatibility marker from
  // being selected while still keeping it in the request for the gate.
  if (!wantsStream && body.stream_options === undefined) body.stream_options = { include_usage: true }
  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    if (body.tool_choice === undefined) body.tool_choice = "none"
  }
  return { body, injectedRead }
}

function normalizeChatMessage(message) {
  if (!message || message.role !== "assistant") return message
  if (typeof message.reasoning_content === "string") {
    return { ...message, reasoning_content: stripThinkControl(message.reasoning_content) }
  }
  if (typeof message.reasoning === "string") {
    return { ...message, reasoning_content: stripThinkControl(message.reasoning) }
  }
  if (typeof message.reasoning_text === "string") {
    return { ...message, reasoning_content: stripThinkControl(message.reasoning_text) }
  }
  return message
}

function stripChatDirective(messages) {
  if (!Array.isArray(messages)) return { messages, effort: undefined }
  const lastUserIndex = lastMessageIndex(messages, "user")
  let effort
  const normalized = messages.map((message, index) => {
    if (index !== lastUserIndex || message?.role !== "user") return message
    if (typeof message.content === "string") {
      const text = readThinkDirective(message.content, (value) => (effort = value))
      return { ...message, content: text }
    }
    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: stripThinkFromParts(message.content, (value) => (effort = value)),
      }
    }
    return message
  })
  return { messages: normalized, effort }
}

function knownReasoningModel(model) {
  return (
    typeof model === "string" &&
    /(big-pickle|deepseek|kimi|glm|minimax|mimo|nemotron|longcat|ring-|space-bunny|hy3|step-|north-|x-preview|qwen)/i.test(
      model,
    )
  )
}

function buildChatToolRegistry(tools) {
  const registry = {
    tools: [],
    byName: new Map(),
    byClient: new Map(),
    bySimpleName: new Map(),
  }
  const used = new Set()

  const add = (descriptor) => {
    const base = sanitizeToolName(descriptor.upstreamName) || "tool"
    let name = base
    let suffix = 2
    while (used.has(name)) name = `${base}_${suffix++}`
    used.add(name)
    const entry = { ...descriptor, upstreamName: name }
    registry.tools.push({
      type: "function",
      function: {
        name,
        description: entry.description ?? "",
        parameters: entry.input_schema,
      },
    })
    registry.byName.set(name, entry)
    for (const clientName of entry.clientNames ?? []) registry.byClient.set(clientName, name)
    const simple = registry.bySimpleName.get(entry.name) ?? []
    if (!simple.includes(name)) simple.push(name)
    registry.bySimpleName.set(entry.name, simple)
  }

  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== "object") continue

    if (tool.type === "namespace") {
      const namespace = tool.name
      if (!namespace) continue
      for (const nested of Array.isArray(tool.tools) ? tool.tools : []) {
        if (!nested || typeof nested !== "object") continue
        const description = [tool.description ? `[${namespace}] ${tool.description}` : `[${namespace}]`, nested.description]
          .filter(Boolean)
          .join("\n\n")
        if (nested.type === "custom") {
          add(customToolDescriptor(nested, namespace, description))
          continue
        }
        if (nested.type === "function" && nested.name) {
          add({
            kind: "function",
            name: nested.name,
            namespace,
            upstreamName: `${namespace}__${nested.name}`,
            description,
            input_schema: normalizeInputSchema(nested.parameters),
            clientNames: [`${namespace}__${nested.name}`, `${namespace}.${nested.name}`],
          })
        }
      }
      continue
    }

    if (tool.type === "custom" && tool.name) {
      add(customToolDescriptor(tool))
      continue
    }

    const functionSpec = tool.type === "function" ? tool : tool.type === undefined ? tool : undefined
    if (!functionSpec) continue
    const name = functionSpec.name ?? functionSpec.function?.name
    if (!name) continue
    add({
      kind: "function",
      name,
      namespace: tool.namespace ?? null,
      upstreamName: tool.namespace ? `${tool.namespace}__${name}` : name,
      description: functionSpec.description ?? functionSpec.function?.description ?? "",
      input_schema: normalizeInputSchema(
        functionSpec.parameters ?? functionSpec.function?.parameters ?? functionSpec.input_schema,
      ),
      clientNames: tool.namespace ? [`${tool.namespace}__${name}`, `${tool.namespace}.${name}`] : [name],
    })
  }

  return registry
}

function customToolDescriptor(tool, namespace, description) {
  const prefix = namespace ? `[${namespace}] ` : ""
  const base = description ?? `${prefix}${tool.description ?? ""}`
  return {
    kind: "custom",
    name: tool.name,
    namespace: namespace ?? null,
    upstreamName: namespace ? `${namespace}__${tool.name}` : tool.name,
    description: `${base}\n\nThe function-calling API requires a JSON object, but the "input" field itself is the exact freeform text. Put the complete raw input there without escaping, quoting, or JSON-encoding that value.`,
    input_schema: {
      type: "object",
      properties: {
        input: { type: "string", description: "The complete raw tool input." },
      },
      required: ["input"],
      additionalProperties: false,
    },
    clientNames: namespace ? [`${namespace}__${tool.name}`, `${namespace}.${tool.name}`] : [tool.name],
  }
}

function normalizeInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} }
  }
  return {
    ...schema,
    type: "object",
    properties: schema.properties ?? {},
    ...(Array.isArray(schema.required) ? { required: schema.required } : {}),
  }
}

function sanitizeToolName(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
}

function resolveToolName(registry, name, namespace) {
  const raw = String(name ?? "")
  if (namespace) {
    const qualified = registry.byClient.get(`${namespace}__${raw}`) ?? registry.byClient.get(`${namespace}.${raw}`)
    if (qualified) return qualified
  }
  const direct = registry.byClient.get(raw)
  if (direct) return direct
  const simple = registry.bySimpleName.get(raw)
  if (simple?.length === 1) return simple[0]
  return sanitizeToolName(raw)
}

function customToolInput(value) {
  if (typeof value === "string") return value
  if (value && typeof value === "object") {
    if (typeof value.input === "string") return value.input
    if (typeof value.patch === "string") return value.patch
    if (typeof value.content === "string") return value.content
    const strings = Object.values(value).filter((entry) => typeof entry === "string")
    if (strings.length === 1) return strings[0]
  }
  return JSON.stringify(value ?? "")
}

function reasoningTextFromItem(item) {
  const content = []
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (part?.type === "reasoning_text" && typeof part.text === "string") content.push(part.text)
  }
  if (content.length > 0) return content.join("")
  const summary = []
  for (const part of Array.isArray(item.summary) ? item.summary : []) {
    if (part?.type === "summary_text" && typeof part.text === "string") summary.push(part.text)
  }
  if (summary.length > 0) return summary.join("")
  return typeof item.text === "string" ? item.text : ""
}

function encodeReasoning(text) {
  if (!text) return undefined
  return REASONING_PREFIX + gzipSync(Buffer.from(text, "utf8")).toString("base64url")
}

function decodeReasoning(value) {
  if (typeof value !== "string" || !value.startsWith(REASONING_PREFIX)) return undefined
  try {
    return gunzipSync(Buffer.from(value.slice(REASONING_PREFIX.length), "base64url")).toString("utf8")
  } catch {
    return undefined
  }
}

function lastMessageIndex(messages, role) {
  let index = -1
  for (const [current, message] of messages.entries()) {
    if (typeof message === "string") {
      if (role === "user") index = current
      continue
    }
    if (message?.role === role) index = current
  }
  return index
}

function readThinkDirective(text, onEffort) {
  const match = /^\s*\/(no_think|think)(?=\s|$)[ \t]*/i.exec(text)
  if (!match) return text
  onEffort?.(match[1].toLowerCase() === "no_think" ? "none" : "high")
  return text.slice(match[0].length)
}

function stripThinkControl(text) {
  return String(text ?? "").replace(/^\s*\/(?:no_think|think)(?=$|\s|[.,;:!?])\s*/i, "")
}

function stripThinkFromParts(parts, onEffort) {
  let applied = false
  return parts.flatMap((part) => {
    if (part.type !== "text" || applied) return [part]
    applied = true
    const text = readThinkDirective(part.text, onEffort)
    return text ? [{ ...part, text }] : []
  })
}

function outputText(value) {
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    return value
      .flatMap((part) => {
        if (typeof part === "string") return [part]
        if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") {
          return typeof part.text === "string" ? [part.text] : []
        }
        if (part?.type === "input_image" || part?.type === "image_url") return ["[image]"]
        return []
      })
      .join("\n")
  }
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return value.text
    if (typeof value.content === "string") return value.content
    return JSON.stringify(value)
  }
  return String(value ?? "")
}

function normalizeChatEffort(value) {
  if (value === undefined || value === null || value === false) return undefined
  const normalized = String(value).trim().toLowerCase()
  if (!normalized) return undefined
  if (["none", "off", "disabled", "false", "no"].includes(normalized)) return "none"
  if (["minimal", "minimum"].includes(normalized)) return "low"
  if (["xhigh", "max", "ultra"].includes(normalized)) return "high"
  if (["auto", "default", "model_default"].includes(normalized)) return undefined
  if (["low", "medium", "high"].includes(normalized)) return normalized
  return undefined
}

class ControlTextFilter {
  constructor() {
    this.buffer = ""
    this.ready = false
    this.trimLeading = false
  }

  push(text) {
    if (typeof text !== "string" || text.length === 0) return ""
    if (this.trimLeading) {
      const trimmed = text.replace(/^\s+/, "")
      if (!trimmed) return ""
      this.trimLeading = false
      text = trimmed
    }
    if (this.ready) return text
    this.buffer += text
    const trimmed = this.buffer.replace(/^\s+/, "")
    const marker = /^(\/no_think|\/think)(?=$|\s|[.,;:!?])/i.exec(trimmed)
    if (marker) {
      this.ready = true
      this.buffer = ""
      const output = trimmed.slice(marker[0].length).replace(/^\s+/, "")
      this.trimLeading = output.length === 0
      return output
    }
    if (trimmed.startsWith("/") && trimmed.length < 12) return ""
    this.ready = true
    const output = this.buffer
    this.buffer = ""
    return output
  }

  flush() {
    if (this.ready) return ""
    this.ready = true
    const output = this.buffer
    this.buffer = ""
    return output.replace(/^\s*\/(?:no_think|think)(?=$|\s|[.,;:!?])\s*/i, "")
  }

  reset() {
    this.buffer = ""
    this.ready = false
    this.trimLeading = false
  }
}

function rewriteResponsesBody(input) {
  const body = { ...input, stream: true }
  const tools = Array.isArray(input.tools) ? [...input.tools] : []
  const hasRead = tools.some((tool) => tool?.name === "read" || tool?.function?.name === "read")
  if (!hasRead) tools.push(RESPONSES_READ_TOOL)
  body.tools = tools
  if (!hasRead && tools.length > 1) {
    body.instructions = [
      typeof input.instructions === "string" ? input.instructions : "",
      "The `read` tool is a proxy compatibility marker. Do not call it; use the caller's tools for all work.",
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    if (body.tool_choice === undefined) body.tool_choice = "none"
  }
  return body
}


function responsesToChat(input) {
  const registry = buildChatToolRegistry(input.tools)
  const messages = []
  const callNames = new Map()
  const source =
    typeof input.input === "string"
      ? [{ type: "message", role: "user", content: input.input }]
      : Array.isArray(input.input)
        ? input.input
        : []
  const lastUserIndex = lastMessageIndex(source, "user")
  let pendingReasoning = ""
  let hasPendingReasoning = false
  let directiveEffort

  const takeReasoning = () => {
    if (!hasPendingReasoning) return
    const reasoning = { type: "reasoning", text: pendingReasoning }
    pendingReasoning = ""
    hasPendingReasoning = false
    return reasoning
  }
  const attachReasoning = (message) => {
    const reasoning = takeReasoning()
    if (reasoning) message.reasoning_content = reasoning.text
    return message
  }
  const flushReasoning = () => {
    const reasoning = takeReasoning()
    if (reasoning) messages.push({ role: "assistant", content: "", reasoning_content: reasoning.text })
  }

  if (typeof input.instructions === "string" && input.instructions.trim()) {
    const text = readThinkDirective(input.instructions, (effort) => (directiveEffort = effort))
    if (text) messages.push({ role: "system", content: text })
  }

  for (const [itemIndex, item] of source.entries()) {
    if (typeof item === "string") {
      const text = itemIndex === lastUserIndex ? readThinkDirective(item, (effort) => (directiveEffort = effort)) : item
      if (text) messages.push({ role: "user", content: text })
      continue
    }
    if (!item || typeof item !== "object") continue

    if (item.type === "reasoning") {
      pendingReasoning += stripThinkControl(decodeReasoning(item.encrypted_content) ?? reasoningTextFromItem(item))
      hasPendingReasoning = true
      continue
    }

    if (item.type === "message") {
      const role = item.role ?? "user"
      const content = responsesContent(item.content)
      if (role === "system" || role === "developer") {
        const parts =
          typeof content === "string"
            ? readThinkDirective(content, (effort) => (directiveEffort = effort))
            : stripThinkFromParts(content, (effort) => (directiveEffort = effort))
        if (parts.length > 0) messages.push({ role: "system", content: parts })
        continue
      }
      if (role === "assistant") {
        messages.push(attachReasoning({ role: "assistant", content }))
        continue
      }
      flushReasoning()
      const parts =
        itemIndex === lastUserIndex
          ? typeof content === "string"
            ? readThinkDirective(content, (effort) => (directiveEffort = effort))
            : stripThinkFromParts(content, (effort) => (directiveEffort = effort))
          : content
      if (parts.length > 0) messages.push({ role: "user", content: parts })
      continue
    }

    if (item.type === "function_call") {
      const id = item.call_id ?? item.id ?? `call_${randomBytes(12).toString("hex")}`
      const name = resolveToolName(registry, item.name ?? "", item.namespace)
      callNames.set(id, name)
      const call = {
        id,
        type: "function",
        function: {
          name,
          arguments:
            typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      }
      const previous = messages[messages.length - 1]
      if (previous?.role === "assistant" && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push(call)
        attachReasoning(previous)
      } else {
        messages.push(attachReasoning({ role: "assistant", content: null, tool_calls: [call] }))
      }
      continue
    }

    if (item.type === "custom_tool_call") {
      const id = item.call_id ?? item.id ?? `call_${randomBytes(12).toString("hex")}`
      const name = resolveToolName(registry, item.name ?? "", item.namespace)
      callNames.set(id, name)
      const call = {
        id,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify({ input: customToolInput(item.input) }),
        },
      }
      const previous = messages[messages.length - 1]
      if (previous?.role === "assistant" && Array.isArray(previous.tool_calls)) {
        previous.tool_calls.push(call)
        attachReasoning(previous)
      } else {
        messages.push(attachReasoning({ role: "assistant", content: null, tool_calls: [call] }))
      }
      continue
    }

    if (
      item.type === "function_call_output" ||
      item.type === "custom_tool_call_output" ||
      item.type === "tool_result"
    ) {
      flushReasoning()
      const id = item.call_id ?? item.tool_use_id ?? item.id ?? ""
      messages.push({
        role: "tool",
        tool_call_id: id,
        name: callNames.get(id) ?? resolveToolName(registry, item.name ?? "", item.namespace),
        content: outputText(item.output),
      })
    }
  }
  flushReasoning()

  const body = { model: input.model, messages, stream: true }
  let tools = registry.tools
  const choice = input.tool_choice
  if (choice === "none") body.tool_choice = "none"
  else if (choice === "required") body.tool_choice = "required"
  else if (choice && typeof choice === "object" && (choice.type === "function" || choice.type === "custom") && choice.name) {
    body.tool_choice = {
      type: "function",
      function: { name: resolveToolName(registry, choice.name, choice.namespace) },
    }
  } else if (choice?.type === "allowed_tools" && Array.isArray(choice.tools)) {
    const allowed = new Set(choice.tools.map((tool) => resolveToolName(registry, tool.name, tool.namespace)))
    tools = tools.filter((tool) => allowed.has(tool.function.name))
    body.tool_choice = choice.mode ?? "auto"
  }
  if (tools.length > 0) body.tools = tools
  if (input.max_output_tokens !== undefined) body.max_completion_tokens = input.max_output_tokens
  for (const key of [
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "parallel_tool_calls",
    "store",
    "metadata",
    "prompt_cache_key",
    "service_tier",
  ]) {
    if (input[key] !== undefined) body[key] = input[key]
  }
  const effort = normalizeChatEffort(input.reasoning?.effort ?? directiveEffort)
  if (effort !== undefined) body.reasoning_effort = effort
  return { body, registry }
}


function responsesContent(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts = content.flatMap((part) => {
    if (typeof part === "string") return [{ type: "text", text: part }]
    if (!part || typeof part !== "object") return []
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      return typeof part.text === "string" ? [{ type: "text", text: part.text }] : []
    }
    if (part.type === "input_image") {
      const url = part.image_url ?? part.url
      return typeof url === "string" ? [{ type: "image_url", image_url: { url } }] : []
    }
    if (part.type === "input_audio" && part.input_audio) {
      return [{ type: "input_audio", input_audio: part.input_audio }]
    }
    return []
  })
  if (parts.length > 0 && parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("")
  return parts
}


function anthropicToChat(input) {
  const registry = buildChatToolRegistry(input.tools)
  const messages = []
  const toolNames = new Map()
  const source = Array.isArray(input.messages) ? input.messages : []
  const lastUserIndex = lastMessageIndex(source, "user")
  let directiveEffort
  const system = readThinkDirective(anthropicText(input.system), (effort) => (directiveEffort = effort))
  if (system) messages.push({ role: "system", content: system })

  for (const [messageIndex, message] of source.entries()) {
    if (!message || typeof message !== "object") continue
    if (message.role === "assistant") {
      const text = []
      const reasoning = []
      const toolCalls = []
      let hasThinking = false
      for (const block of anthropicBlocks(message.content)) {
        if (block.type === "text" && typeof block.text === "string") text.push(block.text)
        if (block.type === "thinking") {
          hasThinking = true
          if (typeof block.thinking === "string") reasoning.push(stripThinkControl(block.thinking))
        }
        if (block.type === "redacted_thinking") hasThinking = true
        if (block.type === "tool_use") {
          const id = block.id ?? `call_${randomBytes(12).toString("hex")}`
          const name = resolveToolName(registry, block.name ?? "")
          toolNames.set(id, name)
          toolCalls.push({
            id,
            type: "function",
            function: {
              name,
              arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
            },
          })
        }
      }
      if (toolCalls.length === 0 && text.length === 0 && !hasThinking) continue
      const assistant = {
        role: "assistant",
        content: text.join("") || (toolCalls.length > 0 ? null : ""),
      }
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls
      if (hasThinking) assistant.reasoning_content = reasoning.join("")
      messages.push(assistant)
      continue
    }

    const parts = []
    let directiveApplied = false
    const flush = () => {
      if (parts.length === 0) return
      messages.push({ role: "user", content: collapseChatContent(parts) })
      parts.length = 0
    }
    for (const block of anthropicBlocks(message.content)) {
      if (block.type === "tool_result") {
        flush()
        messages.push({
          role: "tool",
          tool_call_id: block.tool_use_id ?? "",
          name: toolNames.get(block.tool_use_id) ?? "unknown",
          content: anthropicText(block.content),
        })
        continue
      }
      if (block.type === "text" && typeof block.text === "string") {
        const value =
          messageIndex === lastUserIndex && !directiveApplied
            ? readThinkDirective(block.text, (effort) => (directiveEffort = effort))
            : block.text
        directiveApplied = true
        if (value) parts.push({ type: "text", text: value })
        continue
      }
      if (block.type === "image") {
        const image = anthropicImageToChat(block)
        if (image) parts.push(image)
      }
    }
    flush()
  }

  const body = { model: input.model, messages, stream: true }
  if (registry.tools.length > 0) body.tools = registry.tools
  if (input.tool_choice !== undefined) {
    if (input.tool_choice?.type === "tool" && input.tool_choice.name) {
      body.tool_choice = {
        type: "function",
        function: { name: resolveToolName(registry, input.tool_choice.name) },
      }
    } else {
      body.tool_choice = anthropicToolChoice(input.tool_choice)
    }
  }
  if (input.tool_choice?.disable_parallel_tool_use !== undefined) {
    body.parallel_tool_calls = !input.tool_choice.disable_parallel_tool_use
  }
  if (input.max_tokens !== undefined) body.max_completion_tokens = input.max_tokens
  for (const key of ["temperature", "top_p"]) {
    if (input[key] !== undefined) body[key] = input[key]
  }
  if (Array.isArray(input.stop_sequences) && input.stop_sequences.length > 0) body.stop = input.stop_sequences
  const effort = normalizeChatEffort(
    directiveEffort ?? (input.thinking?.type === "enabled" ? "high" : input.thinking?.type === "disabled" ? "none" : undefined),
  )
  if (effort !== undefined) body.reasoning_effort = effort
  return { body, registry }
}

function anthropicBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }]
  if (Array.isArray(content)) return content.filter((block) => block && typeof block === "object")
  return []
}

function anthropicText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((block) => {
      if (typeof block === "string") return [block]
      if (block?.type === "text" && typeof block.text === "string") return [block.text]
      return []
    })
    .join("")
}

function anthropicImageToChat(block) {
  const source = block.source
  if (!source || typeof source !== "object") return undefined
  if (source.type === "base64" && source.data && source.media_type) {
    return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } }
  }
  if (source.type === "url" && source.url) {
    return { type: "image_url", image_url: { url: source.url } }
  }
  return undefined
}

function collapseChatContent(parts) {
  if (parts.length > 0 && parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("")
  return parts
}

function anthropicToolChoice(choice) {
  if (typeof choice === "string") return choice
  if (choice?.type === "auto") return "auto"
  if (choice?.type === "any") return "required"
  if (choice?.type === "none") return "none"
  if (choice?.type === "tool" && choice.name) return { type: "function", function: { name: choice.name } }
  return "auto"
}

function chatToResponse(chat, originalModel, registry, injectedRead = false) {
  const choice = chat.choices?.[0]
  const message = choice?.message ?? {}
  const output = []
  const reasoning = stripThinkControl(message.reasoning_content ?? "")
  if (reasoning.length > 0) {
    output.push({
      type: "reasoning",
      id: `rs_${randomBytes(12).toString("hex")}`,
      summary: [{ type: "summary_text", text: reasoning }],
      encrypted_content: encodeReasoning(reasoning),
    })
  }
  const content = stripThinkControl(message.content ?? "")
  if (content.length > 0) {
    output.push({
      type: "message",
      id: `msg_${randomBytes(12).toString("hex")}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: content, annotations: [] }],
    })
  }
  for (const call of message.tool_calls ?? []) {
    const name = call.function?.name ?? ""
    if (injectedRead && name === "read" && !registry?.byName.has("read")) continue
    const descriptor = registry?.byName.get(name)
    const args = call.function?.arguments ?? "{}"
    if (descriptor?.kind === "custom") {
      output.push({
        type: "custom_tool_call",
        id: `ctc_${randomBytes(12).toString("hex")}`,
        status: "completed",
        call_id: call.id ?? `call_${randomBytes(12).toString("hex")}`,
        name: descriptor.name,
        ...(descriptor.namespace ? { namespace: descriptor.namespace } : {}),
        input: customToolInput(parseToolInput(args)),
      })
      continue
    }
    output.push({
      type: "function_call",
      id: `fc_${randomBytes(12).toString("hex")}`,
      status: "completed",
      call_id: call.id ?? `call_${randomBytes(12).toString("hex")}`,
      name: descriptor?.name ?? name,
      ...(descriptor?.namespace ? { namespace: descriptor.namespace } : {}),
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    })
  }

  const incomplete =
    choice?.finish_reason === "length"
      ? "max_output_tokens"
      : choice?.finish_reason === "content_filter"
        ? "content_filter"
        : undefined
  return {
    id: `resp_${randomBytes(12).toString("hex")}`,
    object: "response",
    created_at: chat.created ?? Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    model: originalModel ?? chat.model ?? "unknown",
    output,
    usage: chatToUsage(chat.usage),
    error: null,
    incomplete_details: incomplete ? { reason: incomplete } : null,
  }
}

function chatToUsage(usage) {
  if (!usage) return undefined
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: usage.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: usage.total_tokens ?? 0,
  }
}

function chatToAnthropic(chat, originalModel, registry, injectedRead = false) {
  const choice = chat.choices?.[0]
  const message = choice?.message ?? {}
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const content = []
  const reasoning = stripThinkControl(message.reasoning_content ?? "")

  if (reasoning.length > 0) {
    content.push({ type: "thinking", thinking: reasoning, signature: encodeReasoning(reasoning) ?? "" })
  }
  const text = stripThinkControl(message.content ?? "")
  if (text.length > 0) {
    content.push({ type: "text", text })
  }
  for (const call of toolCalls) {
    const name = call.function?.name ?? ""
    if (injectedRead && name === "read" && !registry?.byName.has("read")) continue
    const descriptor = registry?.byName.get(name)
    const args = call.function?.arguments ?? "{}"
    content.push({
      type: "tool_use",
      id: call.id ?? `toolu_${randomBytes(12).toString("hex")}`,
      name: descriptor?.name ?? name,
      input:
        descriptor?.kind === "custom"
          ? { input: customToolInput(parseToolInput(args)) }
          : parseToolInput(args),
    })
  }
  if (content.length === 0) content.push({ type: "text", text: "" })

  return {
    id: `msg_${randomBytes(12).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: originalModel ?? chat.model ?? "unknown",
    content,
    stop_reason: anthropicStopReason(choice?.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: anthropicUsage(chat.usage),
  }
}

function parseToolInput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value
  if (typeof value !== "string" || value.length === 0) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function anthropicUsage(usage) {
  const result = {
    input_tokens: usage?.prompt_tokens ?? 0,
    output_tokens: usage?.completion_tokens ?? 0,
  }
  const cached = usage?.prompt_tokens_details?.cached_tokens
  if (cached) result.cache_read_input_tokens = cached
  return result
}

function anthropicStopReason(reason, hasToolCalls) {
  if (hasToolCalls || reason === "tool_calls") return "tool_use"
  if (reason === "length") return "max_tokens"
  if (reason === "content_filter") return "refusal"
  return "end_turn"
}

async function translateChatToAnthropicStream(
  upstream,
  response,
  originalModel,
  registry,
  injectedRead = false,
  stats,
) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const textFilter = new ControlTextFilter()
  const reasoningFilter = new ControlTextFilter()
  const state = {
    messageId: `msg_${randomBytes(12).toString("hex")}`,
    model: originalModel ?? "unknown",
    nextIndex: 0,
    blocks: [],
    reasoning: undefined,
    text: undefined,
    tools: new Map(),
    usage: undefined,
    finishReason: undefined,
    failed: undefined,
  }
  let buffer = ""

  const emit = (type, data) => {
    if (response.writableEnded || response.destroyed) return
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  }

  emit("message_start", {
    message: {
      id: state.messageId,
      type: "message",
      role: "assistant",
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })
  emit("ping", {})

  const ensureReasoning = () => {
    if (state.reasoning) return state.reasoning
    state.reasoning = { kind: "reasoning", index: state.nextIndex++, text: "" }
    state.blocks.push(state.reasoning)
    emit("content_block_start", {
      index: state.reasoning.index,
      content_block: { type: "thinking", thinking: "" },
    })
    return state.reasoning
  }
  const ensureText = () => {
    if (state.text) return state.text
    state.text = { kind: "text", index: state.nextIndex++, text: "" }
    state.blocks.push(state.text)
    emit("content_block_start", { index: state.text.index, content_block: { type: "text", text: "" } })
    return state.text
  }
  const ensureTool = (call) => {
    const key = call.index ?? 0
    const existing = state.tools.get(key)
    if (existing) return existing
    const name = call.function?.name ?? ""
    if (injectedRead && name === "read" && !registry?.byName.has("read")) {
      const skipped = { skip: true }
      state.tools.set(key, skipped)
      return skipped
    }
    const descriptor = registry?.byName.get(name)
    const tool = {
      kind: "tool",
      index: state.nextIndex++,
      id: call.id ?? `toolu_${randomBytes(12).toString("hex")}`,
      name: descriptor?.name ?? name,
      arguments: "",
    }
    state.tools.set(key, tool)
    state.blocks.push(tool)
    emit("content_block_start", {
      index: tool.index,
      content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
    })
    return tool
  }
  const flushFilters = () => {
    const reasoningText = reasoningFilter.flush()
    if (reasoningText) {
      markOutput(stats)
      const reasoning = ensureReasoning()
      reasoning.text += reasoningText
      emit("content_block_delta", {
        index: reasoning.index,
        delta: { type: "thinking_delta", thinking: reasoningText },
      })
    }
    const text = textFilter.flush()
    if (text) {
      markOutput(stats)
      const block = ensureText()
      block.text += text
      emit("content_block_delta", { index: block.index, delta: { type: "text_delta", text } })
    }
  }

  const consume = (line) => {
    if (!line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") return
    const chunk = parseBody(data)
    if (!chunk) return
    if (chunk.error) {
      state.failed = chunk.error
      emit("error", { error: chunk.error })
      return
    }
    if (chunk.usage) state.usage = chunk.usage
    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) state.finishReason = choice.finish_reason
      const delta = choice.delta ?? {}
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        const value = reasoningFilter.push(delta.reasoning_content)
        if (value) {
          markOutput(stats)
          const reasoning = ensureReasoning()
          reasoning.text += value
          emit("content_block_delta", {
            index: reasoning.index,
            delta: { type: "thinking_delta", thinking: value },
          })
        }
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        const value = textFilter.push(delta.content)
        if (value) {
          markOutput(stats)
          const text = ensureText()
          text.text += value
          emit("content_block_delta", { index: text.index, delta: { type: "text_delta", text: value } })
        }
      }
      const calls = delta.tool_calls ?? []
      if (calls.length > 0) flushFilters()
      for (const call of calls) {
        const tool = ensureTool(call)
        if (tool.skip) continue
        if (call.id) tool.id = call.id
        if (call.function?.name && !tool.name) tool.name = call.function.name
        if (call.function?.arguments) {
          markOutput(stats)
          tool.arguments += call.function.arguments
          emit("content_block_delta", {
            index: tool.index,
            delta: { type: "input_json_delta", partial_json: call.function.arguments },
          })
        }
      }
      if ((delta.tool_calls ?? []).length > 0) {
        state.text = undefined
        state.reasoning = undefined
        textFilter.reset()
        reasoningFilter.reset()
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      consume(buffer.slice(0, newline).replace(/\r$/, ""))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer.trim())
  if (state.failed) {
    response.end()
    return { usage: state.usage, error: state.failed }
  }

  flushFilters()

  const blocks = [...state.blocks]
  blocks.sort((left, right) => left.index - right.index)
  if (blocks.length === 0) {
    emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    emit("content_block_stop", { index: 0 })
  } else {
    for (const block of blocks) {
      if (block.kind === "reasoning") {
        emit("content_block_delta", {
          index: block.index,
          delta: { type: "signature_delta", signature: encodeReasoning(block.text) ?? "" },
        })
      }
      emit("content_block_stop", { index: block.index })
    }
  }

  emit("message_delta", {
    delta: {
      stop_reason: anthropicStopReason(state.finishReason, state.tools.size > 0),
      stop_sequence: null,
    },
    usage: { output_tokens: state.usage?.completion_tokens ?? 0 },
  })
  emit("message_stop", {})
  response.end()
  return { usage: state.usage, error: undefined }
}

async function translateChatStream(
  upstream,
  response,
  originalModel,
  registry,
  injectedRead = false,
  stats,
) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const textFilter = new ControlTextFilter()
  const reasoningFilter = new ControlTextFilter()
  const state = {
    responseId: `resp_${randomBytes(12).toString("hex")}`,
    createdAt: Math.floor(Date.now() / 1000),
    model: originalModel ?? "unknown",
    sequence: 0,
    nextIndex: 0,
    blocks: [],
    reasoning: undefined,
    message: undefined,
    tools: new Map(),
    usage: undefined,
    finishReason: undefined,
    failed: undefined,
  }
  let buffer = ""

  const responseObject = (status, output) => ({
    id: state.responseId,
    object: "response",
    created_at: state.createdAt,
    status,
    model: state.model,
    output,
    usage: chatToUsage(state.usage),
    error: null,
    incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
  })
  const emit = (type, data) => {
    if (response.writableEnded || response.destroyed) return
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: state.sequence++, ...data })}\n\n`)
  }

  const ensureReasoning = () => {
    if (state.reasoning) return state.reasoning
    state.reasoning = { kind: "reasoning", id: `rs_${randomBytes(12).toString("hex")}`, index: state.nextIndex++, text: "" }
    state.blocks.push(state.reasoning)
    emit("response.output_item.added", {
      output_index: state.reasoning.index,
      item: { type: "reasoning", id: state.reasoning.id, summary: [] },
    })
    return state.reasoning
  }
  const ensureMessage = () => {
    if (state.message) return state.message
    state.message = { kind: "message", id: `msg_${randomBytes(12).toString("hex")}`, index: state.nextIndex++, text: "" }
    state.blocks.push(state.message)
    emit("response.output_item.added", {
      output_index: state.message.index,
      item: { type: "message", id: state.message.id, status: "in_progress", role: "assistant", content: [] },
    })
    return state.message
  }
  const ensureTool = (call) => {
    const index = call.index ?? 0
    const existing = state.tools.get(index)
    if (existing) return existing
    const name = call.function?.name ?? ""
    if (injectedRead && name === "read" && !registry?.byName.has("read")) {
      const skipped = { skip: true, arguments: "" }
      state.tools.set(index, skipped)
      return skipped
    }
    const descriptor = registry?.byName.get(name)
    const custom = descriptor?.kind === "custom"
    const tool = {
      kind: custom ? "custom" : "function",
      custom,
      id: custom ? `ctc_${randomBytes(12).toString("hex")}` : `fc_${randomBytes(12).toString("hex")}`,
      index: state.nextIndex++,
      callID: call.id ?? `call_${randomBytes(12).toString("hex")}`,
      name: descriptor?.name ?? name,
      namespace: descriptor?.namespace ?? null,
      arguments: "",
      input: "",
    }
    state.tools.set(index, tool)
    state.blocks.push(tool)
    emit("response.output_item.added", {
      output_index: tool.index,
      item: custom
        ? {
            type: "custom_tool_call",
            id: tool.id,
            call_id: tool.callID,
            name: tool.name,
            ...(tool.namespace ? { namespace: tool.namespace } : {}),
            input: "",
            status: "in_progress",
          }
        : {
            type: "function_call",
            id: tool.id,
            call_id: tool.callID,
            name: tool.name,
            ...(tool.namespace ? { namespace: tool.namespace } : {}),
            arguments: "",
            status: "in_progress",
          },
    })
    return tool
  }
  const flushFilters = () => {
    const reasoningText = reasoningFilter.flush()
    if (reasoningText) {
      markOutput(stats)
      const reasoning = ensureReasoning()
      reasoning.text += reasoningText
      emit("response.reasoning_summary_text.delta", {
        item_id: reasoning.id,
        output_index: reasoning.index,
        summary_index: 0,
        delta: reasoningText,
      })
    }
    const text = textFilter.flush()
    if (text) {
      markOutput(stats)
      const message = ensureMessage()
      message.text += text
      emit("response.output_text.delta", {
        item_id: message.id,
        output_index: message.index,
        content_index: 0,
        delta: text,
      })
    }
  }

  emit("response.created", { response: responseObject("in_progress", []) })
  emit("response.in_progress", { response: responseObject("in_progress", []) })

  const consume = (line) => {
    if (!line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") return
    const chunk = parseBody(data)
    if (!chunk) return
    if (chunk.error) {
      state.failed = chunk.error
      emit("error", { error: chunk.error })
      return
    }
    if (chunk.usage) state.usage = chunk.usage
    for (const choice of chunk.choices ?? []) {
      if (choice.finish_reason) state.finishReason = choice.finish_reason
      const delta = choice.delta ?? {}
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        const value = reasoningFilter.push(delta.reasoning_content)
        if (value) {
          markOutput(stats)
          const reasoning = ensureReasoning()
          reasoning.text += value
          emit("response.reasoning_summary_text.delta", {
            item_id: reasoning.id,
            output_index: reasoning.index,
            summary_index: 0,
            delta: value,
          })
        }
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        const value = textFilter.push(delta.content)
        if (value) {
          markOutput(stats)
          const message = ensureMessage()
          message.text += value
          emit("response.output_text.delta", {
            item_id: message.id,
            output_index: message.index,
            content_index: 0,
            delta: value,
          })
        }
      }
      const calls = delta.tool_calls ?? []
      if (calls.length > 0) flushFilters()
      for (const call of calls) {
        const tool = ensureTool(call)
        if (tool.skip) continue
        if (call.id) tool.callID = call.id
        if (call.function?.name && !tool.name) tool.name = call.function.name
        if (call.function?.arguments) {
          markOutput(stats)
          tool.arguments += call.function.arguments
          if (tool.custom) {
            tool.input = customToolInput(parseToolInput(tool.arguments))
          } else {
            emit("response.function_call_arguments.delta", {
              item_id: tool.id,
              output_index: tool.index,
              delta: call.function.arguments,
            })
          }
        }
      }
      if (calls.length > 0) {
        state.message = undefined
        state.reasoning = undefined
        textFilter.reset()
        reasoningFilter.reset()
      }
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      consume(buffer.slice(0, newline).replace(/\r$/, ""))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer.trim())
  if (state.failed) {
    response.end()
    return { usage: state.usage, error: state.failed }
  }

  flushFilters()

  for (const block of state.blocks) {
    if (!block.custom) continue
    block.input = customToolInput(parseToolInput(block.arguments))
    if (block.input) {
      emit("response.custom_tool_call_input.delta", {
        item_id: block.id,
        output_index: block.index,
        delta: block.input,
      })
    }
  }

  const items = state.blocks.map((block) => {
    if (block.kind === "reasoning") {
      return {
        index: block.index,
        item: {
          type: "reasoning",
          id: block.id,
          summary: [{ type: "summary_text", text: block.text }],
          encrypted_content: encodeReasoning(block.text),
        },
        done: {
          type: "response.reasoning_summary_text.done",
          data: { item_id: block.id, output_index: block.index, summary_index: 0, text: block.text },
        },
      }
    }
    if (block.kind === "message") {
      return {
        index: block.index,
        item: {
          type: "message",
          id: block.id,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: block.text, annotations: [] }],
        },
        done: {
          type: "response.output_text.done",
          data: { item_id: block.id, output_index: block.index, content_index: 0, text: block.text },
        },
      }
    }
    if (block.custom) {
      return {
        index: block.index,
        item: {
          type: "custom_tool_call",
          id: block.id,
          status: "completed",
          call_id: block.callID,
          name: block.name,
          ...(block.namespace ? { namespace: block.namespace } : {}),
          input: block.input,
        },
        done: {
          type: "response.custom_tool_call_input.done",
          data: { item_id: block.id, output_index: block.index, input: block.input },
        },
      }
    }
    return {
      index: block.index,
      item: {
        type: "function_call",
        id: block.id,
        status: "completed",
        call_id: block.callID,
        name: block.name,
        ...(block.namespace ? { namespace: block.namespace } : {}),
        arguments: block.arguments,
      },
      done: {
        type: "response.function_call_arguments.done",
        data: { item_id: block.id, output_index: block.index, arguments: block.arguments },
      },
    }
  })
  items.sort((left, right) => left.index - right.index)
  for (const item of items) {
    emit(item.done.type, item.done.data)
    emit("response.output_item.done", { output_index: item.index, item: item.item })
  }

  const status = state.finishReason === "length" ? "incomplete" : "completed"
  const terminal = status === "incomplete" ? "response.incomplete" : "response.completed"
  emit(terminal, { response: responseObject(status, items.map((item) => item.item)) })
  response.end()
  return { usage: state.usage, error: undefined }
}

function responsesMode(model) {
  if (RESPONSES_MODE === "chat") return "chat"
  if (RESPONSES_MODE === "native") return "native"
  if (typeof model === "string" && (model === "big-pickle" || model.includes("-free"))) return "chat"
  return "native"
}

function anthropicMode(model) {
  if (ANTHROPIC_MODE === "chat") return "chat"
  if (ANTHROPIC_MODE === "native") return "native"
  if (typeof model === "string" && (model === "big-pickle" || model.includes("-free"))) return "chat"
  return "native"
}

function isModelProtocolUnsupported(text) {
  return text.includes("ModelProtocolUnsupported") || text.includes("does not support this protocol")
}

function buildAnthropicHeaders(incoming, wantsStream, session) {
  const headers = buildHeaders(incoming, wantsStream, session)
  const key = upstreamKey(incoming)
  headers.set("authorization", `Bearer ${key}`)
  headers.set("x-api-key", key)
  headers.set("anthropic-version", firstHeader(incoming["anthropic-version"]) ?? "2023-06-01")
  const beta = firstHeader(incoming["anthropic-beta"])
  if (beta) headers.set("anthropic-beta", beta)
  return headers
}

function buildHeaders(incoming, wantsStream, session = SESSION) {
  const trace = randomBytes(16).toString("hex")
  const span = randomBytes(8).toString("hex")
  const parent = randomBytes(8).toString("hex")
  const authorization = upstreamAuthorization(incoming.authorization)

  return new Headers({
    "content-type": "application/json",
    accept: wantsStream ? "text/event-stream" : "application/json",
    "accept-encoding": "identity",
    "user-agent": USER_AGENT,
    "x-opencode-client": "cli",
    "x-opencode-project": PROJECT,
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-session-affinity": session,
    "x-session-id": session,
    authorization,
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1-${parent}`,
  })
}

async function aggregate(upstream, injectedRead = false, stats) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const textFilter = new ControlTextFilter()
  const reasoningFilter = new ControlTextFilter()
  const result = {
    id: "",
    created: 0,
    model: "",
    content: "",
    reasoning: "",
    finishReason: "stop",
    usage: undefined,
    toolCalls: new Map(),
  }
  let buffer = ""

  const consume = (line) => {
    if (!line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") return
    const chunk = parseBody(data)
    if (!chunk) return
    if (chunk.error) {
      const message =
        (typeof chunk.error === "string" ? chunk.error : chunk.error.message) ?? "Upstream stream error"
      const error = new Error(message)
      error.status = chunk.error.statusCode ?? chunk.error.status ?? 502
      throw error
    }
    if (chunk.id) result.id = chunk.id
    if (chunk.created) result.created = chunk.created
    if (chunk.model) result.model = chunk.model
    if (chunk.usage) result.usage = chunk.usage
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      if (typeof delta.content === "string" && delta.content.length > 0) {
        markOutput(stats)
        result.content += textFilter.push(delta.content)
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        markOutput(stats)
        result.reasoning += reasoningFilter.push(delta.reasoning_content)
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        markOutput(stats)
        result.content += textFilter.flush()
        result.reasoning += reasoningFilter.flush()
        textFilter.reset()
        reasoningFilter.reset()
        mergeToolCalls(result.toolCalls, delta.tool_calls)
      }
      if (choice.finish_reason) result.finishReason = choice.finish_reason
    }
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      consume(buffer.slice(0, newline).replace(/\r$/, ""))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer.trim())
  result.content += textFilter.flush()
  result.reasoning += reasoningFilter.flush()

  const message = { role: "assistant", content: result.content }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (result.toolCalls.size > 0) {
    message.tool_calls = Array.from(result.toolCalls.values())
      .sort((left, right) => left.index - right.index)
      .filter((call) => !(injectedRead && call.function?.name === "read"))
      .map(({ index, ...call }) => call)
  }

  return {
    id: result.id || `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion",
    created: result.created || Math.floor(Date.now() / 1000),
    model: result.model || "unknown",
    choices: [{ index: 0, message, finish_reason: result.finishReason, logprobs: null }],
    ...(result.usage ? { usage: result.usage } : {}),
  }
}

async function aggregateResponses(upstream, stats) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const output = new Map()
  let buffer = ""
  let id = ""
  let model = ""
  let createdAt = 0
  let status = "completed"
  let usage
  let text = ""
  let terminal
  let failed

  const consume = (line) => {
    if (!line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") return
    const event = parseBody(data)
    if (!event) return
    if (typeof event.type === "string" && event.type.endsWith(".delta")) markOutput(stats)

    if (event.response?.id) {
      id = event.response.id
      model = event.response.model ?? model
      createdAt = event.response.created_at ?? createdAt
      if (event.response.usage) usage = event.response.usage
      if (Array.isArray(event.response.output)) {
        for (const [index, item] of event.response.output.entries()) output.set(index, item)
      }
    }

    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      markOutput(stats)
      text += event.delta
      return
    }
    if (event.type === "response.output_text.done" && typeof event.text === "string" && text.length === 0) {
      text = event.text
      return
    }
    if (event.type === "response.output_item.done" && event.item) {
      output.set(event.output_index ?? output.size, event.item)
      return
    }
    if (
      event.type === "response.completed" ||
      event.type === "response.incomplete" ||
      event.type === "response.failed"
    ) {
      terminal = event.response
      if (terminal) {
        status = terminal.status ?? status
        return
      }
    }
    if (event.type === "response.failed" || event.type === "error") failed = event
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      consume(buffer.slice(0, newline).replace(/\r$/, ""))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer.trim())

  if (terminal) return terminal
  if (failed) {
    const detail = failed.error ?? failed.response?.error
    const message = typeof detail === "string" ? detail : (detail?.message ?? "Upstream response failed")
    const error = new Error(message)
    error.status = typeof failed.status === "number" ? failed.status : 502
    throw error
  }

  const items = [...output.entries()].sort((left, right) => left[0] - right[0]).map(([, item]) => item)
  if (items.length === 0 && text) {
    items.push({
      type: "message",
      id: `msg_${randomBytes(12).toString("hex")}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    })
  }
  return {
    id: id || `resp_${randomBytes(12).toString("hex")}`,
    object: "response",
    created_at: createdAt || Math.floor(Date.now() / 1000),
    status,
    model: model || "unknown",
    output: items,
    usage,
  }
}

function mergeToolCalls(target, calls) {
  for (const call of calls) {
    const index = call.index ?? 0
    const existing = target.get(index) ?? {
      index,
      id: call.id ?? "",
      type: call.type ?? "function",
      function: { name: "", arguments: "" },
    }
    if (call.id) existing.id = call.id
    if (call.type) existing.type = call.type
    if (call.function?.name) existing.function.name += call.function.name
    if (call.function?.arguments) existing.function.arguments += call.function.arguments
    target.set(index, existing)
  }
}

async function pipeBody(upstream, response, stats) {
  if (!upstream.body) {
    response.end()
    return { usage: undefined, error: "upstream returned an empty stream" }
  }
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let usage
  let error
  const consume = (line) => {
    if (!line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") return
    const event = parseBody(data)
    if (!event) return
    if (event.response?.usage) usage = event.response.usage
    if (event.message?.usage) usage = { ...usage, ...event.message.usage }
    if (event.usage) usage = { ...usage, ...event.usage }
    if (event.type === "content_block_delta" || event.type?.endsWith(".delta")) markOutput(stats)
    if (event.type === "error") {
      error =
        (typeof event.error === "string" ? event.error : event.error?.message) ??
        "Upstream stream error"
    }
    if (event.type === "response.failed") {
      const detail = event.response?.error ?? event.error
      error = (typeof detail === "string" ? detail : detail?.message) ?? "Upstream response failed"
    }
  }
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    response.write(value)
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      consume(buffer.slice(0, newline).replace(/\r$/, ""))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer.trim())
  response.end()
  return { usage, error }
}

async function pipeChatStream(upstream, response, injectedRead = false, stats) {
  if (!upstream.body) {
    response.end()
    return { usage: undefined, error: "upstream returned an empty stream" }
  }
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const textFilter = new ControlTextFilter()
  const reasoningFilter = new ControlTextFilter()
  const meta = {
    id: `chatcmpl-${randomBytes(12).toString("hex")}`,
    created: Math.floor(Date.now() / 1000),
    model: "unknown",
  }
  let buffer = ""
  let done = false
  let usage
  let error

  const write = (value) => {
    if (response.writableEnded || response.destroyed) return
    response.write(`data: ${JSON.stringify(value)}\n\n`)
  }
  const flushFilters = () => {
    const delta = {}
    const text = textFilter.flush()
    if (text) delta.content = text
    const reasoning = reasoningFilter.flush()
    if (reasoning) delta.reasoning_content = reasoning
    if (Object.keys(delta).length === 0) return
    markOutput(stats)
    write({
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta, finish_reason: null }],
    })
  }
  const consume = (line) => {
    if (done || !line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (data === "[DONE]") {
      flushFilters()
      done = true
      if (!response.writableEnded && !response.destroyed) response.write("data: [DONE]\n\n")
      return
    }
    const chunk = parseBody(data)
    if (!chunk) return
    if (chunk.usage) usage = chunk.usage
    if (chunk.error) {
      error =
        (typeof chunk.error === "string" ? chunk.error : chunk.error.message) ?? "Upstream stream error"
    }
    if (chunk.id) meta.id = chunk.id
    if (chunk.created) meta.created = chunk.created
    if (chunk.model) meta.model = chunk.model
    const hasFinish = (chunk.choices ?? []).some((choice) => choice?.finish_reason)
    let hasToolCalls = false
    let hasOutput = false
    for (const choice of chunk.choices ?? []) {
      const delta = choice?.delta
      if (!delta) continue
      if (typeof delta.content === "string") {
        const text = textFilter.push(delta.content)
        if (text) delta.content = text
        else delete delta.content
        if (text) hasOutput = true
      }
      if (typeof delta.reasoning_content === "string") {
        const reasoning = reasoningFilter.push(delta.reasoning_content)
        if (reasoning) delta.reasoning_content = reasoning
        else delete delta.reasoning_content
        if (reasoning) hasOutput = true
      }
      if (injectedRead && Array.isArray(delta.tool_calls)) {
        delta.tool_calls = delta.tool_calls.filter((call) => call.function?.name !== "read")
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        hasToolCalls = true
        hasOutput = true
      }
    }
    if (hasToolCalls) {
      flushFilters()
      textFilter.reset()
      reasoningFilter.reset()
    }
    if (hasFinish) flushFilters()
    if (hasOutput) markOutput(stats)
    write(chunk)
  }

  while (!done) {
    const { done: finished, value } = await reader.read()
    if (finished) break
    buffer += decoder.decode(value, { stream: true })
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      consume(buffer.slice(0, newline).replace(/\r$/, ""))
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf("\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) consume(buffer.trim())
  if (!done) flushFilters()
  response.end()
  return { usage, error }
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body too large")
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

function parseBody(value) {
  if (typeof value !== "string") return value && typeof value === "object" && !Array.isArray(value) ? value : undefined
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value
}

function upstreamAuthorization(value) {
  if (AUTH) return `Bearer ${AUTH.replace(/^Bearer\s+/i, "")}`
  if (PASSTHROUGH_AUTH) return firstHeader(value) ?? "Bearer public"
  return "Bearer public"
}

function upstreamKey(incoming) {
  if (AUTH) return AUTH.replace(/^Bearer\s+/i, "")
  if (PASSTHROUGH_AUTH) {
    const value = firstHeader(incoming["x-api-key"]) ?? firstHeader(incoming.authorization)
    return value ? value.replace(/^Bearer\s+/i, "") : "public"
  }
  return "public"
}

function requestSession(headers, body) {
  if (FIXED_SESSION) return FIXED_SESSION
  const values = [
    body?.prompt_cache_key,
    body?.client_metadata?.session_id,
    headers["session-id"],
    headers["thread-id"],
    headers["x-opencode-session"],
    headers["x-session-id"],
    headers["x-client-request-id"],
  ]
  const seed = values.find((value) => typeof value === "string" && value.length > 0)
  return seed ? createSessionID(seed) : SESSION
}

function createSessionID(seed) {
  if (seed) {
    const hash = createHash("sha256").update(String(seed)).digest()
    const time = hash.subarray(0, 6).toString("hex")
    const suffix = Array.from(hash.subarray(6, 20), (byte) => BASE62[byte % 62]).join("")
    return `ses_${time}${suffix}`
  }
  const current = BigInt(Date.now()) * 0x1000n + 1n
  const value = ~current
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("")
  const suffix = Array.from(randomBytes(14), (byte) => BASE62[byte % 62]).join("")
  return `ses_${time}${suffix}`
}

function setCors(response) {
  response.setHeader("access-control-allow-origin", "*")
  response.setHeader("access-control-allow-headers", "*")
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS")
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  })
  response.end(body)
}

function proxyError(error) {
  return {
    error: {
      type: "proxy_error",
      message: error instanceof Error ? error.message : String(error),
    },
  }
}

function readUpstreamError(text) {
  const parsed = parseBody(text)
  const detail = parsed?.error
  return {
    type: detail?.type ?? "upstream_error",
    message:
      ((typeof detail === "string" ? detail : detail?.message) ?? parsed?.message ?? text) ||
      "Upstream request failed",
    ...(detail?.code ? { code: detail.code } : {}),
  }
}

function openAIUpstreamError(text) {
  return { error: readUpstreamError(text) }
}

function anthropicUpstreamError(text) {
  return { type: "error", error: readUpstreamError(text) }
}
