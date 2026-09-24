"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  dismissTradeInFlight,
  subscribeTradeInFlight,
  type TradeInFlightView,
} from "@/utils/trade-inflight";

/**
 * Blocks the desk while a swap is in flight so the click does not look dead
 * and a second submit cannot start. Wallet confirmations use the top layer,
 * so this scrim does not cover the wallet popup.
 */
export default function TradeInFlightOverlay() {
  const [view, setView] = useState<TradeInFlightView | null>(null);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeTradeInFlight(setView), []);

  useEffect(() => {
    if (!view) return;
    const node = dialogRef.current;
    node?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (view.phase === "confirming") {
        event.preventDefault();
        return;
      }
      dismissTradeInFlight();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  if (!view) return null;

  const confirming = view.phase === "confirming";

  return (
    <div
      className="trade-inflight-scrim fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-4"
      data-testid="trade-inflight"
      data-phase={view.phase}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-busy={confirming}
        aria-labelledby={titleId}
        tabIndex={-1}
        className="trade-inflight-card w-full max-w-sm rounded-xl border border-gray-700 bg-gray-900 px-5 py-4 text-white shadow-lg outline-none"
      >
        <div className="flex items-center gap-3">
          {confirming ? (
            <span className="trade-inflight-spinner shrink-0" aria-hidden />
          ) : (
            <span
              className={`h-3 w-3 shrink-0 rounded-full ${
                view.phase === "success" ? "bg-lime-400" : "bg-red-400"
              }`}
              aria-hidden
            />
          )}
          <div className="min-w-0">
            <p id={titleId} className="text-sm font-semibold">
              {view.title}
            </p>
            {view.detail ? (
              <p className="mt-1 text-xs text-gray-300 break-words">{view.detail}</p>
            ) : confirming ? (
              <p className="mt-1 text-xs text-gray-400">
                Waiting for the transaction to land.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
