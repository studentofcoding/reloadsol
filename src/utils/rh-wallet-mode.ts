export type RhWalletMode = 'parent' | 'bound'

export const RH_WALLET_MODE_STORAGE_KEY = 'reloadsol.rhWalletMode'

/**
 * Spike result (2026-07): GMGN `/v1/trade/swap` is bound-wallet + `GMGN_PRIVATE_KEY` only.
 * Quote may accept an arbitrary `from`, but swap cannot spend a Rabby parent wallet.
 * Parent trades use RH UniV2 + Rabby sign instead.
 */
export const GMGN_PARENT_FROM_SUPPORTED = false as const

export function parseRhWalletMode(raw: string | null | undefined): RhWalletMode {
  return raw === 'bound' ? 'bound' : 'parent'
}

export function readStoredRhWalletMode(): RhWalletMode {
  if (typeof window === 'undefined') return 'parent'
  try {
    return parseRhWalletMode(sessionStorage.getItem(RH_WALLET_MODE_STORAGE_KEY))
  } catch {
    return 'parent'
  }
}

export function writeStoredRhWalletMode(mode: RhWalletMode): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(RH_WALLET_MODE_STORAGE_KEY, mode)
  } catch {
    /* ignore */
  }
}

/** Active RH address for reads/trades. Parent with no Rabby → null. */
export function resolveRhActiveAddress(
  mode: RhWalletMode,
  parentAddress: string | null | undefined,
  boundAddress: string | null | undefined,
): string | null {
  if (mode === 'bound') {
    const b = boundAddress?.trim()
    return b || null
  }
  const p = parentAddress?.trim()
  return p || null
}
