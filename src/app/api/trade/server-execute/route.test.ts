import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { enforceApiAccess } from '@/utils/api-auth'
import {
  WALLET_SESSION_COOKIE,
  createWalletSession,
  serializeWalletSession,
} from '@/utils/wallet-session'

vi.mock('@/utils/jupiter-swap-quote', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/jupiter-swap-quote')>()
  return {
    ...actual,
    executeJupiterSwapDirect: vi.fn(async () => ({
      signature: 'landed-sig',
      outputAmountResult: '99',
    })),
  }
})

import { executeJupiterSwapDirect } from '@/utils/jupiter-swap-quote'
import { POST } from '@/app/api/trade/server-execute/route'

const originalKey = process.env.TRADING_KEYPAIR_JSON
const originalSecret = process.env.WALLET_SESSION_SECRET

beforeEach(() => {
  process.env.WALLET_SESSION_SECRET = 'unit-test-wallet-session-secret'
  vi.mocked(executeJupiterSwapDirect).mockClear()
})

afterEach(() => {
  if (originalKey === undefined) delete process.env.TRADING_KEYPAIR_JSON
  else process.env.TRADING_KEYPAIR_JSON = originalKey
  if (originalSecret === undefined) delete process.env.WALLET_SESSION_SECRET
  else process.env.WALLET_SESSION_SECRET = originalSecret
})

function unsignedTransfer(payer: Keypair): string {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message()
  const tx = new VersionedTransaction(message)
  return Buffer.from(tx.serialize()).toString('base64')
}

function authed(address: string, body: unknown) {
  const token = serializeWalletSession(createWalletSession(address))
  return new NextRequest('http://localhost/api/trade/server-execute', {
    method: 'POST',
    headers: {
      cookie: `${WALLET_SESSION_COOKIE}=${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('/api/trade/server-execute', () => {
  it('rejects anonymous callers before signing', async () => {
    const blocked = enforceApiAccess(
      new NextRequest('http://localhost/api/trade/server-execute', { method: 'POST' }),
    )
    expect(blocked?.status).toBe(401)

    delete process.env.TRADING_KEYPAIR_JSON
    const res = await POST(
      new NextRequest('http://localhost/api/trade/server-execute', {
        method: 'POST',
        body: JSON.stringify({ swaps: [{ swapTransaction: 'aa', requestId: 'r' }] }),
      }),
    )
    expect(res.status).toBe(401)
    expect(executeJupiterSwapDirect).not.toHaveBeenCalled()
  })

  it('lands only when the session matches the trading key and the fee payer is that key', async () => {
    const trading = Keypair.generate()
    const secretJson = JSON.stringify(Array.from(trading.secretKey))
    process.env.TRADING_KEYPAIR_JSON = secretJson
    const address = trading.publicKey.toBase58()

    const mismatch = await POST(
      authed(Keypair.generate().publicKey.toBase58(), {
        swaps: [{ swapTransaction: unsignedTransfer(trading), requestId: 'req-1' }],
      }),
    )
    expect(mismatch.status).toBe(403)
    expect(executeJupiterSwapDirect).not.toHaveBeenCalled()

    const landed = await POST(
      authed(address, {
        swaps: [{ swapTransaction: unsignedTransfer(trading), requestId: 'req-1' }],
      }),
    )
    expect(landed.status).toBe(200)
    const body = await landed.json()
    expect(JSON.stringify(body)).not.toContain(secretJson)
    expect(body.results).toEqual([
      { signature: 'landed-sig', outputAmount: '99' },
    ])
    expect(executeJupiterSwapDirect).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1' }),
    )

    const wrongPayer = await POST(
      authed(address, {
        swaps: [{ swapTransaction: unsignedTransfer(Keypair.generate()), requestId: 'req-2' }],
      }),
    )
    expect(wrongPayer.status).toBe(200)
    const wrongBody = await wrongPayer.json()
    expect(wrongBody.results[0].error).toMatch(/fee payer/i)
    expect(JSON.stringify(wrongBody)).not.toContain(secretJson)
  })
})
