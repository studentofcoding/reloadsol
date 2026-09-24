import { NextRequest, NextResponse, connection } from 'next/server'
import { aggregateSignalsListPnl } from '@/strategies/signals-list-pnl'
import { getMergedMcapTrackerRegistry } from '@/strategies/load-mcap-tracker'
import { getMergedSignalsRegistry } from '@/strategies/load-signals'
import { rankSignalsListStrategies } from '@/strategies/signals-strategy-list'
import { parseDbChain } from '@/utils/app-network-db'
import { cacheGet, cacheSet } from '@/utils/redis-cache'

const LIST_PNL_TTL_S = 30

export async function GET(request: NextRequest) {
  await connection()
  try {
    const chain = parseDbChain(new URL(request.url).searchParams.get('chain'))
    const cacheKey = `signals:list-pnl:v1:${chain}`

    const cached = await cacheGet<{ success: true; strategies: unknown }>(cacheKey)
    if (cached) {
      return NextResponse.json(cached, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    const [breakdown, mcapRegistry, signalsRegistry] = await Promise.all([
      aggregateSignalsListPnl(chain),
      getMergedMcapTrackerRegistry(chain),
      getMergedSignalsRegistry(chain),
    ])

    const nameOverrides: Record<string, string> = {}
    for (const strategy of [
      ...Object.values(signalsRegistry),
      ...Object.values(mcapRegistry),
    ]) {
      if (strategy?.id && strategy.name) nameOverrides[strategy.id] = strategy.name
    }

    const strategies = rankSignalsListStrategies(chain, breakdown, nameOverrides)
    const body = { success: true as const, strategies }
    await cacheSet(cacheKey, body, LIST_PNL_TTL_S)
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        strategies: [],
      },
      { status: 500 },
    )
  }
}
