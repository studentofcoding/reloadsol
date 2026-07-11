export type TokenMapDomain =
  | 'mcap_tracker'
  | 'signals'
  | 'gmgn'
  | 'trending_bot'
  | 'dlmm'
  | 'social'
  | 'infra'

export type TokenMapActivityKind =
  | 'social_event'
  | 'sim_open'
  | 'sim_close'
  | 'gmgn_hot'
  | 'live_boost'
  | 'outcome'

export type TokenMapActivityItem = {
  id: string
  domain: TokenMapDomain
  kind: TokenMapActivityKind
  title: string
  detail?: string
  occurredAt: string
  source?: string
}

export const TOKEN_MAP_LANES: { domain: TokenMapDomain; label: string }[] = [
  { domain: 'mcap_tracker', label: 'MCap tracker' },
  { domain: 'signals', label: 'Signals' },
  { domain: 'gmgn', label: 'GMGN' },
  { domain: 'trending_bot', label: 'Trending' },
  { domain: 'dlmm', label: 'DLMM' },
  { domain: 'social', label: 'Social' },
]

/** ponytail: source→lane mapping; extend when new ingest sources appear */
export function socialDomainAndKind(source: string): {
  domain: TokenMapDomain
  kind: TokenMapActivityKind
} {
  if (source === 'gmgn_hot' || source.startsWith('gmgn_')) {
    return {
      domain: 'gmgn',
      kind: source === 'gmgn_hot' ? 'gmgn_hot' : 'social_event',
    }
  }
  return { domain: 'social', kind: 'social_event' }
}
