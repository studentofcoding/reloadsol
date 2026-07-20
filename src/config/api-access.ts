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
  '/api/trade/test',
  '/api/trade/pools-test',
  '/api/axiom',
  '/api/logs',
] as const;

/** Any connected wallet session (buy/sell/swap analytics). Checked before dev prefixes. */
export const WALLET_API_PREFIXES = [
  '/api/buy',
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
  '/api/pnl/update',
  '/api/strategies',
  '/api/gmgn/token-snapshot',
  '/api/gmgn/detect-snapshot',
  '/api/gmgn/token-ohlc',
  '/api/workers',
  '/api/social',
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
    pathname === '/api/trending/prices'
  );
}

export function getApiAccessTier(pathname: string, method: string): ApiAccessTier {
  if (matchesApiPrefix(pathname, PUBLIC_API_PREFIXES)) {
    return 'public';
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

  return 'open';
}
