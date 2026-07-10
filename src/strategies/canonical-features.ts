import type { StrategyDomain } from './types'
import { computeTokenAgeHours } from './entry-feature-snapshot'

export const FEATURE_SCHEMA_VERSION = 1 as const

export type InstrumentKind = 'spot_token' | 'dlmm_lp'

export type CanonicalEntryFeatures = {
  feature_schema_version: typeof FEATURE_SCHEMA_VERSION
  mint_address: string | null
  pool_address: string | null
  instrument: InstrumentKind
  entry_mcap: number | null
  entry_mcap_band: string | null
  organic_score: number | null
  top_holders_pct: number | null
  token_age_hours: number | null
  volume_at_entry: number | null
  entry_trigger: string | null
  pnl_basis: string | null
  /** Canonical social names (Pattern vocabulary) */
  mention_count_30m: number | null
  unique_channels_30m: number | null
  minutes_to_first_mention: number | null
  smart_wallet_buy_count_1h: number | null
  has_smart_wallet_buy: boolean | null
  domain_features: Record<string, unknown>
}

function readNum(features: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = features[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return null
}

function readStr(features: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = features[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function readBool(features: Record<string, unknown>, key: string): boolean | null {
  const v = features[key]
  if (typeof v === 'boolean') return v
  return null
}

const CORE_KEYS = new Set([
  'feature_schema_version',
  'mint_address',
  'pool_address',
  'instrument',
  'entry_mcap',
  'first_mcap',
  'entry_mcap_band',
  'organic_score',
  'top_holders_pct',
  'token_age_hours',
  'volume_at_entry',
  'volume_5m',
  'entry_trigger',
  'entry_template',
  'pnl_basis',
  'mention_count_30m',
  'telegram_mention_count_30m',
  'unique_channels_30m',
  'telegram_unique_channels_30m',
  'minutes_to_first_mention',
  'minutes_since_first_mention',
  'smart_wallet_buy_count_1h',
  'has_smart_wallet_buy',
  'domain_features',
  'pool_volume',
  'fee_tvl_ratio_24h',
  'pool_name',
  'position_id',
  'amount_sol',
  'first_seen_at',
])

/**
 * Normalize raw outcome/entry features into a token-centric canonical shape.
 * Preserves unknown keys under domain_features.
 */
export function toCanonicalEntryFeatures(
  raw: Record<string, unknown> | null | undefined,
  domain: StrategyDomain,
  opts?: {
    mintAddress?: string | null
    poolAddress?: string | null
    entryAt?: string | null
  },
): Record<string, unknown> {
  const features = raw ?? {}
  const existingDomain =
    features.domain_features && typeof features.domain_features === 'object'
      ? { ...(features.domain_features as Record<string, unknown>) }
      : {}

  const instrument: InstrumentKind =
    features.instrument === 'dlmm_lp' || domain === 'dlmm' ? 'dlmm_lp' : 'spot_token'

  const mint =
    opts?.mintAddress ??
    readStr(features, 'mint_address') ??
    (instrument === 'spot_token' ? null : null)

  const pool =
    opts?.poolAddress ??
    readStr(features, 'pool_address') ??
    (domain === 'dlmm' && !features.mint_address ? null : null)

  const entryMcap = readNum(features, 'entry_mcap', 'first_mcap')
  const mentionCount = readNum(features, 'mention_count_30m', 'telegram_mention_count_30m')
  const channels = readNum(features, 'unique_channels_30m', 'telegram_unique_channels_30m')
  const minutesMention = readNum(
    features,
    'minutes_to_first_mention',
    'minutes_since_first_mention',
  )

  const entryTrigger =
    readStr(features, 'entry_trigger') ??
    readStr(features, 'entry_template') ??
    null

  // Move LP-only volume out of token volume_at_entry
  let volumeAtEntry = readNum(features, 'volume_at_entry', 'volume_5m')
  const poolVolume = readNum(features, 'pool_volume')
  if (instrument === 'dlmm_lp' && poolVolume != null) {
    existingDomain.dlmm = {
      ...(typeof existingDomain.dlmm === 'object' && existingDomain.dlmm
        ? (existingDomain.dlmm as Record<string, unknown>)
        : {}),
      pool_volume_24h: poolVolume,
      fee_tvl_ratio_24h: readNum(features, 'fee_tvl_ratio_24h'),
    }
    // Prefer not to treat pool volume as token 5m volume
    if (features.volume_at_entry === poolVolume || features.volume_5m === poolVolume) {
      volumeAtEntry = readNum(features, 'volume_5m') === poolVolume ? null : volumeAtEntry
      if (volumeAtEntry === poolVolume) volumeAtEntry = null
    }
  }

  let tokenAgeHours = readNum(features, 'token_age_hours')
  if (tokenAgeHours == null) {
    const entryAt =
      opts?.entryAt ??
      (typeof features.entry_at === 'string' ? features.entry_at : null)
    const firstSeen = readStr(features, 'first_seen_at')
    tokenAgeHours = computeTokenAgeHours(entryAt, firstSeen)
    if (tokenAgeHours != null && tokenAgeHours > 168) tokenAgeHours = 168
  }

  const bag: Record<string, unknown> = { ...existingDomain }
  for (const [k, v] of Object.entries(features)) {
    if (CORE_KEYS.has(k)) continue
    if (k.startsWith('ml_')) {
      bag[k] = v
      continue
    }
    if (!(k in bag)) bag[k] = v
  }

  // Keep ml_* at top level for shadow scorers / UI
  const mlTop: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(features)) {
    if (k.startsWith('ml_')) mlTop[k] = v
  }

  return {
    ...mlTop,
    feature_schema_version: FEATURE_SCHEMA_VERSION,
    mint_address: mint,
    pool_address: pool,
    instrument,
    entry_mcap: entryMcap,
    first_mcap: entryMcap,
    entry_mcap_band: readStr(features, 'entry_mcap_band'),
    organic_score: readNum(features, 'organic_score'),
    top_holders_pct: readNum(features, 'top_holders_pct'),
    token_age_hours: tokenAgeHours,
    volume_at_entry: volumeAtEntry,
    volume_5m: volumeAtEntry,
    entry_trigger: entryTrigger,
    entry_template: readStr(features, 'entry_template') ?? entryTrigger,
    pnl_basis: readStr(features, 'pnl_basis'),
    first_seen_at: readStr(features, 'first_seen_at'),
    // Dual-write social aliases for gate + pattern extractors
    mention_count_30m: mentionCount,
    telegram_mention_count_30m: mentionCount,
    unique_channels_30m: channels,
    telegram_unique_channels_30m: channels,
    minutes_to_first_mention: minutesMention,
    minutes_since_first_mention: minutesMention,
    smart_wallet_buy_count_1h: readNum(features, 'smart_wallet_buy_count_1h'),
    has_smart_wallet_buy: readBool(features, 'has_smart_wallet_buy'),
    domain_features: bag,
  }
}

/** Prefer non-SOL mint from Meteora token pair. */
export function resolveDlmmMintFromPoolTokens(
  tokenX?: { address?: string; symbol?: string } | null,
  tokenY?: { address?: string; symbol?: string } | null,
): string | null {
  const SOL = 'So11111111111111111111111111111111111111112'
  const candidates = [tokenX, tokenY].filter(Boolean) as {
    address?: string
    symbol?: string
  }[]
  for (const t of candidates) {
    const addr = t.address?.trim()
    if (!addr) continue
    if (addr === SOL) continue
    const sym = (t.symbol || '').toUpperCase()
    if (sym === 'SOL' || sym === 'WSOL') continue
    return addr
  }
  for (const t of candidates) {
    if (t.address?.trim()) return t.address.trim()
  }
  return null
}
