import { useQuery } from "@tanstack/react-query";

export type LiveTrendingToken = {
  token_address: string;
  token_symbol: string;
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
  created_at?: number;
};

async function fetchLiveTrendingRaw(): Promise<LiveTrendingToken[]> {
  const response = await fetch("/api/trending?cache=off", { cache: "no-store" });
  if (!response.ok) throw new Error("Failed to fetch trending tokens");
  const data = await response.json();
  return (data.tokens ?? []).filter(
    (token: LiveTrendingToken) => (token.mcap || 0) > 0 && (token.mcap || 0) <= 300000,
  );
}

export function useLiveTrendingTokens(refetchInterval = 5 * 60 * 1000) {
  return useQuery({
    queryKey: ["live-trending-tokens"],
    queryFn: fetchLiveTrendingRaw,
    refetchInterval,
    staleTime: 30_000,
  });
}
