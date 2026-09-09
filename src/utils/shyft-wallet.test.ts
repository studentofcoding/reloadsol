import { describe, expect, it } from "vitest";
import {
  mapShyftTokensToUserTokens,
  normalizeShyftBalance,
  SOL_MINT,
  type ShyftWalletToken,
} from "@/utils/shyft-wallet";
import { shyftAllTokensKey } from "@/utils/portfolio-cache";

const SAMPLE: ShyftWalletToken[] = [
  {
    address: "3VJyo1n5EkBGh6uEcnKA1Bf8EgVnvrK3XjcDZDDXsPLF",
    balance: 888888888,
    info: { decimals: 5, name: "Flonk", symbol: "FLONK" },
  },
  {
    address: SOL_MINT,
    balance: 1.5,
    info: { decimals: 9, name: "Wrapped SOL", symbol: "SOL" },
  },
];

describe("normalizeShyftBalance", () => {
  it("treats large integers as raw amounts", () => {
    const flonk = normalizeShyftBalance(888888888, 5);
    expect(flonk.raw).toBe(888888888);
    expect(flonk.ui).toBeCloseTo(8888.88888, 5);
  });

  it("preserves fractional UI balances", () => {
    const flux = normalizeShyftBalance(35457651.1169, 5);
    expect(flux.ui).toBeCloseTo(35457651.1169, 4);
    expect(flux.raw).toBe(Math.round(35457651.1169 * 10 ** 5));
  });

  it("treats small integers as UI amounts", () => {
    const baby = normalizeShyftBalance(5, 9);
    expect(baby.ui).toBe(5);
    expect(baby.raw).toBe(5 * 10 ** 9);
  });

  it("returns zeros for non-finite or non-positive balances", () => {
    expect(normalizeShyftBalance(0, 6)).toEqual({ raw: 0, ui: 0 });
    expect(normalizeShyftBalance(Number.NaN, 6)).toEqual({ raw: 0, ui: 0 });
  });
});

describe("mapShyftTokensToUserTokens", () => {
  it("drops wrapped SOL by default and maps mint/balance", () => {
    const tokens = mapShyftTokensToUserTokens(SAMPLE);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].symbol).toBe("FLONK");
    expect(tokens[0].mintAddress).toBe(SAMPLE[0].address);
    expect(tokens[0].uiAmount).toBeCloseTo(8888.88888, 5);
  });

  it("includes SOL when requested", () => {
    const tokens = mapShyftTokensToUserTokens(SAMPLE, { includeSol: true });
    expect(tokens.some((t) => t.mintAddress === SOL_MINT)).toBe(true);
  });
});

describe("shyft all_tokens cache key", () => {
  it("is stable for the same wallet+network", () => {
    const a = shyftAllTokensKey("WalletABC", "mainnet-beta");
    const b = shyftAllTokensKey("walletabc", "MAINNET-BETA");
    expect(a).toBe(b);
    expect(a).toContain(":all_tokens:mainnet-beta");
  });
});
