/**
 * Cache tag namespaces for Next.js 16.3 Cache Components.
 *
 * Read functions tagged with `cacheTag` in a `'use cache'` scope are
 * invalidated on-demand by `updateTag(...)` from a Server Action.
 * Wallet-scoped tags keep per-user caches from cross-invalidating.
 */
export const CACHE_TAGS = {
  records: (wallet: string) => `records:${wallet}`,
  watchlist: (wallet: string) => `watchlist:${wallet}`,
  signals: 'signals',
  potential: 'potential',
  rug: 'rug',
  blog: 'blog',
  trendingPrices: 'trending-prices',
  lpTerminalPools: 'lp-terminal-pools',
  mcapLabels: (wallet: string) => `mcap-labels:${wallet}`,
} as const;
