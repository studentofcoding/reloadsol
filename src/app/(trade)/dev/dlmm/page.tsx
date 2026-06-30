"use client";

import React, { useMemo, useState } from "react";
import {
  useDlmmCandidates,
  useDlmmPools,
  type EnrichedPool,
} from "@/hooks/useDlmmPools";
import {
  useDeployPosition,
  useDlmmConfig,
  useDlmmPositions,
  useEditPosition,
  useRemovePosition,
  useUpdateDlmmConfig,
} from "@/hooks/useDlmmPositions";
import type { DlmmPosition, DlmmLesson } from "@/types/dlmm";
import HunterCandidateTabs, {
  type DisplayCandidate,
} from "@/components/dlmm/HunterCandidateTabs";
import { formatAppTime } from "@/utils/datetime";

function formatUsd(n: number) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function formatPct(n: number) {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

export default function DlmmDashboardPage() {
  const { data: poolsData, isLoading: poolsLoading, isError: poolsError, error: poolsErrorMsg } = useDlmmPools(40);
  const { data: candidatesData } = useDlmmCandidates(25);
  const { data: positionsData, isLoading: posLoading } = useDlmmPositions();
  const { data: configData, isLoading: configLoading, isError: configError, error: configErrorMsg } = useDlmmConfig();
  const deploy = useDeployPosition();
  const edit = useEditPosition();
  const remove = useRemovePosition();
  const updateConfig = useUpdateDlmmConfig();

  const [deployPool, setDeployPool] = useState<EnrichedPool | null>(null);
  const [deployAmount, setDeployAmount] = useState("0.5");
  const [editPosition, setEditPosition] = useState<DlmmPosition | null>(null);
  const [editTp, setEditTp] = useState("");
  const [editSl, setEditSl] = useState("");
  const [editOor, setEditOor] = useState("");

  const config = configData?.config;
  const dbStatus = configData?.dbStatus ?? positionsData?.dbStatus;
  const dbReady = dbStatus?.reachable && dbStatus?.schemaReady;
  const positions = useMemo(
    () => positionsData?.positions ?? [],
    [positionsData?.positions],
  );
  const lessons = positionsData?.lessons ?? [];
  const candidates = useMemo(
    () => candidatesData?.candidates ?? [],
    [candidatesData?.candidates],
  );
  const pools = useMemo(() => poolsData?.pools ?? [], [poolsData?.pools]);

  const openPositions = useMemo(
    () => positions.filter((p) => p.status !== "closed"),
    [positions],
  );

  const generalCandidates: DisplayCandidate[] = useMemo(() => {
    if (candidates.length > 0) {
      return candidates.map((c) => {
        const pool = pools.find((p) => p.address === c.pool_address);
        return {
          ...c,
          token_x_address: pool?.token_x.address,
          token_y_address: pool?.token_y.address,
        };
      });
    }
    return pools.slice(0, 15).map((p) => ({
      pool_address: p.address,
      pool_name: p.name,
      token_x_symbol: p.token_x.symbol,
      token_y_symbol: p.token_y.symbol,
      token_x_address: p.token_x.address,
      token_y_address: p.token_y.address,
      tvl: p.tvl,
      fee_tvl_ratio_24h: p.fee_tvl_ratio_24h,
      organic_score: p.organic_score,
      holders: Math.max(p.token_x.holders ?? 0, p.token_y.holders ?? 0),
      mcap: 0,
      score: p.organic_score,
      screened_at: '',
    }));
  }, [candidates, pools]);

  const handleDeploy = async () => {
    if (!deployPool) return;
    await deploy.mutateAsync({
      poolAddress: deployPool.address,
      amountSol: parseFloat(deployAmount),
    });
    setDeployPool(null);
  };

  const handleEditSave = async () => {
    if (!editPosition) return;
    await edit.mutateAsync({
      id: editPosition.id,
      takeProfitPct: editTp ? parseFloat(editTp) : undefined,
      stopLossPct: editSl ? parseFloat(editSl) : undefined,
      oorTimeoutMin: editOor ? parseInt(editOor, 10) : undefined,
    });
    setEditPosition(null);
  };

  return (
    <main className="min-h-screen bg-black py-8">
        <div className="container mx-auto px-4 max-w-7xl space-y-8">
          <header className="text-center">
            <h1 className="text-4xl font-bold text-white mb-2">
              DLMM Agent Dashboard
            </h1>
            <p className="text-gray-400">
              Meteora DLMM Hunter + Healer — screen, deploy, monitor, manage
            </p>
          </header>

          {!dbReady && (
            <section className="bg-red-950/40 border border-red-700 rounded-lg p-4 text-sm text-red-200">
              <p className="font-semibold text-red-300 mb-2">Database not ready</p>
              <p className="mb-2">
                {dbStatus?.error ??
                  "Supabase is not configured. Pool screening still works; positions and config require a database."}
              </p>
              <ol className="list-decimal list-inside space-y-1 text-red-200/90">
                <li>Set <code className="text-red-100">SUPABASE_URL</code> and{" "}
                  <code className="text-red-100">SUPABASE_SECRET_KEY</code> in{" "}
                  <code className="text-red-100">.env</code>
                </li>
                <li>Ensure Postgres is running (<code className="text-red-100">docker compose up reloadsol-db reloadsol-bouncer</code>) and schema applied (<code className="text-red-100">db/init/</code>)</li>
                <li>Restart Docker: <code className="text-red-100">npm run docker:down && npm run docker:up</code></li>
              </ol>
              <p className="mt-2 text-red-300/80">
                Health: <a href="/api/dlmm/health" className="underline" target="_blank" rel="noreferrer">/api/dlmm/health</a>
                {dbStatus?.host ? ` · host: ${dbStatus.host}` : null}
              </p>
            </section>
          )}

          {configData?.usingEnvFallback && dbReady && (
            <section className="bg-yellow-950/30 border border-yellow-700 rounded-lg p-3 text-sm text-yellow-200">
              Using environment defaults — connect Supabase to persist agent config and positions.
            </section>
          )}

          {/* Agent config */}
          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">Agent Config</h2>
            {configLoading && (
              <p className="text-gray-400 text-sm">Loading config...</p>
            )}
            {configError && (
              <p className="text-red-400 text-sm mb-2">
                {configErrorMsg instanceof Error ? configErrorMsg.message : "Config unavailable"}
              </p>
            )}
            {config && (
              <div className="flex flex-wrap gap-4 items-center">
                <span
                  className={`px-3 py-1 rounded text-sm font-semibold ${
                    config.enabled
                      ? "bg-green-900/40 text-green-400"
                      : "bg-gray-800 text-gray-400"
                  }`}
                >
                  {config.enabled ? "RUNNING" : "PAUSED"}
                </span>
                <span
                  className={`px-3 py-1 rounded text-sm font-semibold ${
                    config.dry_run
                      ? "bg-yellow-900/40 text-yellow-400"
                      : "bg-red-900/40 text-red-400"
                  }`}
                >
                  {config.dry_run ? "DRY RUN" : "LIVE"}
                </span>
                <button
                  onClick={() =>
                    updateConfig.mutate({ enabled: !config.enabled })
                  }
                  disabled={!dbReady || updateConfig.isPending}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded text-sm"
                >
                  {config.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  onClick={() =>
                    updateConfig.mutate({ dry_run: !config.dry_run })
                  }
                  disabled={!dbReady || updateConfig.isPending}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded text-sm"
                >
                  Toggle dry-run
                </button>
                <span className="text-gray-400 text-sm">
                  Open: {openPositions.length} | Cap: {config.max_sol_at_risk}{" "}
                  SOL
                </span>
              </div>
            )}
          </section>

          {/* Live decision feed */}
          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">Live Decisions</h2>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {lessons.length === 0 && (
                <p className="text-gray-500 text-sm">No decisions yet.</p>
              )}
              {lessons.map((lesson: DlmmLesson) => (
                <div
                  key={lesson.id}
                  className="bg-gray-800 rounded p-3 text-sm border border-gray-700"
                >
                  <div className="flex justify-between text-white">
                    <span className="font-semibold">{lesson.decision}</span>
                    <span className="text-gray-500">
                      {formatAppTime(lesson.created_at)}
                    </span>
                  </div>
                  <div className="text-gray-400">{lesson.reason}</div>
                </div>
              ))}
            </div>
          </section>

          {/* Hunter candidates */}
          <HunterCandidateTabs
            generalCandidates={generalCandidates}
            pools={pools}
            poolsLoading={poolsLoading}
            poolsError={poolsError}
            poolsErrorMsg={poolsErrorMsg}
            dbReady={!!dbReady}
            onDeploy={setDeployPool}
          />

          {/* Positions */}
          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">
              Live Positions ({openPositions.length})
            </h2>
            {posLoading ? (
              <p className="text-gray-400">Loading...</p>
            ) : openPositions.length === 0 ? (
              <p className="text-gray-500">No open positions.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-gray-400 border-b border-gray-700">
                    <tr>
                      <th className="py-2 pr-4">Pool</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2 pr-4">PnL</th>
                      <th className="py-2 pr-4">SOL</th>
                      <th className="py-2 pr-4">Decision</th>
                      <th className="py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openPositions.map((p) => (
                      <tr
                        key={p.id}
                        className="border-b border-gray-800 text-white"
                      >
                        <td className="py-3 pr-4">{p.pool_name}</td>
                        <td className="py-3 pr-4">
                          <span
                            className={
                              p.status === "out_of_range"
                                ? "text-orange-400"
                                : "text-green-400"
                            }
                          >
                            {p.status}
                          </span>
                        </td>
                        <td
                          className={`py-3 pr-4 ${
                            p.pnl_pct >= 0 ? "text-green-400" : "text-red-400"
                          }`}
                        >
                          {formatPct(p.pnl_pct)}
                        </td>
                        <td className="py-3 pr-4">{p.amount_sol}</td>
                        <td className="py-3 pr-4 text-gray-400">
                          {p.last_decision ?? "—"}
                        </td>
                        <td className="py-3 flex gap-2">
                          <button
                            onClick={() => {
                              setEditPosition(p);
                              setEditTp(String(p.take_profit_pct));
                              setEditSl(String(p.stop_loss_pct));
                              setEditOor(String(p.oor_timeout_min));
                            }}
                            className="px-2 py-1 bg-blue-600 hover:bg-blue-700 rounded text-xs"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => {
                              if (
                                confirm(
                                  `Close position in ${p.pool_name}?`,
                                )
                              ) {
                                remove.mutate(p.id);
                              }
                            }}
                            className="px-2 py-1 bg-red-600 hover:bg-red-700 rounded text-xs"
                          >
                            Close
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        {/* Deploy modal */}
        {deployPool && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-900 border border-gray-600 rounded-xl p-6 max-w-md w-full">
              <h3 className="text-xl font-bold text-white mb-4">
                Deploy — {deployPool.name}
              </h3>
              <label className="block text-gray-400 text-sm mb-2">
                Amount (SOL)
              </label>
              <input
                type="number"
                value={deployAmount}
                onChange={(e) => setDeployAmount(e.target.value)}
                className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white mb-4"
                step="0.1"
                min="0.01"
              />
              <div className="flex gap-3">
                {!dbReady && (
                  <p className="text-red-400 text-sm mb-3 col-span-full">
                    Connect Supabase before deploying positions.
                  </p>
                )}
                <button
                  onClick={handleDeploy}
                  disabled={deploy.isPending || !dbReady}
                  className="flex-1 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded"
                >
                  {deploy.isPending ? "Deploying..." : "Confirm Deploy"}
                </button>
                <button
                  onClick={() => setDeployPool(null)}
                  className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Edit modal */}
        {editPosition && (
          <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-gray-900 border border-gray-600 rounded-xl p-6 max-w-md w-full">
              <h3 className="text-xl font-bold text-white mb-4">
                Edit — {editPosition.pool_name}
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="text-gray-400 text-sm">Take Profit %</label>
                  <input
                    type="number"
                    value={editTp}
                    onChange={(e) => setEditTp(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white"
                  />
                </div>
                <div>
                  <label className="text-gray-400 text-sm">Stop Loss %</label>
                  <input
                    type="number"
                    value={editSl}
                    onChange={(e) => setEditSl(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white"
                  />
                </div>
                <div>
                  <label className="text-gray-400 text-sm">
                    OOR timeout (min)
                  </label>
                  <input
                    type="number"
                    value={editOor}
                    onChange={(e) => setEditOor(e.target.value)}
                    className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-white"
                  />
                </div>
              </div>
              <div className="flex gap-3 mt-4">
                <button
                  onClick={handleEditSave}
                  disabled={edit.isPending}
                  className="flex-1 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditPosition(null)}
                  className="flex-1 py-2 bg-gray-700 text-white rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
  );
}
