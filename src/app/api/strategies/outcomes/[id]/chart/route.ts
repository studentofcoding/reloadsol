import { NextResponse } from 'next/server'
import {
  loadStrategyOutcomeById,
  loadOutcomeTradeWindowChart,
} from '@/strategies/db'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    const outcome = await loadStrategyOutcomeById(id)

    if (!outcome) {
      return NextResponse.json(
        { success: false, error: 'Outcome not found' },
        { status: 404 },
      )
    }

    const { points, source } = await loadOutcomeTradeWindowChart({ outcome })

    return NextResponse.json({
      success: true,
      points,
      source,
      entry_at: outcome.entry_at,
      exit_at: outcome.exit_at,
      token_address: outcome.token_address,
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
