import { NextRequest, NextResponse } from 'next/server'
import {
  listPatternTrainingRows,
  patternTrainingCsvHeader,
  patternTrainingFeatureCoverage,
  patternTrainingRowToCsv,
} from '@/strategies/social/pattern-training-export'
import { parseDbChain } from '@/utils/app-network-db'
import { isSocialRollupAuthorized } from '@/utils/social/config'


export async function GET(request: NextRequest) {
  const key =
    request.nextUrl.searchParams.get('key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')

  if (!isSocialRollupAuthorized(key)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const format = request.nextUrl.searchParams.get('format') ?? 'json'
  const chain = parseDbChain(request.nextUrl.searchParams.get('chain'))
  const { rows, skipped, error } = await listPatternTrainingRows(chain)

  if (error && rows.length === 0) {
    return NextResponse.json({ success: false, error, rows: [], skipped }, { status: 503 })
  }

  // Coverage logging: are zero-importance (social) features missing at export
  // time or just uninformative? Logged per export, returned in the JSON payload.
  const featureCoverage = patternTrainingFeatureCoverage(rows)
  console.info(
    '[mcap-patterns/training-export] feature coverage (non-zero rate):',
    Object.fromEntries(
      Object.entries(featureCoverage).map(([k, v]) => [
        k,
        `${(v.nonZeroRate * 100).toFixed(1)}%`,
      ]),
    ),
  )

  if (format === 'csv') {
    const lines = [patternTrainingCsvHeader(), ...rows.map(patternTrainingRowToCsv)]
    return new NextResponse(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="pattern-training.csv"',
      },
    })
  }

  return NextResponse.json({
    success: true,
    rowCount: rows.length,
    skipped,
    featureCoverage,
    rows,
    error,
  })
}
