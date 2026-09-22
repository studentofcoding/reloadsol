import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/telegram', () => ({
  isStrategyTrackTelegramEnabled: () => true,
  sendMcapSimManualTradeAlert: vi.fn(async () => true),
}))

import { sendMcapSimManualTradeAlert } from '@/utils/telegram'
import { sendBestStrategyShareTelegram } from './best-strategies-share-notify'

afterEach(() => {
  vi.clearAllMocks()
})

describe('sendBestStrategyShareTelegram', () => {
  it('sends copy-trade alert with strategy + mint for OHLC path', async () => {
    const ok = await sendBestStrategyShareTelegram({
      strategyId: 'mcap_enter_at_80',
      domain: 'mcap_tracker',
      tokenAddress: 'MintABC',
      tokenSymbol: 'TEST',
      entryMcap: 120_000,
      entryAt: '2026-09-22T12:00:00.000Z',
      sm: 3,
      kol: 1,
    })
    expect(ok).toBe(true)
    expect(sendMcapSimManualTradeAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        strategyId: 'mcap_enter_at_80',
        strategyName: 'Enter at 80% milestone',
        tokenAddress: 'MintABC',
        tokenSymbol: 'TEST',
        entryMcap: 120_000,
        sm: 3,
        kol: 1,
      }),
    )
  })
})
