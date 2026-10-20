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
import { randomBytes } from "node:crypto"

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const PORT = Number(process.env.PORT ?? 8787)
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

// The free-tier gate checks for a tool named `read`. This minimal definition is
// enough; tools already supplied by the caller are preserved.
const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read the contents of a file or directory.",
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
  description: "Read the contents of a file or directory.",
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

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (error?.name === "AbortError" || (error instanceof Error && error.message.includes("aborted"))) return
    console.error(`[zen-proxy] ${error instanceof Error ? error.message : String(error)}`)
    const status = typeof error?.status === "number" ? error.status : 500
    if (!response.headersSent) return json(response, status, proxyError(error))
    response.end()
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[zen-proxy] listening on http://${HOST}:${PORT}/v1`)
  console.log(`[zen-proxy] upstream ${UPSTREAM}`)
  console.log(`[zen-proxy] session ${SESSION}`)
  console.log(`[zen-proxy] project ${PROJECT}`)
})

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

  const wantsStream = input.stream === true
  const body = rewriteBody(input, wantsStream)
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(request.headers, wantsStream),
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      response.end()
      return
    }
    json(response, 502, proxyError(upstream.error))
    return
  }

  console.log(`[zen-proxy] ${upstream.status} model=${input.model ?? "unknown"} stream=${wantsStream}`)
  if (!upstream.ok) {
    const text = await upstream.text()
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  const contentType = upstream.headers.get("content-type") ?? ""
  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    await pipeBody(upstream, response)
    return
  }

  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const text = await upstream.text()
    response.writeHead(200, {
      "content-type": contentType || "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  json(response, 200, await aggregate(upstream))
}

async function proxyResponses(request, response) {
  const raw = await readBody(request)
  const input = parseBody(raw)
  if (!input) {
    json(response, 400, { error: { type: "invalid_request", message: "Request body must be a JSON object" } })
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
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${UPSTREAM}/responses`, {
    method: "POST",
    headers: buildHeaders(request.headers, wantsStream),
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      response.end()
      return
    }
    json(response, 502, proxyError(upstream.error))
    return
  }

  console.log(`[zen-proxy] ${upstream.status} responses model=${input.model ?? "unknown"} stream=${wantsStream}`)
  if (!upstream.ok) {
    const text = await upstream.text()
    if (RESPONSES_MODE === "auto" && upstream.status === 400 && isModelProtocolUnsupported(text)) {
      console.log("[zen-proxy] native responses unsupported; falling back to chat completions")
      return "fallback"
    }
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  const contentType = upstream.headers.get("content-type") ?? ""
  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    await pipeBody(upstream, response)
    return
  }

  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const text = await upstream.text()
    response.writeHead(200, {
      "content-type": contentType || "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  json(response, 200, await aggregateResponses(upstream))
  return "done"
}

async function proxyResponsesViaChat(request, response, input) {
  const wantsStream = input.stream === true
  const body = rewriteBody(responsesToChat(input), wantsStream)
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(request.headers, wantsStream),
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      response.end()
      return
    }
    json(response, 502, proxyError(upstream.error))
    return
  }

  console.log(`[zen-proxy] ${upstream.status} responses->chat model=${input.model ?? "unknown"} stream=${wantsStream}`)
  if (!upstream.ok) {
    const text = await upstream.text()
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  const contentType = upstream.headers.get("content-type") ?? ""
  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    await translateChatStream(upstream, response, input.model)
    return
  }

  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const text = await upstream.text()
    const chat = parseBody(text)
    if (chat) {
      json(response, 200, chatToResponse(chat, input.model))
      return
    }
    response.writeHead(200, {
      "content-type": contentType || "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  json(response, 200, chatToResponse(await aggregate(upstream), input.model))
}

async function proxyAnthropic(request, response) {
  const raw = await readBody(request)
  const input = parseBody(raw)
  if (!input) {
    json(response, 400, { error: { type: "invalid_request", message: "Request body must be a JSON object" } })
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
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${UPSTREAM}/messages`, {
    method: "POST",
    headers: buildAnthropicHeaders(request.headers, wantsStream),
    body: JSON.stringify(input),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      response.end()
      return
    }
    json(response, 502, proxyError(upstream.error))
    return
  }

  console.log(`[zen-proxy] ${upstream.status} messages model=${input.model ?? "unknown"} stream=${wantsStream}`)
  if (!upstream.ok) {
    const text = await upstream.text()
    if (ANTHROPIC_MODE === "auto" && upstream.status === 400 && isModelProtocolUnsupported(text)) {
      console.log("[zen-proxy] native messages unsupported; falling back to chat completions")
      return "fallback"
    }
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return "done"
  }

  const contentType = upstream.headers.get("content-type") ?? ""
  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    await pipeBody(upstream, response)
    return "done"
  }

  const text = await upstream.text()
  response.writeHead(200, {
    "content-type": contentType || "application/json",
    "cache-control": "no-store",
  })
  response.end(text)
  return "done"
}

