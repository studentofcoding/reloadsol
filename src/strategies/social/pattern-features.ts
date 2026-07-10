import type { CombinedInternalExport } from './combined-pattern'

export const PATTERN_TOP_SOURCE_GMGN_FOMO = 'GMGN_Smart_Money_FOMO'

export const PATTERN_FEATURE_KEYS = [
  'log_first_mcap',
  'log_mention_count_30m',
  'unique_channels_30m',
  'minutes_to_first_mention',
  'smart_wallet_buy_count_1h',
  'has_smart_wallet_buy',
  'source_gmgn_smart_money_fomo',
  'gmgn_activity_score_60m',
  'log_gmgn_sm_wallets_60m',
  'has_gmgn_hot_before_entry',
] as const

export type PatternFeatureKey = (typeof PATTERN_FEATURE_KEYS)[number]

const WINDOW_30M_MS = 30 * 60 * 1000
const WINDOW_1H_MS = 60 * 60 * 1000

function readNum(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return null
}

function log1p(value: number | null): number | null {
  if (value == null || value < 0) return null
  return Math.log1p(value)
}

function capMinutes(minutes: number | null): number {
  if (minutes == null || minutes < 0 || !Number.isFinite(minutes)) return 0
  return Math.min(minutes, 720)
}

type SocialEventLike = {
  event_type?: unknown
  source?: unknown
  channel_id?: unknown
  occurred_at?: unknown
  raw_metadata?: unknown
}

function parseEvents(raw: unknown): SocialEventLike[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((e) => e && typeof e === 'object') as SocialEventLike[]
}

function eventMs(event: SocialEventLike): number | null {
  const iso = event.occurred_at
  if (typeof iso !== 'string' || !iso) return null
  const ms = new Date(iso).getTime()
  return Number.isFinite(ms) ? ms : null
}

function isWalletBuy(event: SocialEventLike): boolean {
  return String(event.event_type ?? '') === 'wallet_buy'
}

function isMention(event: SocialEventLike): boolean {
  return String(event.event_type ?? '') === 'mention'
}

function readMetadataNumber(meta: Record<string, unknown>, key: string): number {
  return readNum(meta[key]) ?? 0
}

function socialMetricsFromEvents(
  events: SocialEventLike[],
  firstSeenMs: number,
): {
  mentionCount30m: number
  uniqueChannels30m: number
  minutesToFirstMention: number
  walletBuyCount1h: number
  hasGmgnFomo: boolean
  gmgnActivityScore60m: number
  maxSmWallets60m: number
  hasGmgnHotBeforeEntry: boolean
} {
  const channels = new Set<string>()
  let mentionCount30m = 0
  let walletBuyCount1h = 0
  let firstMentionMs: number | null = null
  let hasGmgnFomo = false
  let gmgnActivityScore60m = 0
  let maxSmWallets60m = 0
  let hasGmgnHotBeforeEntry = false

  for (const event of events) {
    const ms = eventMs(event)
    if (ms == null) continue
    const delta = ms - firstSeenMs
    if (delta < 0) continue

    const source = String(event.source ?? '')

    if (isMention(event) && delta <= WINDOW_30M_MS) {
      mentionCount30m++
      const channel = String(event.channel_id ?? '')
      if (channel) channels.add(channel)
      if (source === PATTERN_TOP_SOURCE_GMGN_FOMO) {
        hasGmgnFomo = true
      }
      if (firstMentionMs == null || ms < firstMentionMs) {
        firstMentionMs = ms
      }
    }

    if (isWalletBuy(event) && delta <= WINDOW_1H_MS) {
      walletBuyCount1h++
      if (source.startsWith('gmgn_')) {
        if (source === 'gmgn_hot') hasGmgnHotBeforeEntry = true
        const meta =
          event.raw_metadata && typeof event.raw_metadata === 'object'
            ? (event.raw_metadata as Record<string, unknown>)
            : {}
        gmgnActivityScore60m = Math.max(
          gmgnActivityScore60m,
          readMetadataNumber(meta, 'gmgn_activity_score'),
        )
        maxSmWallets60m = Math.max(
          maxSmWallets60m,
          readMetadataNumber(meta, 'sm_wallet_count_60m'),
        )
      }
    }
  }

  const minutesToFirstMention =
    firstMentionMs == null
      ? 720
      : capMinutes(Math.round((firstMentionMs - firstSeenMs) / (60 * 1000)))

  return {
    mentionCount30m,
    uniqueChannels30m: channels.size,
    minutesToFirstMention,
    walletBuyCount1h,
    hasGmgnFomo,
    gmgnActivityScore60m,
    maxSmWallets60m,
    hasGmgnHotBeforeEntry,
  }
}

