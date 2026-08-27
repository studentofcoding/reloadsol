/** Routes that require any connected wallet (trade + public analytics). */
export const WALLET_REQUIRED_ROUTES = [
  '/buy',
  '/sell',
  '/swap',
  '/history',
  '/pnl',
] as const;

/** Dev tools — connected wallet must be on the dev whitelist. */
export const DEV_ROUTES = [
  '/dev/signals',
  '/dev/algo-tester',
  '/dev/dlmm',
  '/dev/strategies',
  '/dev/rpc-tester',
  '/dev/token-search',
  '/dev/ohlc-labels',
  '/dev/arbitrage',
  '/search-token',
] as const;

export type WalletRequiredRoute = (typeof WALLET_REQUIRED_ROUTES)[number];
export type DevRoute = (typeof DEV_ROUTES)[number];

export function matchesRoutePrefix(
  pathname: string,
  routes: readonly string[],
): boolean {
  const path = pathname || '';
  return routes.some(
    (route) => path === route || path.startsWith(`${route}/`),
  );
}

export function isWalletRequiredRoute(pathname: string): boolean {
  return matchesRoutePrefix(pathname, WALLET_REQUIRED_ROUTES);
}

export function isDevRoute(pathname: string): boolean {
  return matchesRoutePrefix(pathname, DEV_ROUTES);
}

/** @deprecated Use isWalletRequiredRoute */
export function isTradeRoute(pathname: string): boolean {
  return isWalletRequiredRoute(pathname);
}
