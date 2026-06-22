import { useQuery } from "@tanstack/react-query";
import {
  fetchAxiomTokenInfo,
  getRiskIndicators,
} from "@/utils/axiom";

export function useAxiomRisk(
  tokenAddress: string,
  marketCap: number,
  enabled = true,
) {
  return useQuery({
    queryKey: ["axiom-risk", tokenAddress, marketCap],
    queryFn: async () => {
      const result = await fetchAxiomTokenInfo(tokenAddress);
      if (!result.success || !result.data) {
        throw new Error("Failed to load risk data");
      }
      return {
        axiomData: result.data,
        risk: getRiskIndicators(result.data, marketCap),
      };
    },
    enabled: enabled && !!tokenAddress,
    staleTime: 60_000,
    retry: 1,
  });
}
