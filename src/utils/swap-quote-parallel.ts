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

export type QuoteFailure = { provider: SwapQuoteProvider; rateLimited: boolean }

/**
 * Classify a provider failure. A 429 is a **rate limit**, not a missing route — reading one as the other is
 * how a throttled lane becomes "no route exists" and the caller quietly gives up on a pair that is fine.
 */
function isRateLimitFailure(error: unknown, message: string): boolean {
  const status = (error as { status?: unknown } | null)?.status
  if (status === 429) return true
  return /429|rate limit|too many requests/i.test(message)
}

async function settleProvider<T>(
  provider: SwapQuoteProvider,
  fn: () => Promise<T>,
  onFailure?: (failure: QuoteFailure) => void,
): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rateLimited = isRateLimitFailure(error, message);
    console.warn(
      `[swap-quote] ${provider} failed${rateLimited ? " (rate limited)" : ""}:`,
      message,
    );
    onFailure?.({ provider, rateLimited });
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
 *
 * **Sequential, despite the filename.** Each provider is awaited and the first success short-circuits, so
 * this can only ever return a single candidate — `pickBestSwapQuote` accepts a list and orders by
 * `outAmount`, but has never been handed more than one. The name is historical. A real fan-out was
 * measured and rejected: +5.0 bps mean / **0 median** for 2.59× the swap time (SPEC-swap-provider-routing-v1
 * §2.8). Do not "fix" this into parallel quoting without re-reading that measurement.
 */
export async function collectSwapQuoteCandidates(
  params: ParallelQuoteParams,
  onFailure?: (failure: QuoteFailure) => void,
): Promise<SwapQuoteCandidate[]> {
  const useDirect = params.direct ?? typeof window === "undefined";
  const amount = String(params.amount);
  const orderParams = jupiterOrderParams(params, amount);

  const swap = await settleProvider(
    "jupiter_swap",
    () =>
      useDirect
        ? fetchJupiterSwapQuoteDirect(orderParams)
        : fetchJupiterSwapQuote(orderParams),
    onFailure,
  );
  if (swap) return [candidateFromSwap(swap)];

  const lite = await settleProvider(
    "jupiter_lite",
    () =>
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
    onFailure,
  );
  return lite ? [candidateFromLite(lite)] : [];
}

export async function pickParallelSwapQuote(
  params: ParallelQuoteParams,
  maxImpactPct: number = getSwapQuoteMaxImpactPct(),
  onFailure?: (failure: QuoteFailure) => void,
): Promise<SwapQuoteCandidate | null> {
  const candidates = await collectSwapQuoteCandidates(params, onFailure);
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
