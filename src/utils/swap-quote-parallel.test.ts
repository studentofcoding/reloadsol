import { beforeEach, describe, expect, it, vi } from "vitest";
import { RaptorAPIError } from "@/utils/solanatracker-raptor";
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

function raptorQuote(amountOut: string, priceImpact: number) {
  return {
    inputMint: SOL,
    outputMint: TOKEN,
    amountIn: PARAMS.amount,
    amountOut,
    minAmountOut: amountOut,
    priceImpact,
    slippageBps: 200,
    routePlan: [],
  };
}

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

  it("fails soft: Swap 429 does not kill Lite/Raptor", async () => {
    vi.mocked(fetchRaptorQuoteDirect).mockResolvedValue(
      raptorQuote("100", 0.001),
    );
    vi.mocked(fetchJupiterLiteQuoteDirect).mockResolvedValue(
      liteQuote("300", "0.01"),
    );
    vi.mocked(fetchJupiterSwapQuoteDirect).mockRejectedValue(
      new JupiterSwapQuoteError("Jupiter quote rate limited", 429),
    );

    const winner = await pickParallelSwapQuote(PARAMS);
    expect(winner?.provider).toBe("jupiter_lite");
    expect(winner?.outAmount).toBe("300");
  });

  it("gates Raptor 50% impact and still trades via Lite (7rLE probe)", async () => {
    vi.mocked(fetchRaptorQuoteDirect).mockResolvedValue(
      raptorQuote("999", 0.5),
    );
    vi.mocked(fetchJupiterLiteQuoteDirect).mockResolvedValue(
      liteQuote("800", "0.02"),
    );
    vi.mocked(fetchJupiterSwapQuoteDirect).mockResolvedValue(
      swapDisplay("700", 0.01),
    );

    const quote = await fetchSwapQuote(SOL, TOKEN, 1_000_000_000, 200, true);
    expect(quote?.outAmount).toBe("800");
    expect(fetchJupiterLiteQuoteDirect).toHaveBeenCalled();
    expect(fetchJupiterSwapQuoteDirect).toHaveBeenCalled();
  });

  it("when Raptor has no route, Lite/Swap still produce a quote (7s5k probe)", async () => {
    vi.mocked(fetchRaptorQuoteDirect).mockRejectedValue(
      new RaptorAPIError("No route", 404),
    );
    vi.mocked(fetchJupiterLiteQuoteDirect).mockRejectedValue(
      new JupiterLiteError("Lite 429", 429),
    );
    vi.mocked(fetchJupiterSwapQuoteDirect).mockResolvedValue(
      swapDisplay("555", 0.002),
    );

    const winner = await pickParallelSwapQuote(PARAMS);
    expect(winner?.provider).toBe("jupiter_swap");
    expect(winner?.outAmount).toBe("555");
  });

  it("returns null when every provider fails", async () => {
    vi.mocked(fetchRaptorQuoteDirect).mockRejectedValue(new Error("down"));
    vi.mocked(fetchJupiterLiteQuoteDirect).mockRejectedValue(new Error("down"));
    vi.mocked(fetchJupiterSwapQuoteDirect).mockRejectedValue(new Error("down"));

    expect(await pickParallelSwapQuote(PARAMS)).toBeNull();
    expect(await fetchSwapQuote(SOL, TOKEN, 1_000_000_000, 200, true)).toBeNull();
  });
});
