import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'

let root: string | undefined
let context: Context | undefined
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const close of closers.splice(0)) await close()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A loopback port free at the time of the call. */
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

/** A fake upstream answering every request with the bearer key it received. */
async function echoUpstream(): Promise<string> {
  const server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ authorization: req.headers.authorization, usage: { total_tokens: 1 } }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
}

async function boot(port: number, upstream: string, refs: Record<string, string>): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-key-pool-loader-'))
  const credentials = join(root, '.credentials.yaml')
  await writeFile(credentials, ['version: 1', 'refs:', ...Object.entries(refs).map(([name, value]) => `  ${name}: ${value}`), ''].join('\n'))
  await chmod(credentials, 0o600)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentials)}`,
    '    watch: false',
    "- name: 'dsh-llm-key-pool'",
    '  config:',
    `    port: ${port}`,
    `    upstream: ${upstream}`,
    '    tokenEnv: POOL_TOKEN',
    '    keys: [POOL_KEY_1, POOL_KEY_2]',
    '    limits: { requestsPerSecond: 1, tokensPerMinute: 60000, windowMs: 60000 }',
    '    upstreamRetry: { maxWaitMs: 1000, initialDelayMs: 10, maxDelayMs: 50 }',
    '',
  ].join('\n'))

  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Without Node's internal loader the Loader imports each bare name through Vitest, which
  // resolves this package to source.
  ctx.loader.internal = undefined
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

function call(port: number, token: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
}

describe('dsh-llm-key-pool composition', () => {
  it('serves configured keys from the credential store and releases its port on dispose', async () => {
    const port = await freePort()
    context = await boot(port, await echoUpstream(), { POOL_TOKEN: 'local-token', POOL_KEY_1: 'sk-one', POOL_KEY_2: 'sk-two' })

    const answers = await Promise.all([call(port, 'local-token'), call(port, 'local-token')])
    const keys = await Promise.all(answers.map(async res => (await res.json() as { authorization: string }).authorization))
    expect(keys.sort()).toEqual(['Bearer sk-one', 'Bearer sk-two'])

    await context.fiber.dispose()
    context = undefined
    await expect(call(port, 'local-token')).rejects.toThrow()
  })
})
