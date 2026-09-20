export type AnalyticsMissingReason = 'not_found' | 'stale' | 'dropped'

export type AnalyticsMissingMint = {
  token_address: string
  reason: AnalyticsMissingReason
}

export type TimeFilterKey = '1h' | '4h' | '24h' | '3d' | '7d' | '1m' | 'all'

/** List `timeFilter` → analytics `maxAge` minutes. `all` → 0 (no cutoff). */
export const TIME_FILTER_TO_MAX_AGE_MINUTES: Record<TimeFilterKey, number> = {
  all: 0,
  '1h': 60,
  '4h': 240,
  '24h': 1440,
  '3d': 4320,
  '7d': 10080,
  '1m': 43200,
}

export function analyticsMaxAgeFromTimeFilter(timeFilter: string): number {
  if (timeFilter in TIME_FILTER_TO_MAX_AGE_MINUTES) {
    return TIME_FILTER_TO_MAX_AGE_MINUTES[timeFilter as TimeFilterKey]
  }
  return 60
}

/**
 * Other callers keep today's default 60 when `maxAge` is omitted.
 * Explicit `0` / negative → no `last_updated_at` cutoff.
 */
export function resolveAnalyticsMaxAge(
  raw: unknown,
  defaultMinutes = 60,
): number {
  if (raw === undefined || raw === null || raw === '') return defaultMinutes
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return defaultMinutes
  return n
}

export function analyticsHasLastUpdatedCutoff(maxAgeMinutes: number): boolean {
  return Boolean(maxAgeMinutes && maxAgeMinutes > 0)
}

export function buildMcapAnalyticsSql(maxAgeMinutes: number): {
  sql: string
  hasCutoff: boolean
} {
  let sql = `
            SELECT * FROM token_mcap_tracking
            WHERE token_address = ANY($1::text[])`
  const hasCutoff = analyticsHasLastUpdatedCutoff(maxAgeMinutes)
  if (hasCutoff) {
    sql += ` AND last_updated_at >= $2`
  }
  sql += ` ORDER BY last_updated_at DESC`
  return { sql, hasCutoff }
}

export function isWithinAnalyticsMaxAge(
  lastUpdatedAt: string | Date | null | undefined,
  maxAgeMinutes: number,
  nowMs = Date.now(),
): boolean {
  if (!analyticsHasLastUpdatedCutoff(maxAgeMinutes)) return true
  if (!lastUpdatedAt) return false
  const ts = new Date(lastUpdatedAt).getTime()
  if (!Number.isFinite(ts)) return false
  return ts >= nowMs - maxAgeMinutes * 60 * 1000
}

export function classifyAnalyticsMissing(
  requested: string[],
  rows: Array<{ token_address: string; last_updated_at?: string | Date | null }>,
  enrichedAddresses: Iterable<string>,
  maxAgeMinutes: number,
  nowMs = Date.now(),
): AnalyticsMissingMint[] {
  const enriched = new Set(enrichedAddresses)
  const byAddress = new Map<string, { token_address: string; last_updated_at?: string | Date | null }>()
  for (const row of rows) {
    if (!row?.token_address || byAddress.has(row.token_address)) continue
    byAddress.set(row.token_address, row)
  }

  const missing: AnalyticsMissingMint[] = []
  for (const address of requested) {
    if (enriched.has(address)) continue
    const row = byAddress.get(address)
    if (!row) {
      missing.push({ token_address: address, reason: 'not_found' })
      continue
    }
    if (!isWithinAnalyticsMaxAge(row.last_updated_at, maxAgeMinutes, nowMs)) {
      missing.push({ token_address: address, reason: 'stale' })
      continue
    }
    missing.push({ token_address: address, reason: 'dropped' })
  }
  return missing
}

export function usdPricesToAnalyticsMap(
  prices: Record<string, number>,
): Record<string, { price: number }> {
  const out: Record<string, { price: number }> = {}
  for (const [mint, price] of Object.entries(prices)) {
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
      out[mint] = { price }
    }
  }
  return out
}
