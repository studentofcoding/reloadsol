import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/db', () => ({ query: vi.fn(async () => ({ rows: [] })) }))
const logError = vi.fn()
vi.mock('@/utils/unified-logger', () => ({
  log: { warn: vi.fn(), error: (...a: unknown[]) => logError(...a), info: vi.fn(), debug: vi.fn() },
}))

import {
  __resetOpenAttemptsForTests,
  decideRetry,
  isOpenRecordingEnabled,
  isOpenRetryPolicyEnabled,
  openRetryConfig,
  priceMovePct,
  recordOpenAttempt,
  runOpenWithRetry,
  spineDecisionToAttempt,
  type OpenAttemptRow,
} from './open-attempts'

const cfg = { maxRetries: 2, maxMovePct: 5, delayMs: 0 }
const MINT = 'MintMintMint'

beforeEach(() => {
  vi.clearAllMocks()
  __resetOpenAttemptsForTests()
})

describe('flags', () => {
  it('recording defaults ON, the retry policy defaults OFF', () => {
    expect(isOpenRecordingEnabled({})).toBe(true)
    expect(isOpenRecordingEnabled({ OPEN_ATTEMPTS_RECORD: '0' })).toBe(false)
    expect(isOpenRetryPolicyEnabled({})).toBe(false)
    expect(isOpenRetryPolicyEnabled({ OPEN_RETRY_POLICY: '1' })).toBe(true)
  })
  it('policy defaults are the user policy: 2 retries, 5 %', () => {
    expect(openRetryConfig({})).toMatchObject({ maxRetries: 2, maxMovePct: 5 })
  })
})

describe('price move', () => {
  it('is signed and null-safe', () => {
    expect(priceMovePct(100, 110)).toBeCloseTo(10)
    expect(priceMovePct(100, 90)).toBeCloseTo(-10)
    expect(priceMovePct(null, 90)).toBeNull()
    expect(priceMovePct(0, 90)).toBeNull()
  })
  it('stops on a >5% move in EITHER direction, not on exactly 5%', () => {
    expect(decideRetry(100, 105.1, cfg).action).toBe('skip_price_moved')
    expect(decideRetry(100, 94.9, cfg).action).toBe('skip_price_moved')
    expect(decideRetry(100, 105, cfg).action).toBe('retry')
    expect(decideRetry(100, 95, cfg).action).toBe('retry')
    expect(decideRetry(null, 999, cfg).action).toBe('retry') // nothing to compare against
  })
})

describe('recordOpenAttempt', () => {
  it('inserts a row and never throws', async () => {
    const q = vi.fn(async () => ({ rows: [] }))
    await expect(recordOpenAttempt({ strategyId: 's', tokenAddress: MINT, outcome: 'skipped', reason: 'cap' }, { query: q as never })).resolves.toBe(true)
    expect((q.mock.calls[0] as unknown as unknown[][])[1].slice(0, 6)).toEqual(['s', 'sol', MINT, 'skipped', null, 'cap'])
    const bad = vi.fn(async () => {
      throw new Error('db down')
    })
    await expect(recordOpenAttempt({ strategyId: 's', tokenAddress: MINT, outcome: 'failed' }, { query: bad as never })).resolves.toBe(false)
  })
  it('pauses quietly after the table is found missing', async () => {
    const bad = vi.fn(async () => {
      throw new Error('relation "position_open_attempts" does not exist')
    })
    const row: OpenAttemptRow = { strategyId: 's', tokenAddress: MINT, outcome: 'failed' }
    await recordOpenAttempt(row, { query: bad as never, now: () => 1000 })
    await recordOpenAttempt(row, { query: bad as never, now: () => 2000 })
    expect(bad).toHaveBeenCalledTimes(1)
    await recordOpenAttempt(row, { query: bad as never, now: () => 1000 + 11 * 60_000 })
    expect(bad).toHaveBeenCalledTimes(2)
  })
  it('does nothing when recording is off', async () => {
    const q = vi.fn()
    expect(await recordOpenAttempt({ strategyId: 's', tokenAddress: MINT, outcome: 'failed' }, { query: q as never, env: { OPEN_ATTEMPTS_RECORD: 'off' } })).toBe(false)
    expect(q).not.toHaveBeenCalled()
  })
})

describe('spineDecisionToAttempt', () => {
  const base = { workerId: 'signals_sim_track', mint: MINT, passed: false }
  it('maps price -> failed, rug/size/gate -> skipped, pass -> nothing', () => {
    expect(spineDecisionToAttempt({ ...base, stage: 'price', reason: 'missing_price' })).toMatchObject({ outcome: 'failed', stage: 'price' })
    expect(spineDecisionToAttempt({ ...base, stage: 'rug', reason: 'ohlc_rug (x)' })).toMatchObject({ outcome: 'skipped' })
    expect(spineDecisionToAttempt({ ...base, stage: 'size', reason: 'size_stand_down' })).toMatchObject({ outcome: 'skipped' })
    expect(spineDecisionToAttempt({ ...base, stage: 'gate', reason: 'cap' })).toMatchObject({ outcome: 'skipped' })
    expect(spineDecisionToAttempt({ ...base, stage: 'pass', reason: null, passed: true })).toBeNull()
  })
  it('does not double-record what the retry policy already recorded', () => {
    expect(spineDecisionToAttempt({ ...base, stage: 'price', reason: 'price_moved_gt_5pct' })).toBeNull()
  })
})

