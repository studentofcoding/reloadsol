"use client";

import React, { useCallback, useEffect, useState } from "react";
import GmgnChartEmbed from "@/components/signals/shared/GmgnChartEmbed";
import TradeWindowChart from "@/components/strategies/TradeWindowChart";
import type {
  OutcomeChartPoint,
  OutcomeMlLabel,
  StrategyOutcomeRow,
} from "@/strategies/types";
import { formatAppDateTime } from "@/utils/datetime";
import { getGmgnTokenUrl, pickGmgnIntervalForWindow } from "@/utils/gmgn";

const LABELS: { id: OutcomeMlLabel; title: string; activeClass: string }[] = [
  { id: "skip", title: "Skip", activeClass: "bg-gray-600 ring-gray-400" },
  { id: "interesting", title: "Interesting", activeClass: "bg-blue-700 ring-blue-400" },
  { id: "anomaly", title: "Anomaly", activeClass: "bg-amber-700 ring-amber-400" },
];

function readMlLabel(features: Record<string, unknown> | null): OutcomeMlLabel | null {
  const v = features?.ml_label;
  if (v === "skip" || v === "interesting" || v === "anomaly") return v;
  return null;
}

function readMlNote(features: Record<string, unknown> | null): string {
  const v = features?.ml_note;
  return typeof v === "string" ? v : "";
}

type OutcomeReviewModalProps = {
  outcome: StrategyOutcomeRow;
  onClose: () => void;
  onSaved: (updated: StrategyOutcomeRow) => void;
  onNavigate?: (direction: "prev" | "next") => void;
  hasPrev?: boolean;
  hasNext?: boolean;
};

