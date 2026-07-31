import { afterEach, describe, expect, it } from 'vitest'
import {
  attachPatternShadowToAlert,
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

    const toasts = drainSignalsEarlyAlerts('sol')
    expect(toasts).toHaveLength(1)
    expect(toasts[0].category).toBe('signals_enter')
    expect(toasts[0].title).toBe('Early Enter')
    expect(toasts[0].key).toBe(signalsEnterDedupKey('MintEarly', 'sol'))
    expect(toasts[0].items?.[0]).toMatchObject({
      symbol: 'EARLY',
      address: 'MintEarly',
      entryTemplate: 'signals_enter',
    })
    expect(drainSignalsEarlyAlerts('sol')).toHaveLength(0)
  })

  it('scopes drain by chain — sol drain does not consume robinhood', () => {
    expect(
      recordSignalsEarlyAlert({
        tokenAddress: 'MintShared',
        tokenSymbol: 'SOL',
        entryMcap: 70_000,
        growthPercent: 30,
        score: 55,
        chain: 'sol',
      }),
    ).not.toBeNull()
    expect(
      recordSignalsEarlyAlert({
        tokenAddress: 'MintShared',
        tokenSymbol: 'RH',
        entryMcap: 70_000,
        growthPercent: 30,
        score: 55,
        chain: 'robinhood',
      }),
    ).not.toBeNull()

    const sol = drainSignalsEarlyAlerts('sol')
    expect(sol).toHaveLength(1)
    expect(sol[0].key).toBe(signalsEnterDedupKey('MintShared', 'sol'))

    expect(drainSignalsEarlyAlerts('sol')).toHaveLength(0)
    const rh = drainSignalsEarlyAlerts('robinhood')
    expect(rh).toHaveLength(1)
    expect(rh[0].key).toBe(signalsEnterDedupKey('MintShared', 'robinhood'))
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

  it('still records when Pattern ML predicts loser (shadow never gates)', () => {
    const recorded = emitSignalsEarlyAlertsFromScored([
      scored({
        token_address: 'LoserMint',
        decision: 'enter',
        mcap_growth_percent: 40,
        ml_pattern_p_winner: 0.12,
        ml_pattern_predicted: 'loser',
      }),
    ])
    expect(recorded).toHaveLength(1)
    expect(recorded[0].pWinner).toBe(0.12)
    expect(recorded[0].predicted).toBe('loser')
  })

  it('builds toast with growth, score, and ML shadow snippet', () => {
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
      chain: 'sol',
      mlShadow: true,
      pWinner: 0.42,
      predicted: 'loser',
      mlReason: null,
    })
    expect(toast.message).toContain('FOO')
    expect(toast.message).toContain('+42.5%')
    expect(toast.message).toContain('$85.0K')
    expect(toast.message).toContain('62')
    expect(toast.message).toContain('ML pW 0.42 → loser')
    expect(toast.items?.[0]?.pWinner).toBe(0.42)
    expect(toast.items?.[0]?.predicted).toBe('loser')
  })

  it('attachPatternShadowToAlert mutates alert for Telegram path', () => {
    const alert = recordSignalsEarlyAlert({
      tokenAddress: 'MintAttach',
      tokenSymbol: 'ATT',
      entryMcap: 50_000,
      growthPercent: 30,
      score: 55,
    })
    expect(alert).not.toBeNull()
    attachPatternShadowToAlert(alert!, {
      pWinner: 0.71,
      predicted: 'winner',
      reason: null,
    })
    expect(alert!.pWinner).toBe(0.71)
    expect(alert!.predicted).toBe('winner')
  })
})
