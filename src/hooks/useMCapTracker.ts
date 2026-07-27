import { useQuery, keepPreviousData } from '@tanstack/react-query';
import type { McapToast } from '@/types/mcap-toasts';

export interface FilterOptions {
  search: string;
  sortBy: string;
  sortOrder: "asc" | "desc";
  minGrowth: string;
  maxGrowth: string;
  minMcap: string;
  maxMcap: string;
  excludeZeroPnl: boolean;
  timeFilter: "1h" | "4h" | "24h" | "3d" | "7d" | "1m" | "all";
  performanceFilter: "all" | "gainers" | "losers" | "top_performers";
}

export interface McapTrackingData {
  token_address: string;
  token_symbol: string;
  first_mcap: number;
  current_mcap: number;
  first_seen_at: string;
  last_updated_at: string;
  mcap_growth_percent: number;
  when_reach_80pct: string | null;
  when_reach_120pct: string | null;
  when_reach_200pct: string | null;
  when_drop_40pct?: string | null;
  when_drop_80pct?: string | null;
  peak_mcap?: number | null;
  peak_growth_percent?: number | null;
  peak_seen_at?: string | null;
  label?: string | null;
  solPerToken: {
    first: number;
    current: number;
    growth: number;
  };
  is_finished?: boolean;
  finished_at?: string | null;
  is_tracking_stuck?: boolean;
  _live_refresh?: boolean;
  pattern_p_winner?: number | null;
  pattern_predicted?: 'winner' | 'loser' | null;
}

export interface McapTrackerResponse {
  success: boolean;
  data: McapTrackingData[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  stats: any;
  toasts?: McapToast[];
}

interface UseMCapTrackerParams {
  filters: FilterOptions;
  page: number;
  limit: number;
  refetchInterval?: number | false;
  scanPredictive?: boolean;
  chain?: 'sol' | 'robinhood';
}

export function useMCapTracker({
  filters,
  page,
  limit,
  refetchInterval = false,
  scanPredictive = false,
  chain = 'sol',
}: UseMCapTrackerParams) {
  return useQuery({
    queryKey: ['mcap-tracker', filters, page, limit, scanPredictive, chain],
    queryFn: async () => {
      const params = new URLSearchParams({
        action: 'list',
        chain,
        page: page.toString(),
        limit: limit.toString(),
        search: filters.search,
        sortBy: filters.sortBy,
        sortOrder: filters.sortOrder,
        timeFilter: filters.timeFilter,
        performanceFilter: filters.performanceFilter,
        excludeZeroPnl: filters.excludeZeroPnl.toString(),
        scanPredictive: scanPredictive ? 'true' : 'false',
      });

      if (filters.minGrowth) params.append('minGrowth', filters.minGrowth);
      if (filters.maxGrowth) params.append('maxGrowth', filters.maxGrowth);
      if (filters.minMcap) params.append('minMcap', filters.minMcap);
      if (filters.maxMcap) params.append('maxMcap', filters.maxMcap);

      const res = await fetch(`/api/mcap-tracking?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch data (${res.status})`);
      }
      return res.json() as Promise<McapTrackerResponse>;
    },
    placeholderData: keepPreviousData,
    staleTime: 30000,
    refetchInterval,
  });
}
