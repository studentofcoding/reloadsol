/**
 * Robinhood Pools indexer (robinhoodpools.lol, chain 4663) — pure mappers for
 * `/api/lp/pools` rows and `/api/lp/status` health → LpTerminalPoolRaw + a
 * confidence score. No fetch here; the route/worker owns I/O.
 */
import type {
  LpTerminalPoolRaw,
  LpTerminalProto,
  LpTerminalTokenMeta,
} from '@/utils/dlmm/lp-terminal-pools'

export type RhPoolsToken = {
  address?: string | null
  symbol?: string | null
  decimals?: number | null
}

export type RhPoolsRow = {
  id: string
  pair?: string | null
  protocol?: string | null
  token0?: RhPoolsToken | null
  token1?: RhPoolsToken | null
  fee_ppm?: number | null
  tick_spacing?: number | null
  tvl_usd?: number | null
  active_tvl_usd?: number | null
  observed_active_tvl_usd?: number | null
  volume_usd?: number | null
  fees_usd?: number | null
  swaps?: number | null
  adds?: number | null
  removes?: number | null
  lp_count?: number | null
  price?: number | null
  price_change_pct?: number | null
  created_at?: number | null
  risks?: string[] | null
}

export type RhPoolsResponse = {
  rows?: RhPoolsRow[]
  total?: number
  as_of?: number
  coverage?: { complete?: boolean } | null
}

export type RhIndexerStatus = {
  lag_s?: number | null
  enrichment_deferred?: boolean | null
  reorg?: { at?: number | null } | null
  errors?: Record<string, unknown> | null
  as_of?: number | null
}

export type RhIndexerConfidence = {
  /** 0..1 multiplicative size factor. */
  score: number
  /** True when the score is below the trade floor → strategies must not size. */
  noTrade: boolean
  lagS: number | null
  reasons: string[]
}

export const RH_POOLS_SORTS = ['fees', 'volume', 'tvl', 'created'] as const
export type RhPoolsSort = (typeof RH_POOLS_SORTS)[number]
/** Server caps `limit` at 150 per page. */
export const RH_POOLS_PAGE_CAP = 150

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function protoOf(p: string | null | undefined): LpTerminalProto | null {
  const s = (p ?? '').toLowerCase()
  if (s === 'v2' || s === 'univ2') return 'univ2'
  if (s === 'v3' || s === 'univ3') return 'univ3'
  if (s === 'v4' || s === 'univ4') return 'univ4'
  return null
}

export function rhPoolsUrl(
  base: string,
  opts: { sort: 'tvl' | 'vol' | 'created' | 'fees'; limit: number; offset: number; q?: string; proto?: string },
): string {
  const sp = new URLSearchParams()
  sp.set('window', '24h')
  sp.set('limit', String(Math.min(RH_POOLS_PAGE_CAP, Math.max(1, opts.limit))))
  sp.set('offset', String(Math.max(0, opts.offset)))
  sp.set('sort', opts.sort === 'vol' ? 'volume' : opts.sort)
  if (opts.q) sp.set('q', opts.q)
  const proto = protoOf(opts.proto)
  if (proto) sp.set('protocol', proto.replace('uni', ''))
  return `${base}/api/lp/pools?${sp.toString()}`
}