async function proxyAnthropicViaChat(request, response, input) {
  const wantsStream = input.stream === true
  const body = rewriteBody(anthropicToChat(input), wantsStream)
  const controller = new AbortController()
  response.on("close", () => controller.abort())

  const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: buildHeaders(request.headers, wantsStream),
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((error) => ({ error }))

  if ("error" in upstream) {
    if (upstream.error?.name === "AbortError") {
      response.end()
      return
    }
    json(response, 502, proxyError(upstream.error))
    return
  }

  console.log(
    `[zen-proxy] ${upstream.status} anthropic->chat model=${input.model ?? "unknown"} stream=${wantsStream}`,
  )
  if (!upstream.ok) {
    const text = await upstream.text()
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  const contentType = upstream.headers.get("content-type") ?? ""
  if (wantsStream) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    })
    await translateChatToAnthropicStream(upstream, response, input.model)
    return
  }

  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const text = await upstream.text()
    const chat = parseBody(text)
    if (chat) {
      json(response, 200, chatToAnthropic(chat, input.model))
      return
    }
    response.writeHead(200, {
      "content-type": contentType || "application/json",
      "cache-control": "no-store",
    })
    response.end(text)
    return
  }

  json(response, 200, chatToAnthropic(await aggregate(upstream), input.model))
}

function rewriteBody(input, wantsStream) {
  const messages = Array.isArray(input.messages) ? input.messages.map(normalizeChatMessage) : input.messages
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
  const hasRead = tools.some((tool) => tool?.type === "function" && tool?.function?.name === "read")
  if (!hasRead) tools.push(READ_TOOL)
  body.tools = tools

  // If the caller did not ask for tools, prevent the compatibility marker from
  // being selected while still keeping it in the request for the gate.
  if (!wantsStream && body.stream_options === undefined) body.stream_options = { include_usage: true }
  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    if (body.tool_choice === undefined) body.tool_choice = "none"
  }
  return body
}

function normalizeChatMessage(message) {
  if (!message || message.role !== "assistant") return message
  if (typeof message.reasoning_content === "string") return message
  if (typeof message.reasoning === "string") return { ...message, reasoning_content: message.reasoning }
  if (typeof message.reasoning_text === "string") return { ...message, reasoning_content: message.reasoning_text }
  return message
}

function knownReasoningModel(model) {
  return (
    typeof model === "string" &&
    /(big-pickle|deepseek|kimi|glm|minimax|mimo|nemotron|longcat|ring-|space-bunny|hy3|step-|north-|x-preview|qwen)/i.test(
      model,
    )
  )
}

