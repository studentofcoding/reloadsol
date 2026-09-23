import { beforeEach, describe, expect, it, vi } from "vitest";
import { JupiterLiteError } from "@/utils/jupiter-lite-swap";
import { JupiterSwapQuoteError } from "@/utils/jupiter-swap-quote";

vi.mock("@/utils/solanatracker-raptor", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/solanatracker-raptor")>();
  return {
    ...actual,
    fetchRaptorQuoteDirect: vi.fn(),
    fetchRaptorQuote: vi.fn(),
  };
});

vi.mock("@/utils/jupiter-lite-swap", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/jupiter-lite-swap")>();
  return {
    ...actual,
    fetchJupiterLiteQuoteDirect: vi.fn(),
    fetchJupiterLiteQuote: vi.fn(),
  };
});

vi.mock("@/utils/jupiter-swap-quote", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/jupiter-swap-quote")>();
  return {
    ...actual,
    fetchJupiterSwapQuoteDirect: vi.fn(),
    fetchJupiterSwapQuote: vi.fn(),
  };
});

import { fetchRaptorQuoteDirect } from "@/utils/solanatracker-raptor";
import { fetchJupiterLiteQuoteDirect } from "@/utils/jupiter-lite-swap";
import { fetchJupiterSwapQuoteDirect } from "@/utils/jupiter-swap-quote";
import { pickParallelSwapQuote } from "@/utils/swap-quote-parallel";
import { fetchSwapQuote } from "@/utils/swap-executor";

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const PARAMS = {
  inputMint: SOL,
  outputMint: TOKEN,
  amount: "1000000000",
  slippageBps: 200,
  direct: true,
};

function liteQuote(outAmount: string, priceImpactPct: string) {
  return {
    inputMint: SOL,
    outputMint: TOKEN,
    inAmount: PARAMS.amount,
    outAmount,
    otherAmountThreshold: outAmount,
    swapMode: "ExactIn",
    slippageBps: 200,
    priceImpactPct,
    routePlan: [],
  };
}

function swapDisplay(outAmount: string, priceImpact: number) {
  return {
    inputMint: SOL,
    outputMint: TOKEN,
    amount: PARAMS.amount,
    outAmount,
    minAmountOut: outAmount,
    priceImpact,
    slippageBps: 200,
    route: {},
  };
}

describe("pickParallelSwapQuote / fetchSwapQuote", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SWAP_QUOTE_MAX_IMPACT_PCT;
  });

  it("quotes Jupiter V2 only and does not call Raptor or Lite", async () => {
    vi.mocked(fetchJupiterSwapQuoteDirect).mockResolvedValue(
      swapDisplay("555", 0.002),
    );

    const winner = await pickParallelSwapQuote(PARAMS);

    expect(winner?.provider).toBe("jupiter_swap");
    expect(winner?.outAmount).toBe("555");
    expect(fetchJupiterSwapQuoteDirect).toHaveBeenCalledTimes(1);
    expect(fetchJupiterSwapQuoteDirect).toHaveBeenCalledWith({
      inputMint: SOL,
      outputMint: TOKEN,
      amount: PARAMS.amount,
      slippageBps: 200,
    });
    expect(fetchRaptorQuoteDirect).not.toHaveBeenCalled();
    expect(fetchJupiterLiteQuoteDirect).not.toHaveBeenCalled();
  });

  it("falls back to Lite only when V2 /order fails", async () => {
    vi.mocked(fetchJupiterSwapQuoteDirect).mockRejectedValue(
      new JupiterSwapQuoteError("Jupiter quote rate limited", 429),
    );
    vi.mocked(fetchJupiterLiteQuoteDirect).mockResolvedValue(
      liteQuote("300", "0.01"),
    );

    const winner = await pickParallelSwapQuote(PARAMS);

    expect(winner?.provider).toBe("jupiter_lite");
    expect(winner?.outAmount).toBe("300");
    expect(fetchJupiterLiteQuoteDirect).toHaveBeenCalledTimes(1);
    expect(fetchRaptorQuoteDirect).not.toHaveBeenCalled();
  });

  it("gates a high-impact V2 quote without calling Lite", async () => {
    vi.mocked(fetchJupiterSwapQuoteDirect).mockResolvedValue(
      swapDisplay("999", 0.5),
    );

    const quote = await fetchSwapQuote(SOL, TOKEN, 1_000_000_000, 200, true);

    expect(quote).toBeNull();
    expect(fetchJupiterLiteQuoteDirect).not.toHaveBeenCalled();
    expect(fetchRaptorQuoteDirect).not.toHaveBeenCalled();
  });

  it("returns null when V2 and Lite both fail", async () => {
    vi.mocked(fetchJupiterSwapQuoteDirect).mockRejectedValue(new Error("down"));
    vi.mocked(fetchJupiterLiteQuoteDirect).mockRejectedValue(
      new JupiterLiteError("Lite down", 502),
    );

    expect(await pickParallelSwapQuote(PARAMS)).toBeNull();
    expect(await fetchSwapQuote(SOL, TOKEN, 1_000_000_000, 200, true)).toBeNull();
    expect(fetchRaptorQuoteDirect).not.toHaveBeenCalled();
  });
});
