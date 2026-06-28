"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import GmgnChartEmbed from "@/components/signals/shared/GmgnChartEmbed";
import GlobalWatchlistButton from "@/components/GlobalWatchlistButton";
import TradeWindowChart from "@/components/strategies/TradeWindowChart";
import type {
  OutcomeChartPoint,
  OutcomeMlCondition,
  OutcomeMlLabel,
  StrategyOutcomeRow,
} from "@/strategies/types";
import { formatAppDateTime } from "@/utils/datetime";
import { getGmgnTokenUrl, pickGmgnIntervalForWindow } from "@/utils/gmgn";
import {
  formatEntryMcap,
  readEntryMcap,
  readTokenSymbol,
  readTrainingClass,
} from "@/strategies/outcome-features";
import { computeTrainingClass } from "@/strategies/outcome-labeling";

const LABELS: { id: OutcomeMlLabel; title: string; activeClass: string }[] = [
  { id: "skip", title: "Skip", activeClass: "bg-gray-600 ring-gray-400" },
  { id: "interesting", title: "Interesting", activeClass: "bg-blue-700 ring-blue-400" },
  { id: "anomaly", title: "Anomaly", activeClass: "bg-amber-700 ring-amber-400" },
];

const CONDITIONS: {
  id: OutcomeMlCondition;
  title: string;
  activeClass: string;
}[] = [
  { id: "old_chart", title: "Old Chart", activeClass: "bg-purple-700 ring-purple-400" },
  { id: "price_topped", title: "Price Topped", activeClass: "bg-teal-700 ring-teal-400" },
  { id: "new_chart", title: "New Chart", activeClass: "bg-indigo-700 ring-indigo-400" },
];

const TRAINING_CLASS_OPTIONS: {
  value: 0 | 1 | 2 | 3 | 4;
  title: string;
  short: string;
}[] = [
  { value: 0, short: "c0 skip", title: "Skip — loss or win < 20%" },
  { value: 1, short: "c1", title: "Won 20–50%" },
  { value: 2, short: "c2", title: "Won 50–100%" },
  { value: 3, short: "c3", title: "Won 100–300%" },
  { value: 4, short: "c4", title: "Won ≥ 300%" },
];

export const CONDITION_TITLES: Record<OutcomeMlCondition, string> = {
  old_chart: "Old Chart",
  price_topped: "Price Topped",
  new_chart: "New Chart",
};

function readMlLabel(features: Record<string, unknown> | null): OutcomeMlLabel | null {
  const v = features?.ml_label;
  if (v === "skip" || v === "interesting" || v === "anomaly") return v;
  return null;
}

function readMlCondition(
  features: Record<string, unknown> | null,
): OutcomeMlCondition | null {
  const v = features?.ml_condition;
  if (v === "old_chart" || v === "price_topped" || v === "new_chart") return v;
  return null;
}

function readMlNote(features: Record<string, unknown> | null): string {
  const v = features?.ml_note;
  return typeof v === "string" ? v : "";
}

function hasAnyMlData(
  label: OutcomeMlLabel | null,
  condition: OutcomeMlCondition | null,
  note: string,
): boolean {
  return label != null || condition != null || note.trim().length > 0;
}

function hasSavedMlData(features: Record<string, unknown> | null | undefined): boolean {
  if (!features) return false;
  return (
    readMlLabel(features) != null ||
    readMlCondition(features) != null ||
    readMlNote(features).trim().length > 0
  );
}

type OutcomeNotify = (
  kind: "success" | "error",
  title: string,
  detail?: string,
) => void;

type OutcomeReviewModalProps = {
  outcome: StrategyOutcomeRow;
  onClose: () => void;
  onSaved: (updated: StrategyOutcomeRow) => void;
  onNavigate?: (direction: "prev" | "next") => void;
  onNotify?: OutcomeNotify;
  hasPrev?: boolean;
  hasNext?: boolean;
};

