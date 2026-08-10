import { NextRequest, NextResponse } from 'next/server'
import { loadOutcomesForMlDataset } from '@/strategies/db'
import {
  computeMlDatasetStats,
  countIncompleteMlFields,
  extractMlTrainingRow,
} from '@/strategies/ml-training-features'
import type { StrategyDomain } from '@/strategies/types'


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
    const extractableLabeled = rows.filter(
      (row) => extractMlTrainingRow(row, true) != null,
    ).length
    const incomplete = countIncompleteMlFields(rows, true)

    return NextResponse.json({
      success: true,
      stats,
      extractable_labeled: extractableLabeled,
      skipped_incomplete: incomplete.skipped_incomplete,
      incomplete_by_field: incomplete.incomplete_by_field,
      volume_imputed: incomplete.volume_imputed,
    })
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
