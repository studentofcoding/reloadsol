"use client";

import React, { Suspense } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import SignalsTab from "@/components/signals/SignalsTab";
import LiveTab from "@/components/signals/LiveTab";
import BoardTab from "@/components/signals/BoardTab";
import TrackerTab from "@/components/signals/TrackerTab";

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

function SignalsHubContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawTab = searchParams.get("tab");
  const activeTab: TabId = isTabId(rawTab) ? rawTab : "signals";

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

      {activeTab === "signals" && <SignalsTab />}
      {activeTab === "live" && <LiveTab />}
      {activeTab === "board" && <BoardTab />}
      {activeTab === "tracker" && <TrackerTab />}
    </div>
  );
}

export default function SignalsHub() {
  return (
    <Suspense
      fallback={
        <div className="py-8 text-center text-gray-400">Loading signals…</div>
      }
    >
      <SignalsHubContent />
    </Suspense>
  );
}