export function buildPatternFeatureVector(params: {
  firstMcap: number
  mentionCount30m: number
  uniqueChannels30m: number
  minutesToFirstMention: number
  smartWalletBuyCount1h: number
  hasGmgnFomoSource: boolean
  gmgnActivityScore60m?: number
  maxSmWallets60m?: number
  hasGmgnHotBeforeEntry?: boolean
}): Record<string, number> | null {
  const logFirstMcap = log1p(params.firstMcap)
  if (logFirstMcap == null) return null

  return {
    log_first_mcap: logFirstMcap,
    log_mention_count_30m: log1p(params.mentionCount30m) ?? 0,
    unique_channels_30m: params.uniqueChannels30m,
    minutes_to_first_mention: capMinutes(params.minutesToFirstMention),
    smart_wallet_buy_count_1h: params.smartWalletBuyCount1h,
    has_smart_wallet_buy: params.smartWalletBuyCount1h > 0 ? 1 : 0,
    source_gmgn_smart_money_fomo: params.hasGmgnFomoSource ? 1 : 0,
    gmgn_activity_score_60m: params.gmgnActivityScore60m ?? 0,
    log_gmgn_sm_wallets_60m: log1p(params.maxSmWallets60m ?? 0) ?? 0,
    has_gmgn_hot_before_entry: params.hasGmgnHotBeforeEntry ? 1 : 0,
  }
}

export function extractPatternFeaturesFromSnapshot(
  snapshot: CombinedInternalExport,
): Record<string, number> | null {
  const tracker = snapshot.mcapTracker
  if (!tracker || typeof tracker !== 'object') return null

  const row = tracker as Record<string, unknown>
  const firstMcap = readNum(row.first_mcap)
  const firstSeenRaw = row.first_seen_at ?? snapshot.exportedAt
  const firstSeenMs = new Date(String(firstSeenRaw)).getTime()
  if (firstMcap == null || !Number.isFinite(firstSeenMs)) return null

  const social = socialMetricsFromEvents(parseEvents(snapshot.socialEvents), firstSeenMs)

  return buildPatternFeatureVector({
    firstMcap,
    mentionCount30m: social.mentionCount30m,
    uniqueChannels30m: social.uniqueChannels30m,
    minutesToFirstMention: social.minutesToFirstMention,
    smartWalletBuyCount1h: social.walletBuyCount1h,
    hasGmgnFomoSource: social.hasGmgnFomo,
    gmgnActivityScore60m: social.gmgnActivityScore60m,
    maxSmWallets60m: social.maxSmWallets60m,
    hasGmgnHotBeforeEntry: social.hasGmgnHotBeforeEntry,
  })
}

/** Same vector at sim open from live entry_features + mcap snapshot fields. */
export function extractPatternFeaturesFromLiveEntry(
  entryFeatures: Record<string, unknown>,
): Record<string, number> | null {
  const firstMcap =
    readNum(entryFeatures.entry_mcap) ??
    readNum(entryFeatures.first_mcap) ??
    readNum(entryFeatures.entryMcap)
  if (firstMcap == null) return null

  const mentions = readNum(entryFeatures.telegram_mention_count_30m) ?? 0
  const channels = readNum(entryFeatures.telegram_unique_channels_30m) ?? 0
  const minutes = capMinutes(readNum(entryFeatures.minutes_since_first_mention))
  const walletBuys = readNum(entryFeatures.smart_wallet_buy_count_1h) ?? 0
  const hasWallet =
    entryFeatures.has_smart_wallet_buy === true || walletBuys > 0
  const topSource = String(entryFeatures.telegram_top_source ?? '')
  const hasGmgnFomo =
    topSource === PATTERN_TOP_SOURCE_GMGN_FOMO ||
    entryFeatures.source_gmgn_smart_money_fomo === 1

  const gmgnScore =
    readNum(entryFeatures.gmgn_activity_score) ??
    readNum(entryFeatures.gmgn_activity_score_60m) ??
    0
  const smWallets = readNum(entryFeatures.sm_wallet_count_60m) ?? 0
  const hasHot =
    entryFeatures.has_gmgn_hot_signal === 1 ||
    entryFeatures.has_gmgn_hot_signal === true ||
    entryFeatures.has_gmgn_hot_before_entry === 1

  return buildPatternFeatureVector({
    firstMcap,
    mentionCount30m: mentions,
    uniqueChannels30m: channels,
    minutesToFirstMention: minutes,
    smartWalletBuyCount1h: walletBuys,
    hasGmgnFomoSource: hasGmgnFomo,
    gmgnActivityScore60m: gmgnScore,
    maxSmWallets60m: smWallets,
    hasGmgnHotBeforeEntry: hasHot,
  })
}

export function patternClassFromCohort(cohort: string): 0 | 1 | null {
  if (cohort === 'winner') return 1
  if (cohort === 'loser') return 0
  return null
}

export function patternFeatureVectorToArray(
  vector: Record<string, number>,
  columns: readonly string[] = PATTERN_FEATURE_KEYS,
): Float32Array {
  const arr = new Float32Array(columns.length)
  for (let i = 0; i < columns.length; i++) {
    const v = vector[columns[i]]
    arr[i] = typeof v === 'number' && Number.isFinite(v) ? v : 0
  }
  return arr
}
