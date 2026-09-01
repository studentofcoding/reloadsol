import { NextRequest, NextResponse, connection } from 'next/server'
import { listStrategyOutcomes } from '@/strategies/db'
import { listStrategyReviewNotes } from '@/strategies/strategy-review-notes'
import { buildStrategyReview } from '@/strategies/strategy-review'
import type { StrategyDomain } from '@/strategies/types'


export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    await connection()
    const { searchParams } = new URL(request.url)
    const weeks = Math.min(26, Math.max(4, Number(searchParams.get('weeks') ?? 12) || 12))
    const domain = searchParams.get('domain') as StrategyDomain | null
    const strategyId = searchParams.get('strategyId') ?? undefined
    const sim = searchParams.get('is_simulated')
    const isSimulated = sim === 'true' ? true : sim === 'false' ? false : undefined

    const to = new Date()
    const from = new Date(to.getTime() - weeks * 7 * 86400000)

    const { rows } = await listStrategyOutcomes({
      domain: domain || undefined,
      strategyId,
      isSimulated,
      from: from.toISOString(),
      to: to.toISOString(),
      limit: 5000,
      offset: 0,
    })

    const review = buildStrategyReview(rows, { weeks, now: to })
    const notes = await listStrategyReviewNotes({
      periodKeys: review.weeks.map((w) => w.weekKey),
    })

    return NextResponse.json({
      success: true,
      weeksRequested: weeks,
      rowCount: rows.length,
      review,
      notes,
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
