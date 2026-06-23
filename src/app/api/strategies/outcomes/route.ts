import { NextRequest, NextResponse } from 'next/server'
import { listStrategyOutcomes } from '@/strategies/db'
import type { StrategyDomain, StrategyOutcomeRow } from '@/strategies/types'

export const dynamic = 'force-dynamic'

function readFeatureString(
  features: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const v = features?.[key]
  return typeof v === 'string' ? v : ''
}

function toCsv(rows: StrategyOutcomeRow[]): string {
  const headers = [
    'id',
    'strategy_id',
    'domain',
    'token_address',
    'entry_at',
    'exit_at',
    'pnl_pct',
    'status',
    'is_simulated',
    'ml_label',
    'ml_condition',
    'ml_note',
    'created_at',
  ]
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.strategy_id,
        r.domain,
        r.token_address ?? '',
        r.entry_at ?? '',
        r.exit_at ?? '',
        r.pnl_pct ?? '',
        r.status ?? '',
        r.is_simulated,
        readFeatureString(r.features, 'ml_label'),
        readFeatureString(r.features, 'ml_condition'),
        readFeatureString(r.features, 'ml_note'),
        r.created_at,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    )
  }
  return lines.join('\n')
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const format = searchParams.get('format')
    const strategyId = searchParams.get('strategyId') ?? undefined
    const domain = searchParams.get('domain') as StrategyDomain | null
    const isSimParam = searchParams.get('is_simulated')
    const isSimulated =
      isSimParam === 'true' ? true : isSimParam === 'false' ? false : undefined
    const from = searchParams.get('from') ?? undefined
    const to = searchParams.get('to') ?? undefined
    const mlLabel = searchParams.get('ml_label') ?? undefined
    const mlCondition = searchParams.get('ml_condition') ?? undefined
    const limit = parseInt(searchParams.get('limit') ?? '500', 10)
    const offset = parseInt(searchParams.get('offset') ?? '0', 10)

    const { rows, total } = await listStrategyOutcomes({
      strategyId,
      domain: domain ?? undefined,
      isSimulated,
      from,
      to,
      mlLabel,
      mlCondition,
      limit: format === 'csv' ? Math.min(limit, 5000) : limit,
      offset,
    })

    if (format === 'csv') {
      const csv = toCsv(rows)
      return new NextResponse(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename=strategy_outcomes.csv',
        },
      })
    }

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
