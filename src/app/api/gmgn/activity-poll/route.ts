import { NextRequest, NextResponse } from 'next/server'
import {
  getGmgnActivityIngestCooldownMin,
  getGmgnActivityPollLimit,
  getGmgnActivityScoreThreshold,
  getGmgnActivityWindowMinutes,
  gmgnScoreToFeatureFields,
  scoreGmgnActivity,
} from '@/strategies/gmgn-activity-score'
import {
  RADAR_ACCUMULATE_WINDOW_MS,
  accumulateRadarPeaks,
} from '@/strategies/gmgn-radar-accumulate'
import { killAndBanRadarDump } from '@/strategies/gmgn-radar-dump'
import {
  applyRadarPriceRules,
  computeRadarPriceGrowth,
  extractRadarPriceStateFromEvents,
} from '@/strategies/gmgn-radar-price'
import {
  buildGmgnRadarReview,
  resolveRadarTop10,
  withRadarActionOverride,
  type GmgnRadarInput,
  type GmgnRadarReview,
} from '@/strategies/gmgn-radar-review'
import {
  fetchRecentSocialEvents,
  fetchSocialEventsForTokenSince,
  hasRecentGmgnEvent,
  insertSocialEvents,
} from '@/strategies/social/db'
import { applyGmgnLiveBoost } from '@/strategies/gmgn-live-boost'
import type { SocialIngestEvent } from '@/strategies/social/types'
import { normalizeTrackRows, trackKol, trackSmartMoney } from '@/utils/gmgn-cli'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import { fetchTokenMetadataFromJupiter } from '@/utils/jupiter-metadata'
import { isTokenRugged } from '@/utils/rug-list/db'
import { fetchTokenPricesForTracking } from '@/utils/trading-tracker'
import { sendGmgnRadarAlert } from '@/utils/telegram'
import { log } from '@/utils/unified-logger'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

function getPollSecret(): string {
  return (
    process.env.GMGN_ACTIVITY_POLL_SECRET ||
    process.env.GMGN_SIM_TRACK_SECRET ||
    process.env.SIGNALS_SIM_TRACK_SECRET ||
    process.env.TRENDING_TRACKER_SECRET ||
    'r3l0ads0l-trending'
  )
}

function resolveIngestSource(result: {
  discoverySources: Array<'smartmoney' | 'kol'>
}): string {
  if (result.discoverySources.includes('smartmoney') && result.discoverySources.includes('kol')) {
    return 'gmgn_hot'
  }
  if (result.discoverySources.includes('kol')) return 'gmgn_kol'
  return 'gmgn_smartmoney'
}

async function fetchJupiterTop10Pct(tokenAddress: string): Promise<number | null> {
  try {
    const meta = await fetchTokenMetadataFromJupiter(tokenAddress)
    const pct = meta?.audit?.topHoldersPercentage
    return typeof pct === 'number' && Number.isFinite(pct) ? pct : null
  } catch {
    return null
  }
}

async function buildAccumulatedRadarInput(params: {
  tokenAddress: string
  sm: number
  kol: number
  activityScore: number
  gmgnTop10?: number | null
}): Promise<GmgnRadarInput> {
  const since = new Date(Date.now() - RADAR_ACCUMULATE_WINDOW_MS).toISOString()
  const events = await fetchSocialEventsForTokenSince(params.tokenAddress, since, 80)
  const peaks = accumulateRadarPeaks({
    poll: {
      sm: params.sm,
      kol: params.kol,
      activityScore: params.activityScore,
    },
    events,
  })

  let jupiterTop10: number | null = null
  const gmgnTop10 = params.gmgnTop10 ?? null
  if (gmgnTop10 == null || !Number.isFinite(gmgnTop10)) {
    jupiterTop10 = await fetchJupiterTop10Pct(params.tokenAddress)
  }
  const top10 = resolveRadarTop10({
    gmgnTop10,
    jupiterTop10Pct: jupiterTop10,
  })

  return {
    sm: peaks.smPeak,
    kol: peaks.kolPeak,
    activityScore: peaks.activityScorePeak,
    earlySignalsScore: peaks.earlySignalsScore,
    earlyGrowthPct: peaks.earlyGrowthPct,
    top10: top10.top10,
    top10Source: top10.top10Source,
    tokenAddress: params.tokenAddress,
  }
}

