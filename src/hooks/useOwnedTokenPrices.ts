import { useQuery } from "@tanstack/react-query";

async function fetchOwnedTokenPrices(
  tokenMints: string[],
): Promise<Record<string, number>> {
  if (!tokenMints.length) return {};
  const resp = await fetch(`/api/tokens/prices?tokens=${tokenMints.join(",")}`);
  if (!resp.ok) throw new Error("Failed to fetch prices");
  const data = await resp.json();
  return data.prices || {};
}

export function useOwnedTokenPrices(tokenMints: string[]) {
  const key = tokenMints.join(",");
  return useQuery({
    queryKey: ["owned-token-prices", key],
    queryFn: () => fetchOwnedTokenPrices(tokenMints),
    enabled: tokenMints.length > 0,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
