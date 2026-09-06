import { NextRequest, NextResponse } from 'next/server'
import { isAuthorizedRequest } from '@/utils/dlmm/config'
import {
  runAllStrategySearchCycles,
  runStrategySearchCycle,
  SEARCH_CYCLE_DOMAINS,
} from '@/strategies/strategy-search-cycle'
import type { StrategyDomain } from '@/strategies/types'

function secret(): string {
  return process.env.TRENDING_TRACKER_SECRET || 'r3l0ads0l-trending'
}

function parseDomain(raw: string | null): StrategyDomain | 'all' {
  if (!raw || raw === 'all') return 'all'
  return SEARCH_CYCLE_DOMAINS.includes(raw as StrategyDomain)
    ? (raw as StrategyDomain)
    : 'all'
}

/** Worker `strategy_search` — offline walk-forward → spawn top-K → maybe replace canonical sim. */
export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  if (!isAuthorizedRequest(searchParams.get('key'), secret())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { withJobLock } = await import('@/utils/bot-job-lock')
  const domain = parseDomain(searchParams.get('domain'))
  return withJobLock('strategy_search', 600, async () => {
    const results =
      domain === 'all'
        ? await runAllStrategySearchCycles()
        : [await runStrategySearchCycle(domain)]
    return NextResponse.json({ success: true, results })
  })
}

export async function GET(req: NextRequest) {
  return POST(req)
}
