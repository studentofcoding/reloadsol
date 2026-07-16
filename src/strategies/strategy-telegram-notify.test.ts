import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  getStrategyNotifyFlags,
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

describe('getStrategyNotifyFlags', () => {
  beforeEach(() => {
    vi.mocked(getSignalsStrategy).mockReset()
    vi.mocked(getMergedMcapTrackerRegistry).mockReset()
  })

  it('defaults telegram on when notify unset', async () => {
    vi.mocked(getSignalsStrategy).mockResolvedValue({
      id: 'signals_default',
      is_active: false,
      config: {},
    } as Awaited<ReturnType<typeof getSignalsStrategy>>)
    await expect(
      getStrategyNotifyFlags('signals', 'signals_default'),
    ).resolves.toEqual({ telegram: true, ui: true })
  })

  it('honors notify.telegram false while strategy inactive', async () => {
    vi.mocked(getSignalsStrategy).mockResolvedValue({
      id: 'signals_default',
      is_active: false,
      config: { notify: { telegram: false, ui: false } },
    } as Awaited<ReturnType<typeof getSignalsStrategy>>)
    await expect(
      getStrategyNotifyFlags('signals', 'signals_default'),
    ).resolves.toEqual({ telegram: false, ui: false })
  })

  it('reads mcap notify from registry', async () => {
    vi.mocked(getMergedMcapTrackerRegistry).mockResolvedValue({
      mcap_enter_at_80: {
        config: { notify: { telegram: true, ui: false } },
      },
    } as Awaited<ReturnType<typeof getMergedMcapTrackerRegistry>>)
    await expect(
      getStrategyNotifyFlags('mcap_tracker', 'mcap_enter_at_80'),
    ).resolves.toEqual({ telegram: true, ui: false })
  })
})
