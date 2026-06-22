import { useQuery } from "@tanstack/react-query";
import { getSolPriceUSD } from "@/utils/solana";

export function useSolPrice(refetchInterval = 300_000) {
  return useQuery({
    queryKey: ["sol-price"],
    queryFn: getSolPriceUSD,
    staleTime: 60_000,
    refetchInterval,
    refetchOnWindowFocus: true,
  });
}

export function useSolPriceFromApi(refetchInterval = 60_000) {
  return useQuery({
    queryKey: ["sol-price-api"],
    queryFn: async () => {
      const response = await fetch("/api/solprice");
      const data = await response.json();
      if (!data.price || data.price <= 0) {
        throw new Error("Invalid SOL price");
      }
      return data.price as number;
    },
    staleTime: 30_000,
    refetchInterval,
    refetchOnWindowFocus: true,
  });
}
