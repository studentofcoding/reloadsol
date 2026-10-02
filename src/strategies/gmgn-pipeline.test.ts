import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/gmgn-snapshot-cache', () => ({
  getGmgnTokenSnapshotCached: vi.fn(),
}))
vi.mock('@/strategies/token-info-detect', () => ({
  captureTokenInfoDetectBatch: vi.fn(),
}))
vi.mock('@/utils/gmgn-cli', () => ({
  normalizeTrackRows: vi.fn(),
  trackKol: vi.fn(),
  trackSmartMoney: vi.fn(),
}))
vi.mock('@/utils/jupiter-metadata', () => ({
  fetchJupiterMarketHints: vi.fn(),
}))
vi.mock('./concentration-ban', () => ({
  banConcentrationIfNeeded: vi.fn(),
}))
vi.mock('./ohlc-rug-shadow', () => ({
  attachOhlcRugShadow: vi.fn(),
}))
vi.mock('./gmgn-radar-dump', () => ({
  closeOpenSimsForRadarDump: vi.fn(),
  killAndBanRadarDump: vi.fn(),
}))
vi.mock('./gmgn-security-gate', () => ({
  evaluateGmgnSecurity: vi.fn(),
}))
vi.mock('./social/db', () => ({
  fetchRecentSocialEvents: vi.fn(),
  fetchSocialEventsForTokenSince: vi.fn(),
}))
vi.mock('./gmgn-activity-score', () => ({
  gmgnScoreToFeatureFields: vi.fn(),
  scoreGmgnActivity: vi.fn(),
}))
vi.mock('./gmgn-radar-accumulate', () => ({
  RADAR_ACCUMULATE_WINDOW_MS: 60_000,
  accumulateRadarPeaks: vi.fn(),
}))
vi.mock('./gmgn-radar-review', () => ({
  buildGmgnRadarReview: vi.fn(),
  gmgnRadarInputFromFeatures: vi.fn(),
  withRadarActionOverride: vi.fn(),
}))
vi.mock('./gmgn-radar-price', () => ({
  applyRadarPriceRules: vi.fn(),
  computeRadarPriceGrowth: vi.fn(),
  extractRadarPriceStateFromEvents: vi.fn(),
}))

import type { GmgnStrategy } from './types'
import { gateGmgnCandidates, type GmgnDiscoveryCandidate } from './gmgn-pipeline'
import { getGmgnTokenSnapshotCached } from '@/utils/gmgn-snapshot-cache'
import { captureTokenInfoDetectBatch } from '@/strategies/token-info-detect'
import { fetchJupiterMarketHints } from '@/utils/jupiter-metadata'
import { banConcentrationIfNeeded } from './concentration-ban'
import { attachOhlcRugShadow } from './ohlc-rug-shadow'
import { evaluateGmgnSecurity } from './gmgn-security-gate'
import { fetchRecentSocialEvents, fetchSocialEventsForTokenSince } from './social/db'
import { gmgnScoreToFeatureFields } from './gmgn-activity-score'
import { accumulateRadarPeaks } from './gmgn-radar-accumulate'
import { buildGmgnRadarReview, gmgnRadarInputFromFeatures } from './gmgn-radar-review'
import {
  applyRadarPriceRules,
  computeRadarPriceGrowth,
  extractRadarPriceStateFromEvents,
} from './gmgn-radar-price'

const MINT = 'So11111111111111111111111111111111111111112'

function returns<T extends (...args: never[]) => unknown>(fn: T, value: unknown): void {
  vi.mocked(fn).mockReturnValue(value as ReturnType<T>)
}

function resolves<T extends (...args: never[]) => unknown>(fn: T, value: unknown): void {
  vi.mocked(fn).mockResolvedValue(value as Awaited<ReturnType<T>>)
}

function strategyFixture(chain: 'sol' | 'robinhood'): GmgnStrategy {
  return {
    id: 'gmgn_smartmoney_default',
    config: {
      discovery: { chain },
      security: { maxCandidatesPerTick: 5 },
      radar: undefined,
    },
  } as unknown as GmgnStrategy
}

