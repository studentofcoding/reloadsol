import type { UserToken } from "@/utils/jupiter";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const JUPITER_PORTFOLIO_BASE =
  "https://wallet-api.jup.ag/v2/portfolio/holdings";
export const PORTFOLIO_FETCH_TIMEOUT_MS = 15_000;

export type JupiterPortfolioToken = {
  id: string;
  symbol: string;
  icon?: string;
  decimals: number;
  amount: number;
  rawAmount: string;
  value: number;
  price: number;
  priceChange?: number;
  isVerified?: boolean;
};

export type JupiterPortfolioResponse = {
  totalValue: number;
  tokens: JupiterPortfolioToken[];
  reclaimableCount?: number;
  reclaimableLamports?: number;
  latencyMs?: number;
};

export function mapPortfolioTokenToUserToken(
  token: JupiterPortfolioToken,
): UserToken {
  const rawBalance = Number.parseInt(token.rawAmount, 10);
  return {
    mintAddress: token.id,
    balance: Number.isFinite(rawBalance) ? rawBalance : 0,
    decimals: token.decimals,
    symbol: token.symbol,
    name: token.symbol,
    logoURI: token.icon,
    uiAmount: token.amount,
    usdValue: token.value,
    isLoadingPrice: false,
    frozen: false,
    isNFT: token.decimals === 0 && token.amount <= 1,
  };
}

export function mapPortfolioToUserTokens(
  portfolio: JupiterPortfolioResponse,
  options?: { includeSol?: boolean },
): UserToken[] {
  const includeSol = options?.includeSol ?? false;
  return portfolio.tokens
    .filter((token) => includeSol || token.id !== SOL_MINT)
    .map(mapPortfolioTokenToUserToken)
    .sort((a, b) => b.usdValue - a.usdValue);
}

export function mergePortfolioWithEmptyAccounts(
  portfolioTokens: UserToken[],
  emptyAccounts: UserToken[],
): UserToken[] {
  const mints = new Set(portfolioTokens.map((t) => t.mintAddress));
  const extras = emptyAccounts.filter(
    (token) =>
      !mints.has(token.mintAddress) && token.uiAmount <= 0.000000000001,
  );
  return [...portfolioTokens, ...extras];
}

async function fetchPortfolioFromUrl(
  url: string,
  timeoutMs: number,
): Promise<JupiterPortfolioResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Jupiter portfolio failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }

    const raw = (await response.json()) as JupiterPortfolioResponse & {
      status?: string;
      error?: string;
    };

    if (raw.status === "error") {
      throw new Error(raw.error ?? "Jupiter portfolio fetch failed");
    }

    return {
      totalValue: raw.totalValue ?? 0,
      tokens: raw.tokens ?? [],
      reclaimableCount: raw.reclaimableCount,
      reclaimableLamports: raw.reclaimableLamports,
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ponytail: dedupe in-flight client fetches per URL; upgrade path = React Query only
const portfolioInflight = new Map<string, Promise<JupiterPortfolioResponse>>();

/** Client-side fetch via Next.js proxy. */
export async function fetchJupiterPortfolio(
  walletAddress: string,
): Promise<JupiterPortfolioResponse> {
  const query = new URLSearchParams({
    wallet: walletAddress,
    include: "reclaimableLamports",
  });
  const url = `/api/jupiter/portfolio?${query.toString()}`;

  // ponytail: dedupe in-flight client fetches per URL; upgrade path = React Query only
  const inflight = portfolioInflight.get(url);
  if (inflight) return inflight;

  const promise = fetchPortfolioFromUrl(url, PORTFOLIO_FETCH_TIMEOUT_MS).finally(
    () => portfolioInflight.delete(url),
  );
  portfolioInflight.set(url, promise);
  return promise;
}

/** Server-side fetch directly from Jupiter. */
export async function fetchJupiterPortfolioDirect(
  walletAddress: string,
): Promise<JupiterPortfolioResponse> {
  const url = `${JUPITER_PORTFOLIO_BASE}/${encodeURIComponent(walletAddress)}?include=reclaimableLamports`;
  return fetchPortfolioFromUrl(url, PORTFOLIO_FETCH_TIMEOUT_MS);
}

/** Resolve a sellable token via Jupiter Portfolio (same source as /sell). */
export async function resolveWalletTokenToSell(
  walletAddress: string,
  mintAddress: string,
  fallbacks: {
    cached?: UserToken;
    rpcFetch?: () => Promise<UserToken[]>;
  } = {},
): Promise<UserToken | null> {
  try {
    const portfolio = await fetchJupiterPortfolio(walletAddress);
    const found = mapPortfolioToUserTokens(portfolio).find(
      (t) => t.mintAddress === mintAddress,
    );
    if (found && found.uiAmount > 0) return found;
  } catch (err) {
    console.warn("Jupiter portfolio resolve failed, trying fallbacks", err);
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

export async function refreshPortfolioPrices(
  walletAddress: string,
  existingTokens: UserToken[],
): Promise<UserToken[]> {
  const portfolio = await fetchJupiterPortfolio(walletAddress);
  const freshByMint = new Map(
    mapPortfolioToUserTokens(portfolio).map((token) => [
      token.mintAddress,
      token,
    ]),
  );

  return existingTokens.map((token) => {
    const fresh = freshByMint.get(token.mintAddress);
    if (!fresh) {
      return { ...token, isLoadingPrice: false };
    }
    return {
      ...token,
      ...fresh,
      isLoadingPrice: false,
    };
  });
}
