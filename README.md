# dsh-llm-key-pool

English | [简体中文](README.zh-CN.md)

A DeepSeek Harness bundle that runs a loopback proxy in front of an OpenAI-compatible model API and spreads requests across several API keys within each key's provider limits. Provider adapters are unchanged: a route points its `baseURL` at the proxy and authenticates with a local token.

## Install

Install a release from GitHub:

```sh
dsh plugin --profile web add github:chilingling/dsh-llm-key-pool#v0.1.0
```

Version 0.1.0 requires DeepSeek Harness 0.2.2-alpha.2 or a later 0.2 release.

pnpm builds the plugin through its `prepare` script during installation, and blocks that script until it is allowed. On the first attempt, add the key pnpm prints under `allowBuilds` in the profile's `pnpm-workspace.yaml` and run the command again; the Web **Plugins** page offers **Allow these scripts and retry** instead.

To develop from a local checkout:

```sh
pnpm install && pnpm build
pnpm dsh plugin --profile web add /path/to/dsh-llm-key-pool   # from a deepseek-harness checkout
```

`dsh plugin add` links the checkout and appends the bundle to the profile. After code changes, rebuild and restart the profile.

## Set up

Either way, the bundle's patch [`cordis.patch.yml`](cordis.patch.yml) mounts the proxy with SenseNova defaults: port `18790`, the local token `SENSENOVA_POOL_TOKEN`, and seven pooled keys `SENSENOVA_API_KEY_1` through `SENSENOVA_API_KEY_7`. Store the local token and the pooled keys under their credential names in `$DSH_HOME/.env` or `$DSH_HOME/.credentials.yaml`. The local token is any secret you choose; the proxy only compares it with what the route sends.

Then point the provider route at the proxy in the profile's `cordis.patch.yml`. A patch row replaces the row's whole `config`, so if the profile already configures `llm-pi-ai`, add the provider to that row's `providers` instead of writing a second row:

```yaml
- id: llm-pi-ai
  config:
    providers:
      sensenova:
        apiKeyEnv: SENSENOVA_POOL_TOKEN
        api: openai-completions
        baseURL: http://127.0.0.1:18790
```

The proxy's root path stands for `upstream`, so `http://127.0.0.1:18790/chat/completions` reaches `https://token.sensenova.cn/v1/chat/completions`. Chat Completions, Responses, and model listing pass through unchanged.

To pool a different number of keys or another OpenAI-compatible provider, override the `llm-key-pool` row in the profile's `cordis.patch.yml`. The override replaces the bundle's whole config, so restate every field:

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

Only SenseNova's per-key refusals are recognized as exhausting one key (see [Behavior](#behavior)); with another provider, every 429 takes the backoff path, so set `limits` to that provider's per-key limits.

## Configuration

| Field | Meaning |
|---|---|
| `port` | Loopback port the route's `baseURL` names; two processes cannot share one port, so profiles running at the same time need different ports |
| `upstream` | Upstream base URL |
| `tokenEnv` | Credential name of the local token; the same name is the route's `apiKeyEnv` |
| `keys` | Credential names of the pooled keys; values resolve per request, so a rotated key applies without a restart |
| `limits.requestsPerSecond` | Request starts one key admits per second |
| `limits.tokensPerMinute` | Tokens one key may consume per window, cached input included |
| `limits.windowMs` | Length of the token window |
| `upstreamRetry.maxWaitMs` | Total backoff one request spends on refusals that no key change avoids before the client receives the refusal |
| `upstreamRetry.initialDelayMs` / `maxDelayMs` | First and largest backoff delay; delays double |
| `attemptLog` | JSON Lines file receiving one line per upstream attempt; the bundle writes `$DSH_HOME/logs/llm-key-pool.jsonl`, and omission records nothing |

Every credential must resolve when the plugin loads, and the port must be free; otherwise loading fails with the credential name or the listen error.

## Behavior

Each request waits in arrival order until some key has passed its request-rate gap and has window usage plus in-flight estimates under its token budget, then goes to the least recently started such key. The provider admits any single request while a key's budget is not yet exhausted, so one request may exceed the budget; the key then rests until that usage leaves the window. Usage comes from the answer's `total_tokens` (Chat Completions final chunk, Responses `response.completed`, or the JSON body); an answer without usage, including an interrupted one, is charged its request-size estimate.

A 429 with SenseNova error code `8` (`rps exhausted` or `tpm exhausted`) marks that key exhausted and resends at once on another key. Any other 429 is an upstream refusal that no key change avoids: the proxy backs off and resends until `maxWaitMs` would be exceeded, then returns the refusal so the client's own retry policy applies. Internal resends happen before any answer byte reaches the client, so they are invisible to the session and are not recorded as `llm/retry` events; the plugin logs each attempt (`info` for refusals, `debug` for answers).

Each `attemptLog` line holds `at`, `key` (the credential name, never its value), `status`, `outcome` (`answered`, `key-exhausted`, or `upstream-refused`), the provider error `code`, `queuedMs` spent waiting for a key, `headersMs` until the upstream headers, charged `tokens`, the request `path`, and the upstream `requestId`. Request and answer bodies are not recorded. The file only grows; remove or rotate it yourself.

The proxy listens on `127.0.0.1` only, requires the local token, and refuses requests whose `Host` is not the loopback address, so a web page cannot spend the keys through DNS rebinding.

## Measured SenseNova limits

Measured on 2026-10-25 for `deepseek-flash`: per key about one request start per second and 60,000 tokens per 60-second window, with no observed concurrent-request cap; the shared upstream endpoint also refuses 50 to 65 percent of requests with `RateLimitExceeded.Endpoint*`, independent of the key, and takes 10 to 16 seconds to refuse a request of about 260,000 tokens. Smaller requests therefore help more than additional keys once each step already lands on a fresh key.

## Known limitations

- Scheduling state belongs to one process; two dsh processes using the same keys do not see each other's usage.
- The local estimate of an in-flight request is its body size divided by four; image-heavy requests overestimate it.

## Development

```sh
pnpm test        # pool scheduling, proxy HTTP behavior, Loader composition
pnpm typecheck
pnpm build
```