describe('runOpenWithRetry', () => {
  type R = { ok: boolean; stage?: string; reason?: string }
  const run = (over: Partial<Parameters<typeof runOpenWithRetry<R>>[0]> & { rows?: OpenAttemptRow[] }) => {
    const rows: OpenAttemptRow[] = over.rows ?? []
    return runOpenWithRetry<R>({
      strategyId: 'mcap',
      chain: 'sol',
      mint: MINT,
      initialPriceUsd: 1,
      attempt: async () => ({ ok: true }),
      refetchPriceUsd: async () => 1,
      cfg,
      sleep: async () => {},
      record: async (r) => {
        rows.push(r)
        return true
      },
      ...over,
    })
  }

  it('returns the first success with no retry and no row', async () => {
    const attempt = vi.fn(async () => ({ ok: true }))
    const rows: OpenAttemptRow[] = []
    await expect(run({ attempt, rows })).resolves.toEqual({ ok: true })
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(rows).toHaveLength(0)
  })

  it('does not retry a rug / size stand-down (a decision, not a failure)', async () => {
    const attempt = vi.fn(async () => ({ ok: false, stage: 'rug', reason: 'ohlc_rug' }))
    await expect(run({ attempt })).resolves.toMatchObject({ stage: 'rug' })
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('retries a thrown error and succeeds on the second try with the fresh price', async () => {
    const seen: Array<number | null | undefined> = []
    let n = 0
    const rows: OpenAttemptRow[] = []
    const res = await run({
      rows,
      refetchPriceUsd: async () => 1.02,
      attempt: async (p) => {
        seen.push(p)
        if (++n === 1) throw new Error('boom')
        return { ok: true }
      },
    })
    expect(res).toEqual({ ok: true })
    expect(seen).toEqual([1, 1.02])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome: 'failed', stage: 'exception', attemptNo: 1, isFinal: false })
  })

  it('FAILS LOUDLY and skips when the price moved >5% from the last failed try (up)', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('boom')
    })
    const rows: OpenAttemptRow[] = []
    const res = await run({ rows, attempt, refetchPriceUsd: async () => 1.2 })
    expect(res).toEqual({ ok: false, stage: 'price', reason: 'price_moved_gt_5pct' })
    expect(attempt).toHaveBeenCalledTimes(1) // no second attempt at the moved price
    expect(logError).toHaveBeenCalledTimes(1)
    expect(rows.at(-1)).toMatchObject({
      outcome: 'failed',
      reason: 'price_moved_gt_5pct',
      isFinal: true,
      prevPriceUsd: 1,
      priceUsd: 1.2,
    })
    expect(rows.at(-1)?.priceMovePct).toBeCloseTo(20)
  })

  it('also skips when the price moved down >5%', async () => {
    const res = await run({
      attempt: async () => {
        throw new Error('x')
      },
      refetchPriceUsd: async () => 0.9,
    })
    expect(res).toMatchObject({ reason: 'price_moved_gt_5pct' })
  })

  it('compares each retry against the LAST failed try, not the first', async () => {
    const prices = [1.04, 1.08] // +4% vs 1, then +3.8% vs 1.04: both ok; 1.08 vs 1 would be 8%
    let i = 0
    let calls = 0
    const res = await run({
      attempt: async () => {
        calls++
        if (calls < 3) throw new Error('x')
        return { ok: true }
      },
      refetchPriceUsd: async () => prices[i++],
    })
    expect(res).toEqual({ ok: true })
    expect(calls).toBe(3)
  })

  it('re-throws after 2 retries (3 tries) and records the final failure', async () => {
    const rows: OpenAttemptRow[] = []
    const attempt = vi.fn(async () => {
      throw new Error('always')
    })
    await expect(run({ rows, attempt })).rejects.toThrow('always')
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(rows.map((r) => [r.attemptNo, r.isFinal])).toEqual([[1, false], [2, false], [3, true]])
    expect(logError).toHaveBeenCalled()
  })

  it('returns the price-stage failure after exhausting retries, leaving the final record to the spine decision', async () => {
    const rows: OpenAttemptRow[] = []
    const attempt = vi.fn(async () => ({ ok: false, stage: 'price', reason: 'missing_price' }))
    const res = await run({ rows, attempt, initialPriceUsd: null, refetchPriceUsd: async () => null })
    expect(res).toMatchObject({ ok: false, stage: 'price', reason: 'missing_price' })
    expect(attempt).toHaveBeenCalledTimes(3)
    expect(rows).toHaveLength(2) // tries 1+2 non-final; the final one is the spine decision's row
    expect(rows.every((r) => r.isFinal === false)).toBe(true)
  })

  it('recovers when a missing price appears on the retry', async () => {
    let n = 0
    const res = await run({
      initialPriceUsd: null,
      refetchPriceUsd: async () => 2,
      attempt: async (p) => (p ? { ok: true } : (n++, { ok: false, stage: 'price', reason: 'missing_price' })),
    })
    expect(res).toEqual({ ok: true })
    expect(n).toBe(1)
  })
})
