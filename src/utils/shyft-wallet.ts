import type { UserToken } from "@/utils/jupiter";
import { shyftFetch } from "@/utils/shyft-api";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const SHYFT_ALL_TOKENS_PATH = "/sol/v1/wallet/all_tokens";
export const SHYFT_FETCH_TIMEOUT_MS = 15_000;
export const PRICE_BATCH_SIZE = 100;

export type ShyftWalletTokenInfo = {
  decimals: number;
  name?: string;
  symbol?: string;
  image?: string;
};

export type ShyftWalletToken = {
  address: string;
  balance: number;
  associated_account?: string;
  info?: ShyftWalletTokenInfo;
};

export type ShyftAllTokensResult = ShyftWalletToken[];

export type ShyftAllTokensResponse = {
  tokens: ShyftWalletToken[];
  tokenCount: number;
  latencyMs: number;
};

/** Shyft docs mix raw integer and UI decimal balances — infer from magnitude. */
export function normalizeShyftBalance(
  balance: number,
  decimals: number,
): { raw: number; ui: number } {
  if (!Number.isFinite(balance) || balance <= 0) {
    return { raw: 0, ui: 0 };
  }

  const hasFraction = !Number.isInteger(balance);
  const uiFromRaw = balance / 10 ** decimals;

  if (hasFraction) {
    const raw = Math.round(balance * 10 ** decimals);
    return { raw, ui: balance };
  }

  // Integer balance: treat as raw when dividing yields a plausible UI amount
  if (uiFromRaw >= 0.000_001 && uiFromRaw <= 1e12) {
    return { raw: balance, ui: uiFromRaw };
  }

  // Otherwise assume UI amount (e.g. small integer holdings)
  const raw = Math.round(balance * 10 ** decimals);
  return { raw, ui: balance };
}

export function mapShyftTokenToUserToken(token: ShyftWalletToken): UserToken {
  const decimals = token.info?.decimals ?? 6;
  const { raw, ui } = normalizeShyftBalance(token.balance, decimals);

  return {
    mintAddress: token.address,
    balance: raw,
    decimals,
    symbol: token.info?.symbol ?? "TOKEN",
    name: token.info?.name ?? token.info?.symbol ?? "Unknown Token",
    logoURI: token.info?.image,
    uiAmount: ui,
    usdValue: 0,
    isLoadingPrice: true,
    frozen: false,
    isNFT: decimals === 0 && ui <= 1,
  };
}

export function mapShyftTokensToUserTokens(
  tokens: ShyftWalletToken[],
  options?: { includeSol?: boolean },
): UserToken[] {
  const includeSol = options?.includeSol ?? false;
  return tokens
    .filter((token) => includeSol || token.address !== SOL_MINT)
    .map(mapShyftTokenToUserToken)
    .sort((a, b) => b.uiAmount - a.uiAmount);
}

async function fetchPricesFromApi(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {};

  const prices: Record<string, number> = {};

  for (let i = 0; i < mints.length; i += PRICE_BATCH_SIZE) {
    const batch = mints.slice(i, i + PRICE_BATCH_SIZE);
    const response = await fetch("/api/tokens/prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokens: batch }),
    });

    if (!response.ok) {
      console.warn(`Price batch failed (${response.status}) for ${batch.length} mints`);
      continue;
    }

    const data = (await response.json()) as { prices?: Record<string, number> };
    Object.assign(prices, data.prices ?? {});
  }

  return prices;
}

export async function enrichTokensWithPrices(
  tokens: UserToken[],
): Promise<UserToken[]> {
  const mints = tokens.map((t) => t.mintAddress);
  const prices = await fetchPricesFromApi(mints);

  return tokens
    .map((token) => {
      const price = prices[token.mintAddress] ?? 0;
      return {
        ...token,
        usdValue: token.uiAmount * price,
        isLoadingPrice: false,
      };
    })
    .sort((a, b) => b.usdValue - a.usdValue);
}

export function computeTotalPortfolioUsd(tokens: UserToken[]): number {
  return tokens.reduce((sum, token) => sum + token.usdValue, 0);
}

async function fetchAllTokensFromUrl(
  url: string,
  timeoutMs: number,
): Promise<ShyftAllTokensResponse> {
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
        `Shyft all_tokens failed (${response.status}): ${body.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as {
      tokens: ShyftWalletToken[];
      tokenCount?: number;
      latencyMs?: number;
    };

    return {
      tokens: data.tokens ?? [],
      tokenCount: data.tokenCount ?? data.tokens?.length ?? 0,
      latencyMs: data.latencyMs ?? Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Client-side fetch via Next.js proxy. */
export async function fetchShyftAllTokens(
  walletAddress: string,
  network = "mainnet-beta",
): Promise<ShyftAllTokensResponse> {
  const query = new URLSearchParams({
    wallet: walletAddress,
    network,
  });
  return fetchAllTokensFromUrl(
    `/api/shyft/wallet/all_tokens?${query.toString()}`,
    SHYFT_FETCH_TIMEOUT_MS,
  );
}

/** Server-side fetch directly from Shyft. */
export async function fetchShyftAllTokensDirect(
  walletAddress: string,
  network = "mainnet-beta",
): Promise<ShyftAllTokensResponse> {
  const { result, latencyMs } = await shyftFetch<ShyftAllTokensResult>(
    SHYFT_ALL_TOKENS_PATH,
    { wallet: walletAddress, network },
    { timeoutMs: SHYFT_FETCH_TIMEOUT_MS },
  );

  return {
    tokens: result ?? [],
    tokenCount: result?.length ?? 0,
    latencyMs,
  };
}

export async function refreshShyftTokenPrices(
  existingTokens: UserToken[],
): Promise<UserToken[]> {
  return enrichTokensWithPrices(existingTokens);
}
