import { NextRequest, NextResponse, connection } from 'next/server'
import { query, queryOne } from '@/utils/db'
import { countTrackerOutcomeStats } from '@/utils/trending-profit'

// Force dynamic rendering for this route

// Use alternate tables in local development to avoid prod collisions
const TRACKER_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'

const SORT_COLUMNS = new Set([
  'created_at',
  'tracking_started_at',
  'status_changed_at',
  'peak_gain_percentage',
  'current_gain_percentage',
  'status',
  'token_symbol',
  'token_address',
  'updated_at',
  'market_cap',
])

type FilterParams = {
  status: string
  dateRange: string
  minGain: string | null
  maxGain: string | null
  minDuration: string | null
  maxDuration: string | null
  search: string | null
}

function buildWhereClause(params: FilterParams): { sql: string; values: unknown[] } {
  const conditions: string[] = []
  const values: unknown[] = []

  if (params.status !== 'all') {
    values.push(params.status)
    conditions.push(`status = $${values.length}`)
  }

  if (params.dateRange !== 'all') {
    const now = new Date()
    const cutoff = new Date()

    switch (params.dateRange) {
      case '24h':
        cutoff.setHours(now.getHours() - 24)
        break
      case '7d':
        cutoff.setDate(now.getDate() - 7)
        break
      case '30d':
        cutoff.setDate(now.getDate() - 30)
        break
      case '90d':
        cutoff.setDate(now.getDate() - 90)
        break
    }

    values.push(cutoff.toISOString())
    conditions.push(`created_at >= $${values.length}`)
  }

  if (params.search && params.search.trim()) {
    values.push(`%${params.search.trim()}%`)
    conditions.push(
      `(token_symbol ILIKE $${values.length} OR token_name ILIKE $${values.length} OR token_address ILIKE $${values.length})`,
    )
  }

  if (params.minGain) {
    const minGainNum = parseFloat(params.minGain)
    if (!isNaN(minGainNum)) {
      values.push(minGainNum)
      conditions.push(`peak_gain_percentage >= $${values.length}`)
    }
  }

  if (params.maxGain) {
    const maxGainNum = parseFloat(params.maxGain)
    if (!isNaN(maxGainNum)) {
      values.push(maxGainNum)
      conditions.push(`peak_gain_percentage <= $${values.length}`)
    }
  }

  if (params.minDuration) {
    const minDurationNum = parseFloat(params.minDuration)
    if (!isNaN(minDurationNum)) {
      values.push(minDurationNum)
      conditions.push(
        `EXTRACT(EPOCH FROM (COALESCE(status_changed_at, NOW()) - tracking_started_at))/3600 >= $${values.length}`,
      )
    }
  }

  if (params.maxDuration) {
    const maxDurationNum = parseFloat(params.maxDuration)
    if (!isNaN(maxDurationNum)) {
      values.push(maxDurationNum)
      conditions.push(
        `EXTRACT(EPOCH FROM (COALESCE(status_changed_at, NOW()) - tracking_started_at))/3600 <= $${values.length}`,
      )
    }
  }

  const sql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  return { sql, values }
}

export async function GET(request: NextRequest) {
  try {
    await connection()
    const searchParams = request.nextUrl.searchParams

    const status = searchParams.get('status') || 'all'
    const dateRange = searchParams.get('dateRange') || 'all'
    const minGain = searchParams.get('minGain')
    const maxGain = searchParams.get('maxGain')
    const minDuration = searchParams.get('minDuration')
    const maxDuration = searchParams.get('maxDuration')
    const sortBy = searchParams.get('sortBy') || 'created_at'
    const sortOrder = searchParams.get('sortOrder') || 'desc'
    const search = searchParams.get('search')
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '20')

    console.log('📊 Fetching token tracking history with filters:', {
      status,
      dateRange,
      minGain,
      maxGain,
      minDuration,
      maxDuration,
      sortBy,
      sortOrder,
      search,
      page,
      limit,
    })

    const totalUnfilteredRow = await queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${TRACKER_TABLE}`,
    )
    const totalUnfilteredCount = totalUnfilteredRow?.count ?? 0
    console.log(`🔍 Total unfiltered records in database: ${totalUnfilteredCount}`)

    const filterParams: FilterParams = {
      status,
      dateRange,
      minGain,
      maxGain,
      minDuration,
      maxDuration,
      search,
    }
    const { sql: whereClause, values: whereValues } = buildWhereClause(filterParams)

    const countRow = await queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${TRACKER_TABLE} ${whereClause}`,
      whereValues,
    )
    const count = countRow?.count ?? 0

    const sortColumn = SORT_COLUMNS.has(sortBy) ? sortBy : 'created_at'
    const sortDir = sortOrder === 'asc' ? 'ASC' : 'DESC'
    const offset = (page - 1) * limit

    const listValues = [...whereValues, limit, offset]
    const limitIdx = whereValues.length + 1
    const offsetIdx = whereValues.length + 2

    const [{ rows: data }, { rows: allTokens }] = await Promise.all([
      query(
        `SELECT * FROM ${TRACKER_TABLE} ${whereClause}
         ORDER BY ${sortColumn} ${sortDir}
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        listValues,
      ),
      query<{ status: string; peak_gain_percentage: number | null; current_gain_percentage: number | null }>(
        `SELECT status, peak_gain_percentage, current_gain_percentage FROM ${TRACKER_TABLE}`,
      ),
    ])

    console.log(`📊 Filtered count: ${count} tokens (unfiltered: ${totalUnfilteredCount})`)

    const statsBase = countTrackerOutcomeStats(allTokens ?? [])
    const stats = {
      total: statsBase.total,
      won: statsBase.won,
      lost: statsBase.lost,
      tracking: statsBase.tracking,
      waiting: statsBase.waiting,
      skipped: statsBase.skipped,
      winRate: statsBase.winRate,
      avgPeakGain:
        allTokens && allTokens.length > 0
          ? allTokens.reduce((sum, t) => sum + (t.peak_gain_percentage || 0), 0) /
            allTokens.length
          : 0,
    }

    const totalPages = Math.ceil(count / limit)

    console.log(`📄 Pagination: page ${page}/${totalPages}, limit ${limit}, offset ${offset}`)
    console.log(`✅ Fetched ${data?.length || 0} tokens (page ${page}/${totalPages}, filtered total: ${count})`)

    return NextResponse.json({
      success: true,
      data: data || [],
      pagination: {
        page,
        limit,
        total: count,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
      stats,
      filters: {
        status,
        dateRange,
        minGain,
        maxGain,
        minDuration,
        maxDuration,
        sortBy,
        sortOrder,
        search,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error('❌ Error in tracking history API:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to fetch tracking history',
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    )
  }
}
