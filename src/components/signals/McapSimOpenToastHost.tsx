"use client";

import McapTrackerToasts from "@/components/signals/McapTrackerToasts";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { useMcapSimOpenAlerts } from "@/hooks/useMcapSimOpenAlerts";

/** App-wide host: polls sim-open alerts and renders toasts on every route. */
export default function McapSimOpenToastHost() {
  const { network } = useAppNetwork();
  const { data: alerts } = useMcapSimOpenAlerts({
    network,
    refetchInterval: 15_000,
  });

  return <McapTrackerToasts toasts={alerts ?? []} />;
}
