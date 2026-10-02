/**
 * The watch set — one definition, shared by both writers of the per-token series.
 *
 * `ohlc_sampler` (every 15s, Jupiter spot price only) and `metrics_copier` (candles with volume)
 * must agree on which tokens are worth tracking. Two copies of this SQL would drift, and the two
 * series would stop lining up on exactly the tokens that matter. Sol only: pricing is Jupiter.
 *
 * The watch set is: mcap candidates in the tracking band + trending-tracker rows + mints with a
 * recent sim buy (a cheap proxy for "has an open position" — full open-cycle reconstruction is too
 * heavy for a 15s tick) + fresh FOMO mention mints (so a social open has its own series from the
 * first tick).
 */

import { query } from '@/utils/db'

export const WATCH_RANGE_MIN = 30_000
export const WATCH_RANGE_MAX = 2_000_000
export const WATCH_SOCIAL_WINDOW_MIN = 30
export const DEFAULT_WATCH_MAX_MINTS = 300

/** Params: `$1` mcap min, `$2` mcap max, `$3` limit, `$4` social window (minutes). */
export const WATCH_SQL = `
WITH watch AS (
  SELECT token_address, last_updated_at AS seen_at
    FROM token_mcap_tracking
   WHERE COALESCE(chain, 'sol') = 'sol'
     AND current_mcap >= $1 AND current_mcap <= $2
  UNION ALL
  SELECT token_address, COALESCE(updated_at, tracking_started_at) AS seen_at
    FROM trending_token_tracker
   WHERE status IN ('tracking', 'waiting')
  UNION ALL
  SELECT t->>'mintAddress' AS token_address, r.created_at AS seen_at
    FROM trading_records r
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.data->'tokens', '[]'::jsonb)) t
   WHERE r.operation_type = 'buy'
     AND COALESCE(r.chain, 'sol') = 'sol'
     AND r.created_at > now() - interval '24 hours'
     AND COALESCE(t->>'mintAddress', '') <> ''
  UNION ALL
  SELECT token_address, max(occurred_at) AS seen_at
    FROM social_token_events
   WHERE event_type = 'mention'
     AND source = 'GMGN_Smart_Money_FOMO'
     AND COALESCE(chain, 'sol') = 'sol'
     AND occurred_at > now() - make_interval(mins => $4::int)
   GROUP BY token_address
)
SELECT token_address
  FROM watch
 GROUP BY token_address
 ORDER BY max(seen_at) DESC NULLS LAST
 LIMIT $3
`

/**
 * Positive-integer env knob. A blank or nonsense value falls back rather than disabling the
 * caller — this guards background sweeps, where "set it to garbage" must not mean "stop tracking".
 */
export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** Most-recently-seen watch mints first, capped. */
export async function loadWatchMints(
  params: {
    maxMints?: number
    rangeMin?: number
    rangeMax?: number
    socialWindowMin?: number
  } = {},
): Promise<string[]> {
  const { rows } = await query<{ token_address: string }>(WATCH_SQL, [
    params.rangeMin ?? WATCH_RANGE_MIN,
    params.rangeMax ?? WATCH_RANGE_MAX,
    params.maxMints ?? DEFAULT_WATCH_MAX_MINTS,
    params.socialWindowMin ?? WATCH_SOCIAL_WINDOW_MIN,
  ])
  return rows.map((r) => r.token_address).filter(Boolean)
}

/**
 * Symbols for watch mints, drawn from the same tables the watch set comes from.
 *
 * `WATCH_SQL` is deliberately left alone: it is load-bearing for both series writers, and its four
 * sources do not all carry a symbol — adding a column to it risks the sweep for a display string.
 * This is a separate best-effort lookup, and a mint it does not know simply has no entry. A missing
 * symbol must stay missing rather than be invented from the address.
 */
export async function loadWatchSymbols(mints: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(mints.map((m) => m.trim()).filter(Boolean))]
  if (unique.length === 0) return new Map()
  const { rows } = await query<{ token_address: string; token_symbol: string | null }>(
    `SELECT token_address, MAX(token_symbol) AS token_symbol
       FROM (
         SELECT token_address, token_symbol FROM token_mcap_tracking
          WHERE token_address = ANY($1::text[]) AND token_symbol IS NOT NULL AND token_symbol <> ''
         UNION ALL
         SELECT token_address, token_symbol FROM trending_token_tracker
          WHERE token_address = ANY($1::text[]) AND token_symbol IS NOT NULL AND token_symbol <> ''
       ) s
      GROUP BY token_address`,
    [unique],
  )
  const out = new Map<string, string>()
  for (const row of rows) {
    if (row.token_symbol) out.set(row.token_address, row.token_symbol)
  }
  return out
}
