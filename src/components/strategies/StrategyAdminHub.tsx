"use client";

import React, { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import type {
  TrendingBotStrategy,
  SignalsStrategy,
  DlmmStrategy,
  ExecutionMode,
  TokenFilterConfig,
  StrategyOutcomeRow,
} from "@/strategies/types";
import { formatAppDateTime } from "@/utils/datetime";
import {
  Section,
  FieldGrid,
  NumberField,
  CheckboxField,
  formatFilterSummary,
  parseOptionalFloat,
} from "@/components/strategies/StrategyConfigFields";
import OutcomeReviewModal, {
  OutcomeMlBadge,
} from "@/components/strategies/OutcomeReviewModal";

const OUTCOMES_PAGE_SIZE = 100;

type TabId = "config" | "reports" | "workers";

type StrategiesResponse = {
  success: boolean;
  trending_bot?: {
    effective: Record<string, TrendingBotStrategy>;
    active: string[];
    allocation: Record<string, number>;
  };
  signals?: { effective: Record<string, SignalsStrategy> };
  dlmm?: { effective: DlmmStrategy };
};

type OutcomeRow = StrategyOutcomeRow;

type ReportBreakdown = {
  strategy_id: string;
  domain: string;
  is_simulated: boolean;
  trade_count: number;
  win_rate: number;
  avg_pnl_pct: number;
  last_exit_at?: string | null;
};

type CoverageRow = {
  strategy_id: string;
  domain: string;
  name: string;
  is_active: boolean;
  execution_mode: ExecutionMode;
  sim_trade_count: number;
  live_trade_count: number;
  last_exit_at: string | null;
  avg_pnl_pct: number | null;
};

type AbPair = {
  strategy_id: string;
  domain: string;
  sim: ReportBreakdown | null;
  live: ReportBreakdown | null;
};

type WorkerRow = {
  id: string;
  name: string;
  domain: string;
  schedule: string;
  status: string;
  last_success_at: string;
  next_run_at: string;
  can_trigger: boolean;
  disabled: boolean;
  last_error_msg: string;
};

type WorkersStatusResponse = {
  success: boolean;
  cron_reachable: boolean;
  cron_uptime: string | null;
  workers: WorkerRow[];
  domain_heartbeat: Array<{ domain: string; last_outcome_at: string | null }>;
};

const EXECUTION_MODES: ExecutionMode[] = ["sim_only", "live_only", "ab_parallel"];

function parseTabParam(value: string | null): TabId {
  if (value === "reports" || value === "workers") return value;
  return "config";
}

function buildOutcomesQuery(params: {
  reportFrom: string;
  reportTo: string;
  reportDomain: string;
  reportStrategyId: string;
  reportSimulated: string;
  outcomesOffset: number;
}) {
  const q = new URLSearchParams();
  q.set("limit", String(OUTCOMES_PAGE_SIZE));
  q.set("offset", String(params.outcomesOffset));
  if (params.reportFrom) q.set("from", params.reportFrom);
  if (params.reportTo) q.set("to", params.reportTo);
  if (params.reportDomain) q.set("domain", params.reportDomain);
  if (params.reportStrategyId) q.set("strategyId", params.reportStrategyId);
  if (params.reportSimulated) q.set("is_simulated", params.reportSimulated);
  return q.toString();
}

function buildCsvHref(params: {
  reportFrom: string;
  reportTo: string;
  reportDomain: string;
  reportStrategyId: string;
  reportSimulated: string;
}) {
  const q = new URLSearchParams();
  q.set("format", "csv");
  q.set("limit", "5000");
  if (params.reportFrom) q.set("from", params.reportFrom);
  if (params.reportTo) q.set("to", params.reportTo);
  if (params.reportDomain) q.set("domain", params.reportDomain);
  if (params.reportStrategyId) q.set("strategyId", params.reportStrategyId);
  if (params.reportSimulated) q.set("is_simulated", params.reportSimulated);
  return `/api/strategies/outcomes?${q.toString()}`;
}

export default function StrategyAdminHub() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabId>(() => {
    if (typeof window === "undefined") return "config";
    const params = new URLSearchParams(window.location.search);
    return parseTabParam(params.get("tab"));
  });
  const [saving, setSaving] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const [reportDomain, setReportDomain] = useState("");
  const [reportStrategyId, setReportStrategyId] = useState("");
  const [reportSimulated, setReportSimulated] = useState("");
  const [outcomesOffset, setOutcomesOffset] = useState(0);
  const [selectedOutcomeIndex, setSelectedOutcomeIndex] = useState<number | null>(
    null,
  );
  const [triggeringWorker, setTriggeringWorker] = useState<string | null>(null);
  const [workerMessage, setWorkerMessage] = useState<string | null>(null);

  const strategiesQuery = useQuery({
    queryKey: [
      "strategy-admin",
      reportFrom,
      reportTo,
      reportDomain,
      reportStrategyId,
      reportSimulated,
      outcomesOffset,
    ],
    queryFn: async () => {
      const reportParams = new URLSearchParams();
      if (reportFrom) reportParams.set("from", reportFrom);
      if (reportTo) reportParams.set("to", reportTo);
      if (reportDomain) reportParams.set("domain", reportDomain);
      if (reportStrategyId) reportParams.set("strategy_id", reportStrategyId);
      if (reportSimulated) reportParams.set("is_simulated", reportSimulated);

      const outcomesQuery = buildOutcomesQuery({
        reportFrom,
        reportTo,
        reportDomain,
        reportStrategyId,
        reportSimulated,
        outcomesOffset,
      });

      const [strRes, outRes, repRes] = await Promise.all([
        fetch("/api/strategies"),
        fetch(`/api/strategies/outcomes?${outcomesQuery}`),
        fetch(`/api/strategies/reports?${reportParams.toString()}`),
      ]);
      const strJson = await strRes.json();
      const outJson = await outRes.json();
      const repJson = await repRes.json();
      if (!strJson.success) throw new Error(strJson.error || "Failed to load");
      return {
        data: strJson as StrategiesResponse,
        outcomes: (outJson.outcomes ?? []) as OutcomeRow[],
        outcomesTotal: (outJson.total ?? 0) as number,
        reports: repJson.success
          ? {
              breakdown: repJson.breakdown ?? [],
              coverage: (repJson.coverage ?? []) as CoverageRow[],
              ab_pairs: repJson.ab_pairs ?? [],
              ranking: repJson.ranking ?? [],
            }
          : null,
      };
    },
  });

  const workersQuery = useQuery({
    queryKey: ["workers-status"],
    queryFn: async () => {
      const res = await fetch("/api/workers/status");
      const json = (await res.json()) as WorkersStatusResponse;
      if (!json.success) throw new Error("Failed to load workers");
      return json;
    },
    refetchInterval: tab === "workers" ? 30_000 : false,
    enabled: tab === "workers",
  });

  const data = strategiesQuery.data?.data ?? null;
  const outcomes = strategiesQuery.data?.outcomes ?? [];
  const outcomesTotal = strategiesQuery.data?.outcomesTotal ?? 0;
  const selectedOutcome =
    selectedOutcomeIndex != null ? outcomes[selectedOutcomeIndex] ?? null : null;
  const reports = strategiesQuery.data?.reports ?? null;
  const coverage = reports?.coverage ?? [];
  const loading = strategiesQuery.isLoading;
  const error = actionError ?? (strategiesQuery.error
    ? strategiesQuery.error instanceof Error
      ? strategiesQuery.error.message
      : String(strategiesQuery.error)
    : null);

  const load = useCallback(async () => {
    await strategiesQuery.refetch();
    if (tab === "workers") await workersQuery.refetch();
  }, [strategiesQuery, workersQuery, tab]);

  const switchTab = (next: TabId) => {
    setTab(next);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (next === "config") url.searchParams.delete("tab");
      else url.searchParams.set("tab", next);
      window.history.replaceState({}, "", url.toString());
    }
  };

  const runWorkerNow = async (workerId: string) => {
    setTriggeringWorker(workerId);
    setWorkerMessage(null);
    try {
      const res = await fetch("/api/workers/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workerId }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Trigger failed");
      setWorkerMessage(`${workerId}: triggered`);
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["workers-status"] });
      }, 2000);
    } catch (e) {
      setWorkerMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setTriggeringWorker(null);
    }
  };

  const saveStrategy = async (
    id: string,
    patch: {
      is_active?: boolean;
      execution_mode?: ExecutionMode;
      config?: Record<string, unknown>;
    },
  ) => {
    setSaving(id);
    try {
      const res = await fetch(`/api/strategies/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Save failed");
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const promoteStrategy = async (sourceId: string, targetId: string, confirmLive: boolean) => {
    setSaving(sourceId);
    try {
      const res = await fetch(`/api/strategies/${sourceId}/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_id: targetId, confirm_live: confirmLive }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Promote failed");
      alert(json.message ?? "Promoted");
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  if (loading && !data) {
    return <p className="text-gray-400 text-sm">Loading strategies...</p>;
  }

  if (error) {
    return (
      <div className="text-red-400 text-sm">
        {error}
        <button type="button" onClick={load} className="ml-3 underline text-red-300">
          Retry
        </button>
      </div>
    );
  }

  const effective = data?.trending_bot?.effective ?? {};
  const active = data?.trending_bot?.active ?? [];
  const signals = Object.values(data?.signals?.effective ?? {});
  const dlmm = data?.dlmm?.effective;

  return (
    <div className="space-y-6">
      <div className="flex gap-2 border-b border-gray-700 pb-2">
        <button
          type="button"
          onClick={() => switchTab("config")}
          className={`px-4 py-2 text-sm rounded-t ${tab === "config" ? "bg-gray-800 text-white" : "text-gray-400"}`}
        >
          Config
        </button>
        <button
          type="button"
          onClick={() => switchTab("reports")}
          className={`px-4 py-2 text-sm rounded-t ${tab === "reports" ? "bg-gray-800 text-white" : "text-gray-400"}`}
        >
          Reports (A/B)
        </button>
        <button
          type="button"
          onClick={() => switchTab("workers")}
          className={`px-4 py-2 text-sm rounded-t ${tab === "workers" ? "bg-gray-800 text-white" : "text-gray-400"}`}
        >
          Workers
        </button>
      </div>

      {tab === "config" && (
        <>
          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-2">Trending bot</h2>
            <p className="text-gray-400 text-sm mb-4">
              Active: {active.join(", ") || "none"} · Pre-filter uses union of active bands.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {Object.values(effective).map((s) => (
                <TrendingBotCard
                  key={s.id}
                  strategy={s}
                  isRunning={active.includes(s.id)}
                  allocation={data?.trending_bot?.allocation[s.id]}
                  saving={saving === s.id}
                  onSave={saveStrategy}
                  onPromote={promoteStrategy}
                  promoteTargets={Object.keys(effective).filter((id) => id !== s.id)}
                />
              ))}
            </div>
          </section>

          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">Signals strategies</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {signals.map((s) => (
                <SignalsCard
                  key={s.id}
                  strategy={s}
                  saving={saving === s.id}
                  onSave={saveStrategy}
                />
              ))}
            </div>
            <Link href="/dev/signals" className="text-blue-400 text-sm underline mt-3 inline-block">
              Open Signals hub (manual live buys)
            </Link>
          </section>

          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">DLMM thresholds</h2>
            {dlmm && (
              <DlmmCard
                strategy={dlmm}
                saving={saving === dlmm.id}
                onSave={saveStrategy}
              />
            )}
            <Link href="/dev/dlmm" className="text-blue-400 text-sm underline mt-3 inline-block">
              Open DLMM dashboard (enable / dry-run)
            </Link>
          </section>
        </>
      )}

      {tab === "reports" && (
        <>
          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <div className="flex flex-wrap gap-3 mb-4 text-sm">
              <label className="text-gray-400">
                From
                <input
                  type="date"
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                  value={reportFrom}
                  onChange={(e) => {
                    setReportFrom(e.target.value);
                    setOutcomesOffset(0);
                  }}
                />
              </label>
              <label className="text-gray-400">
                To
                <input
                  type="date"
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                  value={reportTo}
                  onChange={(e) => {
                    setReportTo(e.target.value);
                    setOutcomesOffset(0);
                  }}
                />
              </label>
              <label className="text-gray-400">
                Domain
                <select
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                  value={reportDomain}
                  onChange={(e) => {
                    setReportDomain(e.target.value);
                    setOutcomesOffset(0);
                  }}
                >
                  <option value="">All</option>
                  <option value="trending_bot">Trending bot</option>
                  <option value="signals">Signals</option>
                  <option value="dlmm">DLMM</option>
                </select>
              </label>
              <label className="text-gray-400">
                Strategy
                <select
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white min-w-[160px]"
                  value={reportStrategyId}
                  onChange={(e) => {
                    setReportStrategyId(e.target.value);
                    setOutcomesOffset(0);
                  }}
                >
                  <option value="">All</option>
                  {coverage.map((c) => (
                    <option key={c.strategy_id} value={c.strategy_id}>
                      {c.strategy_id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-gray-400">
                Mode
                <select
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                  value={reportSimulated}
                  onChange={(e) => {
                    setReportSimulated(e.target.value);
                    setOutcomesOffset(0);
                  }}
                >
                  <option value="">All</option>
                  <option value="true">SIM</option>
                  <option value="false">LIVE</option>
                </select>
              </label>
              <button
                type="button"
                onClick={load}
                className="self-end px-3 py-1.5 bg-blue-600 rounded text-white text-xs"
              >
                Refresh
              </button>
              <a
                href={buildCsvHref({
                  reportFrom,
                  reportTo,
                  reportDomain,
                  reportStrategyId,
                  reportSimulated,
                })}
                className="self-end px-3 py-1.5 bg-gray-700 rounded text-white text-xs"
              >
                Export CSV
              </a>
            </div>

            <h3 className="text-lg font-semibold text-white mb-2">Strategy coverage</h3>
            <p className="text-gray-500 text-xs mb-3">
              All registered strategies. Click a row to filter outcomes below.
            </p>
            <div className="overflow-x-auto mb-6">
              <table className="w-full text-sm text-left">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="p-2">Domain</th>
                    <th className="p-2">Strategy</th>
                    <th className="p-2">Active</th>
                    <th className="p-2">Mode</th>
                    <th className="p-2">SIM trades</th>
                    <th className="p-2">Last exit</th>
                    <th className="p-2">Avg PnL (SIM)</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.map((c) => (
                    <tr
                      key={c.strategy_id}
                      className={`border-b border-gray-800 text-gray-300 cursor-pointer hover:bg-gray-800/60 ${
                        reportStrategyId === c.strategy_id ? "bg-gray-800/80" : ""
                      }`}
                      onClick={() => {
                        setReportStrategyId(
                          reportStrategyId === c.strategy_id ? "" : c.strategy_id,
                        );
                        setOutcomesOffset(0);
                      }}
                    >
                      <td className="p-2">{c.domain}</td>
                      <td className="p-2">{c.strategy_id}</td>
                      <td className="p-2">{c.is_active ? "yes" : "no"}</td>
                      <td className="p-2 text-xs">{c.execution_mode}</td>
                      <td className="p-2">{c.sim_trade_count}</td>
                      <td className="p-2">{formatAppDateTime(c.last_exit_at) || "—"}</td>
                      <td className="p-2">
                        {c.avg_pnl_pct != null ? `${c.avg_pnl_pct.toFixed(2)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 className="text-lg font-semibold text-white mb-2">A/B comparison</h3>
            {reports?.ab_pairs?.length ? (
              <table className="w-full text-sm mb-6">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="p-2 text-left">Strategy</th>
                    <th className="p-2">Sim WR</th>
                    <th className="p-2">Sim avg PnL</th>
                    <th className="p-2">Live WR</th>
                    <th className="p-2">Live avg PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.ab_pairs.map((p: AbPair) => (
                    <tr key={p.strategy_id} className="border-b border-gray-800 text-gray-300">
                      <td className="p-2">{p.strategy_id}</td>
                      <td className="p-2 text-center">
                        {p.sim ? `${(p.sim.win_rate * 100).toFixed(1)}% (${p.sim.trade_count})` : "—"}
                      </td>
                      <td className="p-2 text-center">
                        {p.sim ? `${p.sim.avg_pnl_pct.toFixed(2)}%` : "—"}
                      </td>
                      <td className="p-2 text-center">
                        {p.live ? `${(p.live.win_rate * 100).toFixed(1)}% (${p.live.trade_count})` : "—"}
                      </td>
                      <td className="p-2 text-center">
                        {p.live ? `${p.live.avg_pnl_pct.toFixed(2)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-gray-500 text-sm mb-6">No A/B pairs yet (set execution_mode=ab_parallel).</p>
            )}

            <h3 className="text-lg font-semibold text-white mb-2">Ranking (n≥10)</h3>
            <ul className="text-sm text-gray-300 mb-6 space-y-1">
              {(reports?.ranking ?? []).slice(0, 10).map((r: ReportBreakdown) => (
                <li key={`${r.domain}-${r.strategy_id}-${r.is_simulated}`}>
                  {r.domain}/{r.strategy_id} [{r.is_simulated ? "SIM" : "LIVE"}]: WR{" "}
                  {(r.win_rate * 100).toFixed(1)}%, avg {r.avg_pnl_pct.toFixed(2)}% ({r.trade_count} trades)
                </li>
              ))}
            </ul>
          </section>

          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-2">Outcomes (ML feed)</h2>
            <p className="text-gray-500 text-xs mb-4">
              {outcomesTotal > 0
                ? `Showing ${outcomesOffset + 1}–${Math.min(outcomesOffset + OUTCOMES_PAGE_SIZE, outcomesTotal)} of ${outcomesTotal}`
                : reportStrategyId
                  ? "No closed positions for this filter — worker may be idle or no exits yet."
                  : "No closed positions recorded yet."}
              {outcomes.length > 0 && " · Click a row to review and label."}
            </p>
            {outcomes.length === 0 ? (
              <p className="text-gray-500 text-sm">
                {reportStrategyId
                  ? "Try Workers tab to confirm cron is running, or Run now on signals_sim_track."
                  : "No closed positions recorded yet."}
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead>
                      <tr className="text-gray-400 border-b border-gray-700">
                        <th className="p-2">Domain</th>
                        <th className="p-2">Strategy</th>
                        <th className="p-2">Mode</th>
                        <th className="p-2">Token</th>
                        <th className="p-2">Entry</th>
                        <th className="p-2">Exit</th>
                        <th className="p-2">PnL%</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">ML</th>
                      </tr>
                    </thead>
                    <tbody>
                      {outcomes.map((o, idx) => (
                        <tr
                          key={o.id}
                          className="border-b border-gray-800 text-gray-300 cursor-pointer hover:bg-gray-800/50"
                          onClick={() => setSelectedOutcomeIndex(idx)}
                        >
                          <td className="p-2">{o.domain}</td>
                          <td className="p-2">{o.strategy_id}</td>
                          <td className="p-2">{o.is_simulated ? "SIM" : "LIVE"}</td>
                          <td className="p-2 font-mono text-xs">{o.token_address?.slice(0, 8)}…</td>
                          <td className="p-2">{formatAppDateTime(o.entry_at)}</td>
                          <td className="p-2">{formatAppDateTime(o.exit_at)}</td>
                          <td className="p-2">
                            {o.pnl_pct != null ? `${Number(o.pnl_pct).toFixed(2)}%` : "—"}
                          </td>
                          <td className="p-2">{o.status ?? "—"}</td>
                          <td className="p-2">
                            <OutcomeMlBadge features={o.features} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex gap-2 mt-4">
                  <button
                    type="button"
                    disabled={outcomesOffset <= 0}
                    onClick={() => {
                      setOutcomesOffset(Math.max(0, outcomesOffset - OUTCOMES_PAGE_SIZE));
                      setSelectedOutcomeIndex(null);
                    }}
                    className="px-3 py-1.5 bg-gray-700 disabled:opacity-40 text-white text-xs rounded"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={outcomesOffset + OUTCOMES_PAGE_SIZE >= outcomesTotal}
                    onClick={() => {
                      setOutcomesOffset(outcomesOffset + OUTCOMES_PAGE_SIZE);
                      setSelectedOutcomeIndex(null);
                    }}
                    className="px-3 py-1.5 bg-gray-700 disabled:opacity-40 text-white text-xs rounded"
                  >
                    Next
                  </button>
                </div>
              </>
            )}
          </section>
        </>
      )}

      {tab === "workers" && (
        <WorkersTab
          data={workersQuery.data}
          loading={workersQuery.isLoading}
          error={workersQuery.error}
          onRefresh={() => void workersQuery.refetch()}
          triggeringWorker={triggeringWorker}
          workerMessage={workerMessage}
          onRunNow={runWorkerNow}
        />
      )}

      {selectedOutcome && (
        <OutcomeReviewModal
          outcome={selectedOutcome}
          onClose={() => setSelectedOutcomeIndex(null)}
          onSaved={(updated) => {
            queryClient.setQueryData(
              [
                "strategy-admin",
                reportFrom,
                reportTo,
                reportDomain,
                reportStrategyId,
                reportSimulated,
                outcomesOffset,
              ],
              (old: typeof strategiesQuery.data) => {
                if (!old) return old;
                const nextOutcomes = old.outcomes.map((row, i) =>
                  i === selectedOutcomeIndex ? updated : row,
                );
                return { ...old, outcomes: nextOutcomes };
              },
            );
          }}
          onNavigate={(direction) => {
            if (selectedOutcomeIndex == null) return;
            const next =
              direction === "next"
                ? selectedOutcomeIndex + 1
                : selectedOutcomeIndex - 1;
            if (next >= 0 && next < outcomes.length) {
              setSelectedOutcomeIndex(next);
            }
          }}
          hasPrev={selectedOutcomeIndex != null && selectedOutcomeIndex > 0}
          hasNext={
            selectedOutcomeIndex != null &&
            selectedOutcomeIndex < outcomes.length - 1
          }
        />
      )}
    </div>
  );
}

function workerStatusBadge(status: string) {
  const styles: Record<string, string> = {
    ok: "bg-green-900/40 text-green-400",
    stale: "bg-yellow-900/40 text-yellow-400",
    error: "bg-red-900/40 text-red-400",
    never_run: "bg-gray-700 text-gray-400",
    disabled: "bg-gray-800 text-gray-500",
    offline: "bg-red-900/40 text-red-400",
  };
  return styles[status] ?? "bg-gray-700 text-gray-400";
}

function WorkersTab({
  data,
  loading,
  error,
  onRefresh,
  triggeringWorker,
  workerMessage,
  onRunNow,
}: {
  data: WorkersStatusResponse | undefined;
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
  triggeringWorker: string | null;
  workerMessage: string | null;
  onRunNow: (id: string) => void;
}) {
  if (loading && !data) {
    return <p className="text-gray-400 text-sm">Loading workers...</p>;
  }

  if (error) {
    return (
      <p className="text-red-400 text-sm">
        {error instanceof Error ? error.message : String(error)}
      </p>
    );
  }

  const reachable = data?.cron_reachable ?? false;
  const workers = data?.workers ?? [];

  return (
    <div className="space-y-6">
      <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xl font-bold text-white">Cron service</h2>
            <p className="text-sm text-gray-400 mt-1">
              <span
                className={`inline-block px-2 py-0.5 rounded text-xs mr-2 ${
                  reachable ? "bg-green-900/40 text-green-400" : "bg-red-900/40 text-red-400"
                }`}
              >
                {reachable ? "Online" : "Offline"}
              </span>
              {reachable && data?.cron_uptime ? `Uptime: ${data.cron_uptime}` : "Start reloadsol-cron (port 8080)"}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="px-3 py-1.5 bg-blue-600 rounded text-white text-xs"
          >
            Refresh
          </button>
        </div>
        {workerMessage && (
          <p className="text-sm text-amber-300 mb-3">{workerMessage}</p>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="text-gray-400 border-b border-gray-700">
                <th className="p-2">Worker</th>
                <th className="p-2">Domain</th>
                <th className="p-2">Schedule</th>
                <th className="p-2">Last success</th>
                <th className="p-2">Next run</th>
                <th className="p-2">Status</th>
                <th className="p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {workers.length === 0 && !reachable && (
                <tr>
                  <td colSpan={7} className="p-4 text-gray-500">
                    Cron unreachable — worker list unavailable. See docs/algo_overview.md.
                  </td>
                </tr>
              )}
              {workers.map((w) => (
                <tr key={w.id} className="border-b border-gray-800 text-gray-300">
                  <td className="p-2">
                    <div className="font-medium text-white">{w.name}</div>
                    <div className="text-xs text-gray-500">{w.id}</div>
                  </td>
                  <td className="p-2">{w.domain}</td>
                  <td className="p-2 text-xs">{w.schedule}</td>
                  <td className="p-2">{formatAppDateTime(w.last_success_at) || "—"}</td>
                  <td className="p-2">{formatAppDateTime(w.next_run_at) || "—"}</td>
                  <td className="p-2">
                    <span className={`text-xs px-2 py-0.5 rounded ${workerStatusBadge(w.status)}`}>
                      {w.status}
                    </span>
                    {w.last_error_msg ? (
                      <div className="text-xs text-red-400 mt-1 max-w-xs truncate" title={w.last_error_msg}>
                        {w.last_error_msg}
                      </div>
                    ) : null}
                  </td>
                  <td className="p-2">
                    {w.can_trigger ? (
                      <button
                        type="button"
                        disabled={!reachable || w.disabled || triggeringWorker === w.id}
                        onClick={() => onRunNow(w.id)}
                        className="px-2 py-1 bg-amber-700 hover:bg-amber-600 disabled:opacity-40 text-white text-xs rounded"
                      >
                        {triggeringWorker === w.id ? "Running…" : "Run now"}
                      </button>
                    ) : (
                      <span className="text-xs text-gray-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-white mb-3">Domain heartbeat</h3>
        <p className="text-gray-500 text-xs mb-3">
          Last closed outcome in Supabase per domain (cross-check vs worker status).
        </p>
        <ul className="text-sm text-gray-300 space-y-1">
          {(data?.domain_heartbeat ?? []).map((h) => (
            <li key={h.domain}>
              <span className="text-gray-400">{h.domain}:</span>{" "}
              {formatAppDateTime(h.last_outcome_at) || "no outcomes yet"}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ExecutionModeSelect({
  value,
  onChange,
}: {
  value: ExecutionMode;
  onChange: (m: ExecutionMode) => void;
}) {
  return (
    <select
      className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs"
      value={value}
      onChange={(e) => onChange(e.target.value as ExecutionMode)}
    >
      {EXECUTION_MODES.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}

function TrendingBotCard({
  strategy,
  isRunning,
  allocation,
  saving,
  onSave,
  onPromote,
  promoteTargets,
}: {
  strategy: TrendingBotStrategy;
  isRunning: boolean;
  allocation?: number;
  saving: boolean;
  onSave: (id: string, patch: Record<string, unknown>) => void;
  onPromote: (source: string, target: string, confirm: boolean) => void;
  promoteTargets: string[];
}) {
  const f = strategy.filtering ?? { enabled: true };
  const [tp1, setTp1] = useState(String(strategy.take_profit_levels.tp1_percentage));
  const [sl, setSl] = useState(String(strategy.stop_loss_percentage));
  const [buySol, setBuySol] = useState(String(strategy.buy_amount_sol));
  const [execMode, setExecMode] = useState<ExecutionMode>("sim_only");
  const [promoteTarget, setPromoteTarget] = useState(promoteTargets[0] ?? "");
  const [filterEnabled, setFilterEnabled] = useState(f.enabled ?? true);
  const [mcapMin, setMcapMin] = useState(f.mcap?.min != null ? String(f.mcap.min) : "");
  const [mcapMax, setMcapMax] = useState(f.mcap?.max != null ? String(f.mcap.max) : "");
  const [pc5mMin, setPc5mMin] = useState(
    f.priceChange5m?.min != null ? String(f.priceChange5m.min) : "",
  );
  const [pc5mMax, setPc5mMax] = useState(
    f.priceChange5m?.max != null ? String(f.priceChange5m.max) : "",
  );
  const [pc1hMin, setPc1hMin] = useState(
    f.priceChange1h?.min != null ? String(f.priceChange1h.min) : "",
  );
  const [pc1hMax, setPc1hMax] = useState(
    f.priceChange1h?.max != null ? String(f.priceChange1h.max) : "",
  );
  const [pc6hMin, setPc6hMin] = useState(
    f.priceChange6h?.min != null ? String(f.priceChange6h.min) : "",
  );
  const [pc6hMax, setPc6hMax] = useState(
    f.priceChange6h?.max != null ? String(f.priceChange6h.max) : "",
  );
  const [organicMin, setOrganicMin] = useState(
    f.organicScore?.min != null ? String(f.organicScore.min) : "",
  );
  const [holdersMax, setHoldersMax] = useState(
    f.topHoldersPercentage?.max != null ? String(f.topHoldersPercentage.max) : "",
  );
  const [requireCompleteData, setRequireCompleteData] = useState(f.requireCompleteData ?? true);
  const [checkManualHistory, setCheckManualHistory] = useState(
    f.checkManualTradingHistory ?? true,
  );

  const buildFiltering = (): TokenFilterConfig => ({
    enabled: filterEnabled,
    mcap: { min: parseOptionalFloat(mcapMin), max: parseOptionalFloat(mcapMax) },
    priceChange5m: { min: parseOptionalFloat(pc5mMin), max: parseOptionalFloat(pc5mMax) },
    priceChange1h: { min: parseOptionalFloat(pc1hMin), max: parseOptionalFloat(pc1hMax) },
    priceChange6h: { min: parseOptionalFloat(pc6hMin), max: parseOptionalFloat(pc6hMax) },
    organicScore: { min: parseOptionalFloat(organicMin) },
    topHoldersPercentage: { max: parseOptionalFloat(holdersMax) },
    requireCompleteData,
    checkManualTradingHistory: checkManualHistory,
  });

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800">
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="font-semibold text-white">{strategy.name}</h3>
          <p className="text-xs text-gray-500">{strategy.id}</p>
          <p className="text-xs text-gray-500 mt-1">{formatFilterSummary(strategy.filtering)}</p>
        </div>
        <span
          className={`text-xs px-2 py-1 rounded ${isRunning ? "bg-green-900/40 text-green-400" : "bg-gray-700 text-gray-400"}`}
        >
          {isRunning ? "ACTIVE" : "inactive"}
        </span>
      </div>
      {allocation != null && (
        <p className="text-xs text-gray-500 mb-2">Allocation: {(allocation * 100).toFixed(0)}%</p>
      )}
      <label className="text-xs text-gray-400 block mb-2">
        Execution mode
        <ExecutionModeSelect value={execMode} onChange={setExecMode} />
      </label>
      <Section title="Execution">
        <FieldGrid>
          <NumberField label="TP1 %" value={tp1} onChange={setTp1} />
          <NumberField label="SL %" value={sl} onChange={setSl} />
          <NumberField label="Buy SOL" value={buySol} onChange={setBuySol} colSpan={2} step="0.001" />
        </FieldGrid>
      </Section>
      <Section title="Filtering">
        <FieldGrid>
          <CheckboxField
            label="Filtering enabled"
            checked={filterEnabled}
            onChange={setFilterEnabled}
            colSpan={2}
          />
          <NumberField label="MCap min" value={mcapMin} onChange={setMcapMin} />
          <NumberField label="MCap max" value={mcapMax} onChange={setMcapMax} />
          <NumberField label="5m change min %" value={pc5mMin} onChange={setPc5mMin} />
          <NumberField label="5m change max %" value={pc5mMax} onChange={setPc5mMax} />
          <NumberField label="1h change min %" value={pc1hMin} onChange={setPc1hMin} />
          <NumberField label="1h change max %" value={pc1hMax} onChange={setPc1hMax} />
          <NumberField label="6h change min %" value={pc6hMin} onChange={setPc6hMin} />
          <NumberField label="6h change max %" value={pc6hMax} onChange={setPc6hMax} />
          <NumberField label="Organic score min" value={organicMin} onChange={setOrganicMin} />
          <NumberField label="Top holders max %" value={holdersMax} onChange={setHoldersMax} />
          <CheckboxField
            label="Require complete data"
            checked={requireCompleteData}
            onChange={setRequireCompleteData}
            colSpan={2}
          />
          <CheckboxField
            label="Check manual trading history"
            checked={checkManualHistory}
            onChange={setCheckManualHistory}
            colSpan={2}
          />
        </FieldGrid>
      </Section>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            onSave(strategy.id, {
              execution_mode: execMode,
              config: {
                take_profit_levels: { tp1_percentage: parseFloat(tp1) },
                stop_loss_percentage: parseFloat(sl),
                buy_amount_sol: parseFloat(buySol),
                filtering: buildFiltering(),
              },
            })
          }
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs rounded"
        >
          Save
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(strategy.id, { is_active: !strategy.is_active })}
          className="px-3 py-1.5 bg-gray-700 text-white text-xs rounded"
        >
          {strategy.is_active ? "Deactivate" : "Activate"}
        </button>
        {promoteTargets.length > 0 && (
          <>
            <select
              className="bg-gray-900 border border-gray-600 rounded px-2 text-xs text-white"
              value={promoteTarget}
              onChange={(e) => setPromoteTarget(e.target.value)}
            >
              {promoteTargets.map((t) => (
                <option key={t} value={t}>
                  Promote → {t}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={saving || !promoteTarget}
              onClick={() => onPromote(strategy.id, promoteTarget, false)}
              className="px-3 py-1.5 bg-amber-700 text-white text-xs rounded"
            >
              Promote config
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SignalsCard({
  strategy,
  saving,
  onSave,
}: {
  strategy: SignalsStrategy;
  saving: boolean;
  onSave: (id: string, patch: Record<string, unknown>) => void;
}) {
  const q = strategy.config.query;
  const s = strategy.config.scoring;
  const e = strategy.config.execution;
  const [minGrowth, setMinGrowth] = useState(String(q.minGrowth));
  const [recency, setRecency] = useState(String(q.recencyMinutes));
  const [limit, setLimit] = useState(String(q.limit));
  const [maxAge, setMaxAge] = useState(String(q.maxAgeMinutes));
  const [includeStuck, setIncludeStuck] = useState(q.includeStuck);
  const [enterFloor, setEnterFloor] = useState(String(strategy.config.enterScoreFloor));
  const [simBuy, setSimBuy] = useState(String(e.simBuySol));
  const [maxOpen, setMaxOpen] = useState(String(e.maxOpenPositions));
  const [execMode, setExecMode] = useState(strategy.execution_mode);
  const [showAllScoring, setShowAllScoring] = useState(false);
  const [recencyBoostMax, setRecencyBoostMax] = useState(String(s.recencyBoostMax));
  const [milestone80, setMilestone80] = useState(String(s.milestone80));
  const [milestone120, setMilestone120] = useState(String(s.milestone120));
  const [milestone200, setMilestone200] = useState(String(s.milestone200));
  const [speedFast, setSpeedFast] = useState(String(s.speedTo80Fast));
  const [speedMedium, setSpeedMedium] = useState(String(s.speedTo80Medium));
  const [speedSlow, setSpeedSlow] = useState(String(s.speedTo80Slow));
  const [inTrackingRange, setInTrackingRange] = useState(String(s.inTrackingRange));
  const [stuckPenalty, setStuckPenalty] = useState(String(s.stuckPenalty));
  const [stopLossPenalty, setStopLossPenalty] = useState(String(s.stopLossPenalty));
  const [sellOver100LatePenalty, setSellOver100LatePenalty] = useState(
    String(s.sellOver100LatePenalty),
  );

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800">
      <h3 className="font-semibold text-white">{strategy.name}</h3>
      <p className="text-xs text-gray-500 mb-3">{strategy.id} · template {strategy.config.template}</p>
      <label className="text-xs text-gray-400 block mb-2">
        Execution mode
        <ExecutionModeSelect value={execMode} onChange={setExecMode} />
      </label>
      <Section title="Query">
        <FieldGrid>
          <NumberField label="limit" value={limit} onChange={setLimit} step="1" />
          <NumberField label="recency (min)" value={recency} onChange={setRecency} step="1" />
          <NumberField label="minGrowth" value={minGrowth} onChange={setMinGrowth} />
          <NumberField label="maxAge (min)" value={maxAge} onChange={setMaxAge} step="1" />
          <CheckboxField
            label="includeStuck"
            checked={includeStuck}
            onChange={setIncludeStuck}
            colSpan={2}
          />
        </FieldGrid>
      </Section>
      <Section title="Entry">
        <FieldGrid>
          <NumberField label="enter score ≥" value={enterFloor} onChange={setEnterFloor} colSpan={2} />
        </FieldGrid>
      </Section>
      <Section title="Execution">
        <FieldGrid>
          <NumberField label="sim buy SOL" value={simBuy} onChange={setSimBuy} step="0.001" />
          <NumberField label="max open positions" value={maxOpen} onChange={setMaxOpen} step="1" />
        </FieldGrid>
      </Section>
      <Section title="Scoring">
        <FieldGrid>
          <NumberField label="milestone80" value={milestone80} onChange={setMilestone80} step="1" />
          <NumberField label="milestone120" value={milestone120} onChange={setMilestone120} step="1" />
          <NumberField label="milestone200" value={milestone200} onChange={setMilestone200} step="1" />
          <NumberField label="stuckPenalty" value={stuckPenalty} onChange={setStuckPenalty} step="1" />
          <NumberField label="stopLossPenalty" value={stopLossPenalty} onChange={setStopLossPenalty} step="1" />
          <NumberField
            label="sellOver100LatePenalty"
            value={sellOver100LatePenalty}
            onChange={setSellOver100LatePenalty}
            step="1"
          />
        </FieldGrid>
        <button
          type="button"
          className="text-xs text-blue-400 underline mt-1"
          onClick={() => setShowAllScoring((v) => !v)}
        >
          {showAllScoring ? "Hide all scoring weights" : "Show all scoring weights"}
        </button>
        {showAllScoring && (
          <FieldGrid>
            <NumberField
              label="recencyBoostMax"
              value={recencyBoostMax}
              onChange={setRecencyBoostMax}
              step="1"
            />
            <NumberField label="speedTo80Fast" value={speedFast} onChange={setSpeedFast} step="1" />
            <NumberField
              label="speedTo80Medium"
              value={speedMedium}
              onChange={setSpeedMedium}
              step="1"
            />
            <NumberField label="speedTo80Slow" value={speedSlow} onChange={setSpeedSlow} step="1" />
            <NumberField
              label="inTrackingRange"
              value={inTrackingRange}
              onChange={setInTrackingRange}
              step="1"
            />
          </FieldGrid>
        )}
      </Section>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            onSave(strategy.id, {
              execution_mode: execMode,
              config: {
                enterScoreFloor: parseFloat(enterFloor),
                query: {
                  limit: parseInt(limit, 10),
                  recencyMinutes: parseInt(recency, 10),
                  minGrowth: parseFloat(minGrowth),
                  maxAgeMinutes: parseInt(maxAge, 10),
                  includeStuck,
                },
                execution: {
                  simBuySol: parseFloat(simBuy),
                  maxOpenPositions: parseInt(maxOpen, 10),
                },
                scoring: {
                  recencyBoostMax: parseFloat(recencyBoostMax),
                  milestone80: parseFloat(milestone80),
                  milestone120: parseFloat(milestone120),
                  milestone200: parseFloat(milestone200),
                  speedTo80Fast: parseFloat(speedFast),
                  speedTo80Medium: parseFloat(speedMedium),
                  speedTo80Slow: parseFloat(speedSlow),
                  inTrackingRange: parseFloat(inTrackingRange),
                  stuckPenalty: parseFloat(stuckPenalty),
                  stopLossPenalty: parseFloat(stopLossPenalty),
                  sellOver100LatePenalty: parseFloat(sellOver100LatePenalty),
                },
              },
            })
          }
          className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded"
        >
          Save
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(strategy.id, { is_active: !strategy.is_active })}
          className="px-3 py-1.5 bg-gray-700 text-white text-xs rounded"
        >
          {strategy.is_active ? "Deactivate" : "Activate"}
        </button>
      </div>
    </div>
  );
}

function DlmmCard({
  strategy,
  saving,
  onSave,
}: {
  strategy: DlmmStrategy;
  saving: boolean;
  onSave: (id: string, patch: Record<string, unknown>) => void;
}) {
  const c = strategy.config;
  const [minTvl, setMinTvl] = useState(String(c.min_tvl));
  const [minFeeTvl, setMinFeeTvl] = useState(String(c.min_fee_tvl));
  const [minOrganic, setMinOrganic] = useState(String(c.min_organic_score));
  const [minHolders, setMinHolders] = useState(String(c.min_holders));
  const [tp, setTp] = useState(String(c.take_profit_pct));
  const [sl, setSl] = useState(String(c.stop_loss_pct));
  const [oor, setOor] = useState(String(c.oor_timeout_min));
  const [maxSolPos, setMaxSolPos] = useState(String(c.max_sol_per_position));
  const [maxSolRisk, setMaxSolRisk] = useState(String(c.max_sol_at_risk));
  const [binRange, setBinRange] = useState(String(c.bin_range_interval));
  const [execMode, setExecMode] = useState(strategy.execution_mode);

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800 max-w-xl">
      <h3 className="font-semibold text-white mb-2">{strategy.name}</h3>
      <label className="text-xs text-gray-400 block mb-2">
        Execution mode
        <ExecutionModeSelect value={execMode} onChange={setExecMode} />
      </label>
      <Section title="Screener">
        <FieldGrid>
          <NumberField label="min TVL" value={minTvl} onChange={setMinTvl} step="1" />
          <NumberField label="min fee/TVL" value={minFeeTvl} onChange={setMinFeeTvl} />
          <NumberField label="min organic score" value={minOrganic} onChange={setMinOrganic} step="1" />
          <NumberField label="min holders" value={minHolders} onChange={setMinHolders} step="1" />
        </FieldGrid>
      </Section>
      <Section title="Risk">
        <FieldGrid>
          <NumberField label="take profit %" value={tp} onChange={setTp} />
          <NumberField label="stop loss %" value={sl} onChange={setSl} />
          <NumberField label="OOR timeout (min)" value={oor} onChange={setOor} step="1" colSpan={2} />
        </FieldGrid>
      </Section>
      <Section title="Capital">
        <FieldGrid>
          <NumberField label="max SOL / position" value={maxSolPos} onChange={setMaxSolPos} step="0.1" />
          <NumberField label="max SOL at risk" value={maxSolRisk} onChange={setMaxSolRisk} step="0.1" />
          <NumberField label="bin range interval" value={binRange} onChange={setBinRange} step="1" colSpan={2} />
        </FieldGrid>
      </Section>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            onSave(strategy.id, {
              execution_mode: execMode,
              config: {
                min_tvl: parseFloat(minTvl),
                min_fee_tvl: parseFloat(minFeeTvl),
                min_organic_score: parseFloat(minOrganic),
                min_holders: parseInt(minHolders, 10),
                take_profit_pct: parseFloat(tp),
                stop_loss_pct: parseFloat(sl),
                oor_timeout_min: parseInt(oor, 10),
                max_sol_per_position: parseFloat(maxSolPos),
                max_sol_at_risk: parseFloat(maxSolRisk),
                bin_range_interval: parseInt(binRange, 10),
              },
            })
          }
          className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded"
        >
          Save thresholds
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(strategy.id, { is_active: !strategy.is_active })}
          className="px-3 py-1.5 bg-gray-700 text-white text-xs rounded"
        >
          {strategy.is_active ? "Deactivate" : "Activate"}
        </button>
      </div>
    </div>
  );
}
