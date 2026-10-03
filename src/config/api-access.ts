/** API routes that stay open without a wallet session. */
export const PUBLIC_API_PREFIXES = [
  '/api/auth',
  '/api/health',
  '/api/solprice',
  '/api/rpc',
  '/api/tokens',
  '/api/jupiter',
  '/api/providers',
  '/api/trade/health',
  '/api/trade/pools-test',
  '/api/gmgn/token-snapshot',
  '/api/logs',
  // Header climate chip is rendered for signed-out visitors; the route only proxies a display payload.
  '/api/regime/climate',
  // Read before any wallet sign-in by WalletProvider / WalletConnectGate (GMGN-bound addresses are public
  // on-chain; the route returns only addresses, never keys).
  '/api/gmgn/bound-wallets',
  // Static, non-sensitive reads used by EVM-only (Robinhood) visitors who have no Solana-signed session.
  '/api/rh/config',
  '/api/ethprice',
] as const;

/**
 * Exact-path public reads. Exact (not prefix) on purpose: `/api/scout/data-public/paper` writes to the DB
 * and must stay behind a wallet session while the read-only feed behind the Insight strip stays public.
 */
export const PUBLIC_API_EXACT_GET_PATHS = ['/api/scout/data-public'] as const;

/**
 * Routes that authenticate themselves inside the handler (cron secret, Goldsky bearer, per-job secrets)
 * or are webhooks. The proxy lets them through so their own check is the only gate; they are NOT public
 * data. Everything not listed here, in PUBLIC, WALLET or DEV falls to the DEFAULT tier (`wallet`).
 */
export const SELF_AUTH_API_PREFIXES = [
  '/api/gmgn/activity-poll',
  '/api/gmgn/radar-digest',
  '/api/gmgn/sim-track',
  '/api/gmgn/wallet-digger',
  '/api/mcap-patterns/refresh',
  '/api/mcap-patterns/training-export',
  '/api/metrics/copy',
  '/api/ml/pattern/reload',
  '/api/ohlc/sample',
  '/api/report-precompute/refresh',
  '/api/rh/ledger/ingest',
  '/api/rug-signal',
  '/api/sl-tp-monitor',
] as const;

/** Tier applied to any `/api/*` route that is not classified above. Fail closed: new routes need a session. */
export const DEFAULT_API_ACCESS_TIER = 'wallet' as const;

/** Any connected wallet session (buy/sell/swap analytics). Checked before dev prefixes. */
export const WALLET_API_PREFIXES = [
  '/api/buy',
  '/api/trade/server-sign',
  '/api/trade/server-execute',
  '/api/operations',
  '/api/trading/records',
  '/api/trade/compare',
  '/api/trade/enhanced-compare',
  '/api/trending/search',
  '/api/trending/filtered',
  '/api/trending/prices',
  '/api/trading/subscribe',
  '/api/prices/open',
  '/api/watchlist',
] as const;

/** Dev whitelist wallet session. */
export const DEV_API_PREFIXES = [
  '/api/signals',
  '/api/rug',
  '/api/potential',
  '/api/dlmm',
  '/api/trading/signals',
  '/api/mcap-tracking',
  '/api/trending',
  '/api/analytics',
  '/api/trading/sync',
  '/api/capture',
  '/api/pnl',
  '/api/trade/test',
  // quote/scan/execute: scan is driven by the Go cron with ?key= (service auth), the rest is the dev arbitrage page.
  '/api/sol-arb',
  // Spends from the server-held GMGN-bound wallet (GMGN_PRIVATE_KEY): operator only.
  '/api/gmgn/trade/swap',
  '/api/mcap-patterns',
  '/api/strategies',
  '/api/gmgn/token-snapshot',
  '/api/gmgn/detect-snapshot',
  '/api/gmgn/risk-chips',
  '/api/gmgn/token-ohlc',
  '/api/workers',
  '/api/fomo',
  '/api/social',
  '/api/dev/reputation',
] as const;

/** Cron / webhook / bearer routes that bypass wallet sessions. */
export const SERVICE_AUTH_API_PREFIXES = [
  '/api/dlmm/screen',
  '/api/dlmm/manage',
  '/api/dlmm/telegram',
  '/api/sl-tp-monitor',
  '/api/signals/sim-track',
  '/api/mcap-tracking/sim-track',
  '/api/strategies/report-digest',
  '/api/gmgn/sim-track',
  '/api/gmgn/activity-poll',
  '/api/gmgn/radar-digest',
  '/api/social/sim-track',
  '/api/social/ingest',
  '/api/social/rollup',
  '/api/social/cleanup',
  '/api/social/wallet-poll',
] as const;

/** `open` = the handler authenticates itself (see SELF_AUTH_API_PREFIXES); the proxy adds no check. */
export type ApiAccessTier = 'public' | 'wallet' | 'dev' | 'open';

export function matchesApiPrefix(
  pathname: string,
  prefixes: readonly string[],
): boolean {
  const path = pathname || '';
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}

/** GET trending lists for marketing preview (wallet gate, landing). */
export function isPublicTrendingRead(pathname: string, method: string): boolean {
  if (method !== 'GET') return false;
  return (
    pathname === '/api/trending/filtered' ||
    pathname === '/api/trending/prices' ||
    pathname === '/api/gmgn/trending/filtered'
  );
}

/** Mutating verbs on routes whose GET is wallet-level. */
export function isDevOnlyMutation(pathname: string, method: string): boolean {
  // PATCH rewrites the GMGN roster that the cron and the trade UI both read.
  return pathname === '/api/gmgn/roster' && method !== 'GET' && method !== 'HEAD';
}

export function getApiAccessTier(pathname: string, method: string): ApiAccessTier {
  if (matchesApiPrefix(pathname, SELF_AUTH_API_PREFIXES)) {
    return 'open';
  }

  if (matchesApiPrefix(pathname, PUBLIC_API_PREFIXES)) {
    return 'public';
  }

  if (
    method === 'GET' &&
    (PUBLIC_API_EXACT_GET_PATHS as readonly string[]).includes(pathname)
  ) {
    return 'public';
  }

  if (isDevOnlyMutation(pathname, method)) {
    return 'dev';
  }

  if (isPublicTrendingRead(pathname, method)) {
    return 'public';
  }

  if (matchesApiPrefix(pathname, WALLET_API_PREFIXES)) {
    return 'wallet';
  }

  if (matchesApiPrefix(pathname, DEV_API_PREFIXES)) {
    return 'dev';
  }

  return DEFAULT_API_ACCESS_TIER;
}
