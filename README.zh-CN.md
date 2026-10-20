<h1 align="center">OpenCode Zen 代理</h1>

<p align="center">
  OpenAI 兼容的 OpenCode Zen Chat Completions 代理<br>
  流式输出 · 工具调用 · 推理内容回放
</p>

<p align="center">
  <strong>简体中文</strong> ·
  <a href="README.md">English</a>
</p>

---

## 快速开始

需要 Node.js 20 或更高版本，无 npm 运行时依赖。

```powershell
npm start
```

运行 `npm test` 可执行本地黑盒协议测试。

代理默认监听 `http://127.0.0.1:8787/v1`。如果端口已被占用，会依次尝试最多 `PORT_ATTEMPTS` 个连续端口，并在日志中打印实际监听地址。

## 客户端配置

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| 免费模型 API Key | `public` |
| 付费模型 API Key | 真实 OpenCode API Key |

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

## 端点

| 端点 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI 兼容 Chat Completions，支持流式与 JSON |
| `GET /v1/models` | 上游模型列表 |
| `GET /health` | 本地代理健康检查 |

本仓库已移除 Responses API 与 Anthropic Messages 路由。访问这两个协议会返回 OpenAI 格式的 `404` 错误。

## 行为

- 自动补充 Zen 免费层要求的 OpenCode 兼容请求标记。
- 支持标准 function tools；即使工具名称和参数分散在多个 SSE 分片中，也能保留有效的调用方工具调用。
- 多轮推理模型会将 assistant 的 `reasoning_content` 回放给上游。
- 确定性地移除全部 user 历史开头的 `/think` 或 `/no_think`；只有最新 user 的标记会改变本次请求的推理强度。
- 非流式客户端请求上游 SSE 时，自动聚合为标准 JSON Chat Completions 响应。
- 上游忽略 `stream: true` 并返回 JSON Chat Completion 时，会转换为合法 SSE；JSON 错误会明确返回，不再变成空流。
- 流式响应始终以带 `finish_reason` 的终帧和 `[DONE]` 结束；上游提前 EOF 或发送 SSE error 时也能安全终止。非流式响应被截断时返回 `502`。
- 按客户端会话派生稳定的上游 `ses_...` 会话 ID。
- 日志包含时间、token 用量、TTFT、实际生成时间和输出速度。

## 付费模型

为代理设置 OpenCode API Key：

```powershell
$env:OPENCODE_PROXY_AUTH = "your-real-key"
npm start
```

或透传客户端自己的 `Authorization`：

```powershell
$env:OPENCODE_PROXY_PASSTHROUGH_AUTH = "1"
npm start
```

免费模型通常使用 `public`。付费模型由上游服务计费。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 首选监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT_ATTEMPTS` | `20` | 首选端口占用时最多尝试的连续端口数 |
| `LOG_TIME_ZONE` | `Asia/Hong_Kong` | 日志时间戳时区 |
| `OPENCODE_STREAM_IDLE_TIMEOUT_MS` | `120000` | 等待上游响应头或流数据的最长空闲时间；设为 `0` 可关闭 |
| `OPENCODE_ZEN_BASE_URL` | `https://opencode.ai/zen/v1` | 上游基础地址 |
| `OPENCODE_PROXY_UA` | `opencode/latest/2.0.32/cli` | 上游 User-Agent |
| `OPENCODE_PROXY_SESSION` | 自动生成 | 固定 `ses_...` 会话 |
| `OPENCODE_PROXY_PROJECT` | 自动生成 | 固定 32 位十六进制项目 ID |
| `OPENCODE_PROXY_AUTH` | `public` | 上游 Bearer Token |
| `OPENCODE_PROXY_PASSTHROUGH_AUTH` | 未设置 | 设为 `1` 时透传客户端的 Authorization |

## 限制

- 仅支持 Chat Completions。Embeddings、图片生成、音频、Responses API 与 Anthropic Messages 均未实现。
- 上游免费层检查属于启发式客户端指纹，可能随时变化。
- 代理会注入一个最小的 `read` 工具标记。调用方未提供工具时强制设置 `tool_choice: "none"`；提供工具时会加入系统提示，要求模型不要调用该标记。上游返回的 `read` 调用会按完整工具调用移除，不会泄漏跨分片的孤立参数。
- 默认只监听回环地址；除非增加认证层，否则不要公开暴露。

不要提交真实 API Key。从其他 agent 使用免费层前，请确认并遵守上游服务条款。
