#!/usr/bin/env node
/**
 * OpenAI-compatible Chat Completions proxy for OpenCode Zen models.
 *
 * Start it from this directory, then point your OpenAI-compatible client at
 * http://127.0.0.1:8787/v1:
 *
 *   node opencode-zen-proxy.mjs
 *
 * The Zen free tier currently checks more than request headers. It expects an
 * OpenCode-shaped User-Agent, a valid `ses_...` session, a streaming request,
 * and a function tool named `read`. This proxy adds those compatibility
 * markers. It passes SSE through for streaming clients and aggregates SSE into
 * a normal response for non-streaming clients.
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
 */

import http from "node:http"
import { createHash, randomBytes } from "node:crypto"

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
const MAX_BODY_BYTES = 64 * 1024 * 1024
const FIXED_SESSION = process.env.OPENCODE_PROXY_SESSION
const configuredStreamIdleTimeout = Number(process.env.OPENCODE_STREAM_IDLE_TIMEOUT_MS ?? 120000)
const STREAM_IDLE_TIMEOUT_MS =
  Number.isFinite(configuredStreamIdleTimeout) && configuredStreamIdleTimeout >= 0
    ? Math.floor(configuredStreamIdleTimeout)
    : 120000
const CHAT_PATHS = new Set(["/v1/chat/completions", "/chat/completions"])
const MODEL_PATHS = new Set(["/v1/models", "/models"])

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
  const speed = usage && usage.output > 0 && generationMs !== null && generationMs > 0
    ? (usage.output / (generationMs / 1000)).toFixed(1)
    : null
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
    `${status}${stats.protocol} model=${stats.model} stream=${stats.stream} ${tokens} elapsed=${formatDuration(elapsedMs)}${ttft}${generation} speed=${speed === null ? "n/a" : `${speed}tok/s`}${error}`,
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

