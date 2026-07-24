'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RhClmmPosition } from '@/types/dlmm'
import { getDlmmPassword } from '@/hooks/useDlmmPositions'

function authHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'x-dlmm-password': getDlmmPassword(),
  }
}

export function useRhClmmMarks(owner?: string | null, status = 'open') {
  const qs = new URLSearchParams()
  if (status) qs.set('status', status)
  if (owner) qs.set('owner', owner)
  const q = qs.toString()
  return useQuery({
    queryKey: ['rh-clmm-positions', status, owner ?? 'all'],
    queryFn: async () => {
      const res = await fetch(`/api/dlmm/rh-clmm-positions${q ? `?${q}` : ''}`)
      const data = await res.json()
      return data as { success: boolean; positions: RhClmmPosition[] }
    },
    refetchInterval: 30_000,
  })
}

export function useCreateRhClmmMark() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch('/api/dlmm/rh-clmm-positions', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Create failed')
      return data as { success: boolean; position: RhClmmPosition }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rh-clmm-positions'] })
    },
  })
}

export function usePatchRhClmmMark() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const res = await fetch('/api/dlmm/rh-clmm-positions', {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Update failed')
      return data
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rh-clmm-positions'] })
    },
  })
}
