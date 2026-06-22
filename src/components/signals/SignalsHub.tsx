"use client";

import React, { Suspense, useState } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

const SignalsTab = dynamic(() => import("@/components/signals/SignalsTab"), {
  loading: () => <TabLoading label="Signals" />,
});
const LiveTab = dynamic(() => import("@/components/signals/LiveTab"), {
  loading: () => <TabLoading label="Live" />,
});
const BoardTab = dynamic(() => import("@/components/signals/BoardTab"), {
  loading: () => <TabLoading label="Board" />,
});
const TrackerTab = dynamic(() => import("@/components/signals/TrackerTab"), {
  loading: () => <TabLoading label="Tracker" />,
});

const TABS = [
  { id: "signals", label: "Signals" },
  { id: "live", label: "Live" },
  { id: "board", label: "Board" },
  { id: "tracker", label: "Tracker" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function isTabId(value: string | null): value is TabId {
  return TABS.some((tab) => tab.id === value);
}

function TabLoading({ label }: { label: string }) {
  return (
    <div className="py-8 text-center text-gray-400">Loading {label}…</div>
  );
}

function SignalsHubContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawTab = searchParams.get("tab");
  const activeTab: TabId = isTabId(rawTab) ? rawTab : "signals";
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(
    () => new Set([activeTab]),
  );

  if (!mountedTabs.has(activeTab)) {
    setMountedTabs((prev) => {
      if (prev.has(activeTab)) return prev;
      const next = new Set(prev);
      next.add(activeTab);
      return next;
    });
  }

  const setTab = (tab: TabId) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    if (tab !== "board") {
      params.delete("addresses");
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  return (
    <div className="w-full">
      <div className="mb-6 flex flex-wrap gap-2 border-b border-gray-700 pb-3">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setTab(tab.id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "bg-white text-black"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mountedTabs.has("signals") && (
        <div hidden={activeTab !== "signals"} aria-hidden={activeTab !== "signals"}>
          <SignalsTab />
        </div>
      )}
      {mountedTabs.has("live") && (
        <div hidden={activeTab !== "live"} aria-hidden={activeTab !== "live"}>
          <LiveTab />
        </div>
      )}
      {mountedTabs.has("board") && (
        <div hidden={activeTab !== "board"} aria-hidden={activeTab !== "board"}>
          <BoardTab />
        </div>
      )}
      {mountedTabs.has("tracker") && (
        <div hidden={activeTab !== "tracker"} aria-hidden={activeTab !== "tracker"}>
          <TrackerTab />
        </div>
      )}
    </div>
  );
}

export default function SignalsHub() {
  return (
    <Suspense fallback={<TabLoading label="signals" />}>
      <SignalsHubContent />
    </Suspense>
  );
}