const candidate: GmgnDiscoveryCandidate = {
  tokenAddress: MINT,
  symbol: 'TEST',
  walletAddress: 'wallet1',
  tradeUsd: 100,
  tradeAt: new Date('2026-09-27T12:00:00.000Z'),
  source: 'smartmoney',
  walletTags: [],
  clusterWalletCount: 1,
  activityScore: 10,
  activityMetrics: {
    sm_wallet_count_60m: 1,
    kol_wallet_count_60m: 0,
    sm_buy_usd_60m: 100,
    kol_buy_usd_60m: 0,
    total_trades_60m: 1,
    latest_trade_at: '2026-09-27T12:00:00.000Z',
    has_sm_kol_overlap: false,
  },
  discoverySources: ['smartmoney'],
}

beforeEach(() => {
  vi.clearAllMocks()
  resolves(getGmgnTokenSnapshotCached, { info: { price: 1, market_cap: 1000 }, security: {} })
  resolves(attachOhlcRugShadow, { features: {} })
  resolves(banConcentrationIfNeeded, { banned: false, reasons: [] })
  resolves(evaluateGmgnSecurity, { pass: true, verdict: 'pass', reasons: [], features: {} })
  resolves(fetchSocialEventsForTokenSince, [])
  resolves(fetchRecentSocialEvents, [])
  resolves(fetchJupiterMarketHints, null)
  returns(gmgnScoreToFeatureFields, {})
  returns(accumulateRadarPeaks, {
    smPeak: 0,
    kolPeak: 0,
    activityScorePeak: 0,
    earlySignalsScore: 0,
    earlyGrowthPct: 0,
  })
  returns(gmgnRadarInputFromFeatures, {})
  returns(buildGmgnRadarReview, {
    action: 'enter',
    score: 0,
    summary: '',
    gmgnLine: '',
    rawDebug: null,
  })
  returns(extractRadarPriceStateFromEvents, {
    previousPriceUsd: null,
    stickyBaselineUsd: null,
    stickySinceIso: null,
  })
  returns(computeRadarPriceGrowth, null)
  returns(applyRadarPriceRules, {
    action: 'enter',
    banned: false,
    reasons: [],
    growthPct: null,
    stickyBaselineUsd: null,
    stickySinceIso: null,
  })
})

describe('gateGmgnCandidates token-info capture seam', () => {
  it('captures the selected Sol candidate with the panel already in hand', async () => {
    await gateGmgnCandidates({
      strategy: strategyFixture('sol'),
      candidates: [candidate],
    })

    expect(captureTokenInfoDetectBatch).toHaveBeenCalledTimes(1)
    expect(captureTokenInfoDetectBatch).toHaveBeenCalledWith([
      {
        chain: 'sol',
        tokenAddress: MINT,
        detectingStrategy: 'gmgn_smartmoney_default',
        source: 'gmgn_pipeline',
        info: { price: 1, market_cap: 1000 },
        security: {},
      },
    ])
  })

  it('still captures when a later gate throws (finally)', async () => {
    vi.mocked(banConcentrationIfNeeded).mockRejectedValueOnce(new Error('boom'))

    await expect(
      gateGmgnCandidates({
        strategy: strategyFixture('sol'),
        candidates: [candidate],
      }),
    ).rejects.toThrow('boom')

    expect(captureTokenInfoDetectBatch).toHaveBeenCalledTimes(1)
    expect(captureTokenInfoDetectBatch).toHaveBeenCalledWith([
      expect.objectContaining({ chain: 'sol', tokenAddress: MINT, source: 'gmgn_pipeline' }),
    ])
  })

  it('leaves Robinhood unwired', async () => {
    await gateGmgnCandidates({
      strategy: strategyFixture('robinhood'),
      candidates: [candidate],
    })

    const captured = vi
      .mocked(captureTokenInfoDetectBatch)
      .mock.calls.flatMap(([items]) => items)
    expect(captured).toEqual([])
  })
})
