import { NextRequest, NextResponse } from 'next/server'
import {
  VersionedTransaction,
  Connection,
  TransactionMessage,
  AddressLookupTableAccount,
  SystemProgram,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import { getSwapQuote, getSwapTransaction } from '@/utils/jupiter'

// Tip accounts to support Sender priority routing
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

    const HELIUS_API_KEY = process.env.HELIUS_API_KEY
    const SENDER_ENDPOINT = process.env.SENDER_ENDPOINT || 'http://sg-sender.helius-rpc.com/fast'

    if (!HELIUS_API_KEY) {
      return NextResponse.json({ error: 'HELIUS_API_KEY is not configured' }, { status: 500 })
    }

    // If a signed transaction is provided, broadcast it directly
    if (signedTxBase64 && typeof signedTxBase64 === 'string') {
      try {
        const senderResp = await fetch(SENDER_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now().toString(),
            method: 'sendTransaction',
            params: [signedTxBase64, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
          }),
        })
        const senderJson = await senderResp.json()
        if (senderJson.error) {
          return NextResponse.json({ error: senderJson.error?.message || 'Sender error' }, { status: 502 })
        }

        const signature: string = senderJson.result

        const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`)
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
        await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature }, 'confirmed')

        return NextResponse.json({ success: true, signature })
      } catch (err: any) {
        return NextResponse.json({ error: err?.message || 'Failed to broadcast signed transaction' }, { status: 500 })
      }
    }

    // Otherwise, prepare an unsigned swap transaction for the provided user public key
    if (!userPublicKey || typeof userPublicKey !== 'string') {
      return NextResponse.json({ error: 'userPublicKey is required when requesting unsigned transaction' }, { status: 400 })
    }

    // 1) Request Jupiter quote
    const quote = await getSwapQuote(SOL_MINT, tokenAddress, solLamports, slippageBps)
    if (!quote) {
      return NextResponse.json({ error: 'Failed to get quote from Jupiter' }, { status: 502 })
    }

    // 2) Request Jupiter swap transaction
    const swapResponse = await getSwapTransaction(quote, userPublicKey, priorityFeeLamports)
    if (!swapResponse || !swapResponse.swapTransaction) {
      return NextResponse.json({ error: 'Failed to get swap transaction from Jupiter' }, { status: 502 })
    }

    // 3) Deserialize Jupiter transaction
    const transactionBase64 = swapResponse.swapTransaction
    const jupiterTransaction = VersionedTransaction.deserialize(Buffer.from(transactionBase64, 'base64'))

    // 4) Fetch address lookup tables to decompile
    const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`)
    const altAccountResponses = await Promise.all(
      jupiterTransaction.message.addressTableLookups.map((l) => connection.getAddressLookupTable(l.accountKey))
    )
    const altAccounts: AddressLookupTableAccount[] = altAccountResponses.map((item) => {
      if (item.value == null) throw new Error('ALT is null')
      return item.value
    })

    // 5) Decompile and append tip instruction
    let decompiledMessage = TransactionMessage.decompile(jupiterTransaction.message, {
      addressLookupTableAccounts: altAccounts,
    })

    const tipIx = SystemProgram.transfer({
      fromPubkey: new PublicKey(userPublicKey),
      toPubkey: new PublicKey(TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]),
      lamports: Math.floor(0.001 * LAMPORTS_PER_SOL), // 0.001 SOL tip
    })
    decompiledMessage.instructions.push(tipIx)

    // 6) Compile and return unsigned transaction for client-side signing
    const transaction = new VersionedTransaction(decompiledMessage.compileToV0Message(altAccounts))
    const unsignedTxBase64 = Buffer.from(transaction.serialize()).toString('base64')

    return NextResponse.json({ success: true, swapTransactionBase64: unsignedTxBase64 })
  } catch (error: any) {
    console.error('Buy API error:', error)
    return NextResponse.json({ error: error?.message || 'Internal error' }, { status: 500 })
  }
}