export default function OutcomeReviewModal({
  outcome,
  onClose,
  onSaved,
  onNavigate,
  onNotify,
  hasPrev = false,
  hasNext = false,
}: OutcomeReviewModalProps) {
  const [mlLabel, setMlLabel] = useState<OutcomeMlLabel | null>(
    readMlLabel(outcome.features),
  );
  const [mlCondition, setMlCondition] = useState<OutcomeMlCondition | null>(
    readMlCondition(outcome.features),
  );
  const [mlNote, setMlNote] = useState(readMlNote(outcome.features));
  const [trainingClass, setTrainingClass] = useState<number | null>(
    readTrainingClass(outcome.features),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    data: chartData,
    isFetching: chartLoading,
  } = useQuery({
    queryKey: ["outcome-chart", outcome.id],
    queryFn: async () => {
      const res = await fetch(`/api/strategies/outcomes/${outcome.id}/chart`, {
        cache: "no-store",
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Chart load failed");
      return {
        points: (json.points ?? []) as OutcomeChartPoint[],
        source: (json.source ?? "") as string,
        has_volume: Boolean(json.has_volume),
        volume_point_count:
          typeof json.volume_point_count === "number" ? json.volume_point_count : 0,
      };
    },
  });

  const chartPoints = chartData?.points ?? [];
  const chartSource = chartData?.source ?? "";
  const chartHasVolume = chartData?.has_volume ?? false;
  const chartVolumePointCount = chartData?.volume_point_count ?? 0;
  const volumeNote =
    outcome.domain === "dlmm" && !chartHasVolume
      ? "Volume N/A for DLMM pools"
      : !chartHasVolume && chartPoints.length > 0
        ? `No volume data (${chartVolumePointCount} vol points · source: ${chartSource || "?"})`
        : undefined;

  const tokenAddress = outcome.token_address ?? "";
  const tokenSymbol = readTokenSymbol(outcome.features);
  const entryMcap = readEntryMcap(outcome.features);
  const gmgnInterval = pickGmgnIntervalForWindow(outcome.entry_at, outcome.exit_at);
  const autoTrainingClass = computeTrainingClass(outcome.pnl_pct, outcome.status);

  const showToast = useCallback(
    (kind: "success" | "error", title: string, detail?: string) => {
      if (onNotify) {
        onNotify(kind, title, detail);
        return;
      }
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      setToastMessage(detail ? `${title} — ${detail}` : title);
      toastTimerRef.current = setTimeout(() => {
        setToastMessage(null);
        toastTimerRef.current = null;
      }, 2500);
    },
    [onNotify],
  );

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    };
  }, []);

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
    if (
      !hasAnyMlData(mlLabel, mlCondition, mlNote) &&
      trainingClass == null
    ) {
      const msg = "Select a label, condition, training class, or add a note";
      setSaveError(msg);
      showToast("error", "Cannot save outcome", msg);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/strategies/outcomes/${outcome.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ml_label: mlLabel,
          ml_condition: mlCondition,
          ml_note: mlNote || null,
          ml_manual: true,
          ...(trainingClass != null ? { training_class: trainingClass } : {}),
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Save failed");
      onSaved(json.outcome as StrategyOutcomeRow);

      const willAdvance = hasNext && onNavigate;
      const detailParts = [
        mlLabel ? `label: ${mlLabel}` : null,
        mlCondition ? `condition: ${mlCondition}` : null,
        trainingClass != null ? `class: c${trainingClass}` : null,
      ].filter(Boolean);
      showToast(
        "success",
        willAdvance ? "Saved — next outcome" : "Outcome saved",
        detailParts.length > 0
          ? detailParts.join(" · ")
          : outcome.token_address?.slice(0, 8),
      );

      if (willAdvance) {
        if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = setTimeout(() => {
          onNavigate("next");
          advanceTimerRef.current = null;
        }, 400);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(msg);
      showToast("error", "Outcome save failed", msg);
    } finally {
      setSaving(false);
    }
  }, [
    mlLabel,
    mlCondition,
    mlNote,
    trainingClass,
    outcome.id,
    outcome.token_address,
    onSaved,
    hasNext,
    onNavigate,
    showToast,
  ]);

  const clearAll = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/strategies/outcomes/${outcome.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ml_label: null,
          ml_condition: null,
          ml_note: null,
          training_class: null,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Clear failed");
      setMlLabel(null);
      setMlCondition(null);
      setMlNote("");
      setTrainingClass(null);
      onSaved(json.outcome as StrategyOutcomeRow);
      showToast(
        "success",
        "ML data cleared",
        outcome.token_address?.slice(0, 8) ?? outcome.id,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(msg);
      showToast("error", "Clear failed", msg);
    } finally {
      setSaving(false);
    }
  }, [outcome.id, outcome.token_address, onSaved, showToast]);

  const toggleCondition = (id: OutcomeMlCondition) => {
    setMlCondition((prev) => (prev === id ? null : id));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
      role="presentation"
    >
      {toastMessage && !onNotify && (
        <div
          className="fixed bottom-4 right-4 z-[60] rounded-lg border border-green-700 bg-green-900/95 px-4 py-2 text-sm text-green-100 shadow-lg"
          role="status"
        >
          {toastMessage}
        </div>
      )}

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
            {tokenSymbol && (
              <p className="text-sm font-semibold text-white mt-1">{tokenSymbol}</p>
            )}
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
              {entryMcap != null && (
                <>
                  {" "}
                  · Entry mcap {formatEntryMcap(entryMcap)}
                </>
              )}
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
              <div className="px-3 py-2 border-b border-gray-800 flex justify-between items-center gap-2">
                <span className="text-xs text-gray-400">
                  GMGN chart (interval {gmgnInterval})
                </span>
                <div className="flex items-center gap-2">
                  <GlobalWatchlistButton
                    tokenAddress={tokenAddress}
                    tokenSymbol={tokenSymbol}
                  />
                  <a
                    href={getGmgnTokenUrl(tokenAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-blue-400 hover:underline"
                  >
                    Open on GMGN ↗
                  </a>
                </div>
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
              volumeNote={volumeNote}
            />
          ) : (
            <p className="text-xs text-gray-500">
              No price history for entry→exit window (tracker or outcome features).
            </p>
          )}

          <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4">
            <h3 className="text-sm font-semibold text-white mb-3">ML label</h3>
            <div className="flex flex-wrap gap-2 mb-4">
              {LABELS.map(({ id, title, activeClass }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setMlLabel((prev) => (prev === id ? null : id))}
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

            <h3 className="text-sm font-semibold text-white mb-1">Training class</h3>
            {autoTrainingClass != null &&
              trainingClass != null &&
              autoTrainingClass !== trainingClass && (
                <p className="text-xs text-gray-500 mb-2">
                  Auto from PnL: c{autoTrainingClass}
                </p>
              )}
            <div className="flex flex-wrap gap-2 mb-4">
              {TRAINING_CLASS_OPTIONS.map(({ value, short, title }) => (
                <button
                  key={value}
                  type="button"
                  title={title}
                  onClick={() =>
                    setTrainingClass((prev) => (prev === value ? null : value))
                  }
                  className={`px-3 py-1.5 text-xs rounded border border-gray-600 text-white transition ${
                    trainingClass === value
                      ? "bg-emerald-800 ring-2 ring-emerald-400"
                      : "bg-gray-800 hover:bg-gray-700"
                  }`}
                >
                  {short}
                </button>
              ))}
            </div>

            <h3 className="text-sm font-semibold text-white mb-3">
              Condition (optional)
            </h3>
            <div className="flex flex-wrap gap-2 mb-4">
              {CONDITIONS.map(({ id, title, activeClass }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleCondition(id)}
                  className={`px-3 py-1.5 text-xs rounded border border-gray-600 text-white transition ${
                    mlCondition === id
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
                disabled={saving || !hasSavedMlData(outcome.features)}
                onClick={() => void clearAll()}
                className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white text-xs rounded"
              >
                Clear all
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

export function OutcomeMlConditionBadge({
  features,
}: {
  features: Record<string, unknown> | null | undefined;
}) {
  const condition = readMlCondition(features ?? null);
  if (!condition) return <span className="text-gray-600">—</span>;
  const styles: Record<OutcomeMlCondition, string> = {
    old_chart: "bg-purple-900/50 text-purple-300",
    price_topped: "bg-teal-900/50 text-teal-300",
    new_chart: "bg-indigo-900/50 text-indigo-300",
  };
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded ${styles[condition]}`}>
      {CONDITION_TITLES[condition]}
    </span>
  );
}
