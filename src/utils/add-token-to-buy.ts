export const BUY_PENDING_MINTS_KEY = "buy-pending-mints";

export type AddTokenToBuyDetail = {
  tokenAddress: string;
  openChart?: boolean;
};

export const ADD_TOKEN_TO_LIST_EVENT = "addTokenToList";

function readPending(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(BUY_PENDING_MINTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m): m is string => typeof m === "string" && m.length > 0);
  } catch {
    return [];
  }
}

function writePending(mints: string[]): void {
  if (typeof window === "undefined") return;
  try {
    if (mints.length === 0) {
      sessionStorage.removeItem(BUY_PENDING_MINTS_KEY);
    } else {
      sessionStorage.setItem(BUY_PENDING_MINTS_KEY, JSON.stringify(mints));
    }
  } catch {
    // ignore quota / private mode
  }
}

/** Append a unique mint for BulkTokenBuyer to drain after navigating to /buy. */
export function queueBuyMint(address: string): void {
  const mint = address.trim();
  if (!mint) return;
  const pending = readPending();
  if (!pending.includes(mint)) pending.push(mint);
  writePending(pending);
}

/** Read and clear pending mints. */
export function drainBuyPendingMints(): string[] {
  const pending = readPending();
  writePending([]);
  return pending;
}

/**
 * Notify BulkTokenBuyer (if mounted) to append a mint.
 * Caller should queueBuyMint + navigate to /buy when not already on that route.
 */
export function requestAddTokenToBuy(
  address: string,
  opts?: { openChart?: boolean },
): void {
  const tokenAddress = address.trim();
  if (!tokenAddress || typeof window === "undefined") return;

  window.dispatchEvent(
    new CustomEvent<AddTokenToBuyDetail>(ADD_TOKEN_TO_LIST_EVENT, {
      detail: {
        tokenAddress,
        openChart: opts?.openChart ?? true,
      },
    }),
  );
}
