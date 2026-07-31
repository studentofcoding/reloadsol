"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import type {
  TrendingBotStrategy,
  SignalsStrategy,
  McapTrackerStrategy,
  GmgnStrategy,
  SocialStrategy,
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
  OutcomeExitOverlayBadge,
  OutcomeGateMlBadge,
  OutcomeMlBadge,
  OutcomeMlConditionBadge,
  OutcomePatternMlBadge,
  OutcomePotentialMlBadge,
} from "@/components/strategies/OutcomeReviewModal";
import Ml2ExitOverlayPanel from "@/components/strategies/Ml2ExitOverlayPanel";
import StrategyReviewPanel from "@/components/strategies/StrategyReviewPanel";
import ScrollableMenuRow from "@/components/ScrollableMenuRow";
import {
  ENTRY_MCAP_BAND_OPTIONS,
  formatEntryMcap,
  readEntryMcap,
  readMonitorSnapshotCount,
  readOrganicScore,
  readTokenAgeHours,
  readTokenSymbol,
  readTopHoldersPct,
  readTrainingClass,
  readVolumeAtEntry,
} from "@/strategies/outcome-features";
import { DEFAULT_GMGN_RADAR } from "@/strategies/registry";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import { notifySyncForActive, readNotifyFlags } from "@/strategies/strategy-notify";

const OUTCOMES_PAGE_SIZE = 100;

type BackfillPhase = "idle" | "preview" | "running";

const TRAINING_CLASS_OPTIONS: { value: 0 | 1 | 2 | 3 | 4; label: string; title: string }[] = [
  { value: 0, label: "c0", title: "Skip — loss or win < 20%" },
  { value: 1, label: "c1", title: "Won 20–50%" },
  { value: 2, label: "c2", title: "Won 50–100%" },
  { value: 3, label: "c3", title: "Won 100–300%" },
  { value: 4, label: "c4", title: "Won ≥ 300%" },
];

