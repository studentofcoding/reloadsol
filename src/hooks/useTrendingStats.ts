import { useQuery } from '@tanstack/react-query';

export interface TrendingStatsResponse {
  success: boolean;
  timestamp: string;
  latest_summary: any;
  current_tracking: {
    tokens: any[];
    statistics: any;
    averages: any;
  };
  recent_completed: {
    winners: any[];
    losers: any[];
  };
  trends: any;
  data_freshness: any;
  cached: boolean;
  cache_age: number;
  expires_in: number;
}

export interface TrendingStatsFilters {
  isSimulated?: boolean;
  strategyId?: string;
}

export function useTrendingStats(
  refreshInterval = 30000,
  filters?: TrendingStatsFilters,
) {
  const params = new URLSearchParams({ nocache: 'true' });
  if (filters?.isSimulated !== undefined) {
    params.set('is_simulated', String(filters.isSimulated));
  }
  if (filters?.strategyId) {
    params.set('strategy_id', filters.strategyId);
  }

  return useQuery({
    queryKey: ['trending-stats', filters?.isSimulated, filters?.strategyId],
    queryFn: async () => {
      const res = await fetch(`/api/trending/stats?${params.toString()}`);
      if (!res.ok) {
        throw new Error('Failed to fetch trending stats');
      }
      return res.json() as Promise<TrendingStatsResponse>;
    },
    refetchInterval: refreshInterval,
    refetchOnWindowFocus: true,
    staleTime: 10000,
  });
}
