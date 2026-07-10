import type { GmgnStrategy } from './types'
import {
  normalizeTrackRows,
  tokenInfo,
  tokenSecurity,
  trackKol,
  trackSmartMoney,
} from '@/utils/gmgn-cli'
import { evaluateGmgnSecurity } from './gmgn-security-gate'

export type GmgnDiscoveryCandidate = {
  tokenAddress: string
  symbol: string
  walletAddress: string
  tradeUsd: number
  tradeAt: Date
  source: 'smartmoney' | 'kol'
  walletTags: string[]
  clusterWalletCount: number
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
  const rows: GmgnDiscoveryCandidate[] = []

  if (discovery.source === 'smartmoney' || discovery.source === 'both') {
    const sm = await trackSmartMoney({
      chain: discovery.chain,
      side: discovery.side,
      limit: discovery.limit,
    })
    for (const row of normalizeTrackRows(sm, 'smartmoney')) {
      rows.push({ ...row, clusterWalletCount: 1 })
    }
  }

  if (discovery.source === 'kol' || discovery.source === 'both') {
    const kol = await trackKol({
      chain: discovery.chain,
      side: discovery.side,
      limit: discovery.limit,
    })
    for (const row of normalizeTrackRows(kol, 'kol')) {
      rows.push({ ...row, clusterWalletCount: 1 })
    }
  }

  const now = Date.now()
  const maxAgeMs = discovery.maxTradeAgeMinutes * 60 * 1000
  const minUsd = discovery.minAmountUsd ?? 0

  const filtered = rows.filter((r) => {
    if (r.tradeUsd < minUsd) return false
    if (now - r.tradeAt.getTime() > maxAgeMs) return false
    return true
  })

  const clusterByToken = new Map<string, Set<string>>()
  for (const row of filtered) {
    if (!row.walletAddress) continue
    const set = clusterByToken.get(row.tokenAddress) ?? new Set<string>()
    set.add(row.walletAddress)
    clusterByToken.set(row.tokenAddress, set)
  }

  const clusterMin = discovery.clusterMinWallets ?? 1
  const withCluster = filtered.map((row) => ({
    ...row,
    clusterWalletCount: clusterByToken.get(row.tokenAddress)?.size ?? 1,
  }))

  const clusterFiltered =
    clusterMin > 1
      ? withCluster.filter((r) => r.clusterWalletCount >= clusterMin)
      : withCluster

  const byToken = new Map<string, GmgnDiscoveryCandidate>()
  for (const row of clusterFiltered) {
    const existing = byToken.get(row.tokenAddress)
    if (!existing || row.tradeAt.getTime() > existing.tradeAt.getTime()) {
      byToken.set(row.tokenAddress, row)
    }
  }

  return Array.from(byToken.values()).sort(
    (a, b) => b.tradeAt.getTime() - a.tradeAt.getTime(),
  )
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

    gated.push({
      ...candidate,
      verdict: result.verdict,
      pass: result.pass,
      securityReasons: result.reasons,
      entryFeatures: {
        ...result.features,
        discovery_source: candidate.source,
        discovery_wallet: candidate.walletAddress,
        discovery_trade_usd: candidate.tradeUsd,
        discovery_trade_at: candidate.tradeAt.toISOString(),
        discovery_cluster_wallets: candidate.clusterWalletCount,
        gmgn_security_verdict: result.verdict,
        gmgn_security_reasons: result.reasons,
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
