import type { SwapQuote } from "@/types";
import {
  fetchRaptorQuote,
  fetchRaptorQuoteDirect,
  type RaptorQuoteResponse,
} from "@/utils/solanatracker-raptor";
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

function mapRaptorQuoteToSwapQuote(quote: RaptorQuoteResponse): SwapQuote {
  return {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: quote.amountIn,
    outAmount: quote.amountOut,
    otherAmountThreshold: quote.minAmountOut,
    swapMode: "ExactIn",
    slippageBps: quote.slippageBps,
    priceImpactPct: String(quote.priceImpact ?? 0),
    routePlan: (quote.routePlan as unknown[]) ?? [],
  };
}

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

function candidateFromRaptor(quote: RaptorQuoteResponse): SwapQuoteCandidate {
  const mapped = mapRaptorQuoteToSwapQuote(quote);
  return {
    provider: "raptor",
    outAmount: mapped.outAmount,
    impactPct: impactToAbsPct(quote.priceImpact),
    quote: mapped,
  };
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

/** Quote Raptor + Jupiter Lite + Jupiter Swap in parallel; fail-soft per provider. */
export async function collectSwapQuoteCandidates(
  params: ParallelQuoteParams,
): Promise<SwapQuoteCandidate[]> {
  const useDirect = params.direct ?? typeof window === "undefined";
  const amount = String(params.amount);

  const [raptor, lite, swap] = await Promise.all([
    settleProvider("raptor", () =>
      useDirect
        ? fetchRaptorQuoteDirect(
            params.inputMint,
            params.outputMint,
            amount,
            params.slippageBps,
          )
        : fetchRaptorQuote(
            params.inputMint,
            params.outputMint,
            amount,
            params.slippageBps,
          ),
    ),
    settleProvider("jupiter_lite", () =>
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
    ),
    settleProvider("jupiter_swap", () =>
      useDirect
        ? fetchJupiterSwapQuoteDirect({
            inputMint: params.inputMint,
            outputMint: params.outputMint,
            amount,
            slippageBps: params.slippageBps,
          })
        : fetchJupiterSwapQuote({
            inputMint: params.inputMint,
            outputMint: params.outputMint,
            amount,
            slippageBps: params.slippageBps,
          }),
    ),
  ]);

  const candidates: SwapQuoteCandidate[] = [];
  if (raptor) candidates.push(candidateFromRaptor(raptor));
  if (lite) candidates.push(candidateFromLite(lite));
  if (swap) candidates.push(candidateFromSwap(swap));
  return candidates;
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
