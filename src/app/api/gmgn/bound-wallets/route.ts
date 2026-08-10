import { NextResponse } from 'next/server'
import { resolveGmgnBoundWallets } from '@/utils/gmgn-bound-wallets'


/** Public bound addresses only — never PEM / API keys. */
export async function GET() {
  const wallets = await resolveGmgnBoundWallets()
  return NextResponse.json({
    success: true,
    ...wallets,
  })
}
