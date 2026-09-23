import { NextRequest, NextResponse } from 'next/server'
import { requireWalletSession } from '@/utils/api-auth'
import { executeJupiterSwapDirect } from '@/utils/jupiter-swap-quote'
import {
  assertSessionCanServerSign,
  decodeUnsignedTransactions,
  MAX_SERVER_SIGN_TXS,
  readTradingKeypair,
  signVersionedWithTradingKeypair,
  transactionFeePayerIs,
} from '@/utils/server-trade-signer'
import { runWithConcurrency } from '@/utils/swap-executor'

const LAND_CONCURRENCY = 4

type LandBody = {
  swaps?: unknown
}

/**
 * Sign prepared Jupiter V2 orders with the trading key and submit them
 * through /execute. The browser makes one round trip; Jupiter's Success
 * status is the confirmation.
 */
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

  let body: LandBody
  try {
    body = (await req.json()) as LandBody
  } catch {
    return NextResponse.json(
      { success: false, error: 'Invalid JSON body' },
      { status: 400 },
    )
  }

  if (!Array.isArray(body.swaps) || body.swaps.length === 0) {
    return NextResponse.json(
      { success: false, error: 'swaps must be a non-empty array' },
      { status: 400 },
    )
  }

  const swaps = body.swaps.map((entry) => {
    if (!entry || typeof entry !== 'object') return null
    const row = entry as { swapTransaction?: unknown; requestId?: unknown }
    if (typeof row.swapTransaction !== 'string' || typeof row.requestId !== 'string') {
      return null
    }
    if (!row.swapTransaction || !row.requestId) return null
    return { swapTransaction: row.swapTransaction, requestId: row.requestId }
  })

  if (swaps.some((swap) => swap == null)) {
    return NextResponse.json(
      { success: false, error: 'Each swap needs swapTransaction and requestId' },
      { status: 400 },
    )
  }

  const pending = swaps as { swapTransaction: string; requestId: string }[]
  if (pending.length > MAX_SERVER_SIGN_TXS) {
    return NextResponse.json(
      {
        success: false,
        error: `At most ${MAX_SERVER_SIGN_TXS} swaps can be landed at once`,
      },
      { status: 400 },
    )
  }

  try {
    const results = await runWithConcurrency(
      pending,
      LAND_CONCURRENCY,
      async (swap) => {
        try {
          const [tx] = decodeUnsignedTransactions([swap.swapTransaction])
          if (!transactionFeePayerIs(tx, gate.publicKey)) {
            return { error: 'Transaction fee payer is not the trading keypair' }
          }
          const [signed] = signVersionedWithTradingKeypair([tx], keypair)
          const executed = await executeJupiterSwapDirect({
            signedTransaction: Buffer.from(signed.serialize()).toString('base64'),
            requestId: swap.requestId,
          })
          return {
            signature: executed.signature,
            outputAmount: executed.outputAmountResult,
          }
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : 'Server landing failed',
          }
        }
      },
    )

    return NextResponse.json({ success: true, results })
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Server landing failed',
      },
      { status: 400 },
    )
  }
}
