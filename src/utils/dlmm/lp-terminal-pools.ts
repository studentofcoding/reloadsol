export type LpTerminalProto = 'univ2' | 'univ3' | 'univ4'

export type LpTerminalTokenMeta = {
  address: string
  symbol?: string
  decimals?: number
  priceUsd?: number | null
}

export type LpTerminalPoolRaw = {
  proto: LpTerminalProto | string
  address: string
  token0: string
  token1: string
  feePpm?: number | null
  tickSpacing?: number | null
  reserve0?: string | null
  reserve1?: string | null
  tvlUsd?: number | null
  vol24hUsd?: number | null
  txns24h?: number | null
  tvlApprox?: boolean
  /** Indexer-reported 24h gross fees (USDG basis); preferred over vol × fee. */
  fees24hUsd?: number | null
  swaps24h?: number | null
  adds24h?: number | null
  removes24h?: number | null
  lpCount?: number | null
  priceChangePct?: number | null
  activeTvlUsd?: number | null
  /** Indexer spot price (token1 per token0, USDG basis) — paper-LP mark. */
  priceQuote?: number | null
  risks?: string[]
  /** scoreRhPool() output attached by the route when the indexer is live. */
  score?: number | null
  scoreReasons?: string[]
  /** Trenches organic buy USD (24h) for the non-quote leg. */
  demandUsd?: number | null
}

export type LpIndexerHealth = {
  lag_s: number | null
  confidence: number
  no_trade: boolean
  reasons: string[]
}

export type LpTerminalPoolsResponse = {
  ready?: boolean
  asof?: number
  count?: number
  totals?: { univ2?: number; univ3?: number; univ4?: number }
  pools?: LpTerminalPoolRaw[]
  tokens?: Record<string, LpTerminalTokenMeta>
}

/** Known quote tokens on Robinhood Chain (prefer as quote side for display). */
const QUOTE_SYMBOLS = new Set(['USDG', 'USDC', 'USDT', 'WETH', 'ETH', 'UP'])

export function feeRateFromPpm(feePpm: number | null | undefined): number {
  if (feePpm == null || !Number.isFinite(feePpm) || feePpm < 0) return 0
  return feePpm / 1_000_000
}

export function fees24hUsd(
  vol24hUsd: number | null | undefined,
  feePpm: number | null | undefined,
): number {
  const vol = typeof vol24hUsd === 'number' && Number.isFinite(vol24hUsd) ? vol24hUsd : 0
  return vol * feeRateFromPpm(feePpm)
}

export function feeAprPct(
  fees24h: number,
  tvlUsd: number | null | undefined,
): number | null {
  const tvl = typeof tvlUsd === 'number' && Number.isFinite(tvlUsd) ? tvlUsd : 0
  if (tvl <= 0) return null
  return (fees24h * 365) / tvl * 100
}

export function tokenSymbol(
  tokens: Record<string, LpTerminalTokenMeta> | undefined,
  address: string,
): string {
  const meta = tokens?.[address]
  const sym = meta?.symbol?.trim()
  if (sym) return sym
  return address.slice(0, 6) + '…'
}

export function pairLabel(
  pool: Pick<LpTerminalPoolRaw, 'token0' | 'token1'>,
  tokens: Record<string, LpTerminalTokenMeta> | undefined,
): string {
  return `${tokenSymbol(tokens, pool.token0)}/${tokenSymbol(tokens, pool.token1)}`
}

export function protoBadge(proto: string): string {
  if (proto === 'univ4') return 'UNI V4'
  if (proto === 'univ3') return 'UNI V3'
  if (proto === 'univ2') return 'UNI V2'
  return proto.toUpperCase()
}

export function feeTierLabel(pool: LpTerminalPoolRaw): string {
  const feePct = feeRateFromPpm(pool.feePpm) * 100
  const feeStr =
    feePct >= 1 ? `${feePct.toFixed(2)}%` : `${feePct.toFixed(3)}%`
  if (pool.proto === 'univ4') {
    return pool.tickSpacing != null
      ? `v4 ts${pool.tickSpacing} · ${feeStr}`
      : `v4 · ${feeStr}`
  }
  if (pool.proto === 'univ3' && pool.tickSpacing != null) {
    return `v3 ts${pool.tickSpacing} · ${feeStr}`
  }
  if (pool.proto === 'univ2') return `v2 · ${feeStr}`
  return feeStr
}

