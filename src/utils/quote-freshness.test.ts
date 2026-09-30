import { describe, expect, it } from "vitest";
import { isQuoteUsable, quoteMatchesAmount } from "./quote-freshness";

const NOW = 1_700_000_000_000;
const q = (amount: string | null | undefined, ageMs = 0) => ({
  amount: amount as string | undefined,
  timestamp: NOW - ageMs,
});

describe("quoteMatchesAmount", () => {
  it("matches a quote taken for the same amount", () => {
    expect(quoteMatchesAmount(q("681397224200"), "681397224200")).toBe(true);
  });

  it("rejects a quote taken for a different amount (the stale-estimate bug)", () => {
    // 61.6% of the full position -> displayed ~3.98 SOL against a live ~6.46 SOL
    expect(quoteMatchesAmount(q("420000000000"), "681397224200")).toBe(false);
  });

  it("is fail-closed when the quote carries no amount", () => {
    expect(quoteMatchesAmount(q(undefined), "681397224200")).toBe(false);
    expect(quoteMatchesAmount(q(null), "681397224200")).toBe(false);
    expect(quoteMatchesAmount(q(""), "681397224200")).toBe(false);
  });

  it("keeps legacy behaviour when the caller does not request amount-awareness", () => {
    expect(quoteMatchesAmount(q("420000000000"), undefined)).toBe(true);
  });

  it("rejects null quotes", () => {
    expect(quoteMatchesAmount(null, "1")).toBe(false);
  });
});

describe("isQuoteUsable", () => {
  it("accepts a fresh quote for the requested amount", () => {
    expect(isQuoteUsable(q("100", 29_000), "100", NOW)).toBe(true);
  });

  it("rejects an expired quote", () => {
    expect(isQuoteUsable(q("100", 30_001), "100", NOW)).toBe(false);
  });

  it("rejects a fresh quote for the wrong amount", () => {
    expect(isQuoteUsable(q("99", 1_000), "100", NOW)).toBe(false);
  });

  it("rejects a quote with no usable timestamp", () => {
    expect(isQuoteUsable({ amount: "100", timestamp: NaN }, "100", NOW)).toBe(false);
    expect(isQuoteUsable({ amount: "100" }, "100", NOW)).toBe(false);
  });
});
