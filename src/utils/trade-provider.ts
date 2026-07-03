/**
 * Trade stack toggle:
 * - 'raptor': Solana Tracker RPC + Raptor quote/send/confirm
 * - 'shyft': Shyft RPC + Shyft send_txn; Raptor quote build with Jupiter Lite fallback
 */
export type TradeProvider = "raptor" | "shyft";

const STORAGE_KEY = "buybulk.tradeProvider";

const listeners = new Set<(provider: TradeProvider) => void>();

/** @deprecated Dev-only gate removed — provider toggle is always available on client. */
export function isTradeProviderToggleEnabled(): boolean {
  return true;
}

function envTradeProvider(): TradeProvider {
  const value = process.env.TRADE_PROVIDER?.trim();
  return value === "raptor" ? "raptor" : "shyft";
}

function readStoredProvider(): TradeProvider {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "raptor"
      ? "raptor"
      : "shyft";
  } catch {
    return "shyft";
  }
}

export function getTradeProvider(): TradeProvider {
  if (typeof window === "undefined") {
    return envTradeProvider();
  }
  return readStoredProvider();
}

export function subscribeTradeProvider(
  cb: (provider: TradeProvider) => void,
): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setTradeProvider(provider: TradeProvider): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, provider);
  } catch {
    // localStorage unavailable — toggle won't persist
  }
  listeners.forEach((cb) => cb(provider));
}