export default function OutcomeReviewModal({
  outcome,
  onClose,
  onSaved,
  onNavigate,
  hasPrev = false,
  hasNext = false,
}: OutcomeReviewModalProps) {
  const [mlLabel, setMlLabel] = useState<OutcomeMlLabel | null>(
    readMlLabel(outcome.features),
  );
  const [mlNote, setMlNote] = useState(readMlNote(outcome.features));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [chartPoints, setChartPoints] = useState<OutcomeChartPoint[]>([]);
  const [chartSource, setChartSource] = useState<string>("");
  const [chartLoading, setChartLoading] = useState(true);

  const tokenAddress = outcome.token_address ?? "";
  const gmgnInterval = pickGmgnIntervalForWindow(outcome.entry_at, outcome.exit_at);

  useEffect(() => {
    setMlLabel(readMlLabel(outcome.features));
    setMlNote(readMlNote(outcome.features));
    setSaveError(null);
    setSavedFlash(false);
  }, [outcome.id, outcome.features]);

  useEffect(() => {
    let cancelled = false;
    setChartLoading(true);
    setChartPoints([]);

    fetch(`/api/strategies/outcomes/${outcome.id}/chart`, { cache: "no-store" })
      .then((res) => res.json())
      .then((json) => {
        if (cancelled) return;
        if (json.success && Array.isArray(json.points)) {
          setChartPoints(json.points);
          setChartSource(json.source ?? "");
        }
      })
      .catch(() => {
        if (!cancelled) setChartPoints([]);
      })
      .finally(() => {
        if (!cancelled) setChartLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [outcome.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (!onNavigate) return;
      if (e.key === "ArrowLeft" && hasPrev) onNavigate("prev");
      if (e.key === "ArrowRight" && hasNext) onNavigate("next");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onNavigate, hasPrev, hasNext]);

  const saveLabel = useCallback(async () => {
    if (!mlLabel) {
      setSaveError("Select skip, interesting, or anomaly");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/strategies/outcomes/${outcome.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ml_label: mlLabel, ml_note: mlNote || null }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Save failed");
      onSaved(json.outcome as StrategyOutcomeRow);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [mlLabel, mlNote, outcome.id, onSaved]);

  const clearLabel = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/strategies/outcomes/${outcome.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ml_label: null, ml_note: null }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Clear failed");
      setMlLabel(null);
      setMlNote("");
      onSaved(json.outcome as StrategyOutcomeRow);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [outcome.id, onSaved]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-3xl max-h-[95vh] overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="outcome-review-title"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-gray-700 bg-gray-900 px-4 py-3">
          <div>
            <h2 id="outcome-review-title" className="text-lg font-bold text-white">
              Outcome review
            </h2>
            <p className="text-xs text-gray-400 mt-1">
              {outcome.domain} / {outcome.strategy_id} ·{" "}
              {outcome.is_simulated ? "SIM" : "LIVE"}
              {outcome.pnl_pct != null && (
                <span
                  className={
                    outcome.pnl_pct >= 0 ? " text-green-400" : " text-red-400"
                  }
                >
                  {" "}
                  · {Number(outcome.pnl_pct).toFixed(2)}%
                </span>
              )}
            </p>
            <p className="text-[10px] font-mono text-gray-500 mt-1 break-all">
              {tokenAddress || "—"}
            </p>
            <p className="text-[10px] text-gray-500">
              Entry {formatAppDateTime(outcome.entry_at)} → Exit{" "}
              {formatAppDateTime(outcome.exit_at)}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {onNavigate && (
              <>
                <button
                  type="button"
                  disabled={!hasPrev}
                  onClick={() => onNavigate("prev")}
                  className="px-2 py-1 text-xs bg-gray-800 disabled:opacity-40 text-white rounded"
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  disabled={!hasNext}
                  onClick={() => onNavigate("next")}
                  className="px-2 py-1 text-xs bg-gray-800 disabled:opacity-40 text-white rounded"
                >
                  Next →
                </button>
              </>
            )}
            <button
              type="button"
              onClick={onClose}
              className="text-gray-400 hover:text-white text-xl leading-none px-2"
              aria-label="Close"
            >
              ×
            </button>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {tokenAddress ? (
            <div className="rounded-lg border border-gray-700 overflow-hidden bg-black">
              <div className="px-3 py-2 border-b border-gray-800 flex justify-between items-center">
                <span className="text-xs text-gray-400">
                  GMGN chart (interval {gmgnInterval})
                </span>
                <a
                  href={getGmgnTokenUrl(tokenAddress)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:underline"
                >
                  Open on GMGN ↗
                </a>
              </div>
              <GmgnChartEmbed
                tokenAddress={tokenAddress}
                interval={gmgnInterval}
                theme="dark"
                height={280}
                className="w-full"
              />
            </div>
          ) : (
            <p className="text-sm text-gray-500">No token address — chart unavailable.</p>
          )}

          {chartLoading ? (
            <p className="text-xs text-gray-500">Loading trade window chart…</p>
          ) : chartPoints.length > 0 && outcome.entry_at && outcome.exit_at ? (
            <TradeWindowChart
              points={chartPoints}
              entryAt={outcome.entry_at}
              exitAt={outcome.exit_at}
              pnlPct={outcome.pnl_pct}
              source={chartSource}
            />
          ) : (
            <p className="text-xs text-gray-500">
              No price history for entry→exit window (tracker or outcome features).
            </p>
          )}

          <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4">
            <h3 className="text-sm font-semibold text-white mb-3">ML label</h3>
            <div className="flex flex-wrap gap-2 mb-3">
              {LABELS.map(({ id, title, activeClass }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setMlLabel(id)}
                  className={`px-3 py-1.5 text-xs rounded border border-gray-600 text-white transition ${
                    mlLabel === id
                      ? `${activeClass} ring-2`
                      : "bg-gray-800 hover:bg-gray-700"
                  }`}
                >
                  {title}
                </button>
              ))}
            </div>
            <label className="block text-xs text-gray-400 mb-1">Note (optional)</label>
            <textarea
              value={mlNote}
              onChange={(e) => setMlNote(e.target.value)}
              rows={3}
              placeholder="Why skip / interesting / anomaly…"
              className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-sm text-white resize-y min-h-[72px]"
            />
            {saveError && <p className="text-xs text-red-400 mt-2">{saveError}</p>}
            {savedFlash && (
              <p className="text-xs text-green-400 mt-2">Saved.</p>
            )}
            <div className="flex flex-wrap gap-2 mt-3">
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveLabel()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs rounded"
              >
                Save label
              </button>
              <button
                type="button"
                disabled={saving || !readMlLabel(outcome.features)}
                onClick={() => void clearLabel()}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-xs rounded"
              >
                Clear label
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function OutcomeMlBadge({
  features,
}: {
  features: Record<string, unknown> | null | undefined;
}) {
  const label = readMlLabel(features ?? null);
  if (!label) return <span className="text-gray-600">—</span>;
  const styles: Record<OutcomeMlLabel, string> = {
    skip: "bg-gray-700 text-gray-300",
    interesting: "bg-blue-900/50 text-blue-300",
    anomaly: "bg-amber-900/50 text-amber-300",
  };
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded uppercase ${styles[label]}`}>
      {label}
    </span>
  );
}
