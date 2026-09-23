import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NextRequest } from 'next/server'
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import nacl from 'tweetnacl'
import { GET, POST } from '@/app/api/trade/server-sign/route'
import { enforceApiAccess } from '@/utils/api-auth'
import {
  WALLET_SESSION_COOKIE,
  createWalletSession,
  serializeWalletSession,
} from '@/utils/wallet-session'

const originalKey = process.env.TRADING_KEYPAIR_JSON
const originalSecret = process.env.WALLET_SESSION_SECRET

beforeEach(() => {
  process.env.WALLET_SESSION_SECRET = 'unit-test-wallet-session-secret'
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

function authed(url: string, address: string, init?: { method?: string; body?: string }) {
  const token = serializeWalletSession(createWalletSession(address))
  return new NextRequest(url, {
    method: init?.method ?? 'GET',
    headers: {
      cookie: `${WALLET_SESSION_COOKIE}=${token}`,
      'content-type': 'application/json',
    },
    body: init?.body,
  })
}

describe('/api/trade/server-sign', () => {
  it('rejects anonymous callers before any signing', async () => {
    const blocked = enforceApiAccess(
      new NextRequest('http://localhost/api/trade/server-sign', { method: 'POST' }),
    )
    expect(blocked?.status).toBe(401)

    delete process.env.TRADING_KEYPAIR_JSON
    const res = await POST(
      new NextRequest('http://localhost/api/trade/server-sign', {
        method: 'POST',
        body: JSON.stringify({ transactions: ['aaaa'] }),
      }),
    )
    expect(res.status).toBe(401)
  })

  it('returns no pubkey when the session is a different wallet or the key is missing', async () => {
    const trading = Keypair.generate()
    process.env.TRADING_KEYPAIR_JSON = JSON.stringify(Array.from(trading.secretKey))
    const other = Keypair.generate().publicKey.toBase58()
    const mismatch = await GET(
      authed('http://localhost/api/trade/server-sign', other),
    )
    expect(mismatch.status).toBe(200)
    await expect(mismatch.json()).resolves.toMatchObject({ publicKey: null })

    delete process.env.TRADING_KEYPAIR_JSON
    const missing = await GET(
      authed('http://localhost/api/trade/server-sign', trading.publicKey.toBase58()),
    )
    await expect(missing.json()).resolves.toMatchObject({ publicKey: null })
  })

  it('signs only when the session matches the trading key and the fee payer is that key', async () => {
    const trading = Keypair.generate()
    const secretJson = JSON.stringify(Array.from(trading.secretKey))
    process.env.TRADING_KEYPAIR_JSON = secretJson
    const address = trading.publicKey.toBase58()

    const lookup = await GET(authed('http://localhost/api/trade/server-sign', address))
    await expect(lookup.json()).resolves.toMatchObject({
      success: true,
      publicKey: address,
    })

    const signedRes = await POST(
      authed('http://localhost/api/trade/server-sign', address, {
        method: 'POST',
        body: JSON.stringify({ transactions: [unsignedTransfer(trading)] }),
      }),
    )
    expect(signedRes.status).toBe(200)
    const signedBody = await signedRes.json()
    expect(JSON.stringify(signedBody)).not.toContain(secretJson)
    expect(signedBody.signedTransactions).toHaveLength(1)
    const signed = VersionedTransaction.deserialize(
      Buffer.from(signedBody.signedTransactions[0], 'base64'),
    )
    expect(
      nacl.sign.detached.verify(
        signed.message.serialize(),
        signed.signatures[0],
        trading.publicKey.toBytes(),
      ),
    ).toBe(true)

    const otherSession = await POST(
      authed('http://localhost/api/trade/server-sign', Keypair.generate().publicKey.toBase58(), {
        method: 'POST',
        body: JSON.stringify({ transactions: [unsignedTransfer(trading)] }),
      }),
    )
    expect(otherSession.status).toBe(403)
    expect(JSON.stringify(await otherSession.json())).not.toContain(secretJson)

    const wrongPayer = await POST(
      authed('http://localhost/api/trade/server-sign', address, {
        method: 'POST',
        body: JSON.stringify({
          transactions: [unsignedTransfer(Keypair.generate())],
        }),
      }),
    )
    expect(wrongPayer.status).toBe(400)
    expect(JSON.stringify(await wrongPayer.json())).not.toContain(secretJson)
  })
})