/** Map one `/api/lp/pools` row; null when protocol/tokens are unusable. */
export function rhPoolRowToLpPool(
  row: RhPoolsRow,
): { pool: LpTerminalPoolRaw; tokens: Record<string, LpTerminalTokenMeta> } | null {
  const proto = protoOf(row.protocol)
  const t0 = row.token0?.address?.trim().toLowerCase()
  const t1 = row.token1?.address?.trim().toLowerCase()
  if (!proto || !row.id || !t0 || !t1) return null
  const tokens: Record<string, LpTerminalTokenMeta> = {
    [t0]: { address: t0, symbol: row.token0?.symbol ?? undefined, decimals: row.token0?.decimals ?? undefined },
    [t1]: { address: t1, symbol: row.token1?.symbol ?? undefined, decimals: row.token1?.decimals ?? undefined },
  }
  const tvl = num(row.tvl_usd)
  const pool: LpTerminalPoolRaw = {
    proto,
    address: row.id.toLowerCase(),
    token0: t0,
    token1: t1,
    feePpm: num(row.fee_ppm),
    tickSpacing: num(row.tick_spacing),
    tvlUsd: tvl ?? num(row.observed_active_tvl_usd) ?? 0,
    tvlApprox: tvl == null,
    vol24hUsd: num(row.volume_usd) ?? 0,
    txns24h: num(row.swaps),
    fees24hUsd: num(row.fees_usd),
    swaps24h: num(row.swaps),
    adds24h: num(row.adds),
    removes24h: num(row.removes),
    lpCount: num(row.lp_count),
    priceChangePct: num(row.price_change_pct),
    activeTvlUsd: num(row.active_tvl_usd) ?? num(row.observed_active_tvl_usd),
    priceQuote: num(row.price),
    risks: Array.isArray(row.risks) ? row.risks.filter((r) => typeof r === 'string') : [],
  }
  return { pool, tokens }
}

export function rhPoolsToCatalog(body: RhPoolsResponse): {
  pools: LpTerminalPoolRaw[]
  tokens: Record<string, LpTerminalTokenMeta>
  count: number
  totals: { univ2: number; univ3: number; univ4: number }
} {
  const pools: LpTerminalPoolRaw[] = []
  const tokens: Record<string, LpTerminalTokenMeta> = {}
  const totals = { univ2: 0, univ3: 0, univ4: 0 }
  for (const row of body.rows ?? []) {
    const m = rhPoolRowToLpPool(row)
    if (!m) continue
    pools.push(m.pool)
    Object.assign(tokens, m.tokens)
    totals[m.pool.proto as LpTerminalProto] += 1
  }
  return { pools, tokens, count: body.total ?? pools.length, totals }
}

function envNum(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Turn indexer health into a 0..1 size factor. Lag decays linearly to 0 at
 * RH_LP_MAX_LAG_S (default 15m); deferred trace enrichment, a reorg in the last
 * RH_LP_REORG_WINDOW_S (default 1h) and reported errors each take a fixed cut.
 * Below RH_LP_CONFIDENCE_FLOOR (default 0.35) → noTrade.
 */
export function rhIndexerConfidence(
  status: RhIndexerStatus | null | undefined,
  nowS: number = Date.now() / 1000,
): RhIndexerConfidence {
  if (!status) return { score: 0, noTrade: true, lagS: null, reasons: ['status unavailable'] }
  const maxLag = envNum('RH_LP_MAX_LAG_S', 900)
  const reorgWindow = envNum('RH_LP_REORG_WINDOW_S', 3600)
  const floor = envNum('RH_LP_CONFIDENCE_FLOOR', 0.35)
  const reasons: string[] = []
  const lagS = num(status.lag_s)
  let score = lagS == null ? 0.5 : Math.max(0, 1 - lagS / maxLag)
  if (lagS == null) reasons.push('lag unknown')
  else if (lagS > maxLag) reasons.push(`lag ${Math.round(lagS)}s > ${maxLag}s`)
  if (status.enrichment_deferred) {
    score *= 0.7
    reasons.push('trace enrichment deferred')
  }
  const reorgAt = num(status.reorg?.at)
  if (reorgAt != null && nowS - reorgAt < reorgWindow) {
    score *= 0.5
    reasons.push('recent reorg')
  }
  const errs = status.errors ? Object.keys(status.errors).length : 0
  if (errs > 0) {
    score *= 0.9
    reasons.push(`${errs} indexer error(s)`)
  }
  score = Math.round(Math.max(0, Math.min(1, score)) * 1000) / 1000
  return { score, noTrade: score < floor, lagS, reasons }
}
