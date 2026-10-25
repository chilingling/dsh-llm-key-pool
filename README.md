# dsh-llm-key-pool

A DeepSeek Harness bundle that runs a loopback proxy in front of an OpenAI-compatible model API and spreads requests across several API keys within each key's provider limits. Provider adapters are unchanged: a route points its `baseURL` at the proxy and authenticates with a local token.

## Install

```sh
pnpm install && pnpm build
pnpm dsh plugin --profile web add /path/to/dsh-llm-key-pool   # from a deepseek-harness checkout
```

`dsh plugin add` links the checkout and appends the bundle to the profile, whose patch [`cordis.patch.yml`](cordis.patch.yml) mounts the proxy with SenseNova defaults. Store the local token and the pooled keys under their credential names in `$DSH_HOME/.env` or `$DSH_HOME/.credentials.yaml`, then point the provider route at the proxy in the profile's `cordis.patch.yml`:

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

Every credential must resolve when the plugin loads, and the port must be free; otherwise loading fails with the credential name or the listen error.

## Behavior

Each request waits in arrival order until some key has passed its request-rate gap and has window usage plus in-flight estimates under its token budget, then goes to the least recently started such key. The provider admits any single request while a key's budget is not yet exhausted, so one request may exceed the budget; the key then rests until that usage leaves the window. Usage comes from the answer's `total_tokens` (Chat Completions final chunk, Responses `response.completed`, or the JSON body); an answer without usage, including an interrupted one, is charged its request-size estimate.

A 429 with SenseNova error code `8` (`rps exhausted` or `tpm exhausted`) marks that key exhausted and resends at once on another key. Any other 429 is an upstream refusal that no key change avoids: the proxy backs off and resends until `maxWaitMs` would be exceeded, then returns the refusal so the client's own retry policy applies. Internal resends happen before any answer byte reaches the client, so they are invisible to the session and are not recorded as `llm/retry` events; the plugin logs each attempt (`info` for refusals, `debug` for answers).

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
