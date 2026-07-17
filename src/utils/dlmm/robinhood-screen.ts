import type { GmgnMarketRankRow } from '@/utils/gmgn-api'

export const ROBINHOOD_LP_DEFAULTS = {
  chain: 'robinhood' as const,
  interval: '24h' as const,
  minMcap: 500_000,
  minVolume: 1_000_000,
  limit: 50,
}

export type CommunityCue = 'komun_ok' | 'komun_thin'
export type FomoCue = 'fomo_hot' | 'fomo_quiet'

export type RobinhoodScreenToken = {
  address: string
  symbol: string
  name: string
  marketCap: number
  volume24h: number
  liquidity: number
  holders: number
  launchpad: string
  website: string
  twitter: string
  telegram: string
  priceChangePct: number
  hotLevel: number
  smartDegenCount: number
  renownedCount: number
  visitingCount: number
  communityCue: CommunityCue
  fomoCue: FomoCue
}

function asNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : 0
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function isFlapLaunchpad(row: {
  launchpad?: unknown
  launchpad_platform?: unknown
  website?: unknown
}): boolean {
  const hay = [
    asString(row.launchpad),
    asString(row.launchpad_platform),
    asString(row.website),
  ]
    .join(' ')
    .toLowerCase()
  return hay.includes('flap')
}

export function communityCue(row: {
  twitter_username?: unknown
  telegram?: unknown
  website?: unknown
}): CommunityCue {
  const twitter = asString(row.twitter_username)
  const telegram = asString(row.telegram)
  const website = asString(row.website)
  if (twitter && (telegram || website)) return 'komun_ok'
  return 'komun_thin'
}

export function fomoCue(row: {
  hot_level?: unknown
  price_change_percent?: unknown
  smart_degen_count?: unknown
  renowned_count?: unknown
  visiting_count?: unknown
}): FomoCue {
  const hot = asNumber(row.hot_level)
  const pct = asNumber(row.price_change_percent)
  const sm = asNumber(row.smart_degen_count)
  const kol = asNumber(row.renowned_count)
  const visits = asNumber(row.visiting_count)
  // ponytail: coarse FOMO heuristic — tune thresholds after a week of RH screens
  if (hot >= 2 || pct >= 30 || sm + kol >= 20 || visits >= 200) return 'fomo_hot'
  return 'fomo_quiet'
}

export function applyRobinhoodLpFilters(
  rows: GmgnMarketRankRow[],
  opts: { minMcap?: number; minVolume?: number } = {},
): RobinhoodScreenToken[] {
  const minMcap = opts.minMcap ?? ROBINHOOD_LP_DEFAULTS.minMcap
  const minVolume = opts.minVolume ?? ROBINHOOD_LP_DEFAULTS.minVolume

  const out: RobinhoodScreenToken[] = []
  for (const row of rows) {
    const address = asString(row.address)
    if (!address) continue
    if (isFlapLaunchpad(row)) continue
    const marketCap = asNumber(row.market_cap)
    const volume24h = asNumber(row.volume)
    if (marketCap <= minMcap) continue
    if (volume24h <= minVolume) continue

    out.push({
      address,
      symbol: asString(row.symbol) || address.slice(0, 8),
      name: asString(row.name) || asString(row.symbol) || address.slice(0, 8),
      marketCap,
      volume24h,
      liquidity: asNumber(row.liquidity),
      holders: asNumber(row.holder_count),
      launchpad:
        asString(row.launchpad_platform) || asString(row.launchpad) || '—',
      website: asString(row.website),
      twitter: asString(row.twitter_username),
      telegram: asString(row.telegram),
      priceChangePct: asNumber(row.price_change_percent),
      hotLevel: asNumber(row.hot_level),
      smartDegenCount: asNumber(row.smart_degen_count),
      renownedCount: asNumber(row.renowned_count),
      visitingCount: asNumber(row.visiting_count),
      communityCue: communityCue(row),
      fomoCue: fomoCue(row),
    })
  }
  return out
}
