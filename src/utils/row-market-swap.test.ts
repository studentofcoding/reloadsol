import { describe, expect, it } from "vitest";
import { rowMarketSwap } from "@/utils/row-market-swap";
import { runTrackerMarketSwap } from "@/utils/tracker-market-swap";

describe("row market swap", () => {
  it("is the same function the mcap tracker rows send through", () => {
    expect(rowMarketSwap).toBe(runTrackerMarketSwap);
  });
});
