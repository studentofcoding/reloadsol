import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSignalsEarlyToast,
  drainSignalsEarlyAlerts,
  emitSignalsEarlyAlertsFromScored,
  recordSignalsEarlyAlert,
  resetSignalsEarlyAlertsForTests,
  shouldEmitSignalsEarlyAlert,
  signalsEnterDedupKey,
} from './signals-early-alerts'
import type { ScoredSignal } from './signals-pipeline'

afterEach(() => {
  resetSignalsEarlyAlertsForTests()
})

function scored(partial: Partial<ScoredSignal> & { token_address: string }): ScoredSignal {
  return {
    token_symbol: 'TEST',
    first_mcap: 50_000,
    current_mcap: 70_000,
    mcap_growth_percent: 40,
    first_seen_at: '2026-07-09T00:00:00.000Z',
    last_updated_at: '2026-07-09T01:00:00.000Z',
    in_tracking_range: true,
    trend_age_minutes: 10,
    score: 55,
    decision: 'enter',
    rationale: 'Strong momentum and recency',
    ...partial,
  }
}

describe('signals-early-alerts', () => {
  it('emits only for enter with growth under 100%', () => {
    expect(
      shouldEmitSignalsEarlyAlert({ decision: 'enter', mcap_growth_percent: 35 }),
    ).toBe(true)
    expect(
      shouldEmitSignalsEarlyAlert({ decision: 'enter', mcap_growth_percent: 100 }),
    ).toBe(false)
    expect(
      shouldEmitSignalsEarlyAlert({ decision: 'enter', mcap_growth_percent: 120 }),
    ).toBe(false)
    expect(
      shouldEmitSignalsEarlyAlert({ decision: 'hold', mcap_growth_percent: 40 }),
    ).toBe(false)
    expect(
      shouldEmitSignalsEarlyAlert({
        decision: 'enter',
        mcap_growth_percent: 40,
        is_tracking_stuck: true,
      }),
    ).toBe(false)
    expect(
      shouldEmitSignalsEarlyAlert({
        decision: 'enter',
        mcap_growth_percent: 40,
        label: 'rugged',
      }),
    ).toBe(false)
  })

  it('dedups per mint for 24h and drains as Early Enter toast', () => {
    const first = recordSignalsEarlyAlert({
      tokenAddress: 'MintEarly',
      tokenSymbol: 'EARLY',
      entryMcap: 70_000,
      growthPercent: 35.4,
      score: 58,
    })
    expect(first).not.toBeNull()

    const dup = recordSignalsEarlyAlert({
      tokenAddress: 'MintEarly',
      tokenSymbol: 'EARLY',
      entryMcap: 72_000,
      growthPercent: 40,
      score: 60,
    })
    expect(dup).toBeNull()

    const toasts = drainSignalsEarlyAlerts()
    expect(toasts).toHaveLength(1)
    expect(toasts[0].category).toBe('signals_enter')
    expect(toasts[0].title).toBe('Early Enter')
    expect(toasts[0].key).toBe(signalsEnterDedupKey('MintEarly'))
    expect(toasts[0].items?.[0]).toMatchObject({
      symbol: 'EARLY',
      address: 'MintEarly',
      entryTemplate: 'signals_enter',
    })
    expect(drainSignalsEarlyAlerts()).toHaveLength(0)
  })

  it('emitSignalsEarlyAlertsFromScored filters and records eligible signals', () => {
    const recorded = emitSignalsEarlyAlertsFromScored([
      scored({ token_address: 'A', decision: 'enter', mcap_growth_percent: 35 }),
      scored({ token_address: 'B', decision: 'enter', mcap_growth_percent: 150 }),
      scored({ token_address: 'C', decision: 'exit', mcap_growth_percent: 20 }),
      scored({ token_address: 'D', decision: 'enter', mcap_growth_percent: 80 }),
    ])
    expect(recorded.map((a) => a.tokenAddress).sort()).toEqual(['A', 'D'])
  })

  it('builds toast with growth and score', () => {
    const toast = buildSignalsEarlyToast({
      tokenAddress: 'Mint1',
      tokenSymbol: 'FOO',
      entryMcap: 85_000,
      growthPercent: 42.5,
      score: 62,
      rationale: 'Strong momentum',
      entryAt: '2026-07-09T00:00:00.000Z',
      recordedAt: Date.now(),
      delivered: false,
    })
    expect(toast.message).toContain('FOO')
    expect(toast.message).toContain('+42.5%')
    expect(toast.message).toContain('$85.0K')
    expect(toast.message).toContain('62')
  })
})
