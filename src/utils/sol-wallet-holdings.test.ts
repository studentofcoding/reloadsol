import { describe, expect, it, vi, beforeEach } from "vitest";

const fetchShyftAllTokens = vi.hoisted(() => vi.fn());
const enrichTokensWithPrices = vi.hoisted(() => vi.fn());
const fetchJupiterPortfolio = vi.hoisted(() => vi.fn());

vi.mock("@/utils/shyft-wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/shyft-wallet")>();
  return {
    ...actual,
    fetchShyftAllTokens,
    enrichTokensWithPrices,
  };
});

vi.mock("@/utils/jupiter-portfolio", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/jupiter-portfolio")>();
  return {
    ...actual,
    fetchJupiterPortfolio,
  };
});

import { fetchSolWalletHoldings, resolveWalletTokenToSell } from "@/utils/sol-wallet-holdings";

const SHYFT_TOKEN = {
  address: "3VJyo1n5EkBGh6uEcnKA1Bf8EgVnvrK3XjcDZDDXsPLF",
  balance: 5,
  info: { decimals: 9, name: "BabyBonk", symbol: "BABYBONK" },
};

describe("fetchSolWalletHoldings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichTokensWithPrices.mockImplementation(async (tokens: unknown) => tokens);
  });

  it("uses Shyft all_tokens when the proxy succeeds", async () => {
    fetchShyftAllTokens.mockResolvedValue({
      tokens: [SHYFT_TOKEN],
      tokenCount: 1,
      latencyMs: 12,
    });

    const result = await fetchSolWalletHoldings("Wallet1", { enrichPrices: false });

    expect(result.source).toBe("shyft");
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].symbol).toBe("BABYBONK");
    expect(fetchJupiterPortfolio).not.toHaveBeenCalled();
  });

  it("falls back to Jupiter Portfolio when Shyft fails", async () => {
    fetchShyftAllTokens.mockRejectedValue(new Error("shyft down"));
    fetchJupiterPortfolio.mockResolvedValue({
      totalValue: 2,
      tokens: [
        {
          id: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          symbol: "USDC",
          decimals: 6,
          amount: 2,
          rawAmount: "2000000",
          value: 2,
          price: 1,
        },
      ],
    });

    const result = await fetchSolWalletHoldings("Wallet1");

    expect(result.source).toBe("jupiter");
    expect(result.totalPortfolioUsd).toBe(2);
    expect(result.tokens[0].symbol).toBe("USDC");
    expect(fetchJupiterPortfolio).toHaveBeenCalledWith("Wallet1", false);
  });

  it("forwards fresh=true to the Shyft proxy", async () => {
    fetchShyftAllTokens.mockResolvedValue({
      tokens: [],
      tokenCount: 0,
      latencyMs: 1,
    });

    await fetchSolWalletHoldings("Wallet1", { fresh: true, enrichPrices: false });

    expect(fetchShyftAllTokens).toHaveBeenCalledWith("Wallet1", { fresh: true });
  });
});

describe("resolveWalletTokenToSell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enrichTokensWithPrices.mockImplementation(async (tokens: unknown) => tokens);
  });

  it("returns the Shyft-mapped token when the mint is held", async () => {
    fetchShyftAllTokens.mockResolvedValue({
      tokens: [SHYFT_TOKEN],
      tokenCount: 1,
      latencyMs: 8,
    });

    const found = await resolveWalletTokenToSell(
      "Wallet1",
      SHYFT_TOKEN.address,
    );

    expect(found?.mintAddress).toBe(SHYFT_TOKEN.address);
    expect(found?.uiAmount).toBeGreaterThan(0);
  });

  it("uses cached fallback when holdings miss the mint", async () => {
    fetchShyftAllTokens.mockResolvedValue({
      tokens: [],
      tokenCount: 0,
      latencyMs: 4,
    });

    const cached = {
      mintAddress: "CachedMint",
      balance: 10,
      decimals: 6,
      symbol: "CASH",
      name: "Cash",
      uiAmount: 10,
      usdValue: 1,
      isLoadingPrice: false,
      frozen: false,
      isNFT: false,
    };

    const found = await resolveWalletTokenToSell("Wallet1", "CachedMint", {
      cached,
    });

    expect(found?.symbol).toBe("CASH");
  });
});