function handleRequest(request, response) {
  handle(request, response).catch((error) => {
    if (error?.name === "AbortError" || (error instanceof Error && error.message.includes("aborted"))) return
    logError(error instanceof Error ? error.message : String(error))
    const status = typeof error?.status === "number" ? error.status : 500
    if (!response.headersSent) {
      return json(response, status, proxyError(error))
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

  if (request.method === "GET" && MODEL_PATHS.has(url.pathname)) {
    await proxyModels(response)
    return
  }

  if (request.method !== "POST" || !CHAT_PATHS.has(url.pathname)) {
    json(response, 404, {
      error: {
        type: "not_found",
        message: "Use /v1/chat/completions or /v1/models",
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

  const upstream = await fetchUpstream(controller, {
    method: "POST",
    headers: buildHeaders(request.headers, wantsStream, session),
    body: JSON.stringify(body),
  })

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
  const isEventStream = contentType.toLowerCase().includes("text/event-stream")

  if (wantsStream && !isEventStream) {
    const text = await upstream.text()
    const chat = parseBody(text)
    if (!chat) {
      stats.error = "Upstream returned a non-JSON response to a streaming request"
      logRequest(stats)
      json(response, 502, { error: { type: "upstream_error", message: stats.error } })
      return
    }
    if (chat.error) {
      const error = readUpstreamError(text)
      stats.error = error.message
      logRequest(stats)
      json(response, upstreamErrorStatus(chat), { error })
      return
    }
    if (!Array.isArray(chat.choices)) {
      stats.error = "Upstream JSON response is not an OpenAI Chat Completion"
      logRequest(stats)
      json(response, 502, { error: { type: "upstream_error", message: stats.error } })
      return
    }
    const normalized = normalizeChatCompletion(chat, rewritten.injectedRead)
    stats.usage = normalized.usage
    logRequest(stats)
    streamChatCompletion(response, normalized, input.stream_options?.include_usage === true)
    return
  }

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

  if (!isEventStream) {
    const text = await upstream.text()
    const chat = parseBody(text)
    if (!chat) {
      stats.error = "Upstream returned a non-JSON response"
      logRequest(stats)
      json(response, 502, { error: { type: "upstream_error", message: stats.error } })
      return
    }
    if (chat.error) {
      const error = readUpstreamError(text)
      stats.error = error.message
      logRequest(stats)
      json(response, upstreamErrorStatus(chat), { error })
      return
    }
    if (!Array.isArray(chat.choices)) {
      stats.error = "Upstream JSON response is not an OpenAI Chat Completion"
      logRequest(stats)
      json(response, 502, { error: { type: "upstream_error", message: stats.error } })
      return
    }
    const normalized = normalizeChatCompletion(chat, rewritten.injectedRead)
    stats.usage = normalized.usage
    logRequest(stats)
    json(response, 200, normalized)
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

function normalizeChatCompletion(chat, injectedRead) {
  const normalized = structuredClone(chat)
  for (const choice of normalized.choices ?? []) {
    const message = choice?.message
    if (!message) continue
    if (typeof message.content === "string") message.content = stripThinkControl(message.content)
    if (typeof message.reasoning_content === "string") {
      message.reasoning_content = stripThinkControl(message.reasoning_content)
    }
    if (injectedRead && Array.isArray(message.tool_calls)) {
      message.tool_calls = message.tool_calls.filter((call) => !isReadToolCall(call))
      if (message.tool_calls.length === 0) delete message.tool_calls
    }
    if (
      choice.finish_reason === "tool_calls" &&
      (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0)
    ) {
      choice.finish_reason = "stop"
    }
  }
  return normalized
}

function streamChatCompletion(response, chat, includeUsage) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  const base = {
    id: chat.id ?? `chatcmpl-${randomBytes(12).toString("hex")}`,
    object: "chat.completion.chunk",
    created: chat.created ?? Math.floor(Date.now() / 1000),
    model: chat.model ?? "unknown",
  }
  const write = (value) => response.write(`data: ${JSON.stringify(value)}\n\n`)
  for (const choice of chat.choices ?? []) {
    const message = choice?.message ?? {}
    const delta = { role: message.role ?? "assistant" }
    if (message.content !== undefined) delta.content = message.content
    if (message.reasoning_content !== undefined) delta.reasoning_content = message.reasoning_content
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      delta.tool_calls = message.tool_calls.map((call, index) => ({ ...call, index }))
    }
    write({ ...base, choices: [{ index: choice.index ?? 0, delta, finish_reason: null }] })
    const finishReason =
      Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0 && (!choice.finish_reason || choice.finish_reason === "stop")
        ? "tool_calls"
        : choice.finish_reason ?? "stop"
    write({
      ...base,
      choices: [{ index: choice.index ?? 0, delta: {}, finish_reason: finishReason }],
    })
  }
  if (includeUsage && chat.usage) write({ ...base, choices: [], usage: chat.usage })
  response.write("data: [DONE]\n\n")
  response.end()
}

function isReadToolCall(call) {
  return String(call?.function?.name ?? "").trim().toLowerCase() === "read"
}

function upstreamErrorStatus(value) {
  const parsed = typeof value === "string" ? parseBody(value) : value
  const status = Number(parsed?.error?.statusCode ?? parsed?.error?.status ?? parsed?.status)
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502
}

async function fetchUpstream(controller, options) {
  const timeoutController = new AbortController()
  const timer =
    STREAM_IDLE_TIMEOUT_MS > 0
      ? setTimeout(() => {
          const error = new Error(`upstream response headers idle for ${STREAM_IDLE_TIMEOUT_MS}ms`)
          error.name = "StreamIdleTimeoutError"
          timeoutController.abort(error)
        }, STREAM_IDLE_TIMEOUT_MS)
      : undefined
  try {
    return await fetch(`${UPSTREAM}/chat/completions`, {
      ...options,
      signal: timer ? AbortSignal.any([controller.signal, timeoutController.signal]) : controller.signal,
    })
  } catch (error) {
    return { error }
  } finally {
    clearTimeout(timer)
  }
}

async function readStreamChunk(reader, timeoutMs) {
  if (!timeoutMs) return reader.read()
  let timer
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reader.cancel().catch(() => {})
          const error = new Error(`upstream stream idle for ${timeoutMs}ms`)
          error.name = "StreamIdleTimeoutError"
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
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
  const inputTools = Array.isArray(input.tools) ? input.tools : []
  const tools = [...inputTools]
  const hasRead = tools.some((tool) => tool?.function?.name === "read" || tool?.name === "read")
  if (!hasRead) tools.push(READ_TOOL)
  body.tools = tools

  const injectedRead = !hasRead
  if (injectedRead && inputTools.length > 0 && Array.isArray(normalized)) {
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
  if (inputTools.length === 0) body.tool_choice = "none"
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
    if (message?.role !== "user") return message
    const onEffort = index === lastUserIndex ? (value) => (effort = value) : undefined
    if (typeof message.content === "string") {
      const text = readThinkDirective(message.content, onEffort)
      return { ...message, content: text }
    }
    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: stripThinkFromParts(message.content, onEffort),
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
  let found = false
  return parts.flatMap((part) => {
    if (part.type !== "text" || found) return [part]
    if (typeof part.text !== "string") return [part]
    const original = part.text
    const text = readThinkDirective(part.text, onEffort)
    found = text !== original
    return text ? [{ ...part, text }] : []
  })
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
  let sawFinish = false
  let sawDone = false

  const consume = (line) => {
    if (!line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (!data) return
    if (data === "[DONE]") {
      sawDone = true
      return
    }
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
      if (choice.finish_reason) {
        sawFinish = true
        result.finishReason = choice.finish_reason
      }
    }
  }

  while (true) {
    const { done, value } = await readStreamChunk(reader, STREAM_IDLE_TIMEOUT_MS)
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
  if (!sawFinish && !sawDone) {
    const error = new Error("Upstream stream ended before finish_reason or [DONE]")
    error.status = 502
    throw error
  }

  const message = { role: "assistant", content: result.content }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (result.toolCalls.size > 0) {
    const toolCalls = Array.from(result.toolCalls.values())
      .sort((left, right) => left.index - right.index)
      .filter((call) => !(injectedRead && isReadToolCall(call)))
    if (toolCalls.length > 0) {
      message.tool_calls = toolCalls.map(({ index, ...call }) => call)
    }
  }
  if (result.finishReason === "tool_calls" && !Array.isArray(message.tool_calls)) {
    result.finishReason = "stop"
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

async function pipeChatStream(upstream, response, injectedRead = false, stats) {
  const reader = upstream.body?.getReader()
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
  let finishSent = false
  let finishReason
  let usage
  let error
  let sawFinish = false
  let sawDone = false
  let emittedToolCalls = false
  const bufferedToolCalls = new Map()

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
  const flushToolCalls = () => {
    if (!injectedRead || bufferedToolCalls.size === 0) return
    const toolCalls = Array.from(bufferedToolCalls.values())
      .sort((left, right) => left.index - right.index)
      .filter((call) => !isReadToolCall(call))
    bufferedToolCalls.clear()
    if (toolCalls.length === 0) return
    emittedToolCalls = true
    markOutput(stats)
    write({
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [
        {
          index: 0,
          delta: { tool_calls: toolCalls.map(({ index, ...call }) => ({ index, ...call })) },
          finish_reason: null,
        },
      ],
    })
  }
  const finishChunk = () => {
    if (!finishSent) {
      const reason = injectedRead && finishReason === "tool_calls" && !emittedToolCalls
        ? "stop"
        : finishReason ?? "stop"
      write({
        id: meta.id,
        object: "chat.completion.chunk",
        created: meta.created,
        model: meta.model,
        choices: [{ index: 0, delta: {}, finish_reason: reason }],
        ...(usage ? { usage } : {}),
      })
      finishSent = true
    }
  }
  const finishStream = () => {
    if (done) return
    flushFilters()
    flushToolCalls()
    finishChunk()
    if (!response.writableEnded && !response.destroyed) response.write("data: [DONE]\n\n")
    done = true
  }
  const consume = (line) => {
    if (done || !line.startsWith("data:")) return
    const data = line.slice(5).trim()
    if (data === "[DONE]") {
      sawDone = true
      flushFilters()
      finishStream()
      return
    }
    const chunk = parseBody(data)
    if (!chunk) return
    if (chunk.usage) usage = chunk.usage
    if (chunk.error) {
      error = readUpstreamError(JSON.stringify(chunk))
      write({ error })
      finishStream()
      return
    }
    if (chunk.id) meta.id = chunk.id
    if (chunk.created) meta.created = chunk.created
    if (chunk.model) meta.model = chunk.model
    const finishedChoice = (chunk.choices ?? []).find((choice) => choice?.finish_reason)
    const hasFinish = finishedChoice !== undefined
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
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        hasToolCalls = true
        hasOutput = true
        if (injectedRead) {
          mergeToolCalls(bufferedToolCalls, delta.tool_calls)
          delete delta.tool_calls
        }
      }
    }
    if (hasToolCalls) {
      flushFilters()
      textFilter.reset()
      reasoningFilter.reset()
    }
    if (hasFinish) {
      flushFilters()
      finishReason = finishedChoice.finish_reason
      sawFinish = true
    }
    if (hasOutput) markOutput(stats)
    if (hasFinish) {
      if (injectedRead) flushToolCalls()
      else {
        write(chunk)
        finishSent = true
      }
      finishChunk()
      return
    }
    const hasDelta = (chunk.choices ?? []).some((choice) => {
      const delta = choice?.delta
      return delta && Object.keys(delta).length > 0
    })
    if (hasDelta || chunk.usage) write(chunk)
  }

  try {
    while (reader && !done) {
      const { done: finished, value } = await readStreamChunk(reader, STREAM_IDLE_TIMEOUT_MS)
      if (finished) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        consume(buffer.slice(0, newline).replace(/\r$/, ""))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
      }
    }
    if (reader && !done) {
      buffer += decoder.decode()
      if (buffer.trim()) consume(buffer.trim())
    }
  } catch (caught) {
    if (caught?.name === "AbortError") throw caught
    error = caught instanceof Error ? caught.message : String(caught)
    if (!done) finishStream()
  } finally {
    if (reader && done) await reader.cancel().catch(() => {})
  }
  if (!error && !sawFinish && !sawDone) {
    error = "Upstream stream ended before finish_reason or [DONE]"
  }
  if (!done) finishStream()
  if (!response.writableEnded && !response.destroyed) response.end()
  return {
    usage,
    error: error ?? (reader ? undefined : "upstream returned an empty stream"),
  }
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
