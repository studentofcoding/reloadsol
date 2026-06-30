import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { query, queryOne } from '@/utils/db'
import { getAppDayBounds } from '@/utils/datetime'

// Force dynamic rendering
export const dynamic = 'force-dynamic'

const TRACKER_TABLE = process.env.NODE_ENV === 'development' ? 'trending_token_tracker_dev' : 'trending_token_tracker'

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const page = parseInt(searchParams.get('page') || '1')
    const limit = parseInt(searchParams.get('limit') || '20')
    const date = searchParams.get('date') // YYYY-MM-DD
    const search = searchParams.get('search') || ''

    const offset = (page - 1) * limit

    const conditions: string[] = []
    const values: unknown[] = []

    if (date) {
      const { start, end } = getAppDayBounds(date)
      values.push(start.toISOString())
      conditions.push(`tracking_started_at >= $${values.length}`)
      values.push(end.toISOString())
      conditions.push(`tracking_started_at <= $${values.length}`)
    }

    if (search) {
      values.push(`%${search}%`)
      conditions.push(
        `(token_symbol ILIKE $${values.length} OR token_name ILIKE $${values.length} OR token_address ILIKE $${values.length})`,
      )
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const countRow = await queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${TRACKER_TABLE} ${whereClause}`,
      values,
    )
    const count = countRow?.count ?? 0

    const listValues = [...values, limit, offset]
    const limitIdx = values.length + 1
    const offsetIdx = values.length + 2

    const { rows: tokens } = await query(
      `SELECT * FROM ${TRACKER_TABLE} ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      listValues,
    )

    return NextResponse.json({
      tokens,
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit),
      },
    })
  } catch (error) {
    console.error('Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
