import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BUYBULK_DATAPUBLIC_SCOUT_ID, type ScoutCandidate } from '@/utils/data-public-scout'
import {
  parsePaperNotches,
  writePaperNotchesToStorage,
  type PaperNotch,
} from '@/utils/paper-notch-store'

export const BUYBULK_PAPER_NOTCHES_QUERY_KEY = [
  'buybulk-datapublic-scout-paper-notches',
] as const

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

async function fetchPaperNotches(): Promise<PaperNotch[]> {
  const response = await fetch('/api/scout/data-public/paper', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  const data: unknown = await response.json().catch(() => null)
  if (!response.ok || data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('paper notches BFF HTTP ' + response.status)
  }
  const body = data as { ok?: boolean; notches?: unknown; strategyId?: string }
  if (body.ok !== true) throw new Error('paper notches BFF returned an invalid payload')
  if (body.strategyId && body.strategyId !== BUYBULK_DATAPUBLIC_SCOUT_ID) {
    throw new Error('unexpected paper-notch strategy id')
  }
  const notches = parsePaperNotches(body.notches)
  writePaperNotchesToStorage(notches, storage())
  return notches
}

async function postPaperNotch(candidate: ScoutCandidate): Promise<{
  ok: true
  notch: PaperNotch
  created: boolean
} | { ok: false; reason: string; error?: string }> {
  const response = await fetch('/api/scout/data-public/paper', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      candidate: {
        chain: candidate.chain,
        mint: candidate.mint,
        symbol: candidate.symbol,
        name: candidate.name,
        kind: candidate.kind,
        decision: candidate.decision,
        score: candidate.score,
        id: candidate.id,
        url: candidate.url,
        mcap: candidate.mcap,
        liq: candidate.liq,
        source: candidate.source,
      },
    }),
  })
  const data: unknown = await response.json().catch(() => null)
  const body =
    data !== null && typeof data === 'object' && !Array.isArray(data)
      ? (data as {
          ok?: boolean
          created?: boolean
          notch?: PaperNotch
          reason?: string
          error?: string
        })
      : null
  if (!body || body.ok !== true || !body.notch) {
    return {
      ok: false,
      reason: body?.reason || 'error',
      error: body?.error,
    }
  }
  return { ok: true, notch: body.notch, created: body.created === true }
}

/** DB is source of truth. localStorage is a cache filled after successful GET. */
export function useBuybulkPaperNotches(cache: PaperNotch[]) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: BUYBULK_PAPER_NOTCHES_QUERY_KEY,
    queryFn: fetchPaperNotches,
    staleTime: 15_000,
    retry: 1,
    placeholderData: cache,
  })

  const mutation = useMutation({
    mutationFn: postPaperNotch,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: BUYBULK_PAPER_NOTCHES_QUERY_KEY })
    },
  })

  return {
    notches: query.data ?? cache,
    isLoading: query.isPending && !query.data,
    isError: query.isError,
    note: mutation.mutateAsync,
    noting: mutation.isPending,
  }
}
