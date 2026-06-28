import { NextRequest, NextResponse } from 'next/server'
import { loadOutcomesForMlDataset } from '@/strategies/db'
import { computeMlDatasetStats, extractMlTrainingRow } from '@/strategies/ml-training-features'
import type { StrategyDomain } from '@/strategies/types'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const domain = searchParams.get('domain') as StrategyDomain | null
    const strategyId = searchParams.get('strategyId') ?? undefined

    const rows = await loadOutcomesForMlDataset({
      domain: domain ?? undefined,
      strategyId,
    })
    const stats = computeMlDatasetStats(rows)
    const extractableLabeled = rows.filter((row) => extractMlTrainingRow(row) != null).length

    return NextResponse.json({
      success: true,
      stats,
      extractable_labeled: extractableLabeled,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