function formatCompactAmount(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  if (n >= 1) return n.toFixed(2)
  if (n > 0) return n.toPrecision(3)
  return '0'
}

/**
 * Prefer quote = USDG/WETH/… when present; otherwise token1 as quote.
 * Price = quote per base from reserves when decimals known.
 */
export function priceReservesLabel(
  pool: LpTerminalPoolRaw,
  tokens: Record<string, LpTerminalTokenMeta> | undefined,
): string {
  const s0 = tokenSymbol(tokens, pool.token0)
  const s1 = tokenSymbol(tokens, pool.token1)
  const d0 = tokens?.[pool.token0]?.decimals ?? 18
  const d1 = tokens?.[pool.token1]?.decimals ?? 18
  const r0 = Number(pool.reserve0 ?? NaN) / 10 ** d0
  const r1 = Number(pool.reserve1 ?? NaN) / 10 ** d1

  if (!Number.isFinite(r0) || !Number.isFinite(r1) || (r0 <= 0 && r1 <= 0)) {
    return `${s0} / ${s1}`
  }

  const t0IsQuote = QUOTE_SYMBOLS.has(s0.toUpperCase())
  const t1IsQuote = QUOTE_SYMBOLS.has(s1.toUpperCase())
  let baseSym = s0
  let quoteSym = s1
  let baseAmt = r0
  let quoteAmt = r1
  if (t0IsQuote && !t1IsQuote) {
    baseSym = s1
    quoteSym = s0
    baseAmt = r1
    quoteAmt = r0
  }

  if (baseAmt > 0 && quoteAmt > 0) {
    const px = quoteAmt / baseAmt
    return `${formatCompactAmount(px)} ${quoteSym}/${baseSym}`
  }
  return `${formatCompactAmount(r0)} ${s0} + ${formatCompactAmount(r1)} ${s1}`
}

export type LpTerminalPoolRow = {
  address: string
  proto: string
  protoLabel: string
  pair: string
  feeTier: string
  priceReserves: string
  tvlUsd: number
  vol24hUsd: number
  fees24hUsd: number
  feeAprPct: number | null
  token0: string
  token1: string
  lpCount: number | null
  /** (adds + removes) / max(lpCount, 1); null when the indexer gave no counts. */
  churn: number | null
  priceChangePct: number | null
  risks: string[]
  score: number | null
  scoreReasons: string[]
  demandUsd: number | null
  tvlApprox: boolean
}

export function lpChurn(
  pool: Pick<LpTerminalPoolRaw, 'adds24h' | 'removes24h' | 'lpCount'>,
): number | null {
  if (pool.adds24h == null && pool.removes24h == null) return null
  const moves = (pool.adds24h ?? 0) + (pool.removes24h ?? 0)
  return moves / Math.max(pool.lpCount ?? 0, 1)
}

export function toPoolRows(
  pools: LpTerminalPoolRaw[],
  tokens: Record<string, LpTerminalTokenMeta> | undefined,
): LpTerminalPoolRow[] {
  return pools.map((pool) => {
    const fees =
      typeof pool.fees24hUsd === 'number' && Number.isFinite(pool.fees24hUsd)
        ? pool.fees24hUsd
        : fees24hUsd(pool.vol24hUsd, pool.feePpm)
    return {
      address: pool.address,
      proto: pool.proto,
      protoLabel: protoBadge(pool.proto),
      pair: pairLabel(pool, tokens),
      feeTier: feeTierLabel(pool),
      priceReserves: priceReservesLabel(pool, tokens),
      tvlUsd: Number(pool.tvlUsd) || 0,
      vol24hUsd: Number(pool.vol24hUsd) || 0,
      fees24hUsd: fees,
      feeAprPct: feeAprPct(fees, pool.tvlUsd),
      token0: pool.token0,
      token1: pool.token1,
      lpCount: pool.lpCount ?? null,
      churn: lpChurn(pool),
      priceChangePct: pool.priceChangePct ?? null,
      risks: pool.risks ?? [],
      score: pool.score ?? null,
      scoreReasons: pool.scoreReasons ?? [],
      demandUsd: pool.demandUsd ?? null,
      tvlApprox: pool.tvlApprox === true,
    }
  })
}
