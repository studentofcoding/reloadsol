import { NextRequest, NextResponse } from 'next/server'
import { requireWalletSession } from '@/utils/api-auth'
import {
  assertSessionCanServerSign,
  decodeUnsignedTransactions,
  encodeSignedTransactions,
  readTradingKeypair,
  signVersionedWithTradingKeypair,
  tradingKeypairPublicKey,
  transactionFeePayerIs,
} from '@/utils/server-trade-signer'

/**
 * Wallet-session gated signer for the server trading keypair.
 * GET returns the pubkey only when the session address is that key.
 * POST signs unsigned versioned txs whose fee payer is that key.
 * The secret never leaves the server.
 */
export async function GET(req: NextRequest) {
  const auth = requireWalletSession(req)
  if (auth instanceof NextResponse) return auth

  const publicKey = tradingKeypairPublicKey()
  const gate = assertSessionCanServerSign(auth.session.address, publicKey)
  return NextResponse.json({
    success: true,
    publicKey: gate.ok ? gate.publicKey : null,
  })
}

export async function POST(req: NextRequest) {
  const auth = requireWalletSession(req)
  if (auth instanceof NextResponse) return auth

  const keypair = readTradingKeypair()
  const gate = assertSessionCanServerSign(
    auth.session.address,
    keypair?.publicKey.toBase58() ?? null,
  )
  if (!gate.ok || !keypair) {
    const code = gate.ok ? 'NO_KEYPAIR' : gate.code
    if (code === 'NO_KEYPAIR') {
      return NextResponse.json(
        { success: false, error: 'Trading keypair is not configured', code: 'NO_KEYPAIR' },
        { status: 409 },
      )
    }
    return NextResponse.json(
      {
        success: false,
        error: 'Wallet session does not match the trading keypair',
        code: 'MISMATCH',
      },
      { status: 403 },
    )
  }

  let body: { transactions?: unknown }
  try {
    body = (await req.json()) as { transactions?: unknown }
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    )
  }

  try {
    const txs = decodeUnsignedTransactions(body.transactions)
    if (txs.some((tx) => !transactionFeePayerIs(tx, gate.publicKey))) {
      return NextResponse.json(
        {
          success: false,
          error: 'Transaction fee payer is not the trading keypair',
          code: 'FEE_PAYER_MISMATCH',
        },
        { status: 400 },
      )
    }
    const signed = signVersionedWithTradingKeypair(txs, keypair)
    return NextResponse.json({
      success: true,
      publicKey: gate.publicKey,
      signedTransactions: encodeSignedTransactions(signed),
    })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Server signing failed',
      },
      { status: 400 },
    )
  }
}
