"use client";

/**
 * The React binding for `quote-engine`. Thin on purpose: react-query already provides cross-component
 * dedupe, `staleTime` and `refetchInterval`, so this hook adds only the key and the policy.
 *
 * The design decisions it encodes:
 *
 * - **Freshness gates the fetch, not a timer.** A re-edit inside the TTL costs zero requests, and two
 *   surfaces asking the same question share one entry. `keepPreviousData` means the displayed estimate
 *   never blanks while a new one is in flight.
 * - **A quote is not a live ticker.** `refreshMs` defaults to `false`; a surface that genuinely wants a
 *   slow refresh asks for it (the seller asks for 25 s, inside the venue's 30 s validity).
 * - **A hidden tab does no work** (`refetchIntervalInBackground: false`).
 * - **An `execute` is never cached** — `staleTime: 0`, `gcTime: 0`, and a key that includes `purpose`,
 *   so a transaction can never be handed back from a previous quote.
 */
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import {
  QUOTE_ENGINE_KEY_ROOT,
  quoteKey,
  requestQuote,
  resolveEstimateTtlMs,
  type SolanaQuote,
  type SolanaQuoteRequest,
} from "@/utils/quote-engine";

export type QuotePolicy = {
  enabled?: boolean;
  /** Refresh a stable selection on an interval. Default `false`. */
  refreshMs?: number | false;
  /** Freshness window. Defaults to `QUOTE_ESTIMATE_TTL_MS`. */
  staleTimeMs?: number;
};

export function solQuoteQueryKey(req: SolanaQuoteRequest) {
  return [QUOTE_ENGINE_KEY_ROOT, quoteKey(req)] as const;
}

function queryOptionsFor(req: SolanaQuoteRequest, policy: QuotePolicy) {
  const execute = req.purpose === "execute";
  return {
    queryKey: solQuoteQueryKey(req),
    queryFn: () => requestQuote(req),
    enabled: policy.enabled ?? true,
    // An execution must be built at click against current chain state; an estimate may be seconds old.
    staleTime: execute ? 0 : policy.staleTimeMs ?? resolveEstimateTtlMs(),
    gcTime: execute ? 0 : 60_000,
    refetchInterval: execute ? (false as const) : policy.refreshMs ?? (false as const),
    refetchIntervalInBackground: false,
    retry: false,
    ...(execute ? {} : { placeholderData: keepPreviousData }),
  };
}

export function useQuote(req: SolanaQuoteRequest | null, policy: QuotePolicy = {}) {
  const enabled = (policy.enabled ?? true) && req !== null;
  const query = useQuery({
    ...queryOptionsFor(
      req ?? { inputMint: "", outputMint: "", amount: "0", slippageBps: 0, purpose: "estimate" },
      { ...policy, enabled },
    ),
  });

  return {
    quote: (query.data as SolanaQuote | undefined) ?? null,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * N quotes at once — a bulk selection. Returns by `quoteKey` so a caller can look one up from its
 * selection without re-deriving the key, plus whether anything is still in flight.
 */
export function useQuotes(reqs: SolanaQuoteRequest[], policy: QuotePolicy = {}) {
  const queries = useQueries({
    queries: reqs.map((req) => queryOptionsFor(req, { ...policy, enabled: policy.enabled ?? true })),
  });

  const quotes = new Map<string, SolanaQuote>();
  let isFetching = false;
  let firstError: unknown = null;
  const refetchAll = () => {
    for (const q of queries) void q.refetch();
  };

  reqs.forEach((req, index) => {
    const query = queries[index];
    if (!query) return;
    if (query.isFetching) isFetching = true;
    if (query.error && !firstError) firstError = query.error;
    if (query.data) quotes.set(quoteKey(req), query.data as SolanaQuote);
  });

  return { quotes, isFetching, error: firstError, refetch: refetchAll };
}
