"use client";

import React, { Suspense, useCallback, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import ScrollableMenuRow from "@/components/ScrollableMenuRow";
import {
  ALGO_TESTER_TABS,
  STRATEGY_DOMAIN_OPTIONS,
  canonicalizeAlgoTesterSearch,
  parseAlgoTesterQuery,
  strategyIdOptionsFromRegistry,
  type AlgoTesterQuery,
  type AlgoTesterSimulated,
  type AlgoTesterTab,
} from "@/components/algo-tester/algo-tester-query";
import { useState } from "react";
import { AlgoOpenPositionsTab } from "@/components/AlgoPositions";
import { useAppNetwork } from "@/contexts/AppNetworkContext";

const StrategyAdminHub = dynamic(
  () => import("@/components/strategies/StrategyAdminHub"),
  { loading: () => <TabLoading label="Config" /> },
);
const HistoryTab = dynamic(() => import("@/components/algo-tester/HistoryTab"), {
  loading: () => <TabLoading label="History" />,
});
// T3: the evidence half of the surface. The Noul panel fetches its own data and renders its own
// vacuity labels (T2), so it moves whole rather than being re-cut.
const EarlyEnterNoulShadowPanel = dynamic(
  () => import("@/components/strategies/EarlyEnterNoulShadowPanel"),
  { loading: () => <TabLoading label="Health" /> },
);

const TAB_LABELS: Record<AlgoTesterTab, string> = {
  config: "Config",
  open: "Open positions",
  closed: "Closed reports",
  health: "Health",
};

// T3: the cron/workers table, moved to Health. It is exported from `StrategyAdminHub` rather than
// reimplemented — `.then` on the dynamic import keeps it in that chunk instead of pulling the whole hub
// into the main bundle, and there is still exactly one copy of the table.
const WorkersTab = dynamic(
  () => import("@/components/strategies/StrategyAdminHub").then((m) => ({ default: m.WorkersTab })),
  { loading: () => <TabLoading label="Workers" /> },
);

function TabLoading({ label }: { label: string }) {
  return (
    <div className="py-8 text-center text-gray-400">Loading {label}…</div>
  );
}

function AlgoTesterFilterStrip({
  query,
  strategyOptions,
  showSimulated,
  showToken,
  onPatch,
}: {
  query: AlgoTesterQuery;
  strategyOptions: { id: string; label: string }[];
  showSimulated: boolean;
  showToken: boolean;
  onPatch: (patch: Partial<AlgoTesterQuery>) => void;
}) {
  return (
    <div className="mb-4 flex flex-wrap gap-3 text-sm">
      <label className="text-gray-400">
        Domain
        <select
          className="mt-1 block rounded border border-gray-600 bg-gray-800 px-2 py-1 text-white"
          value={query.domain}
          onChange={(e) =>
            onPatch({
              domain: e.target.value as AlgoTesterQuery["domain"],
              strategyId: "",
            })
          }
        >
          {STRATEGY_DOMAIN_OPTIONS.map((opt) => (
            <option key={opt.value || "all"} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-gray-400">
        Strategy
        <select
          className="mt-1 block min-w-[160px] rounded border border-gray-600 bg-gray-800 px-2 py-1 text-white"
          value={query.strategyId}
          onChange={(e) => onPatch({ strategyId: e.target.value })}
        >
          <option value="">All</option>
          {strategyOptions.map((opt) => (
            <option key={`${opt.id}-${opt.label}`} value={opt.id}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      {showSimulated ? (
        <label className="text-gray-400">
          Sim / Live
          <select
            className="mt-1 block rounded border border-gray-600 bg-gray-800 px-2 py-1 text-white"
            value={query.simulated}
            onChange={(e) =>
              onPatch({ simulated: e.target.value as AlgoTesterSimulated })
            }
          >
            <option value="all">All</option>
            <option value="sim">SIM</option>
            <option value="live">LIVE</option>
          </select>
        </label>
      ) : null}
      {showToken ? (
        <label className="text-gray-400">
          Token
          <input
            type="search"
            className="mt-1 block w-56 rounded border border-gray-600 bg-gray-800 px-2 py-1 text-white"
            value={query.tokenAddress}
            placeholder="Search token / CA"
            onChange={(e) => onPatch({ tokenAddress: e.target.value })}
          />
        </label>
      ) : null}
    </div>
  );
}

function AlgoTesterHubContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { network } = useAppNetwork();
  const query = useMemo(
    () => parseAlgoTesterQuery(searchParams),
    [searchParams],
  );

  useEffect(() => {
    const canonical = canonicalizeAlgoTesterSearch(searchParams);
    if (canonical !== searchParams.toString()) {
      router.replace(canonical ? `${pathname}?${canonical}` : pathname);
    }
  }, [searchParams, router, pathname]);

  const patchQuery = useCallback(
    (patch: Partial<AlgoTesterQuery>) => {
      const next = new URLSearchParams(searchParams.toString());
      const merged: AlgoTesterQuery = { ...query, ...patch };
      next.set("tab", merged.tab);
      if (merged.domain) next.set("domain", merged.domain);
      else next.delete("domain");
      if (merged.strategyId) next.set("strategyId", merged.strategyId);
      else next.delete("strategyId");
      if (merged.simulated && merged.simulated !== "all") {
        next.set("simulated", merged.simulated);
      } else {
        next.delete("simulated");
        next.delete("is_simulated");
      }
      if (merged.tokenAddress.trim()) {
        next.set("tokenAddress", merged.tokenAddress.trim());
      } else {
        next.delete("tokenAddress");
      }
      if (merged.panel) next.set("panel", merged.panel);
      else next.delete("panel");
      if (merged.view) next.set("view", merged.view);
      else next.delete("view");
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, query, router, searchParams],
  );

  const setTab = (tab: AlgoTesterTab) => {
    patchQuery({
      tab,
      panel: "",
      view: "",
    });
  };

  const strategiesQuery = useQuery({
    queryKey: ["algo-tester-strategies", network],
    queryFn: async () => {
      const res = await fetch(`/api/strategies?chain=${network}`);
      return res.json();
    },
    staleTime: 30_000,
  });

  // T3: the workers table moved to Health, so its data did too — same endpoint and the same 30s cadence
  // as the Config panel used, just gated on the tab that renders it.
  const workersQuery = useQuery({
    queryKey: ["workers-status"],
    queryFn: async () => {
      const res = await fetch("/api/workers/status");
      // Deliberately uncast: `WorkersStatusResponse` is declared inside `StrategyAdminHub` and the shape
      // is checked where it is consumed. Casting to a partial type here is exactly what made the prop
      // unassignable — the compiler was right and the cast was wrong.
      const json = await res.json();
      if (!json.success) throw new Error("Failed to load workers");
      return json;
    },
    refetchInterval: query.tab === "health" ? 30_000 : false,
    enabled: query.tab === "health",
  });
  const [triggeringWorker, setTriggeringWorker] = useState<string | null>(null);
  const runWorkerNow = async (workerId: string) => {
    setTriggeringWorker(workerId);
    try {
      await fetch("/api/workers/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workerId }),
      });
      await workersQuery.refetch();
    } finally {
      setTriggeringWorker(null);
    }
  };

  const strategyOptions = useMemo(
    () => strategyIdOptionsFromRegistry(strategiesQuery.data, query.domain),
    [strategiesQuery.data, query.domain],
  );

  return (
    <div className="w-full">
      <ScrollableMenuRow className="mb-4 border-b border-gray-700 pb-3">
        {ALGO_TESTER_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setTab(tab)}
            className={`shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              query.tab === tab
                ? "bg-white text-black"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white"
            }`}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </ScrollableMenuRow>

      <AlgoTesterFilterStrip
        query={query}
        strategyOptions={strategyOptions}
        // T3: Health is evidence, not trades — the Noul panel fetches its own data and ignores these
        // filters. `query.tab !== "config"` handed it the simulated toggle anyway, which rendered a
        // control nothing consumes, on a tab built to remove exactly that kind of thing.
        showSimulated={query.tab === "open" || query.tab === "closed"}
        showToken={query.tab === "open" || query.tab === "closed"}
        onPatch={patchQuery}
      />

      {query.tab === "health" && (
        <div className="space-y-3">
          <EarlyEnterNoulShadowPanel />
          <WorkersTab
            data={workersQuery.data}
            loading={workersQuery.isLoading}
            error={workersQuery.error}
            onRefresh={() => void workersQuery.refetch()}
            triggeringWorker={triggeringWorker}
            onRunNow={runWorkerNow}
          />
        </div>
      )}

      {query.tab === "config" && (
        <StrategyAdminHub
          embedded={{
            view: "config",
            panel: query.panel === "workers" ? "workers" : "",
            domain: query.domain,
            strategyId: query.strategyId,
            hideSharedFilters: true,
            onDomainChange: (domain) =>
              patchQuery({ domain: domain as AlgoTesterQuery["domain"], strategyId: "" }),
            onStrategyIdChange: (strategyId) => patchQuery({ strategyId }),
          }}
        />
      )}
      {query.tab === "open" && query.view === "history" && (
        <div className="space-y-3">
          <p className="text-sm text-amber-300/90">
            Trending token tracker history — not{" "}
            <code className="text-xs">strategy_outcomes</code>.{" "}
            <button
              type="button"
              className="text-blue-400 underline"
              onClick={() => patchQuery({ tab: "open", view: "" })}
            >
              Back to open positions
            </button>
          </p>
          <HistoryTab />
        </div>
      )}
      {query.tab === "open" && query.view !== "history" && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            <button
              type="button"
              className="text-blue-400 underline"
              onClick={() => patchQuery({ tab: "open", view: "history" })}
            >
              Trending token tracker history
            </button>
            {" "}
            (not closed outcomes)
          </p>
          <AlgoOpenPositionsTab
            domain={query.domain}
            strategyId={query.strategyId}
            simulated={query.simulated}
            tokenAddress={query.tokenAddress}
          />
        </div>
      )}
      {query.tab === "closed" && (
        <StrategyAdminHub
          embedded={{
            view: "closed",
            panel: query.panel === "review" ? "review" : "",
            domain: query.domain,
            strategyId: query.strategyId,
            simulated: query.simulated,
            tokenAddress: query.tokenAddress,
            hideSharedFilters: true,
            onDomainChange: (domain) =>
              patchQuery({ domain: domain as AlgoTesterQuery["domain"], strategyId: "" }),
            onStrategyIdChange: (strategyId) => patchQuery({ strategyId }),
            onSimulatedChange: (simulated) => patchQuery({ simulated }),
            onTokenAddressChange: (tokenAddress) => patchQuery({ tokenAddress }),
          }}
        />
      )}
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
