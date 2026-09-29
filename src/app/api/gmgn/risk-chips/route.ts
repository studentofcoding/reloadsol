import { NextRequest, NextResponse, connection } from 'next/server'
import { readRiskChips } from '@/strategies/risk-store'

export const maxDuration = 30

/** Bulk shadow risk chips for list surfaces: /api/gmgn/risk-chips?addresses=a,b,c */
export async function GET(request: NextRequest) {
  await connection()
  try {
    const { searchParams } = new URL(request.url)
    const chain = searchParams.get('chain')?.trim() || 'sol'
    const raw = searchParams.get('addresses')?.trim() ?? ''
    const addresses = raw
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean)
      .slice(0, 500)

    const chips = await readRiskChips(chain, addresses)
    return NextResponse.json(
      { success: true, chips },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        chips: {},
      },
      { status: 500 },
    )
  }
}
