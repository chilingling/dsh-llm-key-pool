/**
 * Per-key admission scheduling for one pool of API keys.
 *
 * @module dsh-llm-key-pool/pool
 */

/** Provider-enforced limits of one key; every key in a pool shares them. */
export interface KeyLimits {
  /** Request starts admitted per second on one key. */
  requestsPerSecond: number
  /** Tokens one key may consume within one {@link windowMs} window. */
  tokensPerMinute: number
  /** Length of the token-accounting window in milliseconds. */
  windowMs: number
}

/** One admitted request on one key; exactly one settling call ends it. */
export interface KeyLease {
  /** Index of the leased key within the pool. */
  readonly key: number
  /**
   * The request completed; record the usage the provider reported against this key's window.
   * @param tokens - every token the provider counts, cached input included.
   */
  settle(tokens: number): void
  /**
   * The provider refused this key's request rate (`rps`) or token budget
   * (`tpm`) before running the request. `tpm` rests the key for a whole
   * window, because local accounting underestimated the provider's.
   * @param limit - the exhausted provider limit.
   */
  reject(limit: 'rps' | 'tpm'): void
  /** The request ended without reported usage, such as an upstream refusal or a transport failure. */
  release(): void
}

interface KeyState {
  lastStart: number
  /** Sum of estimates of requests admitted and not yet ended. */
  inflight: number
  /** Settled usage, oldest first, still inside the window. */
  usage: { at: number; tokens: number }[]
}

interface Waiter {
  estimate: number
  grant: (lease: KeyLease) => void
}

/**
 * Admits requests onto the least-loaded key whose limits allow a start now.
 * Requests that no key can admit wait in arrival order.
 */
export class KeyPool {
  private readonly keys: KeyState[]
  private readonly waiters: Waiter[] = []
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param size - number of keys; positive.
   * @param limits - per-key limits shared by every key.
   */
  constructor(size: number, private readonly limits: KeyLimits) {
    this.keys = Array.from({ length: size }, () => ({ lastStart: -Infinity, inflight: 0, usage: [] }))
  }

  /**
   * Lease a key for one request, waiting until some key admits it.
   * @param estimate - tokens the request is expected to consume.
   * @param signal - cancels the wait; a granted lease is unaffected.
   * @returns the lease.
   * @throws the signal's reason when cancelled before a key is granted.
   */
  acquire(estimate: number, signal?: AbortSignal): Promise<KeyLease> {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted()
      const onAbort = (): void => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1)
        reject(signal!.reason)
        this.pump()
      }
      const waiter: Waiter = {
        estimate,
        grant: (lease) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(lease)
        },
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
      this.pump()
    })
  }

  private get startGapMs(): number {
    return 1000 / this.limits.requestsPerSecond
  }

  /**
   * Earliest time `state` admits a start: after its request-rate gap, and once
   * settled usage still in the window plus in-flight estimates is under the
   * token budget. The provider admits any single request while the budget is
   * not yet exhausted, so one request may exceed the budget on its own.
   * `Infinity` when only an in-flight request can free the budget.
   */
  private readyAt(state: KeyState, now: number): number {
    while (state.usage.length > 0 && state.usage[0]!.at + this.limits.windowMs <= now) state.usage.shift()
    let used = state.inflight + state.usage.reduce((sum, entry) => sum + entry.tokens, 0)
    let budgetAt = now
    for (const entry of state.usage) {
      if (used < this.limits.tokensPerMinute) break
      used -= entry.tokens
      budgetAt = entry.at + this.limits.windowMs
    }
    if (used >= this.limits.tokensPerMinute) budgetAt = Infinity
    return Math.max(state.lastStart + this.startGapMs, budgetAt)
  }

  private lease(key: number, estimate: number): KeyLease {
    const state = this.keys[key]!
    let ended = false
    const end = (): void => {
      if (ended) throw new Error(`key-pool: lease on key ${key} ended twice`)
      ended = true
      state.inflight -= estimate
    }
    return {
      key,
      settle: (tokens) => {
        end()
        state.usage.push({ at: Date.now(), tokens })
        this.pump()
      },
      reject: (limit) => {
        end()
        if (limit === 'rps') state.lastStart = Date.now()
        else state.usage.push({ at: Date.now(), tokens: this.limits.tokensPerMinute })
        this.pump()
      },
      release: () => {
        end()
        this.pump()
      },
    }
  }

  /** Grant waiters in arrival order while some key admits them; otherwise wake at the earliest ready time. */
  private pump(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    while (this.waiters.length > 0) {
      const now = Date.now()
      let best: number | undefined
      for (let index = 0; index < this.keys.length; index++) {
        const state = this.keys[index]!
        if (this.readyAt(state, now) > now) continue
        if (best === undefined || state.lastStart < this.keys[best]!.lastStart) best = index
      }
      if (best === undefined) {
        const wakeAt = Math.min(...this.keys.map(state => this.readyAt(state, now)))
        // An infinite wake time means only a settling lease can free a key; it pumps then.
        if (wakeAt !== Infinity) this.timer = setTimeout(() => { this.pump() }, wakeAt - now)
        return
      }
      const waiter = this.waiters.shift()!
      const state = this.keys[best]!
      state.lastStart = now
      state.inflight += waiter.estimate
      waiter.grant(this.lease(best, waiter.estimate))
    }
  }
}
