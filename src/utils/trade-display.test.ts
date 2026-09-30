import { describe, expect, it } from "vitest";
import { estimateBuyUsdValue, formatTradeAmount } from "./trade-display";

describe("formatTradeAmount", () => {
  it("keeps a real fill legible instead of rounding it to zero", () => {
    expect(formatTradeAmount(0.000123456)).toBe("0.000123456");
    expect(formatTradeAmount(0.5)).toBe("0.5");
  });

  it("shows the exact quantity a user checks against the chain", () => {
    expect(formatTradeAmount(681.3972242)).toBe("681.397224");
  });

  it("groups thousands", () => {
    expect(formatTradeAmount(1234567.891)).toBe("1,234,567.89");
  });

  it("handles zero and unusable input without inventing a figure", () => {
    expect(formatTradeAmount(0)).toBe("0");
    expect(formatTradeAmount(Number.NaN)).toBe("—");
    expect(formatTradeAmount(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("estimateBuyUsdValue", () => {
  it("values a SOL buy at the live native price", () => {
    expect(estimateBuyUsdValue({ amount: 0.005, currency: "SOL", nativePriceUsd: 118.51 })).toBeCloseTo(
      0.59255,
      6,
    );
  });

  it("takes a USDC buy as the dollar unit", () => {
    expect(estimateBuyUsdValue({ amount: 25, currency: "USDC", nativePriceUsd: 118.51 })).toBe(25);
    expect(estimateBuyUsdValue({ amount: 25, currency: "USDC", nativePriceUsd: null })).toBe(25);
  });

  it("returns null rather than assuming a price it cannot observe", () => {
    expect(estimateBuyUsdValue({ amount: 0.005, currency: "SOL", nativePriceUsd: null })).toBeNull();
    expect(estimateBuyUsdValue({ amount: 0.005, currency: "SOL", nativePriceUsd: undefined })).toBeNull();
    expect(estimateBuyUsdValue({ amount: 0.005, currency: "SOL", nativePriceUsd: 0 })).toBeNull();
    expect(estimateBuyUsdValue({ amount: 0.005, currency: "SOL", nativePriceUsd: Number.NaN })).toBeNull();
  });

  it("returns null for an amount that is not a usable number", () => {
    expect(estimateBuyUsdValue({ amount: 0, currency: "SOL", nativePriceUsd: 118.51 })).toBeNull();
    expect(estimateBuyUsdValue({ amount: -1, currency: "SOL", nativePriceUsd: 118.51 })).toBeNull();
    expect(estimateBuyUsdValue({ amount: Number.NaN, currency: "SOL", nativePriceUsd: 118.51 })).toBeNull();
  });
});
