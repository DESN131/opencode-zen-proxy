import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import http from "node:http"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PROXY = path.join(ROOT, "opencode-zen-proxy.mjs")
const requests = []

let proxy
let proxyOrigin
let upstream
let upstreamSockets = new Set()

function chunk(delta, finishReason = null, extra = {}) {
  return {
    id: "mock-chat",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  }
}

function sendSse(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`)
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content
  if (!Array.isArray(message?.content)) return ""
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

function lastRequestText(body) {
  return messageText(body.messages?.at(-1))
}

async function handleUpstream(request, response) {
  const chunks = []
  for await (const value of request) chunks.push(value)
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  requests.push(body)
  const scenario = /scenario:([a-z-]+)/.exec(lastRequestText(body))?.[1] ?? "normal-stream"

  if (scenario === "json-error") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: { type: "rate_limit", message: "mock JSON error", status: 429 } }))
    return
  }

  if (scenario === "normal-json") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        id: "mock-json",
        object: "chat.completion",
        created: 1,
        model: "mock-model",
        system_fingerprint: "fp_json",
        service_tier: "default",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello from JSON" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
    )
    return
  }

  if (scenario === "normal-json-tool") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        id: "mock-json-tool",
        object: "chat.completion",
        created: 1,
        model: "mock-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_json",
                  type: "function",
                  function: { name: "lookup", arguments: "{\"q\":\"json\"}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    )
    return
  }

  response.writeHead(200, { "content-type": "text/event-stream" })
  if (scenario === "empty-stream") {
    response.end()
    return
  }
  if (scenario === "sse-error-hold") {
    sendSse(response, { error: { type: "rate_limit", message: "mock SSE error", status: 429 } })
    const timer = setTimeout(() => response.end(), 5000)
    response.on("close", () => clearTimeout(timer))
    return
  }
  if (scenario === "idle-hold") {
    response.flushHeaders()
    const timer = setTimeout(() => response.end(), 5000)
    response.on("close", () => clearTimeout(timer))
    return
  }
  if (scenario === "eof-truncated") {
    sendSse(response, chunk({ role: "assistant", content: "partial answer" }))
    response.end()
    return
  }
  if (scenario === "read-fragmented") {
    sendSse(response, chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "r", arguments: "" } }] }))
    sendSse(response, chunk({ tool_calls: [{ index: 0, function: { name: "ead", arguments: "{\"path\":\"" } }] }))
    sendSse(response, chunk({ tool_calls: [{ index: 0, function: { arguments: "secret.txt\"}" } }] }))
    sendSse(response, chunk({}, "tool_calls", { usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }))
    response.end("data: [DONE]\n\n")
    return
  }
  if (scenario === "user-tool") {
    sendSse(response, chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_lookup", type: "function", function: { name: "look", arguments: "{\"q\":" } }] }))
    sendSse(response, chunk({ tool_calls: [{ index: 0, function: { name: "up", arguments: "\"x\"}" } }] }))
    sendSse(response, chunk({}, "tool_calls", { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }))
    response.end("data: [DONE]\n\n")
    return
  }
  if (scenario === "user-tool-delayed") {
    sendSse(response, chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_lookup_delayed", type: "function", function: { name: "lookup", arguments: "{\"q\":" } }] }))
    const timer = setTimeout(() => {
      sendSse(response, chunk({ tool_calls: [{ index: 0, function: { arguments: "\"late\"}" } }] }))
      sendSse(response, chunk({}, "tool_calls"))
      response.end("data: [DONE]\n\n")
    }, 300)
    response.on("close", () => clearTimeout(timer))
    return
  }
  if (scenario === "rich-stream") {
    sendSse(response, chunk(
      {
        role: "assistant",
        content: "rich",
        annotations: [{ type: "url_citation", url: "https://example.test" }],
        audio: { id: "audio_1", expires_at: 123, data: "AA", transcript: "hel" },
      },
      null,
      { system_fingerprint: "fp_mock", service_tier: "default" },
    ))
    sendSse(response, {
      id: "mock-chat",
      object: "chat.completion.chunk",
      created: 1,
      model: "mock-model",
      system_fingerprint: "fp_mock",
      choices: [
        {
          index: 0,
          delta: { refusal: "blocked", audio: { id: "audio_1", data: "BB", transcript: "lo" } },
          finish_reason: "stop",
          logprobs: { content: [{ token: "rich", logprob: -0.1 }] },
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    })
    response.end("data: [DONE]\n\n")
    return
  }
  if (scenario === "caller-read") {
    sendSse(response, chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_caller_read", type: "function", function: { name: "read", arguments: "{\"path\":\"notes.txt\"}" } }] }))
    sendSse(response, chunk({}, "tool_calls"))
    response.end("data: [DONE]\n\n")
    return
  }
  if (scenario === "caller-read-file") {
    sendSse(response, chunk(
      { role: "assistant", tool_calls: [{ index: 0, id: "call_read_file", type: "function", function: { name: "read", arguments: "" } }] },
      null,
      { system_fingerprint: "fp_tool", service_tier: "default" },
    ))
    sendSse(response, chunk({ tool_calls: [{ index: 0, function: { name: "_file", arguments: "{\"path\":\"notes.txt\"}" } }] }))
    sendSse(response, chunk({}, "tool_calls"))
    response.end("data: [DONE]\n\n")
    return
  }
  sendSse(response, chunk({ role: "assistant", content: "hello stream" }))
  sendSse(response, chunk({}, "stop", { usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }))
  response.end("data: [DONE]\n\n")
}

async function startProxy() {
  upstream = http.createServer((request, response) => {
    handleUpstream(request, response).catch((error) => {
      response.writeHead(500, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: error.message } }))
    })
  })
  upstream.on("connection", (socket) => {
    upstreamSockets.add(socket)
    socket.on("close", () => upstreamSockets.delete(socket))
  })
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const upstreamPort = upstream.address().port

  proxy = spawn(process.execPath, [PROXY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      OPENCODE_STREAM_IDLE_TIMEOUT_MS: "250",
      OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  proxyOrigin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proxy startup timed out\n${output}`)), 10000)
    proxy.stdout.setEncoding("utf8")
    proxy.stderr.setEncoding("utf8")
    proxy.stdout.on("data", (value) => {
      output += value
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)\/v1/.exec(output)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1])
    })
    proxy.stderr.on("data", (value) => {
      output += value
    })
    proxy.once("exit", (code) => reject(new Error(`proxy exited with ${code}\n${output}`)))
  })
}

