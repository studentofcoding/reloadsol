import {
  fetchWithCache,
  invalidatePortfolio,
  shyftAllTokensKey,
} from "@/utils/portfolio-cache";
import {
  fetchShyftAllTokensDirect,
  SHYFT_ALL_TOKENS_STALE_TTL_SECONDS,
  SHYFT_ALL_TOKENS_TTL_SECONDS,
  type ShyftAllTokensResponse,
} from "@/utils/shyft-wallet";

export type ShyftAllTokensCacheOrigin = "hit" | "miss" | "stale";

export type CachedShyftAllTokens = ShyftAllTokensResponse & {
  origin: ShyftAllTokensCacheOrigin;
};

/**
 * Server-side Shyft `all_tokens` with Redis SWR cache.
 * `fresh` purges the wallet's Solana portfolio keys (including this one).
 */
export async function fetchShyftAllTokensCached(
  walletAddress: string,
  network = "mainnet-beta",
  options?: { fresh?: boolean },
): Promise<CachedShyftAllTokens> {
  const skipCache = options?.fresh === true;
  if (skipCache) {
    await invalidatePortfolio("sol", walletAddress);
  }

  const key = shyftAllTokensKey(walletAddress, network);
  const { origin, data } = await fetchWithCache<ShyftAllTokensResponse>({
    key,
    staleKey: `${key}:stale`,
    ttlSeconds: SHYFT_ALL_TOKENS_TTL_SECONDS,
    staleTtlSeconds: SHYFT_ALL_TOKENS_STALE_TTL_SECONDS,
    skipCache,
    fetch: () => fetchShyftAllTokensDirect(walletAddress, network),
  });

  return { ...data, origin };
}
