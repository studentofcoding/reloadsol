import { afterEach, describe, expect, it } from "vitest";
import type { SwapQuote } from "@/types";
import {
  SWAP_QUOTE_DEFAULT_MAX_IMPACT_PCT,
  getSwapQuoteMaxImpactPct,
  impactToAbsPct,
  passesImpactGate,
  pickBestSwapQuote,
  type SwapQuoteCandidate,
  type SwapQuoteProvider,
} from "@/utils/swap-quote-pick";

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN = "Token111111111111111111111111111111111111111";

function quote(outAmount: string, priceImpactPct: string): SwapQuote {
  return {
    inputMint: SOL,
    outputMint: TOKEN,
    inAmount: "1000000000",
    outAmount,
    otherAmountThreshold: outAmount,
    swapMode: "ExactIn",
    slippageBps: 200,
    priceImpactPct,
    routePlan: [],
  };
}

function candidate(
  provider: SwapQuoteProvider,
  outAmount: string,
  impactPct: number,
): SwapQuoteCandidate {
  return {
    provider,
    outAmount,
    impactPct,
    quote: quote(outAmount, String(impactPct)),
  };
}

describe("getSwapQuoteMaxImpactPct", () => {
  afterEach(() => {
    delete process.env.SWAP_QUOTE_MAX_IMPACT_PCT;
  });

  it("defaults to 15%", () => {
    delete process.env.SWAP_QUOTE_MAX_IMPACT_PCT;
    expect(getSwapQuoteMaxImpactPct()).toBe(SWAP_QUOTE_DEFAULT_MAX_IMPACT_PCT);
    expect(SWAP_QUOTE_DEFAULT_MAX_IMPACT_PCT).toBe(15);
  });

  it("reads SWAP_QUOTE_MAX_IMPACT_PCT", () => {
    process.env.SWAP_QUOTE_MAX_IMPACT_PCT = "20";
    expect(getSwapQuoteMaxImpactPct()).toBe(20);
  });

  it("ignores non-positive / invalid values", () => {
    process.env.SWAP_QUOTE_MAX_IMPACT_PCT = "0";
    expect(getSwapQuoteMaxImpactPct()).toBe(15);
    process.env.SWAP_QUOTE_MAX_IMPACT_PCT = "nope";
    expect(getSwapQuoteMaxImpactPct()).toBe(15);
  });
});

describe("impactToAbsPct / passesImpactGate", () => {
  it("treats fractions and percents the same as rawImpactToPct", () => {
    expect(impactToAbsPct(0.5)).toBeCloseTo(50);
    expect(impactToAbsPct(50)).toBe(50);
    expect(impactToAbsPct("0.012")).toBeCloseTo(1.2);
    expect(impactToAbsPct(undefined)).toBe(0);
  });

  it("gates at the absolute ceiling inclusive", () => {
    expect(passesImpactGate(15, 15)).toBe(true);
    expect(passesImpactGate(15.01, 15)).toBe(false);
    expect(passesImpactGate(-50, 15)).toBe(false);
  });
});

describe("pickBestSwapQuote", () => {
  const max = 15;

  it("discards Raptor ~50% impact and picks Lite (probe 7rLE…)", () => {
    const winner = pickBestSwapQuote(
      [
        candidate("raptor", "900000000", 50),
        candidate("jupiter_lite", "800000000", 2.1),
        candidate("jupiter_swap", "790000000", 1.8),
      ],
      max,
    );
    expect(winner?.provider).toBe("jupiter_lite");
    expect(winner?.outAmount).toBe("800000000");
  });

  it("picks highest outAmount among gated routes", () => {
    const winner = pickBestSwapQuote(
      [
        candidate("raptor", "100", 1),
        candidate("jupiter_lite", "300", 2),
        candidate("jupiter_swap", "200", 0.5),
      ],
      max,
    );
    expect(winner?.provider).toBe("jupiter_lite");
  });

  it("when Raptor is missing, Lite/Swap still trade (probe 7s5k…)", () => {
    const winner = pickBestSwapQuote(
      [
        candidate("jupiter_lite", "111", 3),
        candidate("jupiter_swap", "222", 4),
      ],
      max,
    );
    expect(winner?.provider).toBe("jupiter_swap");
    expect(winner?.outAmount).toBe("222");
  });

  it("tie-breaks equal outAmount by lower impact, then Raptor", () => {
    const byImpact = pickBestSwapQuote(
      [
        candidate("jupiter_lite", "100", 4),
        candidate("jupiter_swap", "100", 1),
      ],
      max,
    );
    expect(byImpact?.provider).toBe("jupiter_swap");

    const byRaptor = pickBestSwapQuote(
      [
        candidate("jupiter_lite", "100", 1),
        candidate("raptor", "100", 1),
        candidate("jupiter_swap", "100", 1),
      ],
      max,
    );
    expect(byRaptor?.provider).toBe("raptor");
  });

  it("returns null when every route fails the gate or has no outAmount", () => {
    expect(
      pickBestSwapQuote(
        [
          candidate("raptor", "1", 50),
          candidate("jupiter_lite", "0", 1),
          candidate("jupiter_swap", "abc", 1),
        ],
        max,
      ),
    ).toBeNull();
    expect(pickBestSwapQuote([], max)).toBeNull();
  });
});
