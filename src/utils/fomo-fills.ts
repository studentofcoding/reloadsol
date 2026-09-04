import type { SocialIngestEvent } from '@/strategies/social/types'

export const FOMO_SOCIAL_SOURCE = 'fomo_family'

export type NormalizedFomoFill = {
  source_fill_id: number
  tx: string
  wallet_address: string
  token_address: string
  symbol: string | null
  name: string | null
  handle: string | null
  side: 'buy' | 'sell'
  usd: number | null
  amount: number | null
  price: number | null
  mark: number | null
  liquidity: number | null
  followers: number | null
  new_position: boolean | null
  is_stock: boolean
  priced: string | null
  block: number | null
  pair_url: string | null
  flags: unknown
  raw: Record<string, unknown>
  occurred_at: string
  chain: string
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  return v as Record<string, unknown>
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (v === 1 || v === '1') return true
  if (v === 0 || v === '0') return false
  return null
}

function asString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s || null
}

function occurredAtIso(ts: unknown): string | null {
  const n = asFiniteNumber(ts)
  if (n == null || n <= 0) return null
  const ms = n > 1e12 ? n : n * 1000
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/** Site tape/WS id — unique high-water mark. */
export function sourceFillId(raw: Record<string, unknown>): number | null {
  const n = asFiniteNumber(raw.id)
  if (n == null || !Number.isInteger(n) || n <= 0) return null
  return n
}

export function normalizeFomoFill(raw: unknown): NormalizedFomoFill | null {
  const rec = asRecord(raw)
  if (!rec) return null

  const id = sourceFillId(rec)
  const tx = asString(rec.tx)
  const wallet = asString(rec.wallet)
  const token = asString(rec.token)
  const sideRaw = asString(rec.side)?.toLowerCase()
  const occurred_at = occurredAtIso(rec.ts)
  if (
    id == null ||
    !tx ||
    !wallet ||
    !token ||
    (sideRaw !== 'buy' && sideRaw !== 'sell') ||
    !occurred_at
  ) {
    return null
  }

  return {
    source_fill_id: id,
    tx,
    wallet_address: wallet,
    token_address: token,
    symbol: asString(rec.symbol),
    name: asString(rec.name),
    handle: asString(rec.handle),
    side: sideRaw,
    usd: asFiniteNumber(rec.usd),
    amount: asFiniteNumber(rec.amount),
    price: asFiniteNumber(rec.price),
    mark: asFiniteNumber(rec.mark),
    liquidity: asFiniteNumber(rec.liquidity),
    followers: asFiniteNumber(rec.followers),
    new_position: asBool(rec.new_position),
    is_stock: asBool(rec.is_stock) ?? false,
    priced: asString(rec.priced),
    block: asFiniteNumber(rec.block),
    pair_url: asString(rec.pair_url),
    flags: rec.flags ?? null,
    raw: rec,
    occurred_at,
    chain: asString(rec.chain) ?? 'robinhood',
  }
}

export function maxFillsPerBatch(): number {
  const n = Number(process.env.FOMO_MAX_FILLS_PER_BATCH ?? '100')
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : 100
}

/** Cash-leg buys only. Skip wallets already on GMGN/digger/tracked rosters. */
export function fomoFillToSocialEvent(
  fill: NormalizedFomoFill,
  skipWallets: Set<string>,
): SocialIngestEvent | null {
  if (fill.side !== 'buy' || fill.priced !== 'cash_leg') return null
  const wallet = fill.wallet_address.toLowerCase()
  if (skipWallets.has(wallet)) return null
  return {
    token_address: fill.token_address.toLowerCase(),
    event_type: 'wallet_buy',
    source: FOMO_SOCIAL_SOURCE,
    channel_id: 'robinhoodtrenches',
    channel_label: fill.handle,
    wallet_address: wallet,
    wallet_label: fill.handle,
    external_message_id: String(fill.source_fill_id),
    occurred_at: fill.occurred_at,
    chain: 'robinhood',
    raw_metadata: {
      usd: fill.usd,
      priced: fill.priced,
      tx: fill.tx,
      symbol: fill.symbol,
      is_stock: fill.is_stock,
      source_fill_id: fill.source_fill_id,
    },
  }
}