async function applyPriceRulesToRadar(params: {
  tokenAddress: string
  symbol: string
  review: GmgnRadarReview
  priceUsd: number | null
}): Promise<{
  review: GmgnRadarReview
  priceUsd: number | null
  growthPct: number | null
  stickyBaselineUsd: number | null
  banned: boolean
}> {
  const priorEvents = await fetchRecentSocialEvents(params.tokenAddress, 30)
  const { previousPriceUsd, stickyBaselineUsd } =
    extractRadarPriceStateFromEvents(priorEvents)
  const growthPct = computeRadarPriceGrowth(params.priceUsd, previousPriceUsd)
  const rules = applyRadarPriceRules({
    action: params.review.action,
    growthPct,
    stickyBaselineUsd,
    currentPriceUsd: params.priceUsd,
    previousPriceUsd,
  })

  if (rules.banned) {
    void killAndBanRadarDump({
      tokenAddress: params.tokenAddress,
      tokenSymbol: params.symbol,
      sellPriceUsd: params.priceUsd,
    }).catch((err) => {
      console.error('[gmgn-activity-poll] radar dump ban/kill failed:', err)
    })
  }

  const extra =
    rules.reasons.length > 0 ? rules.reasons.join('; ') : null
  const review =
    rules.action !== params.review.action || extra
      ? withRadarActionOverride(params.review, rules.action, extra)
      : params.review

  return {
    review,
    priceUsd: params.priceUsd,
    growthPct: rules.growthPct,
    stickyBaselineUsd: rules.stickyBaselineUsd,
    banned: rules.banned,
  }
}

