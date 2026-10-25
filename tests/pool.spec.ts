import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeyPool } from '../src/pool.ts'

const LIMITS = { requestsPerSecond: 1, tokensPerMinute: 60_000, windowMs: 60_000 }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('KeyPool', () => {
  it('spreads simultaneous requests across different keys', async () => {
    const pool = new KeyPool(3, LIMITS)
    const leases = await Promise.all([pool.acquire(100), pool.acquire(100), pool.acquire(100)])
    expect(leases.map(lease => lease.key).sort()).toEqual([0, 1, 2])
  })

  it('holds a second start on the same key until its request-rate gap has passed', async () => {
    const pool = new KeyPool(1, LIMITS)
    await pool.acquire(100)
    let admitted = false
    const second = pool.acquire(100).then((lease) => { admitted = true; return lease })
    await vi.advanceTimersByTimeAsync(999)
    expect(admitted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await second).key).toBe(0)
  })

  it('admits a key again only after its exhausted token budget leaves the window', async () => {
    const pool = new KeyPool(1, LIMITS)
    const first = await pool.acquire(30_000)
    first.settle(60_000)
    let admitted = false
    const second = pool.acquire(100).then((lease) => { admitted = true; return lease })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(admitted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await second).key).toBe(0)
  })

  it('keeps admitting a key whose window usage stays under the token budget', async () => {
    const pool = new KeyPool(1, LIMITS)
    const first = await pool.acquire(20_000)
    first.settle(20_000)
    let admitted = false
    void pool.acquire(20_000).then(() => { admitted = true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(admitted).toBe(true)
  })

  it('rests a key for a whole window after the provider reports its token budget exhausted', async () => {
    const pool = new KeyPool(1, LIMITS)
    const first = await pool.acquire(100)
    first.reject('tpm')
    let admitted = false
    void pool.acquire(100).then(() => { admitted = true })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(admitted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(admitted).toBe(true)
  })

  it('restarts the request-rate gap after the provider reports the key rate exhausted', async () => {
    const pool = new KeyPool(1, LIMITS)
    const first = await pool.acquire(100)
    await vi.advanceTimersByTimeAsync(500)
    first.reject('rps')
    let admitted = false
    void pool.acquire(100).then(() => { admitted = true })
    await vi.advanceTimersByTimeAsync(999)
    expect(admitted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(admitted).toBe(true)
  })

  it('frees an in-flight estimate that blocked the key once the request ends without usage', async () => {
    const pool = new KeyPool(1, LIMITS)
    const big = await pool.acquire(200_000)
    let admitted = false
    void pool.acquire(100).then(() => { admitted = true })
    await vi.advanceTimersByTimeAsync(5000)
    expect(admitted).toBe(false)
    big.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(admitted).toBe(true)
  })

  it('drops a cancelled waiter so it neither receives a key nor delays later requests', async () => {
    const pool = new KeyPool(1, LIMITS)
    await pool.acquire(100)
    const controller = new AbortController()
    const cancelled = pool.acquire(50_000, controller.signal)
    const later = pool.acquire(100)
    controller.abort(new Error('client closed'))
    await expect(cancelled).rejects.toThrow('client closed')
    await vi.advanceTimersByTimeAsync(1000)
    expect((await later).key).toBe(0)
    // The cancelled 50k estimate never reached the key, so a 30k request still fits after the gap.
    let admitted = false
    void pool.acquire(30_000).then(() => { admitted = true })
    await vi.advanceTimersByTimeAsync(1000)
    expect(admitted).toBe(true)
  })
})
