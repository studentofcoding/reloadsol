import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import {
  prepareSwapTransaction,
  submitSignedSwap,
  confirmSwapSignature,
  executeClientSwap,
  type SignOneTransaction,
  type ExecuteClientSwapResult,
} from "@/utils/swap-executor";
import { getRaptorMaxHopsArbitrage } from "@/utils/solanatracker-raptor";
import { quoteTriArb } from "./quote";
import { SOL_MINT, type TriArbLegId, type TriArbQuoteResult } from "./types";

export type TriArbLegResult = {
  leg: TriArbLegId;
  signature?: string;
  inAmount: string;
  outAmount?: string;
  success: boolean;
  error?: string;
};

export type ExecuteTriArbResult = {
  success: boolean;
  aborted: boolean;
  abortLeg?: TriArbLegId;
  quote: TriArbQuoteResult;
  legs: TriArbLegResult[];
};

export type ExecuteTriArbSequentialParams = {
  mintA: string;
  mintB: string;
  amountLamports: string | number;
  slippageBps?: number;
  priorityFeeLamports?: number;
  userPublicKey: string;
  connection: Connection;
  /** Wallet or keypair signer. */
  signTransaction: SignOneTransaction;
  /** Re-quote before execute (reserved; always quotes today). */
  refreshQuote?: boolean;
};

/**
 * Run SOL→A→B→SOL as three sequential swaps.
 * On mid-leg failure: stop and hold inventory (no silent continue).
 */
export async function executeTriArbSequential(
  params: ExecuteTriArbSequentialParams,
): Promise<ExecuteTriArbResult> {
  const maxHops = getRaptorMaxHopsArbitrage();
  const quote = await quoteTriArb({
    mintA: params.mintA,
    mintB: params.mintB,
    amountLamports: params.amountLamports,
    slippageBps: params.slippageBps,
  });

  const legs: TriArbLegResult[] = [];
  let amountIn = quote.inSolLamports;

  const sequence: Array<{
    leg: TriArbLegId;
    inputMint: string;
    outputMint: string;
  }> = [
    { leg: "sol_to_a", inputMint: SOL_MINT, outputMint: params.mintA },
    { leg: "a_to_b", inputMint: params.mintA, outputMint: params.mintB },
    { leg: "b_to_sol", inputMint: params.mintB, outputMint: SOL_MINT },
  ];

  for (const step of sequence) {
    try {
      const result: ExecuteClientSwapResult = await executeClientSwap({
        userPublicKey: params.userPublicKey,
        inputMint: step.inputMint,
        outputMint: step.outputMint,
        amount: amountIn,
        slippageBps: params.slippageBps ?? quote.slippageBps,
        priorityFeeLamports: params.priorityFeeLamports,
        connection: params.connection,
        signTransaction: params.signTransaction,
        direct: true,
        maxHops,
      });

      legs.push({
        leg: step.leg,
        signature: result.signature,
        inAmount: amountIn,
        outAmount: result.outAmount,
        success: true,
      });

      if (!result.outAmount) {
        return {
          success: false,
          aborted: true,
          abortLeg: step.leg,
          quote,
          legs: [
            ...legs.slice(0, -1),
            {
              ...legs[legs.length - 1]!,
              success: false,
              error: "Missing outAmount after swap — holding inventory",
            },
          ],
        };
      }
      amountIn = result.outAmount;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      legs.push({
        leg: step.leg,
        inAmount: amountIn,
        success: false,
        error: message,
      });
      return {
        success: false,
        aborted: true,
        abortLeg: step.leg,
        quote,
        legs,
      };
    }
  }

  return { success: true, aborted: false, quote, legs };
}

export type PrepareTriArbLegsParams = {
  mintA: string;
  mintB: string;
  amountLamports: string | number;
  slippageBps?: number;
  priorityFeeLamports?: number;
  userPublicKey: string;
};

export type PreparedTriArbLeg = {
  leg: TriArbLegId;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  swapTransaction: string;
  outAmount?: string;
  lastValidBlockHeight?: number;
};

/** Build three unsigned swap txs from a fresh quote (client signs each). */
export async function prepareTriArbLegs(
  params: PrepareTriArbLegsParams,
): Promise<{ quote: TriArbQuoteResult; legs: PreparedTriArbLeg[] }> {
  const maxHops = getRaptorMaxHopsArbitrage();
  const quote = await quoteTriArb({
    mintA: params.mintA,
    mintB: params.mintB,
    amountLamports: params.amountLamports,
    slippageBps: params.slippageBps,
  });

  const plan: Array<{
    leg: TriArbLegId;
    inputMint: string;
    outputMint: string;
    inAmount: string;
  }> = [
    {
      leg: "sol_to_a",
      inputMint: SOL_MINT,
      outputMint: params.mintA,
      inAmount: quote.legs[0]!.inAmount,
    },
    {
      leg: "a_to_b",
      inputMint: params.mintA,
      outputMint: params.mintB,
      inAmount: quote.legs[1]!.inAmount,
    },
    {
      leg: "b_to_sol",
      inputMint: params.mintB,
      outputMint: SOL_MINT,
      inAmount: quote.legs[2]!.inAmount,
    },
  ];

  const legs: PreparedTriArbLeg[] = [];
  for (const step of plan) {
    const prepared = await prepareSwapTransaction({
      userPublicKey: params.userPublicKey,
      inputMint: step.inputMint,
      outputMint: step.outputMint,
      amount: step.inAmount,
      slippageBps: params.slippageBps ?? quote.slippageBps,
      priorityFeeLamports: params.priorityFeeLamports,
      direct: true,
      maxHops,
    });
    legs.push({
      leg: step.leg,
      inputMint: step.inputMint,
      outputMint: step.outputMint,
      inAmount: step.inAmount,
      swapTransaction: prepared.swapTransaction,
      outAmount: prepared.outAmount,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    });
  }

  return { quote, legs };
}

/** Sign+submit+confirm one prepared leg (server keypair path). */
export async function submitPreparedLeg(params: {
  prepared: PreparedTriArbLeg;
  connection: Connection;
  keypair: Keypair;
}): Promise<TriArbLegResult> {
  const tx = VersionedTransaction.deserialize(
    Buffer.from(params.prepared.swapTransaction, "base64"),
  );
  tx.sign([params.keypair]);
  const sendResult = await submitSignedSwap({
    signedTx: tx,
    prepared: {
      provider: "raptor",
      swapTransaction: params.prepared.swapTransaction,
      outAmount: params.prepared.outAmount,
      lastValidBlockHeight: params.prepared.lastValidBlockHeight,
    },
    connection: params.connection,
    direct: true,
  });
  await confirmSwapSignature({
    signature: sendResult.signature,
    via: sendResult.via,
    checkViaRaptor: sendResult.checkViaRaptor,
    connection: params.connection,
    lastValidBlockHeight: params.prepared.lastValidBlockHeight,
    blockhash: tx.message.recentBlockhash,
    direct: true,
  });
  return {
    leg: params.prepared.leg,
    signature: sendResult.signature,
    inAmount: params.prepared.inAmount,
    outAmount: params.prepared.outAmount,
    success: true,
  };
}

export function isSolArbLiveEnabled(): boolean {
  return process.env.SOL_ARB_LIVE_ENABLED?.trim().toLowerCase() === "true";
}

export function loadSolArbKeypair(): Keypair {
  const raw = process.env.TRADING_KEYPAIR_JSON?.trim();
  if (!raw) {
    throw new Error("TRADING_KEYPAIR_JSON required for server-side sol-arb execute");
  }
  const secret = JSON.parse(raw) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}
