/**
 * Display helpers for trade amounts and the buy-side value estimate.
 *
 * Both encode a rule rather than a formatting preference:
 * - `formatTradeAmount` keeps a real fill legible (never rounding a live amount to "0.00").
 * - `estimateBuyUsdValue` values a buy as spend × native price — the same convention the buy
 *   tracker uses — and returns `null` rather than substituting a price it cannot observe.
 */

/** Group thousands, keep up to 6 decimals, 6 significant digits for dust. */
export function formatTradeAmount(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (abs >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return value.toLocaleString(undefined, { maximumSignificantDigits: 6 });
}

export type BuyInputCurrency = "SOL" | "USDC";

/**
 * USD value of a buy: the input amount valued at the live native price (SOL) or taken as the
 * dollar unit (USDC, which the input is already denominated in).
 *
 * Returns `null` when it cannot be computed — a missing/zero live price, or a non-positive or
 * non-finite amount. A caller must then show no figure: a fabricated conversion reads downstream
 * as fact, which is exactly the failure this returns `null` to prevent.
 */
export function estimateBuyUsdValue(params: {
  /** Input amount, in `currency` units. */
  amount: number;
  currency: BuyInputCurrency;
  /** Live SOL price in USD; `null`/`undefined`/`0` means unknown. */
  nativePriceUsd?: number | null;
}): number | null {
  const { amount, currency, nativePriceUsd } = params;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (currency === "USDC") return amount;
  if (!nativePriceUsd || !Number.isFinite(nativePriceUsd) || nativePriceUsd <= 0) return null;
  return amount * nativePriceUsd;
}
