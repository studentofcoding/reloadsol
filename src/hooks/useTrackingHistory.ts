import { useQuery, keepPreviousData } from '@tanstack/react-query';

export interface TrackedTokenHistory {
  id: string;
  token_address: string;
  token_symbol: string | null;
  token_name: string | null;
  logo_url: string | null;
  initial_price_usd: number;
  last_price_usd: number;
  peak_price_usd: number;
  current_gain_percentage: number;
  peak_gain_percentage: number;
  status: "waiting" | "tracking" | "won" | "lost" | "skipped";
  organic_score: number | null;
  market_cap: number | null;
  volume_1h: number | null;
  volume_5m: number | null;
  tracking_started_at: string;
  status_changed_at: string | null;
  created_at: string;
  updated_at: string;
  trade_comparison_data?: any | null;
  trading_simulation?: any | null;
  price_history?: any[] | null;
  waiting_started_at?: string | null;
  waiting_initial_price?: number | null;
}

export interface FilterOptions {
  status: "all" | "waiting" | "tracking" | "won" | "lost" | "skipped";
  dateRange: "all" | "24h" | "7d" | "30d" | "90d";
  minGain: string;
  maxGain: string;
  minDuration: string;
  maxDuration: string;
  sortBy:
    | "created_at"
    | "peak_gain_percentage"
    | "current_gain_percentage"
    | "tracking_duration"
    | "status_changed_at";
  sortOrder: "asc" | "desc";
}

export interface TrackingHistoryResponse {
  success: boolean;
  data: TrackedTokenHistory[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  stats: {
    total: number;
    won: number;
    lost: number;
    tracking: number;
    waiting: number;
    skipped: number;
    winRate: number;
    avgPeakGain: number;
  };
  filters: any;
  timestamp: string;
  error?: string;
}

interface UseTrackingHistoryParams {
  filters: FilterOptions;
  page: number;
  limit: number;
  searchQuery: string;
}

export function useTrackingHistory({ filters, page, limit, searchQuery }: UseTrackingHistoryParams) {
  return useQuery({
    queryKey: ['tracking-history', filters, page, limit, searchQuery],
    queryFn: async () => {
      const params = new URLSearchParams({
        status: filters.status,
        dateRange: filters.dateRange,
        sortBy: filters.sortBy,
        sortOrder: filters.sortOrder,
        page: page.toString(),
        limit: limit.toString(),
      });

      if (filters.minGain) params.append("minGain", filters.minGain);
      if (filters.maxGain) params.append("maxGain", filters.maxGain);
      if (filters.minDuration) params.append("minDuration", filters.minDuration);
      if (filters.maxDuration) params.append("maxDuration", filters.maxDuration);
      if (searchQuery.trim()) params.append("search", searchQuery.trim());

      const res = await fetch(`/api/trending/history?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`API error: ${res.status} ${res.statusText}`);
      }
      return res.json() as Promise<TrackingHistoryResponse>;
    },
    placeholderData: keepPreviousData,
    staleTime: 60000, // 1 minute
  });
}
