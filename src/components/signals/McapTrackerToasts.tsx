"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { McapToast } from "@/types/mcap-toasts";
import { useFastBuy } from "@/hooks/useFastBuy";

const TOAST_AUTO_DISMISS_MS = 12_000;
const MAX_VISIBLE = 4;

function toastStyles(type: McapToast["type"], category?: McapToast["category"]) {
  if (category === "predictive") {
    return "border-emerald-600 bg-emerald-950/95 text-emerald-50";
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

type ActiveToast = McapToast & { id: string };

type McapTrackerToastsProps = {
  toasts?: McapToast[] | null;
};

export default function McapTrackerToasts({ toasts }: McapTrackerToastsProps) {
  const { fastBuy, buyStates, buyConfig } = useFastBuy();
  const [active, setActive] = useState<ActiveToast[]>([]);
  const seenKeysRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pausedRef = useRef<Set<string>>(new Set());

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
    (id: string) => {
      if (pausedRef.current.has(id)) return;
      const existing = timersRef.current.get(id);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => dismiss(id), TOAST_AUTO_DISMISS_MS);
      timersRef.current.set(id, timer);
    },
    [dismiss],
  );

  useEffect(() => {
    if (!toasts?.length) return;

    const incoming: ActiveToast[] = [];
    for (const toast of toasts) {
      const dedupKey = toast.key ?? `${toast.category ?? toast.type}:${toast.title}:${toast.message}`;
      if (seenKeysRef.current.has(dedupKey)) continue;
      seenKeysRef.current.add(dedupKey);
      incoming.push({ ...toast, id: `${dedupKey}:${Date.now()}` });
    }

    if (incoming.length === 0) return;

    setActive((prev) => {
      const merged = [...incoming, ...prev].slice(0, MAX_VISIBLE);
      return merged;
    });

    for (const toast of incoming) {
      scheduleDismiss(toast.id);
    }
  }, [toasts, scheduleDismiss]);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
    };
  }, []);

  if (active.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[70] flex w-full max-w-sm flex-col gap-2 pointer-events-none">
      {active.map((toast) => {
        const isPredictive = toast.category === "predictive";
        const item = toast.items?.[0];

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
              scheduleDismiss(toast.id);
            }}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{toast.title}</p>
                <p className="mt-1 text-xs opacity-90 break-words">{toast.message}</p>
                {item && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {isPredictive && item.pWinner != null && (
                      <span className="rounded bg-black/25 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                        {Math.round(item.pWinner * 100)}% winner
                      </span>
                    )}
                    <Link
                      href={`/chart/${item.address}`}
                      className="text-xs underline opacity-90 hover:opacity-100"
                    >
                      {item.symbol}
                    </Link>
                    {typeof item.growthPercent === "number" && (
                      <span className="text-[10px] opacity-75">
                        {item.growthPercent.toFixed(1)}% growth
                      </span>
                    )}
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

            {isPredictive && item && (
              <div className="mt-3 flex items-center gap-2">
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
                {buyStates[item.address]?.error && (
                  <span className="text-[10px] text-red-200">
                    {buyStates[item.address]?.error}
                  </span>
                )}
                {buyStates[item.address]?.status === "Done" && (
                  <span className="text-[10px] text-emerald-200">Purchased</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
