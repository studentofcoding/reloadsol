import { useQuery } from "@tanstack/react-query";

async function fetchSolPriceFromApi(): Promise<number> {
  const response = await fetch("/api/solprice");
  const data = await response.json();
  if (!data.price || data.price <= 0) {
    throw new Error("Invalid SOL price");
  }
  return data.price as number;
}

export function useSolPrice(refetchInterval = 300_000) {
  return useQuery({
    queryKey: ["sol-price"],
    queryFn: fetchSolPriceFromApi,
    staleTime: 60_000,
    refetchInterval,
    refetchOnWindowFocus: true,
  });
}

/** @deprecated Use useSolPrice — same query key and endpoint */
export function useSolPriceFromApi(refetchInterval = 60_000) {
  return useSolPrice(refetchInterval);
}
