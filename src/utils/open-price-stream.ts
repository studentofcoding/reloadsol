'use client';

/**
 * One SSE connection to `/api/prices/open/stream`, shared by every consumer.
 *
 * Why this exists: the watchlist bar polls `/api/prices/open/refresh` every 15s and PnLTracker
 * additionally holds its own `EventSource` on the same endpoint. Two consumers of one live feed, so
 * a browser-per-host connection each. This module keeps **one** connection open and re-opens it with
 * the UNION of the mints subscribers care about — the bar's set (real, priced, held) and
 * PnLTracker's set (which also covers sim, bot and external) are different, so the union is what
 * avoids either surface polling.
 *
 * Deliberately NOT a poller. Callers keep their existing `/refresh` poll as a safety net, exactly as
 * PnLTracker already does (`refetchInterval: 15_000`). This only ever makes prices *fresher*; if the
 * stream dies, the poll is still there and nothing regresses. That ordering is what makes it safe to
 * land without a browser: a stream that fails silently costs nothing, it cannot stick a wrong price
 * because the poll keeps overwriting it.
 *
 * Prices are emitted one mint at a time so consumers merge into whatever state they already own.
 * There is no accumulated map here to go stale or to leak between mint sets.
 */

type PriceListener = (mint: string, price: number) => void;

let source: EventSource | null = null;
let currentUrl = '';
const refs = new Map<string, number>();
const listeners = new Set<PriceListener>();

function buildUrl(): string {
  const mints = [...refs.keys()].sort();
  return `/api/prices/open/stream?mints=${encodeURIComponent(mints.join(','))}`;
}

function ensureConnection(): void {
  if (typeof window === 'undefined') return;
  if (refs.size === 0) {
    source?.close();
    source = null;
    currentUrl = '';
    return;
  }
  const url = buildUrl();
  if (source && url === currentUrl) return;
  // Mint set changed, or no connection yet: replace it rather than hold a stale subscription.
  source?.close();
  source = null;
  currentUrl = url;
  try {
    const es = new EventSource(url);
    es.onmessage = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data) as { mint?: string; price?: number };
        if (
          typeof payload.mint === 'string' &&
          typeof payload.price === 'number' &&
          payload.price > 0
        ) {
          for (const listener of listeners) listener(payload.mint, payload.price);
        }
      } catch {
        // A malformed event must not tear down the stream.
      }
    };
    es.onerror = () => {
      // Drop the connection; consumers' own polls carry on. The next mint-set change, or the next
      // subscriber, re-opens it.
      es.close();
      if (source === es) {
        source = null;
        currentUrl = '';
      }
    };
    source = es;
  } catch {
    source = null;
    currentUrl = '';
  }
}

/**
 * Subscribe to live prices for `mints`. Returns an unsubscribe function.
 *
 * Callers must pass a stable, sorted set from a `useMemo` keyed on the mint list — this refcounts by
 * mint, so a new array identity with the same contents is fine, but passing a different *set* on
 * every render would reconnect the shared stream on every render.
 */
export function subscribeOpenPrices(
  mints: string[],
  listener: PriceListener,
): () => void {
  if (typeof window === 'undefined') return () => {};

  for (const mint of mints) {
    if (!mint) continue;
    refs.set(mint, (refs.get(mint) ?? 0) + 1);
  }
  listeners.add(listener);

  ensureConnection();

  return () => {
    for (const mint of mints) {
      if (!mint) continue;
      const next = (refs.get(mint) ?? 1) - 1;
      if (next <= 0) refs.delete(mint);
      else refs.set(mint, next);
    }
    listeners.delete(listener);
    ensureConnection();
  };
}

/** Test seam — drops all state. Not used by application code. */
export function __resetOpenPriceStream(): void {
  source?.close();
  source = null;
  currentUrl = '';
  refs.clear();
  listeners.clear();
}
