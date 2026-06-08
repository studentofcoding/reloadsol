import { useQuery } from '@tanstack/react-query';
import type { MeteoraPool } from '@/types/dlmm';
import type { DlmmScreenCandidate } from '@/types/dlmm';

export interface EnrichedPool extends MeteoraPool {
  organic_score: number;
  fee_tvl_ratio_24h: number;
}

export function useDlmmPools(limit = 50) {
  return useQuery({
    queryKey: ['dlmm-pools', limit],
    queryFn: async () => {
      const res = await fetch(`/api/dlmm/pools?limit=${limit}`);
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to fetch DLMM pools');
      }
      return data as { success: boolean; pools: EnrichedPool[] };
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useDlmmCandidates(limit = 25) {
  return useQuery({
    queryKey: ['dlmm-candidates', limit],
    queryFn: async () => {
      const res = await fetch(`/api/dlmm/pools?source=candidates&limit=${limit}`);
      const data = await res.json();
      if (!res.ok || (!data.success && !data.candidates)) {
        throw new Error(data.error || 'Failed to fetch candidates');
      }
      return data as { success: boolean; candidates: DlmmScreenCandidate[] };
    },
    refetchInterval: 60_000,
  });
}
