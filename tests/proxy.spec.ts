import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { KeyPool } from '../src/pool.ts'
import { startProxy, type KeyPoolProxy, type ProxyOptions } from '../src/proxy.ts'

interface Received {
  path: string
  authorization: string | undefined
  body: string
  at: number
}

type Respond = (received: Received, res: ServerResponse) => void

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** A fake upstream that records each request and answers through `respond`. */
async function upstream(respond: Respond): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const entry = { path: req.url ?? '', authorization: req.headers.authorization, body: Buffer.concat(chunks).toString(), at: Date.now() }
      received.push(entry)
      respond(entry, res)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, received }
}

const KEYS = ['sk-key-a', 'sk-key-b']
const TOKEN = 'local-token'

async function proxy(upstreamUrl: string, overrides: Partial<ProxyOptions> = {}): Promise<KeyPoolProxy> {
  const started = await startProxy({
    port: 0,
    upstream: upstreamUrl,
    token: () => Promise.resolve(TOKEN),
    key: index => Promise.resolve(KEYS[index]!),
    pool: new KeyPool(KEYS.length, { requestsPerSecond: 1000, tokensPerMinute: 60_000, windowMs: 60_000 }),
    upstreamRetry: { maxWaitMs: 1000, initialDelayMs: 10, maxDelayMs: 50 },
    ...overrides,
  })
  closers.push(() => started.close())
  return started
}

