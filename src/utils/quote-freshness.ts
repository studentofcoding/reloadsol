/**
 * A quote is only meaningful for the amount it was requested at.
 *
 * The sell panel stores quotes in a map keyed by mint, so a quote fetched for a previous amount
 * stays "valid" (the age check passes) and gets rendered as the estimate for the *current* amount.
 * That is how a position whose live quote was ~6.46 SOL displayed ~3.98 SOL: the USD side came from
 * a fresh price, the SOL side came from a quote for an older quantity, and nothing compared them.
 */

export type AmountTaggedQuote = {
  amount?: string | null;
  timestamp?: number | null;
};

/** Default window a quote remains useful for; matches the sell panel's execution re-quote budget. */
export const QUOTE_MAX_AGE_MS = 30_000;

/**
 * Does this quote belong to `requestedAmount`?
 *
 * Fail-closed: a quote with a missing, empty or non-string amount is NOT a match, because it cannot
 * be shown to correspond to the requested amount (an empty string must never read as a match — the
 * `Number('') === 0` class of trap).
 */
export function quoteMatchesAmount(
  quote: AmountTaggedQuote | null | undefined,
  requestedAmount: string | undefined,
): boolean {
  if (!quote) return false;
  if (requestedAmount === undefined) return true; // caller did not ask for amount-awareness
  if (typeof quote.amount !== "string" || quote.amount.length === 0) return false;
  return quote.amount === requestedAmount;
}

/** Amount match AND age within window. */
export function isQuoteUsable(
  quote: AmountTaggedQuote | null | undefined,
  requestedAmount: string | undefined,
  now: number = Date.now(),
  maxAgeMs: number = QUOTE_MAX_AGE_MS,
): boolean {
  if (!quote) return false;
  if (!quoteMatchesAmount(quote, requestedAmount)) return false;
  const ts = typeof quote.timestamp === "number" ? quote.timestamp : NaN;
  if (!Number.isFinite(ts)) return false;
  return now - ts < maxAgeMs;
}
