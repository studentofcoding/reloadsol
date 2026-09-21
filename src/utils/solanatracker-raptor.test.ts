import { describe, expect, it } from "vitest";
import {
  BUYBULK_PLATFORM_FEE_BPS,
  BUYBULK_SOL_FEE_ACCOUNT,
} from "@/utils/buybulk-fee";
import {
  RAPTOR_DEFAULT_MAX_HOPS,
  RAPTOR_DEV_FEE_ACCOUNT,
  RAPTOR_DEV_FEE_BPS,
  buildRaptorQuoteAndSwapBody,
} from "@/utils/solanatracker-raptor";

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
})
