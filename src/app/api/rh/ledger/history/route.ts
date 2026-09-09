import { NextRequest, NextResponse, connection } from 'next/server'
import { isEvmAddress } from '@/utils/rh-wallet-holdings'
import { listRhLedgerHistory } from '@/utils/rh-ledger'

/**
 * Ledger-backed token transfer history for a tracked RH wallet. Newest first.
 * GET /api/rh/ledger/history?wallet=0x…&token=0x…(optional)&limit=50
 */
export async function GET(request: NextRequest) {
  await connection()
  try {
    const wallet = request.nextUrl.searchParams.get('wallet')?.trim() ?? ''
    if (!isEvmAddress(wallet)) {
      return NextResponse.json(
        { success: false, error: 'wallet must be a 0x EVM address' },
        { status: 400 },
      )
    }
    const token = request.nextUrl.searchParams.get('token')?.trim() || undefined
    const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? 50)
    const limit = Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50

    const rows = await listRhLedgerHistory(wallet, { token, limit })
    return NextResponse.json({
      success: true,
      wallet: wallet.toLowerCase(),
      rows,
      count: rows.length,
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
