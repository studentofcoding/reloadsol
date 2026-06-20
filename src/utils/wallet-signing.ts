import type { VersionedTransaction } from '@solana/web3.js'

export type SignAllTransactionsFn = (
  transactions: VersionedTransaction[],
) => Promise<VersionedTransaction[]>

export function requireSignAllTransactions(
  signAllTransactions: SignAllTransactionsFn | undefined,
  message = 'Wallet signing is required for on-chain trades',
): SignAllTransactionsFn {
  if (!signAllTransactions) {
    throw new Error(message)
  }
  return signAllTransactions
}
