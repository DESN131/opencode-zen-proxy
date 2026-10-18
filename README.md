<h1 align="center">OpenCode Zen Proxy</h1>

<p align="center">
  Use OpenCode Zen free models from other software and agents<br>
  Chat Completions · Responses API · Anthropic Messages · Streaming
</p>

<p align="center">
  <strong>English</strong> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

---

## Quick Start

**Requirements:** Node.js 20 or newer. No npm dependencies.

Start the proxy, then point other OpenAI- or Anthropic-compatible software or agents at the local endpoint to use OpenCode Zen free models.

```powershell
node opencode-zen-proxy.mjs
```

The proxy listens on `http://127.0.0.1:8787/v1` by default.

### Client settings

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API key (free models) | `public` |
| API key (paid models) | A real OpenCode API key |

### Responses API example

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="public",
)

response = client.responses.create(
    model="big-pickle",
    input="Say hello",
)

print(response.output_text)
```

### Chat Completions example

```python
completion = client.chat.completions.create(
    model="big-pickle",
    messages=[{"role": "user", "content": "Say hello"}],
)

print(completion.choices[0].message.content)
```

### Anthropic Messages example

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://127.0.0.1:8787",
    api_key="public",
)

message = client.messages.create(
    model="big-pickle",
    max_tokens=200,
    messages=[{"role": "user", "content": "Say hello"}],
)

print(message.content)
```

## Features

- Proxy OpenCode Zen free models for other software and agents
- OpenAI-compatible Chat Completions and Responses endpoints
- Anthropic Messages API endpoint
- Responses-to-Chat and Anthropic-to-Chat translation for compatible models
- SSE passthrough for streaming clients
- JSON aggregation for non-streaming clients
- Responses-to-Chat translation for models that only support Chat Completions
- Chat-to-Responses event translation for streaming clients
- OpenCode-compatible request markers for free-tier access
- No runtime dependencies beyond Node.js built-ins

## Free and Paid Models

### Free models

Free models do not require a real API key. This is the main use case: other software and agents can call Zen free models through this proxy. Use `public` or another placeholder as the client API key. The proxy adds the request markers required by the upstream free-tier check.

### Paid models

Set a real OpenCode API key for the proxy:

```powershell
$env:OPENCODE_PROXY_AUTH = "your-real-key"
node opencode-zen-proxy.mjs
```

Or forward the client's `Authorization` header:

```powershell
$env:OPENCODE_PROXY_PASSTHROUGH_AUTH = "1"
node opencode-zen-proxy.mjs
```

Paid models are billed by the upstream service. Upstream errors such as `401`, `402`, and `429` are returned unchanged.

## Endpoints

| Endpoint | Description |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI-compatible Chat Completions |
| `POST /v1/responses` | Responses API, native or translated |
| `POST /v1/messages` | Anthropic Messages API, native or translated |
| `GET /v1/models` | Upstream model list |
| `GET /health` | Local proxy health check |

## Responses API Modes

`OPENCODE_PROXY_RESPONSES_MODE` controls `/v1/responses`:

| Value | Behavior |
| --- | --- |
| `auto` (default) | Free models use Chat Completions translation. Other models try native Responses first and fall back on `ModelProtocolUnsupported`. |
| `chat` | Always translate Responses requests to Chat Completions. |
| `native` | Always forward to the native Responses endpoint. |

The translation covers:

- `instructions` to a system message
- `input` strings and item arrays to Chat Completions messages
- `function_call` and `function_call_output` items
- Responses tools to Chat Completions tools
- `tool_choice`, `max_output_tokens`, and `reasoning.effort`
- Text, reasoning, tool calls, usage, and streaming events in both directions

## Anthropic API Modes

`OPENCODE_PROXY_ANTHROPIC_MODE` controls `/v1/messages`:

| Value | Behavior |
| --- | --- |
| `auto` (default) | Free models use Chat Completions translation. Other models try native Anthropic Messages first and fall back on `ModelProtocolUnsupported`. |
| `chat` | Always translate Anthropic Messages requests to Chat Completions. |
| `native` | Always forward to the native Anthropic Messages endpoint. |

The translation covers:

- `system` prompts and text content blocks
- Image content blocks
- `tool_use` and `tool_result` blocks
- Anthropic tools and `tool_choice`
- `max_tokens`, `temperature`, `top_p`, and `stop_sequences`
- Text, thinking, tool calls, usage, and streaming events in both directions

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Listen host |
| `OPENCODE_ZEN_BASE_URL` | `https://opencode.ai/zen/v1` | Upstream base URL |
| `OPENCODE_PROXY_UA` | `opencode/latest/2.0.32/cli` | Upstream User-Agent |
| `OPENCODE_PROXY_SESSION` | generated | Fixed `ses_...` session |
| `OPENCODE_PROXY_PROJECT` | generated | Fixed 32-hex project ID |
| `OPENCODE_PROXY_AUTH` | `public` | Upstream bearer token |
| `OPENCODE_PROXY_PASSTHROUGH_AUTH` | unset | Forward the client's Authorization when set to `1` |
| `OPENCODE_PROXY_RESPONSES_MODE` | `auto` | `auto`, `chat`, or `native` |
| `OPENCODE_PROXY_ANTHROPIC_MODE` | `auto` | `auto`, `chat`, or `native` |

## Limitations

- Only Chat Completions, Responses, and Anthropic Messages are implemented. Google `generateContent`, embeddings, images, and audio endpoints are not supported.
- Responses translation does not support `previous_response_id`, background tasks, hosted tools such as `web_search` or `file_search`, or file inputs.
- Anthropic translation emits synthetic thinking signatures. Documents, citations, and provider-specific Anthropic extensions are not translated.
- The upstream free-tier check is a heuristic client fingerprint and may change without notice.
- The proxy injects a `read` tool marker. When the caller provides no tools, `tool_choice` is set to `none` to prevent the injected tool from being selected.
- The server binds to `127.0.0.1` by default. Do not expose it publicly without authentication.

## Security Notes

- Do not commit real API keys or share them in logs.
- Keep the listen host on loopback unless you add an authentication layer.
- Review the upstream service terms before using free-tier access from other agents.
