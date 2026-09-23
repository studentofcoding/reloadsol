import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  chooseSolSignerMode,
  signPreparedSwapTransactions,
} from '@/utils/sol-desk-signer'

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

describe('chooseSolSignerMode', () => {
  const trading = Keypair.generate().publicKey.toBase58()

  it('uses the server when the connected pubkey matches', () => {
    expect(chooseSolSignerMode(trading, trading)).toBe('server')
  })

  it('uses the wallet when the connected pubkey does not match', () => {
    const other = Keypair.generate().publicKey.toBase58()
    expect(chooseSolSignerMode(other, trading)).toBe('wallet')
  })

  it('uses the wallet when the server key is missing or unreadable', () => {
    expect(chooseSolSignerMode(trading, null)).toBe('wallet')
    expect(chooseSolSignerMode(trading, '')).toBe('wallet')
    expect(chooseSolSignerMode(trading, 'not-a-key')).toBe('wallet')
    expect(chooseSolSignerMode('', trading)).toBe('wallet')
  })
})

describe('signPreparedSwapTransactions', () => {
  const trading = Keypair.generate()
  const tradingPk = trading.publicKey.toBase58()
  let tx: VersionedTransaction

  beforeEach(() => {
    tx = unsignedTransfer(trading)
  })

  it('pubkey match signs on the server and does not call the wallet', async () => {
    const walletSign = vi.fn(async (txs: VersionedTransaction[]) => txs)
    const serverSign = vi.fn(async (txs: VersionedTransaction[]) => {
      txs.forEach((item) => item.sign([trading]))
      return txs
    })

    const result = await signPreparedSwapTransactions(
      {
        userPublicKey: tradingPk,
        transactions: [tx],
        walletSign,
      },
      {
        lookupPublicKey: async () => tradingPk,
        serverSign,
      },
    )

    expect(result.mode).toBe('server')
    expect(serverSign).toHaveBeenCalledOnce()
    expect(walletSign).not.toHaveBeenCalled()
    expect(() => result.signed[0].serialize()).not.toThrow()
  })

  it('pubkey mismatch uses the wallet signer', async () => {
    const other = Keypair.generate().publicKey.toBase58()
    const walletSign = vi.fn(async (txs: VersionedTransaction[]) => txs)
    const serverSign = vi.fn(async (txs: VersionedTransaction[]) => txs)

    const result = await signPreparedSwapTransactions(
      {
        userPublicKey: other,
        transactions: [tx],
        walletSign,
      },
      {
        lookupPublicKey: async () => tradingPk,
        serverSign,
      },
    )

    expect(result.mode).toBe('wallet')
    expect(walletSign).toHaveBeenCalledOnce()
    expect(serverSign).not.toHaveBeenCalled()
  })

  it('missing server keypair uses the wallet signer', async () => {
    const walletSign = vi.fn(async (txs: VersionedTransaction[]) => txs)
    const serverSign = vi.fn(async (txs: VersionedTransaction[]) => txs)

    const result = await signPreparedSwapTransactions(
      {
        userPublicKey: tradingPk,
        transactions: [tx],
        walletSign,
      },
      {
        lookupPublicKey: async () => null,
        serverSign,
      },
    )

    expect(result.mode).toBe('wallet')
    expect(walletSign).toHaveBeenCalledOnce()
    expect(serverSign).not.toHaveBeenCalled()
  })

  it('falls back to the wallet when the server pubkey cannot be loaded', async () => {
    const walletSign = vi.fn(async (txs: VersionedTransaction[]) => txs)
    const serverSign = vi.fn(async (txs: VersionedTransaction[]) => txs)

    const result = await signPreparedSwapTransactions(
      {
        userPublicKey: tradingPk,
        transactions: [tx],
        walletSign,
      },
      {
        lookupPublicKey: async () => {
          throw new Error('keypair load failed')
        },
        serverSign,
      },
    )

    expect(result.mode).toBe('wallet')
    expect(walletSign).toHaveBeenCalledOnce()
    expect(serverSign).not.toHaveBeenCalled()
  })
})
