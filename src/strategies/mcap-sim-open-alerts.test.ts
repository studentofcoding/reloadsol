import { afterEach, describe, expect, it } from 'vitest'
import {
  buildSimOpenToast,
  drainSimOpenAlerts,
  isMcapManualTradeStrategy,
  recordSimOpenAlert,
  resetSimOpenAlertsForTests,
  simOpenDedupKey,
  strategyLabelForManualTrade,
} from './mcap-sim-open-alerts'

afterEach(() => {
  resetSimOpenAlertsForTests()
})

describe('mcap-sim-open-alerts', () => {
  it('recognizes manual trade strategies', () => {
    expect(isMcapManualTradeStrategy('mcap_enter_first_seen')).toBe(true)
    expect(isMcapManualTradeStrategy('mcap_enter_at_80')).toBe(true)
    expect(isMcapManualTradeStrategy('other')).toBe(false)
  })

  it('labels strategies for copy-trade UI', () => {
    expect(strategyLabelForManualTrade('mcap_enter_first_seen')).toBe(
      'Enter at first seen',
    )
    expect(strategyLabelForManualTrade('mcap_enter_at_80')).toBe(
      'Enter at 80% milestone',
    )
  })

  it('records alert once per strategy+mint and peeks as toast without consume', () => {
    const first = recordSimOpenAlert({
      strategyId: 'mcap_enter_at_80',
      tokenAddress: 'MintABC',
      tokenSymbol: 'TEST',
      entryMcap: 120_000,
      entryAt: '2026-07-09T00:00:00.000Z',
      entryTemplate: 'milestone_80',
    })
    expect(first).not.toBeNull()

    const dup = recordSimOpenAlert({
      strategyId: 'mcap_enter_at_80',
      tokenAddress: 'MintABC',
      tokenSymbol: 'TEST',
      entryMcap: 120_000,
      entryAt: '2026-07-09T00:00:00.000Z',
      entryTemplate: 'milestone_80',
    })
    expect(dup).toBeNull()

    const otherStrategy = recordSimOpenAlert({
      strategyId: 'mcap_enter_first_seen',
      tokenAddress: 'MintABC',
      tokenSymbol: 'TEST',
      entryMcap: 80_000,
      entryAt: '2026-07-09T00:00:00.000Z',
      entryTemplate: 'first_seen',
    })
    expect(otherStrategy).not.toBeNull()

    const toasts = drainSimOpenAlerts()
    expect(toasts).toHaveLength(2)
    expect(toasts[0].category).toBe('sim_open')
    expect(toasts[0].key).toBe(simOpenDedupKey('mcap_enter_at_80', 'MintABC'))
    expect(toasts[0].items?.[0]).toMatchObject({
      symbol: 'TEST',
      address: 'MintABC',
      strategyId: 'mcap_enter_at_80',
      entryMcap: 120_000,
      entryTemplate: 'milestone_80',
    })

    expect(drainSimOpenAlerts()).toHaveLength(2)
  })

  it('ignores non-manual strategies', () => {
    expect(
      recordSimOpenAlert({
        strategyId: 'unknown_strategy',
        tokenAddress: 'MintXYZ',
        tokenSymbol: 'X',
        entryMcap: 1,
        entryAt: '2026-07-09T00:00:00.000Z',
        entryTemplate: 'first_seen',
      }),
    ).toBeNull()
    expect(drainSimOpenAlerts()).toHaveLength(0)
  })

  it('builds toast message with strategy and entry mcap', () => {
    const toast = buildSimOpenToast({
      strategyId: 'mcap_enter_first_seen',
      strategyName: 'Enter at first seen',
      tokenAddress: 'Mint1',
      tokenSymbol: 'FOO',
      entryMcap: 85_000,
      entryAt: '2026-07-09T00:00:00.000Z',
      entryTemplate: 'first_seen',
      recordedAt: Date.now(),
      delivered: false,
    })
    expect(toast.title).toBe('Mcap Sim Open')
    expect(toast.message).toContain('Enter at first seen')
    expect(toast.message).toContain('FOO')
    expect(toast.message).toContain('$85.0K')
  })
})
