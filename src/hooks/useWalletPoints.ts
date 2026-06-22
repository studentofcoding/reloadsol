import { useQuery } from "@tanstack/react-query";
import { getWalletPoints } from "@/utils/operations-api";

export function useWalletPoints(walletAddress: string | null) {
  return useQuery({
    queryKey: ["wallet-points", walletAddress],
    queryFn: () => getWalletPoints(walletAddress!),
    enabled: !!walletAddress,
    staleTime: 30_000,
  });
}
