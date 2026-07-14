import type { GmgnStrategy } from './types'
import {
  gmgnScoreToFeatureFields,
  scoreGmgnActivity,
  type GmgnActivityMetrics,
} from './gmgn-activity-score'
import {
  RADAR_ACCUMULATE_WINDOW_MS,
  accumulateRadarPeaks,
} from './gmgn-radar-accumulate'
import {
  buildGmgnRadarReview,
  gmgnRadarInputFromFeatures,
  withRadarActionOverride,
} from './gmgn-radar-review'
import { killAndBanRadarDump } from './gmgn-radar-dump'
import {
  applyRadarPriceRules,
  computeRadarPriceGrowth,
  extractRadarPriceStateFromEvents,
} from './gmgn-radar-price'
import { fetchRecentSocialEvents, fetchSocialEventsForTokenSince } from './social/db'
import {
  normalizeTrackRows,
  tokenInfo,
  tokenSecurity,
  trackKol,
  trackSmartMoney,
} from '@/utils/gmgn-cli'
import { evaluateGmgnSecurity } from './gmgn-security-gate'
import { fetchJupiterMarketHints } from '@/utils/jupiter-metadata'

export type GmgnDiscoveryCandidate = {
  tokenAddress: string
  symbol: string
  walletAddress: string
  tradeUsd: number
  tradeAt: Date
  source: 'smartmoney' | 'kol'
  walletTags: string[]
  clusterWalletCount: number
  activityScore: number
  activityMetrics: GmgnActivityMetrics
  discoverySources: Array<'smartmoney' | 'kol'>
}

export type GmgnGatedCandidate = GmgnDiscoveryCandidate & {
  verdict: string
  pass: boolean
  securityReasons: string[]
  entryFeatures: Record<string, unknown>
}

export async function fetchGmgnDiscoveryCandidates(
  strategy: GmgnStrategy,
): Promise<GmgnDiscoveryCandidate[]> {
  const { discovery } = strategy.config
  const normalized: ReturnType<typeof normalizeTrackRows> = []

  if (discovery.source === 'smartmoney' || discovery.source === 'both') {
    const sm = await trackSmartMoney({
      chain: discovery.chain,
      side: discovery.side,
      limit: discovery.limit,
    })
    normalized.push(...normalizeTrackRows(sm, 'smartmoney'))
  }

  if (discovery.source === 'kol' || discovery.source === 'both') {
    const kol = await trackKol({
      chain: discovery.chain,
      side: discovery.side,
      limit: discovery.limit,
    })
    normalized.push(...normalizeTrackRows(kol, 'kol'))
  }

  const now = Date.now()
  const maxAgeMs = discovery.maxTradeAgeMinutes * 60 * 1000
  const minUsd = discovery.minAmountUsd ?? 0

  const filtered = normalized.filter((r) => {
    if (r.tradeUsd < minUsd) return false
    if (now - r.tradeAt.getTime() > maxAgeMs) return false
    return true
  })

  const scored = scoreGmgnActivity(filtered, {
    windowMinutes: discovery.maxTradeAgeMinutes,
  })
  const scoreByToken = new Map(scored.map((item) => [item.tokenAddress, item]))

  const clusterByToken = new Map<string, Set<string>>()
  for (const row of filtered) {
    if (!row.walletAddress) continue
    const set = clusterByToken.get(row.tokenAddress) ?? new Set<string>()
    set.add(row.walletAddress)
    clusterByToken.set(row.tokenAddress, set)
  }

  const clusterMin = discovery.clusterMinWallets ?? 1
  const clusterFiltered = filtered.filter((row) => {
    const count = clusterByToken.get(row.tokenAddress)?.size ?? 1
    return count >= clusterMin
  })

  const byToken = new Map<string, GmgnDiscoveryCandidate>()
  for (const row of clusterFiltered) {
    const existing = byToken.get(row.tokenAddress)
    if (!existing || row.tradeAt.getTime() > existing.tradeAt.getTime()) {
      const activity = scoreByToken.get(row.tokenAddress)
      byToken.set(row.tokenAddress, {
        ...row,
        clusterWalletCount: clusterByToken.get(row.tokenAddress)?.size ?? 1,
        activityScore: activity?.score ?? 0,
        activityMetrics: activity?.metrics ?? {
          sm_wallet_count_60m: 0,
          kol_wallet_count_60m: 0,
          sm_buy_usd_60m: 0,
          kol_buy_usd_60m: 0,
          total_trades_60m: 0,
          latest_trade_at: row.tradeAt.toISOString(),
          has_sm_kol_overlap: false,
        },
        discoverySources: activity?.discoverySources ?? [row.source],
      })
    }
  }

  return Array.from(byToken.values()).sort((a, b) => {
    if (b.activityScore !== a.activityScore) return b.activityScore - a.activityScore
    return b.tradeAt.getTime() - a.tradeAt.getTime()
  })
}

export function filterGmgnCandidatesByCooldown(params: {
  candidates: GmgnDiscoveryCandidate[]
  openMints: Set<string>
  recentMints: Set<string>
}): GmgnDiscoveryCandidate[] {
  return params.candidates.filter((c) => {
    if (params.openMints.has(c.tokenAddress)) return false
    if (params.recentMints.has(c.tokenAddress)) return false
    return true
  })
}

