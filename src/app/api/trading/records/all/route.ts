import { NextRequest, NextResponse, connection } from 'next/server'
import { query } from '@/utils/db'

// Force dynamic rendering for this route

// GET /api/trading/records/all?limit=<number>
export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const limit = parseInt(searchParams.get('limit') || '1000')

    const origin = request.headers.get('origin')
    const allowedOrigin = (() => {
      if (!origin) return null
      try {
        const url = new URL(origin)
        const hostname = url.hostname
        const protocol = url.protocol
        if (process.env.NODE_ENV === 'production' && protocol !== 'https:') return null
        if (hostname === 'reloadsol.xyz' || hostname.endsWith('.reloadsol.xyz')) return origin
        if (
          process.env.NODE_ENV !== 'production' &&
          (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))
        ) {
          return origin
        }
        return null
      } catch {
        return null
      }
    })()

    const { rows } = await query<{ data: unknown }>(
      `SELECT data FROM trading_records
       ORDER BY timestamp DESC
       LIMIT $1`,
      [limit],
    )

    return NextResponse.json(
      {
        success: true,
        records: rows.map((item) => item.data)
      },
      {
        headers: {
          ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin } : {}),
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin',
          'Cache-Control': 'public, max-age=120, stale-while-revalidate=60',
        },
      }
    )
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
