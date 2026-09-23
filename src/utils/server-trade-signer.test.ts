import { afterEach, describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  assertSessionCanServerSign,
  readTradingKeypair,
  signVersionedWithTradingKeypair,
  tradingKeypairPublicKey,
} from '@/utils/server-trade-signer'

const original = process.env.TRADING_KEYPAIR_JSON

afterEach(() => {
  if (original === undefined) delete process.env.TRADING_KEYPAIR_JSON
  else process.env.TRADING_KEYPAIR_JSON = original
})

function unsignedTransfer(payer: Keypair): VersionedTransaction {
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
  return new VersionedTransaction(message)
}

describe('readTradingKeypair', () => {
  it('returns null when the env key is missing or invalid', () => {
    delete process.env.TRADING_KEYPAIR_JSON
    expect(readTradingKeypair()).toBeNull()
    expect(tradingKeypairPublicKey()).toBeNull()

    process.env.TRADING_KEYPAIR_JSON = 'not-json'
    expect(readTradingKeypair()).toBeNull()

    process.env.TRADING_KEYPAIR_JSON = JSON.stringify([1, 2, 3])
    expect(readTradingKeypair()).toBeNull()
  })

  it('loads the pubkey from TRADING_KEYPAIR_JSON without exposing the secret', () => {
    const keypair = Keypair.generate()
    process.env.TRADING_KEYPAIR_JSON = JSON.stringify(Array.from(keypair.secretKey))
    const loaded = readTradingKeypair()
    expect(loaded?.publicKey.toBase58()).toBe(keypair.publicKey.toBase58())
    expect(tradingKeypairPublicKey()).toBe(keypair.publicKey.toBase58())
  })
})

describe('assertSessionCanServerSign', () => {
  const trading = Keypair.generate().publicKey.toBase58()

  it('allows only the matching session', () => {
    expect(assertSessionCanServerSign(trading, trading)).toEqual({
      ok: true,
      publicKey: trading,
    })
    expect(assertSessionCanServerSign(Keypair.generate().publicKey.toBase58(), trading).ok).toBe(
      false,
    )
    expect(assertSessionCanServerSign(trading, null)).toEqual({
      ok: false,
      code: 'NO_KEYPAIR',
    })
    expect(assertSessionCanServerSign(null, trading)).toEqual({
      ok: false,
      code: 'NO_SESSION',
    })
  })
})

describe('signVersionedWithTradingKeypair', () => {
  it('signs a fee payer that is the trading key and rejects a different wallet', () => {
    const trading = Keypair.generate()
    const other = Keypair.generate()
    const ownTx = unsignedTransfer(trading)
    signVersionedWithTradingKeypair([ownTx], trading)
    expect(
      nacl.sign.detached.verify(
        ownTx.message.serialize(),
        ownTx.signatures[0],
        trading.publicKey.toBytes(),
      ),
    ).toBe(true)

    expect(() =>
      signVersionedWithTradingKeypair([unsignedTransfer(other)], trading),
    ).toThrow(/fee payer/i)
  })
})
