import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireSolanaTrackerOhlcSlot,
  resetSolanaTrackerOhlcLimiterForTests,
  solanaTrackerOhlcRps,
} from '@/utils/solanatracker-ohlc-limit'

describe('solanaTrackerOhlcRps', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('defaults to 3 and ignores non-positive overrides', () => {
    vi.stubEnv('SOLANATRACKER_OHLC_RPS', '')
    expect(solanaTrackerOhlcRps()).toBe(3)
    vi.stubEnv('SOLANATRACKER_OHLC_RPS', '0')
    expect(solanaTrackerOhlcRps()).toBe(3)
    vi.stubEnv('SOLANATRACKER_OHLC_RPS', '1.5')
    expect(solanaTrackerOhlcRps()).toBe(1.5)
  })
})

describe('acquireSolanaTrackerOhlcSlot', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    resetSolanaTrackerOhlcLimiterForTests()
  })

  it('keeps parallel starts at or under 3 per second', async () => {
    vi.stubEnv('SOLANATRACKER_OHLC_RPS', '3')
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T00:00:00.000Z'))
    resetSolanaTrackerOhlcLimiterForTests()

    const starts: number[] = []
    const pending = Promise.all(
      Array.from({ length: 6 }, () =>
        acquireSolanaTrackerOhlcSlot().then(() => {
          starts.push(Date.now())
        }),
      ),
    )
    await vi.runAllTimersAsync()
    await pending

    expect(starts).toHaveLength(6)
    expect(starts[0]).toBe(Date.parse('2026-09-23T00:00:00.000Z'))
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(333)
    }
    for (const start of starts) {
      const inWindow = starts.filter((t) => t >= start && t < start + 1000)
      expect(inWindow.length).toBeLessThanOrEqual(3)
    }
  })
})
