import {
  fetchRaptorQuoteDirect,
  getRaptorMaxHopsArbitrage,
  mapRaptorQuoteToDisplay,
  RaptorAPIError,
} from "@/utils/solanatracker-raptor";
import {
  fetchJupiterLiteQuoteDirect,
  mapJupiterLiteQuoteToSwapQuote,
} from "@/utils/jupiter-lite-swap";
import {
  computeTriArbEv,
  SOL_MINT,
  type TriArbLegId,
  type TriArbLegQuote,
  type TriArbQuoteResult,
} from "./types";

export type QuoteTriArbParams = {
  mintA: string;
  mintB: string;
  amountLamports: string | number;
  slippageBps?: number;
};

async function quoteOneLeg(params: {
  leg: TriArbLegId;
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps: number;
  maxHops: number;
}): Promise<TriArbLegQuote> {
  try {
    const quote = await fetchRaptorQuoteDirect(
      params.inputMint,
      params.outputMint,
      params.amount,
      params.slippageBps,
      params.maxHops,
    );
    const display = mapRaptorQuoteToDisplay(quote, params.amount);
    return {
      leg: params.leg,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: display.amount,
      outAmount: display.outAmount,
      minAmountOut: display.minAmountOut,
      provider: "raptor",
      priceImpactPct: String(display.priceImpact ?? 0),
    };
  } catch (raptorError) {
    console.warn(
      `sol-arb leg ${params.leg} Raptor failed, trying Jupiter Lite:`,
      raptorError instanceof RaptorAPIError
        ? raptorError.message
        : raptorError,
    );
    const lite = await fetchJupiterLiteQuoteDirect(
      params.inputMint,
      params.outputMint,
      params.amount,
      params.slippageBps,
    );
    const mapped = mapJupiterLiteQuoteToSwapQuote(lite);
    return {
      leg: params.leg,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: mapped.inAmount,
      outAmount: mapped.outAmount,
      minAmountOut: mapped.otherAmountThreshold,
      provider: "jupiter_lite",
      priceImpactPct: mapped.priceImpactPct,
    };
  }
}

/** Quote SOL→A→B→SOL with arb-only Raptor hops. */
export async function quoteTriArb(
  params: QuoteTriArbParams,
): Promise<TriArbQuoteResult> {
  const slippageBps = params.slippageBps ?? defaultSlippageBps();
  const maxHops = getRaptorMaxHopsArbitrage();
  const inSol = String(params.amountLamports);

  if (!/^\d+$/.test(inSol) || BigInt(inSol) <= BigInt(0)) {
    throw new Error("amountLamports must be a positive integer string");
  }
  if (!params.mintA || !params.mintB) {
    throw new Error("mintA and mintB are required");
  }
  if (params.mintA === params.mintB) {
    throw new Error("mintA and mintB must differ");
  }

  const leg1 = await quoteOneLeg({
    leg: "sol_to_a",
    inputMint: SOL_MINT,
    outputMint: params.mintA,
    amount: inSol,
    slippageBps,
    maxHops,
  });

  const leg2 = await quoteOneLeg({
    leg: "a_to_b",
    inputMint: params.mintA,
    outputMint: params.mintB,
    amount: leg1.outAmount,
    slippageBps,
    maxHops,
  });

  const leg3 = await quoteOneLeg({
    leg: "b_to_sol",
    inputMint: params.mintB,
    outputMint: SOL_MINT,
    amount: leg2.outAmount,
    slippageBps,
    maxHops,
  });

  const ev = computeTriArbEv(BigInt(inSol), BigInt(leg3.outAmount));

  return {
    mintA: params.mintA,
    mintB: params.mintB,
    inSolLamports: inSol,
    outSolLamports: leg3.outAmount,
    netSolLamports: ev.netSolLamports.toString(),
    roiPct: ev.roiPct,
    profitable: ev.profitable,
    legs: [leg1, leg2, leg3],
    maxHopsArbitrage: maxHops,
    slippageBps,
  };
}

export function defaultSlippageBps(): number {
  const raw = process.env.SOL_ARB_SLIPPAGE_BPS?.trim();
  if (!raw) return 300;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 300;
}

export function defaultAmountLamports(): string {
  const raw = process.env.SOL_ARB_AMOUNT_LAMPORTS?.trim();
  if (!raw || !/^\d+$/.test(raw)) return "100000000";
  return raw;
}

export function minEdgeLamports(): bigint {
  const raw = process.env.SOL_ARB_MIN_EDGE_LAMPORTS?.trim();
  if (!raw || !/^-?\d+$/.test(raw)) return BigInt(0);
  return BigInt(raw);
}