function rewriteResponsesBody(input) {
  const body = { ...input, stream: true }
  const tools = Array.isArray(input.tools) ? [...input.tools] : []
  const hasRead = tools.some((tool) => tool?.type === "function" && tool?.name === "read")
  if (!hasRead) tools.push(RESPONSES_READ_TOOL)
  body.tools = tools

  if (!Array.isArray(input.tools) || input.tools.length === 0) {
    if (body.tool_choice === undefined) body.tool_choice = "none"
  }
  return body
}

function responsesToChat(input) {
  const messages = []
  let pendingReasoning = ""
  let hasPendingReasoning = false

  const attachReasoning = (message) => {
    if (!hasPendingReasoning) return
    message.reasoning_content = (message.reasoning_content ?? "") + pendingReasoning
    pendingReasoning = ""
    hasPendingReasoning = false
  }
  const flushReasoning = () => {
    if (!hasPendingReasoning) return
    messages.push({ role: "assistant", content: "", reasoning_content: pendingReasoning })
    pendingReasoning = ""
    hasPendingReasoning = false
  }
  const addReasoning = (text) => {
    const previous = messages[messages.length - 1]
    if (previous?.role === "assistant") {
      previous.reasoning_content = (previous.reasoning_content ?? "") + text
      return
    }
    pendingReasoning += text
    hasPendingReasoning = true
  }

  if (typeof input.instructions === "string" && input.instructions.trim())
    messages.push({ role: "system", content: input.instructions })

  if (typeof input.input === "string") {
    messages.push({ role: "user", content: input.input })
  } else if (Array.isArray(input.input)) {
    for (const item of input.input) {
      if (typeof item === "string") {
        flushReasoning()
        messages.push({ role: "user", content: item })
        continue
      }
      if (!item || typeof item !== "object") continue
      if (item.type === "reasoning") {
        const text = responsesReasoningText(item)
        addReasoning(text)
        if (text.length === 0) hasPendingReasoning = true
        continue
      }
      if (item.type === "message") {
        if (item.role === "assistant") {
          const assistant = { role: "assistant", content: responsesContent(item.content) }
          attachReasoning(assistant)
          messages.push(assistant)
        } else {
          flushReasoning()
          messages.push({
            role: item.role === "developer" ? "system" : (item.role ?? "user"),
            content: responsesContent(item.content),
          })
        }
        continue
      }
      if (item.type === "function_call") {
        const call = {
          id: item.call_id ?? item.id ?? `call_${randomBytes(12).toString("hex")}`,
          type: "function",
          function: { name: item.name ?? "", arguments: item.arguments ?? "{}" },
        }
        const previous = messages[messages.length - 1]
        if (previous?.role === "assistant" && Array.isArray(previous.tool_calls)) {
          previous.tool_calls.push(call)
          attachReasoning(previous)
        } else {
          const assistant = { role: "assistant", content: null, tool_calls: [call] }
          attachReasoning(assistant)
          messages.push(assistant)
        }
        continue
      }
      if (item.type === "function_call_output") {
        flushReasoning()
        messages.push({
          role: "tool",
          tool_call_id: item.call_id ?? "",
          content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
        })
      }
    }
    flushReasoning()
  }

  const body = { model: input.model, messages, stream: true }
  let tools = Array.isArray(input.tools) ? input.tools.filter((tool) => tool?.type === "function") : []
  if (input.tool_choice?.type === "allowed_tools" && Array.isArray(input.tool_choice.tools)) {
    const allowed = new Set(input.tool_choice.tools.map((tool) => tool.name))
    tools = tools.filter((tool) => allowed.has(tool.name))
  }
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? { type: "object", properties: {} },
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      },
    }))
  }
  if (input.tool_choice !== undefined) body.tool_choice = responsesToolChoice(input.tool_choice)
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
  if (input.reasoning?.effort !== undefined) body.reasoning_effort = input.reasoning.effort
  return body
}

