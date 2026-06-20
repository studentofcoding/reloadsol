"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type {
  TrendingBotStrategy,
  SignalsStrategy,
  DlmmStrategy,
  ExecutionMode,
} from "@/strategies/types";
import { formatAppDateTime } from "@/utils/datetime";

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

type OutcomeRow = {
  id: string;
  strategy_id: string;
  domain: string;
  token_address: string | null;
  entry_at: string | null;
  exit_at: string | null;
  pnl_pct: number | null;
  status: string | null;
  is_simulated: boolean;
};

type ReportBreakdown = {
  strategy_id: string;
  domain: string;
  is_simulated: boolean;
  trade_count: number;
  win_rate: number;
  avg_pnl_pct: number;
};

type AbPair = {
  strategy_id: string;
  domain: string;
  sim: ReportBreakdown | null;
  live: ReportBreakdown | null;
};

const EXECUTION_MODES: ExecutionMode[] = ["sim_only", "live_only", "ab_parallel"];

export default function StrategyAdminHub() {
  const [tab, setTab] = useState<"config" | "reports">("config");
  const [data, setData] = useState<StrategiesResponse | null>(null);
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([]);
  const [reports, setReports] = useState<{
    breakdown: ReportBreakdown[];
    ab_pairs: AbPair[];
    ranking: ReportBreakdown[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const [reportDomain, setReportDomain] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("tab") === "reports") setTab("reports");
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reportParams = new URLSearchParams();
      if (reportFrom) reportParams.set("from", reportFrom);
      if (reportTo) reportParams.set("to", reportTo);
      if (reportDomain) reportParams.set("domain", reportDomain);

      const [strRes, outRes, repRes] = await Promise.all([
        fetch("/api/strategies"),
        fetch("/api/strategies/outcomes?limit=50"),
        fetch(`/api/strategies/reports?${reportParams.toString()}`),
      ]);
      const strJson = await strRes.json();
      const outJson = await outRes.json();
      const repJson = await repRes.json();
      if (!strJson.success) throw new Error(strJson.error || "Failed to load");
      setData(strJson);
      setOutcomes(outJson.outcomes ?? []);
      if (repJson.success) {
        setReports({
          breakdown: repJson.breakdown ?? [],
          ab_pairs: repJson.ab_pairs ?? [],
          ranking: repJson.ranking ?? [],
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [reportFrom, reportTo, reportDomain]);

  useEffect(() => {
    load();
  }, [load]);

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
      setError(e instanceof Error ? e.message : String(e));
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
      setError(e instanceof Error ? e.message : String(e));
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
          onClick={() => setTab("config")}
          className={`px-4 py-2 text-sm rounded-t ${tab === "config" ? "bg-gray-800 text-white" : "text-gray-400"}`}
        >
          Config
        </button>
        <button
          type="button"
          onClick={() => setTab("reports")}
          className={`px-4 py-2 text-sm rounded-t ${tab === "reports" ? "bg-gray-800 text-white" : "text-gray-400"}`}
        >
          Reports (A/B)
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
                  onChange={(e) => setReportFrom(e.target.value)}
                />
              </label>
              <label className="text-gray-400">
                To
                <input
                  type="date"
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                  value={reportTo}
                  onChange={(e) => setReportTo(e.target.value)}
                />
              </label>
              <label className="text-gray-400">
                Domain
                <select
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                  value={reportDomain}
                  onChange={(e) => setReportDomain(e.target.value)}
                >
                  <option value="">All</option>
                  <option value="trending_bot">Trending bot</option>
                  <option value="signals">Signals</option>
                  <option value="dlmm">DLMM</option>
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
                href={`/api/strategies/outcomes?format=csv&limit=5000${reportDomain ? `&domain=${reportDomain}` : ""}`}
                className="self-end px-3 py-1.5 bg-gray-700 rounded text-white text-xs"
              >
                Export CSV
              </a>
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
                  {reports.ab_pairs.map((p) => (
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
              {(reports?.ranking ?? []).slice(0, 10).map((r) => (
                <li key={`${r.domain}-${r.strategy_id}-${r.is_simulated}`}>
                  {r.domain}/{r.strategy_id} [{r.is_simulated ? "SIM" : "LIVE"}]: WR{" "}
                  {(r.win_rate * 100).toFixed(1)}%, avg {r.avg_pnl_pct.toFixed(2)}% ({r.trade_count} trades)
                </li>
              ))}
            </ul>
          </section>

          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">Outcomes (ML feed)</h2>
            {outcomes.length === 0 ? (
              <p className="text-gray-500 text-sm">No closed positions recorded yet.</p>
            ) : (
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
                    </tr>
                  </thead>
                  <tbody>
                    {outcomes.map((o) => (
                      <tr key={o.id} className="border-b border-gray-800 text-gray-300">
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
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
  const [tp1, setTp1] = useState(String(strategy.take_profit_levels.tp1_percentage));
  const [sl, setSl] = useState(String(strategy.stop_loss_percentage));
  const [buySol, setBuySol] = useState(String(strategy.buy_amount_sol));
  const [execMode, setExecMode] = useState<ExecutionMode>("sim_only");
  const [promoteTarget, setPromoteTarget] = useState(promoteTargets[0] ?? "");

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800">
      <div className="flex justify-between items-start mb-3">
        <div>
          <h3 className="font-semibold text-white">{strategy.name}</h3>
          <p className="text-xs text-gray-500">{strategy.id}</p>
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
      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <label className="text-gray-400">
          TP1 %
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={tp1} onChange={(e) => setTp1(e.target.value)} />
        </label>
        <label className="text-gray-400">
          SL %
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={sl} onChange={(e) => setSl(e.target.value)} />
        </label>
        <label className="text-gray-400 col-span-2">
          Buy SOL
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={buySol} onChange={(e) => setBuySol(e.target.value)} />
        </label>
      </div>
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
  const [minGrowth, setMinGrowth] = useState(String(strategy.config.query.minGrowth));
  const [recency, setRecency] = useState(String(strategy.config.query.recencyMinutes));
  const [enterFloor, setEnterFloor] = useState(String(strategy.config.enterScoreFloor));
  const [simBuy, setSimBuy] = useState(String(strategy.config.execution.simBuySol));
  const [maxOpen, setMaxOpen] = useState(String(strategy.config.execution.maxOpenPositions));
  const [execMode, setExecMode] = useState(strategy.execution_mode);

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800">
      <h3 className="font-semibold text-white">{strategy.name}</h3>
      <p className="text-xs text-gray-500 mb-3">{strategy.id} · template {strategy.config.template}</p>
      <label className="text-xs text-gray-400 block mb-2">
        Execution mode
        <ExecutionModeSelect value={execMode} onChange={setExecMode} />
      </label>
      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <label className="text-gray-400">
          minGrowth
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={minGrowth} onChange={(e) => setMinGrowth(e.target.value)} />
        </label>
        <label className="text-gray-400">
          recency (min)
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={recency} onChange={(e) => setRecency(e.target.value)} />
        </label>
        <label className="text-gray-400">
          enter score ≥
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={enterFloor} onChange={(e) => setEnterFloor(e.target.value)} />
        </label>
        <label className="text-gray-400">
          sim buy SOL
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={simBuy} onChange={(e) => setSimBuy(e.target.value)} />
        </label>
        <label className="text-gray-400 col-span-2">
          max open positions
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={maxOpen} onChange={(e) => setMaxOpen(e.target.value)} />
        </label>
      </div>
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
                  minGrowth: parseFloat(minGrowth),
                  recencyMinutes: parseInt(recency, 10),
                },
                execution: {
                  simBuySol: parseFloat(simBuy),
                  maxOpenPositions: parseInt(maxOpen, 10),
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
  const [minTvl, setMinTvl] = useState(String(strategy.config.min_tvl));
  const [tp, setTp] = useState(String(strategy.config.take_profit_pct));
  const [sl, setSl] = useState(String(strategy.config.stop_loss_pct));
  const [oor, setOor] = useState(String(strategy.config.oor_timeout_min));
  const [execMode, setExecMode] = useState(strategy.execution_mode);

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800 max-w-xl">
      <h3 className="font-semibold text-white mb-2">{strategy.name}</h3>
      <label className="text-xs text-gray-400 block mb-2">
        Execution mode
        <ExecutionModeSelect value={execMode} onChange={setExecMode} />
      </label>
      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <label className="text-gray-400">
          min TVL
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={minTvl} onChange={(e) => setMinTvl(e.target.value)} />
        </label>
        <label className="text-gray-400">
          take profit %
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={tp} onChange={(e) => setTp(e.target.value)} />
        </label>
        <label className="text-gray-400">
          stop loss %
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={sl} onChange={(e) => setSl(e.target.value)} />
        </label>
        <label className="text-gray-400">
          OOR timeout (min)
          <input className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white" value={oor} onChange={(e) => setOor(e.target.value)} />
        </label>
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={() =>
          onSave(strategy.id, {
            execution_mode: execMode,
            config: {
              min_tvl: parseFloat(minTvl),
              take_profit_pct: parseFloat(tp),
              stop_loss_pct: parseFloat(sl),
              oor_timeout_min: parseInt(oor, 10),
            },
          })
        }
        className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded"
      >
        Save thresholds
      </button>
    </div>
  );
}
