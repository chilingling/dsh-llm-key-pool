/**
 * Loopback HTTP proxy that replaces the client's local token with a pool key.
 *
 * @module dsh-llm-key-pool/proxy
 */

import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { KeyPool } from './pool.ts'
import { UsageReader } from './usage.ts'

/** Loopback only: the proxy spends real keys for anyone who can reach it. */
const HOST = '127.0.0.1'

/** Request headers the proxy owns or that describe the client connection. */
const DROPPED_REQUEST_HEADERS = new Set(['host', 'authorization', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'accept-encoding'])

/** Response headers invalidated by `fetch` decoding the upstream body. */
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'content-length', 'content-encoding', 'transfer-encoding'])

/** Internal retry of rate-limit refusals that no key change can avoid. */
export interface UpstreamRetry {
  /** Longest total backoff spent on one request before the refusal reaches the client. */
  maxWaitMs: number
  /** First backoff delay; each later delay doubles. */
  initialDelayMs: number
  /** Largest single backoff delay. */
  maxDelayMs: number
}

/** One upstream attempt, reported after its outcome is known. */
export interface ProxyAttempt {
  /** Index of the pool key the attempt used. */
  key: number
  /** Upstream HTTP status. */
  status: number
  /**
   * `answered`: the answer reached the client; `key-exhausted`: the provider
   * refused this key's budget and another key is tried; `upstream-refused`: a
   * rate-limit refusal that no key change avoids.
   */
  outcome: 'answered' | 'key-exhausted' | 'upstream-refused'
  /** Provider error code of a refusal. */
  code?: string
  /** Usage charged to the key for an answer. */
  tokens?: number
  /** Milliseconds from sending the request to receiving the upstream headers. */
  headersMs: number
}

/** Everything {@link startProxy} needs; values are resolved per request. */
export interface ProxyOptions {
  /** Loopback port; `0` asks the OS for a free one. */
  port: number
  /** Upstream base URL that the proxy's root path stands for. */
  upstream: string
  /** Current local token clients must present as their bearer key. */
  token: () => Promise<string>
  /** Current value of the pool key at `index`. */
  key: (index: number) => Promise<string>
  /** Scheduler admitting each request onto one key. */
  pool: KeyPool
  /** Backoff for upstream refusals that are not tied to one key. */
  upstreamRetry: UpstreamRetry
  /** Receives every upstream attempt. */
  log?: (attempt: ProxyAttempt) => void
}

/** A listening proxy. */
export interface KeyPoolProxy {
  /** Bound loopback port. */
  readonly port: number
  /** Stop listening and drop open connections. */
  close(): Promise<void>
}

/**
 * Start the proxy on the loopback interface.
 * @param options - listener, upstream, credentials, and scheduling.
 * @returns the listening proxy once the port is bound.
 * @throws the listen error, such as `EADDRINUSE`.
 */
export async function startProxy(options: ProxyOptions): Promise<KeyPoolProxy> {
  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port
    // A browser page that rebinds its own name to 127.0.0.1 still sends that name as Host.
    if (req.headers.host !== `${HOST}:${port}` && req.headers.host !== `localhost:${port}`) {
      sendError(res, 403, 'permission_error', 'key-pool proxy: requests must address the loopback host')
      return
    }
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new Error('key-pool proxy: client disconnected'))
    })
    void handle(options, req, res, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return // The client is gone; nothing can receive the failure.
      if (!res.headersSent) sendError(res, 502, 'api_error', `key-pool proxy: ${error instanceof Error ? error.message : String(error)}`)
      else res.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => {
      server.close(() => { resolve() })
      server.closeAllConnections()
    }),
  }
}

async function handle(options: ProxyOptions, req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
  if (!bearerMatches(req.headers.authorization, await options.token())) {
    sendError(res, 401, 'authentication_error', 'key-pool proxy: missing or wrong local token')
    return
  }
  const body = await readBody(req)
  const estimate = Math.ceil(body.length / 4)
  let waitedMs = 0
  for (let refusals = 0; ; ) {
    const lease = await options.pool.acquire(estimate, signal)
    const sentAt = Date.now()
    let upstream: Response
    try {
      upstream = await fetch(options.upstream + (req.url ?? '/'), {
        method: req.method ?? 'GET',
        headers: { ...forwardedHeaders(req.headers), Authorization: `Bearer ${await options.key(lease.key)}` },
        ...body.length > 0 ? { body } : {},
        signal,
      })
    } catch (error: unknown) {
      lease.release()
      throw error
    }
    const headersMs = Date.now() - sentAt
    if (upstream.status === 429) {
      const text = await upstream.text()
      const error = providerError(text)
      const limit = exhaustedKeyLimit(error)
      options.log?.({
        key: lease.key, status: 429, outcome: limit === undefined ? 'upstream-refused' : 'key-exhausted', headersMs,
        ...error?.code === undefined ? {} : { code: error.code },
      })
      if (limit !== undefined) {
        lease.reject(limit)
        continue
      }
      lease.release()
      const { initialDelayMs, maxDelayMs, maxWaitMs } = options.upstreamRetry
      const delayMs = Math.min(initialDelayMs * 2 ** refusals, maxDelayMs)
      if (waitedMs + delayMs <= maxWaitMs) {
        refusals++
        waitedMs += delayMs
        await new Promise(resolve => setTimeout(resolve, delayMs))
        signal.throwIfAborted()
        continue
      }
      res.writeHead(upstream.status, responseHeaders(upstream.headers))
      res.end(text)
      return
    }
    res.writeHead(upstream.status, responseHeaders(upstream.headers))
    const usage = new UsageReader(upstream.headers.get('content-type')?.includes('text/event-stream') === true)
    try {
      if (upstream.body !== null) {
        for await (const chunk of upstream.body) {
          usage.push(chunk)
          res.write(chunk)
        }
      }
      res.end()
    } finally {
      // An interrupted answer still spent provider tokens; charge the estimate when no usage arrived.
      const tokens = usage.finish() ?? estimate
      lease.settle(tokens)
      options.log?.({ key: lease.key, status: upstream.status, outcome: 'answered', tokens, headersMs })
    }
    return
  }
}

/** The `error` object of an OpenAI-style error body, or `undefined` when the body has none. */
function providerError(text: string): { code?: string; message?: string } | undefined {
  let error: { code?: unknown; message?: unknown } | undefined
  try {
    error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error
  } catch {
    return undefined
  }
  if (typeof error !== 'object' || error === null) return undefined
  return {
    ...typeof error.code === 'string' ? { code: error.code } : {},
    ...typeof error.message === 'string' ? { message: error.message } : {},
  }
}

/**
 * The per-key limit a 429 error reports as exhausted, or `undefined` for a
 * refusal another key cannot avoid. SenseNova reports per-key limits with
 * error code `8` and the messages `rps exhausted` and `tpm exhausted`.
 */
function exhaustedKeyLimit(error: { code?: string; message?: string } | undefined): 'rps' | 'tpm' | undefined {
  if (error?.code !== '8' || error.message === undefined) return undefined
  if (/\brps exhausted\b/.test(error.message)) return 'rps'
  if (/\btpm exhausted\b/.test(error.message)) return 'tpm'
  return undefined
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = Buffer.from(header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '')
  const expected = Buffer.from(token)
  return presented.length === expected.length && timingSafeEqual(presented, expected)
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function forwardedHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue
    out[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

function responseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) out[name] = value
  })
  return out
}

/** Answer with the OpenAI error envelope that clients already parse. */
function sendError(res: ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message, type } }))
}
