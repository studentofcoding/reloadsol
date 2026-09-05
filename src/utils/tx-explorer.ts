import { explorerTxUrl } from '@/utils/dlmm/rh-univ2'

/** Solana sigs are base58; RH EVM tx hashes are 0x + 32 bytes. */
export function txSignatureExplorer(sig: string): {
  href: string
  label: string
} {
  const hash = sig.trim()
  if (/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return { href: explorerTxUrl(hash), label: 'View on Blockscout' }
  }
  return { href: `https://solscan.io/tx/${hash}`, label: 'View on Solscan' }
}