function post(target: KeyPoolProxy, path: string, body: unknown, token = TOKEN): Promise<Response> {
  return fetch(`http://127.0.0.1:${target.port}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

describe('key-pool proxy', () => {
  it('forwards a request under the upstream base URL with a pool key and returns the upstream answer', async () => {
    const up = await upstream((_received, res) => json(res, 200, { id: 'chat-1', usage: { total_tokens: 12 } }))
    const target = await proxy(up.url)
    const res = await post(target, '/chat/completions', { model: 'deepseek-flash', messages: [] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'chat-1', usage: { total_tokens: 12 } })
    expect(up.received).toHaveLength(1)
    expect(up.received[0]!.path).toBe('/v1/chat/completions')
    expect(KEYS.map(key => `Bearer ${key}`)).toContain(up.received[0]!.authorization)
    expect(JSON.parse(up.received[0]!.body)).toEqual({ model: 'deepseek-flash', messages: [] })
  })

  it('refuses a request without the local token and never contacts the upstream', async () => {
    const up = await upstream((_received, res) => json(res, 200, {}))
    const target = await proxy(up.url)
    const res = await post(target, '/chat/completions', {}, 'wrong-token')
    expect(res.status).toBe(401)
    expect(up.received).toHaveLength(0)
  })

  it('refuses a request addressed to a host name other than the loopback address', async () => {
    const up = await upstream((_received, res) => json(res, 200, {}))
    const target = await proxy(up.url)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port: target.port, path: '/chat/completions', method: 'POST',
        headers: { Host: `rebound.example:${target.port}`, Authorization: `Bearer ${TOKEN}` },
      }, (res) => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject)
      req.end('{}')
    })
    expect(status).toBe(403)
    expect(up.received).toHaveLength(0)
  })

  it('resends on another key when the provider reports the first key exhausted', async () => {
    const up = await upstream((received, res) => {
      if (received.authorization === 'Bearer sk-key-a') json(res, 429, { error: { message: 'tpm exhausted', type: 'quota_exceeded_error', code: '8' } })
      else json(res, 200, { id: 'chat-2', usage: { total_tokens: 7 } })
    })
    const target = await proxy(up.url)
    const res = await post(target, '/chat/completions', { messages: [] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'chat-2', usage: { total_tokens: 7 } })
    expect(up.received.map(entry => entry.authorization)).toEqual(['Bearer sk-key-a', 'Bearer sk-key-b'])
  })

  const ENDPOINT_LIMITED = { error: { message: 'inference exceeds tpm/rpm limit', type: 'rate_limit_error', code: 'RateLimitExceeded.EndpointRPMExceeded' } }

  it('retries an upstream rate-limit refusal internally until the upstream accepts', async () => {
    let calls = 0
    const up = await upstream((_received, res) => {
      calls++
      if (calls < 3) json(res, 429, ENDPOINT_LIMITED)
      else json(res, 200, { id: 'chat-3' })
    })
    const target = await proxy(up.url)
    const res = await post(target, '/chat/completions', { messages: [] })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 'chat-3' })
    expect(up.received).toHaveLength(3)
  })

  it('backs off instead of switching keys when error code 8 names no per-key limit', async () => {
    let calls = 0
    const up = await upstream((_received, res) => {
      calls++
      if (calls === 1) json(res, 429, { error: { message: 'inference exceeds tpm/rpm limit', type: 'rate_limit_error', code: '8' } })
      else json(res, 200, { usage: { total_tokens: 3 } })
    })
    const attempts: unknown[] = []
    const target = await proxy(up.url, { log: attempt => attempts.push(attempt) })
    await (await post(target, '/chat/completions', {})).text()
    expect(attempts).toMatchObject([
      { status: 429, outcome: 'upstream-refused', code: '8' },
      { status: 200, outcome: 'answered' },
    ])
  })

  it('reports every upstream attempt with its key, outcome, and provider error code and message', async () => {
    let calls = 0
    const up = await upstream((received, res) => {
      calls++
      if (received.authorization === 'Bearer sk-key-a') json(res, 429, { error: { message: 'tpm exhausted', type: 'quota_exceeded_error', code: '8' } })
      else if (calls === 2) json(res, 429, ENDPOINT_LIMITED)
      else json(res, 200, { usage: { total_tokens: 3 } })
    })
    const attempts: unknown[] = []
    const target = await proxy(up.url, { log: attempt => attempts.push(attempt) })
    await (await post(target, '/chat/completions', {})).text()
    expect(attempts).toMatchObject([
      { key: 0, status: 429, outcome: 'key-exhausted', code: '8', message: 'tpm exhausted' },
      { key: 1, status: 429, outcome: 'upstream-refused', code: 'RateLimitExceeded.EndpointRPMExceeded', message: 'inference exceeds tpm/rpm limit' },
      { key: 1, status: 200, outcome: 'answered', tokens: 3 },
    ])
  })

  it('reports how long an attempt waited for a key, its path, and the upstream request id', async () => {
    const up = await upstream((_received, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': `req-${up.received.length}` })
      res.end(JSON.stringify({ usage: { total_tokens: 1 } }))
    })
    const attempts: { queuedMs: number }[] = []
    const target = await proxy(up.url, {
      key: () => Promise.resolve('sk-only'),
      pool: new KeyPool(1, { requestsPerSecond: 2, tokensPerMinute: 60_000, windowMs: 60_000 }),
      log: attempt => attempts.push(attempt),
    })
    await (await post(target, '/chat/completions', {})).text()
    await (await post(target, '/chat/completions', {})).text()
    expect(attempts).toMatchObject([
      { path: '/chat/completions', requestId: 'req-1' },
      { path: '/chat/completions', requestId: 'req-2' },
    ])
    expect(attempts[0]!.queuedMs).toBeLessThan(100)
    // The second start waits out the 500 ms request-rate gap of the only key.
    expect(attempts[1]!.queuedMs).toBeGreaterThanOrEqual(400)
  })

  it('hands the upstream refusal to the client once internal backoff would exceed its budget', async () => {
    const up = await upstream((_received, res) => json(res, 429, ENDPOINT_LIMITED))
    const target = await proxy(up.url, { upstreamRetry: { maxWaitMs: 100, initialDelayMs: 20, maxDelayMs: 40 } })
    const started = Date.now()
    const res = await post(target, '/chat/completions', { messages: [] })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual(ENDPOINT_LIMITED)
    // Delays 20, 40, 40 fit the 100 ms budget; the next 40 would not.
    expect(up.received).toHaveLength(4)
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })

  const sse = (events: readonly unknown[]): string => events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
  const REPORTED_USAGE: Record<string, { contentType: string; body: string }> = {
    'Chat Completions stream': {
      contentType: 'text/event-stream',
      body: sse([{ choices: [{ delta: { content: 'hi' } }] }, { choices: [], usage: { prompt_tokens: 1400, completion_tokens: 100, total_tokens: 1500 } }]) + 'data: [DONE]\n\n',
    },
    'Responses stream': {
      contentType: 'text/event-stream',
      body: sse([{ type: 'response.output_text.delta', delta: 'hi' }, { type: 'response.completed', response: { usage: { input_tokens: 1400, output_tokens: 100, total_tokens: 1500 } } }]),
    },
    'non-streaming JSON': {
      contentType: 'application/json',
      body: JSON.stringify({ id: 'chat-4', usage: { total_tokens: 1500 } }),
    },
  }

  it.each(Object.keys(REPORTED_USAGE))('charges the usage reported in a %s answer to its key before the next start', async (kind) => {
    const answer = REPORTED_USAGE[kind]!
    const up = await upstream((_received, res) => {
      res.writeHead(200, { 'Content-Type': answer.contentType })
      res.end(answer.body)
    })
    const target = await proxy(up.url, {
      key: () => Promise.resolve('sk-only'),
      pool: new KeyPool(1, { requestsPerSecond: 1000, tokensPerMinute: 1000, windowMs: 300 }),
    })
    const first = await post(target, '/chat/completions', { stream: true })
    expect(await first.text()).toBe(answer.body)
    await post(target, '/chat/completions', { stream: true })
    expect(up.received[1]!.at - up.received[0]!.at).toBeGreaterThanOrEqual(300)
  })

  it('never sends a request whose client disconnected while it waited for a key', async () => {
    const up = await upstream((_received, res) => json(res, 200, { usage: { total_tokens: 1 } }))
    const target = await proxy(up.url, {
      key: () => Promise.resolve('sk-only'),
      pool: new KeyPool(1, { requestsPerSecond: 2, tokensPerMinute: 60_000, windowMs: 60_000 }),
    })
    await post(target, '/chat/completions', {})
    const controller = new AbortController()
    const queued = fetch(`http://127.0.0.1:${target.port}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}', signal: controller.signal,
    })
    await new Promise(resolve => setTimeout(resolve, 100))
    controller.abort()
    await expect(queued).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(up.received).toHaveLength(1)
  })

  it('aborts the upstream request when the client disconnects mid-stream', async () => {
    let upstreamClosed: () => void = () => {}
    const closed = new Promise<void>((resolve) => { upstreamClosed = resolve })
    const up = await upstream((_received, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: {"choices":[]}\n\n')
      res.on('close', () => upstreamClosed())
    })
    const target = await proxy(up.url)
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${target.port}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}', signal: controller.signal,
    })
    const reader = res.body!.getReader()
    await reader.read()
    controller.abort()
    await closed
    expect(up.received).toHaveLength(1)
  })

  it('answers 502 when the upstream is unreachable and frees the key for later requests', async () => {
    const unreachable = await upstream(() => {})
    await closers.pop()!()
    const target = await proxy(unreachable.url, {
      key: () => Promise.resolve('sk-only'),
      // Each request's estimate alone fills the budget, so a leaked lease would hold the key forever.
      pool: new KeyPool(1, { requestsPerSecond: 1000, tokensPerMinute: 10, windowMs: 60_000 }),
    })
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await post(target, '/chat/completions', { padding: 'x'.repeat(100) })
      expect(res.status).toBe(502)
      expect((await res.json() as { error: { type: string } }).error.type).toBe('api_error')
    }
  })
})
