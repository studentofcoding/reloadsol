import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/utils/supabase'

// Force dynamic rendering for this route
export const dynamic = 'force-dynamic'

// GET /api/trading/records/all?limit=<number>
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '1000')

    const { data, error } = await supabase
      .from('trading_records')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit)

    if (error) {
      throw error
    }

    return NextResponse.json({
      success: true,
      records: (data || []).map((item: any) => item.data)
    })
  } catch (error) {
    console.error('Error fetching all trading records:', error)
    return NextResponse.json(
      { 
        error: 'Failed to fetch all trading records',
        details: error instanceof Error ? error.message : 'Unknown error'
      },
      { status: 500 }
    )
  }
}