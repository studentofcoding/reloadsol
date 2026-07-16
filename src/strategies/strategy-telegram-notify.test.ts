import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  isStrategyActiveForTelegram,
  resolveStrategyDisplayName,
} from './strategy-telegram-notify'

vi.mock('./load-signals', () => ({
  getSignalsStrategy: vi.fn(),
}))

vi.mock('./load-mcap-tracker', () => ({
  getMergedMcapTrackerRegistry: vi.fn(),
}))

import { getSignalsStrategy } from './load-signals'
import { getMergedMcapTrackerRegistry } from './load-mcap-tracker'

describe('resolveStrategyDisplayName', () => {
  it('resolves gmgn registry names', () => {
    expect(resolveStrategyDisplayName('gmgn', 'gmgn_smartmoney_default')).toBe(
      'GMGN Smart Money',
    )
  })
})

describe('isStrategyActiveForTelegram', () => {
  beforeEach(() => {
    vi.mocked(getSignalsStrategy).mockReset()
    vi.mocked(getMergedMcapTrackerRegistry).mockReset()
  })

  it('returns true for active signals strategy', async () => {
    vi.mocked(getSignalsStrategy).mockResolvedValue({
      id: 'signals_default',
      is_active: true,
    } as Awaited<ReturnType<typeof getSignalsStrategy>>)
    await expect(
      isStrategyActiveForTelegram('signals', 'signals_default'),
    ).resolves.toBe(true)
  })

  it('returns false for inactive signals strategy', async () => {
    vi.mocked(getSignalsStrategy).mockResolvedValue({
      id: 'signals_default',
      is_active: false,
    } as Awaited<ReturnType<typeof getSignalsStrategy>>)
    await expect(
      isStrategyActiveForTelegram('signals', 'signals_default'),
    ).resolves.toBe(false)
  })

  it('returns false when mcap strategy missing from registry', async () => {
    vi.mocked(getMergedMcapTrackerRegistry).mockResolvedValue({})
    await expect(
      isStrategyActiveForTelegram('mcap_tracker', 'mcap_enter_at_80'),
    ).resolves.toBe(false)
  })
})
