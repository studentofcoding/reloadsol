/**
 * Desk-wide "a trade is confirming" signal.
 * Entry points share one scrim so a second click cannot submit again.
 * Server jobs (no window) never touch it — concurrent requests must not
 * share a process-wide depth counter.
 */

export type TradeInFlightPhase = "confirming" | "success" | "error";

export type TradeInFlightView = {
  phase: TradeInFlightPhase;
  title: string;
  detail?: string;
};

export type TradeFlight = {
  succeed: (detail?: string) => void;
  fail: (detail?: string) => void;
};

const CONFIRM_TITLE = "Confirming trade…";
const SUCCESS_TITLE = "Trade confirmed";
const ERROR_TITLE = "Trade failed";
const SUCCESS_DISMISS_MS = 900;
const ERROR_DISMISS_MS = 2400;

type Listener = (view: TradeInFlightView | null) => void;

const listeners = new Set<Listener>();
let depth = 0;
let view: TradeInFlightView | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

const noopFlight: TradeFlight = {
  succeed() {},
  fail() {},
};

function inflightEnabled(): boolean {
  return typeof window !== "undefined";
}

function emit(): void {
  for (const listener of listeners) listener(view);
}

function clearDismiss(): void {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

function scheduleDismiss(ms: number): void {
  clearDismiss();
  dismissTimer = setTimeout(() => {
    dismissTimer = null;
    if (depth === 0) {
      view = null;
      emit();
    }
  }, ms);
}

function clip(detail?: string): string | undefined {
  const text = detail?.trim();
  if (!text) return undefined;
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

export function subscribeTradeInFlight(listener: Listener): () => void {
  listeners.add(listener);
  listener(view);
  return () => {
    listeners.delete(listener);
  };
}

export function getTradeInFlightView(): TradeInFlightView | null {
  return view;
}

/** Dismiss a finished result early. Confirming trades stay up. */
export function dismissTradeInFlight(): void {
  if (!view || view.phase === "confirming" || depth > 0) return;
  clearDismiss();
  view = null;
  emit();
}

export function beginTradeInFlight(): TradeFlight {
  if (!inflightEnabled()) return noopFlight;

  clearDismiss();
  depth += 1;
  view = { phase: "confirming", title: CONFIRM_TITLE };
  emit();

  let settled = false;
  const finish = (phase: "success" | "error", title: string, detail?: string) => {
    if (settled) return;
    settled = true;
    depth = Math.max(0, depth - 1);
    if (depth > 0) return;
    view = { phase, title, detail: clip(detail) };
    emit();
    scheduleDismiss(phase === "success" ? SUCCESS_DISMISS_MS : ERROR_DISMISS_MS);
  };

  return {
    succeed(detail) {
      finish("success", SUCCESS_TITLE, detail);
    },
    fail(detail) {
      finish("error", ERROR_TITLE, detail);
    },
  };
}

export function resetTradeInFlightForTests(): void {
  clearDismiss();
  depth = 0;
  view = null;
  listeners.clear();
}
