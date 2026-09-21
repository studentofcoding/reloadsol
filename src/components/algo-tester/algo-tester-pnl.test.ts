import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("PnL AlgoPositions shrink", () => {
  it("PnLTracker no longer hosts a PositionCard grid or hide-algo toggle", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/components/PnLTracker.tsx"),
      "utf8",
    );
    expect(src).toContain("<AlgoPositions");
    expect(src).not.toContain("showAlgoStrategies");
    expect(src).not.toContain("PositionCard");
    expect(src).not.toContain("Hide algo");
  });

  it("AlgoPositions default export is a link-out to Algo Tester", () => {
    const src = readFileSync(
      path.join(process.cwd(), "src/components/AlgoPositions.tsx"),
      "utf8",
    );
    expect(src).toContain("/dev/algo-tester?tab=open");
    expect(src).toContain("/dev/algo-tester?tab=closed");
    expect(src).toContain("Open on Algo Tester");
  });
});
