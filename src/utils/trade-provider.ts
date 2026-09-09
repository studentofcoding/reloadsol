/**
 * Trade stack toggle:
 * - 'raptor' (default): Solana Tracker RPC (rpc-mainnet.solanatracker.io) for
 *   send/confirm + Raptor quote/send/confirm from raptor-beta.solanatracker.io
 * - 'shyft': Shyft RPC + Shyft send_txn; Raptor quote build with Jupiter Lite fallback
 */
export type TradeProvider = "raptor" | "shyft";

const STORAGE_KEY = "buybulk.tradeProvider";

const listeners = new Set<(provider: TradeProvider) => void>();

function envTradeProvider(): TradeProvider {
  const value = process.env.TRADE_PROVIDER?.trim();
  return value === "shyft" ? "shyft" : "raptor";
}

function readStoredProvider(): TradeProvider {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "shyft"
      ? "shyft"
      : "raptor";
  } catch {
    return "raptor";
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
