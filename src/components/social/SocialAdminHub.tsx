"use client";

import ChartBuyModal from "@/components/ChartBuyModal";
import FomoMirrorPanel from "@/components/social/FomoMirrorPanel";
import {
  copyJson,
  downloadJson,
} from "@/components/token-locate/internal-export";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import type { AppNetwork } from "@/utils/app-network";
import { isValidTradeTokenAddress } from "@/utils/gmgn-currencies";
import { isValidMintAddress } from "@/utils/jupiter";
import { useQuery } from "@tanstack/react-query";
import React, { useCallback, useEffect, useMemo, useState } from "react";

type TrackedWallet = {
  address: string;
  label: string;
  tier: "tier1" | "tier2";
  tags: string[];
  is_active: boolean;
  last_polled_at: string | null;
  last_poll_error: string | null;
};

type SocialRollup = {
  token_address: string;
  mention_count_30m: number;
  unique_channel_count_30m: number;
  smart_wallet_buy_count_1h: number;
  top_source: string | null;
  last_event_at: string | null;
  updated_at: string;
};

type SocialStats = {
  eventCount24h: number;
  rollupCount: number;
  walletCount: number;
};

type SocialEvent = {
  id: string;
  token_address: string;
  event_type: string;
  source: string;
  channel_label: string | null;
  wallet_label: string | null;
  wallet_address: string | null;
  occurred_at: string;
  raw_metadata?: Record<string, unknown>;
};

type SocialAdminData = {
  wallets: TrackedWallet[];
  rollups: SocialRollup[];
  events: SocialEvent[];
  stats: SocialStats | null;
  fetchedAt: string;
};

type SignalChannel = {
  id: string;
  channel_name: string;
  channel_id: string | null;
  cluster_name: string;
  tolerance_pct: number;
  sim_buy_sol: number;
  is_active: boolean;
};

type CrosscheckRow = {
  id: string;
  token_address: string;
  channel_name: string;
  token_name: string | null;
  token_symbol: string | null;
  signal_price_usd: number;
  jupiter_price_usd: number | null;
  pct_diff: number | null;
  tolerance_pct: number;
  status: string;
  strategy_id: string | null;
  sim_opened: boolean;
  occurred_at: string;
};

async function fetchCrosschecks(): Promise<CrosscheckRow[]> {
  const res = await fetch("/api/social/crosscheck?limit=50&hours=48");
  const json = await res.json();
  if (!json.success) throw new Error(json.error || "Failed to load crosschecks");
  return (json.crosschecks ?? []) as CrosscheckRow[];
}

async function fetchSignalChannels(): Promise<SignalChannel[]> {
  const res = await fetch("/api/social/channels");
  const json = await res.json();
  if (!json.success) return [];
  return (json.channels ?? []) as SignalChannel[];
}

type McapPatterns24hData = {
  builtAt: string;
  winners: unknown[];
  losers: unknown[];
  neutralCount: number;
  tokenCount?: number;
  rules?: { winnerMinGrowthPct: number; loserMaxGrowthPct: number };
};

async function fetchMcapPatterns24h(
  chain: AppNetwork,
): Promise<McapPatterns24hData> {
  const res = await fetch(
    `/api/mcap-patterns/24h?chain=${encodeURIComponent(chain)}`,
  );
  const json = await res.json();
  if (!json.success) throw new Error(json.error || "Failed to load patterns");
  return {
    builtAt: json.builtAt,
    winners: json.winners ?? [],
    losers: json.losers ?? [],
    neutralCount: json.neutralCount ?? 0,
    tokenCount: json.tokenCount,
    rules: json.rules,
  };
}

type PatternMlStats = {
  winnerCount: number;
  loserCount: number;
  exportableRows: number;
  trainReady: boolean;
  patternModelReady: boolean;
  patternModelVersion: string | null;
  pipeline: {
    last_run_at?: string;
    status?: "success" | "partial" | "failed";
    export_rows?: number;
    train_ready?: boolean;
    train_skipped_reason?: string | null;
    trained_at?: string | null;
    macro_f1?: number | null;
    pattern_ready?: boolean | null;
    web_reloaded?: boolean;
  } | null;
  model: {
    trained_at: string | null;
    macro_f1: number | null;
    pattern_ready: boolean | null;
    class_counts: Record<string, number> | null;
    top_features: Array<{ name: string; importance: number }>;
  } | null;
};

