import { beforeEach, describe, expect, it, vi } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
vi.mock('@/utils/unified-logger', () => ({ log: { info: vi.fn(), warn, error: vi.fn() } }))

import {
  capStallCounters,
  lastSimBuyAtMs,
  noteCapPass,
  resetCapStallForTests,
} from './cap-stall-monitor'
import type { TrackingRecord } from '@/utils/trading-tracker'

const H = 3_600_000
const NOW = 1_000 * H
const base = {
  strategyId: 's1',
  chain: 'sol',
  opened: 0,
  openCount: 10,
  maxOpen: 10,
  env: {} as Record<string, string | undefined>,
}

beforeEach(() => {
  resetCapStallForTests()
  warn.mockClear()
})

describe('noteCapPass', () => {
  it('warns (structured) only after repeated capped passes with no opens for N hours', () => {
    const last = NOW - 30 * H
    expect(noteCapPass({ ...base, hitCap: true, lastBuyAtMs: last, nowMs: NOW })).toBe(false)
    expect(noteCapPass({ ...base, hitCap: true, lastBuyAtMs: last, nowMs: NOW + 1 })).toBe(false)
    expect(noteCapPass({ ...base, hitCap: true, lastBuyAtMs: last, nowMs: NOW + 2 })).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    const [, , meta] = warn.mock.calls[0]
    expect(meta).toMatchObject({
      event: 'strategy_at_cap_no_opens',
      strategyId: 's1',
      openCount: 10,
      maxOpen: 10,
      consecutiveCapPasses: 3,
      thresholdHours: 6,
    })
    expect(meta.hoursSinceLastOpen).toBeGreaterThanOrEqual(30)
    expect(capStallCounters()).toEqual({ capPasses: 3, stallWarnings: 1 })
  })

  it('does not warn when the strategy opened recently (a healthy full book)', () => {
    for (let i = 0; i < 5; i++) {
      noteCapPass({ ...base, hitCap: true, lastBuyAtMs: NOW - 1 * H, nowMs: NOW + i })
    }
    expect(warn).not.toHaveBeenCalled()
    expect(capStallCounters().capPasses).toBe(5)
  })

  it('resets the streak when a pass is not capped or does open', () => {
    const last = NOW - 30 * H
    noteCapPass({ ...base, hitCap: true, lastBuyAtMs: last, nowMs: NOW })
    noteCapPass({ ...base, hitCap: true, lastBuyAtMs: last, nowMs: NOW + 1 })
    noteCapPass({ ...base, hitCap: false, lastBuyAtMs: last, nowMs: NOW + 2 })
    expect(noteCapPass({ ...base, hitCap: true, lastBuyAtMs: last, nowMs: NOW + 3 })).toBe(false)
    expect(warn).not.toHaveBeenCalled()
  })

  it('rate-limits repeat warnings and honours env overrides', () => {
    const env = { CAP_STALL_WARN_HOURS: '1', CAP_STALL_MIN_PASSES: '1', CAP_STALL_WARN_EVERY_MIN: '10' }
    const last = NOW - 2 * H
    expect(noteCapPass({ ...base, env, hitCap: true, lastBuyAtMs: last, nowMs: NOW })).toBe(true)
    expect(noteCapPass({ ...base, env, hitCap: true, lastBuyAtMs: last, nowMs: NOW + 5 * 60_000 })).toBe(false)
    expect(noteCapPass({ ...base, env, hitCap: true, lastBuyAtMs: last, nowMs: NOW + 11 * 60_000 })).toBe(true)
  })

  it('treats "never bought" as stalled', () => {
    for (let i = 0; i < 3; i++) {
      noteCapPass({ ...base, hitCap: true, lastBuyAtMs: null, nowMs: NOW + i })
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][2].hoursSinceLastOpen).toBeNull()
  })
})

describe('lastSimBuyAtMs', () => {
  it('returns the latest simulated buy of that strategy only', () => {
    const r = (s: string, op: string, ts: number, sim = true) =>
      ({ operationType: op, bot_strategy: s, timestamp: ts, is_simulation: sim }) as unknown as TrackingRecord
    expect(
      lastSimBuyAtMs(
        [r('a', 'buy', 5), r('a', 'buy', 9), r('b', 'buy', 99), r('a', 'sell', 100), r('a', 'buy', 50, false)],
        'a',
      ),
    ).toBe(9)
    expect(lastSimBuyAtMs([], 'a')).toBeNull()
  })
})
