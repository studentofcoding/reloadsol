"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { McapToast } from "@/types/mcap-toasts";
import { useFastBuy } from "@/hooks/useFastBuy";
import { useAppNetwork } from "@/contexts/AppNetworkContext";
import {
  queueBuyMint,
  requestAddTokenToBuy,
} from "@/utils/add-token-to-buy";

const TOAST_AUTO_DISMISS_MS = 12_000;
const SIM_OPEN_AUTO_DISMISS_MS = 20_000;
const MAX_VISIBLE = 4;
const TOAST_Z_INDEX = 9999;

function toastStyles(type: McapToast["type"], category?: McapToast["category"]) {
  if (category === "sim_open") {
    return "border-emerald-600 bg-emerald-950/95 text-emerald-50";
  }
  if (category === "signals_enter") {
    return "border-sky-600 bg-sky-950/95 text-sky-50";
  }
  switch (type) {
    case "success":
      return "border-green-700 bg-green-900/95 text-green-100";
    case "warning":
      return "border-amber-700 bg-amber-900/95 text-amber-100";
    default:
      return "border-blue-700 bg-blue-900/95 text-blue-100";
  }
}

function isCopyTradeToast(category?: McapToast["category"]): boolean {
  return category === "sim_open" || category === "signals_enter";
}

function formatEntryMcap(value?: number): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function strategyBadgeLabel(strategyId?: string, entryTemplate?: string): string | null {
  if (entryTemplate === "signals_enter") return "Early enter";
  if (
    strategyId === "mcap_enter_at_80" ||
    strategyId === "mcap_enter_at_80_rh" ||
    entryTemplate === "milestone_80"
  ) {
    return strategyId?.endsWith("_rh") ? "Enter at 80% (RH)" : "Enter at 80%";
  }
  if (
    strategyId === "mcap_enter_first_seen" ||
    strategyId === "mcap_enter_first_seen_rh" ||
    entryTemplate === "first_seen"
  ) {
    return strategyId?.endsWith("_rh") ? "First seen (RH)" : "First seen";
  }
  return null;
}

type ActiveToast = McapToast & { id: string };

type McapTrackerToastsProps = {
  toasts?: McapToast[] | null;
};

export default function McapTrackerToasts({ toasts }: McapTrackerToastsProps) {
  const { fastBuy, buyStates, buyConfig } = useFastBuy();
  const { network } = useAppNetwork();
  const isRobinhood = network === "robinhood";
  const router = useRouter();
  const pathname = usePathname();
  const [active, setActive] = useState<ActiveToast[]>([]);
  const seenKeysRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pausedRef = useRef<Set<string>>(new Set());

  const handleAddTokenToBuy = useCallback(
    (address: string) => {
      const onBuy = pathname === "/buy" || pathname?.startsWith("/buy/");
      requestAddTokenToBuy(address, { openChart: true });
      if (!onBuy) {
        queueBuyMint(address);
        router.push("/buy");
      }
    },
    [pathname, router],
  );

  const dismiss = useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    pausedRef.current.delete(id);
    setActive((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const scheduleDismiss = useCallback(
    (id: string, ms: number = TOAST_AUTO_DISMISS_MS) => {
      if (pausedRef.current.has(id)) return;
      const existing = timersRef.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => dismiss(id), ms);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    if (!toasts?.length) return;

    const incoming: ActiveToast[] = [];
    for (const toast of toasts) {
      const dedupKey =
        toast.key ?? `${toast.category ?? toast.type}:${toast.title}:${toast.message}`;
      if (seenKeysRef.current.has(dedupKey)) continue;
      seenKeysRef.current.add(dedupKey);
      incoming.push({ ...toast, id: `${dedupKey}:${Date.now()}` });
    }

    if (incoming.length === 0) return;

    const frame = window.setTimeout(() => {
      setActive((prev) => [...incoming, ...prev].slice(0, MAX_VISIBLE));
      for (const toast of incoming) {
        const ms = isCopyTradeToast(toast.category)
          ? SIM_OPEN_AUTO_DISMISS_MS
          : TOAST_AUTO_DISMISS_MS;
        scheduleDismiss(toast.id, ms);
      }
    }, 0);

    return () => clearTimeout(frame);
  }, [toasts, scheduleDismiss]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  if (active.length === 0) return null;

  return (
    <div
      className="fixed top-4 right-4 flex w-full max-w-sm flex-col gap-2 pointer-events-none"
      style={{ zIndex: TOAST_Z_INDEX }}
    >
      {active.map((toast) => {
        const isCopyTrade = isCopyTradeToast(toast.category);
        const item = toast.items?.[0];
        const badge = strategyBadgeLabel(item?.strategyId, item?.entryTemplate);
        const entryMcapLabel = formatEntryMcap(item?.entryMcap);
        const dismissMs = isCopyTrade ? SIM_OPEN_AUTO_DISMISS_MS : TOAST_AUTO_DISMISS_MS;

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto rounded-lg border px-4 py-3 shadow-lg ${toastStyles(toast.type, toast.category)}`}
            role="status"
            onMouseEnter={() => {
              pausedRef.current.add(toast.id);
              const timer = timersRef.current.get(toast.id);
              if (timer) {
                clearTimeout(timer);
                timersRef.current.delete(toast.id);
              }
            }}
            onMouseLeave={() => {
              pausedRef.current.delete(toast.id);
              scheduleDismiss(toast.id, dismissMs);
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{toast.title}</p>
                <p className="mt-1 text-xs opacity-90 break-words">{toast.message}</p>
                {item && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {badge && (
                      <span className="rounded bg-black/25 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide">
                        {badge}
                      </span>
                    )}
                    {toast.category === "signals_enter" && (
                      <span className="rounded bg-black/25 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide opacity-80">
                        shadow
                      </span>
                    )}
                    {toast.category === "signals_enter" &&
                      item.pWinner != null &&
                      Number.isFinite(item.pWinner) && (
                        <span className="text-xs opacity-80">
                          pW {item.pWinner.toFixed(2)}
                          {item.predicted ? ` ${item.predicted}` : ""}
                        </span>
                      )}
                    {entryMcapLabel && (
                      <span className="text-xs opacity-75">
                        Entry {entryMcapLabel}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => handleAddTokenToBuy(item.address)}
                      className="text-xs underline opacity-90 hover:opacity-100"
                      title="Add to buy list and open chart"
                    >
                      {item.symbol}
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismiss(toast.id)}
                className="shrink-0 text-lg leading-none opacity-70 hover:opacity-100"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>

            {isCopyTrade && item && (
              <div className="mt-3 flex items-center gap-2">
                {isRobinhood ? (
                  <button
                    type="button"
                    onClick={() => handleAddTokenToBuy(item.address)}
                    className="rounded bg-white px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-gray-100"
                  >
                    Open on /buy
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={buyStates[item.address]?.loading}
                    onClick={() => void fastBuy(item.address, item.symbol)}
                    className="rounded bg-white px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {buyStates[item.address]?.loading
                      ? "Buying…"
                      : `Buy ${buyConfig.solAmount} SOL`}
                  </button>
                )}
                {buyStates[item.address]?.error && (
                  <span className="text-xs text-red-200">
                    {buyStates[item.address]?.error}
                  </span>
                )}
                {buyStates[item.address]?.status === "Done" && (
                  <span className="text-xs text-emerald-200">Purchased</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