function pipelineStatusClass(status?: string): string {
  if (status === "success") return "text-green-400";
  if (status === "failed") return "text-red-400";
  if (status === "partial") return "text-yellow-400";
  return "text-gray-500";
}

async function fetchPatternMlStats(chain: AppNetwork): Promise<PatternMlStats> {
  const res = await fetch(
    `/api/mcap-patterns/stats?chain=${encodeURIComponent(chain)}`,
  );
  const json = await res.json();
  if (!json.success) throw new Error(json.error || "Failed to load pattern ML stats");
  return {
    winnerCount: json.winnerCount ?? 0,
    loserCount: json.loserCount ?? 0,
    exportableRows: json.exportableRows ?? 0,
    trainReady: json.trainReady === true,
    patternModelReady: json.patternModelReady === true,
    patternModelVersion: json.patternModelVersion ?? null,
    pipeline: json.pipeline ?? null,
    model: json.model ?? null,
  };
}

function isSocialTokenAddress(network: AppNetwork, address: string): boolean {
  return network === "robinhood"
    ? isValidTradeTokenAddress("robinhood", address)
    : isValidMintAddress(address);
}

async function fetchSocialAdminData(
  network: AppNetwork,
): Promise<SocialAdminData> {
  const telegramOnly = network !== "robinhood";
  const [walletsRes, eventsRes] = await Promise.all([
    fetch(
      `/api/social/wallets?rollups_limit=40&chain=${encodeURIComponent(network)}`,
    ),
    fetch(
      `/api/social/events?limit=50&hours=24&telegram_only=${telegramOnly}&chain=${encodeURIComponent(network)}`,
    ),
  ]);
  const json = await walletsRes.json();
  if (!json.success) throw new Error(json.error || "Failed to load");

  const eventsJson = await eventsRes.json();
  return {
    wallets: (json.wallets ?? []) as TrackedWallet[],
    rollups: (json.rollups ?? []) as SocialRollup[],
    stats: (json.stats ?? null) as SocialStats | null,
    events: eventsJson.success
      ? ((eventsJson.events ?? []) as SocialEvent[])
      : [],
    fetchedAt: new Date().toISOString(),
  };
}

function truncateMint(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function eventUsd(meta?: Record<string, unknown>): string {
  if (!meta) return "—";
  const v = meta.usd ?? meta.solAmount ?? meta.amount_usd ?? meta.amount;
  if (typeof v === "number" && Number.isFinite(v)) {
    return v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
  }
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
    const n = Number(v);
    return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
  }
  return "—";
}

