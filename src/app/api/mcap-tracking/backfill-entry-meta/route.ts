import { NextRequest, NextResponse } from 'next/server'
import { backfillMcapEntryMeta } from '@/strategies/mcap-entry-meta-backfill'
import { isSocialRollupAuthorized } from '@/utils/social/config'

/** The host has no tsx, so the cron drives this via the API like every other worker. */
export const maxDuration = 120

function positiveInt(raw: string | null, fallback: number): number {
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.floor(n)
}

export async function POST(request: NextRequest) {
  const key =
    request.nextUrl.searchParams.get('key') ??
    request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')

  if (!isSocialRollupAuthorized(key)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  const params = request.nextUrl.searchParams
  try {
    const result = await backfillMcapEntryMeta({
      sinceDays: positiveInt(params.get('since-days'), 7),
      limit: positiveInt(params.get('limit'), 300),
      dryRun: params.get('dry-run') === '1' || params.get('dry-run') === 'true',
    })
    return NextResponse.json({ success: true, chain: 'sol', ...result })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
