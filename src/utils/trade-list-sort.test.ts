import { describe, expect, it } from "vitest";
import {
  compareBySortMode,
  signedSolForHistoryRecord,
} from "@/utils/trade-list-sort";

describe("compareBySortMode", () => {
  it("orders by date newest / oldest", () => {
    expect(compareBySortMode("date_desc", 1, 2, 0, 0)).toBeGreaterThan(0);
    expect(compareBySortMode("date_asc", 1, 2, 0, 0)).toBeLessThan(0);
  });

  it("orders by pnl + / − and puts missing pnl last", () => {
    expect(compareBySortMode("pnl_desc", 1, 1, 10, 5)).toBeLessThan(0);
    expect(compareBySortMode("pnl_asc", 1, 1, 10, 5)).toBeGreaterThan(0);
    expect(compareBySortMode("pnl_desc", 1, 2, undefined, 5)).toBeGreaterThan(0);
  });
});

describe("signedSolForHistoryRecord", () => {
  it("signs buy negative and sell/close positive", () => {
    expect(signedSolForHistoryRecord({ operationType: "buy", solAmount: 1 })).toBe(
      -1,
    );
    expect(
      signedSolForHistoryRecord({ operationType: "sell", solAmount: 2 }),
    ).toBe(2);
    expect(
      signedSolForHistoryRecord({ operationType: "close", solAmount: 0.002 }),
    ).toBe(0.002);
  });
});
