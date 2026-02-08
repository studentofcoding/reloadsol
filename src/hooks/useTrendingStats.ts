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

export function useTrendingStats(refreshInterval = 30000) {
  return useQuery({
    queryKey: ['trending-stats'],
    queryFn: async () => {
      // Use nocache=true to ensure we get fresh data from the API (API handles its own internal caching)
      // but React Query handles the client-side caching/deduping
      const res = await fetch('/api/trending/stats?nocache=true');
      if (!res.ok) {
        throw new Error('Failed to fetch trending stats');
      }
      return res.json() as Promise<TrendingStatsResponse>;
    },
    // Auto-refresh every 30s by default
    refetchInterval: refreshInterval,
    // Don't refetch if user tabs away (saves resources)
    refetchOnWindowFocus: true,
    // Keep data fresh for 10s
    staleTime: 10000,
  });
}
