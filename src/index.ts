/**
 * Loopback model-API proxy that spreads requests across several API keys.
 *
 * A provider route points its `baseURL` at `http://127.0.0.1:<port>` and
 * authenticates with a local token; the proxy admits each request onto a key
 * whose request-rate and token budgets allow it, waits when none does, and
 * resends on another key when the provider reports one exhausted.
 *
 * @module dsh-llm-key-pool
 */

import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { KeyPool, type KeyLimits } from './pool.ts'
import { startProxy, type ProxyAttempt, type UpstreamRetry } from './proxy.ts'

export type { KeyLease, KeyLimits } from './pool.ts'
export { KeyPool } from './pool.ts'
export type { KeyPoolProxy, ProxyAttempt, ProxyOptions, UpstreamRetry } from './proxy.ts'
export { startProxy } from './proxy.ts'

export const name = 'llm-key-pool'
export const inject = ['credentials']

/** Proxy listener, upstream, credentials, and per-key limits. */
export interface Config {
  /** Loopback port the provider route's `baseURL` names. */
  port: number
  /** Upstream base URL that `http://127.0.0.1:<port>` stands for. */
  upstream: string
  /** Credential reference of the local token the provider route sends as its key. */
  tokenEnv: string
  /** Credential references of the pooled API keys. */
  keys: string[]
  /** Provider limits of each key. */
  limits: KeyLimits
  /** Internal backoff for upstream refusals that no key change avoids. */
  upstreamRetry: UpstreamRetry
  /**
   * JSON Lines file that receives one line per upstream attempt, naming the
   * key by its credential reference; omission records nothing. The file only
   * grows: remove or rotate it yourself.
   */
  attemptLog?: string
}

const positive = (description: string): z<number> => z.number().min(Number.MIN_VALUE).required().description(description)

export const Config: z<Config> = z.object({
  port: z.natural().max(65535).required()
    .description('Loopback port the provider route\'s baseURL names; 0 binds a random port, which only tests can reach.'),
  upstream: z.string().required()
    .description('Upstream base URL, such as https://token.sensenova.cn/v1.'),
  tokenEnv: z.string().role('credential-ref').required()
    .description('Credential reference of the local token clients present; also set as the provider route\'s apiKeyEnv.'),
  keys: z.array(z.string().role('credential-ref')).required()
    .description('Credential references of the pooled API keys.'),
  limits: z.object({
    requestsPerSecond: positive('Request starts the provider admits per second on one key.'),
    tokensPerMinute: positive('Tokens one key may consume within one window, cached input included.'),
    windowMs: positive('Length of the provider\'s token-accounting window in milliseconds.'),
  }).required(),
  upstreamRetry: z.object({
    maxWaitMs: z.natural().required().description('Longest total backoff one request spends on upstream refusals before the client receives the refusal.'),
    initialDelayMs: positive('First backoff delay; each later delay doubles.'),
    maxDelayMs: positive('Largest single backoff delay.'),
  }).required(),
  attemptLog: z.string()
    .description('JSON Lines file receiving one line per upstream attempt (key credential name, outcome, timings, tokens, request id); omit to record nothing.'),
})

/**
 * Validate the configuration, resolve every credential once so a missing one
 * fails the plugin at load, and listen until the plugin is disposed.
 * @param ctx - plugin context with the credentials service.
 * @param config - validated plugin configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.keys.length === 0) throw new Error('llm-key-pool: keys must name at least one credential reference')
  const upstream = new URL(config.upstream).href.replace(/\/+$/, '')
  const tokenRef = credentialRef(config.tokenEnv)
  const keyRefs = config.keys.map(credentialRef)

  const resolve = async (ref: CredentialRef): Promise<string> => {
    const value = (await ctx.credentials.resolve(ref))?.value
    if (value === undefined || value.length === 0) {
      throw new Error(`llm-key-pool: credential ${ref} is not set; store it in $DSH_HOME/.credentials.yaml or $DSH_HOME/.env`)
    }
    return value
  }
  await Promise.all([tokenRef, ...keyRefs].map(resolve))

  const pool = new KeyPool(keyRefs.length, config.limits)
  await ctx.effect(async () => {
    let attempts: WriteStream | undefined
    if (config.attemptLog !== undefined) {
      await mkdir(dirname(config.attemptLog), { recursive: true })
      attempts = createWriteStream(config.attemptLog, { flags: 'a', mode: 0o600 })
      attempts.on('error', (error) => { ctx.logger.warn('attempt log %s: %s', config.attemptLog, error.message) })
    }
    const record = (attempt: ProxyAttempt): void => {
      const { key, ...rest } = attempt
      attempts?.write(JSON.stringify({ at: new Date().toISOString(), key: keyRefs[key], ...rest }) + '\n')
    }
    const proxy = await startProxy({
      port: config.port,
      upstream,
      // Credentials resolve per request, so a rotated key applies without a reload.
      token: () => resolve(tokenRef),
      key: index => resolve(keyRefs[index]!),
      pool,
      upstreamRetry: config.upstreamRetry,
      log: (attempt) => {
        record(attempt)
        if (attempt.outcome === 'answered') {
          ctx.logger.debug('key %d answered %d after %dms: %d tokens', attempt.key + 1, attempt.status, attempt.headersMs, attempt.tokens)
        } else {
          ctx.logger.info('key %d %s after %dms: %s', attempt.key + 1, attempt.outcome, attempt.headersMs, attempt.code ?? `HTTP ${attempt.status}`)
        }
      },
    })
    ctx.logger.info('proxying %s through http://127.0.0.1:%d with %d keys', upstream, proxy.port, keyRefs.length)
    return async () => {
      await proxy.close()
      await new Promise<void>(resolve => attempts === undefined ? resolve() : attempts.end(resolve))
    }
  }, 'llm-key-pool.listen')
}
