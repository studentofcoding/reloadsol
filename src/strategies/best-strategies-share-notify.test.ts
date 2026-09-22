import { afterEach, describe, expect, it, vi } from 'vitest'

const afterHarness = vi.hoisted(() => ({
  queue: [] as Array<() => void | Promise<void>>,
}))

vi.mock('next/server', () => ({
  after: (fn: () => void | Promise<void>) => {
    afterHarness.queue.push(fn)
  },
}))

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
  notifyBestStrategyFollowAlert,
  resetFollowAlertCooldownForTests,
  sendBestStrategyFollowAlert,
} from './best-strategies-share-notify'

afterEach(() => {
  vi.clearAllMocks()
  afterHarness.queue.length = 0
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

  it('uses a PNG chart whenever at least one OHLC bar exists', () => {
    expect(isOhlcTooThinForFollowAlert(0)).toBe(true)
    expect(isOhlcTooThinForFollowAlert(FOLLOW_ALERT_MIN_OHLC_BARS - 1)).toBe(
      true,
    )
    expect(isOhlcTooThinForFollowAlert(FOLLOW_ALERT_MIN_OHLC_BARS)).toBe(false)
    expect(FOLLOW_ALERT_MIN_OHLC_BARS).toBe(1)
  })

  it('cooldown blocks duplicate mint+arm blasts', () => {
    expect(claimFollowAlertCooldown('mcap_enter_at_80', 'MintA')).toBe(true)
    expect(claimFollowAlertCooldown('mcap_enter_at_80', 'MintA')).toBe(false)
    expect(claimFollowAlertCooldown('mcap_enter_first_seen', 'MintA')).toBe(true)
  })

  it('sends GMGN text only when there are no OHLC bars', async () => {
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

  it('uses the close-chart OHLC PNG path when any bars exist', async () => {
    const bars = [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }]
    vi.mocked(loadOhlcBarsForTelegram).mockResolvedValueOnce(bars)
    const result = await sendBestStrategyFollowAlert({
      strategyId: 'mcap_enter_first_seen',
      tokenAddress: 'MintABC',
      tokenSymbol: 'TEST',
      mcap: 80_000,
      force: true,
    })
    expect(result.sent).toBe(true)
    expect(result.usedPhoto).toBe(true)
    expect(sendTelegramMessage).not.toHaveBeenCalled()
    expect(sendTelegramOhlcPhotoOrText).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(sendTelegramOhlcPhotoOrText).mock.calls[0]![0]
    expect(arg.bars).toEqual(bars)
    expect(arg.caption).toContain('first_seen')
    expect(arg.caption).toContain('Follow alert')
  })

  it('does not encode the follow chart until after the response task runs', async () => {
    const bars = [{ t: 1, o: 1, h: 2, l: 0.5, c: 1.5, v: 1 }]
    vi.mocked(loadOhlcBarsForTelegram).mockResolvedValueOnce(bars)
    notifyBestStrategyFollowAlert({
      strategyId: 'mcap_enter_at_80',
      tokenAddress: 'MintDEF',
      tokenSymbol: 'TEST',
      mcap: 90_000,
      force: true,
    })
    expect(sendTelegramOhlcPhotoOrText).not.toHaveBeenCalled()
    expect(loadOhlcBarsForTelegram).not.toHaveBeenCalled()
    expect(afterHarness.queue).toHaveLength(1)
    await afterHarness.queue[0]!()
    expect(sendTelegramOhlcPhotoOrText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(sendTelegramOhlcPhotoOrText).mock.calls[0]![0].bars).toEqual(
      bars,
    )
  })
})
