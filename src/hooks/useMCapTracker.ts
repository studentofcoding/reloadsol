import { useQuery, keepPreviousData } from '@tanstack/react-query';

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
  when_reach_80mc: string | null;
  when_reach_120mc: string | null;
  when_reach_200mc: string | null;
  solPerToken: {
    first: number;
    current: number;
    growth: number;
  };
  is_finished?: boolean;
  finished_at?: string | null;
  is_tracking_stuck?: boolean;
  _live_refresh?: boolean;
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
  toasts?: Array<{
    type: string;
    title: string;
    message: string;
    items?: Array<{ symbol: string; address: string; growthPercent: number }>;
  }>;
}

interface UseMCapTrackerParams {
  filters: FilterOptions;
  page: number;
  limit: number;
}

export function useMCapTracker({ filters, page, limit }: UseMCapTrackerParams) {
  return useQuery({
    queryKey: ['mcap-tracker', filters, page, limit],
    queryFn: async () => {
      const params = new URLSearchParams({
        action: 'list',
        page: page.toString(),
        limit: limit.toString(),
        search: filters.search,
        sortBy: filters.sortBy,
        sortOrder: filters.sortOrder,
        timeFilter: filters.timeFilter,
        performanceFilter: filters.performanceFilter,
        excludeZeroPnl: filters.excludeZeroPnl.toString(),
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
  });
}
