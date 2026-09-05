import { useQuery } from "@tanstack/react-query";
import {
  isValidAnyChainTokenAddress,
  isValidTradeTokenAddress,
} from "@/utils/gmgn-currencies";

export type ChartTokenInfo = {
  symbol: string;
  name: string;
  address: string;
  price: number;
  logoURI?: string;
  decimals: number;
  marketCap: number;
};

async function fetchRhChartTokenInfo(
  tokenAddress: string,
): Promise<ChartTokenInfo> {
  const res = await fetch(
    `/api/gmgn/token/search?chain=robinhood&query=${encodeURIComponent(tokenAddress)}`,
  );
  if (!res.ok) throw new Error("Failed to fetch token metadata");
  const data: unknown = await res.json();
  const row = Array.isArray(data) ? data[0] : null;
  if (!row || typeof row !== "object") throw new Error("Token not found");
  const t = row as {
    symbol?: string;
    name?: string;
    address?: string;
    icon?: string;
    mcap?: number;
  };
  return {
    symbol: t.symbol || "UNKNOWN",
    name: t.name || "Unknown Token",
    address: t.address || tokenAddress,
    price: 0,
    logoURI: t.icon,
    decimals: 18,
    marketCap: typeof t.mcap === "number" && Number.isFinite(t.mcap) ? t.mcap : 0,
  };
}

async function fetchChartTokenInfo(
  tokenAddress: string,
): Promise<ChartTokenInfo> {
  if (isValidTradeTokenAddress("robinhood", tokenAddress)) {
    return fetchRhChartTokenInfo(tokenAddress);
  }

  const jupiterResponse = await fetch(
    `/api/jupiter/metadata?mint=${tokenAddress}`,
  );
  if (!jupiterResponse.ok) {
    throw new Error("Failed to fetch token metadata");
  }

  const jupiterData = await jupiterResponse.json();
  const tokenData = jupiterData.data;
  if (!tokenData) {
    throw new Error("Token not found");
  }

  let price = 0;
  let marketCap = 0;
  try {
    const trendingResponse = await fetch(
      `/api/trending/search?query=${tokenAddress}`,
    );
    if (trendingResponse.ok) {
      const trendingData = await trendingResponse.json();
      const tokenTrending = Array.isArray(trendingData)
        ? trendingData.find((t) => t.id === tokenAddress)
        : null;
      if (tokenTrending) {
        price = tokenTrending.price || 0;
        marketCap = tokenTrending.mcap || 0;
      }
    }
  } catch {
    // optional enrichment
  }

  return {
    symbol: tokenData.symbol || "UNKNOWN",
    name: tokenData.name || "Unknown Token",
    address: tokenAddress,
    price,
    logoURI: tokenData.logoURI,
    decimals: tokenData.decimals || 6,
    marketCap,
  };
}

export function useChartTokenInfo(tokenAddress: string | null) {
  const valid = !!tokenAddress && isValidAnyChainTokenAddress(tokenAddress);

  return useQuery({
    queryKey: ["chart-token-info", tokenAddress],
    queryFn: () => fetchChartTokenInfo(tokenAddress!),
    enabled: valid,
    staleTime: 60_000,
    retry: 1,
  });
}
