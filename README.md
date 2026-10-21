<h1 align="center">OpenCode Zen Proxy</h1>

<p align="center">
  OpenAI-compatible Chat Completions proxy for OpenCode Zen models<br>
  Streaming · Tool calls · Reasoning replay
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

---

## Quick Start

Requires Node.js 20 or newer. There are no npm runtime dependencies.

```powershell
npm start
```

Run `npm test` for the local black-box protocol tests.

The proxy listens on `http://127.0.0.1:8787/v1` by default. If that port is occupied or unavailable due to an OS exclusion/permission error, it tries up to `PORT_ATTEMPTS` consecutive ports and logs the actual address.

## Client Settings

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key for free models | `public` |
| API key for paid models | A real OpenCode API key |

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="public",
)

completion = client.chat.completions.create(
    model="big-pickle",
    messages=[{"role": "user", "content": "Say hello"}],
)

print(completion.choices[0].message.content)
```

## Endpoints

| Endpoint | Description |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible Chat Completions, streaming or JSON |
| `GET /v1/models` | Upstream model list |
| `GET /health` | Local proxy health check |

Responses API and Anthropic Messages routes are intentionally not implemented. Unsupported routes return `404` with an OpenAI-style error object.

## Behavior

- Adds the OpenCode-compatible request markers required by the Zen free tier.
- Supports standard function tools and preserves valid caller tool calls even when their name and arguments span multiple SSE chunks.
- Replays assistant `reasoning_content` for multi-turn reasoning models.
- Removes leading `/think` and `/no_think` markers from all user history deterministically; only the latest user marker changes this request's reasoning effort.
- Aggregates upstream SSE into a normal JSON Chat Completions response for non-streaming clients.
- Converts a JSON Chat Completion into SSE when the upstream ignores `stream: true`, and reports JSON errors instead of emitting an empty stream.
- Ensures streaming responses end with a `finish_reason` chunk and `[DONE]`, including premature EOF and SSE error recovery. A truncated non-streaming response returns `502`.
- Keeps a stable upstream `ses_...` session per client conversation.
- Logs timestamps, token usage, TTFT, generation time, and output speed.

## Paid Models

Set an OpenCode API key for the proxy:

```powershell
$env:OPENCODE_PROXY_AUTH = "your-real-key"
npm start
```

Or forward the client's `Authorization` header:

```powershell
$env:OPENCODE_PROXY_PASSTHROUGH_AUTH = "1"
npm start
```

Free models normally use `public`. Paid usage is billed by the upstream service.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Preferred listen port |
| `HOST` | `127.0.0.1` | Listen host |
| `PORT_ATTEMPTS` | `200` | Consecutive ports to try when the preferred port is occupied or unavailable |
| `LOG_TIME_ZONE` | `Asia/Hong_Kong` | Time zone for log timestamps |
| `OPENCODE_STREAM_IDLE_TIMEOUT_MS` | `120000` | Maximum idle time while waiting for upstream headers or stream chunks; set to `0` to disable |
| `OPENCODE_ZEN_BASE_URL` | `https://opencode.ai/zen/v1` | Upstream base URL |
| `OPENCODE_PROXY_UA` | `opencode/latest/2.0.32/cli` | Upstream User-Agent |
| `OPENCODE_PROXY_SESSION` | generated | Fixed `ses_...` session |
| `OPENCODE_PROXY_PROJECT` | generated | Fixed 32-hex project ID |
| `OPENCODE_PROXY_AUTH` | `public` | Upstream bearer token |
| `OPENCODE_PROXY_PASSTHROUGH_AUTH` | unset | Forward the caller's Authorization when set to `1` |

## Limitations

- Only Chat Completions is supported. Embeddings, image generation, audio, Responses API, and Anthropic Messages are not implemented.
- The upstream free-tier check is a heuristic client fingerprint and may change without notice.
- The proxy injects a minimal `read` tool marker. If the caller sends no tools, `tool_choice` is forced to `none`; if tools are present, a system instruction tells the model not to call that marker. Any `read` call returned by the upstream is removed completely across streamed tool-call fragments.
- Keep the listener on loopback unless you add authentication.

Do not commit real API keys. Review the upstream service terms before using free-tier access from other agents.
