import { NextRequest, NextResponse } from 'next/server'
import { listStrategyOutcomes } from '@/strategies/db'
import { resolveEffectiveTrainingClass } from '@/strategies/ml-training-features'
import type { StrategyDomain, StrategyOutcomeRow } from '@/strategies/types'
import {
  readEntryMcap,
  readMonitorSnapshotCount,
  readOrganicScore,
  readTokenAgeHours,
  readTokenSymbol,
  readTopHoldersPct,
  readVolumeAtEntry,
} from '@/strategies/outcome-features'

export const dynamic = 'force-dynamic'

function readFeatureString(
  features: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const v = features?.[key]
  return typeof v === 'string' ? v : ''
}

function parseOptionalNumber(value: string | null): number | undefined {
  if (value == null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function resolvePnlFilter(pnlFilter: string | null): {
  pnlMin?: number
  pnlMax?: number
} {
  switch (pnlFilter) {
    case 'win':
      return { pnlMin: 0 }
    case 'loss':
      return { pnlMax: -0.000001 }
    case 'strong_win':
      return { pnlMin: 50 }
    case 'heavy_loss':
      return { pnlMax: -30 }
    default:
      return {}
  }
}

function readFeatureNumber(
  features: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const v = features?.[key]
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'string') return v
  return ''
}

function toCsv(rows: StrategyOutcomeRow[], recomputeLabels: boolean): string {
  const headers = [
    'id',
    'strategy_id',
    'domain',
    'token_symbol',
    'token_address',
    'entry_mcap',
    'entry_mcap_band',
    'organic_score',
    'top_holders_pct',
    'token_age_hours',
    'volume_at_entry',
    'monitor_count',
    'training_class',
    'entry_template',
    'regime_tag_at_exit',
    'telegram_mention_count_30m',
    'telegram_unique_channels_30m',
    'minutes_since_first_mention',
    'smart_wallet_buy_count_1h',
    'has_smart_wallet_buy',
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
    const trainingClass = resolveEffectiveTrainingClass(r, recomputeLabels)
    lines.push(
      [
        r.id,
        r.strategy_id,
        r.domain,
        readTokenSymbol(r.features) ?? '',
        r.token_address ?? '',
        readEntryMcap(r.features) ?? '',
        readFeatureString(r.features, 'entry_mcap_band'),
        readOrganicScore(r.features) ?? '',
        readTopHoldersPct(r.features) ?? '',
        readTokenAgeHours(r.features) ?? '',
        readVolumeAtEntry(r.features) ?? '',
        readMonitorSnapshotCount(r.features),
        trainingClass ?? '',
        readFeatureString(r.features, 'entry_template'),
        readFeatureString(r.features, 'regime_tag_at_exit'),
        readFeatureNumber(r.features, 'telegram_mention_count_30m'),
        readFeatureNumber(r.features, 'telegram_unique_channels_30m'),
        readFeatureNumber(r.features, 'minutes_since_first_mention'),
        readFeatureNumber(r.features, 'smart_wallet_buy_count_1h'),
        readFeatureNumber(r.features, 'has_smart_wallet_buy'),
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
    const status = searchParams.get('status') ?? undefined
    const entryMcapBand = searchParams.get('entry_mcap_band') ?? undefined
    const pnlFilter = searchParams.get('pnl_filter')
    const pnlMin =
      parseOptionalNumber(searchParams.get('pnl_min')) ??
      resolvePnlFilter(pnlFilter).pnlMin
    const pnlMax =
      parseOptionalNumber(searchParams.get('pnl_max')) ??
      resolvePnlFilter(pnlFilter).pnlMax
    const trainingClassOnly = searchParams.get('training_class_only') === 'true'
    const trainingClassMin = parseOptionalNumber(searchParams.get('training_class_min'))
    const recomputeLabels = searchParams.get('recompute_labels') === 'true'
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
      status,
      pnlMin,
      pnlMax,
      entryMcapBand,
      trainingClassOnly,
      trainingClassMin,
      recomputeLabels,
      limit: format === 'csv' ? Math.min(limit, 5000) : limit,
      offset,
    })

    if (format === 'csv') {
      const csv = toCsv(rows, recomputeLabels)
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
