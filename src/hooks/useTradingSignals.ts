import { useQuery } from '@tanstack/react-query';

export interface TradingSignalsParams {
  limit: number;
  recencyMinutes: number;
  minGrowth: number;
  includeStuck: boolean;
  maxAgeMinutes: number;
  strategy: "default" | "sell_over_100";
}

export interface SignalItem {
  token_address: string;
  token_symbol?: string;
  current_mcap?: number;
  first_mcap?: number;
  mcap_growth_percent?: number;
  score?: number;
  decision?: "enter" | "hold" | "exit" | "skip";
  rationale?: string;
  first_seen_at?: string;
  last_updated_at?: string;
  when_reach_80pct?: string | null;
  when_reach_120pct?: string | null;
  when_reach_200pct?: string | null;
  is_tracking_stuck?: boolean;
}

export interface SignalsResponse {
  success: boolean;
  params?: Record<string, any>;
  stats?: Record<string, any>;
  signals?: SignalItem[];
}

export function useTradingSignals(params: TradingSignalsParams) {
  return useQuery({
    queryKey: ['trading-signals', params],
    queryFn: async () => {
      const query = new URLSearchParams({
        limit: params.limit.toString(),
        recencyMinutes: params.recencyMinutes.toString(),
        minGrowth: params.minGrowth.toString(),
        includeStuck: params.includeStuck.toString(),
        maxAgeMinutes: params.maxAgeMinutes.toString(),
        strategy: params.strategy,
      }).toString();

      const res = await fetch(`/api/trading/signals?${query}`);
      if (!res.ok) {
        throw new Error(`Failed to fetch signals (${res.status})`);
      }
      return res.json() as Promise<SignalsResponse>;
    },
    refetchInterval: 30000, // Auto refresh every 30s
    staleTime: 10000,
  });
}
