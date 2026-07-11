"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { PotentialExitOverlayConfig } from "@/strategies/potential-exit-overlay-config";
import type { PotentialExitMode } from "@/strategies/potential-exit-overlay";

type ExitOverlayApi = {
  success: boolean;
  config: PotentialExitOverlayConfig;
  defaults: PotentialExitOverlayConfig;
  effectiveMode: PotentialExitMode;
  envMode: PotentialExitMode;
  previewBase: {
    stopLossPct: number;
    takeProfitPct: number;
    maxHoldHours: number;
  };
  preview: Record<
    string,
    { stopLossPct: number; takeProfitPct: number; maxHoldHours: number }
  >;
  potentialReady: boolean | null;
  potentialMinRows: number;
  potentialMinRowsRecommended: number;
  error?: string;
};

type Props = {
  onNotify?: (kind: "success" | "error", title: string, detail?: string) => void;
};

function numOrEmpty(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "";
  return String(v);
}

function parseOptionalNum(raw: string): number | null {
  if (raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export default function Ml2ExitOverlayPanel({ onNotify }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<ExitOverlayApi | null>(null);
  const [draft, setDraft] = useState<PotentialExitOverlayConfig | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/strategies/ml/exit-overlay");
      const json = (await res.json()) as ExitOverlayApi;
      if (!json.success) throw new Error(json.error ?? "load failed");
      setData(json);
      setDraft(structuredClone(json.config));
      setConfirmApply(false);
    } catch (e) {
      onNotify?.(
        "error",
        "ML2 overlay load failed",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(t)
  }, [load])

  const save = async (opts?: { reset?: boolean }) => {
    if (!draft && !opts?.reset) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = opts?.reset
        ? { reset: true }
        : { config: draft };
      if (
        !opts?.reset &&
        draft?.exitModeOverride === "apply"
      ) {
        body.confirm_apply = confirmApply;
      }
      const res = await fetch("/api/strategies/ml/exit-overlay", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        success: boolean;
        error?: string;
        config?: PotentialExitOverlayConfig;
        effectiveMode?: PotentialExitMode;
      };
      if (!json.success) throw new Error(json.error ?? "save failed");
      onNotify?.("success", opts?.reset ? "Overlay reset" : "Overlay saved");
      await load();
    } catch (e) {
      onNotify?.(
        "error",
        "ML2 overlay save failed",
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading || !draft || !data) {
    return (
      <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
        <h2 className="text-xl font-bold text-white mb-2">ML2 Exit Overlay</h2>
        <p className="text-gray-400 text-sm">Loading…</p>
      </section>
    );
  }

  const updateTier = (
    tier: 1 | 2 | 3 | 4,
    key: keyof PotentialExitOverlayConfig["tiers"][1],
    raw: string,
  ) => {
    setDraft((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        tiers: {
          ...prev.tiers,
          [tier]: {
            ...prev.tiers[tier],
            [key]: parseOptionalNum(raw),
          },
        },
      };
    });
  };

  return (
    <section className="bg-gray-900 border border-gray-700 rounded-lg p-6 space-y-4">
      <div>
        <h2 className="text-xl font-bold text-white mb-1">ML2 Exit Overlay</h2>
        <p className="text-gray-400 text-sm">
          Potential → TP/SL rules for sim opens. Live exits never use apply.
          Effective mode:{" "}
          <span className="text-white font-mono">{data.effectiveMode}</span>
          {" "}(env {data.envMode}
          {draft.exitModeOverride
            ? `, override ${draft.exitModeOverride}`
            : ", no override"}
          ).
        </p>
      </div>

      {data.potentialReady === false && (
        <p className="text-amber-300 text-xs border border-amber-800/60 rounded px-3 py-2">
          Potential model meta reports potential_ready=false — keep shadow until
          metrics improve.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm text-gray-300">
          Exit mode override
          <select
            className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
            value={draft.exitModeOverride ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setDraft((prev) =>
                prev
                  ? {
                      ...prev,
                      exitModeOverride:
                        v === ""
                          ? null
                          : (v as PotentialExitMode),
                    }
                  : prev,
              );
              if (v !== "apply") setConfirmApply(false);
            }}
          >
            <option value="">Use env ({data.envMode})</option>
            <option value="shadow">shadow</option>
            <option value="apply">apply</option>
            <option value="off">off</option>
          </select>
        </label>
        {draft.exitModeOverride === "apply" && (
          <label className="flex items-center gap-2 text-xs text-amber-200">
            <input
              type="checkbox"
              checked={confirmApply}
              onChange={(e) => setConfirmApply(e.target.checked)}
            />
            Confirm apply (sim only; live exits unchanged)
          </label>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs text-left text-gray-300">
          <thead>
            <tr className="text-gray-400 border-b border-gray-700">
              <th className="p-2">Tier</th>
              <th className="p-2" title="Absolute TP">
                TP abs
              </th>
              <th className="p-2" title="max(base, x)">
                TP min
              </th>
              <th className="p-2" title="min(base, x)">
                TP max
              </th>
              <th className="p-2" title="max(base, x) tighter">
                SL tighter
              </th>
              <th className="p-2" title="min(base, x) wider">
                SL wider
              </th>
              <th className="p-2">Hold Δ</th>
              <th className="p-2">Hold cap</th>
              <th className="p-2">Preview (base 200/-50/96h)</th>
            </tr>
          </thead>
          <tbody>
            {([1, 2, 3, 4] as const).map((tier) => {
              const rule = draft.tiers[tier];
              const prev = data.preview[`tier_${tier}`];
              return (
                <tr key={tier} className="border-b border-gray-800">
                  <td className="p-2 font-semibold text-white">T{tier}</td>
                  {(
                    [
                      "takeProfitPct",
                      "takeProfitMin",
                      "takeProfitMax",
                      "stopLossTighter",
                      "stopLossWider",
                      "maxHoldHoursDelta",
                      "maxHoldHoursCap",
                    ] as const
                  ).map((key) => (
                    <td key={key} className="p-1">
                      <input
                        className="w-16 bg-gray-800 border border-gray-600 rounded px-1 py-0.5 text-white"
                        value={numOrEmpty(rule[key])}
                        onChange={(e) => updateTier(tier, key, e.target.value)}
                      />
                    </td>
                  ))}
                  <td className="p-2 font-mono text-[10px] text-gray-400">
                    {prev
                      ? `TP ${prev.takeProfitPct} · SL ${prev.stopLossPct} · ${prev.maxHoldHours}h`
                      : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 text-sm">
        <label className="text-gray-300">
          Moon → T3
          <input
            className="block mt-1 w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
            value={draft.moonScorePromote.tier3}
            onChange={(e) =>
              setDraft((p) =>
                p
                  ? {
                      ...p,
                      moonScorePromote: {
                        ...p.moonScorePromote,
                        tier3: Number(e.target.value) || 0,
                      },
                    }
                  : p,
              )
            }
          />
        </label>
        <label className="text-gray-300">
          Moon → T4
          <input
            className="block mt-1 w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
            value={draft.moonScorePromote.tier4}
            onChange={(e) =>
              setDraft((p) =>
                p
                  ? {
                      ...p,
                      moonScorePromote: {
                        ...p.moonScorePromote,
                        tier4: Number(e.target.value) || 0,
                      },
                    }
                  : p,
              )
            }
          />
        </label>
        <label className="text-gray-300">
          pWinner nudge (min / +TP / minTier)
          <div className="flex gap-1 mt-1">
            <input
              className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
              value={draft.pWinnerNudge.min}
              onChange={(e) =>
                setDraft((p) =>
                  p
                    ? {
                        ...p,
                        pWinnerNudge: {
                          ...p.pWinnerNudge,
                          min: Number(e.target.value) || 0,
                        },
                      }
                    : p,
                )
              }
            />
            <input
              className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
              value={draft.pWinnerNudge.tpBonus}
              onChange={(e) =>
                setDraft((p) =>
                  p
                    ? {
                        ...p,
                        pWinnerNudge: {
                          ...p.pWinnerNudge,
                          tpBonus: Number(e.target.value) || 0,
                        },
                      }
                    : p,
                )
              }
            />
            <input
              className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
              value={draft.pWinnerNudge.minTier}
              onChange={(e) =>
                setDraft((p) =>
                  p
                    ? {
                        ...p,
                        pWinnerNudge: {
                          ...p.pWinnerNudge,
                          minTier: Number(e.target.value) || 0,
                        },
                      }
                    : p,
                )
              }
            />
          </div>
        </label>
      </div>

      <p className="text-[11px] text-gray-500">
        Potential train floor:{" "}
        <span className="font-mono text-gray-300">
          ML_POTENTIAL_MIN_ROWS={data.potentialMinRows}
        </span>{" "}
        (recommended {data.potentialMinRowsRecommended}). Set via env on VPS —
        values &lt; 30 warn but still train.
      </p>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="px-3 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm rounded"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void save({ reset: true })}
          className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white text-sm rounded"
        >
          Reset to defaults
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => void load()}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm rounded"
        >
          Reload
        </button>
      </div>
    </section>
  );
}
