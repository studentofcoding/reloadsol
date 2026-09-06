/**
 * Trenches (fomo_fills) → demand / toxic-flow features per token, and a
 * wallet-edge weight from the traders snapshot. Organic demand = cash-leg,
 * unflagged buys (airdrops and "not a real buy" excluded).
 */
import { query } from '@/utils/db'

export type FomoTokenDemand = {
  organicBuyUsd: number
  uniqueBuyers: number
  sellUsd: number
  /** sellUsd / (organicBuyUsd + sellUsd); 0 = pure buying, 1 = pure selling. */
  toxicRatio: number
}

export const EMPTY_DEMAND: FomoTokenDemand = {
  organicBuyUsd: 0,
  uniqueBuyers: 0,
  sellUsd: 0,
  toxicRatio: 0,
}

export function shapeDemandRow(row: {
  buy_usd: unknown
  buyers: unknown
  sell_usd: unknown
}): FomoTokenDemand {
  const buy = Number(row.buy_usd) || 0
  const sell = Number(row.sell_usd) || 0
  const total = buy + sell
  return {
    organicBuyUsd: buy,
    uniqueBuyers: Number(row.buyers) || 0,
    sellUsd: sell,
    toxicRatio: total > 0 ? sell / total : 0,
  }
}

/**
 * 24h organic demand per token (lowercase 0x). Missing tokens map to
 * EMPTY_DEMAND; a DB outage also yields an empty map so scoring degrades to
 * pool-only features instead of throwing.
 */
export async function fomoTokenDemand24h(
  tokens: readonly string[],
): Promise<Map<string, FomoTokenDemand>> {
  const out = new Map<string, FomoTokenDemand>()
  const uniq = [...new Set(tokens.map((t) => t.toLowerCase()))]
  if (uniq.length === 0) return out
  try {
    const { rows } = await query<{
      token: string
      buy_usd: string | null
      buyers: string | null
      sell_usd: string | null
    }>(
      `SELECT lower(token_address) AS token,
              SUM(CASE WHEN side = 'buy' AND priced = 'cash_leg' AND NOT synthetic THEN usd ELSE 0 END) AS buy_usd,
              COUNT(DISTINCT CASE WHEN side = 'buy' AND priced = 'cash_leg' AND NOT synthetic THEN wallet_address END) AS buyers,
              SUM(CASE WHEN side = 'sell' THEN COALESCE(usd, 0) ELSE 0 END) AS sell_usd
       FROM (
         SELECT token_address, side, priced, usd, wallet_address,
                EXISTS (
                  SELECT 1 FROM jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(flags) = 'array' THEN flags ELSE '[]'::jsonb END
                  ) f
                  WHERE f ILIKE '%airdrop%' OR f ILIKE '%not a real%' OR f ILIKE '%synthetic%'
                ) AS synthetic
         FROM fomo_fills
         WHERE occurred_at >= NOW() - INTERVAL '24 hours'
           AND lower(token_address) = ANY($1::text[])
       ) t
       GROUP BY 1`,
      [uniq],
    )
    for (const r of rows) out.set(r.token, shapeDemandRow(r))
  } catch (error) {
    console.warn('[fomo-demand] demand query skipped:', error instanceof Error ? error.message : error)
  }
  return out
}

export type FomoTraderRow = {
  realized_pnl?: number | null
  win_rate?: number | null
  closed_trades?: number | null
  wins?: number | null
}

/**
 * Wallet edge in [0, 2]: 1 = neutral. Needs >= minClosed closed trades, else 1
 * (no information). Win rate above/below 50% moves it, realized PnL sign nudges.
 */
export function fomoWalletEdge(t: FomoTraderRow | null | undefined, minClosed = 5): number {
  if (!t) return 1
  const closed = Number(t.closed_trades) || 0
  if (closed < minClosed) return 1
  const wr = Number(t.win_rate)
  const rate = Number.isFinite(wr) ? (wr > 1 ? wr / 100 : wr) : 0.5
  let edge = 1 + (rate - 0.5) * 2 // 0..2 from win rate
  const pnl = Number(t.realized_pnl)
  if (Number.isFinite(pnl) && pnl !== 0) edge += pnl > 0 ? 0.2 : -0.2
  return Math.max(0, Math.min(2, Math.round(edge * 100) / 100))
}
