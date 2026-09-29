import { NextRequest, NextResponse, connection } from 'next/server'
import { listDevReputation } from '@/strategies/risk-store'
import type { DevVerdict } from '@/strategies/dev-reputation'

export const maxDuration = 30

const VERDICTS: readonly DevVerdict[] = ['ban', 'good', 'inconclusive', 'unknown']

function isVerdict(value: string | null): value is DevVerdict {
  return value != null && (VERDICTS as readonly string[]).includes(value)
}

/** Read-only dev ban / good lists for observability. Dev-wallet gated. */
export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const verdictParam = searchParams.get('verdict')
    const verdict = isVerdict(verdictParam) ? verdictParam : undefined
    const limitParam = Number(searchParams.get('limit'))
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 100

    const rows = await listDevReputation(verdict, limit)
    return NextResponse.json({ success: true, count: rows.length, rows })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
