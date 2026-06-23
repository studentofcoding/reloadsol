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

    const data = (await response.json()) as JupiterPortfolioResponse;
    return {
      ...data,
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Client-side fetch via Next.js proxy. */
export async function fetchJupiterPortfolio(
  walletAddress: string,
): Promise<JupiterPortfolioResponse> {
  const query = new URLSearchParams({
    wallet: walletAddress,
    include: "reclaimableLamports",
  });
  return fetchPortfolioFromUrl(
    `/api/jupiter/portfolio?${query.toString()}`,
    PORTFOLIO_FETCH_TIMEOUT_MS,
  );
}

/** Server-side fetch directly from Jupiter. */
export async function fetchJupiterPortfolioDirect(
  walletAddress: string,
): Promise<JupiterPortfolioResponse> {
  const url = `${JUPITER_PORTFOLIO_BASE}/${encodeURIComponent(walletAddress)}?include=reclaimableLamports`;
  return fetchPortfolioFromUrl(url, PORTFOLIO_FETCH_TIMEOUT_MS);
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
