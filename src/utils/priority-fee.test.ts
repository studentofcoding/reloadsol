import { describe, expect, it } from "vitest";
import {
  AUTO_PRIORITY_FEE_MAX_LAMPORTS,
  autoPriorityFeeLamports,
  clampManualPriorityFeeLamports,
  jupiterLitePrioritizationFee,
  jupiterV2PriorityFeeQuery,
  priorityFeeFromSolInput,
  resolveTrackerPriorityFee,
} from "@/utils/priority-fee";
import {
  buildRaptorQuoteAndSwapBody,
  getRaptorPriorityFeeParams,
} from "@/utils/solanatracker-raptor";

const AUTO = autoPriorityFeeLamports({
  level: "high",
  maxLamports: 3_000_000,
});

describe("autoPriorityFeeLamports", () => {
  it("builds the Jupiter high object capped at 0.003 SOL with global false", () => {
    expect(AUTO).toEqual({
      priorityLevelWithMaxLamports: {
        priorityLevel: "high",
        maxLamports: 3_000_000,
        global: false,
      },
    });
    expect(AUTO.priorityLevelWithMaxLamports.maxLamports).toBe(
      AUTO_PRIORITY_FEE_MAX_LAMPORTS,
    );
  });

  it("does not under-cap or exceed 3e6 when the level is high", () => {
    expect(
      autoPriorityFeeLamports({ level: "high", maxLamports: 30_000 })
        .priorityLevelWithMaxLamports.maxLamports,
    ).toBe(3_000_000);
    expect(
      autoPriorityFeeLamports({ level: "high", maxLamports: 9_000_000 })
        .priorityLevelWithMaxLamports.maxLamports,
    ).toBe(3_000_000);
  });

  it("places the object on the Lite swap field", () => {
    expect(jupiterLitePrioritizationFee(AUTO)).toEqual(AUTO);
  });
});

describe("getRaptorPriorityFeeParams auto", () => {
  it("uses high and maxPriorityFee 3e6 for the auto object", () => {
    expect(getRaptorPriorityFeeParams(AUTO)).toEqual({
      priorityFee: "high",
      maxPriorityFee: 3_000_000,
    });
  });

  it("does not under-cap a high auto spec below 3e6", () => {
    expect(
      getRaptorPriorityFeeParams({
        priorityLevelWithMaxLamports: {
          priorityLevel: "high",
          maxLamports: 30_000,
          global: false,
        },
      }),
    ).toEqual({
      priorityFee: "high",
      maxPriorityFee: 3_000_000,
    });
  });

  it("stamps high + 3e6 on the quote-and-swap body", () => {
    const body = buildRaptorQuoteAndSwapBody({
      userPublicKey: "BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV",
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000000000",
      slippageBps: 50,
      priorityFeeLamports: AUTO,
    });
    expect(body.priorityFee).toBe("high");
    expect(body.maxPriorityFee).toBe(3_000_000);
  });

  it("keeps the numeric ladder for non-auto callers", () => {
    expect(getRaptorPriorityFeeParams(30_000)).toEqual({
      priorityFee: "high",
      maxPriorityFee: 30_000,
    });
    expect(getRaptorPriorityFeeParams(0)).toEqual({
      priorityFee: "medium",
      maxPriorityFee: 1_000_000,
    });
    expect(getRaptorPriorityFeeParams(1_000_000)).toEqual({
      priorityFee: "veryHigh",
      maxPriorityFee: 1_000_000,
    });
  });
});

describe("manual priority fee override", () => {
  it("clamps lamports to at most 3e6", () => {
    expect(clampManualPriorityFeeLamports(5_000_000)).toBe(3_000_000);
    expect(clampManualPriorityFeeLamports(3_000_000)).toBe(3_000_000);
    expect(clampManualPriorityFeeLamports(1_000_000)).toBe(1_000_000);
    expect(clampManualPriorityFeeLamports(0)).toBe(0);
    expect(clampManualPriorityFeeLamports(Number.NaN)).toBe(0);
  });

  it("treats an empty Fees field as auto and caps a SOL override", () => {
    expect(priorityFeeFromSolInput("")).toEqual(AUTO);
    expect(priorityFeeFromSolInput(null)).toEqual(AUTO);
    expect(priorityFeeFromSolInput(0)).toEqual(AUTO);
    expect(priorityFeeFromSolInput(0.001)).toBe(1_000_000);
    expect(priorityFeeFromSolInput(0.01)).toBe(3_000_000);
    expect(priorityFeeFromSolInput(0.003)).toBe(3_000_000);
  });

  it("clamps a tracker manual override and defaults omission to auto", () => {
    expect(resolveTrackerPriorityFee(undefined)).toEqual(AUTO);
    expect(resolveTrackerPriorityFee(9_000_000)).toBe(3_000_000);
    expect(resolveTrackerPriorityFee(30_000)).toBe(30_000);
    expect(resolveTrackerPriorityFee(AUTO)).toEqual(AUTO);
  });
});

describe("jupiter V2 order fee shape", () => {
  it("maps auto high to maxCap at 3e6", () => {
    expect(jupiterV2PriorityFeeQuery(AUTO)).toEqual({
      priorityFeeLamports: 3_000_000,
      broadcastFeeType: "maxCap",
    });
    expect(
      jupiterV2PriorityFeeQuery({
        priorityLevelWithMaxLamports: {
          priorityLevel: "high",
          maxLamports: 30_000,
          global: false,
        },
      }),
    ).toEqual({
      priorityFeeLamports: 3_000_000,
      broadcastFeeType: "maxCap",
    });
  });

  it("maps a numeric override to an exact tip", () => {
    expect(jupiterV2PriorityFeeQuery(1_000_000)).toEqual({
      priorityFeeLamports: 1_000_000,
      broadcastFeeType: "exactFee",
    });
  });
});
