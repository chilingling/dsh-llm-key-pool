# dsh-llm-key-pool

[English](README.md) | 简体中文

DeepSeek Harness 的多 key 调度插件。插件在 OpenAI 兼容的模型 API 前启动一个只监听本机回环地址的代理，在每个 key 的 provider 限额内，把请求分配到多个 API key 上。provider 适配器不需要修改：路由把 `baseURL` 指向代理，并使用本地 token 认证。

## 安装

从 GitHub 安装发布版本：

```sh
dsh plugin --profile web add github:chilingling/dsh-llm-key-pool#v0.1.0
```

0.1.0 版本要求 DeepSeek Harness 0.2.2-alpha.2 或之后的 0.2 版本。

安装时，pnpm 通过 `prepare` 脚本构建插件。pnpm 默认会拦截这个脚本，因此第一次安装会失败。按 pnpm 打印的提示，把它给出的 key 加入 profile 目录下 `pnpm-workspace.yaml` 的 `allowBuilds`，然后重新执行命令。也可以在 Web 的**插件**页面点击**允许这些脚本并重试**。

从本地仓库开发：

```sh
pnpm install && pnpm build
pnpm dsh plugin --profile web add /path/to/dsh-llm-key-pool   # 在 deepseek-harness 仓库中执行
```

`dsh plugin add` 会链接本仓库，并把 bundle 加入 profile。修改代码后，需要重新构建并重启该 profile。

## 配置接入

两种安装方式都由 bundle 的 patch 文件 [`cordis.patch.yml`](cordis.patch.yml) 挂载代理，并使用 SenseNova 的默认配置：端口 `18790`，本地 token 为 `SENSENOVA_POOL_TOKEN`，key 池为 `SENSENOVA_API_KEY_1` 到 `SENSENOVA_API_KEY_7` 共七个 key。按这些凭据名，把本地 token 和各个 key 写入 `$DSH_HOME/.env` 或 `$DSH_HOME/.credentials.yaml`。本地 token 可以是你自己生成的任意密钥，代理只把它与路由发送的值比较。

然后在 profile 的 `cordis.patch.yml` 中把 provider 路由指向代理。patch 行会替换目标行的整个 `config`，因此如果 profile 已经配置了 `llm-pi-ai`，请把下面的 provider 加到该行已有的 `providers` 中，不要再写一行：

```yaml
- id: llm-pi-ai
  config:
    providers:
      sensenova:
        apiKeyEnv: SENSENOVA_POOL_TOKEN
        api: openai-completions
        baseURL: http://127.0.0.1:18790
```

代理的根路径对应 `upstream`，因此 `http://127.0.0.1:18790/chat/completions` 会转发到 `https://token.sensenova.cn/v1/chat/completions`。Chat Completions、Responses 和模型列表请求都原样转发。

如果 key 数量不是七个，或者要接入其他 OpenAI 兼容的 provider，请在 profile 的 `cordis.patch.yml` 中覆盖 `llm-key-pool` 行。覆盖会替换 bundle 的整个 config，因此需要写出所有字段：

```yaml
- id: llm-key-pool
  config:
    port: 18790
    upstream: https://token.sensenova.cn/v1
    tokenEnv: SENSENOVA_POOL_TOKEN
    keys: [SENSENOVA_API_KEY_1, SENSENOVA_API_KEY_2]
    limits: { requestsPerSecond: 1, tokensPerMinute: 60000, windowMs: 60000 }
    upstreamRetry: { maxWaitMs: 60000, initialDelayMs: 1000, maxDelayMs: 8000 }
    attemptLog: !!js "(process.env.DSH_HOME || process.env.HOME + '/.dsh') + '/logs/llm-key-pool.jsonl'"
```

