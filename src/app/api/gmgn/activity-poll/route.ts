import { NextRequest, NextResponse } from 'next/server'
import {
  getGmgnActivityIngestCooldownMin,
  getGmgnActivityPollLimit,
  getGmgnActivityScoreThreshold,
  getGmgnActivityWindowMinutes,
  gmgnScoreToFeatureFields,
  scoreGmgnActivity,
} from '@/strategies/gmgn-activity-score'
import { buildGmgnRadarReview } from '@/strategies/gmgn-radar-review'
import { hasRecentGmgnEvent, insertSocialEvents } from '@/strategies/social/db'
import { applyGmgnLiveBoost } from '@/strategies/gmgn-live-boost'
import type { SocialIngestEvent } from '@/strategies/social/types'
import { normalizeTrackRows, trackKol, trackSmartMoney } from '@/utils/gmgn-cli'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
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

    const events: SocialIngestEvent[] = []
    let skipped = 0

    for (const item of hot) {
      const recent = await hasRecentGmgnEvent(item.tokenAddress, cooldownMin)
      if (recent) {
        skipped++
        continue
      }

      const source = resolveIngestSource(item)
      const radar = buildGmgnRadarReview({
        sm: item.metrics.sm_wallet_count_60m,
        kol: item.metrics.kol_wallet_count_60m,
      })
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
        },
      })

      // ponytail: fire-and-forget alert; don't block ingest on telegram
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
    })

    return NextResponse.json({
      success: true,
      polled: normalized.length,
      hotCount: hot.length,
      ingested: ingestResult.inserted,
      skipped,
      ingestErrors: ingestResult.errors,
      liveBoosted,
      top: hot.slice(0, 10).map((item) => {
        const radar = buildGmgnRadarReview({
          sm: item.metrics.sm_wallet_count_60m,
          kol: item.metrics.kol_wallet_count_60m,
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
