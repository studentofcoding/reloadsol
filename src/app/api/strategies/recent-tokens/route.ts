import { NextRequest, NextResponse, connection } from 'next/server'
import { listRecentStrategyTokens } from '@/strategies/db'
import { parseStrategyChain } from '@/strategies/types'

export async function GET(request: NextRequest) {
  await connection()
  try {
    const chain = parseStrategyChain(request.nextUrl.searchParams.get('chain'))
    const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? '30')
    const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 30
    const tokens = await listRecentStrategyTokens(chain, limit)
    return NextResponse.json({ success: true, chain, tokens })
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