插件只能识别 SenseNova 的单 key 限额拒绝（见[行为](#行为)）。接入其他 provider 时，所有 429 都按退避重试处理，因此请把 `limits` 设为该 provider 的单 key 限额。

## 配置项

| 字段 | 含义 |
|---|---|
| `port` | 路由 `baseURL` 中的回环端口；一个端口只能被一个进程监听，同时运行的多个 profile 需要使用不同端口 |
| `upstream` | 上游 base URL |
| `tokenEnv` | 本地 token 的凭据名；路由的 `apiKeyEnv` 使用同一个名字 |
| `keys` | key 池中各个 key 的凭据名；每个请求都会重新解析凭据值，因此轮换 key 后不需要重启 |
| `limits.requestsPerSecond` | 单个 key 每秒允许开始的请求数 |
| `limits.tokensPerMinute` | 单个 key 在一个窗口内可消耗的 token 数，包括命中缓存的输入 |
| `limits.windowMs` | token 统计窗口的长度 |
| `upstreamRetry.maxWaitMs` | 对于换 key 也无法避免的拒绝，单个请求累计退避的最长时间；超过后把拒绝返回给客户端 |
| `upstreamRetry.initialDelayMs` / `maxDelayMs` | 第一次和最长一次退避的延迟；每次延迟翻倍 |
| `attemptLog` | 每次上游尝试写一行的 JSON Lines 文件；bundle 默认写入 `$DSH_HOME/logs/llm-key-pool.jsonl`，省略时不记录 |

插件加载时，所有凭据都必须能解析，端口也必须空闲；否则加载失败，错误信息包含凭据名或监听错误。

## 行为

每个请求按到达顺序排队，直到某个 key 满足两个条件：距上次开始请求已超过请求速率间隔；窗口内已用量加上进行中请求的估算量低于 token 额度。请求随后分配给满足条件的 key 中最久没有开始请求的那个。provider 在 key 额度未用完时会接受任意单个请求，因此单个请求可能超出额度；此后该 key 暂停使用，直到这部分用量移出窗口。用量取自响应中的 `total_tokens`（Chat Completions 的最后一个 chunk、Responses 的 `response.completed` 事件，或 JSON 响应体）。没有返回用量的响应，包括中途断开的响应，按请求大小的估算值计入。

SenseNova 返回错误码 `8` 且 message 为 `rps exhausted` 或 `tpm exhausted` 的 429 时，代理把该 key 标记为额度用尽，并立即换另一个 key 重发。其他 429 属于换 key 也无法避免的上游拒绝，其中包括错误码 `8` 且 message 为 `inference exceeds tpm/rpm limit` 的拒绝，该 message 来自共享 endpoint 的限流：代理退避后重发，直到下一次退避会超过 `maxWaitMs`，然后把拒绝返回给客户端，由客户端自己的重试策略处理。内部重发都发生在任何响应字节到达客户端之前，因此会话看不到这些重发，也不会产生 `llm/retry` 事件。插件会记录每次尝试的日志（拒绝为 `info` 级别，正常响应为 `debug` 级别）。

`attemptLog` 的每一行包含：`at`、`key`（凭据名，不含凭据值）、`status`、`outcome`（`answered`、`key-exhausted` 或 `upstream-refused`）、拒绝时的 provider 错误码 `code` 和错误信息 `message`、等待 key 的时长 `queuedMs`、收到上游响应头的耗时 `headersMs`、计入的 `tokens`、请求路径 `path`，以及上游的 `requestId`。插件不记录请求体和响应体。该文件只会追加，需要自行删除或轮转。

代理只监听 `127.0.0.1`，要求客户端提供本地 token，并拒绝 `Host` 不是回环地址的请求，因此网页无法通过 DNS rebinding 使用这些 key。

## SenseNova 限额实测

2026-10-25 针对 `deepseek-flash` 的实测结果：单个 key 大约每秒允许开始一个请求，每 60 秒窗口 60,000 token，未观察到并发请求数限制。此外，共享的上游 endpoint 会以 `RateLimitExceeded.Endpoint*` 拒绝 50% 到 65% 的请求，这类拒绝与 key 无关；对于约 260,000 token 的请求，拒绝需要 10 到 16 秒才返回。因此，在每一步已经分配到空闲 key 的前提下，减小请求体积比增加 key 更有效。

## 已知限制

- 调度状态只存在于单个进程中；使用同一组 key 的两个 dsh 进程无法看到对方的用量。
- 进行中请求的本地估算值是请求体字节数除以四；图片较多的请求会被高估。

## 开发

```sh
pnpm test        # key 池调度、代理 HTTP 行为、Loader 组合
pnpm typecheck
pnpm build
```