export async function gateGmgnCandidates(params: {
  strategy: GmgnStrategy
  candidates: GmgnDiscoveryCandidate[]
}): Promise<GmgnGatedCandidate[]> {
  const maxCheck = params.strategy.config.security.maxCandidatesPerTick
  const slice = params.candidates.slice(0, maxCheck)
  const gated: GmgnGatedCandidate[] = []

  for (const candidate of slice) {
    const chain = params.strategy.config.discovery.chain
    const [info, security] = await Promise.all([
      tokenInfo({ chain, address: candidate.tokenAddress }),
      tokenSecurity({ chain, address: candidate.tokenAddress }),
    ])

    const result = evaluateGmgnSecurity({
      tokenAddress: candidate.tokenAddress,
      chain,
      info,
      security,
      config: params.strategy.config.security,
    })

    const since = new Date(Date.now() - RADAR_ACCUMULATE_WINDOW_MS).toISOString()
    const priorEvents = await fetchSocialEventsForTokenSince(
      candidate.tokenAddress,
      since,
      80,
    )
    const peaks = accumulateRadarPeaks({
      poll: {
        sm: candidate.activityMetrics.sm_wallet_count_60m,
        kol: candidate.activityMetrics.kol_wallet_count_60m,
        activityScore: candidate.activityScore,
      },
      events: priorEvents,
    })

    const radarBase = buildGmgnRadarReview(
      gmgnRadarInputFromFeatures({
        sm: peaks.smPeak,
        kol: peaks.kolPeak,
        features: {
          ...result.features,
          early_signals_score: peaks.earlySignalsScore,
          early_growth_pct: peaks.earlyGrowthPct,
        },
        activityScore: peaks.activityScorePeak,
        earlySignalsScore: peaks.earlySignalsScore,
        earlyGrowthPct: peaks.earlyGrowthPct,
      }),
    )

    const hints = await fetchJupiterMarketHints(candidate.tokenAddress)
    const priceUsd =
      hints?.usdPrice != null && hints.usdPrice > 0 ? hints.usdPrice : null
    const mcapUsd = hints?.mcap != null && hints.mcap > 0 ? hints.mcap : null
    const priceHistory = await fetchRecentSocialEvents(candidate.tokenAddress, 30)
    const { previousPriceUsd, stickyBaselineUsd, stickySinceIso } =
      extractRadarPriceStateFromEvents(priceHistory)
    const growthPct = computeRadarPriceGrowth(priceUsd, previousPriceUsd)
    const radarCfg = params.strategy.config.radar
    const priceRules = applyRadarPriceRules({
      action: radarBase.action,
      radarScore: radarBase.score,
      growthPct,
      stickyBaselineUsd,
      stickySinceIso,
      currentPriceUsd: priceUsd,
      previousPriceUsd,
      stickyPumpPct: radarCfg?.stickyPumpPct,
      dumpBanPct: radarCfg?.dumpBanPct,
      stickyTtlMinutes: radarCfg?.stickyTtlMinutes,
      enterOverrideMinScore: radarCfg?.enterOverrideMinScore,
    })

    const action = priceRules.action
    const banned = priceRules.banned
    const reasonParts = [...priceRules.reasons]

    if (banned) {
      void killAndBanRadarDump({
        tokenAddress: candidate.tokenAddress,
        tokenSymbol: candidate.symbol,
        sellPriceUsd: priceUsd,
      }).catch(() => {})
    }
    const radar =
      action !== radarBase.action || reasonParts.length > 0
        ? withRadarActionOverride(
            radarBase,
            action,
            reasonParts.join('; ') || null,
          )
        : radarBase

    gated.push({
      ...candidate,
      verdict: result.verdict,
      pass: result.pass && !banned,
      securityReasons: result.reasons,
      entryFeatures: {
        ...result.features,
        ...gmgnScoreToFeatureFields({
          score: candidate.activityScore,
          metrics: candidate.activityMetrics,
          discoverySources: candidate.discoverySources,
        }),
        discovery_source: candidate.source,
        discovery_wallet: candidate.walletAddress,
        discovery_trade_usd: candidate.tradeUsd,
        discovery_trade_at: candidate.tradeAt.toISOString(),
        discovery_cluster_wallets: candidate.clusterWalletCount,
        gmgn_security_verdict: result.verdict,
        gmgn_security_reasons: result.reasons,
        radar_action: radar.action,
        radar_score: radar.score,
        radar_summary: radar.summary,
        radar_gmgn_line: radar.gmgnLine,
        radar_raw_debug: radar.rawDebug ?? null,
        radar_sm_peak: peaks.smPeak,
        radar_kol_peak: peaks.kolPeak,
        radar_activity_peak: peaks.activityScorePeak,
        early_signals_score: peaks.earlySignalsScore,
        early_growth_pct: peaks.earlyGrowthPct,
        radar_price_usd: priceUsd,
        radar_mcap_usd: mcapUsd,
        radar_growth_pct: priceRules.growthPct,
        radar_watch_baseline_usd: priceRules.stickyBaselineUsd,
        radar_sticky_since_iso: priceRules.stickySinceIso,
        radar_dump_banned: banned ? 1 : 0,
        strategy_id: params.strategy.id,
        domain: 'gmgn',
      },
    })
  }

  return gated
}

export async function discoverAndGateGmgnCandidates(params: {
  strategy: GmgnStrategy
  openMints: Set<string>
  recentMints: Set<string>
}): Promise<{
  discovered: number
  eligible: GmgnGatedCandidate[]
  skipped: string[]
}> {
  const discovered = await fetchGmgnDiscoveryCandidates(params.strategy)
  const filtered = filterGmgnCandidatesByCooldown({
    candidates: discovered,
    openMints: params.openMints,
    recentMints: params.recentMints,
  })

  const gated = await gateGmgnCandidates({
    strategy: params.strategy,
    candidates: filtered,
  })

  const eligible = gated.filter((g) => g.pass)
  const skipped = gated
    .filter((g) => !g.pass)
    .map((g) => `${g.symbol}: ${g.securityReasons.join('; ') || g.verdict}`)

  return { discovered: discovered.length, eligible, skipped }
}
