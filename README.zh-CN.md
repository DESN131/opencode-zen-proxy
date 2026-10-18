<h1 align="center">OpenCode Zen 代理</h1>

<p align="center">
  让其他 OpenAI 兼容软件使用 OpenCode Zen 免费模型<br>
  Chat Completions · Responses API · 流式输出 · 工具调用
</p>

<p align="center">
  <strong>简体中文</strong> ·
  <a href="README.md">English</a>
</p>

---

## 快速开始

**环境要求：** Node.js 20 或更高版本，无需安装 npm 依赖。

启动代理后，将其他 OpenAI 兼容软件或 agent 指向本地端点，即可使用 OpenCode Zen 免费模型。

```powershell
node opencode-zen-proxy.mjs
```

默认监听地址：`http://127.0.0.1:8787/v1`。

### 客户端配置

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key（免费模型） | `public` |
| API Key（付费模型） | 真实 OpenCode API Key |

### Responses API 示例

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

### Chat Completions 示例

```python
completion = client.chat.completions.create(
    model="big-pickle",
    messages=[{"role": "user", "content": "Say hello"}],
)

print(completion.choices[0].message.content)
```

## 功能

- 将 OpenCode Zen 免费模型代理给其他 OpenAI 兼容软件和 agent
- OpenAI 兼容的 Chat Completions 和 Responses 端点
- 流式请求直接透传 SSE
- 非流式请求自动聚合为 JSON
- 将 Responses 请求翻译为 Chat Completions，适配只支持 Chat 协议的模型
- 将 Chat Completions 事件翻译为 Responses API 的流式事件
- 为免费模型自动补充 OpenCode 兼容的请求标记
- 没有 npm 运行时依赖，只使用 Node.js 内置模块

## 免费模型与付费模型

### 免费模型

免费模型不需要真实 API Key。这是本代理的主要用途：让其他 OpenAI 兼容软件和 agent 通过本地代理调用 Zen 免费模型。客户端填写 `public` 或其他占位符即可。代理会自动补充上游免费层检查所需的 OpenCode 兼容请求标记。

### 付费模型

为代理提供真实 OpenCode API Key：

```powershell
$env:OPENCODE_PROXY_AUTH = "your-real-key"
node opencode-zen-proxy.mjs
```

或者透传客户端自己的 `Authorization`：

```powershell
$env:OPENCODE_PROXY_PASSTHROUGH_AUTH = "1"
node opencode-zen-proxy.mjs
```

付费模型由上游服务计费。代理会把 `401`、`402`、`429` 等上游错误原样返回。

## 端点

| 端点 | 说明 |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI 兼容的 Chat Completions |
| `POST /v1/responses` | Responses API，支持原生或翻译模式 |
| `GET /v1/models` | 获取上游模型列表 |
| `GET /health` | 本地代理健康检查 |

## Responses API 模式

通过 `OPENCODE_PROXY_RESPONSES_MODE` 控制 `/v1/responses` 的行为：

| 值 | 行为 |
| --- | --- |
| `auto`（默认） | 免费模型使用 Chat Completions 翻译；其他模型先尝试原生 Responses，遇到 `ModelProtocolUnsupported` 时自动回退 |
| `chat` | 始终将 Responses 请求翻译为 Chat Completions |
| `native` | 始终使用原生 Responses 端点 |

翻译范围包括：

- `instructions` 转为 system message
- `input` 字符串或数组转为 Chat Completions messages
- `function_call` 和 `function_call_output` 项目
- Responses 工具定义转为 Chat Completions 工具定义
- `tool_choice`、`max_output_tokens`、`reasoning.effort`
- 文本、推理内容、工具调用、usage 以及双向流式事件

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `OPENCODE_ZEN_BASE_URL` | `https://opencode.ai/zen/v1` | 上游基础地址 |
| `OPENCODE_PROXY_UA` | `opencode/latest/2.0.32/cli` | 上游 User-Agent |
| `OPENCODE_PROXY_SESSION` | 自动生成 | 固定 `ses_...` 会话 |
| `OPENCODE_PROXY_PROJECT` | 自动生成 | 固定 32 位十六进制项目 ID |
| `OPENCODE_PROXY_AUTH` | `public` | 上游 Bearer Token |
| `OPENCODE_PROXY_PASSTHROUGH_AUTH` | 未设置 | 设为 `1` 时透传客户端的 Authorization |
| `OPENCODE_PROXY_RESPONSES_MODE` | `auto` | `auto`、`chat` 或 `native` |

## 限制

- 目前只实现 Chat Completions 和 Responses。不支持 Anthropic `/messages`、Google `generateContent`、embeddings、图片和音频端点。
- Responses 翻译不支持 `previous_response_id`、后台任务、`web_search`/`file_search` 等托管工具，以及文件输入。
- 上游免费层检查属于启发式客户端指纹，可能随时变化。
- 代理会注入一个名为 `read` 的工具标记。调用方没有提供工具时，会设置 `tool_choice: "none"`，避免模型选择这个注入工具。
- 默认只监听 `127.0.0.1`。不要在未增加认证的情况下公开监听。

## 安全说明

- 不要把真实 API Key 提交到仓库或写入日志。
- 除非增加认证层，否则保持回环地址监听。
- 从其他 agent 使用免费层前，请确认并遵守上游服务的相关条款。
