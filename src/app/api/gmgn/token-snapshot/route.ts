import { NextRequest, NextResponse } from 'next/server'
import { buildGmgnTokenSnapshot } from '@/strategies/gmgn-token-snapshot'
import { tokenInfo, tokenSecurity } from '@/utils/gmgn-cli'
import { isValidMintAddress } from '@/utils/jupiter'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const address = searchParams.get('address')?.trim() ?? ''
    const chain = searchParams.get('chain')?.trim() || 'sol'

    if (!address || !isValidMintAddress(address)) {
      return NextResponse.json(
        { success: false, error: 'Valid address is required' },
        { status: 400 },
      )
    }

    const [info, security] = await Promise.all([
      tokenInfo({ chain, address }),
      tokenSecurity({ chain, address }),
    ])

    const snapshot = buildGmgnTokenSnapshot(info, security)

    return NextResponse.json(
      { success: true, address, chain, ...snapshot },
      { headers: { 'Cache-Control': 'no-store' } },
    )
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
