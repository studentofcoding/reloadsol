import { useQuery } from "@tanstack/react-query";
import type { AppNetwork } from "@/utils/app-network";

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

async function fetchLiveTrendingRaw(
  chain: AppNetwork,
): Promise<LiveTrendingToken[]> {
  // Jupiter has no Robinhood list; the GMGN filtered feed is the RH source.
  const url =
    chain === "robinhood"
      ? "/api/gmgn/trending/filtered?chain=robinhood"
      : "/api/trending?cache=off";
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Failed to fetch trending tokens");
  const data = await response.json();
  const tokens = (data.tokens ?? []) as Partial<LiveTrendingToken>[];

  if (chain === "robinhood") {
    return tokens.map((t) => ({
      buy_volume_1h: 0,
      sell_volume_1h: 0,
      buy_volume_5m: 0,
      sell_volume_5m: 0,
      volume_5m: 0,
      ...t,
    })) as LiveTrendingToken[];
  }

  return (tokens as LiveTrendingToken[]).filter(
    (token) => (token.mcap || 0) > 0 && (token.mcap || 0) <= 300000,
  );
}

export function useLiveTrendingTokens(
  refetchInterval = 5 * 60 * 1000,
  chain: AppNetwork = "sol",
) {
  return useQuery({
    queryKey: ["live-trending-tokens", chain],
    queryFn: () => fetchLiveTrendingRaw(chain),
    refetchInterval,
    staleTime: 30_000,
  });
}
