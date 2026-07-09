"use client";

import McapTrackerToasts from "@/components/signals/McapTrackerToasts";
import { useMcapSimOpenAlerts } from "@/hooks/useMcapSimOpenAlerts";

/** App-wide host: polls sim-open alerts and renders toasts on every route. */
export default function McapSimOpenToastHost() {
  const { data: alerts } = useMcapSimOpenAlerts({
    refetchInterval: 15_000,
  });

  return <McapTrackerToasts toasts={alerts ?? []} />;
}
