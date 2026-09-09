import type { UserToken } from "@/utils/jupiter";
import {
  fetchJupiterPortfolio,
  mapPortfolioToUserTokens,
} from "@/utils/jupiter-portfolio";
import {
  computeTotalPortfolioUsd,
  enrichTokensWithPrices,
  fetchShyftAllTokens,
  mapShyftTokensToUserTokens,
} from "@/utils/shyft-wallet";

export type SolHoldingsSource = "shyft" | "jupiter";

export type SolHoldingsResult = {
  tokens: UserToken[];
  source: SolHoldingsSource;
  totalPortfolioUsd: number;
  latencyMs: number;
};

export type FetchSolWalletHoldingsOptions = {
  /** Bypass the proxy response cache (post-trade `fresh=1`). */
  fresh?: boolean;
  /** Attach USD via `/api/tokens/prices` when Shyft is the source. Default true. */
  enrichPrices?: boolean;
};

/**
 * Client holdings: cached Shyft `all_tokens` first, Jupiter Portfolio fallback.
 * Trade quotes/swaps stay on Solana Tracker — this is list/PnL only.
 */
export async function fetchSolWalletHoldings(
  walletAddress: string,
  options?: FetchSolWalletHoldingsOptions,
): Promise<SolHoldingsResult> {
  const start = Date.now();
  const fresh = options?.fresh ?? false;
  const enrichPrices = options?.enrichPrices ?? true;

  try {
    const shyft = await fetchShyftAllTokens(walletAddress, { fresh });
    let tokens = mapShyftTokensToUserTokens(shyft.tokens);
    if (enrichPrices) {
      try {
        tokens = await enrichTokensWithPrices(tokens);
      } catch (err) {
        console.warn("Shyft holdings price enrich failed", err);
      }
    }
    return {
      tokens,
      source: "shyft",
      totalPortfolioUsd: computeTotalPortfolioUsd(tokens),
      latencyMs: Date.now() - start,
    };
  } catch (shyftErr) {
    console.warn(
      "Shyft all_tokens unavailable, falling back to Jupiter portfolio",
      shyftErr,
    );
    const portfolio = await fetchJupiterPortfolio(walletAddress, fresh);
    return {
      tokens: mapPortfolioToUserTokens(portfolio),
      source: "jupiter",
      totalPortfolioUsd: portfolio.totalValue,
      latencyMs: Date.now() - start,
    };
  }
}

/** Resolve a sellable token via Shyft holdings (same source as /sell). */
export async function resolveWalletTokenToSell(
  walletAddress: string,
  mintAddress: string,
  fallbacks: {
    cached?: UserToken;
    rpcFetch?: () => Promise<UserToken[]>;
  } = {},
): Promise<UserToken | null> {
  try {
    const holdings = await fetchSolWalletHoldings(walletAddress, {
      enrichPrices: false,
    });
    const found = holdings.tokens.find((t) => t.mintAddress === mintAddress);
    if (found && found.uiAmount > 0) return found;
  } catch (err) {
    console.warn("Sol holdings resolve failed, trying fallbacks", err);
  }

  if (fallbacks.cached && fallbacks.cached.uiAmount > 0) {
    return fallbacks.cached;
  }

  if (fallbacks.rpcFetch) {
    try {
      const tokens = await fallbacks.rpcFetch();
      const found = tokens.find((t) => t.mintAddress === mintAddress);
      if (found && found.uiAmount > 0) return found;
    } catch (err) {
      console.warn("RPC token resolve failed", err);
    }
  }

  return null;
}
