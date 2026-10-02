import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  getStrategyNotifyFlags,
  notifyStrategyClose,
  notifyStrategyOpen,
  resolveStrategyDisplayName,
  telegramExtrasFromFeatures,
} from './strategy-telegram-notify'

const telegramMocks = vi.hoisted(() => ({
  sendStrategyTrackOpenAlert: vi.fn(async () => true),
  sendStrategyTrackCloseAlert: vi.fn(async () => true),
}))

const afterHarness = vi.hoisted(() => ({
  queue: [] as Array<() => void | Promise<void>>,
  mode: 'queue' as 'queue' | 'throw',
}))

vi.mock('next/server', () => ({
  after: (fn: () => void | Promise<void>) => {
    if (afterHarness.mode === 'throw') {
      throw new Error('after was called outside a request scope')
    }
    afterHarness.queue.push(fn)
  },
}))

vi.mock('@/utils/telegram', () => ({
  sendStrategyTrackOpenAlert: telegramMocks.sendStrategyTrackOpenAlert,
  sendStrategyTrackCloseAlert: telegramMocks.sendStrategyTrackCloseAlert,
}))

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
    } as unknown as Awaited<ReturnType<typeof getMergedMcapTrackerRegistry>>)
    await expect(
      getStrategyNotifyFlags('mcap_tracker', 'mcap_enter_at_80'),
    ).resolves.toEqual({ telegram: true, ui: false })
  })
})

describe('telegramExtrasFromFeatures marketCap precedence', () => {
  it('open (default) prefers entry_mcap when both entry and exit are present', () => {
    const { marketCap } = telegramExtrasFromFeatures({
      entry_mcap: 80267,
      exit_mcap: 198690,
    })
    expect(marketCap).toBe(80267)
  })

  it('close (preferExit) reports exit_mcap over entry_mcap', () => {
    const { marketCap } = telegramExtrasFromFeatures(
      { entry_mcap: 80267, exit_mcap: 198690 },
      { preferExit: true },
    )
    expect(marketCap).toBe(198690)
  })

  it('close prefers current_mcap when exit_mcap is absent', () => {
    const { marketCap } = telegramExtrasFromFeatures(
      { entry_mcap: 80267, current_mcap: 122000 },
      { preferExit: true },
    )
    expect(marketCap).toBe(122000)
  })

  it('close falls back to entry_mcap when nothing but entry is present', () => {
    const { marketCap } = telegramExtrasFromFeatures(
      { entry_mcap: 80267 },
      { preferExit: true },
    )
    expect(marketCap).toBe(80267)
  })

  it('close reads exit_mcap nested under domain_features (canonicalized outcomes)', () => {
    const { marketCap } = telegramExtrasFromFeatures(
      {
        entry_mcap: 80267,
        domain_features: { exit_mcap: 198690, mcap_growth_at_exit: 147.5 },
      },
      { preferExit: true },
    )
    expect(marketCap).toBe(198690)
  })
})

const closeParams = {
  domain: 'signals' as const,
  strategyId: 'signals_default',
  tokenAddress: 'Mint111111111111111111111111111111111111111',
  pnlPct: 12.5,
  isSimulated: true,
}

describe('notifyStrategyOpen / notifyStrategyClose scheduling', () => {
  beforeEach(() => {
    afterHarness.mode = 'queue'
    afterHarness.queue.length = 0
    telegramMocks.sendStrategyTrackOpenAlert.mockReset()
    telegramMocks.sendStrategyTrackOpenAlert.mockResolvedValue(true)
    telegramMocks.sendStrategyTrackCloseAlert.mockReset()
    telegramMocks.sendStrategyTrackCloseAlert.mockResolvedValue(true)
    vi.mocked(getSignalsStrategy).mockResolvedValue({
      id: 'signals_default',
      is_active: true,
      config: { notify: { telegram: true, ui: true } },
    } as Awaited<ReturnType<typeof getSignalsStrategy>>)
  })

  // These four used to assert the opposite: "does not send … until the after() task runs". That was
  // the bug written down as a requirement. `after()` waits for the RESPONSE, and the sim-track
  // handler responds only when its whole cycle is done — minutes later — so a post for a position
  // that opened early in the cycle went out at the end of it. The contract now is: detached, now,
  // off the critical path.

  it('sends the close telegram immediately, not at the end of the response', async () => {
    notifyStrategyClose(closeParams)
    await vi.waitFor(() => {
      expect(telegramMocks.sendStrategyTrackCloseAlert).toHaveBeenCalledTimes(1)
    })
    // Nothing is parked waiting for the response to finish.
    expect(afterHarness.queue).toHaveLength(0)
  })

  it('sends the open telegram immediately, not at the end of the response', async () => {
    notifyStrategyOpen({
      domain: 'signals',
      strategyId: 'signals_default',
      tokenSymbol: 'TEST',
      tokenAddress: closeParams.tokenAddress,
      isSimulated: true,
    })
    await vi.waitFor(() => {
      expect(telegramMocks.sendStrategyTrackOpenAlert).toHaveBeenCalledTimes(1)
    })
    expect(afterHarness.queue).toHaveLength(0)
  })

  it('does not reject the caller when the close notify fails', async () => {
    telegramMocks.sendStrategyTrackCloseAlert.mockRejectedValueOnce(
      new Error('sharp down'),
    )
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => notifyStrategyClose(closeParams)).not.toThrow()
    await vi.waitFor(() => expect(errorSpy).toHaveBeenCalled())
    errorSpy.mockRestore()
  })

  it('does not depend on after() being callable at all', async () => {
    // Detached means the send no longer routes through the request lifecycle, so a context where
    // after() throws must not change the outcome.
    afterHarness.mode = 'throw'
    notifyStrategyClose(closeParams)
    await vi.waitFor(() => {
      expect(telegramMocks.sendStrategyTrackCloseAlert).toHaveBeenCalledTimes(1)
    })
    expect(afterHarness.queue).toHaveLength(0)
  })
})
