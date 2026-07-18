import { describe, expect, it } from "vitest";
import { resolveCloseExecutionPlan } from "@/utils/jupiter";

describe("resolveCloseExecutionPlan", () => {
  it("signs reclaim when craft succeeded — no manual fallback after wallet prompt", () => {
    expect(resolveCloseExecutionPlan(true)).toBe("sign-reclaim");
  });

  it("uses manual only when craft failed before any sign", () => {
    expect(resolveCloseExecutionPlan(false)).toBe("manual");
  });
});
