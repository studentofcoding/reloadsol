import { useQuery } from "@tanstack/react-query";
import type { EnrichedTokenData } from "@/utils/data-aggregation";

async function fetchTokenAnalytics(tokenAddresses: string[]) {
  const response = await fetch("/api/analytics/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenAddresses, maxAge: 60 }),
  });
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || "Analytics request failed");
  }
  const analytics: Record<string, EnrichedTokenData> = {};
  (result.data as EnrichedTokenData[]).forEach((token) => {
    analytics[token.token_address] = token;
  });
  return analytics;
}

export function useTokenAnalytics(tokenAddresses: string[]) {
  const key = tokenAddresses.join(",");
  return useQuery({
    queryKey: ["token-analytics", key],
    queryFn: () => fetchTokenAnalytics(tokenAddresses),
    enabled: tokenAddresses.length > 0,
    staleTime: 60_000,
  });
}