export async function POST(request: NextRequest) {
  const key = request.nextUrl.searchParams.get('key')
  if (!isAuthorizedRequest(key, getPollSecret())) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const chain = 'sol'
    const limit = getGmgnActivityPollLimit()
    const threshold = getGmgnActivityScoreThreshold()
    const cooldownMin = getGmgnActivityIngestCooldownMin()
    const windowMinutes = getGmgnActivityWindowMinutes()

    const [smRows, kolRows] = await Promise.all([
      trackSmartMoney({ chain, side: 'buy', limit }),
      trackKol({ chain, side: 'buy', limit }),
    ])

    const normalized = [
      ...normalizeTrackRows(smRows, 'smartmoney'),
      ...normalizeTrackRows(kolRows, 'kol'),
    ]

    const scored = scoreGmgnActivity(normalized, { windowMinutes })
    const hot = scored.filter((item) => item.score >= threshold)

    const prices =
      hot.length > 0
        ? await fetchTokenPricesForTracking(hot.map((h) => h.tokenAddress))
        : {}

    const events: SocialIngestEvent[] = []
    let skipped = 0
    let dumpBanned = 0
    const radarByMint = new Map<string, GmgnRadarReview>()

    for (const item of hot) {
      const recent = await hasRecentGmgnEvent(item.tokenAddress, cooldownMin)
      if (recent) {
        skipped++
        continue
      }

      const source = resolveIngestSource(item)
      const radarInput = await buildAccumulatedRadarInput({
        tokenAddress: item.tokenAddress,
        sm: item.metrics.sm_wallet_count_60m,
        kol: item.metrics.kol_wallet_count_60m,
        activityScore: item.score,
      })
      let radar = buildGmgnRadarReview(radarInput)

      const priceUsd = prices[item.tokenAddress] ?? null
      const priced = await applyPriceRulesToRadar({
        tokenAddress: item.tokenAddress,
        symbol: item.symbol,
        review: radar,
        priceUsd: typeof priceUsd === 'number' && priceUsd > 0 ? priceUsd : null,
      })
      radar = priced.review
      if (priced.banned) dumpBanned++

      radarByMint.set(item.tokenAddress, radar)

      events.push({
        token_address: item.tokenAddress,
        event_type: 'wallet_buy',
        source,
        wallet_address: item.latestTrade.walletAddress || null,
        occurred_at: item.metrics.latest_trade_at,
        raw_metadata: {
          ...gmgnScoreToFeatureFields({
            score: item.score,
            metrics: item.metrics,
            discoverySources: item.discoverySources,
            hasHotSignal: source === 'gmgn_hot',
          }),
          symbol: item.symbol,
          radar_action: radar.action,
          radar_score: radar.score,
          radar_summary: radar.summary,
          radar_gmgn_line: radar.gmgnLine,
          radar_sm_peak: radarInput.sm,
          radar_kol_peak: radarInput.kol,
          radar_activity_peak: radarInput.activityScore,
          radar_early_score: radarInput.earlySignalsScore,
          top10_source: radarInput.top10Source,
          jupiter_top_holders_pct:
            radarInput.top10Source === 'jupiter' ? radarInput.top10 : undefined,
          radar_price_usd: priced.priceUsd,
          radar_growth_pct: priced.growthPct,
          radar_watch_baseline_usd: priced.stickyBaselineUsd,
          radar_dump_banned: priced.banned ? 1 : 0,
        },
      })

      const rugged = priced.banned || (await isTokenRugged(item.tokenAddress))
      if (!rugged) {
        void sendGmgnRadarAlert({
          review: radar,
          symbol: item.symbol,
          tokenAddress: item.tokenAddress,
          category: source === 'gmgn_hot' ? 'HOT' : source === 'gmgn_kol' ? 'KOL' : 'SM',
          eventLabel: `activity score ${item.score}`,
        }).catch((err) => {
          console.error('[gmgn-activity-poll] radar telegram failed:', err)
        })
      }
    }

    const ingestResult =
      events.length > 0 ? await insertSocialEvents(events) : { inserted: 0, skipped: 0, errors: [] }

    let liveBoosted = 0
    if (ingestResult.inserted > 0) {
      for (const event of events) {
        const boost = await applyGmgnLiveBoost({
          tokenAddress: event.token_address,
          hotEvent: {
            occurred_at: event.occurred_at ?? new Date().toISOString(),
            raw_metadata: event.raw_metadata,
          },
          source: 'activity_poll',
        })
        liveBoosted += boost.simPositionsBoosted
      }
    }

    log.info('api_request', 'GMGN activity poll', {
      polled: normalized.length,
      hotCount: hot.length,
      ingested: ingestResult.inserted,
      skipped,
      ingestSkipped: ingestResult.skipped,
      liveBoosted,
      dumpBanned,
    })

    return NextResponse.json({
      success: true,
      polled: normalized.length,
      hotCount: hot.length,
      ingested: ingestResult.inserted,
      skipped,
      ingestErrors: ingestResult.errors,
      liveBoosted,
      dumpBanned,
      top: hot.slice(0, 10).map((item) => {
        const radar =
          radarByMint.get(item.tokenAddress) ??
          buildGmgnRadarReview({
            sm: item.metrics.sm_wallet_count_60m,
            kol: item.metrics.kol_wallet_count_60m,
            activityScore: item.score,
          })
        return {
          symbol: item.symbol,
          tokenAddress: item.tokenAddress,
          score: item.score,
          radar: {
            action: radar.action,
            score: radar.score,
            summary: radar.summary,
            gmgn: radar.gmgnLine,
          },
        }
      }),
    })
  } catch (error) {
    log.error('error_handling', 'GMGN activity poll failed', error as Error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
