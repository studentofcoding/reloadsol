import { useQuery } from "@tanstack/react-query";
import type { EnrichedTokenData } from "@/utils/data-aggregation";
import {
  analyticsMaxAgeFromTimeFilter,
  type AnalyticsMissingMint,
} from "@/app/api/analytics/token/analytics-helpers";

export type { AnalyticsMissingMint };

export type TokenAnalyticsResult = {
  data: Record<string, EnrichedTokenData>;
  missing: AnalyticsMissingMint[];
};

export type UseTokenAnalyticsOptions = {
  /** Minutes. `0` = no last_updated_at cutoff. Omit → route default 60. */
  maxAgeMinutes?: number;
};

export { analyticsMaxAgeFromTimeFilter };

export async function fetchTokenAnalytics(
  tokenAddresses: string[],
  opts?: UseTokenAnalyticsOptions,
): Promise<TokenAnalyticsResult> {
  const body: { tokenAddresses: string[]; maxAge?: number } = { tokenAddresses };
  if (opts?.maxAgeMinutes !== undefined) {
    body.maxAge = opts.maxAgeMinutes;
  }

  const response = await fetch("/api/analytics/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }
  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || "Analytics request failed");
  }
  const analytics: Record<string, EnrichedTokenData> = {};
  for (const token of (result.data as EnrichedTokenData[] | undefined) ?? []) {
    if (token?.token_address) analytics[token.token_address] = token;
  }
  const missing: AnalyticsMissingMint[] = Array.isArray(result.missing)
    ? result.missing
    : [];
  return { data: analytics, missing };
}

export function useTokenAnalytics(
  tokenAddresses: string[],
  opts?: UseTokenAnalyticsOptions,
) {
  const key = tokenAddresses.join(",");
  const maxAgeKey =
    opts?.maxAgeMinutes === undefined ? "default" : String(opts.maxAgeMinutes);
  return useQuery({
    queryKey: ["token-analytics", key, maxAgeKey],
    queryFn: () => fetchTokenAnalytics(tokenAddresses, opts),
    enabled: tokenAddresses.length > 0,
    staleTime: 60_000,
  });
}
