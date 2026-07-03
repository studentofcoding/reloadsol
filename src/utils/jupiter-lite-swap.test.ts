import { describe, expect, it } from "vitest";
import { mapJupiterLiteQuoteToSwapQuote } from "@/utils/jupiter-lite-swap";

describe("mapJupiterLiteQuoteToSwapQuote", () => {
  it("maps Jupiter Lite quote fields to SwapQuote", () => {
    const mapped = mapJupiterLiteQuoteToSwapQuote({
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inAmount: "1000000000",
      outAmount: "17057460",
      otherAmountThreshold: "16886885",
      swapMode: "ExactIn",
      slippageBps: 50,
      priceImpactPct: "0.01",
      routePlan: [{ swapInfo: {} }],
    });

    expect(mapped.inputMint).toBe(
      "So11111111111111111111111111111111111111112",
    );
    expect(mapped.outAmount).toBe("17057460");
    expect(mapped.slippageBps).toBe(50);
    expect(mapped.swapMode).toBe("ExactIn");
    expect(mapped.routePlan).toHaveLength(1);
  });
});