function responsesReasoningText(item) {
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

function responsesToolChoice(choice) {
  if (typeof choice === "string") return choice
  if (choice?.type === "function" && choice.name) return { type: "function", function: { name: choice.name } }
  if (choice?.type === "allowed_tools") return choice.mode ?? "auto"
  return "auto"
}

function anthropicToChat(input) {
  const messages = []
  const system = anthropicText(input.system)
  if (system) messages.push({ role: "system", content: system })

  for (const message of Array.isArray(input.messages) ? input.messages : []) {
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
          if (typeof block.thinking === "string") reasoning.push(block.thinking)
        }
        if (block.type === "redacted_thinking") hasThinking = true
        if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id ?? `call_${randomBytes(12).toString("hex")}`,
            type: "function",
            function: {
              name: block.name ?? "",
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
          content: anthropicText(block.content),
        })
        continue
      }
      if (block.type === "text" && typeof block.text === "string") {
        parts.push({ type: "text", text: block.text })
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
  if (Array.isArray(input.tools) && input.tools.length > 0) {
    body.tools = input.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    }))
  }
  if (input.tool_choice !== undefined) body.tool_choice = anthropicToolChoice(input.tool_choice)
  if (input.tool_choice?.disable_parallel_tool_use !== undefined) {
    body.parallel_tool_calls = !input.tool_choice.disable_parallel_tool_use
  }
  if (input.max_tokens !== undefined) body.max_completion_tokens = input.max_tokens
  for (const key of ["temperature", "top_p"]) {
    if (input[key] !== undefined) body[key] = input[key]
  }
  if (Array.isArray(input.stop_sequences) && input.stop_sequences.length > 0) body.stop = input.stop_sequences
  return body
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