async function patchOutcomeTrainingClass(
  id: string,
  trainingClass: 0 | 1 | 2 | 3 | 4,
): Promise<StrategyOutcomeRow> {
  const res = await fetch(`/api/strategies/outcomes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ training_class: trainingClass, ml_manual: true }),
  });
  const json = (await res.json()) as { success?: boolean; error?: string; outcome?: StrategyOutcomeRow };
  if (!res.ok || !json.success || !json.outcome) {
    throw new Error(json.error || "Failed to update training class");
  }
  return json.outcome;
}

function StrategyNotifyBar({
  strategyId,
  notify,
  saving,
  onSave,
}: {
  strategyId: string
  notify?: { telegram?: boolean; ui?: boolean } | null
  saving: boolean
  onSave: (id: string, patch: Record<string, unknown>) => void
}) {
  const flags = readNotifyFlags(notify)
  return (
    <div className="flex flex-wrap gap-3 items-center text-xs text-gray-300">
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="checkbox"
          className="rounded border-gray-600"
          checked={flags.telegram}
          disabled={saving}
          onChange={(e) =>
            onSave(strategyId, {
              config: { notify: { telegram: e.target.checked, ui: flags.ui } },
            })
          }
        />
        Telegram
      </label>
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="checkbox"
          className="rounded border-gray-600"
          checked={flags.ui}
          disabled={saving}
          onChange={(e) =>
            onSave(strategyId, {
              config: { notify: { telegram: flags.telegram, ui: e.target.checked } },
            })
          }
        />
        UI toasts
      </label>
    </div>
  )
}

function toggleActiveWithNotifySync(
  strategyId: string,
  currentlyActive: boolean,
  onSave: (id: string, patch: Record<string, unknown>) => void,
) {
  const next = !currentlyActive
  onSave(strategyId, {
    is_active: next,
    config: { notify: notifySyncForActive(next) },
  })
}

type TabId = "config" | "reports" | "review" | "workers";

type StrategiesResponse = {
  success: boolean;
  trending_bot?: {
    effective: Record<string, TrendingBotStrategy>;
    active: string[];
    allocation: Record<string, number>;
  };
  signals?: { effective: Record<string, SignalsStrategy> };
  mcap_tracker?: {
    effective: Record<string, McapTrackerStrategy>;
    active: string[];
  };
  gmgn?: {
    effective: Record<string, GmgnStrategy>;
    active: string[];
  };
  social?: {
    effective: Record<string, SocialStrategy>;
    active: string[];
  };
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
  open_tracker_count?: number | null;
  ml_unlabeled?: number;
  ml_labeled?: number;
};

type AbPair = {
  strategy_id: string;
  domain: string;
  sim: ReportBreakdown | null;
  live: ReportBreakdown | null;
};

type MlLabelStats = {
  total: number;
  unlabeled: number;
  by_label: Record<string, number>;
  by_condition: Record<string, number>;
};

type McapTrackerMilestoneBucket = {
  bucket: string;
  label: string;
  trade_count: number;
  win_count: number;
  win_rate: number;
  avg_pnl_pct: number;
};

type McapOpenSimReportRow = {
  strategy_id: string;
  token_address: string;
  token_symbol: string;
  entry_mcap: number;
  entry_at: string | null;
  current_mcap: number | null;
  unrealized_pnl_pct: number | null;
};

type McapTrackerReportStats = {
  strategies: ReportBreakdown[];
  milestone_buckets: McapTrackerMilestoneBucket[];
  timeline_inconsistent_count: number;
  total_tracked_tokens: number;
  open_sim_positions?: McapOpenSimReportRow[];
};

type BestTradeWindowRow = {
  strategy_id: string;
  domain: string;
  is_simulated: boolean;
  timezone: string;
  best: {
    start_hour: number;
    end_hour: number;
    trade_count: number;
    win_rate: number;
    avg_pnl_pct: number;
  } | null;
};

type StrategyAdminQueryData = {
  data: StrategiesResponse;
  outcomes: OutcomeRow[];
  outcomesTotal: number;
  reports: {
    breakdown: ReportBreakdown[];
    coverage: CoverageRow[];
    ab_pairs: AbPair[];
    ranking: ReportBreakdown[];
    ml_stats: MlLabelStats;
    mcap_tracker_stats: McapTrackerReportStats | null;
    best_trade_windows: BestTradeWindowRow[];
    timezone: string;
  } | null;
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
  domain_heartbeat: Array<{
    domain: string;
    last_outcome_at: string | null;
    heartbeat_source?: "outcome" | "position_close" | "position_activity" | "worker";
  }>;
};

const EXECUTION_MODES: ExecutionMode[] = ["sim_only", "live_only", "ab_parallel"];

type AdminToast = {
  kind: "success" | "error";
  title: string;
  detail?: string;
};

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

const REPORTS_POLL_INTERVAL_MS = 15_000;

function heartbeatSourceLabel(
  source?: WorkersStatusResponse["domain_heartbeat"][number]["heartbeat_source"],
): string {
  switch (source) {
    case "outcome":
      return " (closed outcome)";
    case "position_close":
      return " (position close)";
    case "position_activity":
      return " (manage activity)";
    case "worker":
      return " (worker run)";
    default:
      return "";
  }
}

function AdminToastBanner({
  toast,
  onDismiss,
}: {
  toast: AdminToast | null;
  onDismiss: () => void;
}) {
  if (!toast) return null;
  const isSuccess = toast.kind === "success";
  return (
    <div
      className={`fixed bottom-4 right-4 z-[60] max-w-sm rounded-lg border px-4 py-3 shadow-lg ${
        isSuccess
          ? "border-green-700 bg-green-900/95 text-green-100"
          : "border-red-700 bg-red-900/95 text-red-100"
      }`}
      role="status"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{toast.title}</p>
          {toast.detail && (
            <p className="text-xs mt-1 opacity-90 break-words">{toast.detail}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 text-lg leading-none opacity-70 hover:opacity-100"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function parseTabParam(value: string | null): TabId {
  if (value === "reports" || value === "workers" || value === "review") return value;
  return "config";
}

function buildOutcomesQuery(params: {
  reportFrom: string;
  reportTo: string;
  reportDomain: string;
  reportStrategyId: string;
  reportSimulated: string;
  reportMlLabel: string;
  reportMlCondition: string;
  reportStatus: string;
  reportPnlFilter: string;
  reportEntryMcapBand: string;
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
  if (params.reportMlLabel) q.set("ml_label", params.reportMlLabel);
  if (params.reportMlCondition) q.set("ml_condition", params.reportMlCondition);
  if (params.reportStatus) q.set("status", params.reportStatus);
  if (params.reportPnlFilter) q.set("pnl_filter", params.reportPnlFilter);
  if (params.reportEntryMcapBand) q.set("entry_mcap_band", params.reportEntryMcapBand);
  return q.toString();
}

function buildCsvHref(params: {
  reportFrom: string;
  reportTo: string;
  reportDomain: string;
  reportStrategyId: string;
  reportSimulated: string;
  reportMlLabel: string;
  reportMlCondition: string;
  reportStatus: string;
  reportPnlFilter: string;
  reportEntryMcapBand: string;
}) {
  const q = new URLSearchParams();
  q.set("format", "csv");
  q.set("limit", "5000");
  if (params.reportFrom) q.set("from", params.reportFrom);
  if (params.reportTo) q.set("to", params.reportTo);
  if (params.reportDomain) q.set("domain", params.reportDomain);
  if (params.reportStrategyId) q.set("strategyId", params.reportStrategyId);
  if (params.reportSimulated) q.set("is_simulated", params.reportSimulated);
  if (params.reportMlLabel) q.set("ml_label", params.reportMlLabel);
  if (params.reportMlCondition) q.set("ml_condition", params.reportMlCondition);
  if (params.reportStatus) q.set("status", params.reportStatus);
  if (params.reportPnlFilter) q.set("pnl_filter", params.reportPnlFilter);
  if (params.reportEntryMcapBand) q.set("entry_mcap_band", params.reportEntryMcapBand);
  return `/api/strategies/outcomes?${q.toString()}`;
}

export default function StrategyAdminHub() {
  const queryClient = useQueryClient();
  const { network } = useAppNetwork();
  const isRobinhood = network === "robinhood";
  const [tab, setTab] = useState<TabId>(() => {
    if (typeof window === "undefined") return "config";
    const params = new URLSearchParams(window.location.search);
    return parseTabParam(params.get("tab"));
  });
  const [saving, setSaving] = useState<string | null>(null);
  const [toast, setToast] = useState<AdminToast | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const [reportTz, setReportTz] = useState("Asia/Bangkok");
  const [reportDomain, setReportDomain] = useState("");
  const [reportStrategyId, setReportStrategyId] = useState("");
  const [reportSimulated, setReportSimulated] = useState("");
  const [reportMlLabel, setReportMlLabel] = useState("");
  const [reportMlCondition, setReportMlCondition] = useState("");
  const [reportStatus, setReportStatus] = useState("");
  const [reportPnlFilter, setReportPnlFilter] = useState("");
  const [reportEntryMcapBand, setReportEntryMcapBand] = useState("");
  const [outcomesOffset, setOutcomesOffset] = useState(0);
  const [selectedOutcomeIndex, setSelectedOutcomeIndex] = useState<number | null>(
    null,
  );
  const [triggeringWorker, setTriggeringWorker] = useState<string | null>(null);
  const [regimeDate, setRegimeDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [regimeTag, setRegimeTag] = useState("high_vol_meme");
  const [regimeNotes, setRegimeNotes] = useState("");
  const [savingRegime, setSavingRegime] = useState(false);
  const [showEntryFeatureColumns, setShowEntryFeatureColumns] = useState(false);
  const [backfillPhase, setBackfillPhase] = useState<BackfillPhase>("idle");
  const [patchingClassId, setPatchingClassId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const socialOverlapSeenRef = useRef(new Set<string>());

  const reportsPollingActive =
    tab === "reports" && backfillPhase !== "running";

  useEffect(() => {
    if (tab !== "reports") return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [tab]);

  const dismissToast = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  }, []);

  const showToast = useCallback(
    (kind: AdminToast["kind"], title: string, detail?: string) => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      setToast({ kind, title, detail });
      toastTimerRef.current = setTimeout(() => {
        setToast(null);
        toastTimerRef.current = null;
      }, 4000);
    },
    [],
  );

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const strategyAdminQueryKey = useMemo(
    () =>
      [
        "strategy-admin",
        network,
        reportFrom,
        reportTo,
        reportTz,
        reportDomain,
        reportStrategyId,
        reportSimulated,
        reportMlLabel,
        reportMlCondition,
        reportStatus,
        reportPnlFilter,
        reportEntryMcapBand,
        outcomesOffset,
      ] as const,
    [
      network,
      reportFrom,
      reportTo,
      reportTz,
      reportDomain,
      reportStrategyId,
      reportSimulated,
      reportMlLabel,
      reportMlCondition,
      reportStatus,
      reportPnlFilter,
      reportEntryMcapBand,
      outcomesOffset,
    ],
  );

  const patternCohortQuery = useQuery({
    queryKey: ["pattern-cohort-map", network],
    queryFn: async () => {
      const res = await fetch(
        `/api/mcap-patterns/24h?chain=${encodeURIComponent(network)}`,
      );
      const json = await res.json();
      const map = new Map<string, "winner" | "loser">();
      if (json.success) {
        for (const row of json.winners ?? []) {
          const addr = (row as { tokenAddress?: string }).tokenAddress;
          if (addr) map.set(addr, "winner");
        }
        for (const row of json.losers ?? []) {
          const addr = (row as { tokenAddress?: string }).tokenAddress;
          if (addr) map.set(addr, "loser");
        }
      }
      return map;
    },
    enabled: tab === "reports",
    staleTime: 60_000,
  });

  const strategiesQuery = useQuery({
    queryKey: strategyAdminQueryKey,
    queryFn: async () => {
      const reportParams = new URLSearchParams();
      reportParams.set("chain", network);
      if (reportFrom) reportParams.set("from", reportFrom);
      if (reportTo) reportParams.set("to", reportTo);
      if (reportDomain) reportParams.set("domain", reportDomain);
      if (reportStrategyId) reportParams.set("strategy_id", reportStrategyId);
      if (reportSimulated) reportParams.set("is_simulated", reportSimulated);
      reportParams.set("tz", reportTz);

      const outcomesQuery = buildOutcomesQuery({
        reportFrom,
        reportTo,
        reportDomain,
        reportStrategyId,
        reportSimulated,
        reportMlLabel,
        reportMlCondition,
        reportStatus,
        reportPnlFilter,
        reportEntryMcapBand,
        outcomesOffset,
      });

      const [strRes, outRes, repRes] = await Promise.all([
        fetch(`/api/strategies?chain=${network}`),
        fetch(`/api/strategies/outcomes?${outcomesQuery}&chain=${network}`),
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
              ml_stats: (repJson.ml_stats ?? {
                total: 0,
                unlabeled: 0,
                by_label: {},
                by_condition: {},
              }) as MlLabelStats,
              mcap_tracker_stats: repJson.mcap_tracker_stats ?? null,
              best_trade_windows: (repJson.best_trade_windows ??
                []) as BestTradeWindowRow[],
              timezone: (repJson.timezone as string) ?? reportTz,
            }
          : null,
      };
    },
    refetchInterval:
      tab === "reports" && backfillPhase !== "running"
        ? REPORTS_POLL_INTERVAL_MS
        : false,
    refetchIntervalInBackground: false,
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
  const outcomes = useMemo(
    () => strategiesQuery.data?.outcomes ?? [],
    [strategiesQuery.data?.outcomes],
  );
  const outcomesTotal = strategiesQuery.data?.outcomesTotal ?? 0;
  const selectedOutcome =
    selectedOutcomeIndex != null ? outcomes[selectedOutcomeIndex] ?? null : null;
  const reports = strategiesQuery.data?.reports ?? null;
  const coverage = reports?.coverage ?? [];
  const loading = strategiesQuery.isLoading;
  const loadError = strategiesQuery.error
    ? strategiesQuery.error instanceof Error
      ? strategiesQuery.error.message
      : String(strategiesQuery.error)
    : null;

  useEffect(() => {
    if (tab !== "reports" || outcomes.length === 0) return;
    for (const o of outcomes) {
      const feats =
        o.features && typeof o.features === "object"
          ? (o.features as Record<string, unknown>)
          : null;
      if (!feats || feats.social_overlap !== true) continue;
      const mint = o.token_address ?? "";
      const key = `${mint}:${o.entry_at ?? o.id}`;
      if (socialOverlapSeenRef.current.has(key)) continue;
      socialOverlapSeenRef.current.add(key);
      const symbol =
        (typeof feats.token_symbol === "string" && feats.token_symbol) ||
        mint.slice(0, 8);
      showToast(
        "success",
        `Social overlap: ${symbol}`,
        "Token mentioned in last 24h",
      );
      break;
    }
  }, [outcomes, tab, showToast]);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const result = await strategiesQuery.refetch();
      if (result.error) throw result.error;
      if (tab === "workers") {
        const workersResult = await workersQuery.refetch();
        if (workersResult.error) throw workersResult.error;
      }
      if (!options?.silent) {
        showToast("success", "Data refreshed");
      }
    } catch (e) {
      showToast("error", "Refresh failed", formatError(e));
    }
  }, [strategiesQuery, workersQuery, tab, showToast]);

  const refreshWorkers = useCallback(async () => {
    try {
      const result = await workersQuery.refetch();
      if (result.error) throw result.error;
      showToast("success", "Workers refreshed");
    } catch (e) {
      showToast("error", "Workers refresh failed", formatError(e));
    }
  }, [workersQuery, showToast]);

  const backfillAutoLabels = useCallback(async () => {
    setBackfillPhase("preview");
    try {
      const params = new URLSearchParams({ dry_run: "true" });
      if (reportDomain) params.set("domain", reportDomain);
      if (reportStrategyId) params.set("strategyId", reportStrategyId);

      const previewRes = await fetch(
        `/api/strategies/ml/backfill-labels?${params.toString()}`,
        { method: "POST", credentials: "include" },
      );
      const previewJson = (await previewRes.json()) as {
        success?: boolean;
        error?: string;
        preview?: Record<string, number>;
        skipped_manual?: number;
      };
      if (!previewRes.ok || !previewJson.success) {
        throw new Error(previewJson.error || "Backfill preview failed");
      }

      const p = previewJson.preview ?? {};
      const previewDetail = [
        `c0 ${p["0"] ?? 0}`,
        `c1 ${p["1"] ?? 0}`,
        `c2 ${p["2"] ?? 0}`,
        `c3 ${p["3"] ?? 0}`,
        `c4 ${p["4"] ?? 0}`,
        previewJson.skipped_manual
          ? `skip manual ${previewJson.skipped_manual}`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");

      showToast("success", "Backfill preview", previewDetail);

      const scope =
        reportDomain || reportStrategyId
          ? ` (${[reportDomain, reportStrategyId].filter(Boolean).join("/")})`
          : " (all outcomes)";

      setBackfillPhase("idle");
      if (
        !window.confirm(
          `Backfill auto ML labels${scope}?\n\nPreview: ${previewDetail}\n\nRows with ml_manual stay unchanged.`,
        )
      ) {
        showToast("success", "Backfill cancelled", previewDetail);
        return;
      }

      setBackfillPhase("running");
      params.delete("dry_run");
      const runRes = await fetch(
        `/api/strategies/ml/backfill-labels?${params.toString()}`,
        { method: "POST", credentials: "include" },
      );
      const runJson = (await runRes.json()) as {
        success?: boolean;
        error?: string;
        updated?: number;
        skipped_manual?: number;
      };
      if (!runRes.ok || !runJson.success) {
        throw new Error(runJson.error || "Backfill failed");
      }

      await strategiesQuery.refetch();
      showToast(
        "success",
        `Backfilled ${runJson.updated ?? 0} outcomes`,
        runJson.skipped_manual
          ? `${runJson.skipped_manual} manual rows skipped`
          : undefined,
      );
    } catch (e) {
      showToast("error", "Backfill failed", formatError(e));
    } finally {
      setBackfillPhase("idle");
    }
  }, [
    reportDomain,
    reportStrategyId,
    showToast,
    strategiesQuery,
  ]);

  const updateOutcomeInCache = useCallback(
    (updated: StrategyOutcomeRow, rowIndex?: number) => {
      queryClient.setQueryData<StrategyAdminQueryData | undefined>(
        strategyAdminQueryKey,
        (old) => {
          if (!old) return old;
          const idx = rowIndex ?? old.outcomes.findIndex((r) => r.id === updated.id);
          if (idx < 0) return old;
          const nextOutcomes = old.outcomes.map((row, i) => (i === idx ? updated : row));
          return { ...old, outcomes: nextOutcomes };
        },
      );
    },
    [queryClient, strategyAdminQueryKey],
  );

  const handleTrainingClassChange = useCallback(
    async (outcome: OutcomeRow, idx: number, raw: string) => {
      if (!raw) return;
      const trainingClass = Number(raw) as 0 | 1 | 2 | 3 | 4;
      if (trainingClass < 0 || trainingClass > 4) return;
      setPatchingClassId(outcome.id);
      try {
        const updated = await patchOutcomeTrainingClass(outcome.id, trainingClass);
        updateOutcomeInCache(updated, idx);
        showToast("success", `Class c${trainingClass} saved`, readTokenSymbol(updated.features) ?? undefined);
      } catch (e) {
        showToast("error", "Class update failed", formatError(e));
      } finally {
        setPatchingClassId(null);
      }
    },
    [showToast, updateOutcomeInCache],
  );

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
    try {
      const res = await fetch("/api/workers/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workerId }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Trigger failed");
      showToast("success", "Worker triggered", workerId);
      setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: ["workers-status"] });
      }, 2000);
    } catch (e) {
      showToast("error", "Worker trigger failed", `${workerId}: ${formatError(e)}`);
    } finally {
      setTriggeringWorker(null);
    }
  };

  const saveRegimeTag = async () => {
    setSavingRegime(true);
    try {
      const res = await fetch("/api/strategies/regime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tag_date: regimeDate,
          regime_tag: regimeTag,
          notes: regimeNotes || null,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Save failed");
      showToast("success", "Regime tag saved", regimeDate);
    } catch (e) {
      showToast("error", "Regime save failed", formatError(e));
    } finally {
      setSavingRegime(false);
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
      await load({ silent: true });
      showToast("success", "Strategy saved", id);
    } catch (e) {
      showToast("error", "Strategy save failed", `${id}: ${formatError(e)}`);
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
      await load({ silent: true });
      showToast(
        "success",
        "Strategy promoted",
        json.message ?? `${sourceId} → ${targetId}`,
      );
    } catch (e) {
      showToast(
        "error",
        "Strategy promote failed",
        `${sourceId} → ${targetId}: ${formatError(e)}`,
      );
    } finally {
      setSaving(null);
    }
  };

  if (loading && !data) {
    return <p className="text-gray-400 text-sm">Loading strategies...</p>;
  }

  if (loadError && !data) {
    return (
      <div className="text-red-400 text-sm">
        {loadError}
        <button type="button" onClick={() => void load()} className="ml-3 underline text-red-300">
          Retry
        </button>
      </div>
    );
  }

  const effective = data?.trending_bot?.effective ?? {};
  const active = data?.trending_bot?.active ?? [];
  const signals = Object.values(data?.signals?.effective ?? {});
  const mcapTracker = Object.values(data?.mcap_tracker?.effective ?? {});
  const gmgn = Object.values(data?.gmgn?.effective ?? {});
  const social = Object.values(data?.social?.effective ?? {});
  const dlmm = data?.dlmm?.effective;

  return (
    <div className="space-y-6">
      <AdminToastBanner toast={toast} onDismiss={dismissToast} />
      <ScrollableMenuRow className="border-b border-gray-700 pb-2">
        <button
          type="button"
          onClick={() => switchTab("config")}
          className={`shrink-0 px-4 py-2 text-sm rounded-t ${tab === "config" ? "bg-gray-800 text-white" : "text-gray-400"}`}
        >
          Config
        </button>
        <button
          type="button"
          onClick={() => switchTab("reports")}
          className={`shrink-0 px-4 py-2 text-sm rounded-t ${tab === "reports" ? "bg-gray-800 text-white" : "text-gray-400"}`}
        >
          Reports (A/B)
        </button>
        <button
          type="button"
          onClick={() => switchTab("review")}
          className={`shrink-0 px-4 py-2 text-sm rounded-t ${tab === "review" ? "bg-gray-800 text-white" : "text-gray-400"}`}
        >
          Review
        </button>
        <button
          type="button"
          onClick={() => switchTab("workers")}
          className={`shrink-0 px-4 py-2 text-sm rounded-t ${tab === "workers" ? "bg-gray-800 text-white" : "text-gray-400"}`}
        >
          Workers
        </button>
      </ScrollableMenuRow>

      {tab === "config" && (
        <>
          <Ml2ExitOverlayPanel
            onNotify={(kind, title, detail) =>
              showToast(kind, title, detail ?? "")
            }
          />

          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-2">Trending bot</h2>
            <p className="text-gray-400 text-sm mb-4">
              Active: {active.join(", ") || "none"} · Pre-filter uses union of active bands.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {Object.values(effective).map((s) => (
                <TrendingBotCard
                  key={`${s.id}-${s.is_active}-${s.buy_amount_sol}-${s.stop_loss_percentage}-${s.take_profit_levels.tp1_percentage}`}
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
            <h2 className="text-xl font-bold text-white mb-4">MCap tracker strategies</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {mcapTracker.map((s) => (
                <McapTrackerCard
                  key={s.id}
                  strategy={s}
                  saving={saving === s.id}
                  onSave={saveStrategy}
                />
              ))}
            </div>
            <Link
              href="/dev/signals?tab=tracker"
              className="text-blue-400 text-sm underline mt-3 inline-block"
            >
              Open MCap tracker tab
            </Link>
          </section>

          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">GMGN strategies</h2>
            <p className="text-gray-400 text-sm mb-4">
              Smart money / KOL discovery via gmgn-cli. Paper sim wallet:{" "}
              <code className="text-xs">gmgn-sim</code>. Requires GMGN_API_KEY + gmgn-cli on server.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              {gmgn.map((s) => (
                <GmgnCard
                  key={`${s.id}-${s.is_active}-${s.execution_mode}-${s.config.radar?.stickyPumpPct}-${s.config.radar?.dumpBanPct}-${s.config.radar?.comeback?.allowSimReopen}-${s.config.radar?.telegram?.singleThread}-${s.config.radar?.telegram?.minMcapUsd}`}
                  strategy={s}
                  saving={saving === s.id}
                  onSave={saveStrategy}
                />
              ))}
            </div>
          </section>

          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">Social strategies</h2>
            {isRobinhood ? (
              <p className="text-gray-400 text-sm">
                Not available on Robinhood — social ingest only resolves Solana
                mints, so there is no Robinhood candidate feed yet.
              </p>
            ) : (
              <>
                <p className="text-gray-400 text-sm mb-4">
                  Social-only FOMO entry when a token is present only on{" "}
                  <code className="text-xs">social_token_rollups</code> with FOMO mentions &gt;7 in 30m.
                  Paper wallet: <code className="text-xs">social-sim</code>.
                </p>
                <div className="grid gap-4 md:grid-cols-2">
                  {social.map((s) => (
                    <SocialCard
                      key={`${s.id}-${s.is_active}-${s.execution_mode}-${s.config.entry.minMentions30m}`}
                      strategy={s}
                      saving={saving === s.id}
                      onSave={saveStrategy}
                    />
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <h2 className="text-xl font-bold text-white mb-4">DLMM thresholds</h2>
            {isRobinhood ? (
              <p className="text-gray-400 text-sm">
                Not available on Robinhood — the LP agent is Meteora-specific.
                Robinhood LP lives on the{" "}
                <Link href="/dev/dlmm" className="text-blue-400 underline">
                  DLMM dashboard
                </Link>{" "}
                instead.
              </p>
            ) : (
              <>
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
              </>
            )}
          </section>
        </>
      )}

      {tab === "reports" && (
        <>
          <p className="text-gray-400 text-sm mb-4">
            Reports and the ML feed below show{" "}
            <span className="text-white">closed trades</span> from{" "}
            <code className="text-xs">strategy_outcomes</code>. Open positions
            (still holding) appear in{" "}
            <Link href="/dev/algo-tester" className="text-blue-400 underline">
              Algo tester
            </Link>{" "}
            until fully closed — counts will not match 1:1.
          </p>
          <section className="bg-gray-900 border border-gray-700 rounded-lg p-6">
            <div className="flex flex-wrap gap-3 mb-4 text-sm">
              {reportsPollingActive ? (
                <span className="inline-flex items-center gap-1.5 self-end rounded-full border border-emerald-800/60 bg-emerald-950/40 px-2 py-1 text-xs text-emerald-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                  Live
                </span>
              ) : null}
              {strategiesQuery.dataUpdatedAt ? (
                <span className="self-end pb-1.5 text-xs text-gray-500">
                  Updated{" "}
                  {formatRelativeTime(
                    new Date(strategiesQuery.dataUpdatedAt),
                    now,
                  )}
                </span>
              ) : null}
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
                Timezone
                <select
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                  value={reportTz}
                  onChange={(e) => setReportTz(e.target.value)}
                >
                  <option value="Asia/Bangkok">Asia/Bangkok</option>
                  <option value="UTC">UTC</option>
                </select>
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
                  <option value="mcap_tracker">MCap tracker</option>
                  <option value="gmgn">GMGN</option>
                  <option value="social">Social</option>
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
              <label className="text-gray-400">
                ML label
                <select
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white min-w-[120px]"
                  value={reportMlLabel}
                  onChange={(e) => {
                    setReportMlLabel(e.target.value);
                    setOutcomesOffset(0);
                  }}
                >
                  <option value="">Any</option>
                  <option value="unlabeled">Unlabeled</option>
                  <option value="skip">Skip</option>
                  <option value="interesting">Interesting</option>
                  <option value="anomaly">Anomaly</option>
                </select>
              </label>
              <label className="text-gray-400">
                Condition
                <select
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white min-w-[140px]"
                  value={reportMlCondition}
                  onChange={(e) => {
                    setReportMlCondition(e.target.value);
                    setOutcomesOffset(0);
                  }}
                >
                  <option value="">Any</option>
                  <option value="none">None</option>
                  <option value="old_chart">Old Chart</option>
                  <option value="price_topped">Price Topped</option>
                  <option value="new_chart">New Chart</option>
                </select>
              </label>
              <label className="text-gray-400">
                Status
                <select
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white min-w-[100px]"
                  value={reportStatus}
                  onChange={(e) => {
                    setReportStatus(e.target.value);
                    setOutcomesOffset(0);
                  }}
                >
                  <option value="">Any</option>
                  <option value="won">Won</option>
                  <option value="lost">Lost</option>
                </select>
              </label>
              <label className="text-gray-400">
                PnL
                <select
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white min-w-[140px]"
                  value={reportPnlFilter}
                  onChange={(e) => {
                    setReportPnlFilter(e.target.value);
                    setOutcomesOffset(0);
                  }}
                >
                  <option value="">Any</option>
                  <option value="win">Win (≥0%)</option>
                  <option value="loss">Loss (&lt;0%)</option>
                  <option value="strong_win">Strong win (≥50%)</option>
                  <option value="heavy_loss">Heavy loss (≤-30%)</option>
                </select>
              </label>
              <label className="text-gray-400">
                Entry mcap
                <select
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white min-w-[140px]"
                  value={reportEntryMcapBand}
                  onChange={(e) => {
                    setReportEntryMcapBand(e.target.value);
                    setOutcomesOffset(0);
                  }}
                >
                  <option value="">Any</option>
                  {ENTRY_MCAP_BAND_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                onClick={() => void load()}
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
                  reportMlLabel,
                  reportMlCondition,
                  reportStatus,
                  reportPnlFilter,
                  reportEntryMcapBand,
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
                    <th className="p-2">Open positions</th>
                    <th className="p-2">Last exit</th>
                    <th className="p-2">Avg PnL (SIM)</th>
                    <th className="p-2">ML unlabeled</th>
                    <th className="p-2">ML labeled</th>
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
                      <td className="p-2">
                        {c.domain === "trending_bot" || c.domain === "mcap_tracker"
                          ? c.open_tracker_count ?? 0
                          : "—"}
                      </td>
                      <td className="p-2">{formatAppDateTime(c.last_exit_at) || "—"}</td>
                      <td className="p-2">
                        {c.avg_pnl_pct != null ? `${c.avg_pnl_pct.toFixed(2)}%` : "—"}
                      </td>
                      <td className="p-2">{c.ml_unlabeled ?? 0}</td>
                      <td className="p-2">{c.ml_labeled ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {reports?.ml_stats && reports.ml_stats.total > 0 && (
              <>
                <h3 className="text-lg font-semibold text-white mb-2">ML labeling</h3>
                <p className="text-gray-400 text-xs mb-2">
                  Filter-scoped closed outcomes. Unlabeled: {reports.ml_stats.unlabeled} of{" "}
                  {reports.ml_stats.total}
                  {Object.keys(reports.ml_stats.by_label).length > 0 && (
                    <>
                      {" "}
                      · Labels:{" "}
                      {Object.entries(reports.ml_stats.by_label)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(", ")}
                    </>
                  )}
                  {Object.keys(reports.ml_stats.by_condition).length > 0 && (
                    <>
                      {" "}
                      · Conditions:{" "}
                      {Object.entries(reports.ml_stats.by_condition)
                        .map(([k, v]) => `${k} ${v}`)
                        .join(", ")}
                    </>
                  )}
                </p>
              </>
            )}

            <h3 className="text-lg font-semibold text-white mb-2">Market regime</h3>
            <p className="text-gray-500 text-xs mb-3">
              Tag daily context for ML (attached to new outcomes as regime_tag_at_exit).
            </p>
            <div className="flex flex-wrap gap-3 mb-6 items-end">
              <label className="text-gray-400 text-xs">
                Date
                <input
                  type="date"
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                  value={regimeDate}
                  onChange={(e) => setRegimeDate(e.target.value)}
                />
              </label>
              <label className="text-gray-400 text-xs">
                Regime
                <select
                  className="block mt-1 bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white min-w-[200px]"
                  value={regimeTag}
                  onChange={(e) => setRegimeTag(e.target.value)}
                >
                  <option value="high_vol_meme">High vol / memecoin season</option>
                  <option value="low_vol_consolidation">Low vol / consolidation</option>
                  <option value="btc_correlation">Trending BTC correlation</option>
                  <option value="custom">Custom (edit notes)</option>
                </select>
              </label>
              <label className="text-gray-400 text-xs flex-1 min-w-[200px]">
                Notes
                <input
                  type="text"
                  className="block mt-1 w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white"
                  value={regimeNotes}
                  onChange={(e) => setRegimeNotes(e.target.value)}
                  placeholder="Optional context"
                />
              </label>
              <button
                type="button"
                disabled={savingRegime}
                onClick={() => void saveRegimeTag()}
                className="px-3 py-1.5 bg-blue-600 disabled:opacity-50 rounded text-white text-xs"
              >
                {savingRegime ? "Saving…" : "Save regime"}
              </button>
            </div>

            <h3 className="text-lg font-semibold text-white mb-2">MCap tracker sim outcomes</h3>
            <p className="text-gray-500 text-xs mb-2">
              Paper trades from{" "}
              <Link href="/dev/signals?tab=tracker" className="text-blue-400 underline">
                mcap tracking
              </Link>
              , enriched with 80/120/200% milestone reach. PnL uses mcap growth at close.
              {reports?.mcap_tracker_stats?.timeline_inconsistent_count != null &&
              reports.mcap_tracker_stats.timeline_inconsistent_count > 0 ? (
                <>
                  {" "}
                  Timeline inconsistencies in DB:{" "}
                  {reports.mcap_tracker_stats.timeline_inconsistent_count} row(s) — run SQL repair
                  patch.
                </>
              ) : null}
            </p>
            {reports?.mcap_tracker_stats ? (
              <>
                <p className="text-gray-400 text-xs mb-3">
                  Tracked tokens: {reports.mcap_tracker_stats.total_tracked_tokens}
                </p>
                {reports.mcap_tracker_stats.strategies.length > 0 && (
                  <table className="w-full text-sm mb-4">
                    <thead>
                      <tr className="text-gray-400 border-b border-gray-700">
                        <th className="p-2 text-left">Strategy</th>
                        <th className="p-2">Trades</th>
                        <th className="p-2">WR</th>
                        <th className="p-2">Avg PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reports.mcap_tracker_stats.strategies.map((s: ReportBreakdown) => (
                        <tr
                          key={s.strategy_id}
                          className="border-b border-gray-800 text-gray-300"
                        >
                          <td className="p-2">{s.strategy_id}</td>
                          <td className="p-2 text-center">{s.trade_count}</td>
                          <td className="p-2 text-center">
                            {(s.win_rate * 100).toFixed(1)}%
                          </td>
                          <td className="p-2 text-center">{s.avg_pnl_pct.toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <table className="w-full text-sm mb-6">
                  <thead>
                    <tr className="text-gray-400 border-b border-gray-700">
                      <th className="p-2 text-left">Milestone bucket</th>
                      <th className="p-2">Trades</th>
                      <th className="p-2">WR</th>
                      <th className="p-2">Avg PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.mcap_tracker_stats.milestone_buckets.map((b: McapTrackerMilestoneBucket) => (
                      <tr
                        key={b.bucket}
                        className="border-b border-gray-800 text-gray-300"
                      >
                        <td className="p-2">{b.label}</td>
                        <td className="p-2 text-center">{b.trade_count}</td>
                        <td className="p-2 text-center">
                          {(b.win_rate * 100).toFixed(1)}%
                        </td>
                        <td className="p-2 text-center">{b.avg_pnl_pct.toFixed(2)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(reports.mcap_tracker_stats.open_sim_positions?.length ?? 0) >
                0 ? (
                  <>
                    <h4 className="text-sm font-semibold text-white mb-2">
                      Open sim positions (not yet in outcomes)
                    </h4>
                    <table className="w-full text-sm mb-6">
                      <thead>
                        <tr className="text-gray-400 border-b border-gray-700">
                          <th className="p-2 text-left">Strategy</th>
                          <th className="p-2 text-left">Token</th>
                          <th className="p-2">Entry mcap</th>
                          <th className="p-2">Current mcap</th>
                          <th className="p-2">Unrealized PnL</th>
                          <th className="p-2">Entry at</th>
                        </tr>
                      </thead>
                      <tbody>
                        {reports.mcap_tracker_stats.open_sim_positions!.map(
                          (p: McapOpenSimReportRow) => (
                            <tr
                              key={`${p.strategy_id}-${p.token_address}`}
                              className="border-b border-gray-800 text-gray-300"
                            >
                              <td className="p-2">{p.strategy_id}</td>
                              <td className="p-2">
                                <Link
                                  href={`/dev/signals?tab=tracker&search=${encodeURIComponent(p.token_address)}`}
                                  className="text-blue-400 underline"
                                >
                                  {p.token_symbol || p.token_address.slice(0, 8)}
                                </Link>
                              </td>
                              <td className="p-2 text-center">
                                {p.entry_mcap.toLocaleString()}
                              </td>
                              <td className="p-2 text-center">
                                {p.current_mcap != null
                                  ? p.current_mcap.toLocaleString()
                                  : "—"}
                              </td>
                              <td className="p-2 text-center">
                                {p.unrealized_pnl_pct != null
                                  ? `${p.unrealized_pnl_pct.toFixed(2)}%`
                                  : "—"}
                              </td>
                              <td className="p-2">
                                {formatAppDateTime(p.entry_at) || "—"}
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <p className="text-gray-500 text-xs mb-6">
                    No open mcap sim positions — tracked tokens appear here after
                    the sim worker opens a paper trade, before close writes an
                    outcome.
                  </p>
                )}
              </>
            ) : (
              <p className="text-gray-500 text-sm mb-6">No mcap tracker stats yet.</p>
            )}

            <h3 className="text-lg font-semibold text-white mb-2">A/B comparison</h3>
            <p className="text-gray-500 text-xs mb-2">
              Signals and DLMM honor per-strategy execution_mode. MCap tracker sim
              results are in the section above (not A/B). Trending bot uses global
              keypair for live; ab_parallel does not dual-buy on trending. Only
              signals/DLMM strategies appear below.
            </p>
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
                    <tr key={`${p.domain}-${p.strategy_id}`} className="border-b border-gray-800 text-gray-300">
                      <td className="p-2">
                        {p.domain}/{p.strategy_id}
                      </td>
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

            <h3 className="text-lg font-semibold text-white mb-2">
              Ranking by avg PnL (n≥10)
            </h3>
            <ul className="text-sm text-gray-300 mb-6 space-y-1">
              {(reports?.ranking ?? []).slice(0, 10).map((r: ReportBreakdown) => (
                <li key={`${r.domain}-${r.strategy_id}-${r.is_simulated}`}>
                  {r.domain}/{r.strategy_id} [{r.is_simulated ? "SIM" : "LIVE"}]: avg{" "}
                  {r.avg_pnl_pct.toFixed(2)}%, WR {(r.win_rate * 100).toFixed(1)}% (
                  {r.trade_count} trades)
                </li>
              ))}
            </ul>

            <h3 className="text-lg font-semibold text-white mb-2">
              Best trade windows ({reports?.timezone ?? reportTz})
            </h3>
            <ul className="text-sm text-gray-300 mb-6 space-y-1">
              {(reports?.best_trade_windows ?? [])
                .filter((w) => w.best)
                .slice(0, 20)
                .map((w) => {
                  const b = w.best!;
                  const pad = (n: number) => String(n).padStart(2, "0");
                  const range = `${pad(b.start_hour)}:00–${pad(b.end_hour)}:00`;
                  const avg = `${b.avg_pnl_pct >= 0 ? "+" : ""}${b.avg_pnl_pct.toFixed(0)}%`;
                  return (
                    <li
                      key={`${w.domain}-${w.strategy_id}-${w.is_simulated}`}
                    >
                      {w.strategy_id} [{w.is_simulated ? "SIM" : "LIVE"}] · {range} ·
                      avg {avg} · n={b.trade_count}
                    </li>
                  );
                })}
              {(reports?.best_trade_windows ?? []).filter((w) => w.best).length ===
                0 && (
                <li className="text-gray-500">
                  No windows with ≥5 trades yet (need enough closed outcomes by
                  entry hour).
                </li>
              )}
            </ul>
          </section>

          <section className="relative bg-gray-900 border border-gray-700 rounded-lg p-6">
            {backfillPhase === "running" && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center rounded-lg bg-gray-950/80">
                <div className="w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full animate-spin mb-3" />
                <p className="text-sm text-white">Backfilling ML labels…</p>
              </div>
            )}
            <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
              <h2 className="text-xl font-bold text-white">Outcomes (ML feed)</h2>
              <button
                type="button"
                disabled={backfillPhase !== "idle"}
                onClick={() => void backfillAutoLabels()}
                className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 disabled:opacity-40 text-white text-xs rounded"
                title="Recompute skip/interesting and training_class 0–4 on stored outcomes (respects current domain/strategy filters)"
              >
                {backfillPhase === "preview"
                  ? "Loading preview…"
                  : backfillPhase === "running"
                    ? "Backfilling…"
                    : "Backfill auto labels"}
              </button>
            </div>
            <p className="text-gray-500 text-xs mb-4">
              Closed trades only — partial TP sells stay open in Algo tester until 100% sold.
              {" "}
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
                        <th className="p-2">Entry MCap</th>
                        {showEntryFeatureColumns && (
                          <>
                            <th className="p-2">Organic</th>
                            <th className="p-2">Holders%</th>
                            <th className="p-2">Age(h)</th>
                            <th className="p-2">Vol@entry</th>
                            <th
                              className="p-2"
                              title="Price/volume/mcap snapshots recorded while the position was open"
                            >
                              Track samples
                            </th>
                          </>
                        )}
                        <th className="p-2">Entry</th>
                        <th className="p-2">Exit</th>
                        <th className="p-2">PnL%</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">ML</th>
                        <th className="p-2" title="Pattern-gate shadow score at entry">
                          Pattern ML
                        </th>
                        <th className="p-2" title="Sim-outcome gate p_bad at entry">
                          Gate
                        </th>
                        <th className="p-2" title="ML2 potential tier / moon score">
                          Potential
                        </th>
                        <th
                          className="p-2"
                          title="ML2 exit overlay base→effective TP/SL (shadow or apply)"
                        >
                          Exit TP/SL
                        </th>
                        <th className="p-2" title="24h mcap growth cohort if token appears in pattern DB">
                          24h cohort
                        </th>
                        <th className="p-2">Condition</th>
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
                          <td className="p-2">
                            <div className="font-semibold text-white">
                              {readTokenSymbol(o.features) || "Unknown"}
                            </div>
                            <div className="text-xs text-gray-400 font-mono">
                              {o.token_address
                                ? `${o.token_address.slice(0, 8)}…`
                                : "—"}
                            </div>
                          </td>
                          <td className="p-2">
                            {formatEntryMcap(readEntryMcap(o.features))}
                          </td>
                          {showEntryFeatureColumns && (
                            <>
                              <td className="p-2">
                                {readOrganicScore(o.features) ?? "—"}
                              </td>
                              <td className="p-2">
                                {readTopHoldersPct(o.features) != null
                                  ? `${readTopHoldersPct(o.features)}%`
                                  : "—"}
                              </td>
                              <td className="p-2">
                                {readTokenAgeHours(o.features) ?? "—"}
                              </td>
                              <td className="p-2">
                                {readVolumeAtEntry(o.features) != null
                                  ? Math.round(readVolumeAtEntry(o.features)!)
                                  : "—"}
                              </td>
                              <td className="p-2">
                                {readMonitorSnapshotCount(o.features) || "—"}
                              </td>
                            </>
                          )}
                          <td className="p-2">{formatAppDateTime(o.entry_at)}</td>
                          <td className="p-2">{formatAppDateTime(o.exit_at)}</td>
                          <td className="p-2">
                            {o.pnl_pct != null ? `${Number(o.pnl_pct).toFixed(2)}%` : "—"}
                          </td>
                          <td className="p-2">{o.status ?? "—"}</td>
                          <td className="p-2" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center gap-1 flex-wrap">
                              <OutcomeMlBadge features={o.features} />
                              <select
                                value={
                                  readTrainingClass(o.features) != null
                                    ? String(readTrainingClass(o.features))
                                    : ""
                                }
                                disabled={
                                  backfillPhase === "running" ||
                                  patchingClassId === o.id
                                }
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  void handleTrainingClassChange(o, idx, e.target.value);
                                }}
                                className="bg-gray-800 border border-gray-600 text-xs text-gray-200 rounded px-1 py-0.5 max-w-[4rem] disabled:opacity-50"
                                title="Training class (manual override)"
                              >
                                <option value="">—</option>
                                {TRAINING_CLASS_OPTIONS.map((opt) => (
                                  <option key={opt.value} value={opt.value} title={opt.title}>
                                    {opt.label}
                                  </option>
                                ))}
                              </select>
                              {patchingClassId === o.id && (
                                <span className="inline-block w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin" />
                              )}
                            </div>
                          </td>
                          <td className="p-2">
                            <OutcomePatternMlBadge features={o.features} />
                          </td>
                          <td className="p-2">
                            <OutcomeGateMlBadge features={o.features} />
                          </td>
                          <td className="p-2">
                            <OutcomePotentialMlBadge features={o.features} />
                          </td>
                          <td className="p-2">
                            <OutcomeExitOverlayBadge features={o.features} />
                          </td>
                          <td className="p-2">
                            {o.token_address &&
                            patternCohortQuery.data?.get(o.token_address) ? (
                              <span
                                className={
                                  patternCohortQuery.data.get(o.token_address) ===
                                  "winner"
                                    ? "text-emerald-400"
                                    : "text-red-400"
                                }
                              >
                                {patternCohortQuery.data.get(o.token_address)}
                              </span>
                            ) : (
                              <span className="text-gray-600">—</span>
                            )}
                          </td>
                          <td className="p-2">
                            <OutcomeMlConditionBadge features={o.features} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-wrap items-center gap-2 mt-4">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowEntryFeatureColumns((v) => !v);
                    }}
                    className="px-3 py-1.5 bg-gray-700 text-white text-xs rounded"
                  >
                    {showEntryFeatureColumns
                      ? "Hide entry features"
                      : "Show entry features"}
                  </button>
                  <button
                    type="button"
                    disabled={outcomesOffset <= 0 || backfillPhase === "running"}
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
                    disabled={
                      outcomesOffset + OUTCOMES_PAGE_SIZE >= outcomesTotal ||
                      backfillPhase === "running"
                    }
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

      {tab === "review" && <StrategyReviewPanel />}

      {tab === "workers" && (
        <WorkersTab
          data={workersQuery.data}
          loading={workersQuery.isLoading}
          error={workersQuery.error}
          onRefresh={() => void refreshWorkers()}
          triggeringWorker={triggeringWorker}
          onRunNow={runWorkerNow}
        />
      )}

      {selectedOutcome && (
        <OutcomeReviewModal
          key={selectedOutcome.id}
          outcome={selectedOutcome}
          onClose={() => setSelectedOutcomeIndex(null)}
          onNotify={(kind, title, detail) => showToast(kind, title, detail)}
          onSaved={(updated) => {
            updateOutcomeInCache(updated, selectedOutcomeIndex ?? undefined);
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
  onRunNow,
}: {
  data: WorkersStatusResponse | undefined;
  loading: boolean;
  error: unknown;
  onRefresh: () => void;
  triggeringWorker: string | null;
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
          DLMM may show manage activity or worker run when no closes exist yet.
        </p>
        <ul className="text-sm text-gray-300 space-y-1">
          {(data?.domain_heartbeat ?? []).map((h) => (
            <li key={h.domain}>
              <span className="text-gray-400">{h.domain}:</span>{" "}
              {h.last_outcome_at ? (
                <>
                  {formatAppDateTime(h.last_outcome_at)}
                  <span className="text-gray-500">
                    {heartbeatSourceLabel(h.heartbeat_source)}
                  </span>
                </>
              ) : (
                "no activity yet"
              )}
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
  const [execMode, setExecMode] = useState<ExecutionMode>(
    strategy.execution_mode ?? "sim_only",
  );
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
          onClick={() =>
            toggleActiveWithNotifySync(strategy.id, strategy.is_active, onSave)
          }
          className="px-3 py-1.5 bg-gray-700 text-white text-xs rounded"
        >
          {strategy.is_active ? "Deactivate" : "Activate"}
        </button>
        <StrategyNotifyBar
          strategyId={strategy.id}
          notify={strategy.notify}
          saving={saving}
          onSave={onSave}
        />
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
          onClick={() =>
            toggleActiveWithNotifySync(strategy.id, strategy.is_active, onSave)
          }
          className="px-3 py-1.5 bg-gray-700 text-white text-xs rounded"
        >
          {strategy.is_active ? "Deactivate" : "Activate"}
        </button>
        <StrategyNotifyBar
          strategyId={strategy.id}
          notify={strategy.config.notify}
          saving={saving}
          onSave={onSave}
        />
      </div>
    </div>
  );
}

function McapTrackerCard({
  strategy,
  saving,
  onSave,
}: {
  strategy: McapTrackerStrategy;
  saving: boolean;
  onSave: (id: string, patch: Record<string, unknown>) => void;
}) {
  const q = strategy.config.query;
  const e = strategy.config.execution;
  const x = strategy.config.exit;
  const en = strategy.config.entry;
  const [entryTemplate, setEntryTemplate] = useState(strategy.config.entryTemplate);
  const [recency, setRecency] = useState(String(q.recencyMinutes));
  const [limit, setLimit] = useState(String(q.limit ?? 300));
  const [simBuy, setSimBuy] = useState(String(e.simBuySol));
  const [maxOpen, setMaxOpen] = useState(String(e.maxOpenPositions));
  const [stopLoss, setStopLoss] = useState(String(x.stopLossPct));
  const [takeProfit, setTakeProfit] = useState(String(x.takeProfitPct));
  const [maxHold, setMaxHold] = useState(String(x.maxHoldHours));
  const [mcapMin, setMcapMin] = useState(String(en.mcapMin));
  const [mcapMax, setMcapMax] = useState(String(en.mcapMax));
  const [organicMin, setOrganicMin] = useState(
    en.organicScoreMin != null ? String(en.organicScoreMin) : "",
  );
  const [holdersMax, setHoldersMax] = useState(
    en.topHoldersPctMax != null ? String(en.topHoldersPctMax) : "",
  );
  const [execMode, setExecMode] = useState(strategy.execution_mode);

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800">
      <h3 className="font-semibold text-white">{strategy.name}</h3>
      <p className="text-xs text-gray-500 mb-3">
        {strategy.id} · {entryTemplate}
      </p>
      <label className="text-xs text-gray-400 block mb-2">
        Execution mode
        <ExecutionModeSelect value={execMode} onChange={setExecMode} />
      </label>
      <label className="text-xs text-gray-400 block mb-2">
        Entry template
        <select
          className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs"
          value={entryTemplate}
          onChange={(ev) =>
            setEntryTemplate(ev.target.value as "first_seen" | "milestone_80")
          }
        >
          <option value="first_seen">first_seen</option>
          <option value="milestone_80">milestone_80</option>
        </select>
      </label>
      <Section title="Query">
        <FieldGrid>
          <NumberField label="recency (min)" value={recency} onChange={setRecency} step="1" />
          <NumberField label="limit" value={limit} onChange={setLimit} step="1" />
        </FieldGrid>
      </Section>
      <Section title="Execution">
        <FieldGrid>
          <NumberField label="sim buy SOL" value={simBuy} onChange={setSimBuy} step="0.001" />
          <NumberField label="max open" value={maxOpen} onChange={setMaxOpen} step="1" />
        </FieldGrid>
      </Section>
      <Section title="Exit">
        <FieldGrid>
          <NumberField label="stop loss %" value={stopLoss} onChange={setStopLoss} step="1" />
          <NumberField label="take profit %" value={takeProfit} onChange={setTakeProfit} step="1" />
          <NumberField label="max hold (h)" value={maxHold} onChange={setMaxHold} step="1" />
        </FieldGrid>
      </Section>
      <Section title="Entry filters">
        <FieldGrid>
          <NumberField label="mcap min" value={mcapMin} onChange={setMcapMin} step="1000" />
          <NumberField label="mcap max" value={mcapMax} onChange={setMcapMax} step="1000" />
          <NumberField label="organic min" value={organicMin} onChange={setOrganicMin} step="1" />
          <NumberField label="holders max %" value={holdersMax} onChange={setHoldersMax} step="1" />
        </FieldGrid>
      </Section>
      <div className="flex gap-2 mt-2">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            onSave(strategy.id, {
              execution_mode: execMode,
              config: {
                entryTemplate,
                query: {
                  recencyMinutes: parseInt(recency, 10),
                  limit: parseInt(limit, 10),
                },
                execution: {
                  simBuySol: parseFloat(simBuy),
                  maxOpenPositions: parseInt(maxOpen, 10),
                },
                exit: {
                  stopLossPct: parseFloat(stopLoss),
                  takeProfitPct: parseFloat(takeProfit),
                  maxHoldHours: parseFloat(maxHold),
                },
                entry: {
                  mcapMin: parseFloat(mcapMin),
                  mcapMax: parseFloat(mcapMax),
                  organicScoreMin: organicMin ? parseFloat(organicMin) : undefined,
                  topHoldersPctMax: holdersMax ? parseFloat(holdersMax) : undefined,
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
          onClick={() =>
            toggleActiveWithNotifySync(strategy.id, strategy.is_active, onSave)
          }
          className="px-3 py-1.5 bg-gray-700 text-white text-xs rounded"
        >
          {strategy.is_active ? "Deactivate" : "Activate"}
        </button>
        <StrategyNotifyBar
          strategyId={strategy.id}
          notify={strategy.config.notify}
          saving={saving}
          onSave={onSave}
        />
      </div>
    </div>
  );
}

function GmgnCard({
  strategy,
  saving,
  onSave,
}: {
  strategy: GmgnStrategy;
  saving: boolean;
  onSave: (id: string, patch: Record<string, unknown>) => void;
}) {
  const d = strategy.config.discovery;
  const s = strategy.config.security;
  const e = strategy.config.execution;
  const x = strategy.config.exit;
  const r = strategy.config.radar ?? DEFAULT_GMGN_RADAR;
  const [source, setSource] = useState(d.source);
  const [limit, setLimit] = useState(String(d.limit));
  const [minUsd, setMinUsd] = useState(d.minAmountUsd != null ? String(d.minAmountUsd) : "");
  const [maxAge, setMaxAge] = useState(String(d.maxTradeAgeMinutes));
  const [clusterMin, setClusterMin] = useState(
    d.clusterMinWallets != null ? String(d.clusterMinWallets) : "",
  );
  const [simBuy, setSimBuy] = useState(String(e.simBuySol));
  const [maxOpen, setMaxOpen] = useState(String(e.maxOpenPositions));
  const [stopLoss, setStopLoss] = useState(String(x.stopLossPct));
  const [takeProfit, setTakeProfit] = useState(String(x.takeProfitPct));
  const [maxHold, setMaxHold] = useState(String(x.maxHoldHours));
  const [minSmart, setMinSmart] = useState(String(s.minSmartWallets));
  const [maxTop10, setMaxTop10] = useState(String(s.maxTop10HolderRate));
  const [minLiq, setMinLiq] = useState(String(s.minLiquidityUsd));
  const [maxCandidates, setMaxCandidates] = useState(String(s.maxCandidatesPerTick));
  const [execMode, setExecMode] = useState(strategy.execution_mode);
  const [stickyPumpPct, setStickyPumpPct] = useState(String(r.stickyPumpPct));
  const [dumpBanPct, setDumpBanPct] = useState(String(r.dumpBanPct));
  const [stickyTtlMinutes, setStickyTtlMinutes] = useState(
    String(r.stickyTtlMinutes ?? DEFAULT_GMGN_RADAR.stickyTtlMinutes),
  );
  const [enterOverrideMinScore, setEnterOverrideMinScore] = useState(
    String(r.enterOverrideMinScore ?? DEFAULT_GMGN_RADAR.enterOverrideMinScore),
  );
  const [comebackEnabled, setComebackEnabled] = useState(r.comeback.enabled);
  const [drawdownPct, setDrawdownPct] = useState(String(r.comeback.drawdownPct));
  const [troughMcapMax, setTroughMcapMax] = useState(String(r.comeback.troughMcapMax));
  const [recoverMultiple, setRecoverMultiple] = useState(String(r.comeback.recoverMultiple));
  const [minRadarScore, setMinRadarScore] = useState(String(r.comeback.minRadarScore));
  const [unbanOnComeback, setUnbanOnComeback] = useState(r.comeback.unbanOnComeback);
  const [allowSimReopen, setAllowSimReopen] = useState(r.comeback.allowSimReopen);
  const [singleThread, setSingleThread] = useState(r.telegram.singleThread);
  const [minTelegramMcapUsd, setMinTelegramMcapUsd] = useState(
    String(r.telegram.minMcapUsd ?? DEFAULT_GMGN_RADAR.telegram.minMcapUsd),
  );

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800">
      <h3 className="font-semibold text-white">{strategy.name}</h3>
      <p className="text-xs text-gray-500 mb-3">
        {strategy.id} · {source}
      </p>
      <label className="text-xs text-gray-400 block mb-2">
        Execution mode
        <ExecutionModeSelect value={execMode} onChange={setExecMode} />
      </label>
      <label className="text-xs text-gray-400 block mb-2">
        Discovery source
        <select
          className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white text-xs"
          value={source}
          onChange={(ev) =>
            setSource(ev.target.value as "smartmoney" | "kol" | "both")
          }
        >
          <option value="smartmoney">smartmoney</option>
          <option value="kol">kol</option>
          <option value="both">both</option>
        </select>
      </label>
      <Section title="Discovery">
        <FieldGrid>
          <NumberField label="limit" value={limit} onChange={setLimit} step="1" />
          <NumberField label="min trade USD" value={minUsd} onChange={setMinUsd} step="1" />
          <NumberField label="max age (min)" value={maxAge} onChange={setMaxAge} step="1" />
          <NumberField label="cluster min wallets" value={clusterMin} onChange={setClusterMin} step="1" />
        </FieldGrid>
      </Section>
      <Section title="Security gate">
        <FieldGrid>
          <NumberField label="min smart wallets" value={minSmart} onChange={setMinSmart} step="1" />
          <NumberField label="max top-10 rate" value={maxTop10} onChange={setMaxTop10} step="0.01" />
          <NumberField label="min liquidity USD" value={minLiq} onChange={setMinLiq} step="1000" />
          <NumberField label="max candidates/tick" value={maxCandidates} onChange={setMaxCandidates} step="1" />
        </FieldGrid>
      </Section>
      <Section title="Execution">
        <FieldGrid>
          <NumberField label="sim buy SOL" value={simBuy} onChange={setSimBuy} step="0.001" />
          <NumberField label="max open" value={maxOpen} onChange={setMaxOpen} step="1" />
        </FieldGrid>
      </Section>
      <Section title="Exit">
        <FieldGrid>
          <NumberField label="stop loss %" value={stopLoss} onChange={setStopLoss} step="1" />
          <NumberField label="take profit %" value={takeProfit} onChange={setTakeProfit} step="1" />
          <NumberField label="max hold (h)" value={maxHold} onChange={setMaxHold} step="1" />
        </FieldGrid>
      </Section>
      <Section title="Radar">
        <FieldGrid>
          <NumberField
            label="sticky pump %"
            value={stickyPumpPct}
            onChange={setStickyPumpPct}
            step="1"
          />
          <NumberField label="dump ban %" value={dumpBanPct} onChange={setDumpBanPct} step="1" />
          <NumberField
            label="sticky TTL (min)"
            value={stickyTtlMinutes}
            onChange={setStickyTtlMinutes}
            step="1"
          />
          <NumberField
            label="ENTER override score ≥"
            value={enterOverrideMinScore}
            onChange={setEnterOverrideMinScore}
            step="1"
          />
          <CheckboxField
            label="comeback enabled"
            checked={comebackEnabled}
            onChange={setComebackEnabled}
          />
          <CheckboxField
            label="Telegram single thread"
            checked={singleThread}
            onChange={setSingleThread}
          />
          <NumberField
            label="Telegram min mcap $"
            value={minTelegramMcapUsd}
            onChange={setMinTelegramMcapUsd}
            step="1000"
          />
          <NumberField label="drawdown %" value={drawdownPct} onChange={setDrawdownPct} step="1" />
          <NumberField
            label="trough mcap max"
            value={troughMcapMax}
            onChange={setTroughMcapMax}
            step="1000"
          />
          <NumberField
            label="recover multiple"
            value={recoverMultiple}
            onChange={setRecoverMultiple}
            step="0.1"
          />
          <NumberField
            label="min radar score"
            value={minRadarScore}
            onChange={setMinRadarScore}
            step="1"
          />
          <CheckboxField
            label="unban on comeback"
            checked={unbanOnComeback}
            onChange={setUnbanOnComeback}
          />
          <CheckboxField
            label="sim reopen on comeback"
            checked={allowSimReopen}
            onChange={setAllowSimReopen}
          />
        </FieldGrid>
      </Section>
      <div className="flex gap-2 mt-2">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            onSave(strategy.id, {
              execution_mode: execMode,
              config: {
                discovery: {
                  source,
                  limit: parseInt(limit, 10),
                  minAmountUsd: minUsd ? parseFloat(minUsd) : undefined,
                  maxTradeAgeMinutes: parseInt(maxAge, 10),
                  clusterMinWallets: clusterMin ? parseInt(clusterMin, 10) : undefined,
                },
                security: {
                  minSmartWallets: parseInt(minSmart, 10),
                  maxTop10HolderRate: parseFloat(maxTop10),
                  minLiquidityUsd: parseFloat(minLiq),
                  maxCandidatesPerTick: parseInt(maxCandidates, 10),
                },
                execution: {
                  simBuySol: parseFloat(simBuy),
                  maxOpenPositions: parseInt(maxOpen, 10),
                },
                exit: {
                  stopLossPct: parseFloat(stopLoss),
                  takeProfitPct: parseFloat(takeProfit),
                  maxHoldHours: parseFloat(maxHold),
                },
                radar: {
                  stickyPumpPct: parseFloat(stickyPumpPct),
                  dumpBanPct: parseFloat(dumpBanPct),
                  stickyTtlMinutes: parseInt(stickyTtlMinutes, 10),
                  enterOverrideMinScore: parseFloat(enterOverrideMinScore),
                  comeback: {
                    enabled: comebackEnabled,
                    drawdownPct: parseFloat(drawdownPct),
                    troughMcapMax: parseFloat(troughMcapMax),
                    recoverMultiple: parseFloat(recoverMultiple),
                    minRadarScore: parseFloat(minRadarScore),
                    unbanOnComeback,
                    allowSimReopen,
                  },
                  telegram: {
                    singleThread,
                    minMcapUsd: parseFloat(minTelegramMcapUsd),
                  },
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
          onClick={() =>
            toggleActiveWithNotifySync(strategy.id, strategy.is_active, onSave)
          }
          className="px-3 py-1.5 bg-gray-700 text-white text-xs rounded"
        >
          {strategy.is_active ? "Deactivate" : "Activate"}
        </button>
        <StrategyNotifyBar
          strategyId={strategy.id}
          notify={strategy.config.notify}
          saving={saving}
          onSave={onSave}
        />
      </div>
    </div>
  );
}

function SocialCard({
  strategy,
  saving,
  onSave,
}: {
  strategy: SocialStrategy;
  saving: boolean;
  onSave: (id: string, patch: Record<string, unknown>) => void;
}) {
  const entry = strategy.config.entry;
  const e = strategy.config.execution;
  const x = strategy.config.exit;
  const [minMentions, setMinMentions] = useState(String(entry.minMentions30m));
  const [topSource, setTopSource] = useState(entry.topSource);
  const [requireMentionSources, setRequireMentionSources] = useState(
    (entry.requireMentionSources ?? []).join(', '),
  );
  const [trendingssolChannel, setTrendingssolChannel] = useState(
    entry.listenChannelPeers?.TRENDINGSSOL ?? '@trendingssol',
  );
  const [maxCandidates, setMaxCandidates] = useState(String(entry.maxCandidatesPerTick));
  const [simBuy, setSimBuy] = useState(String(e.simBuySol));
  const [maxOpen, setMaxOpen] = useState(String(e.maxOpenPositions));
  const [stopLoss, setStopLoss] = useState(String(x.stopLossPct));
  const [takeProfit, setTakeProfit] = useState(String(x.takeProfitPct));
  const [maxHold, setMaxHold] = useState(String(x.maxHoldHours));
  const [execMode, setExecMode] = useState(strategy.execution_mode);

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800">
      <h3 className="font-semibold text-white">{strategy.name}</h3>
      <p className="text-xs text-gray-500 mb-3">{strategy.id}</p>
      <p className="text-xs text-gray-400 mb-3">{strategy.description}</p>
      <label className="text-xs text-gray-400 block mb-2">
        Execution mode
        <ExecutionModeSelect value={execMode} onChange={setExecMode} />
      </label>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="text-gray-400">
          Min mentions 30m
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={minMentions}
            onChange={(ev) => setMinMentions(ev.target.value)}
          />
        </label>
        <label className="text-gray-400">
          Max candidates/tick
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={maxCandidates}
            onChange={(ev) => setMaxCandidates(ev.target.value)}
          />
        </label>
        <label className="text-gray-400 col-span-2">
          Top source
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={topSource}
            onChange={(ev) => setTopSource(ev.target.value)}
          />
        </label>
        <label className="text-gray-400 col-span-2">
          Require mention sources (30m, comma-separated)
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={requireMentionSources}
            onChange={(ev) => setRequireMentionSources(ev.target.value)}
            placeholder="TRENDINGSSOL"
          />
        </label>
        <label className="text-gray-400 col-span-2">
          TRENDINGSSOL channel (ingest listen peer)
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={trendingssolChannel}
            onChange={(ev) => setTrendingssolChannel(ev.target.value)}
            placeholder="@trendingssol or -100…"
          />
          <span className="text-gray-500 mt-1 block">
            Telegram @username or numeric id. social-ingest polls this; source
            label stays TRENDINGSSOL for the FOMO gate.
          </span>
        </label>
        <label className="text-gray-400">
          Sim buy SOL
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={simBuy}
            onChange={(ev) => setSimBuy(ev.target.value)}
          />
        </label>
        <label className="text-gray-400">
          Max open
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={maxOpen}
            onChange={(ev) => setMaxOpen(ev.target.value)}
          />
        </label>
        <label className="text-gray-400">
          Stop loss %
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={stopLoss}
            onChange={(ev) => setStopLoss(ev.target.value)}
          />
        </label>
        <label className="text-gray-400">
          Take profit %
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={takeProfit}
            onChange={(ev) => setTakeProfit(ev.target.value)}
          />
        </label>
        <label className="text-gray-400">
          Max hold hours
          <input
            className="w-full mt-1 bg-gray-900 border border-gray-600 rounded px-2 py-1 text-white"
            value={maxHold}
            onChange={(ev) => setMaxHold(ev.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        <button
          type="button"
          disabled={saving}
          onClick={() =>
            onSave(strategy.id, {
              execution_mode: execMode,
              config: {
                entry: {
                  minMentions30m: parseInt(minMentions, 10),
                  topSource,
                  requireMentionSources: requireMentionSources
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                  listenChannelPeers: (() => {
                    const peer = trendingssolChannel.trim();
                    return peer ? { TRENDINGSSOL: peer } : {};
                  })(),
                  maxCandidatesPerTick: parseInt(maxCandidates, 10),
                },
                execution: {
                  simBuySol: parseFloat(simBuy),
                  maxOpenPositions: parseInt(maxOpen, 10),
                },
                exit: {
                  stopLossPct: parseFloat(stopLoss),
                  takeProfitPct: parseFloat(takeProfit),
                  maxHoldHours: parseFloat(maxHold),
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
          onClick={() =>
            toggleActiveWithNotifySync(strategy.id, strategy.is_active, onSave)
          }
          className="px-3 py-1.5 bg-gray-700 text-white text-xs rounded"
        >
          {strategy.is_active ? "Deactivate" : "Activate"}
        </button>
        <StrategyNotifyBar
          strategyId={strategy.id}
          notify={strategy.config.notify}
          saving={saving}
          onSave={onSave}
        />
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
  const exec = c.execution ?? {
    simDeploySol: 0.05,
    maxOpenPositions: 3,
    minCandidateScore: 15,
  };
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
  const [simDeploySol, setSimDeploySol] = useState(String(exec.simDeploySol));
  const [maxOpen, setMaxOpen] = useState(String(exec.maxOpenPositions));
  const [minScore, setMinScore] = useState(String(exec.minCandidateScore));

  return (
    <div className="border border-gray-700 rounded-lg p-4 bg-gray-800 max-w-xl">
      <h3 className="font-semibold text-white mb-2">{strategy.name}</h3>
      <label className="text-xs text-gray-400 block mb-2">
        Execution mode
        <ExecutionModeSelect value={execMode} onChange={setExecMode} />
      </label>
      <Section title="Start conditions">
        <FieldGrid>
          <NumberField label="min TVL" value={minTvl} onChange={setMinTvl} step="1" />
          <NumberField label="min fee/TVL" value={minFeeTvl} onChange={setMinFeeTvl} />
          <NumberField label="min organic score" value={minOrganic} onChange={setMinOrganic} step="1" />
          <NumberField label="min holders" value={minHolders} onChange={setMinHolders} step="1" />
        </FieldGrid>
      </Section>
      <Section title="End conditions">
        <FieldGrid>
          <NumberField label="take profit %" value={tp} onChange={setTp} />
          <NumberField label="stop loss %" value={sl} onChange={setSl} />
          <NumberField label="OOR timeout (min)" value={oor} onChange={setOor} step="1" colSpan={2} />
        </FieldGrid>
      </Section>
      <Section title="Execution">
        <FieldGrid>
          <NumberField label="sim deploy SOL" value={simDeploySol} onChange={setSimDeploySol} step="0.01" />
          <NumberField label="max open positions" value={maxOpen} onChange={setMaxOpen} step="1" />
          <NumberField label="min candidate score" value={minScore} onChange={setMinScore} step="1" colSpan={2} />
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
                execution: {
                  simDeploySol: parseFloat(simDeploySol),
                  maxOpenPositions: parseInt(maxOpen, 10),
                  minCandidateScore: parseFloat(minScore),
                },
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
          onClick={() =>
            toggleActiveWithNotifySync(strategy.id, strategy.is_active, onSave)
          }
          className="px-3 py-1.5 bg-gray-700 text-white text-xs rounded"
        >
          {strategy.is_active ? "Deactivate" : "Activate"}
        </button>
        <StrategyNotifyBar
          strategyId={strategy.id}
          notify={strategy.config.notify}
          saving={saving}
          onSave={onSave}
        />
      </div>
    </div>
  );
}
