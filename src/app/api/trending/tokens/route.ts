import { NextResponse } from 'next/server'
import { NextRequest } from 'next/server'
import { supabase } from '@/utils/supabase'

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

    let query = supabase
      .from(TRACKER_TABLE)
      .select('*', { count: 'exact' })

    // Date filter (created_at)
    if (date) {
      // Start of day
      const startDate = new Date(date)
      startDate.setHours(0, 0, 0, 0)

      // End of day
      const endDate = new Date(date)
      endDate.setHours(23, 59, 59, 999)

      query = query
        .gte('created_at', startDate.toISOString())
        .lte('created_at', endDate.toISOString())
    }

    // Search filter
    if (search) {
      query = query.or(`token_symbol.ilike.%${search}%,token_name.ilike.%${search}%,token_address.ilike.%${search}%`)
    }

    // Order by created_at desc
    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    const { data: tokens, error, count } = await query

    if (error) {
      console.error('Error fetching tokens:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      tokens,
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit)
      }
    })

  } catch (error) {
    console.error('Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