async function post(pathname, body, timeout = 4000) {
  return fetch(`${proxyOrigin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
}

function chat(content, extra = {}) {
  return { model: "mock-model", messages: [{ role: "user", content }], ...extra }
}

function events(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
}

function parsedEvents(text) {
  return events(text)
    .filter((value) => value !== "[DONE]")
    .map((value) => JSON.parse(value))
}

function finishReason(text) {
  return parsedEvents(text)
    .flatMap((event) => event.choices ?? [])
    .find((choice) => choice.finish_reason)?.finish_reason
}

test("opencode-zen-proxy Chat Completions regressions", async (context) => {
  await startProxy()
  context.after(async () => {
    proxy?.kill()
    for (const socket of upstreamSockets) socket.destroy()
    await new Promise((resolve) => upstream?.close(resolve))
  })

  await context.test("streams normal text through the exact Chat route", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:normal-stream", { stream: true }))
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type"), /text\/event-stream/)
    assert.match(text, /hello stream/)
    assert.equal(finishReason(text), "stop")
    assert.equal(events(text).at(-1), "[DONE]")
  })

  await context.test("converts a JSON 200 completion into a valid stream", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:normal-json", { stream: true }))
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.match(response.headers.get("content-type"), /text\/event-stream/)
    assert.match(text, /hello from JSON/)
    assert.equal(parsedEvents(text)[0].system_fingerprint, "fp_json")
    assert.equal(parsedEvents(text)[0].service_tier, "default")
    assert.equal(finishReason(text), "stop")
    assert.equal(events(text).at(-1), "[DONE]")
  })

  await context.test("adds stream indexes when converting a JSON tool completion", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:normal-json-tool", {
      stream: true,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    }))
    const text = await response.text()
    const toolCall = parsedEvents(text)
      .flatMap((event) => event.choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? [])[0]
    assert.equal(response.status, 200)
    assert.equal(toolCall.index, 0)
    assert.equal(toolCall.id, "call_json")
    assert.equal(toolCall.function.name, "lookup")
    assert.equal(finishReason(text), "tool_calls")
  })

  await context.test("does not turn a JSON error into an empty stream", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:json-error", { stream: true }))
    const body = await response.json()
    assert.equal(response.status, 429)
    assert.equal(body.error.message, "mock JSON error")
  })

  await context.test("terminates immediately after an SSE error chunk", async () => {
    const startedAt = Date.now()
    const response = await post("/v1/chat/completions", chat("scenario:sse-error-hold", { stream: true }), 1500)
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.ok(Date.now() - startedAt < 1500)
    assert.match(text, /mock SSE error/)
    assert.equal(finishReason(text), "stop")
    assert.equal(events(text).at(-1), "[DONE]")
  })

  await context.test("times out an idle streaming upstream", async () => {
    const startedAt = Date.now()
    const response = await post("/v1/chat/completions", chat("scenario:idle-hold", { stream: true }), 1500)
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.ok(Date.now() - startedAt < 1500)
    assert.equal(finishReason(text), "stop")
    assert.equal(events(text).at(-1), "[DONE]")
  })

  await context.test("terminates a stream when upstream EOF has no finish marker", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:eof-truncated", { stream: true }))
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.match(text, /partial answer/)
    assert.equal(finishReason(text), "stop")
    assert.equal(events(text).at(-1), "[DONE]")
  })

  await context.test("terminates an empty stream instead of leaving the client open", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:empty-stream", { stream: true }))
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.equal(finishReason(text), "stop")
    assert.equal(events(text).at(-1), "[DONE]")
  })

  await context.test("filters an injected read call split across many chunks", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:read-fragmented", { stream: true }))
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.doesNotMatch(text, /call_read|secret\.txt|"tool_calls"/)
    assert.equal(finishReason(text), "stop")
    assert.equal(events(text).at(-1), "[DONE]")
  })

  await context.test("does not aggregate an injected read call into JSON", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:read-fragmented"))
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.choices[0].message.tool_calls, undefined)
    assert.equal(body.choices[0].finish_reason, "stop")
  })

  await context.test("preserves a caller tool call split across chunks", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:user-tool", {
      stream: true,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    }))
    const text = await response.text()
    const fragments = parsedEvents(text)
      .flatMap((event) => event.choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? [])
    assert.equal(response.status, 200)
    assert.equal(fragments.map((call) => call.function?.name ?? "").join(""), "lookup")
    assert.equal(fragments.map((call) => call.function?.arguments ?? "").join(""), "{\"q\":\"x\"}")
    assert.equal(finishReason(text), "tool_calls")
    assert.ok(requests.at(-1).messages.some((message) => String(message.content).includes("proxy compatibility marker")))
  })

  await context.test("streams a caller tool call before the upstream finishes", async () => {
    const startedAt = Date.now()
    const response = await post("/v1/chat/completions", chat("scenario:user-tool-delayed", {
      stream: true,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: {} } } }],
    }))
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const firstRead = await reader.read()
    const firstText = decoder.decode(firstRead.value, { stream: true })
    assert.equal(response.status, 200)
    assert.ok(Date.now() - startedAt < 250)
    assert.match(firstText, /lookup/)
    await reader.cancel()
  })

  await context.test("preserves a read tool owned by the caller", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:caller-read", {
      stream: true,
      tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }],
    }))
    const text = await response.text()
    const choices = parsedEvents(text).flatMap((event) => event.choices ?? [])
    const toolCall = choices.flatMap((choice) => choice.delta?.tool_calls ?? [])[0]
    assert.equal(toolCall.id, "call_caller_read")
    assert.equal(toolCall.function.name, "read")
    assert.equal(finishReason(text), "tool_calls")
    assert.equal(choices.filter((choice) => choice.finish_reason).length, 1)
  })

  await context.test("does not confuse a fragmented caller read_file tool with the marker", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:caller-read-file", {
      stream: true,
      tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }],
    }))
    const text = await response.text()
    const calls = parsedEvents(text)
      .flatMap((event) => event.choices ?? [])
      .flatMap((choice) => choice.delta?.tool_calls ?? [])
    const toolEvent = parsedEvents(text).find((event) => event.choices?.some((choice) => choice.delta?.tool_calls))
    assert.equal(response.status, 200)
    assert.equal(calls.map((call) => call.function?.name ?? "").join(""), "read_file")
    assert.equal(calls.map((call) => call.function?.arguments ?? "").join(""), "{\"path\":\"notes.txt\"}")
    assert.equal(toolEvent.system_fingerprint, "fp_tool")
    assert.equal(toolEvent.service_tier, "default")
    assert.equal(finishReason(text), "tool_calls")
  })

  await context.test("forces tool_choice none when the caller supplies no tools", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:normal-stream", {
      stream: true,
      tool_choice: "required",
    }))
    await response.text()
    assert.equal(requests.at(-1).tool_choice, "none")
  })

  await context.test("rejects Chat options that cannot be represented faithfully", async () => {
    const multiChoice = await post("/v1/chat/completions", chat("scenario:normal-stream", { n: 2 }))
    const multiChoiceBody = await multiChoice.json()
    assert.equal(multiChoice.status, 400)
    assert.equal(multiChoiceBody.error.code, "unsupported_parameter")

    const logprobs = await post("/v1/chat/completions", chat("scenario:normal-stream", { logprobs: true }))
    const logprobsBody = await logprobs.json()
    assert.equal(logprobs.status, 400)
    assert.equal(logprobsBody.error.code, "unsupported_parameter")
  })

  await context.test("preserves standard Chat response metadata when aggregating SSE", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:rich-stream"))
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.system_fingerprint, "fp_mock")
    assert.equal(body.service_tier, "default")
    assert.equal(body.choices[0].message.content, "rich")
    assert.equal(body.choices[0].message.refusal, "blocked")
    assert.deepEqual(body.choices[0].message.annotations, [{ type: "url_citation", url: "https://example.test" }])
    assert.deepEqual(body.choices[0].message.audio, {
      id: "audio_1",
      expires_at: 123,
      data: "AABB",
      transcript: "hello",
    })
    assert.deepEqual(body.choices[0].logprobs.content, [{ token: "rich", logprob: -0.1 }])
  })

  await context.test("strips think markers deterministically from history", async () => {
    await post("/v1/chat/completions", chat([
      { type: "text", text: "/think first scenario:normal-stream" },
    ])).then((response) => response.text())
    assert.equal(requests.at(-1).reasoning_effort, "high")

    const response = await post("/v1/chat/completions", {
      model: "mock-model",
      messages: [
        { role: "user", content: "/think first scenario:normal-stream" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second scenario:normal-stream" },
      ],
    })
    await response.text()
    assert.equal(requests.at(-1).messages[0].content, "first scenario:normal-stream")
    assert.equal(requests.at(-1).reasoning_effort, undefined)
  })

  await context.test("finds think markers in later text parts", async () => {
    const response = await post("/v1/chat/completions", chat([
      { type: "text", text: "prefix" },
      { type: "text", text: "/no_think scenario:normal-stream" },
    ]))
    await response.text()
    assert.equal(requests.at(-1).messages[0].content[1].text, "scenario:normal-stream")
    assert.equal(requests.at(-1).reasoning_effort, "none")
  })

  await context.test("returns 502 for a truncated non-streaming response", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:eof-truncated"))
    assert.equal(response.status, 502)
    assert.match((await response.text()), /finish_reason or \[DONE\]/)
  })

  await context.test("returns 502 for an empty non-streaming response", async () => {
    const response = await post("/v1/chat/completions", chat("scenario:empty-stream"))
    assert.equal(response.status, 502)
  })

  await context.test("returns 502 for an idle non-streaming upstream", async () => {
    const startedAt = Date.now()
    const response = await post("/v1/chat/completions", chat("scenario:idle-hold"), 1500)
    assert.equal(response.status, 502)
    assert.ok(Date.now() - startedAt < 1500)
  })

  await context.test("falls back to the next port when the preferred port is occupied", async () => {
    const occupied = http.createServer((_request, response) => {
      response.writeHead(200)
      response.end("occupied")
    })
    await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve))
    const occupiedPort = occupied.address().port
    let fallbackProxy
    let output = ""
    try {
      fallbackProxy = spawn(process.execPath, [PROXY], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(occupiedPort),
          PORT_ATTEMPTS: "3",
          HOST: "127.0.0.1",
          OPENCODE_STREAM_IDLE_TIMEOUT_MS: "250",
          OPENCODE_ZEN_BASE_URL: `http://127.0.0.1:${upstream.address().port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      })
      fallbackProxy.stdout.setEncoding("utf8")
      fallbackProxy.stderr.setEncoding("utf8")
      const origin = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`fallback proxy startup timeout\n${output}`)), 10000)
        const onData = (value) => {
          output += value
          const match = /listening on (http:\/\/127\.0\.0\.1:\d+)\/v1/.exec(output)
          if (!match) return
          clearTimeout(timer)
          resolve(match[1])
        }
        fallbackProxy.stdout.on("data", onData)
        fallbackProxy.stderr.on("data", onData)
        fallbackProxy.once("exit", (code) => {
          clearTimeout(timer)
          reject(new Error(`fallback proxy exited with ${code}\n${output}`))
        })
      })

      assert.notEqual(new URL(origin).port, String(occupiedPort))
      assert.match(output, new RegExp(`port ${occupiedPort} is unavailable \\(EADDRINUSE\\)`))
      assert.equal((await fetch(`${origin}/health`)).status, 200)
    } finally {
      fallbackProxy?.kill()
      occupied.closeAllConnections?.()
      await new Promise((resolve) => occupied.close(resolve))
    }
  })

  await context.test("keeps unsupported routes at 404", async () => {
    assert.equal((await post("/v1/responses", {})).status, 404)
    assert.equal((await post("/v1/messages", {})).status, 404)
    assert.equal((await post("/invalid/chat/completions", chat("scenario:normal-stream"))).status, 404)
  })
})
