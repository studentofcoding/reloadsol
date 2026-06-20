import { NextRequest, NextResponse } from 'next/server'
import { listStrategyOutcomes } from '@/strategies/db'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const strategyId = searchParams.get('strategyId') ?? undefined
    const limit = parseInt(searchParams.get('limit') ?? '50', 10)
    const offset = parseInt(searchParams.get('offset') ?? '0', 10)

    const { rows, total } = await listStrategyOutcomes({
      strategyId,
      limit,
      offset,
    })

    return NextResponse.json({
      success: true,
      outcomes: rows,
      total,
      limit,
      offset,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
