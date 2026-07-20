import { TOKENS } from "@/utils/solana";

export const SOL_MINT = TOKENS.SOL;

export type TriArbLegId = "sol_to_a" | "a_to_b" | "b_to_sol";

export type TriArbLegQuote = {
  leg: TriArbLegId;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  minAmountOut?: string;
  provider: string;
  priceImpactPct?: string;
};

export type TriArbQuoteResult = {
  mintA: string;
  mintB: string;
  inSolLamports: string;
  outSolLamports: string;
  netSolLamports: string;
  roiPct: number;
  profitable: boolean;
  legs: TriArbLegQuote[];
  maxHopsArbitrage: number;
  slippageBps: number;
};

export type SolArbPair = {
  mintA: string;
  mintB: string;
  label?: string;
};

export function computeTriArbEv(
  inSolLamports: bigint,
  outSolLamports: bigint,
): { netSolLamports: bigint; roiPct: number; profitable: boolean } {
  const net = outSolLamports - inSolLamports;
  const zero = BigInt(0);
  const roiPct =
    inSolLamports === zero ? 0 : (Number(net) / Number(inSolLamports)) * 100;
  return {
    netSolLamports: net,
    roiPct,
    profitable: net > zero,
  };
}
