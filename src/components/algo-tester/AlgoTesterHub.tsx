"use client";

import React, { Suspense } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import ScrollableMenuRow from "@/components/ScrollableMenuRow";

const AlgoDashboardTab = dynamic(
  () => import("@/components/algo-tester/AlgoDashboardTab"),
  { loading: () => <TabLoading label="Dashboard" /> },
);
const HistoryTab = dynamic(() => import("@/components/algo-tester/HistoryTab"), {
  loading: () => <TabLoading label="History" />,
});

const TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "history", label: "History" },
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

function AlgoTesterHubContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawTab = searchParams.get("tab");
  const activeTab: TabId = isTabId(rawTab) ? rawTab : "dashboard";

  const setTab = (tab: TabId) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  };

  return (
    <div className="w-full">
      <ScrollableMenuRow className="mb-6 border-b border-gray-700 pb-3">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setTab(tab.id)}
            className={`shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.id
                ? "bg-white text-black"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </ScrollableMenuRow>

      {activeTab === "dashboard" && <AlgoDashboardTab />}
      {activeTab === "history" && <HistoryTab />}
    </div>
  );
}

export default function AlgoTesterHub() {
  return (
    <Suspense fallback={<TabLoading label="algo tester" />}>
      <AlgoTesterHubContent />
    </Suspense>
  );
}
