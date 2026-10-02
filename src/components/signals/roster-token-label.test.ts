import { describe, expect, it } from "vitest";
import {
  rosterChartPath,
  rosterTokenLabel,
  shortAddr,
  usableTokenSymbol,
} from "./roster-token-label";

const MINT = "nDZknLvfFRp5rgUHdzTrQsmSY5NKzoavqdLjSHVpump";

describe("rosterTokenLabel", () => {
  it("prefers a real symbol over the mint", () => {
    expect(
      rosterTokenLabel({ mint: MINT, symbol: "POPCAT", metaSymbol: null }),
    ).toBe("POPCAT");
  });

  it("prefers metadata over a mint-prefix placeholder", () => {
    expect(
      rosterTokenLabel({
        mint: MINT,
        symbol: MINT.slice(0, 8),
        metaSymbol: "POPCAT",
      }),
    ).toBe("POPCAT");
  });

  it("falls back to a truncated mint when no symbol is usable", () => {
    expect(rosterTokenLabel({ mint: MINT, symbol: MINT.slice(0, 8) })).toBe(
      shortAddr(MINT),
    );
    expect(rosterTokenLabel({ mint: MINT, symbol: null })).toBe("nDZk…pump");
  });

  it("ignores placeholder tickers and the raw mint", () => {
    expect(usableTokenSymbol("TOKEN", MINT)).toBeNull();
    expect(usableTokenSymbol("Unknown", MINT)).toBeNull();
    expect(usableTokenSymbol(MINT, MINT)).toBeNull();
    expect(usableTokenSymbol("BONK", MINT)).toBe("BONK");
  });

  it("builds the same-origin chart path", () => {
    expect(rosterChartPath(MINT)).toBe(`/chart/${MINT}`);
  });
});
