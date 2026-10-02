/** Display label for a roster digger token. Prefer a real ticker. */

const PLACEHOLDER_SYMBOLS = new Set(["token", "unknown", "unknown token"]);

export function shortAddr(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * A usable ticker, or null when the value is empty, a placeholder, or the
 * mint-prefix stand-in wallet-digger stores (`tokenAddress.slice(0, 8)`).
 */
export function usableTokenSymbol(
  symbol: string | null | undefined,
  mint: string,
): string | null {
  if (typeof symbol !== "string") return null;
  const trimmed = symbol.trim();
  if (!trimmed) return null;
  if (PLACEHOLDER_SYMBOLS.has(trimmed.toLowerCase())) return null;
  if (trimmed === mint) return null;
  if (trimmed.length >= 8 && mint.startsWith(trimmed)) return null;
  return trimmed;
}

export function rosterTokenLabel(params: {
  mint: string;
  symbol?: string | null;
  metaSymbol?: string | null;
}): string {
  return (
    usableTokenSymbol(params.metaSymbol, params.mint) ??
    usableTokenSymbol(params.symbol, params.mint) ??
    shortAddr(params.mint)
  );
}

/** Same-origin chart path used by Board and the watchlist. */
export function rosterChartPath(mint: string): string {
  return `/chart/${mint}`;
}
