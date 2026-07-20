import { describe, expect, it } from "vitest";
import { parseArbLog } from "./parse-log";

describe("parseArbLog", () => {
  it("maps our quote JSON to legs + totals", () => {
    const raw = JSON.stringify({
      success: true,
      quote: {
        mintA: "Aaa",
        mintB: "Bbb",
        inSolLamports: "100000000",
        outSolLamports: "108000000",
        netSolLamports: "8000000",
        roiPct: 8,
        legs: [
          {
            leg: "sol_to_a",
            inAmount: "100000000",
            outAmount: "1000",
            provider: "raptor",
          },
          {
            leg: "a_to_b",
            inAmount: "1000",
            outAmount: "2000",
            provider: "raptor",
          },
          {
            leg: "b_to_sol",
            inAmount: "2000",
            outAmount: "108000000",
            provider: "raptor",
          },
        ],
      },
    });
    const result = parseArbLog(raw);
    expect(result.kind).toBe("json");
    expect(result.raw).toBe(raw);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]?.action).toBe("sol_to_a");
    expect(result.totals?.solSpent).toBeCloseTo(0.1, 9);
    expect(result.totals?.solReceived).toBeCloseTo(0.108, 9);
    expect(result.totals?.roiPct).toBeCloseTo(8, 9);
  });

  it("parses freeform CRX/SCX-style lines", () => {
    const raw = [
      "Time  Wallet  Action  Amount  USD",
      "22:35  W1  buy CRX with 0.1 SOL  0.1 SOL  $7.60",
      "22:36  W1  swaps 9225 CRX for 18M SCX  SCALE",
      "22:37  W1  sell 18M SCX for 0.861 SOL  0.861 SOL  $65.58",
    ].join("\n");
    const result = parseArbLog(raw);
    expect(result.kind).toBe("freeform");
    expect(result.raw).toBe(raw);
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    expect(result.rows.some((r) => r.action === "buy")).toBe(true);
    expect(result.rows.some((r) => r.action === "sell")).toBe(true);
    expect(result.totals?.solSpent).toBeCloseTo(0.1, 6);
    expect(result.totals?.solReceived).toBeCloseTo(0.861, 6);
  });

  it("leaves empty paste empty", () => {
    const result = parseArbLog("   ");
    expect(result.kind).toBe("empty");
    expect(result.rows).toHaveLength(0);
  });
});
