import type { Address, PublicClient, WalletClient } from 'viem'

export type RhClmmCtx = {
  publicClient: PublicClient
  walletClient?: WalletClient
  owner: Address
}

let currentCtx: RhClmmCtx | undefined

/**
 * Runs a CLMM operation against injected clients.
 * ponytail: this module-level context is safe for sequential browser UI calls;
 * overlapping calls must not be nested. Use request-scoped storage if server concurrency is added.
 */
export async function withRhClmmCtx<T>(ctx: RhClmmCtx, fn: () => Promise<T>): Promise<T> {
  const previous = currentCtx
  currentCtx = ctx
  try {
    return await fn()
  } finally {
    currentCtx = previous
  }
}

function requireCtx(): RhClmmCtx {
  if (!currentCtx) throw new Error('RH CLMM context is required; call through withRhClmmCtx')
  return currentCtx
}

export function getPublicClient(_chainId?: number): PublicClient {
  return requireCtx().publicClient
}

export function getWalletClient(_chainId?: number): WalletClient {
  const wallet = requireCtx().walletClient
  if (!wallet) throw new Error('RH CLMM wallet client is required for this operation')
  return wallet
}

export function getHotWalletAddress(): Address {
  return requireCtx().owner
}
