import { describe, expect, it, vi } from "vitest";
import {
  BUYBULK_PLATFORM_FEE_BPS,
  BUYBULK_SOL_FEE_ACCOUNT,
} from "@/utils/buybulk-fee";
import { TOKENS } from "@/utils/solana";
import { RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT } from "@/utils/raptor-hops";
import {
  RAPTOR_DEFAULT_MAX_HOPS,
  RAPTOR_DEV_FEE_ACCOUNT,
  RAPTOR_DEV_FEE_BPS,
  buildRaptorQuoteAndSwapBody,
  fetchRaptorQuoteDirect,
} from "@/utils/solanatracker-raptor";

const DEW = "DEW9dSN6QpWyNthphCpMmAbZP1Q4cEKR9xQXAri98WDP";

const BASE = {
  userPublicKey: "BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV",
  inputMint: "So11111111111111111111111111111111111111112",
  outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: "1000000000",
  slippageBps: 50,
};

describe("buildRaptorQuoteAndSwapBody buy_bulk fee", () => {
  it("keeps directional maxHops default at 1", () => {
    expect(RAPTOR_DEFAULT_MAX_HOPS).toBe(1);
    expect(buildRaptorQuoteAndSwapBody(BASE).maxHops).toBe(1);
  });

  it("always stamps 25 bps + canonical fee account", () => {
    const body = buildRaptorQuoteAndSwapBody(BASE);
    expect(body.feeBps).toBe(25);
    expect(body.feeBps).toBe(BUYBULK_PLATFORM_FEE_BPS);
    expect(body.feeBps).toBe(RAPTOR_DEV_FEE_BPS);
    expect(body.feeAccount).toBe(BUYBULK_SOL_FEE_ACCOUNT);
    expect(body.feeAccount).toBe(RAPTOR_DEV_FEE_ACCOUNT);
  });

  it("does not honor a zero or 50 bps override (no fee bypass)", () => {
    expect(buildRaptorQuoteAndSwapBody({ ...BASE, feeBps: 0 }).feeBps).toBe(25);
    expect(buildRaptorQuoteAndSwapBody({ ...BASE, feeBps: 50 }).feeBps).toBe(25);
    expect(
      buildRaptorQuoteAndSwapBody({
        ...BASE,
        feeAccount: "11111111111111111111111111111111",
      }).feeAccount,
    ).toBe(BUYBULK_SOL_FEE_ACCOUNT);
  });
});

/**
 * Measured 2026-10-01: on 40 real SOL→token pairs, 8 returned
 * `500 "No direct route found and maxHops=1"` while quoting fine at a wider ceiling. The retry is free on
 * this lane — and strictly better than escalating to the keyed Jupiter picker, which is what used to
 * happen and spends the execution budget on a display quote.
 */
describe("fetchRaptorQuoteDirect — no-route hop retry", () => {
  function response(status: number, body: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  it("retries once at a wider ceiling and returns the quote", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      if (urls.length === 1) {
        return response(500, {
          error: "Failed to get quote: No direct route found and maxHops=1",
          code: 500,
        });
      }
      return response(200, { inputMint: BASE.inputMint, amountOut: "123" });
    });

    try {
      const quote = await fetchRaptorQuoteDirect(TOKENS.SOL, DEW, "100000000", 300);
      expect(quote.amountOut).toBe("123");
      expect(urls).toHaveLength(2);
      expect(urls[0]).toContain("maxHops=1");
      // the retry widens the ceiling rather than giving up
      expect(urls[1]).toContain(`maxHops=${RAPTOR_TOKEN_TOKEN_HOPS_DEFAULT}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not retry a failure that is not a missing route", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return response(500, { error: "something else went wrong", code: 500 });
    });

    try {
      await expect(
        fetchRaptorQuoteDirect(TOKENS.SOL, DEW, "100000000", 300),
      ).rejects.toThrow(/something else went wrong/);
      expect(urls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
