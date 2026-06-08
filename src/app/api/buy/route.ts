import { NextRequest, NextResponse } from 'next/server'
import {
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { getSwapQuote, getSwapTransaction } from '@/utils/jupiter'
import { createRpcConnection } from '@/utils/rpc-urls'

const TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
]

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
        const raw = Buffer.from(signedTxBase64, 'base64')
        const signature = await connection.sendRawTransaction(raw, {
          skipPreflight: true,
          maxRetries: 2,
        })

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
        await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, 'confirmed')

        return NextResponse.json({ success: true, signature })
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Failed to broadcast signed transaction'
        return NextResponse.json({ error: message }, { status: 500 })
      }
    }

    if (!userPublicKey || typeof userPublicKey !== 'string') {
      return NextResponse.json({ error: 'userPublicKey is required when requesting unsigned transaction' }, { status: 400 })
    }

    const quote = await getSwapQuote(SOL_MINT, tokenAddress, solLamports, slippageBps)
    if (!quote) {
      return NextResponse.json({ error: 'Failed to get quote from Jupiter' }, { status: 502 })
    }

    const swapResponse = await getSwapTransaction(quote, userPublicKey, priorityFeeLamports)
    if (!swapResponse?.swapTransaction) {
      return NextResponse.json({ error: 'Failed to get swap transaction from Jupiter' }, { status: 502 })
    }

    const jupiterTransaction = VersionedTransaction.deserialize(
      Buffer.from(swapResponse.swapTransaction, 'base64'),
    )

    const altAccountResponses = await Promise.all(
      jupiterTransaction.message.addressTableLookups.map((l) =>
        connection.getAddressLookupTable(l.accountKey),
      ),
    )
    const altAccounts: AddressLookupTableAccount[] = altAccountResponses.map((item) => {
      if (item.value == null) throw new Error('ALT is null')
      return item.value
    })

    const decompiledMessage = TransactionMessage.decompile(jupiterTransaction.message, {
      addressLookupTableAccounts: altAccounts,
    })

    const tipIx = SystemProgram.transfer({
      fromPubkey: new PublicKey(userPublicKey),
      toPubkey: new PublicKey(TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]),
      lamports: Math.floor(0.001 * LAMPORTS_PER_SOL),
    })
    decompiledMessage.instructions.push(tipIx)

    const transaction = new VersionedTransaction(decompiledMessage.compileToV0Message(altAccounts))
    const unsignedTxBase64 = Buffer.from(transaction.serialize()).toString('base64')

    return NextResponse.json({ success: true, swapTransactionBase64: unsignedTxBase64 })
  } catch (error: unknown) {
    console.error('Buy API error:', error)
    const message = error instanceof Error ? error.message : 'Internal error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
