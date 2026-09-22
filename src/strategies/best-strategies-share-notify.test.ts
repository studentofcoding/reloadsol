import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/telegram', () => ({
  isStrategyTrackTelegramEnabled: () => true,
  sendTelegramMessage: vi.fn(async () => ({ ok: true, messageId: 1, chatId: '1' })),
  formatMcapUsd: (n: number) => `$${(n / 1000).toFixed(1)}K`,
  formatReloadsolChartLink: (m: string) => `https://reloadsol.app/chart/${m}`,
  formatTelegramBuyLink: (m: string) => `https://jup.ag/tokens/${m}`,
}))

vi.mock('@/strategies/ohlc-telegram-paint', () => ({
  loadOhlcBarsForTelegram: vi.fn(async () => []),
  sendTelegramOhlcPhotoOrText: vi.fn(async () => ({
    ok: true,
    messageId: 2,
    chatId: '1',
    usedPhoto: true,
  })),
}))

vi.mock('@/strategies/best-strategies-qualify', () => ({
  getQualifiedBestStrategyRank: vi.fn(async () => ({
    place: 1,
    row: {
      strategy_id: 'mcap_enter_at_80',
      domain: 'mcap_tracker',
      name: 'mcap_enter_at_80',
      is_simulated: true,
      n: 40,
      all_time_n: 40,
      week_n: 12,
      avg_pnl_pct: 18,
      win_pct: 55,
      score: 775,
      sum_pnl_pct: 720,
      hypothesis: false,
    },
  })),
}))

import { sendTelegramMessage } from '@/utils/telegram'
import {
  loadOhlcBarsForTelegram,
  sendTelegramOhlcPhotoOrText,
} from '@/strategies/ohlc-telegram-paint'
import {
  FOLLOW_ALERT_MIN_OHLC_BARS,
  buildBestStrategyFollowAlertHtml,
  claimFollowAlertCooldown,
  followAlertArmLabel,
  formatAvgXnRankContext,
  isOhlcTooThinForFollowAlert,
  resetFollowAlertCooldownForTests,
  sendBestStrategyFollowAlert,
} from './best-strategies-share-notify'

afterEach(() => {
  vi.clearAllMocks()
  resetFollowAlertCooldownForTests()
})

describe('follow alert hygiene', () => {
  it('labels follow alert, not auto-enter / paper / entry', () => {
    const html = buildBestStrategyFollowAlertHtml({
      strategyId: 'mcap_enter_at_80',
      tokenSymbol: 'TEST',
      tokenAddress: 'MintABC',
      mcap: 120_000,
      rank: {
        place: 1,
        avg_pnl_pct: 18,
        n: 40,
        win_pct: 55,
        score: 775,
      },
      chartUrl: 'https://www.gmgn.cc/kline/sol/MintABC',
      chartKind: 'gmgn',
    })
    expect(html).toContain('Follow alert')
    expect(html).toContain('not auto-enter')
    expect(html).toContain('80%')
    expect(html).toContain('avg×n+win%')
    expect(html).toContain('GMGN chart')
    expect(html.toLowerCase()).not.toContain('paper')
    expect(html.toLowerCase()).not.toContain('noul')
    expect(html.toLowerCase()).not.toContain('soft-gate')
    expect(html.toLowerCase()).not.toContain('open ·')
    expect(html.toLowerCase()).not.toContain('copy trade')
    expect(html).not.toContain('sum%')
  })

  it('arm labels first_seen / 80%', () => {
    expect(followAlertArmLabel('mcap_enter_first_seen')).toBe('first_seen')
    expect(followAlertArmLabel('mcap_enter_at_80')).toBe('80%')
    expect(followAlertArmLabel('mcap_enter_at_80_rh')).toBe('80% (RH)')
  })

  it('formats avg×n rank context without sum%', () => {
    const ctx = formatAvgXnRankContext({
      place: 2,
      avg_pnl_pct: 16.2,
      n: 35,
      win_pct: 50,
      score: 617,
    })
    expect(ctx).toContain('#2')
    expect(ctx).toContain('n=35')
    expect(ctx).not.toContain('sum')
  })

  it('treats thin OHLC as needing GMGN fallback', () => {
    expect(isOhlcTooThinForFollowAlert(0)).toBe(true)
    expect(isOhlcTooThinForFollowAlert(FOLLOW_ALERT_MIN_OHLC_BARS - 1)).toBe(
      true,
    )
    expect(isOhlcTooThinForFollowAlert(FOLLOW_ALERT_MIN_OHLC_BARS)).toBe(false)
  })

  it('cooldown blocks duplicate mint+arm blasts', () => {
    expect(claimFollowAlertCooldown('mcap_enter_at_80', 'MintA')).toBe(true)
    expect(claimFollowAlertCooldown('mcap_enter_at_80', 'MintA')).toBe(false)
    expect(claimFollowAlertCooldown('mcap_enter_first_seen', 'MintA')).toBe(true)
  })

  it('prefers GMGN URL text when OHLC bars are thin', async () => {
    vi.mocked(loadOhlcBarsForTelegram).mockResolvedValueOnce([])
    const result = await sendBestStrategyFollowAlert({
      strategyId: 'mcap_enter_at_80',
      tokenAddress: 'MintABC',
      tokenSymbol: 'TEST',
      mcap: 120_000,
      force: true,
    })
    expect(result.sent).toBe(true)
    expect(result.usedPhoto).toBe(false)
    expect(sendTelegramMessage).toHaveBeenCalled()
    expect(sendTelegramOhlcPhotoOrText).not.toHaveBeenCalled()
    const text = vi.mocked(sendTelegramMessage).mock.calls[0]![0] as string
    expect(text).toContain('Follow alert')
    expect(text).toContain('gmgn.cc')
  })

  it('uses OHLC photo path when bars are dense enough', async () => {
    vi.mocked(loadOhlcBarsForTelegram).mockResolvedValueOnce(
      Array.from({ length: FOLLOW_ALERT_MIN_OHLC_BARS }, (_, i) => ({
        t: i,
        o: 1,
        h: 2,
        l: 0.5,
        c: 1.5,
        v: 1,
      })),
    )
    const result = await sendBestStrategyFollowAlert({
      strategyId: 'mcap_enter_first_seen',
      tokenAddress: 'MintABC',
      tokenSymbol: 'TEST',
      mcap: 80_000,
      force: true,
    })
    expect(result.sent).toBe(true)
    expect(sendTelegramOhlcPhotoOrText).toHaveBeenCalled()
    const caption = vi.mocked(sendTelegramOhlcPhotoOrText).mock.calls[0]![0]
      .caption as string
    expect(caption).toContain('first_seen')
    expect(caption).toContain('Follow alert')
  })
})
