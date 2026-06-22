import { useQuery } from "@tanstack/react-query";
import { getRpcHealth } from "@/utils/rpc-config";

export function useRpcHealth() {
  return useQuery({
    queryKey: ["rpc-health"],
    queryFn: getRpcHealth,
    staleTime: 30_000,
  });
}
