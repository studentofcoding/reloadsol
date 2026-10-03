"use client";

import { useQuery } from "@tanstack/react-query";
import McapTrackerToasts from "@/components/signals/McapTrackerToasts";
import { useWalletSessionOptional } from "@/components/WalletSessionContext";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { useMcapSimOpenAlerts } from "@/hooks/useMcapSimOpenAlerts";
import { getWalletSessionStatus } from "@/utils/wallet-session-client";

/**
 * App-wide host: polls sim-open alerts and renders toasts on every route.
 *
 * The alerts route is dev-tier, so only poll once a dev wallet session exists. Signed-out and non-dev visitors
 * used to hit it every 15 s on every page and (with the proxy enforcing) would get a 401 each time.
 */
export default function McapSimOpenToastHost() {
  const { network } = useAppNetwork();
  const walletSession = useWalletSessionOptional();
  const { data: session } = useQuery({
    queryKey: ["wallet-session-dev", walletSession?.status ?? "none", walletSession?.sessionAddress ?? null],
    queryFn: getWalletSessionStatus,
    staleTime: 60_000,
    retry: false,
  });
  const { data: alerts } = useMcapSimOpenAlerts({
    network,
    refetchInterval: 15_000,
    enabled: Boolean(session?.dev),
  });

  return <McapTrackerToasts toasts={alerts ?? []} />;
}
