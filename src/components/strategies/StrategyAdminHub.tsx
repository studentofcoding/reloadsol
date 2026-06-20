"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { TrendingBotStrategy } from "@/strategies/types";
import { formatAppDateTime } from "@/utils/datetime";

type StrategiesResponse = {
  success: boolean;
  trending_bot?: {
    effective: Record<string, TrendingBotStrategy>;
    active: string[];
    allocation: Record<string, number>;
    status: { is_active: string[]; is_inactive: string[] };
  };
  signals?: { templates: { id: string; name: string; description: string }[] };
  dlmm?: { config: Record<string, unknown>; note: string };
};

type OutcomeRow = {
  id: string;
  strategy_id: string;
  token_address: string | null;
  entry_at: string | null;
  exit_at: string | null;
  pnl_pct: number | null;
  status: string | null;
};

export default function StrategyAdminHub() {
  const [data, setData] = useState<StrategiesResponse | null>(null);
  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [strRes, outRes] = await Promise.all([
        fetch("/api/strategies"),
        fetch("/api/strategies/outcomes?limit=30"),
      ]);
      const strJson = await strRes.json();
      const outJson = await outRes.json();
      if (!strJson.success) throw new Error(strJson.error || "Failed to load");
      setData(strJson);
      setOutcomes(outJson.outcomes ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveStrategy = async (
    id: string,
    patch: {
      is_active?: boolean;
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

  if (loading) {
    return <p className="text-gray-400 text-sm">Loading strategies...</p>;
  }

  if (error) {
    return (
      <div className="text-red-400 text-sm">
        {error}
        <button
          type="button"
          onClick={load}
          className="ml-3 underline text-red-300"
        >
          Retry
        </button>
      </div>
    );
  }

  const effective = data?.trending_bot?.effective ?? {};
  const active = data?.trending_bot?.active ?? [];

  return (
    <div className="space-y-8">
      <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
        <h2 className="text-xl font-bold text-white mb-2">Trending bot</h2>
        <p className="text-gray-400 text-sm mb-4">
          Active: {active.join(", ") || "none"} · Pre-filter uses union of all
          active strategy bands.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {Object.values(effective).map((s) => (
            <StrategyCard
              key={s.id}
              strategy={s}
              isRunning={active.includes(s.id)}
              allocation={data?.trending_bot?.allocation[s.id]}
              saving={saving === s.id}
              onSave={saveStrategy}
            />
          ))}
        </div>
      </section>

      <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
        <h2 className="text-xl font-bold text-white mb-4">Signals templates</h2>
        <p className="text-gray-500 text-sm mb-3">Read-only in v1</p>
        <ul className="space-y-2 text-sm">
          {data?.signals?.templates.map((t) => (
            <li key={t.id} className="text-gray-300">
              <span className="font-semibold text-white">{t.name}</span> ({t.id}
              ) — {t.description}
            </li>
          ))}
        </ul>
        <Link href="/dev/signals" className="text-blue-400 text-sm underline mt-3 inline-block">
          Open Signals hub
        </Link>
      </section>

      <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
        <h2 className="text-xl font-bold text-white mb-4">DLMM agent</h2>
        <p className="text-gray-500 text-sm mb-3">{data?.dlmm?.note}</p>
        {data?.dlmm?.config && (
          <pre className="text-xs text-gray-400 overflow-x-auto bg-gray-800 p-3 rounded">
            {JSON.stringify(data.dlmm.config, null, 2)}
          </pre>
        )}
        <Link href="/dev/dlmm" className="text-blue-400 text-sm underline mt-3 inline-block">
          Open DLMM dashboard
        </Link>
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
                  <th className="p-2">Strategy</th>
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
                    <td className="p-2">{o.strategy_id}</td>
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
    </div>
  );
}

function StrategyCard({
  strategy,
  isRunning,
  allocation,
  saving,
  onSave,
}: {
  strategy: TrendingBotStrategy;
  isRunning: boolean;
  allocation?: number;
  saving: boolean;
  onSave: (id: string, patch: { is_active?: boolean; config?: Record<string, unknown> }) => void;
}) {
  const [tp1, setTp1] = useState(String(strategy.take_profit_levels.tp1_percentage));
  const [sl, setSl] = useState(String(strategy.stop_loss_percentage));
  const [buySol, setBuySol] = useState(String(strategy.buy_amount_sol));
  const [mcapMin, setMcapMin] = useState(String(strategy.filtering?.mcap?.min ?? ""));
  const [mcapMax, setMcapMax] = useState(String(strategy.filtering?.mcap?.max ?? ""));

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
      <p className="text-xs text-gray-400 mb-3">{strategy.description}</p>
      {allocation != null && (
        <p className="text-xs text-gray-500 mb-2">
          Allocation: {(allocation * 100).toFixed(0)}%
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 text-xs mb-3">
        <label className="text-gray-400">
          TP1 %
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={tp1}
            onChange={(e) => setTp1(e.target.value)}
          />
        </label>
        <label className="text-gray-400">
          SL %
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={sl}
            onChange={(e) => setSl(e.target.value)}
          />
        </label>
        <label className="text-gray-400">
          Buy SOL
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={buySol}
            onChange={(e) => setBuySol(e.target.value)}
          />
        </label>
        <label className="text-gray-400">
          Mcap min
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={mcapMin}
            onChange={(e) => setMcapMin(e.target.value)}
          />
        </label>
        <label className="text-gray-400 col-span-2">
          Mcap max
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={mcapMax}
            onChange={(e) => setMcapMax(e.target.value)}
          />
        </label>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            onSave(strategy.id, {
              config: {
                take_profit_levels: { tp1_percentage: parseFloat(tp1) },
                stop_loss_percentage: parseFloat(sl),
                buy_amount_sol: parseFloat(buySol),
                filtering: {
                  mcap: {
                    min: mcapMin ? parseFloat(mcapMin) : undefined,
                    max: mcapMax ? parseFloat(mcapMax) : undefined,
                  },
                },
              },
            })
          }
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs rounded"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave(strategy.id, { is_active: !strategy.is_active })}
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-xs rounded"
        >
          {strategy.is_active ? "Deactivate" : "Activate"}
        </button>
      </div>
    </div>
  );
}
