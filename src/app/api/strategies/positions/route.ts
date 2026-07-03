import { NextRequest, NextResponse } from 'next/server'
import { getAlgoPositions } from '@/strategies/algo-positions'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const limitParam = request.nextUrl.searchParams.get('limit')
    const closedLimit = limitParam ? Math.min(Number(limitParam) || 100, 500) : 100

    const { open, closed } = await getAlgoPositions({ closedLimit })

    return NextResponse.json(
      { success: true, open, closed },
      { headers: { 'Cache-Control': 'private, max-age=15' } },
    )
  } catch (error) {
    console.error('Algo positions API error:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    )
  }
}
