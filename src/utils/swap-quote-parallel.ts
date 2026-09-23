import {
  fetchJupiterLiteQuote,
  fetchJupiterLiteQuoteDirect,
  mapJupiterLiteQuoteToSwapQuote,
  type JupiterLiteQuoteResponse,
} from "@/utils/jupiter-lite-swap";
import {
  fetchJupiterSwapQuote,
  fetchJupiterSwapQuoteDirect,
  mapJupiterSwapDisplayToSwapQuote,
  type JupiterQuoteDisplay,
  type JupiterSwapQuoteParams,
} from "@/utils/jupiter-swap-quote";
import {
  getSwapQuoteMaxImpactPct,
  impactToAbsPct,
  passesImpactGate,
  pickBestSwapQuote,
  type SwapQuoteCandidate,
  type SwapQuoteProvider,
} from "@/utils/swap-quote-pick";

export type ParallelQuoteParams = {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  direct?: boolean;
};

async function settleProvider<T>(
  provider: SwapQuoteProvider,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[swap-quote] ${provider} failed:`, message);
    return null;
  }
}

function candidateFromLite(
  quote: JupiterLiteQuoteResponse,
): SwapQuoteCandidate {
  const mapped = mapJupiterLiteQuoteToSwapQuote(quote);
  return {
    provider: "jupiter_lite",
    outAmount: mapped.outAmount,
    impactPct: impactToAbsPct(quote.priceImpactPct),
    quote: mapped,
  };
}

function candidateFromSwap(display: JupiterQuoteDisplay): SwapQuoteCandidate {
  const mapped = mapJupiterSwapDisplayToSwapQuote(display);
  return {
    provider: "jupiter_swap",
    outAmount: mapped.outAmount,
    impactPct: impactToAbsPct(display.priceImpact),
    quote: mapped,
  };
}

function jupiterOrderParams(params: ParallelQuoteParams, amount: string): JupiterSwapQuoteParams {
  return {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount,
    slippageBps: params.slippageBps,
  };
}

/**
 * Desk quote: one Jupiter Swap V2 `/order` (no taker).
 * Lite runs only after V2 fails. Raptor is not queried.
 */
export async function collectSwapQuoteCandidates(
  params: ParallelQuoteParams,
): Promise<SwapQuoteCandidate[]> {
  const useDirect = params.direct ?? typeof window === "undefined";
  const amount = String(params.amount);
  const orderParams = jupiterOrderParams(params, amount);

  const swap = await settleProvider("jupiter_swap", () =>
    useDirect
      ? fetchJupiterSwapQuoteDirect(orderParams)
      : fetchJupiterSwapQuote(orderParams),
  );
  if (swap) return [candidateFromSwap(swap)];

  const lite = await settleProvider("jupiter_lite", () =>
    useDirect
      ? fetchJupiterLiteQuoteDirect(
          params.inputMint,
          params.outputMint,
          amount,
          params.slippageBps,
        )
      : fetchJupiterLiteQuote(
          params.inputMint,
          params.outputMint,
          amount,
          params.slippageBps,
        ),
  );
  return lite ? [candidateFromLite(lite)] : [];
}

export async function pickParallelSwapQuote(
  params: ParallelQuoteParams,
  maxImpactPct: number = getSwapQuoteMaxImpactPct(),
): Promise<SwapQuoteCandidate | null> {
  const candidates = await collectSwapQuoteCandidates(params);
  const gatedOut = candidates.filter((c) => !passesImpactGate(c.impactPct, maxImpactPct));
  for (const c of gatedOut) {
    console.warn(
      `[swap-quote] ${c.provider} gated: impact ${c.impactPct.toFixed(2)}% > ${maxImpactPct}%`,
    );
  }
  const winner = pickBestSwapQuote(candidates, maxImpactPct);
  if (winner) {
    console.info(
      `[swap-quote] winner=${winner.provider} out=${winner.outAmount} impact=${winner.impactPct.toFixed(2)}% (n=${candidates.length})`,
    );
  }
  return winner;
}
