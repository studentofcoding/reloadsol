import { mcapLabelFilterSql } from '@/utils/tracker-label'

function getTimeFilterCutoff(timeFilter: string): Date | null {
  if (timeFilter === 'all') return null
  const now = new Date()
  switch (timeFilter) {
    case '1h': return new Date(now.getTime() - 60 * 60 * 1000)
    case '4h': return new Date(now.getTime() - 4 * 60 * 60 * 1000)
    case '24h': return new Date(now.getTime() - 24 * 60 * 60 * 1000)
    case '3d': return new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000)
    case '7d': return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    case '1m': return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    default: return null
  }
}

export type McapListFilterParams = {
  chain?: string
  search?: string
  timeFilter?: string
  performanceFilter?: string
  minGrowth?: string | null
  maxGrowth?: string | null
  minMcap?: string | null
  maxMcap?: string | null
  /** Tracker label chip. Omitted / all → no predicate. `rug` is invalid. */
  label?: string | null
  statsOnly?: boolean
}

export function buildMcapListWhere(
  params: McapListFilterParams,
): { sql: string; values: unknown[]; error?: string } {
  const conditions: string[] = []
  const values: unknown[] = []

  if (params.statsOnly) {
    conditions.push('mcap_growth_percent IS NOT NULL')
    conditions.push('current_mcap IS NOT NULL')
    conditions.push('first_mcap IS NOT NULL')
    conditions.push('first_mcap > 0')
    conditions.push('current_mcap > 0')
  }

  if (params.chain) {
    values.push(params.chain)
    conditions.push(`chain = $${values.length}`)
  }

  if (params.search) {
    values.push(`%${params.search}%`)
    conditions.push(`(token_symbol ILIKE $${values.length} OR token_address ILIKE $${values.length})`)
  }

  const cutoff = getTimeFilterCutoff(params.timeFilter || 'all')
  if (cutoff) {
    values.push(cutoff.toISOString())
    conditions.push(`first_seen_at >= $${values.length}`)
  }

  const performanceFilter = params.performanceFilter || 'all'
  if (performanceFilter === 'gainers') {
    conditions.push('mcap_growth_percent > 0')
  } else if (performanceFilter === 'losers') {
    conditions.push('mcap_growth_percent < 0')
  } else if (performanceFilter === 'top_performers') {
    conditions.push('mcap_growth_percent >= 100')
  }

  if (params.minGrowth != null && params.minGrowth !== '') {
    values.push(parseFloat(params.minGrowth))
    conditions.push(`mcap_growth_percent >= $${values.length}`)
  }
  if (params.maxGrowth != null && params.maxGrowth !== '') {
    values.push(parseFloat(params.maxGrowth))
    conditions.push(`mcap_growth_percent <= $${values.length}`)
  }
  if (params.minMcap != null && params.minMcap !== '') {
    values.push(parseFloat(params.minMcap))
    conditions.push(`first_mcap >= $${values.length}`)
  }
  if (params.maxMcap != null && params.maxMcap !== '') {
    values.push(parseFloat(params.maxMcap))
    conditions.push(`first_mcap <= $${values.length}`)
  }

  const labelSql = mcapLabelFilterSql(params.label, values.length + 1)
  if ('error' in labelSql) {
    return { sql: '', values: [], error: labelSql.error }
  }
  if (labelSql.sql) {
    conditions.push(labelSql.sql)
    values.push(...labelSql.values)
  }

  const sql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return { sql, values }
}
