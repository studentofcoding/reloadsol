import { NextRequest, NextResponse } from 'next/server'
import { VersionedTransaction } from '@solana/web3.js'
import {
  prepareSwapTransaction,
  confirmSwapSignature,
  submitSignedSwap,
} from '@/utils/swap-executor'
import { createRpcConnection } from '@/utils/rpc-urls'

const SOL_MINT = 'So11111111111111111111111111111111111111112'

export const POST = async (req: NextRequest) => {
  try {
    const body = await req.json()
    const { tokenAddress, solLamports, slippageBps = 50, priorityFeeLamports = 1000000, userPublicKey, signedTxBase64 } = body || {}

    if (!tokenAddress || typeof tokenAddress !== 'string') {
      return NextResponse.json({ error: 'tokenAddress is required' }, { status: 400 })
    }
    if (!solLamports || typeof solLamports !== 'number' || solLamports <= 0) {
      return NextResponse.json({ error: 'solLamports must be a positive number' }, { status: 400 })
    }

    let connection
    try {
      connection = createRpcConnection()
    } catch {
      return NextResponse.json(
        { error: 'RPC not configured. Set RPC_URL or SHYFT_API_KEY in .env' },
        { status: 500 },
      )
    }

    if (signedTxBase64 && typeof signedTxBase64 === 'string') {
      try {
        const signedTx = VersionedTransaction.deserialize(
          Buffer.from(signedTxBase64, 'base64'),
        )
        const sendResult = await submitSignedSwap({
          signedTx,
          prepared: {
            provider: 'raptor',
            swapTransaction: signedTxBase64,
          },
          connection,
          direct: true,
        })
        await confirmSwapSignature({
          signature: sendResult.signature,
          via: sendResult.via,
          checkViaRaptor: sendResult.checkViaRaptor,
          connection,
          direct: true,
          blockhash: signedTx.message.recentBlockhash,
        })
        return NextResponse.json({ success: true, signature: sendResult.signature })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to submit signed transaction'
        return NextResponse.json({ error: message }, { status: 500 })
      }
    }

    if (!userPublicKey || typeof userPublicKey !== 'string') {
      return NextResponse.json({ error: 'userPublicKey is required when requesting unsigned transaction' }, { status: 400 })
    }

    const prepared = await prepareSwapTransaction({
      userPublicKey,
      inputMint: SOL_MINT,
      outputMint: tokenAddress,
      amount: solLamports,
      slippageBps,
      priorityFeeLamports,
      direct: true,
    })

    if (!prepared.swapTransaction) {
      return NextResponse.json({ error: 'Failed to build Raptor swap transaction' }, { status: 502 })
    }

    return NextResponse.json({
      success: true,
      swapTransactionBase64: prepared.swapTransaction,
      outAmount: prepared.outAmount,
    })
  } catch (error: unknown) {
    console.error('Buy API error:', error)
    const message = error instanceof Error ? error.message : 'Internal error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
