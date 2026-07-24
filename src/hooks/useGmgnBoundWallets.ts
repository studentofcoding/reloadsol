'use client'

import { useQuery } from '@tanstack/react-query'
import {
  isGmgnBoundEvm,
  isGmgnBoundSol,
  type GmgnBoundWallets,
} from '@/utils/gmgn-bound-wallets'

async function fetchBoundWallets(): Promise<GmgnBoundWallets> {
  const res = await fetch('/api/gmgn/bound-wallets')
  if (!res.ok) return { sol: null, evm: null }
  const data = (await res.json()) as {
    sol?: string | null
    evm?: string | null
  }
  return {
    sol: data.sol?.trim() || null,
    evm: data.evm?.trim() || null,
  }
}

export function useGmgnBoundWallets() {
  const query = useQuery({
    queryKey: ['gmgn-bound-wallets'],
    queryFn: fetchBoundWallets,
    staleTime: 60_000,
  })
  const wallets = query.data ?? { sol: null, evm: null }
  return {
    ...query,
    wallets,
    sol: wallets.sol,
    evm: wallets.evm,
    isSyncedSol: (connected: string | null | undefined) =>
      isGmgnBoundSol(connected, wallets.sol),
    isSyncedEvm: (connected: string | null | undefined) =>
      isGmgnBoundEvm(connected, wallets.evm),
  }
}