function formatRelativeTime(date: Date | null, nowMs: number): string {
  if (!date) return "";
  const secs = Math.floor((nowMs - date.getTime()) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function TokenCell({
  tokenAddress,
  tradable,
  onOpen,
}: {
  tokenAddress: string;
  tradable: boolean;
  onOpen: () => void;
}) {
  if (!tradable) {
    return (
      <span className="font-mono text-xs text-gray-500" title={tokenAddress}>
        {truncateMint(tokenAddress)}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="font-mono text-xs text-blue-400 hover:text-blue-300 hover:underline"
      title={tokenAddress}
      onClick={onOpen}
    >
      {truncateMint(tokenAddress)}
    </button>
  );
}

export default function SocialAdminHub() {
  const { network } = useAppNetwork();
  const isRobinhood = network === "robinhood";
  const [activeTab, setActiveTab] = useState<
    "overview" | "crosscheck" | "patterns"
  >("overview");
  const [actionError, setActionError] = useState<string | null>(null);
  const [newAddress, setNewAddress] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [channelName, setChannelName] = useState("");
  const [clusterName, setClusterName] = useState("cluster");
  const [tolerancePct, setTolerancePct] = useState("3");
  const [alertText, setAlertText] = useState("");
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [patternsRefreshLoading, setPatternsRefreshLoading] = useState(false);
  const [modalTokenAddress, setModalTokenAddress] = useState<string | null>(
    null,
  );
  const [modalTokenList, setModalTokenList] = useState<string[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const socialQuery = useQuery({
    queryKey: ["social-admin", network],
    queryFn: () => fetchSocialAdminData(network),
  });

  const channelsQuery = useQuery({
    queryKey: ["signal-channels"],
    queryFn: fetchSignalChannels,
  });

  const crosscheckQuery = useQuery({
    queryKey: ["signal-crosschecks"],
    queryFn: fetchCrosschecks,
    refetchInterval: activeTab === "crosscheck" ? 15_000 : false,
  });

  const patternsQuery = useQuery({
    queryKey: ["mcap-patterns-24h", network],
    queryFn: () => fetchMcapPatterns24h(network),
    enabled: activeTab === "patterns",
    refetchInterval: activeTab === "patterns" ? 60_000 : false,
  });

  const patternMlStatsQuery = useQuery({
    queryKey: ["mcap-patterns-ml-stats", network],
    queryFn: () => fetchPatternMlStats(network),
    enabled: activeTab === "patterns",
    refetchInterval: activeTab === "patterns" ? 60_000 : false,
  });

  const wallets = useMemo(
    () => socialQuery.data?.wallets ?? [],
    [socialQuery.data?.wallets],
  );
  const rollups = useMemo(
    () => socialQuery.data?.rollups ?? [],
    [socialQuery.data?.rollups],
  );
  const events = useMemo(
    () => socialQuery.data?.events ?? [],
    [socialQuery.data?.events],
  );
  const stats = socialQuery.data?.stats ?? null;
  const loading = socialQuery.isLoading;
  const error =
    actionError ??
    (socialQuery.error instanceof Error
      ? socialQuery.error.message
      : socialQuery.error
        ? String(socialQuery.error)
        : null);
  const lastUpdatedAt = socialQuery.data?.fetchedAt
    ? new Date(socialQuery.data.fetchedAt)
    : socialQuery.dataUpdatedAt
      ? new Date(socialQuery.dataUpdatedAt)
      : null;

  const eventTokenList = useMemo(
    () =>
      events
        .map((e) => e.token_address)
        .filter((a) => isSocialTokenAddress(network, a)),
    [events, network],
  );

  const rollupTokenList = useMemo(
    () =>
      rollups
        .map((r) => r.token_address)
        .filter((a) => isSocialTokenAddress(network, a)),
    [rollups, network],
  );

  const openBuyModal = useCallback(
    (tokenAddress: string, list: string[]) => {
      if (!isSocialTokenAddress(network, tokenAddress)) return;
      setModalTokenList(list);
      setModalTokenAddress(tokenAddress);
    },
    [network],
  );

  const refresh = useCallback(async () => {
    setActionError(null);
    const result = await socialQuery.refetch();
    if (result.error) {
      setActionError(
        result.error instanceof Error
          ? result.error.message
          : String(result.error),
      );
    }
  }, [socialQuery]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  useEffect(() => {
    if (isRobinhood && activeTab === "crosscheck") setActiveTab("overview");
  }, [isRobinhood, activeTab]);

  const modalIndex = modalTokenAddress
    ? modalTokenList.indexOf(modalTokenAddress)
    : -1;

  const addWallet = async () => {
    if (!newAddress.trim() || !newLabel.trim()) return;
    const res = await fetch("/api/social/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: newAddress.trim(),
        label: newLabel.trim(),
        tier: "tier2",
        tags: [],
        is_active: true,
      }),
    });
    const json = await res.json();
    if (!json.success) {
      setActionError(json.error || "Add failed");
      return;
    }
    setNewAddress("");
    setNewLabel("");
    await refresh();
  };

  const removeWallet = async (address: string) => {
    const res = await fetch(
      `/api/social/wallets?address=${encodeURIComponent(address)}`,
      { method: "DELETE" },
    );
    const json = await res.json();
    if (!json.success) {
      setActionError("Delete failed");
      return;
    }
    await refresh();
  };

  const runCrosscheck = async () => {
    if (!channelName.trim()) {
      setActionError("Channel name is required (manual input — not parsed from alert)");
      return;
    }
    if (!alertText.trim()) {
      setActionError("Paste an alert message to verify");
      return;
    }
    setVerifyLoading(true);
    setActionError(null);
    try {
      const res = await fetch("/api/social/crosscheck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          raw_message: alertText,
          channel_name: channelName.trim(),
          cluster_name: clusterName.trim() || "cluster",
          tolerance_pct: Number(tolerancePct) || 3,
        }),
      });
      const json = await res.json();
      if (!json.success && !json.crosscheck) {
        setActionError(json.error || "Cross-check failed");
        return;
      }
      await crosscheckQuery.refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifyLoading(false);
    }
  };

  const applyChannelPreset = (id: string) => {
    const preset = (channelsQuery.data ?? []).find((c) => c.id === id);
    if (!preset) return;
    setChannelName(preset.channel_name);
    setClusterName(preset.cluster_name || "cluster");
    setTolerancePct(String(preset.tolerance_pct ?? 3));
  };

  const refreshPatterns = async () => {
    setPatternsRefreshLoading(true);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/mcap-patterns/24h?refresh=true&chain=${encodeURIComponent(network)}`,
      );
      const json = await res.json();
      if (!json.success) {
        setActionError(json.error || "Pattern refresh failed");
        return;
      }
      await patternsQuery.refetch();
      await patternMlStatsQuery.refetch();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setPatternsRefreshLoading(false);
    }
  };

  const crosschecks = crosscheckQuery.data ?? [];
  const channelPresets = channelsQuery.data ?? [];
  const patterns = patternsQuery.data;
  const bothPatterns = patterns
    ? { winners: patterns.winners, losers: patterns.losers }
    : null;

  if (loading && activeTab === "overview") {
    return <p className="text-sm text-gray-400">Loading social data…</p>;
  }

  return (
    <div className="space-y-8">
      <div className="flex gap-2 border-b border-gray-800 pb-2">
        <button
          type="button"
          className={`rounded px-3 py-1.5 text-sm ${
            activeTab === "overview"
              ? "bg-gray-800 text-white"
              : "text-gray-400 hover:text-white"
          }`}
          onClick={() => setActiveTab("overview")}
        >
          Overview
        </button>
        {!isRobinhood ? (
        <button
          type="button"
          className={`rounded px-3 py-1.5 text-sm ${
            activeTab === "crosscheck"
              ? "bg-gray-800 text-white"
              : "text-gray-400 hover:text-white"
          }`}
          onClick={() => setActiveTab("crosscheck")}
        >
          Cross-check
        </button>
        ) : null}
        <button
          type="button"
          className={`rounded px-3 py-1.5 text-sm ${
            activeTab === "patterns"
              ? "bg-gray-800 text-white"
              : "text-gray-400 hover:text-white"
          }`}
          onClick={() => setActiveTab("patterns")}
        >
          24h Patterns
        </button>
      </div>

      {error ? (
        <p className="rounded border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {activeTab === "crosscheck" ? (
        <>
          <section>
            <h2 className="mb-2 text-lg font-medium text-white">
              Telegram signal price cross-check
            </h2>
            <p className="mb-4 text-xs text-gray-500">
              Channel name is manual — e.g. &quot;GMGN Alpha&quot;. Coin title
              lines like &quot;The Black Cobra (TATE)&quot; are parsed from the
              alert body, not used as the channel name.
            </p>
            <div className="mb-4 flex flex-wrap gap-2">
              <input
                className="min-w-[200px] rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
                placeholder="Channel name (required)"
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
              />
              <input
                className="w-28 rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
                placeholder="Cluster"
                value={clusterName}
                onChange={(e) => setClusterName(e.target.value)}
              />
              <input
                className="w-20 rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
                placeholder="Tol %"
                value={tolerancePct}
                onChange={(e) => setTolerancePct(e.target.value)}
              />
              {channelPresets.length > 0 ? (
                <select
                  className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) applyChannelPreset(e.target.value);
                  }}
                >
                  <option value="">Load preset…</option>
                  {channelPresets.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.channel_name}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
            <textarea
              className="mb-3 min-h-[180px] w-full rounded border border-gray-700 bg-gray-900 px-3 py-2 font-mono text-xs text-white"
              placeholder={`The Black Cobra (TATE) NEW ALERT!!!\n...\nUSD: $0.0000679 (+34%)\nDex: PumpSwap`}
              value={alertText}
              onChange={(e) => setAlertText(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-600 disabled:opacity-50"
                disabled={verifyLoading}
                onClick={() => void runCrosscheck()}
              >
                {verifyLoading ? "Verifying…" : "Verify"}
              </button>
              <button
                type="button"
                className="rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
                onClick={() => void crosscheckQuery.refetch()}
              >
                Refresh results
              </button>
            </div>
          </section>

          <section>
            <h3 className="mb-3 text-md font-medium text-white">Results</h3>
            <div className="overflow-x-auto rounded border border-gray-800">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-gray-900 text-gray-400">
                  <tr>
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Channel</th>
                    <th className="px-3 py-2">Coin</th>
                    <th className="px-3 py-2">Token</th>
                    <th className="px-3 py-2">Signal USD</th>
                    <th className="px-3 py-2">Jupiter USD</th>
                    <th className="px-3 py-2">Diff %</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Strategy</th>
                    <th className="px-3 py-2">Sim</th>
                  </tr>
                </thead>
                <tbody>
                  {crosschecks.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-gray-800 text-gray-200"
                    >
                      <td className="px-3 py-2 text-xs text-gray-400">
                        {row.occurred_at}
                      </td>
                      <td className="px-3 py-2">{row.channel_name}</td>
                      <td className="px-3 py-2 text-xs">
                        {row.token_name ?? "—"}
                        {row.token_symbol ? ` (${row.token_symbol})` : ""}
                      </td>
                      <td className="px-3 py-2">
                        <TokenCell
                          tokenAddress={row.token_address}
                          tradable={isSocialTokenAddress(
                            network,
                            row.token_address,
                          )}
                          onOpen={() =>
                            openBuyModal(
                              row.token_address,
                              crosschecks
                                .map((c) => c.token_address)
                                .filter((a) =>
                                  isSocialTokenAddress(network, a),
                                ),
                            )
                          }
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {Number(row.signal_price_usd).toFixed(8)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {row.jupiter_price_usd != null
                          ? Number(row.jupiter_price_usd).toFixed(8)
                          : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {row.pct_diff != null
                          ? `${Number(row.pct_diff).toFixed(2)}%`
                          : "—"}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            row.status === "passed"
                              ? "text-emerald-400"
                              : row.status === "failed"
                                ? "text-amber-400"
                                : "text-red-400"
                          }
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {row.strategy_id ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        {row.sim_opened ? "yes" : "—"}
                      </td>
                    </tr>
                  ))}
                  {crosschecks.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-3 py-4 text-gray-500">
                        No cross-checks yet — paste an alert and verify
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : activeTab === "patterns" ? (
        <>
          <section>
            <h2 className="mb-2 text-lg font-medium text-white">
              Mcap + social 24h patterns
            </h2>
            <p className="mb-4 text-xs text-gray-500">
              Auto-built from DB: winners (growth &ge;{" "}
              {patterns?.rules?.winnerMinGrowthPct ?? 120}%), losers (growth &lt;{" "}
              {patterns?.rules?.loserMaxGrowthPct ?? 80}%). Each entry is mcap
              tracker row + social events in the last 24h.
            </p>
            {patternsQuery.isLoading ? (
              <p className="text-sm text-gray-400">Loading patterns…</p>
            ) : (
              <>
                <div className="mb-4 grid grid-cols-3 gap-3 text-sm">
                  <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
                    <div className="text-gray-400">Winners</div>
                    <div className="text-xl font-semibold text-emerald-400">
                      {patterns?.winners.length ?? 0}
                    </div>
                  </div>
                  <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
                    <div className="text-gray-400">Losers</div>
                    <div className="text-xl font-semibold text-red-400">
                      {patterns?.losers.length ?? 0}
                    </div>
                  </div>
                  <div className="rounded border border-gray-800 bg-gray-900/60 p-3">
                    <div className="text-gray-400">Neutral (80–119%)</div>
                    <div className="text-xl font-semibold text-gray-300">
                      {patterns?.neutralCount ?? 0}
                    </div>
                  </div>
                </div>
                {patterns?.builtAt ? (
                  <p className="mb-3 text-xs text-gray-500">
                    Built {patterns.builtAt}
                  </p>
                ) : null}
                {patternMlStatsQuery.data ? (
                  <div className="mb-4 rounded border border-gray-800 bg-gray-900/40 p-3 text-xs text-gray-400">
                    <div className="font-medium text-gray-300 mb-1">
                      Pattern ML training
                    </div>
                    <div>
                      Exportable rows: {patternMlStatsQuery.data.exportableRows}{" "}
                      (win {patternMlStatsQuery.data.winnerCount} / lose{" "}
                      {patternMlStatsQuery.data.loserCount})
                    </div>
                    <div>
                      Train ready (30+ each cohort):{" "}
                      {patternMlStatsQuery.data.trainReady ? "yes" : "no"}
                    </div>
                    {patternMlStatsQuery.data.pipeline?.last_run_at ? (
                      <div>
                        Daily job:{" "}
                        <span
                          className={pipelineStatusClass(
                            patternMlStatsQuery.data.pipeline.status,
                          )}
                        >
                          {patternMlStatsQuery.data.pipeline.status ?? "unknown"}
                        </span>
                        {" · "}
                        last run {patternMlStatsQuery.data.pipeline.last_run_at}
                        {patternMlStatsQuery.data.pipeline.train_skipped_reason
                          ? ` — ${patternMlStatsQuery.data.pipeline.train_skipped_reason}`
                          : null}
                        {patternMlStatsQuery.data.pipeline.web_reloaded
                          ? " · ONNX reloaded"
                          : null}
                      </div>
                    ) : (
                      <div className="text-gray-500">
                        Daily job: not run yet — install with{" "}
                        <code className="text-gray-400">
                          bash scripts/install-ml-pattern-cron.sh
                        </code>
                      </div>
                    )}
                    <div>
                      Model:{" "}
                      {patternMlStatsQuery.data.patternModelReady
                        ? `ready (${patternMlStatsQuery.data.patternModelVersion ?? "pattern-gate"})`
                        : patternMlStatsQuery.data.model?.trained_at
                          ? `deployed, not ready (${patternMlStatsQuery.data.patternModelVersion ?? "pattern-gate"})`
                          : "not deployed — run npm run ml:pattern-daily"}
                    </div>
                    {patternMlStatsQuery.data.model?.macro_f1 != null ? (
                      <div>
                        macro-F1: {patternMlStatsQuery.data.model.macro_f1.toFixed(3)}
                        {patternMlStatsQuery.data.model.pattern_ready != null
                          ? ` · pattern_ready: ${patternMlStatsQuery.data.model.pattern_ready ? "yes" : "no"}`
                          : null}
                        {patternMlStatsQuery.data.model.trained_at
                          ? ` · trained ${patternMlStatsQuery.data.model.trained_at}`
                          : null}
                      </div>
                    ) : null}
                    <div className="mt-1 text-gray-500">
                      Shadow scores on sim opens even when model is not ready.
                      Enforce stays off until pattern_ready. Server log:{" "}
                      <code className="text-gray-400">logs/ml-pattern-daily.log</code>
                    </div>
                  </div>
                ) : null}
                <div className="mb-4 flex flex-wrap gap-2 rounded-lg border border-gray-700 bg-gray-900/40 px-4 py-3">
                  <button
                    type="button"
                    disabled={!patterns?.winners.length}
                    className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
                    onClick={() => copyJson(patterns?.winners ?? [])}
                  >
                    Copy winners JSON
                  </button>
                  <button
                    type="button"
                    disabled={!patterns?.losers.length}
                    className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
                    onClick={() => copyJson(patterns?.losers ?? [])}
                  >
                    Copy losers JSON
                  </button>
                  <button
                    type="button"
                    disabled={!bothPatterns}
                    className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
                    onClick={() => bothPatterns && copyJson(bothPatterns)}
                  >
                    Copy both
                  </button>
                  <span className="mx-1 hidden h-6 w-px bg-gray-700 sm:inline" />
                  <button
                    type="button"
                    disabled={!patterns?.winners.length}
                    className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
                    onClick={() =>
                      downloadJson("mcap-patterns-winners-24h.json", patterns?.winners ?? [])
                    }
                  >
                    Export winners
                  </button>
                  <button
                    type="button"
                    disabled={!patterns?.losers.length}
                    className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
                    onClick={() =>
                      downloadJson("mcap-patterns-losers-24h.json", patterns?.losers ?? [])
                    }
                  >
                    Export losers
                  </button>
                  <button
                    type="button"
                    disabled={!bothPatterns}
                    className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
                    onClick={() =>
                      bothPatterns &&
                      downloadJson("mcap-patterns-both-24h.json", bothPatterns)
                    }
                  >
                    Export both
                  </button>
                  <button
                    type="button"
                    disabled={patternsRefreshLoading}
                    className="rounded border border-gray-600 px-3 py-1 text-sm text-gray-300 hover:bg-gray-800 disabled:opacity-50"
                    onClick={() => void refreshPatterns()}
                  >
                    {patternsRefreshLoading ? "Refreshing…" : "Refresh from DB"}
                  </button>
                </div>
              </>
            )}
          </section>
        </>
      ) : (
        <>
      {stats ? (
        <div className="grid grid-cols-3 gap-4 text-sm">
          <div className="rounded border border-gray-800 bg-gray-900/60 p-4">
            <div className="text-gray-400">Events (24h)</div>
            <div className="text-xl font-semibold text-white">
              {stats.eventCount24h}
            </div>
          </div>
          <div className="rounded border border-gray-800 bg-gray-900/60 p-4">
            <div className="text-gray-400">Rollups</div>
            <div className="text-xl font-semibold text-white">
              {stats.rollupCount}
            </div>
          </div>
          <div className="rounded border border-gray-800 bg-gray-900/60 p-4">
            <div className="text-gray-400">Active wallets</div>
            <div className="text-xl font-semibold text-white">
              {stats.walletCount}
            </div>
          </div>
        </div>
      ) : null}

      <FomoMirrorPanel />

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-lg font-medium text-white">
            {isRobinhood ? "FOMO / social fills" : "Recent channel activity"}
          </h2>
          {lastUpdatedAt ? (
            <span className="text-xs text-gray-500">
              Updated {formatRelativeTime(lastUpdatedAt, now)}
            </span>
          ) : null}
        </div>
        <p className="mb-3 text-xs text-gray-500">
          {isRobinhood
            ? "cash_leg buys from robinhoodtrenches (source fomo_family)."
            : "Telegram mentions from social-ingest (excludes tracked-wallet poll)."}
          {" "}
          Live logs:{" "}
          <code className="text-gray-400">
            docker compose logs -f {isRobinhood ? "cron" : "social-ingest"}
          </code>
        </p>
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-gray-900 text-gray-400">
              <tr>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2">Handle</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">USD</th>
                <th className="px-3 py-2">Token</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-t border-gray-800 text-gray-200">
                  <td className="px-3 py-2 text-xs text-gray-400">
                    {e.occurred_at}
                  </td>
                  <td className="px-3 py-2">{e.source}</td>
                  <td className="px-3 py-2">{e.channel_label ?? "—"}</td>
                  <td className="px-3 py-2">
                    {e.wallet_label ?? e.wallet_address ?? "—"}
                  </td>
                  <td className="px-3 py-2">{e.event_type}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {eventUsd(e.raw_metadata)}
                  </td>
                  <td className="px-3 py-2">
                    <TokenCell
                      tokenAddress={e.token_address}
                      tradable={isSocialTokenAddress(network, e.token_address)}
                      onOpen={() =>
                        openBuyModal(e.token_address, eventTokenList)
                      }
                    />
                  </td>
                  <td className="px-3 py-2">
                    {isSocialTokenAddress(network, e.token_address) ? (
                      <button
                        type="button"
                        className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
                        title="Open Chart & Buy"
                        onClick={() =>
                          openBuyModal(e.token_address, eventTokenList)
                        }
                      >
                        Buy
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {events.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-4 text-gray-500">
                    No {isRobinhood ? "FOMO" : "Telegram"} events in the last 24h
                    {isRobinhood
                      ? " — cron fomo_ws must be ingesting cash_leg buys"
                      : " — check social-ingest is running and channels are active"}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {!isRobinhood ? (
        <>
      <section>
        <h2 className="mb-3 text-lg font-medium text-white">Tracked wallets</h2>
        <div className="mb-4 flex flex-wrap gap-2">
          <input
            className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
            placeholder="Wallet address"
            value={newAddress}
            onChange={(e) => setNewAddress(e.target.value)}
          />
          <input
            className="rounded border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-white"
            placeholder="Label"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
          />
          <button
            type="button"
            className="rounded bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-600"
            onClick={() => void addWallet()}
          >
            Add wallet
          </button>
          <button
            type="button"
            className="rounded border border-gray-700 px-3 py-2 text-sm text-gray-300 hover:bg-gray-800"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-gray-900 text-gray-400">
              <tr>
                <th className="px-3 py-2">Label</th>
                <th className="px-3 py-2">Address</th>
                <th className="px-3 py-2">Tier</th>
                <th className="px-3 py-2">Last poll</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {wallets.map((w) => (
                <tr key={w.address} className="border-t border-gray-800 text-gray-200">
                  <td className="px-3 py-2">{w.label}</td>
                  <td className="px-3 py-2 font-mono text-xs">{w.address}</td>
                  <td className="px-3 py-2">{w.tier}</td>
                  <td className="px-3 py-2 text-xs text-gray-400">
                    {w.last_polled_at ?? "—"}
                    {w.last_poll_error ? ` (${w.last_poll_error})` : ""}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="text-xs text-red-400 hover:text-red-300"
                      onClick={() => void removeWallet(w.address)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-medium text-white">Token rollups</h2>
        <div className="overflow-x-auto rounded border border-gray-800">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-gray-900 text-gray-400">
              <tr>
                <th className="px-3 py-2">Token</th>
                <th className="px-3 py-2">Mentions 30m</th>
                <th className="px-3 py-2">Channels</th>
                <th className="px-3 py-2">Wallet buys 1h</th>
                <th className="px-3 py-2">Top source</th>
                <th className="px-3 py-2">Updated</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rollups.map((r) => (
                <tr
                  key={r.token_address}
                  className="border-t border-gray-800 text-gray-200"
                >
                  <td className="px-3 py-2">
                    <TokenCell
                      tokenAddress={r.token_address}
                      tradable={isSocialTokenAddress(network, r.token_address)}
                      onOpen={() =>
                        openBuyModal(r.token_address, rollupTokenList)
                      }
                    />
                  </td>
                  <td className="px-3 py-2">{r.mention_count_30m}</td>
                  <td className="px-3 py-2">{r.unique_channel_count_30m}</td>
                  <td className="px-3 py-2">{r.smart_wallet_buy_count_1h}</td>
                  <td className="px-3 py-2">{r.top_source ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-gray-400">
                    {r.updated_at}
                  </td>
                  <td className="px-3 py-2">
                    {isSocialTokenAddress(network, r.token_address) ? (
                      <button
                        type="button"
                        className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
                        title="Open Chart & Buy"
                        onClick={() =>
                          openBuyModal(r.token_address, rollupTokenList)
                        }
                      >
                        Buy
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {rollups.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-gray-500">
                    No rollups yet — run social ingest + POST /api/social/rollup
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
        </>
      ) : null}
        </>
      )}

      {modalTokenAddress ? (
        <ChartBuyModal
          tokenAddress={modalTokenAddress}
          onClose={() => setModalTokenAddress(null)}
          onNavigate={(direction) => {
            if (modalIndex === -1 || modalTokenList.length === 0) return;
            const nextIndex =
              direction === "next" ? modalIndex + 1 : modalIndex - 1;
            if (nextIndex >= 0 && nextIndex < modalTokenList.length) {
              setModalTokenAddress(modalTokenList[nextIndex]);
            }
          }}
          hasPrev={modalIndex > 0}
          hasNext={
            modalIndex >= 0 && modalIndex < modalTokenList.length - 1
          }
        />
      ) : null}
    </div>
  );
}
