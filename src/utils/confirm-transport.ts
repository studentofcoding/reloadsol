import { RAPTOR_DEFAULT_BASE } from "@/utils/solanatracker-raptor";

/**
 * Dev-only toggle for how swap confirmations are checked:
 * - 'api' (default): Raptor HTTP status + batched RPC getSignatureStatuses polling
 * - 'ws': WebSocket signatureSubscribe (falls back to 'api' for leftovers)
 */
export type ConfirmTransport = "api" | "ws";

const STORAGE_KEY = "buybulk.confirmTransport";

export function isConfirmTransportToggleEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}

/** Raptor base with wss scheme, e.g. wss://raptor-beta.solanatracker.io */
export function getRaptorWsBase(): string {
  return RAPTOR_DEFAULT_BASE.replace(/^https/, "wss").replace(/^http\b/, "ws");
}

export function getConfirmWsUrl(): string {
  const override = process.env.NEXT_PUBLIC_SOLANA_WS_URL?.trim();
  if (override && (override.startsWith("wss://") || override.startsWith("ws://"))) {
    return override;
  }
  return getRaptorWsBase();
}

export function getConfirmTransport(): ConfirmTransport {
  if (!isConfirmTransportToggleEnabled() || typeof window === "undefined") {
    return "api";
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "ws" ? "ws" : "api";
  } catch {
    return "api";
  }
}

export function setConfirmTransport(transport: ConfirmTransport): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, transport);
  } catch {
    // localStorage unavailable (private mode) — toggle just won't persist
  }
}
