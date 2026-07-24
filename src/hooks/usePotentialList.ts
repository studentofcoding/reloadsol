'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppNetwork } from '@/contexts/AppNetworkContext'
import type { DlmmPotentialEntry, DlmmPotentialSource } from '@/types/dlmm'
import type { AppNetwork } from '@/utils/app-network'

export const POTENTIAL_LIST_QUERY_KEY = ['potential-list'] as const

async function fetchPotentialList(
  chain: AppNetwork,
): Promise<DlmmPotentialEntry[]> {
  const res = await fetch(`/api/potential?chain=${encodeURIComponent(chain)}`)
  const data = await res.json()
  if (!res.ok || !data.success) {
    throw new Error(data.error || 'Failed to fetch potential list')
  }
  return data.entries as DlmmPotentialEntry[]
}

export function usePotentialList() {
  const { network } = useAppNetwork()
  const queryClient = useQueryClient()
  const listKey = [...POTENTIAL_LIST_QUERY_KEY, network] as const

  const query = useQuery({
    queryKey: listKey,
    queryFn: () => fetchPotentialList(network),
    refetchInterval: 30_000,
  })

  const addressSet = new Set((query.data ?? []).map((e) => e.token_address))

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: POTENTIAL_LIST_QUERY_KEY })

  const addMutation = useMutation({
    mutationFn: async (input: {
      tokenAddress: string
      tokenSymbol?: string | null
      source: DlmmPotentialSource
      notes?: string | null
    }) => {
      const res = await fetch('/api/potential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenAddress: input.tokenAddress,
          tokenSymbol: input.tokenSymbol,
          source: input.source,
          notes: input.notes,
          chain: network,
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to add to potential list')
      }
      return data.entry as DlmmPotentialEntry
    },
    onSuccess: invalidate,
  })

  const removeMutation = useMutation({
    mutationFn: async (tokenAddress: string) => {
      const qs = new URLSearchParams({
        tokenAddress,
        chain: network,
      })
      const res = await fetch(`/api/potential?${qs}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to remove from potential list')
      }
    },
    onSuccess: invalidate,
  })

  const toggle = async (input: {
    tokenAddress: string
    tokenSymbol?: string | null
    source: DlmmPotentialSource
  }) => {
    if (addressSet.has(input.tokenAddress)) {
      await removeMutation.mutateAsync(input.tokenAddress)
      return false
    }
    await addMutation.mutateAsync(input)
    return true
  }

  return {
    entries: query.data ?? [],
    addressSet,
    isLoading: query.isLoading,
    isInList: (tokenAddress: string) => addressSet.has(tokenAddress),
    add: addMutation.mutateAsync,
    remove: removeMutation.mutateAsync,
    toggle,
    isPending: addMutation.isPending || removeMutation.isPending,
    invalidate,
  }
}

/** @deprecated Use usePotentialList */
export function useDlmmPotentialList() {
  return usePotentialList()
}
