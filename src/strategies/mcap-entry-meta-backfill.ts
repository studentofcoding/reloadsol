import { query } from '@/utils/db'
import { fetchDexScreenerVolumeHints } from '@/utils/dexscreener-volume'
import { upsertMcapEntryMeta } from '@/utils/mcap-tracker'
import { fetchJupiterEntryHints } from '@/strategies/resolve-entry-snapshot'

/**
 * Backfill `token_mcap_tracking` entry metadata for SOL tokens tracked without it.
 *
 * `upsertMcapEntryMeta` is called only from the entry-snapshot path, so a token
 * that is merely tracked (never evaluated for an entry) keeps NULL
 * `organic_score` / `top_holders_pct` / `volume_5m` forever — which starves the
 * pattern/ML features that read them.
 *
 * SOL ONLY. The Robinhood twins are deliberately unwired (see
 * docs/02-architecture-and-data.md), so the query is chain-scoped rather than
 * taking a chain parameter that could quietly do half a job.
 *
 * Reuses the exact sources and writer the live path uses, so a backfilled row is
 * indistinguishable from one written during a live open. Both hint fetchers
 * carry their own rate gates, so a run does not burst upstream.
 */

export type McapEntryMetaBackfillResult = {
  candidates: number
  filled: number
  empty: number
  failed: number
  dryRun: boolean
  sinceDays: number
}

export const MCAP_ENTRY_META_SOL_ONLY_MESSAGE =
  'token_mcap_tracking backfill is sol-only by design (RH twins unwired)'

export async function backfillMcapEntryMeta(opts: {
  sinceDays?: number
  limit?: number
  dryRun?: boolean
} = {}): Promise<McapEntryMetaBackfillResult> {
  const sinceDays = Number.isFinite(opts.sinceDays) ? Math.max(0, Math.floor(opts.sinceDays!)) : 7
  const limit = Number.isFinite(opts.limit) ? Math.min(2000, Math.max(1, Math.floor(opts.limit!))) : 300
  const dryRun = opts.dryRun === true

  const { rows } = await query<{ token_address: string }>(
    `SELECT token_address
       FROM token_mcap_tracking
      WHERE chain = 'sol'
        AND first_seen_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND (organic_score IS NULL OR top_holders_pct IS NULL)
      ORDER BY first_seen_at DESC
      LIMIT $2`,
    [sinceDays, limit],
  )

  let filled = 0
  let empty = 0
  let failed = 0

  for (const row of rows) {
    const tokenAddress = row.token_address
    try {
      const hints = await fetchJupiterEntryHints(tokenAddress, {
        needMeta: true,
        needVolume: true,
        needMcap: false,
      })
      const organicScore = hints?.organicScore ?? null
      const topHoldersPct = hints?.topHoldersPct ?? null
      let volume5m = hints?.volume5m ?? null

      if (volume5m == null) {
        const dex = await fetchDexScreenerVolumeHints(tokenAddress)
        if (dex) volume5m = dex.volume
      }
      if (organicScore == null && topHoldersPct == null && volume5m == null) {
        empty++
        continue
      }

      if (!dryRun) {
        await upsertMcapEntryMeta(tokenAddress, { organicScore, topHoldersPct, volume5m })
      }
      filled++
    } catch {
      failed++
    }
  }

  return { candidates: rows.length, filled, empty, failed, dryRun, sinceDays }
}
