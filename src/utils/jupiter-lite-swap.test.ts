import { describe, expect, it } from "vitest";
import {
  buildJupiterLiteSwapRequestBody,
  mapJupiterLiteQuoteToSwapQuote,
} from "@/utils/jupiter-lite-swap";
import { autoPriorityFeeLamports } from "@/utils/priority-fee";

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

describe("buildJupiterLiteSwapRequestBody", () => {
  const quote = {
    inputMint: "So11111111111111111111111111111111111111112",
    outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    inAmount: "1000000000",
    outAmount: "17057460",
    otherAmountThreshold: "16886885",
    swapMode: "ExactIn",
    slippageBps: 50,
    priceImpactPct: "0.01",
  };

  it("sends priorityLevel high capped at 3e6 and keeps dynamic compute units", () => {
    const body = buildJupiterLiteSwapRequestBody({
      quoteResponse: quote,
      userPublicKey: "BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV",
      priorityFeeLamports: autoPriorityFeeLamports({
        level: "high",
        maxLamports: 3_000_000,
      }),
    });
    expect(body.dynamicComputeUnitLimit).toBe(true);
    expect(body.prioritizationFeeLamports).toEqual({
      priorityLevelWithMaxLamports: {
        priorityLevel: "high",
        maxLamports: 3_000_000,
        global: false,
      },
    });
  });

  it("still accepts a fixed lamport override", () => {
    const body = buildJupiterLiteSwapRequestBody({
      quoteResponse: quote,
      userPublicKey: "BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV",
      priorityFeeLamports: 1_000_000,
    });
    expect(body.prioritizationFeeLamports).toBe(1_000_000);
    expect(body.dynamicComputeUnitLimit).toBe(true);
  });
});
