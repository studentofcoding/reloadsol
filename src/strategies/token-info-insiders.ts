import { fetchGmgnWebTokenStat } from '@/utils/gmgn-web-extra'
import { buildGmgnTokenSnapshot, missingCoreTiles } from '@/strategies/gmgn-token-snapshot'

/**
 * The GMGN web `multi_token_full_info` row never carries an insider rate (verified on the live row,
 * see `gmgn-web-multi.fixtures.ts`), so `insiders_hold_pct` was NULL on every ledger row. The same
 * web API's `token_stat` does: `top_rat_trader_percentage` — GMGN's "Insiders" (rat-trader share).
 *
 * Fills `security.rat_trader_amount_rate` from it, once per ledger capture, and only when:
 *  - the snapshot has no insider value yet, and
 *  - the core tiles are all present (a panel the write-once gate will refuse is not worth a call).
 *
 * Fail-soft: any miss (parked endpoint, unconfigured host, error) returns `security` unchanged and
 * the tile stays NULL — it is never invented.
 */
export async function withInsidersFromTokenStat(
  mint: string,
  info: Record<string, unknown>,
  security: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const snap = buildGmgnTokenSnapshot(info, security)
  if (snap.insidersHoldPct != null) return security
  if (missingCoreTiles(snap).length > 0) return security
  try {
    const stat = await fetchGmgnWebTokenStat(mint)
    if (stat?.ratPct == null || !Number.isFinite(stat.ratPct)) return security
    // `ratPct` is already a percent; the snapshot reader takes a 0–1 rate.
    return { ...security, rat_trader_amount_rate: stat.ratPct / 100 }
  } catch {
    return security
  }
}
