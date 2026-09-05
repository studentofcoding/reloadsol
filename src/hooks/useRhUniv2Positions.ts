'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RhUniv2Position } from '@/types/dlmm'
import { getDlmmPassword } from '@/hooks/useDlmmPositions'

function authHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'x-dlmm-password': getDlmmPassword(),
  }
}

export function useRhUniv2Positions(status?: string, owner?: string) {
  const sp = new URLSearchParams()
  if (status) sp.set('status', status)
  if (owner) sp.set('owner', owner)
  const qs = sp.toString() ? `?${sp.toString()}` : ''
  return useQuery({
    queryKey: ['rh-univ2-positions', status ?? 'all', owner ?? ''],
    queryFn: async () => {
      const res = await fetch(`/api/dlmm/rh-univ2-positions${qs}`)
      const data = await res.json()
      return data as { success: boolean; positions: RhUniv2Position[] }
    },
    refetchInterval: 30_000,
  })
}

export function useCreateRhUniv2Position() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch('/api/dlmm/rh-univ2-positions', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Create failed')
      return data as { success: boolean; position: RhUniv2Position }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rh-univ2-positions'] })
    },
  })
}

export function usePatchRhUniv2Position() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch('/api/dlmm/rh-univ2-positions', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Update failed')
      return data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rh-univ2-positions'] })
    },
  })
}