function chatToResponse(chat, originalModel) {
  const choice = chat.choices?.[0]
  const message = choice?.message ?? {}
  const output = []
  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    output.push({
      type: "reasoning",
      id: `rs_${randomBytes(12).toString("hex")}`,
      summary: [{ type: "summary_text", text: message.reasoning_content }],
    })
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    output.push({
      type: "message",
      id: `msg_${randomBytes(12).toString("hex")}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: message.content, annotations: [] }],
    })
  }
  for (const call of message.tool_calls ?? []) {
    output.push({
      type: "function_call",
      id: `fc_${randomBytes(12).toString("hex")}`,
      status: "completed",
      call_id: call.id ?? `call_${randomBytes(12).toString("hex")}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
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

function chatToAnthropic(chat, originalModel) {
  const choice = chat.choices?.[0]
  const message = choice?.message ?? {}
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const content = []

  if (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0) {
    content.push({ type: "thinking", thinking: message.reasoning_content, signature: "" })
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content })
  }
  for (const call of toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id ?? `toolu_${randomBytes(12).toString("hex")}`,
      name: call.function?.name ?? "",
      input: parseToolInput(call.function?.arguments),
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

async function translateChatToAnthropicStream(upstream, response, originalModel) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const state = {
    messageId: `msg_${randomBytes(12).toString("hex")}`,
    model: originalModel ?? "unknown",
    nextIndex: 0,
    reasoning: undefined,
    text: undefined,
    tools: new Map(),
    usage: undefined,
    finishReason: undefined,
    failed: undefined,
  }
  let buffer = ""

  const emit = (type, data) => {
    response.write(`event: ${type}\n`)
    response.write(`data: ${JSON.stringify({ type, ...data })}\n\n`)
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
    state.reasoning = { index: state.nextIndex++, text: "" }
    emit("content_block_start", {
      index: state.reasoning.index,
      content_block: { type: "thinking", thinking: "" },
    })
    return state.reasoning
  }

  const ensureText = () => {
    if (state.text) return state.text
    state.text = { index: state.nextIndex++, text: "" }
    emit("content_block_start", {
      index: state.text.index,
      content_block: { type: "text", text: "" },
    })
    return state.text
  }

  const ensureTool = (call) => {
    const key = call.index ?? 0
    const existing = state.tools.get(key)
    if (existing) return existing
    const tool = {
      index: state.nextIndex++,
      id: call.id ?? `toolu_${randomBytes(12).toString("hex")}`,
      name: call.function?.name ?? "",
      arguments: "",
    }
    state.tools.set(key, tool)
    emit("content_block_start", {
      index: tool.index,
      content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} },
    })
    return tool
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
        const reasoning = ensureReasoning()
        reasoning.text += delta.reasoning_content
        emit("content_block_delta", {
          index: reasoning.index,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content },
        })
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        const text = ensureText()
        text.text += delta.content
        emit("content_block_delta", {
          index: text.index,
          delta: { type: "text_delta", text: delta.content },
        })
      }
      for (const call of delta.tool_calls ?? []) {
        const tool = ensureTool(call)
        if (call.function?.name) tool.name = call.function.name
        if (call.function?.arguments) {
          tool.arguments += call.function.arguments
          emit("content_block_delta", {
            index: tool.index,
            delta: { type: "input_json_delta", partial_json: call.function.arguments },
          })
        }
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
    return
  }

  const blocks = []
  if (state.reasoning) blocks.push({ index: state.reasoning.index, type: "reasoning" })
  if (state.text) blocks.push({ index: state.text.index, type: "text" })
  for (const tool of state.tools.values()) blocks.push({ index: tool.index, type: "tool" })
  blocks.sort((left, right) => left.index - right.index)

  if (blocks.length === 0) {
    emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    emit("content_block_stop", { index: 0 })
  } else {
    for (const block of blocks) {
      if (block.type === "reasoning") {
        emit("content_block_delta", {
          index: block.index,
          delta: { type: "signature_delta", signature: "" },
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
}

async function translateChatStream(upstream, response, originalModel) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  const state = {
    responseId: `resp_${randomBytes(12).toString("hex")}`,
    createdAt: Math.floor(Date.now() / 1000),
    model: originalModel ?? "unknown",
    sequence: 0,
    nextIndex: 0,
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
    response.write(`event: ${type}\n`)
    response.write(`data: ${JSON.stringify({ type, sequence_number: state.sequence++, ...data })}\n\n`)
  }

  const ensureReasoning = () => {
    if (state.reasoning) return state.reasoning
    state.reasoning = { id: `rs_${randomBytes(12).toString("hex")}`, index: state.nextIndex++, text: "" }
    emit("response.output_item.added", {
      output_index: state.reasoning.index,
      item: { type: "reasoning", id: state.reasoning.id, summary: [] },
    })
    return state.reasoning
  }

  const ensureMessage = () => {
    if (state.message) return state.message
    state.message = { id: `msg_${randomBytes(12).toString("hex")}`, index: state.nextIndex++, text: "" }
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
    const tool = {
      id: `fc_${randomBytes(12).toString("hex")}`,
      index: state.nextIndex++,
      callID: call.id ?? `call_${randomBytes(12).toString("hex")}`,
      name: call.function?.name ?? "",
      arguments: "",
    }
    state.tools.set(index, tool)
    emit("response.output_item.added", {
      output_index: tool.index,
      item: {
        type: "function_call",
        id: tool.id,
        call_id: tool.callID,
        name: tool.name,
        arguments: "",
        status: "in_progress",
      },
    })
    return tool
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
        const reasoning = ensureReasoning()
        reasoning.text += delta.reasoning_content
        emit("response.reasoning_summary_text.delta", {
          item_id: reasoning.id,
          output_index: reasoning.index,
          summary_index: 0,
          delta: delta.reasoning_content,
        })
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        const message = ensureMessage()
        message.text += delta.content
        emit("response.output_text.delta", {
          item_id: message.id,
          output_index: message.index,
          content_index: 0,
          delta: delta.content,
        })
      }
      for (const call of delta.tool_calls ?? []) {
        const tool = ensureTool(call)
        if (call.id) tool.callID = call.id
        if (call.function?.name) tool.name = call.function.name
        if (call.function?.arguments) {
          tool.arguments += call.function.arguments
          emit("response.function_call_arguments.delta", {
            item_id: tool.id,
            output_index: tool.index,
            delta: call.function.arguments,
          })
        }
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
    return
  }

  const items = []
  if (state.reasoning) {
    const item = {
      type: "reasoning",
      id: state.reasoning.id,
      summary: [{ type: "summary_text", text: state.reasoning.text }],
    }
    items.push({
      index: state.reasoning.index,
      item,
      done: {
        type: "response.reasoning_summary_text.done",
        data: {
          item_id: state.reasoning.id,
          output_index: state.reasoning.index,
          summary_index: 0,
          text: state.reasoning.text,
        },
      },
    })
  }
  if (state.message) {
    const item = {
      type: "message",
      id: state.message.id,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: state.message.text, annotations: [] }],
    }
    items.push({
      index: state.message.index,
      item,
      done: {
        type: "response.output_text.done",
        data: {
          item_id: state.message.id,
          output_index: state.message.index,
          content_index: 0,
          text: state.message.text,
        },
      },
    })
  }
  for (const tool of state.tools.values()) {
    const item = {
      type: "function_call",
      id: tool.id,
      status: "completed",
      call_id: tool.callID,
      name: tool.name,
      arguments: tool.arguments,
    }
    items.push({
      index: tool.index,
      item,
      done: {
        type: "response.function_call_arguments.done",
        data: { item_id: tool.id, output_index: tool.index, arguments: tool.arguments },
      },
    })
  }
  items.sort((left, right) => left.index - right.index)
  for (const item of items) {
    emit(item.done.type, item.done.data)
    emit("response.output_item.done", { output_index: item.index, item: item.item })
  }

  const status = state.finishReason === "length" ? "incomplete" : "completed"
  const terminal = status === "incomplete" ? "response.incomplete" : "response.completed"
  emit(terminal, { response: responseObject(status, items.map((item) => item.item)) })
  response.end()
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

function buildAnthropicHeaders(incoming, wantsStream) {
  const headers = buildHeaders(incoming, wantsStream)
  const key = upstreamKey(incoming)
  headers.set("authorization", `Bearer ${key}`)
  headers.set("x-api-key", key)
  headers.set("anthropic-version", firstHeader(incoming["anthropic-version"]) ?? "2023-06-01")
  const beta = firstHeader(incoming["anthropic-beta"])
  if (beta) headers.set("anthropic-beta", beta)
  return headers
}

function buildHeaders(incoming, wantsStream) {
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
    "x-opencode-session": SESSION,
    "x-opencode-session-id": SESSION,
    "x-session-affinity": SESSION,
    "x-session-id": SESSION,
    authorization,
    traceparent: `00-${trace}-${span}-01`,
    b3: `${trace}-${span}-1-${parent}`,
  })
}

async function aggregate(upstream) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
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
    if (chunk.id) result.id = chunk.id
    if (chunk.created) result.created = chunk.created
    if (chunk.model) result.model = chunk.model
    if (chunk.usage) result.usage = chunk.usage
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {}
      if (typeof delta.content === "string") result.content += delta.content
      if (typeof delta.reasoning_content === "string") result.reasoning += delta.reasoning_content
      if (Array.isArray(delta.tool_calls)) mergeToolCalls(result.toolCalls, delta.tool_calls)
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

  const message = { role: "assistant", content: result.content }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (result.toolCalls.size > 0) {
    message.tool_calls = Array.from(result.toolCalls.values())
      .sort((left, right) => left.index - right.index)
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

async function aggregateResponses(upstream) {
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

async function pipeBody(upstream, response) {
  if (!upstream.body) {
    response.end()
    return
  }
  const reader = upstream.body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    response.write(value)
  }
  response.end()
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error("request body too large")
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

function createSessionID() {
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
