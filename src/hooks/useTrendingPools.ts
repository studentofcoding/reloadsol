import { useQuery } from '@tanstack/react-query';

export interface TrendingToken {
  token_symbol: string;
  token_address: string;
  price: number;
  change_1h: number;
  change_5m: number;
  buy_volume_1h: number;
  sell_volume_1h: number;
  buy_volume_5m: number;
  sell_volume_5m: number;
  volume_1h: number;
  volume_5m: number;
  mcap: number;
  logo_url?: string;
  organic_score: number;
  last_updated?: number;
  price_change?: number;
  created_at?: number;
}

export interface TrendingResponse {
  tokens: TrendingToken[];
  cached: boolean;
  cache_age: number;
  expires_in: number;
  refresh_type?: string;
  last_updated?: number;
}

export function useTrendingPools(refreshInterval = 30000) {
  return useQuery({
    queryKey: ['trending-pools'],
    queryFn: async () => {
      const response = await fetch('/api/trending', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response.json() as Promise<TrendingResponse>;
    },
    refetchInterval: refreshInterval,
    staleTime: 10000,
    refetchOnWindowFocus: true,
  });
}
