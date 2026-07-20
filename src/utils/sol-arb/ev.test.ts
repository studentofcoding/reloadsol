import { describe, expect, it } from "vitest";
import { computeTriArbEv } from "./types";

describe("computeTriArbEv", () => {
  it("computes profit net and roi", () => {
    const inSol = BigInt(100_000_000);
    const profit = computeTriArbEv(inSol, BigInt(108_000_000));
    expect(profit.netSolLamports).toBe(BigInt(8_000_000));
    expect(profit.roiPct).toBeCloseTo(8, 9);
    expect(profit.profitable).toBe(true);
  });

  it("computes loss", () => {
    const loss = computeTriArbEv(BigInt(100_000_000), BigInt(90_000_000));
    expect(loss.netSolLamports).toBe(BigInt(-10_000_000));
    expect(loss.profitable).toBe(false);
    expect(loss.roiPct).toBeCloseTo(-10, 9);
  });

  it("zero in → roi 0", () => {
    expect(computeTriArbEv(BigInt(0), BigInt(1)).roiPct).toBe(0);
  });
});
